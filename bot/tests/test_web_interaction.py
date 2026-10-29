# -*- coding: utf-8 -*-
"""統合アプリ発の依頼を Discord の Interaction の形で渡す代役(web_interaction)の試験。"""

from __future__ import annotations

import asyncio
import io
import sys
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

import discord  # noqa: E402

from iyakusai_bot import web_interaction as W  # noqa: E402
from iyakusai_bot.progress import PHASE_LABELS  # noqa: E402


class Msg:
    def __init__(self, cid, content, files=()):
        self.id, self.content = cid, content
        self.attachments = list(files)
        self.edits = []
        self.jump_url = f"https://discord.com/channels/1/2/{cid}"

    async def edit(self, content=None, attachments=None, allowed_mentions=None, **kwargs):
        self.edits.append((content, allowed_mentions))
        if content is not None:
            self.content = content
        if attachments is not None:
            self.attachments = list(attachments)
        return self


class Chan:
    id = 2

    def __init__(self):
        self.sent = []

    def permissions_for(self, member):
        return discord.Permissions(view_channel=True)

    async def send(self, content=None, *, file=None, files=None, allowed_mentions=None, embed=None,
                   embeds=None, view=None):
        message = Msg(100 + len(self.sent), content, [file] if file else list(files or []))
        self.sent.append(message)
        return message


def run(coro):
    return asyncio.run(coro)


class WebInteractionTests(unittest.TestCase):
    def make(self, **kwargs):
        channel = Chan()
        original = Msg(99, "📱 アプリから テスト委員 さんの質問")
        adapter = W.WebInteraction(interaction_id="j_x", user=SimpleUser(), channel=channel, guild=None,
                                   original=original, **kwargs)
        return adapter, channel, original

    def test_progress_goes_to_callback_and_original_not_to_answer_text(self):
        seen = []

        async def on_progress(phase, text):
            seen.append((phase, text))

        adapter, channel, original = self.make(on_progress=on_progress)
        progress = f"{PHASE_LABELS['search']}… ⏱3秒"
        run(adapter.edit_original_response(content=progress, allowed_mentions=discord.AllowedMentions.none()))
        self.assertEqual(seen, [("search", progress)])
        self.assertEqual(adapter.answer_text(), "")
        self.assertEqual(original.content, progress)   # 元の応答は進捗で書き換わる(Discord と同じ)

    def test_answer_chunks_and_files_are_captured_and_posted(self):
        adapter, channel, original = self.make()
        run(adapter.edit_original_response(content="**Q: 質問**\n本文の一つめ"))
        file = discord.File(io.BytesIO(b"docx-bytes"), filename="回答.md")
        run(adapter.followup.send("続きの本文", file=file))
        self.assertEqual(adapter.answer_text(), "**Q: 質問**\n本文の一つめ\n続きの本文")
        self.assertEqual([(f.name, f.data) for f in adapter.files], [("回答.md", b"docx-bytes")])
        # 中身を読んでも、実際に送る分の読み出し位置は戻っている
        self.assertEqual(channel.sent[0].attachments[0].fp.read(), b"docx-bytes")
        self.assertEqual(channel.sent[0].content, "続きの本文")

    def test_ephemeral_messages_are_captured_but_never_posted(self):
        adapter, channel, _ = self.make()
        result = run(adapter.followup.send("⚠ 本人にだけ見える返事", ephemeral=True))
        self.assertIsNone(result)
        self.assertEqual(channel.sent, [])
        self.assertEqual(adapter.ephemeral_text(), "⚠ 本人にだけ見える返事")
        self.assertEqual(adapter.answer_text(), "")

    def test_response_is_single_use_and_modals_are_refused(self):
        adapter, _, _ = self.make()
        run(adapter.response.defer(thinking=True))
        self.assertTrue(adapter.response.is_done())
        with self.assertRaises(W.WebAlreadyResponded):
            run(adapter.response.send_message("二度目"))
        with self.assertRaises(W.WebUnsupported):
            run(adapter.response.send_modal(object()))

    def test_permissions_come_from_the_channel_for_the_user(self):
        adapter, _, _ = self.make()
        self.assertTrue(adapter.permissions.view_channel)
        self.assertEqual(adapter.id, "j_x")
        self.assertIsNone(adapter.guild_id)

    def test_progress_writes_are_throttled(self):
        clock = [100.0]
        writes = []

        async def on_progress(phase, text):
            writes.append(text)

        adapter, _, _ = self.make(on_progress=on_progress, clock=lambda: clock[0])
        for n in range(5):
            text = f"{PHASE_LABELS['search']}… ⏱{n}秒"
            run(adapter.edit_original_response(content=text))
            clock[0] += 0.5   # 0.5 秒ごとに 5 回更新しても書き込みは間引く
        self.assertEqual(len(writes), 2)   # 最初の 1 回と、2 秒経った後の 1 回
        self.assertEqual(W.phase_of("不明な文"), "running")
        self.assertEqual(W.phase_of(PHASE_LABELS["oneshot"]), "oneshot")


class SimpleUser:
    id = 1000000000000000001
    name = "テスト委員"

    def __str__(self):
        return self.name


if __name__ == "__main__":
    unittest.main()
