# -*- coding: utf-8 -*-
"""統合アプリ「Bot」タブの Cog を、偽の Discord で動かす試験(実 Discord には接続しない)。

既存の /ask・/doc・候補ボタンの本体は実物を使う。偽物は Discord の入れ物(チャンネル・メンバー・
メッセージ)と、外部の AI(provider)・Gemini だけ。TaskStore・ScreeningStore・ReminderStore は
一時フォルダの実物。
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

import discord  # noqa: E402

from iyakusai_bot import assistant_cog as AC  # noqa: E402
from iyakusai_bot import assistant_logic as L  # noqa: E402
from iyakusai_bot import images as IM  # noqa: E402
from iyakusai_bot import mail_draft  # noqa: E402
from iyakusai_bot import screening_cog as SC  # noqa: E402
from iyakusai_bot.ai_provider import AIError, AIResult  # noqa: E402
from iyakusai_bot.assistant_store import AssistantStore  # noqa: E402
from iyakusai_bot.config import AssistantSettings, ImageSettings  # noqa: E402
from iyakusai_bot.documents import Documents  # noqa: E402
from iyakusai_bot.knowledge import Knowledge  # noqa: E402
from iyakusai_bot.knowledge_search import Excerpt, SearchResult  # noqa: E402
from iyakusai_bot.progress import PHASE_LABELS  # noqa: E402
from iyakusai_bot.screening_store import ScreeningStore  # noqa: E402
from iyakusai_bot.storage import ReminderStore  # noqa: E402
from iyakusai_bot.task_cog import Access  # noqa: E402
from iyakusai_bot.task_domain import Actor, Scope, TaskError  # noqa: E402
from iyakusai_bot.task_store import TaskSettings, TaskStore  # noqa: E402
from iyakusai_bot.web_interaction import WebInteraction  # noqa: E402

# 合成の ID(実在しない値。Discord の ID と同じ桁数にして入力検査を通す)
GUILD, SHARE, REMIND_CH, OTHER_CH, CANDIDATE_CH = (1000000000000000101, 1000000000000000102,
                                                    1000000000000000103, 1000000000000000104,
                                                    1000000000000000105)
BOT_ID = 1000000000000000199
ACTOR, TARGET, ADMIN, OUTSIDER = 1000000000000000001, 1000000000000000002, 1000000000000000003, 1000000000000000004
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


class _Resp:
    status = 404
    reason = "Not Found"


class FakeMember:
    def __init__(self, uid, name, *, manage=False, bot=False):
        self.id = uid
        self.name = name
        self.display_name = name
        self.bot = bot
        self.guild_permissions = discord.Permissions(manage_guild=manage)


class FakeGuild:
    id = GUILD

    def __init__(self, members):
        self.members = {m.id: m for m in members}
        self.me = FakeMember(BOT_ID, "bot", bot=True)

    def get_member(self, uid):
        return self.members.get(uid)

    async def fetch_member(self, uid):
        member = self.members.get(uid)
        if member is None:
            raise discord.NotFound(_Resp(), "unknown member")
        return member

    def fetch_members(self, limit=None):
        # 本番の Bot は members インテントを要求していないので、discord.py は一覧の取得を拒む(2026-10-14)
        raise discord.ClientException("Intents.members must be enabled to use this.")


class FakeMessage:
    def __init__(self, channel, mid, content, files=()):
        self.channel = channel
        self.id = mid
        self.content = content
        self.attachments = list(files)
        self.edits = []   # 編集のたびに書き換え後の本文を残す(進捗の確認用)
        self.jump_url = f"https://discord.com/channels/{GUILD}/{channel.id}/{mid}"

    async def edit(self, content=None, attachments=None, view=None, allowed_mentions=None, **kwargs):
        if content is not None:
            self.content = content
        if attachments is not None:
            self.attachments = list(attachments)
        self.edits.append(self.content)
        return self


class FakeChannel:
    def __init__(self, cid, guild, name):
        self.id = cid
        self.guild = guild
        self.name = name
        self.sent: list[FakeMessage] = []
        self.by_id: dict[int, FakeMessage] = {}
        self.mentions_seen = []

    def permissions_for(self, member):
        return discord.Permissions(view_channel=True, send_messages=True)

    async def send(self, content=None, *, file=None, files=None, view=None, allowed_mentions=None,
                   embed=None, embeds=None):
        self.mentions_seen.append(allowed_mentions)
        message = FakeMessage(self, 7000 + len(self.sent), content, [file] if file else list(files or []))
        self.sent.append(message)
        self.by_id[message.id] = message
        return message

    async def fetch_message(self, mid):
        if mid not in self.by_id:
            raise discord.NotFound(_Resp(), "no message")
        return self.by_id[mid]


class FakeBot:
    user = SimpleNamespace(id=BOT_ID)

    def __init__(self, channels):
        self.channels = {c.id: c for c in channels}
        self.cogs = {}
        self.cfg = None

    def get_channel(self, cid):
        return self.channels.get(cid)

    def get_cog(self, name):
        return self.cogs.get(name)


class FakeKB:
    def search(self, query, max_excerpts=10, use_fields=True):
        return SearchResult(terms=["発電機"], excerpts=[
            Excerpt(source="2026医薬祭/サンプル部/発電機.md", text="発電機は3台をレンタルする方針です。", score=9)])


class FakeProvider:
    effort = ""

    def __init__(self):
        self.gemini = None
        self.probe = None

    def choose_model(self, text, kind=None, override=None):
        return override if override and override != "auto" else "sonnet"

    async def answer(self, question, context, model=None, **kwargs):
        await asyncio.sleep(0.3)   # 進捗の書き込みが何度か起きる時間を与える
        if self.probe is not None:
            self.probe()
        return AIResult(text="発電機は3台です。", model=model or "sonnet",
                        usage={"input_tokens": 10, "output_tokens": 5})

    async def draft(self, doc_type, instruction, context="", model=None):
        return AIResult(text="# 発電機の見積依頼\n\n株式会社◯◯ 御中\n本文です。", model=model or "sonnet",
                        usage={"input_tokens": 10, "output_tokens": 5})

    async def complete(self, prompt, model=None, timeout=None, effort=None):
        # メールの草案(mail_draft の指示)はここに来る。AI がコードブロックで囲んで返す癖も再現する
        self.prompts = getattr(self, "prompts", []) + [prompt]
        return AIResult(text="```\n件名: 発電機お見積りのお願い(医学薬学祭実行委員会)\n\n"
                             "株式会社◯◯\n【担当者名】様\n\n本文です。\n【氏名】\n```",
                        model=model or "sonnet", usage={"input_tokens": 10, "output_tokens": 5})


class FakeTaskCog:
    """TaskCog.authorize の代わり。実物は権限の判定そのものなので、ここでは許可・拒否だけ決める。"""

    def __init__(self, channel, allow=True):
        self.channel, self.allow = channel, allow

    def authorize(self, itx, *, edit):
        if not self.allow:
            raise TaskError("FORBIDDEN", "この場所では操作できません。")
        return Access(scope=Scope(GUILD, self.channel.id), actor=Actor(user_id=itx.user.id, operation_id=itx.id),
                      guild=self.channel.guild, channel=self.channel)


def candidate_row(fingerprint, decision, title):
    return {"fingerprint": fingerprint, "route_key": "naimu", "route_label": "内務部", "channel_id": CANDIDATE_CH,
            "title": title, "description": "説明", "purpose": "目的", "deliverable": "", "completion_criteria": "連絡済み",
            "open_questions": "", "assignee_name": None, "assignee_id": None, "deadline": "2030-01-10",
            "confidence": "high", "decision": decision, "decision_note": "テスト", "reason": "理由",
            "sources": '[{"kind": "discord", "source": "#企画課", "ts": "2026-10-13T11:30:00+00:00", '
                       '"author": "柏葉", "link": "https://discord.com/channels/1/2/3"}]'}


class AssistantCase(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="assistant-cog-"))
        self.store = AssistantStore.open(self.dir / "jobs.sqlite3")
        self.guild = FakeGuild([
            FakeMember(ACTOR, "テスト委員"), FakeMember(TARGET, "鈴蘭"),
            FakeMember(ADMIN, "役員", manage=True), FakeMember(OUTSIDER, "外部"),
        ])
        self.share = FakeChannel(SHARE, self.guild, "bottest")
        self.remind = FakeChannel(REMIND_CH, self.guild, "内務部")
        self.other = FakeChannel(OTHER_CH, self.guild, "別部")
        self.candidate = FakeChannel(CANDIDATE_CH, self.guild, "企画課")
        self.bot = FakeBot([self.share, self.remind, self.other, self.candidate])
        self.reminders = ReminderStore(self.dir / "data")
        (self.dir / "data").mkdir()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def settings(self):
        return AssistantSettings(enabled=True, store_path=self.dir / "jobs.sqlite3", files_dir=self.dir / "files",
                                 share_channel_id=SHARE, reminder_channel_ids=[REMIND_CH, OTHER_CH],
                                 poll_sec=2, max_active_per_user=3)

    def cog(self):
        return AC.Assistant(self.bot, self.settings(), self.store, reminders=self.reminders)

    def job(self, kind, input_obj, *, op=None, actor=ACTOR, name="テスト委員"):
        job, _ = self.store.enqueue(f"discord-{actor}", name, f"op-{kind}-{os.urandom(4).hex()}", kind, op,
                                    input_obj, max_active=10)
        return job


class AskDocTests(AssistantCase):
    def ask_input(self, **over):
        base = {"question": "発電機のレンタルは?", "model": "auto", "effort": "auto", "tone": None, "format": None}
        base.update(over)
        return base

    def test_ask_posts_header_to_share_channel_and_stores_the_answer(self):
        async def go():
            provider = FakeProvider()
            seen = []
            provider.probe = lambda: seen.append(self.store.get(job.id).progress)
            self.bot.cfg = SimpleNamespace(ai_progress=True, ai_progress_interval_sec=0.05, mirror_dir=None,
                                           ai_agent_model="sonnet", ai_agent_effort="")
            knowledge = Knowledge(self.bot, FakeKB(), provider, None, 160.0, None, None)
            self.bot.cogs["Knowledge"] = knowledge
            cog = self.cog()
            job = self.job("ask", self.ask_input())
            await cog._run(self.store.claim_next(("ask",)), "ask_doc")
            return job, seen
        job, seen = asyncio.run(go())
        done = self.store.get(job.id)
        self.assertEqual(done.state, "done", done.error_message)
        self.assertIn("発電機は3台です。", done.result["text"])
        header = self.share.sent[0]
        self.assertEqual(done.discord_url, header.jump_url)
        # 進捗が出ていたので、回答の 1 通目は元の応答(#bottest の最初の投稿)に書き換わる。
        # 投稿は 1 件だけ。進捗の編集は edits に残る(本文とは別物)
        self.assertEqual(len(self.share.sent), 1)
        self.assertIn("発電機は3台です。", header.content)
        self.assertTrue(any("質問を読み解" in (e or "") or "資料" in (e or "") for e in header.edits[:-1]))
        # 書き換えても「誰の質問か」の 1 行は先頭に残る。結果の本文には入れない(アプリは自分で出す)
        self.assertTrue(header.content.startswith("📱 アプリから テスト委員 さんの質問\n"))
        self.assertTrue(all((e or "").startswith("📱 アプリから") for e in header.edits))
        self.assertNotIn("📱 アプリから", done.result["text"])
        # 通知の宛先は付けない(アプリ発の本文で誰も呼び出さない)
        self.assertFalse(self.share.mentions_seen[0].users)
        # 進捗はジョブ表に入り、本文とは区別される
        self.assertTrue(seen and seen[0] and seen[0]["phase"] in PHASE_LABELS)
        self.assertNotIn("発電機は3台", seen[0]["text"])

    def test_ask_answer_text_is_what_discord_would_show(self):
        async def go():
            knowledge = Knowledge(self.bot, FakeKB(), FakeProvider(), None, 160.0, None, None)
            self.bot.cogs["Knowledge"] = knowledge
            cog = self.cog()
            job = self.job("ask", self.ask_input())
            await cog._run(self.store.claim_next(("ask",)), "ask_doc")
            return self.store.get(job.id)
        done = asyncio.run(go())
        self.assertIn("**Q: 発電機のレンタルは?**", done.result["text"])
        self.assertIn("-# [1] 2026医薬祭/サンプル部/発電機.md", done.result["text"])

    def test_ask_without_knowledge_cog_fails_with_japanese_message(self):
        async def go():
            cog = self.cog()
            job = self.job("ask", self.ask_input())
            await cog._run(self.store.claim_next(("ask",)), "ask_doc")
            return self.store.get(job.id)
        failed = asyncio.run(go())
        self.assertEqual((failed.state, failed.error_code), ("failed", "UNAVAILABLE"))
        self.assertIn("資料検索", failed.error_message)

    def test_doc_posts_file_and_returns_body_text(self):
        async def go():
            provider = FakeProvider()
            documents = Documents(self.bot, FakeKB(), provider, None, 160.0)
            self.bot.cogs["Documents"] = documents
            cog = self.cog()
            job = self.job("doc", {"docType": "request", "content": "発電機の見積依頼", "format": "docx",
                                   "useSources": True, "model": "auto"})
            await cog._run(self.store.claim_next(("doc",)), "ask_doc")
            return job, cog
        job, cog = asyncio.run(go())
        done = self.store.get(job.id)
        self.assertEqual(done.state, "done", done.error_message)
        self.assertEqual(self.share.sent[0].content, "📱 アプリから テスト委員 さんの文書作成")
        self.assertIn("本文です。", done.result["text"])
        file_meta = done.result["files"][0]
        self.assertTrue(file_meta["name"].endswith(".docx"))
        self.assertEqual(file_meta["mime"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        registered = self.store.get_file(job.id, file_meta["name"])
        self.assertIsNotNone(registered)
        self.assertTrue((self.dir / "files" / registered["relpath"]).is_file())

    def test_app_mail_goes_through_doc_and_returns_subject_line_first(self):
        """アプリの「メール」は /doc(docType=mail・txt)として来る。メールの指示で起草し、本文の 1 行目が件名。"""
        searched = []

        class RecordingKB(FakeKB):
            def search(self, query, max_excerpts=10, use_fields=True):
                searched.append(query)
                return super().search(query, max_excerpts, use_fields)

        request = mail_draft.compose_request("サンプルレンタル ご担当者様", "発電機3台の見積依頼",
                                             sender="渉外課 山田", relation="first")

        async def go():
            provider = FakeProvider()
            documents = Documents(self.bot, RecordingKB(), provider, None, 160.0)
            self.bot.cogs["Documents"] = documents
            cog = self.cog()
            job = self.job("doc", L.doc_input({"docType": "mail", "content": request, "format": "txt",
                                               "useSources": True, "model": "auto"}, gemini=False))
            await cog._run(self.store.claim_next(("doc",)), "ask_doc")
            return job, provider
        job, provider = asyncio.run(go())
        done = self.store.get(job.id)
        self.assertEqual(done.state, "done", done.error_message)
        self.assertEqual(self.share.sent[0].content, "📱 アプリから テスト委員 さんの文書作成")
        prompt = provider.prompts[0]
        self.assertIn("メール起草アシスタント", prompt)
        self.assertIn("【相手】サンプルレンタル ご担当者様", prompt)
        self.assertIn("# 今日の日付", prompt)
        self.assertIn("発電機は3台をレンタルする方針です。", prompt)   # 資料抜粋が渡る
        self.assertEqual(searched, ["サンプルレンタル ご担当者様 渉外課 山田 初めて連絡する 発電機3台の見積依頼"])
        text = done.result["text"]
        # 題は件名、要記入の一覧、本文(1 行目が「件名：」・コードブロックの囲みは外れる)
        self.assertIn("✉️ **発電機お見積りのお願い(医学薬学祭実行委員会)**(メールの草案)", text)
        self.assertIn("-# 要記入: 【担当者名】 【氏名】", text)
        lines = text.splitlines()
        subject_lines = [i for i, line in enumerate(lines) if line.startswith("件名：")]
        self.assertEqual(len(subject_lines), 1)
        self.assertEqual(lines[subject_lines[0]], "件名：発電機お見積りのお願い(医学薬学祭実行委員会)")
        self.assertNotIn("```", text)
        file_meta = done.result["files"][0]
        self.assertTrue(file_meta["name"].endswith(".txt"))
        saved = (self.dir / "files" / self.store.get_file(job.id, file_meta["name"])["relpath"]).read_text("utf-8")
        self.assertTrue(saved.startswith("件名：発電機お見積りのお願い"))

    def test_discord_mail_command_posts_the_draft_as_text_too(self):
        """Discord の /mail は、メモと txt の後に草案そのものを本文として投稿する(メンションは無効)。"""
        async def go():
            provider = FakeProvider()
            documents = Documents(self.bot, FakeKB(), provider, None, 160.0)
            user = FakeMember(ACTOR, "テスト委員")
            itx = WebInteraction(interaction_id="mail-1", user=user, channel=self.share, guild=self.guild,
                                 original=None)
            await documents.mail.callback(documents, itx, "学務課 ご担当者様", "会計書類を11/6までに提出します",
                                          None, None, None, False, None)
            return itx, provider
        itx, provider = asyncio.run(go())
        self.assertIn("【相手】学務課 ご担当者様", provider.prompts[0])
        self.assertNotIn("# 資料抜粋", provider.prompts[0])   # 資料参照:False
        self.assertTrue(itx.files and itx.files[0].name.endswith(".txt"))
        text = itx.answer_text()
        self.assertIn("(メールの草案)", text)
        self.assertIn("件名：発電機お見積りのお願い", text)
        self.assertIn("本文です。", text)
        self.assertEqual(len(self.share.sent), 2)   # メモ＋txt、草案の本文

    def test_doc_failure_when_no_provider_is_reported_as_failed_job(self):
        async def go():
            documents = Documents(self.bot, FakeKB(), None, None, 160.0)
            self.bot.cogs["Documents"] = documents
            cog = self.cog()
            job = self.job("doc", {"docType": "free", "content": "何か", "format": "md", "useSources": False,
                                   "model": "auto"})
            await cog._run(self.store.claim_next(("doc",)), "ask_doc")
            return self.store.get(job.id)
        failed = asyncio.run(go())
        self.assertEqual(failed.state, "failed")
        self.assertIn("AIプロバイダ", failed.error_message)


class RemindTests(AssistantCase):
    def create_input(self, **over):
        """連携口が保存する形(assistant_logic.remind_create_input の出力)と同じ入力。"""
        raw = {"text": "資料提出", "due": "2030-01-05T18:00+09:00", "targetId": f"discord-{TARGET}"}
        raw.update(over)
        return L.remind_create_input(raw)

    def test_create_stores_reminder_posts_confirmation_and_refreshes_snapshot(self):
        async def go():
            cog = self.cog()
            job = self.job("remind", self.create_input(), op="create")
            await cog._run(self.store.claim_next(("remind",)), None)
            await cog.publish_state()
            return job, cog
        job, cog = asyncio.run(go())
        done = self.store.get(job.id)
        self.assertEqual(done.state, "done", done.error_message)
        rem = self.reminders.get(done.result["reminder"]["id"])
        self.assertEqual((rem["creator_id"], rem["target_id"], rem["channel_id"]), (ACTOR, TARGET, REMIND_CH))
        self.assertIn("📱 アプリから テスト委員 さんが登録", self.remind.sent[0].content)
        self.assertIn("登録しました", self.remind.sent[0].content)
        taken, body = self.store.read_snapshot()
        self.assertEqual(body["reminders"][0]["creator"], {"id": f"discord-{ACTOR}", "name": "テスト委員"})
        self.assertEqual(body["reminders"][0]["channel"]["name"], "内務部")
        # 名前はメンバー一覧(特権インテント)を使わず 1 人ずつ取る。役員の判定は連携口が本人の権限で行う
        self.assertEqual(body["reminders"][0]["target"]["id"], f"discord-{TARGET}")
        self.assertNotEqual(body["reminders"][0]["target"]["name"], "Discordユーザー")
        self.assertNotIn("manageGuildIds", body)
        capabilities = json.loads(self.store.get_meta("capabilities"))
        self.assertFalse(capabilities["features"]["image"])
        self.assertEqual(capabilities["reminderChannels"][0]["name"], "内務部")

    def test_confirmation_post_failure_keeps_the_saved_reminder(self):
        # 保存の後で確認の投稿だけ失敗しても、依頼は done のまま(再依頼で二重登録させない)
        async def refused(content=None, **kwargs):
            raise discord.HTTPException(_Resp(), "forbidden")
        self.remind.send = refused

        async def go():
            cog = self.cog()
            job = self.job("remind", self.create_input(), op="create")
            await cog._run(self.store.claim_next(("remind",)), None)
            return self.store.get(job.id)
        done = asyncio.run(go())
        self.assertEqual(done.state, "done")
        self.assertEqual(len(self.reminders.all()), 1)
        self.assertIn("確認の投稿は届きませんでした", done.result["message"])

    def test_channel_outside_the_allowed_list_is_refused(self):
        async def go():
            cog = self.cog()
            job = self.job("remind", self.create_input(channelId=str(CANDIDATE_CH)), op="create")
            await cog._run(self.store.claim_next(("remind",)), None)
            return self.store.get(job.id)
        failed = asyncio.run(go())
        self.assertEqual((failed.state, failed.error_code), ("failed", "VALIDATION"))

    def test_unreadable_due_is_refused_without_writing(self):
        # 連携口の検査を通らない入力でも、Bot 側が二重に読めずに止めること
        async def go():
            cog = self.cog()
            job = self.job("remind", {"text": "x", "due": "来年のどこか", "targetId": None,
                                      "repeat": "none", "channelId": None}, op="create")
            await cog._run(self.store.claim_next(("remind",)), None)
            return self.store.get(job.id)
        failed = asyncio.run(go())
        self.assertEqual(failed.error_code, "VALIDATION")
        self.assertEqual(self.reminders.all(), [])

    def test_done_and_delete_follow_discord_permission_rules(self):
        async def setup():
            cog = self.cog()
            job = self.job("remind", self.create_input(), op="create")
            await cog._run(self.store.claim_next(("remind",)), None)
            return cog, self.store.get(job.id).result["reminder"]["id"]
        cog, rem_id = asyncio.run(setup())

        async def change(op, actor):
            job = self.job("remind", {"reminderId": rem_id}, op=op, actor=actor, name="名前")
            await cog._run(self.store.claim_next(("remind",)), None)
            return self.store.get(job.id)

        # 登録者でも対象でもない人は完了できない
        self.assertEqual(asyncio.run(change("done", OUTSIDER)).error_code, "FORBIDDEN")
        # 催促対象は完了できる(Discord と同じ)
        self.assertEqual(asyncio.run(change("done", TARGET)).state, "done")
        self.assertTrue(self.reminders.get(rem_id)["done"])
        # 削除は登録者と役員だけ。対象の人は削除できない
        self.assertEqual(asyncio.run(change("delete", TARGET)).error_code, "FORBIDDEN")
        self.assertEqual(asyncio.run(change("delete", ADMIN)).state, "done")
        self.assertIsNone(self.reminders.get(rem_id))

    def test_missing_reminder_is_reported(self):
        async def go():
            cog = self.cog()
            job = self.job("remind", {"reminderId": 999}, op="done")
            await cog._run(self.store.claim_next(("remind",)), None)
            return self.store.get(job.id)
        self.assertEqual(asyncio.run(go()).error_code, "NOT_FOUND")


class ScreeningTests(AssistantCase):
    def setUp(self):
        super().setUp()
        base = self.dir / "todo"
        base.mkdir()
        self.tasks = TaskStore.open(base / "tasks")
        self.ledger = ScreeningStore.open(self.dir / "candidates.sqlite3")
        settings = TaskSettings(enabled=True, guild_ids=(GUILD,), channel_ids=(), store_dir=base / "tasks")
        self.screening = SC.TaskScreening(self.bot, settings, self.tasks, self.ledger,
                                          trigger_path=self.dir / "followup.request")
        self.screening._channel = lambda c: self.candidate
        self.bot.cogs["TaskScreening"] = self.screening

    def publish(self, decision, title):
        """候補を 1 件、本番と同じ経路(claim → _publish)で投稿済みにする。"""
        run = self.ledger.start_run()
        cid = self.ledger.add(run, candidate_row(f"fp-{title}", decision, title))
        rows = self.ledger.claim_new(10)

        async def go():
            for row in rows:
                await self.screening._publish(row)
        asyncio.run(go())
        return cid

    def test_approve_creates_task_and_edits_the_candidate_post(self):
        cid = self.publish("review", "救護担当を決める")
        self.bot.cogs["TaskCog"] = FakeTaskCog(self.candidate)
        job = self.job("screening", {"candidateId": cid, "comment": None}, op="ok")
        asyncio.run(self.cog()._run(self.store.claim_next(("screening",)), None))
        done = self.store.get(job.id)
        self.assertEqual(done.state, "done", done.error_message)
        self.assertEqual(done.result["taskNumber"], self.ledger.get(cid).task_number)
        self.assertIn("✅", done.result["message"])
        post = self.candidate.sent[0]
        self.assertIn("起票", post.content)
        self.assertEqual(self.tasks.get_task(Scope(GUILD, CANDIDATE_CH), done.result["taskNumber"]).task.title,
                         "救護担当を決める")

    def test_return_edits_post_and_records_comment(self):
        cid = self.publish("review", "訂正紙の要否を決める")
        self.bot.cogs["TaskCog"] = FakeTaskCog(self.candidate)
        job = self.job("screening", {"candidateId": cid, "comment": "期限は10/16"}, op="return")
        asyncio.run(self.cog()._run(self.store.claim_next(("screening",)), None))
        done = self.store.get(job.id)
        self.assertEqual(done.state, "done", done.error_message)
        self.assertEqual(self.ledger.get(cid).state, "returned")
        self.assertIn("差し戻し", self.candidate.sent[0].content)

    def test_authorization_is_not_bypassed(self):
        cid = self.publish("review", "腕章の数を数える")
        self.bot.cogs["TaskCog"] = FakeTaskCog(self.candidate, allow=False)
        job = self.job("screening", {"candidateId": cid, "comment": None}, op="ok")
        asyncio.run(self.cog()._run(self.store.claim_next(("screening",)), None))
        failed = self.store.get(job.id)
        self.assertEqual((failed.state, failed.error_code), ("failed", "REJECTED"))
        self.assertEqual(self.ledger.get(cid).state, "posted")   # 起票されていない
        self.assertEqual(self.tasks.list_tasks(Scope(GUILD, CANDIDATE_CH)), [])

    def test_unknown_operation_is_refused_and_never_treated_as_undo(self):
        cid = self.publish("review", "無線機を受け取る")   # 承認待ち(取り消し・起票のどちらにも変わりうる)
        self.bot.cogs["TaskCog"] = FakeTaskCog(self.candidate)
        job = self.job("screening", {"candidateId": cid, "comment": None}, op="rt")
        asyncio.run(self.cog()._run(self.store.claim_next(("screening",)), None))
        self.assertEqual(self.store.get(job.id).error_code, "VALIDATION")
        self.assertEqual(self.ledger.get(cid).state, "posted")

    def test_unknown_candidate_fails(self):
        self.bot.cogs["TaskCog"] = FakeTaskCog(self.candidate)
        job = self.job("screening", {"candidateId": 99999, "comment": None}, op="ng")
        asyncio.run(self.cog()._run(self.store.claim_next(("screening",)), None))
        self.assertEqual(self.store.get(job.id).error_code, "NOT_FOUND")


class ImageDisabledTests(AssistantCase):
    """画像が使えない構成(image_enabled=false、または Images が無い・点検前)。依頼は受けて即 IMAGE_DISABLED。
    Assistant 自身は /image を登録しない(登録するのは Images)。"""

    def test_image_job_fails_fast_without_posting_anything(self):
        cog = self.cog()
        self.assertFalse(cog.image_enabled)
        job = self.job("image", {"prompt": "春の医薬祭ポスター", "aspect": "16:9"})
        asyncio.run(cog._run(self.store.claim_next(("image",)), None))
        failed = self.store.get(job.id)
        self.assertEqual((failed.state, failed.error_code), ("failed", "IMAGE_DISABLED"))
        self.assertIn("使えません", failed.error_message)
        self.assertEqual(self.share.sent, [])
        self.assertIsNone(self.store.get_file(job.id, "image.png"))

    def test_setting_on_but_images_not_ready_is_still_disabled(self):
        settings = self.settings()
        settings.image_enabled = True
        images = IM.Images(self.bot, image_settings(self.dir), FakeImageProvider(), maker=None)
        self.bot.cogs["Images"] = images   # 点検前(ready=False)
        cog = AC.Assistant(self.bot, settings, self.store, reminders=self.reminders)
        self.assertFalse(cog.image_enabled)
        job = self.job("image", {"prompt": "看板", "aspect": "1:1"})

        async def go():
            await cog._claim()
            await asyncio.gather(*list(cog._jobs))
        asyncio.run(go())
        self.assertEqual(self.store.get(job.id).error_code, "IMAGE_DISABLED")
        self.assertEqual(self.share.sent, [])

    def test_no_image_command_is_registered(self):
        cog = self.cog()
        self.assertNotIn("image", [c.name for c in cog.get_app_commands()])

    def test_capabilities_report_no_image_and_no_gemini_model(self):
        async def go():
            cog = self.cog()
            await cog.publish_state()
        asyncio.run(go())
        capabilities = json.loads(self.store.get_meta("capabilities"))
        self.assertFalse(capabilities["features"]["image"])
        self.assertFalse(capabilities["gemini"])


IMAGE_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600"><title>模擬店の値段表</title>'
             '<rect width="900" height="1600" fill="#ffd400"/><text x="60" y="300" font-size="96">焼きそば</text></svg>')


class FakeImageProvider:
    """Claude の代わり。SVG を返す(画像の依頼は one-shot の complete だけを使う)。"""

    def __init__(self, *answers):
        self.answers = list(answers) or [IMAGE_SVG]

    async def complete(self, prompt, model=None, timeout=None, effort=None):
        await asyncio.sleep(0.05)
        return AIResult(text=self.answers.pop(0) if len(self.answers) > 1 else self.answers[0], model=model or "opus",
                        usage={"input_tokens": 10, "output_tokens": 5})


class FakeImageMaker(IM.ImageMaker):
    async def render(self, svg, width, height):
        return PNG


def image_settings(base: Path, limit: int = 20) -> ImageSettings:
    return ImageSettings(enabled=True, model="opus", effort="", font_dir=base / "fonts", work_dir=base / "work",
                         render_python="", render_timeout_sec=60, daily_limit_per_user=limit, max_concurrent=1)


class ImageEnabledTests(AssistantCase):
    """画像の再開(2026-10-14 夜・Claude の SVG 方式)。Discord の /image と同じ本体を通る。"""

    def enabled_cog(self, limit: int = 20):
        provider = FakeImageProvider()
        settings = image_settings(self.dir, limit)
        images = IM.Images(self.bot, settings, provider, maker=FakeImageMaker(provider, settings))
        images.ready = True
        self.bot.cogs["Images"] = images
        assistant_settings = self.settings()
        assistant_settings.image_enabled = True
        return AC.Assistant(self.bot, assistant_settings, self.store, reminders=self.reminders), images

    def run_all(self, cog):
        async def go():
            await cog._claim()
            await asyncio.gather(*list(cog._jobs))
        asyncio.run(go())

    def test_image_job_posts_to_the_share_channel_and_returns_only_the_png(self):
        cog, _ = self.enabled_cog()
        self.assertTrue(cog.image_enabled)
        job = self.job("image", {"prompt": "模擬店の値段表", "aspect": "9:16"})
        self.run_all(cog)
        done = self.store.get(job.id)
        self.assertEqual(done.state, "done", done.error_message)
        self.assertEqual([f["name"] for f in done.result["files"]], ["image.png"])
        self.assertIsNotNone(self.store.get_file(job.id, "image.png"))
        self.assertIsNone(self.store.get_file(job.id, "image.svg"))   # SVG はアプリでは配らない型
        header, post = self.share.sent
        self.assertEqual(header.content, "📱 アプリから テスト委員 さんの画像")
        self.assertEqual(done.discord_url, header.jump_url)
        self.assertEqual([f.filename for f in post.attachments], ["image.png", "image.svg"])
        self.assertIn("模擬店の値段表", done.result["text"])
        self.assertTrue(all(m is not None and m.everyone is False for m in self.share.mentions_seen))

    def test_images_run_one_at_a_time_in_their_own_lane(self):
        cog, _ = self.enabled_cog()
        first = self.job("image", {"prompt": "看板1", "aspect": "1:1"})
        second = self.job("image", {"prompt": "看板2", "aspect": "1:1"})

        async def go():
            await cog._claim()
            states = (self.store.get(first.id).state, self.store.get(second.id).state)
            await asyncio.gather(*list(cog._jobs))
            await cog._claim()
            await asyncio.gather(*list(cog._jobs))
            return states
        states = asyncio.run(go())
        self.assertEqual(states, ("running", "queued"))
        self.assertEqual([self.store.get(j.id).state for j in (first, second)], ["done", "done"])

    def test_over_the_daily_limit_is_refused_before_posting(self):
        cog, images = self.enabled_cog(limit=1)
        self.job("image", {"prompt": "看板1", "aspect": "1:1"})
        self.run_all(cog)
        posted = len(self.share.sent)
        job = self.job("image", {"prompt": "看板2", "aspect": "1:1"})
        self.run_all(cog)
        failed = self.store.get(job.id)
        self.assertEqual((failed.state, failed.error_code), ("failed", "LIMIT"))
        self.assertIn("1 日 1 枚まで", failed.error_message)
        self.assertEqual(len(self.share.sent), posted)

    def test_capabilities_report_image_on(self):
        cog, _ = self.enabled_cog()
        asyncio.run(cog.publish_state())
        capabilities = json.loads(self.store.get_meta("capabilities"))
        self.assertTrue(capabilities["features"]["image"])
        self.assertFalse(capabilities["gemini"])


class BlockingDocs:
    """起草が終わらない文書の Cog。同時実行の枠を数えるために使う(止めるのはテストの後始末)。"""

    class _Doc:
        async def callback(self, cog, itx, *args):
            await asyncio.Event().wait()

    doc = _Doc()


class RunnerTests(AssistantCase):
    def test_claim_respects_lane_limits_and_failures_are_recorded(self):
        async def go():
            self.bot.cogs["Documents"] = BlockingDocs()
            cog = self.cog()
            ids = [self.job("doc", {"docType": "free", "content": f"内容{n}", "format": "md",
                                    "useSources": False, "model": "auto"}).id for n in range(3)]
            await cog._claim()
            await asyncio.sleep(0.05)
            states = [self.store.get(i).state for i in ids]
            # 壊れた依頼(入力の鍵が無い)は INTERNAL で必ず failed になる
            bad = self.job("remind", {}, op="create")
            await cog._claim()
            for _ in range(100):
                if self.store.get(bad.id).state != "queued":
                    break
                await asyncio.sleep(0.02)
            for task in list(cog._jobs):
                task.cancel()
            await asyncio.gather(*list(cog._jobs), return_exceptions=True)
            return states, bad
        states, bad = asyncio.run(go())
        self.assertEqual(states.count("running"), 2)   # 文書の同時実行は 2 本まで
        self.assertEqual(states.count("queued"), 1)
        self.assertEqual(self.store.get(bad.id).error_code, "INTERNAL")
        self.assertNotIn("KeyError", self.store.get(bad.id).error_message)

    def test_unknown_or_unsupported_job_kind_is_not_left_running(self):
        async def go():
            cog = self.cog()
            job = self.job("remind", {"reminderId": 1}, op="unknown")
            await cog._run(self.store.claim_next(("remind",)), None)
            return self.store.get(job.id)
        self.assertEqual(asyncio.run(go()).state, "failed")

    def test_interrupted_jobs_are_recovered_once_at_start(self):
        job = self.job("ask", {"question": "x", "model": "auto", "effort": "auto", "tone": None, "format": None})
        self.store.claim_next(("ask",))
        async def go():
            cog = self.cog()
            await cog.poll.coro(cog)   # 1 周期分だけ実行(Bot の定期処理と同じ関数)
        asyncio.run(go())
        self.assertEqual(self.store.get(job.id).error_code, "INTERRUPTED")


if __name__ == "__main__":
    unittest.main()
