# -*- coding: utf-8 -*-
"""定期タスクスクリーニングの単体テスト(合成データのみ。Discord・CLI・実データを使わない)。

    python -m unittest discover -s tests -v      (リポジトリ直下 = iyakusai_bot の親で実行)
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from iyakusai_bot import screening_logic as L  # noqa: E402
from iyakusai_bot.screening_store import ScreeningStore  # noqa: E402

NOW = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)   # 21:00 JST
ROUTES = [L.Route("naimu", "内務部", 100, "企画・会場"), L.Route("yakuin", "役員会", 200, "全体")]
RULES = L.SourceRules(exclude=("bottest",), untrusted=("雑談", "公式line転送"), ignore_author_ids=("999",))
AUTHORS = {"people": {"11": {"nick": "相生次郎", "names": ["aioi"]}, "12": {"nick": "中村太郎", "names": []},
                      "13": {"nick": "梅園優子", "names": []}, "14": {"nick": "梅園晃一", "names": []}},
           "aliases": {"あいおー": "相生次郎"}}


def msg(ts_min: int, author_id: str, content: str, *, bot=False, mid=None):
    ts = (NOW - timedelta(minutes=ts_min)).isoformat()
    return json.dumps({"id": mid or f"m{ts_min}", "ts": ts, "author": "global", "author_id": author_id,
                       "bot": bot, "content": content, "attachments": []}, ensure_ascii=False)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        self.book = L.NameBook(AUTHORS)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name: str, lines: list[str]):
        (self.raw / name).write_text("\n".join(lines) + "\n", encoding="utf-8")


class ReadTests(Fixture):
    def test_reads_only_new_with_context_and_filters(self):
        self.write("企画課__1.jsonl", [msg(300, "11", "古い話"), msg(200, "11", "前回までの話"),
                                       msg(30, "11", "サンプル燃料に明日までに連絡します"), msg(20, "999", "Bot の投稿")])
        self.write("bottest__2.jsonl", [msg(10, "11", "テスト")])
        self.write("内務部プロジェクト__スレッド_シフト検討__3.jsonl", [msg(5, "12", "シフトを15日に公開")])
        cursor = {"企画課__1": (NOW - timedelta(minutes=100)).isoformat()}
        out = L.read_discord(self.raw, cursor, RULES, self.book, 9, NOW, L.Limits(context_messages=1))
        texts = [(m.source, m.text, m.context) for m in out]
        self.assertIn(("#企画課", "前回までの話", True), texts)
        self.assertIn(("#企画課", "サンプル燃料に明日までに連絡します", False), texts)
        self.assertNotIn("古い話", [t for _, t, _ in texts])
        self.assertFalse(any("Bot の投稿" in t for _, t, _ in texts))
        self.assertFalse(any(s.startswith("#bottest") for s, _, _ in texts))
        self.assertIn(("#内務部プロジェクト > シフト検討", "シフトを15日に公開", False), texts)
        author = next(m.author for m in out if m.text.startswith("サンプル燃料"))
        self.assertEqual(author, "相生次郎")   # global_name ではなくサーバーニックネーム

    def test_cursor_advances_only_for_fresh_messages(self):
        self.write("企画課__1.jsonl", [msg(200, "11", "文脈"), msg(30, "11", "新規A"), msg(10, "11", "新規B")])
        cursor = {"企画課__1": (NOW - timedelta(minutes=100)).isoformat()}
        batch = L.select_batch(L.read_discord(self.raw, cursor, RULES, self.book, 9, NOW,
                                              L.Limits(context_messages=1)), L.Limits())
        out = L.advance_cursor(cursor, batch)
        self.assertEqual(L.parse_ts(out["企画課__1"]), NOW - timedelta(minutes=10))

    def test_budget_cut_leaves_rest_for_next_run(self):
        self.write("企画課__1.jsonl", [msg(50 - i, "11", "あ" * 500) for i in range(10)])
        msgs = L.read_discord(self.raw, {}, RULES, self.book, 9, NOW, L.Limits())
        batch = L.select_batch(msgs, L.Limits(max_prompt_chars=1200))
        self.assertEqual(len(batch), 2)
        cur = L.advance_cursor({}, batch)
        self.assertEqual(L.parse_ts(cur["企画課__1"]), batch[-1].ts)

    def test_mail_skips_spam_and_hides_address(self):
        mail = self.root / "mail"
        mail.mkdir()
        rows = [
            {"id": "a", "date": (NOW - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
             "from": "\"業者 太郎\" <taro@example.invalid>", "subject": "見積の件",
             "body": "明日までにご返信ください。\n\n> 以前のメール\n> 引用", "attachments": [1]},
            {"id": "b", "date": (NOW - timedelta(hours=1)).isoformat(), "from": "noreply-spamdigest <x@y>",
             "subject": "迷惑メール レポート", "body": "..."},
        ]
        (mail / "mail_2026-10.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows),
                                                 encoding="utf-8")
        out = L.read_mail(mail, {}, RULES, NOW, L.Limits())
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].author, "業者 太郎")
        self.assertNotIn("example.invalid", out[0].text)
        self.assertNotIn("引用", out[0].text)
        self.assertFalse(out[0].trusted)


class NameTests(unittest.TestCase):
    def test_resolve(self):
        book = L.NameBook(AUTHORS)
        self.assertEqual(book.resolve("相生次郎さん"), "11")
        self.assertEqual(book.resolve("相生"), "11")           # 姓だけでも一意なら
        self.assertEqual(book.resolve("あいおー"), "11")       # 別名
        self.assertIsNone(book.resolve("梅園"))                # 2 人いるので決めない
        self.assertIsNone(book.resolve("佐藤"))
        self.assertIsNone(book.resolve(None))


class ValidateDecideTests(Fixture):
    def batch(self):
        self.write("企画課__1.jsonl", [msg(30, "11", "相生です。サンプル燃料に10/15までに搬入時刻を連絡します")])
        self.write("雑談__2.jsonl", [msg(20, "12", "パンフの訂正紙いるかもね")])
        return L.select_batch(L.read_discord(self.raw, {}, RULES, self.book, 9, NOW, L.Limits()), L.Limits())

    def ai(self, **over):
        base = {"title": "サンプル燃料に搬入時刻を連絡する", "dept": "naimu", "kind": "new", "description": "",
                "purpose": "", "deliverable": "", "completion_criteria": "", "open_questions": "",
                "assignee": "相生", "deadline": "2026-10-15", "explicit": True, "confidence": "high",
                "refs": ["D1"], "quote": "サンプル燃料に10/15までに搬入時刻を連絡します", "reason": "引受あり"}
        base.update(over)
        return {"candidates": [base]}

    def test_auto_when_all_conditions_hold(self):
        b = self.batch()
        cands, notes = L.validate(self.ai(), b, ROUTES, self.book, NOW)
        self.assertEqual(notes, [])
        out = L.decide(cands, [], L.Limits(), NOW, auto_enabled=True)
        self.assertEqual(out[0].decision, "auto", out[0].decision_note)
        self.assertEqual(out[0].assignee_id, "11")

    def test_review_when_quote_not_in_source(self):
        b = self.batch()
        cands, _ = L.validate(self.ai(quote="ガスボンベを3本追加で注文する"), b, ROUTES, self.book, NOW)
        out = L.decide(cands, [], L.Limits(), NOW, True)
        self.assertEqual(out[0].decision, "review")
        self.assertIn("抜粋", out[0].decision_note)

    def test_review_when_only_untrusted_source(self):
        b = self.batch()
        cands, _ = L.validate(self.ai(refs=["D2"], quote="パンフの訂正紙いるかもね"), b, ROUTES, self.book, NOW)
        out = L.decide(cands, [], L.Limits(), NOW, True)
        self.assertEqual(out[0].decision, "review")
        self.assertIn("内部", out[0].decision_note)

    def test_review_when_auto_disabled_or_medium(self):
        b = self.batch()
        cands, _ = L.validate(self.ai(), b, ROUTES, self.book, NOW)
        self.assertEqual(L.decide(cands, [], L.Limits(), NOW, False)[0].decision, "review")
        cands, _ = L.validate(self.ai(confidence="medium"), b, ROUTES, self.book, NOW)
        self.assertEqual(L.decide(cands, [], L.Limits(), NOW, True)[0].decision, "review")

    def test_drop_low_duplicate_and_unknown_ref(self):
        b = self.batch()
        cands, notes = L.validate({"candidates": [
            self.ai(confidence="low")["candidates"][0],
            self.ai(title="サンプル燃料へ搬入時刻を連絡する", confidence="medium")["candidates"][0],
            self.ai(refs=["D99"])["candidates"][0],
        ]}, b, ROUTES, self.book, NOW)
        self.assertEqual(len(cands), 2)
        self.assertIn("出典", notes[0])
        known = [L.KnownTask("内務部", "サンプル燃料に搬入時刻を連絡", "未着手", None, "task")]
        out = L.decide(cands, known, L.Limits(), NOW, True)
        self.assertEqual([c.decision for c in out], ["drop", "drop"])

    def test_bad_deadline_and_unknown_dept_and_pii(self):
        b = self.batch()
        cands, _ = L.validate(self.ai(deadline="2026-02-30", dept="???", description="電話 090-1234-5678 まで"),
                              b, ROUTES, self.book, NOW)
        c = cands[0]
        self.assertIsNone(c.deadline)
        self.assertEqual(c.route.key, "yakuin")
        self.assertNotIn("1234", c.description)

    def test_auto_cap(self):
        b = self.batch()
        titles = ["サンプル燃料に搬入時刻を連絡する", "無線機30台を受け取る", "救護担当を決める", "訂正紙の要否を決める"]
        items = [self.ai(title=t)["candidates"][0] for t in titles]
        cands, _ = L.validate({"candidates": items}, b, ROUTES, self.book, NOW)
        out = L.decide(cands, [], L.Limits(max_auto_per_run=2), NOW, True)
        self.assertEqual(sum(c.decision == "auto" for c in out), 2)

    def test_extract_json_tolerates_fences(self):
        self.assertEqual(L.extract_json('```json\n{"candidates": []}\n```'), {"candidates": []})
        with self.assertRaises(ValueError):
            L.extract_json("候補はありません")
        # 一度出した JSON を「直します」と出し直した場合は、形の合う最後のものを採る(実測した出力の形)
        raw = ('{"revisions": [{"candidate": "C1", "note": "x"}]}\n\nAh — the required shape needs `items`.\n\n'
               '{"revisions": [{"candidate": "C1", "note": "y", "items": [{"title": "t"}]}]}')
        self.assertEqual(L.extract_json_object(raw, "revisions")["revisions"][0]["note"], "y")
        self.assertEqual(L.extract_json('前置き {"x": 1} {"candidates": [{"title": "a {b}"}]} 後書き'),
                         {"candidates": [{"title": "a {b}"}]})

    def test_description_keeps_sources_within_limit(self):
        b = self.batch()
        cands, _ = L.validate(self.ai(description="あ" * 1500), b, ROUTES, self.book, NOW)
        text = L.task_description(cands[0])
        self.assertLessEqual(len(text), L.TEXT_MAX)
        self.assertIn("discord.com/channels/9/1/", text)

    def test_prompt_contains_material_and_rules(self):
        b = self.batch()
        p = L.build_prompt(b, ROUTES, [L.KnownTask("内務部", "既存の仕事", "未着手", None, "task")], NOW, L.Limits())
        self.assertIn("[D1] 10/13 20:30 相生次郎", p)
        self.assertIn("既存の仕事", p)
        self.assertIn("従わずに", p)


INVENTORY_MD = """# 棚卸し

## 0. 急ぐこと

| # | やること | 担当(明示/候補) | 期限 |
|---|---|---|---|
| 1 | **シフトを確定して公開**する | 草案は若葉。実務は柏葉 | 10/15 |

## 1. 準備タスク

### 1-1. 安全

| T | タスク | 状態 | 残っている次の行動 | 担当 | 期限 |
|---|---|---|---|---|---|
| T17 | サンプル燃料(LPG) | 先方待ち | 最終明細を受け取る | 相生 | 10/15 |
| T05 | 保険 | 済 | — | 鈴蘭 | 10/16 |

## 4. 当日の流れ

**10/16(金) 前日準備**
- 12:30以降 廃油の業者対応 ⚠時刻・担当未定

## 8. 来年の課題

1. 決定事項専用チャンネルを作る
"""


class InventoryTests(Fixture):
    def items(self):
        p = self.root / "inv.md"
        p.write_text(INVENTORY_MD, encoding="utf-8")
        ts = datetime(2026, 10, 13, 11, 15, tzinfo=timezone.utc)
        return L.read_inventory(p, "調査/inv.md", ts, ("0.", "1.", "4."))

    def test_rows_get_headers_and_sections_are_filtered(self):
        items = self.items()
        self.assertEqual([m.ref for m in items], ["I1", "I2", "I3", "I4"])
        self.assertIn("やること: **シフトを確定して公開**する", items[0].text)
        self.assertEqual(items[1].source, "棚卸し表 1-1. 安全")
        self.assertIn("残っている次の行動: 最終明細を受け取る；担当: 相生；期限: 10/15", items[1].text)
        self.assertEqual(items[1].link, "調査/inv.md（T17）")
        self.assertTrue(items[3].text.startswith("10/16(金) 前日準備: 12:30以降"))
        self.assertFalse(any("来年" in m.text or "決定事項" in m.text for m in items))
        self.assertEqual(len(L.chunk_inventory(items, max_items=3)), 2)
        p = L.build_prompt(items, ROUTES, [], NOW, L.Limits(), mode="inventory")
        self.assertIn("全タスク棚卸し", p)
        self.assertIn("[I2] T: T17；", p)  # 時刻・発言者は付けない

    def ai(self, **over):
        base = {"title": "サンプル燃料から最終明細を受け取る", "dept": "naimu", "kind": "new", "description": "T17",
                "purpose": "", "deliverable": "", "completion_criteria": "", "open_questions": "",
                "assignee": "相生", "deadline": "2026-10-15", "explicit": True, "confidence": "high",
                "refs": ["I2"], "quote": "最終明細を受け取る", "reason": ""}
        base.update(over)
        return {"candidates": [base]}

    def test_inventory_auto_needs_both_assignee_and_deadline(self):
        items = self.items()
        cands, _ = L.validate(self.ai(), items, ROUTES, self.book, NOW)
        self.assertEqual(L.decide(cands, [], L.Limits(), NOW, True, auto_budget=20)[0].decision, "auto")
        cands, _ = L.validate(self.ai(deadline=None), items, ROUTES, self.book, NOW)
        out = L.decide(cands, [], L.Limits(), NOW, True, auto_budget=20)
        self.assertEqual(out[0].decision, "review")
        self.assertIn("両方", out[0].decision_note)
        cands, _ = L.validate(self.ai(), items, ROUTES, self.book, NOW)
        self.assertEqual(L.decide(cands, [], L.Limits(), NOW, True, auto_budget=0)[0].decision, "review")
        self.assertIn("_目録/調査/inv.md（T17）", L.task_description(cands[0]))
        self.assertIn("担当候補(原文の名前): 相生", L.task_description(cands[0]))


class TagTests(Fixture):
    ROUTES3 = [L.Route("naimu", "内務部", 100, ""), L.Route("gaimu", "外務部", 300, ""), L.Route("yakuin", "役員会", 200, "")]

    def test_parse_tags_and_route(self):
        self.assertEqual(L.parse_tags({"tags": ["koho", "企画課", "x", "koho"]}), ("koho", "kikaku"))
        self.assertEqual(L.parse_tags({"dept": "naimu"}), ("naimu",))           # 古い形も受ける
        self.assertEqual(L.parse_tags({"tags": ["a", "b"]}), ())
        self.assertEqual(L.parse_tags({"tags": ["kikaku", "kaijo", "koho", "shogai"]}), ("kikaku", "kaijo", "koho"))
        self.assertEqual(L.route_for_tags(("koho", "kikaku"), self.ROUTES3).key, "gaimu")   # 先頭の部局の部
        self.assertEqual(L.route_for_tags(("kikaku",), self.ROUTES3).key, "naimu")
        self.assertEqual(L.route_for_tags(("soumu",), self.ROUTES3).key, "yakuin")          # 投稿先が無ければ役員会
        self.assertEqual(L.route_for_tags((), self.ROUTES3).key, "yakuin")
        self.assertIn("kikaku: 企画課（内務部の課）", L.department_lines())

    def test_validate_keeps_tags(self):
        self.write("企画課__1.jsonl", [msg(30, "11", "相生です。パンフの訂正紙を10/15までに作ります")])
        b = L.select_batch(L.read_discord(self.raw, {}, RULES, self.book, 9, NOW, L.Limits()), L.Limits())
        data = {"candidates": [{"title": "訂正紙を作る", "tags": ["koho", "kikaku"], "refs": ["D1"],
                                "confidence": "high", "explicit": True, "quote": "パンフの訂正紙を10/15までに作ります"}]}
        cands, _ = L.validate(data, b, self.ROUTES3, self.book, NOW)
        self.assertEqual((cands[0].tags, cands[0].route.key), (("koho", "kikaku"), "gaimu"))
        data["candidates"][0].pop("tags")
        cands, _ = L.validate(data, b, self.ROUTES3, self.book, NOW)
        self.assertEqual((cands[0].tags, cands[0].route.key), (("yakuin",), "yakuin"))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ScreeningStore.open(Path(self.tmp.name) / "s" / "c.sqlite3")

    def tearDown(self):
        self.tmp.cleanup()

    def row(self, fp="f1", decision="review"):
        return {"fingerprint": fp, "route_key": "naimu", "route_label": "内務部", "channel_id": 100,
                "title": "t", "description": "d", "purpose": "", "deliverable": "", "completion_criteria": "",
                "open_questions": "", "assignee_name": None, "assignee_id": None, "deadline": None,
                "confidence": "high", "decision": decision, "decision_note": "", "reason": "", "sources": "[]"}

    def test_add_dedup_and_claim_flow(self):
        run = self.store.start_run()
        cid = self.store.add(run, self.row())
        self.assertIsNotNone(cid)
        self.assertIsNone(self.store.add(run, self.row()))         # 同じ指紋は追加しない
        claimed = self.store.claim_new(5)
        self.assertEqual([c.id for c in claimed], [cid])
        self.assertEqual(self.store.claim_new(5), [])               # 二重に取らない
        self.assertTrue(self.store.transition(cid, "publishing", "posted", message_id=5))
        self.assertTrue(self.store.transition(cid, "posted", "creating", decided_by=7))
        self.assertFalse(self.store.transition(cid, "posted", "rejected", decided_by=8))   # 取り合いに負ける
        self.assertTrue(self.store.transition(cid, "creating", "created", task_number=3))
        c = self.store.get(cid)
        self.assertEqual((c.state, c.task_number, c.decided_by, c.message_id), ("created", 3, 7, 5))
        self.store.finish_run(run, "ok", candidates=1)

    def test_meta_and_release(self):
        self.store.set_meta("cursor", {"a": "b"})
        self.assertEqual(self.store.get_meta("cursor"), {"a": "b"})
        cid = self.store.add(self.store.start_run(), self.row("f2"))
        self.store.claim_new(1)
        self.assertEqual(self.store.release_stale(minutes=-1), 1)
        self.assertEqual(self.store.get(cid).state, "new")

    def test_decision_log_and_return_revise(self):
        run = self.store.start_run()
        cid = self.store.add(run, self.row("f3"))
        self.store.claim_new(1)
        self.store.transition(cid, "publishing", "posted", message_id=9)
        # 状態が変わらなかったときは記録しない
        self.assertFalse(self.store.transition(cid, "new", "rejected", log=("ng", 5, "", None, "")))
        self.assertTrue(self.store.transition(cid, "posted", "returned", decided_by=5, comment="期限は10/16",
                                              log=("return", 5, "期限は10/16", None, "")))
        self.assertEqual([c.id for c in self.store.returned()], [cid])
        new = self.store.add(run, dict(self.row("f4"), revision_of=cid))
        self.assertTrue(self.store.mark_revised(cid, [new], "期限を10/16にした"))
        old = self.store.get(cid)
        self.assertEqual((old.state, old.revised_to, old.comment), ("revised", str(new), "期限は10/16"))
        self.assertEqual(self.store.get(new).revision_of, cid)
        acts = [(d.candidate_id, d.action, d.actor_id, d.comment, d.related) for d in self.store.decisions()]
        self.assertEqual(acts, [(cid, "return", 5, "期限は10/16", ""), (cid, "revised", None, "期限を10/16にした", str(new))])

    def test_migrates_v1_ledger(self):
        import sqlite3
        path = Path(self.tmp.name) / "v1.sqlite3"
        con = sqlite3.connect(path)
        con.executescript("""
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '1'), ('cursor', '{"a": "b"}');
CREATE TABLE runs(id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0, candidates INTEGER NOT NULL DEFAULT 0, auto INTEGER NOT NULL DEFAULT 0,
  review INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '');
CREATE TABLE candidates(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
  route_key TEXT NOT NULL, route_label TEXT NOT NULL, channel_id INTEGER NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, purpose TEXT NOT NULL, deliverable TEXT NOT NULL, completion_criteria TEXT NOT NULL,
  open_questions TEXT NOT NULL, assignee_name TEXT, assignee_id INTEGER, deadline TEXT, confidence TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('auto','review')), decision_note TEXT NOT NULL, reason TEXT NOT NULL,
  sources TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('new','publishing','posted','creating','created',
  'rejected','undoing','undone','failed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message_id INTEGER,
  task_number INTEGER, decided_by INTEGER, error TEXT);
CREATE INDEX candidates_by_state ON candidates(state, id);
INSERT INTO candidates VALUES (1,1,'x','naimu','内務部',100,'自動の','d','','','','',NULL,NULL,NULL,'high','auto','',
  '','[]','created','2026-10-13T13:00:00+00:00','2026-10-13T13:01:00+00:00',11,1,777,NULL);
INSERT INTO candidates VALUES (2,1,'y','naimu','内務部',100,'承認待ちの','d','','','','',NULL,NULL,NULL,'medium',
  'review','','','[]','posted','2026-10-13T13:00:00+00:00','2026-10-13T13:02:00+00:00',12,NULL,NULL,NULL);
""")
        con.commit()
        con.close()
        store = ScreeningStore.open(path)
        self.assertEqual(store.get_meta("schema_version"), 3)
        self.assertEqual(store.get(2).tag_list, ["naimu"])                     # 部局は投稿先の部
        self.assertEqual(store.get_meta("cursor"), {"a": "b"})
        self.assertEqual((store.get(1).state, store.get(1).task_number), ("created", 1))
        self.assertEqual(store.get(2).state, "posted")
        self.assertEqual([(d.candidate_id, d.action, d.actor_id, d.task_number) for d in store.decisions()],
                         [(1, "auto", 777, 1)])
        self.assertTrue(store.transition(2, "posted", "returned", comment="c"))   # 新しい状態が使える
        ScreeningStore.open(path)   # 2 回目は何もしない


class LedgerV3Tests(unittest.TestCase):
    def test_v2_ledger_gets_tags_column(self):
        import sqlite3
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "c.sqlite3"
        store = ScreeningStore.open(path)
        cid = store.add(store.start_run(), {
            "fingerprint": "f", "route_key": "gaimu", "route_label": "外務部", "channel_id": 1, "title": "t",
            "description": "", "purpose": "", "deliverable": "", "completion_criteria": "", "open_questions": "",
            "assignee_name": None, "assignee_id": None, "deadline": None, "confidence": "high", "decision": "review",
            "decision_note": "", "reason": "", "sources": "[]"})
        con = sqlite3.connect(path)
        if sqlite3.sqlite_version_info < (3, 35):
            self.skipTest("DROP COLUMN が使えない SQLite")
        con.execute("ALTER TABLE candidates DROP COLUMN tags")
        con.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
        con.commit()
        con.close()
        store = ScreeningStore.open(path)
        self.assertEqual(store.get_meta("schema_version"), 3)
        self.assertEqual(store.get(cid).tag_list, ["gaimu"])
        new = store.add(store.start_run(), {
            "fingerprint": "g", "route_key": "naimu", "route_label": "内務部", "channel_id": 1, "title": "u",
            "description": "", "purpose": "", "deliverable": "", "completion_criteria": "", "open_questions": "",
            "assignee_name": None, "assignee_id": None, "deadline": None, "confidence": "high", "decision": "review",
            "decision_note": "", "reason": "", "sources": "[]", "tags": '["kikaku", "koho"]'})
        self.assertEqual(store.get(new).tag_list, ["kikaku", "koho"])


class RevisionTests(Fixture):
    def item(self):
        refs = [L.Message(ref="R1", kind="discord", source="#企画課", trusted=False, ts=NOW, author="相生次郎",
                          text="サンプル燃料に搬入時刻を連絡します", link="https://discord.com/channels/9/1/2", file_key="")]
        return L.ReturnItem(cid=42, route=ROUTES[0], tags=("naimu",), title="サンプル燃料に連絡する", deadline=None,
                            assignee_name="相生",
                            description="説明", purpose="", deliverable="", completion_criteria="", open_questions="",
                            comment="期限は10/15、担当は中村さん。搬入時刻と明細で2つに分けて", commenter="若葉花子",
                            refs=refs)

    def test_prompt_and_parse_split(self):
        it = self.item()
        p = L.build_revision_prompt([it], ROUTES, NOW)
        self.assertIn("### C42", p)
        self.assertIn("差し戻しコメント（若葉花子）", p)
        self.assertIn("[R1] #企画課 10/13 21:00 相生次郎:", p)
        data = {"revisions": [{"candidate": "C42", "note": "2つに分け、期限と担当を直した", "items": [
            {"title": "サンプル燃料に搬入時刻を連絡する", "dept": "naimu", "assignee": "中村太郎", "deadline": "2026-10-15"},
            {"title": "サンプル燃料から最終明細を受け取る", "dept": "yakuin", "assignee": None, "deadline": "2026-10-15"},
            {"title": "3件目", "dept": "naimu"}, {"title": "4件目は捨てる", "dept": "naimu"}]},
            {"candidate": "C99", "items": [{"title": "知らない候補"}]}]}
        out = L.parse_revisions(data, [it], ROUTES, self.book, NOW)
        self.assertEqual(list(out), [42])
        cands, note = out[42]
        self.assertEqual(len(cands), 3)                         # 最大 3 件
        self.assertEqual(cands[0].assignee_id, "12")
        self.assertEqual(cands[1].route.key, "yakuin")
        self.assertTrue(all(c.decision == "review" for c in cands))   # 修正版は必ず承認待ち
        self.assertIn("差し戻しを反映（若葉花子:", cands[0].decision_note)
        self.assertEqual(len({c.fp for c in cands}), 3)
        self.assertNotEqual(cands[0].fp, L.fingerprint("naimu", cands[0].title))  # 元と同じタイトルでもぶつからない
        self.assertEqual(note, "2つに分け、期限と担当を直した")

    def test_strip_source_tail(self):
        self.assertEqual(L.strip_source_tail("本文\n\n出典:\n- #企画課"), "本文")
        with self.assertRaises(ValueError):
            L.parse_revisions({"candidates": []}, [self.item()], ROUTES, self.book, NOW)


if __name__ == "__main__":
    unittest.main()
