# -*- coding: utf-8 -*-
"""TaskScreening Cog の流れを、偽の Discord オブジェクトと一時的な /todo の SQLite で確かめる。

discord.py が入った環境(Bot ホストの venv)で実行する。実際の Discord には接続しない。
TaskStore はローカルディスク上でしか開けないため、一時ディレクトリは SCREENING_TEST_DIR
(既定 ~/.iyakusai/task-screening/test-tmp)の下に作り、終わったら消す。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from iyakusai_bot import screening_cog as C  # noqa: E402
from iyakusai_bot.screening_store import ScreeningStore  # noqa: E402
from iyakusai_bot.task_cog import Access  # noqa: E402
from iyakusai_bot.task_domain import Actor, Scope  # noqa: E402
from iyakusai_bot.task_store import TaskSettings, TaskStore  # noqa: E402

GUILD, CHANNEL, BOT_ID, USER, OTHER = 9001, 9002, 9003, 9004, 9005


class Perms:
    view_channel = True
    send_messages = True


class Member:
    def __init__(self, uid, bot=False):
        self.id, self.bot = uid, bot


class Guild:
    id = GUILD
    me = Member(BOT_ID, bot=True)

    def get_member(self, uid):
        return Member(uid) if uid in (USER, OTHER) else None

    async def fetch_member(self, uid):
        import discord
        raise discord.NotFound(type("R", (), {"status": 404, "reason": "x"})(), "x")


class Message:
    def __init__(self, mid, content):
        self.id, self.content, self.edits = mid, content, []

    async def edit(self, content=None, view=None, allowed_mentions=None):
        self.edits.append(content)
        self.content = content


class Channel:
    id = CHANNEL
    guild = Guild()

    def __init__(self):
        self.sent = []

    def permissions_for(self, member):
        return Perms()

    async def send(self, content, view=None, allowed_mentions=None):
        m = Message(1000 + len(self.sent), content)
        self.sent.append((content, [i.custom_id for i in view.children] if view else []))
        return m


class Bot:
    user = Member(BOT_ID, bot=True)


class Response:
    def __init__(self):
        self.sent = []
        self.deferred = False

    def is_done(self):
        return self.deferred or bool(self.sent)

    async def defer(self, **kwargs):
        self.deferred = True

    async def send_message(self, text, **kwargs):
        self.sent.append(text)


class Followup:
    def __init__(self, response):
        self.response = response

    async def send(self, text, **kwargs):
        self.response.sent.append(text)


class Itx:
    def __init__(self, message):
        self.message = message
        self.response = Response()
        self.followup = Followup(self.response)


def row(fp, decision, title, assignee_id=None):
    return {"fingerprint": fp, "route_key": "naimu", "route_label": "内務部", "channel_id": CHANNEL,
            "title": title, "description": "説明\n\n出典:\n- #企画課 10/13 20:30 相生: https://discord.com/x",
            "purpose": "目的", "deliverable": "", "completion_criteria": "連絡済み", "open_questions": "",
            "assignee_name": "相生" if assignee_id else None, "assignee_id": assignee_id, "deadline": "2026-10-15",
            "confidence": "high", "decision": decision, "decision_note": "テスト", "reason": "理由",
            "sources": '[{"kind": "discord", "source": "#企画課", "ts": "2026-10-13T11:30:00+00:00", '
                       '"author": "相生", "link": "https://discord.com/channels/1/2/3"}]'}


class CogFlow(unittest.TestCase):
    def setUp(self):
        base = Path(os.environ.get("SCREENING_TEST_DIR", Path.home() / ".iyakusai/task-screening/test-tmp"))
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.dir = Path(tempfile.mkdtemp(dir=base))
        self.tasks = TaskStore.open(self.dir / "tasks")
        self.store = ScreeningStore.open(self.dir / "cand.sqlite3")
        settings = TaskSettings(enabled=True, guild_ids=(GUILD,), channel_ids=(), store_dir=self.dir / "tasks")
        self.trigger = self.dir / "followup.request"
        self.cog = C.TaskScreening(Bot(), settings, self.tasks, self.store, trigger_path=self.trigger)
        self.channel = Channel()
        self.cog._channel = lambda c: self.channel

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def access(self, uid):
        return Access(scope=Scope(GUILD, CHANNEL), actor=Actor(user_id=uid, operation_id="x" * 10),
                      guild=Guild(), channel=self.channel)

    def test_publish_approve_reject_undo(self):
        run = self.store.start_run()
        a = self.store.add(run, row("a", "auto", "サンプル燃料に搬入時刻を連絡する", USER))
        r1 = self.store.add(run, row("b", "review", "救護担当を決める"))
        r2 = self.store.add(run, row("c", "review", "訂正紙の要否を決める"))

        async def go():
            for c in self.store.claim_new(10):
                await self.cog._publish(c)
            # 自動起票: Bot 名義・担当つきで #1、お知らせに取り消しボタン
            ca = self.store.get(a)
            self.assertEqual((ca.state, ca.task_number), ("created", 1))
            t1 = self.tasks.get_task(Scope(GUILD, CHANNEL), 1).task
            self.assertEqual((t1.created_by, t1.assignee_id, t1.deadline), (BOT_ID, USER, "2026-10-15"))
            self.assertEqual(t1.requirements["completion_criteria"], "連絡済み")
            hist, _ = self.tasks.history(Scope(GUILD, CHANNEL), 1)
            self.assertEqual(hist[-1].source, "screening")
            self.assertEqual(self.channel.sent[0][1], [f"tscr:rt:{a}", f"tscr:undo:{a}"])
            self.assertIn("自動起票しました", self.channel.sent[0][0])
            # 承認待ち: 2 件投稿、ボタンは起票する / 不要
            self.assertEqual(self.store.get(r1).state, "posted")
            self.assertEqual(self.channel.sent[1][1], [f"tscr:ok:{r1}", f"tscr:rt:{r1}", f"tscr:ng:{r1}"])
            # 起票する → 押した人の名義で #2
            msg = Message(1, self.channel.sent[1][0])
            text = await self.cog._approve(Itx(msg), self.access(OTHER), self.store.get(r1))
            self.assertIn("#2", text)
            t2 = self.tasks.get_task(Scope(GUILD, CHANNEL), 2).task
            self.assertEqual(t2.created_by, OTHER)
            self.assertIn("起票", msg.edits[-1])
            # 二度目は「すでに起票済み」で新しく作らない
            again = await self.cog._approve(Itx(msg), self.access(USER), self.store.get(r1))
            self.assertIn("すでに", again)
            self.assertEqual(len(self.tasks.list_tasks(Scope(GUILD, CHANNEL))), 2)
            # 不要
            msg3 = Message(2, self.channel.sent[2][0])
            await self.cog._reject(Itx(msg3), self.access(USER), self.store.get(r2))
            self.assertEqual(self.store.get(r2).state, "rejected")
            self.assertIn("不要", msg3.edits[-1])
            # 誤起票として閉じる → #1 は完了扱い、説明に記録
            msg1 = Message(3, self.channel.sent[0][0])
            await self.cog._undo(Itx(msg1), self.access(USER), self.store.get(a))
            t1 = self.tasks.get_task(Scope(GUILD, CHANNEL), 1).task
            self.assertEqual(t1.status, "done")
            self.assertIn("誤起票", t1.description)
            self.assertEqual(self.store.get(a).state, "undone")

        asyncio.run(go())

    def test_decisions_logged_and_return_flow(self):
        run = self.store.start_run()
        a = self.store.add(run, row("f", "auto", "冷蔵庫を室内へ搬入する", USER))
        r1 = self.store.add(run, row("g", "review", "救護担当を決める"))
        r2 = self.store.add(run, row("h", "review", "訂正紙の要否を決める"))

        async def go():
            for c in self.store.claim_new(10):
                await self.cog._publish(c)
            await self.cog._approve(Itx(Message(1, self.channel.sent[1][0])), self.access(OTHER), self.store.get(r1))
            # 差し戻し: コメントが台帳と判定記録に残り、投稿が書き換わり、後続処理の起動依頼が書かれる
            self.cog._authorize = lambda itx, cid: self._auth(cid)
            msg = Message(2, self.channel.sent[2][0])
            itx = Itx(msg)
            await self.cog.submit_return(itx, r2, "期限は10/16、担当は鈴蘭さん", msg)
            c = self.store.get(r2)
            self.assertEqual((c.state, c.comment, c.decided_by), ("returned", "期限は10/16、担当は鈴蘭さん", USER))
            self.assertIn("差し戻し", msg.edits[-1])
            self.assertIn("修正版", itx.response.sent[-1])
            # 二度目は「すでに差し戻し済み」
            itx2 = Itx(msg)
            await self.cog.submit_return(itx2, r2, "もう一度", msg)
            self.assertIn("すでに", itx2.response.sent[-1])
            # 空のコメントは受け付けない
            r3 = self.store.add(self.store.start_run(), row("i", "review", "腕章の数を数える"))
            self.store.claim_new(1)
            self.store.transition(r3, "publishing", "posted", message_id=5)
            itx3 = Itx(msg)
            await self.cog.submit_return(itx3, r3, "   ", msg)
            self.assertEqual(self.store.get(r3).state, "posted")

        async def auth(cid):
            return self.access(USER), self.store.get(cid)
        self._auth = auth
        asyncio.run(go())
        acts = [(d.candidate_id, d.action, d.actor_id, d.comment) for d in self.store.decisions()]
        self.assertEqual(acts, [(a, "auto", BOT_ID, ""), (r1, "ok", OTHER, ""),
                                (r2, "return", USER, "期限は10/16、担当は鈴蘭さん")])
        lines = self.trigger.read_text(encoding="utf-8").splitlines()
        self.assertEqual([ln.split("\t")[1:] for ln in lines], [["auto", str(a)], ["ok", str(r1)], ["return", str(r2)]])
        # 修正版の投稿は「修正版」と元の候補番号・コメントを示す
        new = self.store.add(self.store.start_run(), dict(row("j", "review", "救護担当を10/16までに決める"),
                                                          revision_of=r2, decision_note="差し戻しを反映（X: 期限）"))
        text = C.review_text(self.store.get(new))
        self.assertIn("差し戻しの修正版", text)
        self.assertIn(f"元の候補: {r2}", text)

    def test_return_auto_created_closes_task(self):
        a = self.store.add(self.store.start_run(), row("m", "auto", "サンプル燃料に搬入時刻を連絡する", USER))

        async def auth(cid):
            return self.access(OTHER), self.store.get(cid)

        async def go():
            for c in self.store.claim_new(10):
                await self.cog._publish(c)
            self.cog._authorize = lambda itx, cid: auth(cid)
            msg = Message(1, self.channel.sent[0][0])
            itx = Itx(msg)
            await self.cog.submit_return(itx, a, "担当は鈴蘭さん、期限は10/16", msg)
            self.assertIn("#1 は閉じ", itx.response.sent[-1])
            self.assertIn("差し戻し", msg.edits[-1])
            # 同じ投稿でもう一度押しても、二重には閉じない
            itx2 = Itx(msg)
            await self.cog.submit_return(itx2, a, "もう一度", msg)
            self.assertIn("すでに", itx2.response.sent[-1])

        asyncio.run(go())
        t1 = self.tasks.get_task(Scope(GUILD, CHANNEL), 1).task
        self.assertEqual(t1.status, "done")
        self.assertIn("[差し戻し: 担当は鈴蘭さん、期限は10/16。修正版を候補として出し直す]", t1.description)
        c = self.store.get(a)
        self.assertEqual((c.state, c.comment, c.decided_by), ("returned", "担当は鈴蘭さん、期限は10/16", OTHER))
        self.assertEqual([c.id for c in self.store.returned()], [a])
        last = self.store.decisions()[-1]
        self.assertEqual((last.action, last.actor_id, last.task_number), ("return", OTHER, 1))

    def test_export_tsv(self):
        from iyakusai_bot import screening_run as R
        from iyakusai_bot.screening_logic import NameBook
        cid = self.store.add(self.store.start_run(), row("k", "review", "タブ\tを含む\nタイトル"))
        self.store.claim_new(1)
        self.store.transition(cid, "publishing", "posted", message_id=1)
        self.store.transition(cid, "posted", "returned", decided_by=USER, comment="直して\n2行目",
                              log=("return", USER, "直して\n2行目", None, ""))
        path = R.export_decisions(self.store, NameBook({"people": {str(USER): {"nick": "若葉花子"}}}), self.dir / "rep")
        rows = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(rows[0].split("\t")[0], "日時")
        cells = rows[1].split("\t")
        self.assertEqual(len(cells), 9)
        self.assertEqual(cells[1:7], [str(cid), "内務部", "タブ を含む タイトル", "差し戻し", "若葉花子", "直して 2行目"])

    def test_auto_disabled_posts_for_review(self):
        self.cog.auto_create = False
        cid = self.store.add(self.store.start_run(), row("d", "auto", "無線機30台を受け取る"))

        async def go():
            for c in self.store.claim_new(10):
                await self.cog._publish(c)
        asyncio.run(go())
        self.assertEqual(self.store.get(cid).state, "posted")
        self.assertEqual(self.tasks.list_tasks(Scope(GUILD, CHANNEL)), [])

    def test_texts_and_custom_id(self):
        import re
        c = self.store.get(self.store.add(self.store.start_run(), row("e", "review", "あ" * 120)))
        self.assertLessEqual(len(C.review_text(c)), C.MESSAGE_LIMIT)
        self.assertLessEqual(len(C.auto_text(c, 12, None)), C.MESSAGE_LIMIT)
        pattern = C.ScreeningButton.__discord_ui_compiled_template__
        self.assertTrue(pattern.fullmatch("tscr:ok:123"))
        self.assertIsNone(pattern.fullmatch("tscr:ok:abc"))


if __name__ == "__main__":
    unittest.main()
