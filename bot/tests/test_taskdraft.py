# -*- coding: utf-8 -*-
"""タスクの起票支援(taskdraft・2026-11-09)の試験。合成データのみ・実 Discord・実 AI なし。

- taskdraft_logic: 担当の候補の並べ方、指示文、AI の出力の検証(名簿の外の人を使わない・期限・部局・伏せ字)
- assistant_store: 古いジョブ表(kind の CHECK に taskdraft が無い)を開いたときの作り直し
- assistant_cog: ジョブを受けて AI を呼び、draft を書き戻す(Discord には投稿しない)
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from iyakusai_bot import assistant_store as S  # noqa: E402
from iyakusai_bot import taskdraft_logic as TD  # noqa: E402
from iyakusai_bot.ai_provider import AIError, AIResult  # noqa: E402
from iyakusai_bot.task_domain import JST  # noqa: E402

NOW = datetime(2026, 11, 9, 10, 0, tzinfo=JST)
ME = "discord-1000000000000000002"


def person(pid, name, departments=(), lead=0, helper=0, overdue=0, history=()):
    return {"id": pid, "name": name, "departments": list(departments), "lead": lead, "helper": helper,
            "overdue": overdue, "history": list(history)}


ROSTER = [
    person("discord-1000000000000000001", "会場A", ["kaijo"], lead=2, helper=1),
    person(ME, "会場B", ["kaijo"], lead=0),
    person("discord-1000000000000000003", "内務C", ["naimu"], lead=0),
    person("discord-1000000000000000004", "企画D", ["kikaku"], lead=0, history=["kaijo"]),
    person("discord-1000000000000000005", "広報E", ["koho"], lead=0),
]


def draft_input(**over):
    base = {"overview": "11/23 の片付けの段取り。テントの撤去とゴミの回収", "deadline": "2026-11-23",
            "tags": ["kaijo"], "parent": None, "useSources": False, "roster": ROSTER,
            "openTasks": [{"title": "テントを借りる", "tags": ["kaijo"], "assigneeId": ROSTER[0]["id"],
                           "deadline": "2026-11-20"}]}
    base.update(over)
    return base


def ai_output(**over) -> str:
    data = {
        "parent": {"title": "片付けを終える", "tags": ["kaijo"], "deadline": "2026-11-23", "purpose": "撤収",
                   "deliverable": "", "completion_criteria": "会場が元どおり", "open_questions": "",
                   "assignee": "P1", "reason": "会場課のまとめ役"},
        "items": [
            {"title": "テントを撤去する", "tags": ["kaijo"], "deadline": "2026-11-23", "purpose": "",
             "deliverable": "", "completion_criteria": "テントを返却場所へ", "open_questions": "",
             "assignee": "P2", "helpers": ["P2", "P4", "P9"], "reason": "会場課で持ちが少ない"},
            {"title": "ゴミを回収する", "tags": ["unknown"], "deadline": "2026-11-01", "purpose": "",
             "deliverable": "", "completion_criteria": "", "open_questions": "連絡先は 090-1234-5678",
             "assignee": "会場A", "helpers": [], "reason": ""},
        ],
        "notes": "メモ", "questions": ["収集業者を決める", 3],
    }
    data.update(over)
    return "前置き\n" + json.dumps(data, ensure_ascii=False) + "\n以上です"


class RankTests(unittest.TestCase):
    def test_relevance_levels(self):
        self.assertEqual(TD.relevance(ROSTER[0], ["kaijo"]), 3)   # 所属が同じ
        self.assertEqual(TD.relevance(ROSTER[2], ["kaijo"]), 2)   # 内務部の人と会場課のタスク
        self.assertEqual(TD.relevance(ROSTER[0], ["naimu"]), 2)   # 会場課の人と内務部のタスク
        self.assertEqual(TD.relevance(ROSTER[3], ["kaijo"]), 1)   # 企画課だが会場課の担当をしたことがある
        self.assertEqual(TD.relevance(ROSTER[4], ["kaijo"]), 0)
        # 同じ部の別の課どうしは近いとみなさない
        self.assertEqual(TD.relevance(ROSTER[3], ["kikaku"]), 3)
        self.assertEqual(TD.relevance(person("x", "x", ["kaikei"]), ["system"]), 0)

    def test_rank_prefers_nearer_then_lighter(self):
        ranked = [p["name"] for p, _ in TD.rank_people(ROSTER, ["kaijo"])]
        self.assertEqual(ranked, ["会場B", "会場A", "内務C", "企画D", "広報E"])
        # この下書きで既に割り当てた分も持ちに数える
        ranked = [p["name"] for p, _ in TD.rank_people(ROSTER, ["kaijo"], {ME: 5})]
        self.assertEqual(ranked[:2], ["会場A", "会場B"])

    def test_facts(self):
        self.assertEqual(TD.person_facts(person("x", "x", ["kaijo", "naimu"], 2, 1, 1)),
                         "会場課・内務部｜主担当 2・副担当 1・期限超過 1")
        self.assertEqual(TD.person_facts(person("x", "x")), "所属不明｜主担当 0・副担当 0")


class PromptTests(unittest.TestCase):
    def test_prompt_uses_numbers_not_ids(self):
        prompt = TD.build_prompt(draft_input(), now=NOW, actor_id=ME, actor_name="会場B")
        self.assertIn("P1 会場A（会場課｜主担当 2・副担当 1）", prompt)
        self.assertIn("P2 会場B（会場課｜主担当 0・副担当 0） ← 依頼した本人", prompt)
        self.assertIn("会場B さん（候補の P2）", prompt)
        self.assertIn("[会場課] テントを借りる（P1・期限 11/20）", prompt)
        self.assertIn("全体の期限の目安: 2026-11-23", prompt)
        self.assertIn("2026-11-09 10:00（日本時間・月曜）", prompt)
        self.assertNotIn("discord-", prompt)   # 担当の ID は AI に渡さない(番号で答えさせる)

    def test_prompt_for_an_existing_parent_and_sources(self):
        prompt = TD.build_prompt(draft_input(parent={"id": "task-7", "title": "片付け"}, roster=[]),
                                 now=NOW, actor_id=ME, actor_name="会場B", context="# 資料\n去年の段取り")
        self.assertIn("既存のタスク「片付け」の子タスクとして作ります", prompt)
        self.assertIn("名簿を取れませんでした", prompt)
        self.assertIn("【参考：委員会の資料の抜粋】", prompt)
        self.assertIn("去年の段取り", prompt)


class ParseTests(unittest.TestCase):
    def test_maps_numbers_to_the_roster_and_checks_values(self):
        draft = TD.parse_result(ai_output(), draft_input(), now=NOW)
        first, second = draft["items"]
        self.assertEqual((first["assigneeId"], first["assigneeBy"]), (ME, "ai"))
        # 主担当と同じ人・名簿に無い番号は副担当から落とす
        self.assertEqual(first["helperIds"], [ROSTER[3]["id"]])
        self.assertEqual(first["helperNames"], ["企画D"])
        self.assertEqual(first["assigneeFacts"], "会場課｜主担当 0・副担当 0")
        self.assertNotIn(ME, [a["id"] for a in first["alternatives"]])
        self.assertLessEqual(len(first["alternatives"]), TD.MAX_ALTERNATIVES)
        # 名前で書かれた担当は使わず、規則で選ぶ(部局は知らないキーなので親の部局)
        self.assertEqual(second["tags"], ["kaijo"])
        self.assertEqual(second["assigneeBy"], "rule")
        self.assertIsNotNone(second["assigneeId"])
        self.assertIsNone(second["deadline"])                # 今日より前の日付は使わない
        self.assertIn("［伏せ字］", second["openQuestions"])   # 電話番号は伏せる
        self.assertEqual(draft["questions"], ["収集業者を決める"])
        self.assertEqual(draft["parent"]["title"], "片付けを終える")
        self.assertEqual(draft["parent"]["helperIds"], [])
        self.assertEqual(draft["parent"]["completionCriteria"], "会場が元どおり")
        self.assertIsNone(draft["parentTask"])

    def test_rule_spreads_assignments(self):
        items = [{"title": f"仕事{i}", "tags": ["kaijo"], "assignee": None} for i in range(3)]
        draft = TD.parse_result(ai_output(items=items, parent=None), draft_input(), now=NOW)
        names = [item["assigneeName"] for item in draft["items"]]
        # 近い人から持ちの少ない人へ。この下書きで 2 件持った人は、近い人がほかにいれば外す
        self.assertEqual(names, ["会場B", "会場B", "会場A"])
        self.assertIsNone(draft["parent"])

    def test_no_related_person_means_no_assignee(self):
        roster = [person("discord-9", "広報E", ["koho"])]
        draft = TD.parse_result(ai_output(items=[{"title": "テントを撤去する", "tags": ["kaijo"]}]),
                                draft_input(roster=roster), now=NOW)
        item = draft["items"][0]
        self.assertIsNone(item["assigneeId"])
        self.assertIn("名簿にいない", item["reason"])
        self.assertEqual([a["name"] for a in item["alternatives"]], ["広報E"])   # 近い人がいなければ持ちの少ない人

    def test_existing_parent_and_single_item_drop_the_new_parent(self):
        draft = TD.parse_result(ai_output(), draft_input(parent={"id": "task-7", "title": "片付け"}), now=NOW)
        self.assertIsNone(draft["parent"])
        self.assertEqual(draft["parentTask"], {"id": "task-7", "title": "片付け"})
        one = TD.parse_result(ai_output(items=[{"title": "テントを撤去する", "tags": ["kaijo"]}]),
                              draft_input(), now=NOW)
        self.assertIsNone(one["parent"])

    def test_limits_and_empty(self):
        many = [{"title": f"仕事{i}", "tags": ["kaijo"]} for i in range(15)]
        self.assertEqual(len(TD.parse_result(ai_output(items=many), draft_input(), now=NOW)["items"]), TD.MAX_ITEMS)
        long_title = TD.parse_result(ai_output(items=[{"title": "あ" * 200 + "\n改行"}]), draft_input(), now=NOW)
        self.assertEqual(len(long_title["items"][0]["title"]), 120)
        with self.assertRaises(ValueError):
            TD.parse_result(ai_output(items=[{"title": "  "}]), draft_input(), now=NOW)
        with self.assertRaises(ValueError):
            TD.parse_result("JSON ではありません", draft_input(), now=NOW)

    def test_summary(self):
        draft = TD.parse_result(ai_output(), draft_input(), now=NOW)
        text = TD.summary_text(draft)
        self.assertTrue(text.startswith("📝 タスクの下書き（2 件＋親タスク）"))
        self.assertIn("1. テントを撤去する — 担当案: 会場B・期限 11/23", text)
        self.assertIn("決めること: 収集業者を決める", text)


OLD_SCHEMA = S._SCHEMA.replace(",'taskdraft'", "")


class StoreWidenTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="taskdraft-store-"))
        self.path = self.dir / "jobs.sqlite3"

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def make_old(self):
        con = sqlite3.connect(self.path, isolation_level=None)
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(OLD_SCHEMA)
        con.execute("INSERT INTO meta VALUES ('schema_version', '1')")
        for i in range(3):
            con.execute("INSERT INTO jobs(id, kind, op, actor_id, actor_name, client_operation_id, input_json, state,"
                        " created_at, updated_at) VALUES (?, 'ask', NULL, 'discord-1', 'a', ?, '{}', 'done', 't', 't')",
                        (f"j_{i:020d}", f"op-{i}"))
        con.execute("INSERT INTO job_files(job_id, name, mime, size, sha256, relpath)"
                    " VALUES ('j_00000000000000000001', 'x.md', 'text/markdown', 1, 's', 'r')")
        con.execute("DELETE FROM jobs WHERE id = 'j_00000000000000000002'")
        con.close()

    def test_old_table_is_rebuilt_with_rows_files_and_numbers_kept(self):
        self.make_old()
        with self.assertRaises(sqlite3.IntegrityError):   # 古い表は taskdraft を受け付けない(前提の確認)
            con = sqlite3.connect(self.path)
            con.execute("INSERT INTO jobs(id, kind, actor_id, actor_name, client_operation_id, input_json, state,"
                        " created_at, updated_at) VALUES ('j_x', 'taskdraft', 'a', 'a', 'o', '{}', 'queued', 't', 't')")
        con.close()
        store = S.AssistantStore.open(self.path)
        self.assertEqual([j.id for j in store.list_jobs(limit=10)[0]],
                         ["j_00000000000000000001", "j_00000000000000000000"])
        self.assertIsNotNone(store.get_file("j_00000000000000000001", "x.md"))
        job, replayed = store.enqueue("discord-1", "a", "op-new", "taskdraft", None, {"overview": "x"}, max_active=3)
        self.assertFalse(replayed)
        self.assertEqual(job.seq, 4)   # 消した行の番号(3)を使い回さない
        con = sqlite3.connect(self.path)
        names = {row[0] for row in con.execute("SELECT name FROM sqlite_master")}
        self.assertTrue({"jobs_by_state", "jobs_by_kind", "jobs"} <= names)
        self.assertNotIn("jobs_widen", names)
        self.assertEqual(con.execute("PRAGMA foreign_key_check").fetchall(), [])
        con.close()
        S.AssistantStore.open(self.path)   # 2 回目は作り直さない
        self.assertEqual(store.count_active("discord-1"), 1)

    def test_new_table_needs_no_rebuild(self):
        store = S.AssistantStore.open(self.path)
        store.enqueue("discord-1", "a", "op-1", "taskdraft", None, {}, max_active=3)
        S.AssistantStore.open(self.path)
        self.assertEqual(store.count_active("discord-1"), 1)


# ---- Cog(偽の Discord・偽の AI) ----

from test_assistant_cog import AssistantCase, FakeKB  # noqa: E402
from iyakusai_bot.documents import Documents  # noqa: E402


class DraftProvider:
    effort = ""

    def __init__(self, text=None, error=None):
        self.text = ai_output() if text is None else text
        self.error = error
        self.prompts: list[str] = []
        self.gemini = None

    def choose_model(self, text, kind=None, override=None):
        return "sonnet"

    async def complete(self, prompt, model=None, timeout=None, effort=None):
        self.prompts.append(prompt)
        if self.error is not None:
            raise self.error
        return AIResult(text=self.text, model=model or "sonnet", usage={"input_tokens": 10, "output_tokens": 5})


class CogTests(AssistantCase):
    def run_job(self, provider, inp=None, kb=None):
        async def go():
            if provider is not False:
                self.bot.cogs["Documents"] = Documents(self.bot, kb, provider, None, 160.0)
            cog = self.cog()
            job = self.job("taskdraft", inp or draft_input())
            claimed = self.store.claim_next(("ask", "doc", "taskdraft"))
            self.assertEqual(claimed.id, job.id)
            await cog._run(claimed, "ask_doc")
            return self.store.get(job.id)
        return asyncio.run(go())

    def test_writes_the_draft_back_without_posting(self):
        provider = DraftProvider()
        done = self.run_job(provider)
        self.assertEqual(done.state, "done", done.error_message)
        draft = done.result["draft"]
        self.assertEqual(len(draft["items"]), 2)
        self.assertEqual(draft["model"], "sonnet")
        self.assertEqual(draft["sources"], [])
        self.assertEqual(done.result["files"], [])
        self.assertTrue(done.result["text"].startswith("📝 タスクの下書き"))
        self.assertEqual(self.share.sent, [])   # 共有用のチャンネルには出さない
        self.assertIsNone(done.discord_url)
        self.assertIn("テスト委員 さん", provider.prompts[0])

    def test_sources_are_searched_only_when_asked(self):
        provider = DraftProvider()
        done = self.run_job(provider, draft_input(useSources=True), kb=FakeKB())
        self.assertIn("発電機は3台", provider.prompts[0])
        self.assertEqual(done.result["draft"]["sources"][0]["label"], "2026医薬祭/サンプル部/発電機.md")
        provider = DraftProvider()
        self.run_job(provider, draft_input(useSources=False), kb=FakeKB())
        self.assertNotIn("【参考：委員会の資料の抜粋】", provider.prompts[0])

    def test_failures(self):
        self.assertEqual(self.run_job(False).error_code, "UNAVAILABLE")
        self.assertEqual(self.run_job(DraftProvider(error=AIError("x", kind="timeout"))).error_code, "AI_ERROR")
        bad = self.run_job(DraftProvider(text="すみません、分かりません"))
        self.assertEqual((bad.state, bad.error_code), ("failed", "NO_ANSWER"))

    def test_capability_follows_the_ai(self):
        async def go(provider):
            self.bot.cogs["Documents"] = Documents(self.bot, None, provider, None, 160.0)
            await self.cog()._publish_state()
            return json.loads(self.store.get_meta("capabilities"))["features"]["taskdraft"]
        self.assertTrue(asyncio.run(go(DraftProvider())))
        self.assertFalse(asyncio.run(go(None)))


if __name__ == "__main__":
    unittest.main()
