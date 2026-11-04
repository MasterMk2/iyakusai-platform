# -*- coding: utf-8 -*-
"""/line返信: #公式line転送 のスレッドから公式LINE へ返信する(取り決め C-3)。本体の純ロジックは line_reply.py。

- フォーラム(設定の forum_channel_id)の下のスレッドの中でだけ使える。ほかでは本人にだけ見える案内で断る。
- 設定(app_url・key_file・forum_channel_id)のどれかが無ければ「この機能は設定されていません」と答えるだけ。
- Discord の 3 秒の制限は defer で逃がし、アプリの応答は 15 秒まで待つ(HTTP はスレッドで回す)。
- 確認は本人にだけ見えるメッセージ。ボタンの custom_id に consentId と本人の ID を入れる(DynamicItem)。
  本文はメモリにだけ持つ(5 分)。Bot が再起動した後のボタンは「もう使えない」と答え、何も送らない。
- 送ったら(受付済みのときだけ)スレッドに本文つきの記録を 1 件投稿する。メンションは鳴らさない。
- 鍵・本文はログに出さない。
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import time
from dataclasses import dataclass

import discord
from discord import app_commands
from discord.ext import commands

from . import access_check
from . import line_reply as L

log = logging.getLogger("iyakusai.line_reply")

NO_MENTIONS = discord.AllowedMentions.none()
MAX_PENDING = 200


@dataclass
class Pending:
    user_id: int
    thread_id: int
    text: str
    org_name: str
    deadline: float          # time.monotonic() の値


class LineReplyButton(discord.ui.DynamicItem[discord.ui.Button], template=L.CUSTOM_ID_TEMPLATE):
    """「送信する」「やめる」。custom_id に操作・本人の ID・consentId を入れる。"""

    def __init__(self, action: str, user_id: int, consent_id: str):
        style = discord.ButtonStyle.danger if action == "send" else discord.ButtonStyle.secondary
        super().__init__(discord.ui.Button(label="送信する" if action == "send" else "やめる", style=style,
                                           custom_id=L.custom_id(action, user_id, consent_id)))
        self.action = action
        self.user_id = user_id
        self.consent_id = consent_id

    @classmethod
    async def from_custom_id(cls, interaction, item, match: re.Match[str], /):
        return cls(match["action"], int(match["uid"]), match["cid"])

    async def callback(self, interaction: discord.Interaction):
        cog = interaction.client.get_cog("LineReply")
        if cog is None:
            await interaction.response.send_message(L.STALE, ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        await cog.handle_button(interaction, self.action, self.user_id, self.consent_id)


def confirm_view(user_id: int, consent_id: str) -> discord.ui.View:
    view = discord.ui.View(timeout=None)
    view.add_item(LineReplyButton("send", user_id, consent_id))
    view.add_item(LineReplyButton("stop", user_id, consent_id))
    return view


def _text_file(text: str) -> discord.File:
    return discord.File(io.BytesIO(text.encode("utf-8")), filename="本文.txt")


class LineReply(commands.Cog):
    def __init__(self, bot: commands.Bot, settings: L.LineReplySettings, key: str | None, *, call=None):
        self.bot = bot
        self.settings = settings
        self._key = key
        self._call = call or L.call_app          # 試験で差し替える
        self.pending: dict[str, Pending] = {}

    @property
    def configured(self) -> bool:
        return self.settings.configured and bool(self._key)

    async def cog_load(self):
        self.bot.add_dynamic_items(LineReplyButton)

    async def cog_unload(self):
        self.bot.remove_dynamic_items(LineReplyButton)

    # ---- アプリの呼び出し ----

    async def _post(self, path: str, payload: dict):
        """スレッドで HTTP を回し、待つのは設定の秒数＋少しまで。超えたら LineReplyTransportError。"""
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self._call, self.settings, self._key, path, payload),
                timeout=self.settings.timeout_sec + 2)
        except asyncio.TimeoutError:
            raise L.LineReplyTransportError("timeout") from None

    def _remember(self, consent_id: str, item: Pending) -> None:
        now = time.monotonic()
        for cid in [c for c, p in self.pending.items() if p.deadline <= now]:
            del self.pending[cid]
        while len(self.pending) >= MAX_PENDING:
            del self.pending[next(iter(self.pending))]
        self.pending[consent_id] = item

    # ---- /line返信 ----

    @app_commands.command(name="line返信", description="このスレッドの団体に公式LINE で返信する(確認してから送る)")
    @access_check.require("line返信")
    @app_commands.guild_only()
    @app_commands.describe(本文="送る文(5000 字まで)。\\n で改行")
    async def line_reply(self, itx: discord.Interaction, 本文: app_commands.Range[str, 1, L.TEXT_MAX]):
        if not self.configured:
            await itx.response.send_message(L.NOT_CONFIGURED, ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        channel = itx.channel
        is_thread = isinstance(channel, discord.Thread)
        if not L.in_reply_forum(is_thread, getattr(channel, "parent_id", None), self.settings.forum_channel_id):
            await itx.response.send_message(L.WRONG_PLACE, ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        try:
            text = L.normalize_text(本文)
        except L.LineReplyInputError as error:
            await itx.response.send_message(str(error), ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        await itx.response.defer(ephemeral=True, thinking=True)
        try:
            status, data = await self._post(L.PREVIEW_PATH, L.preview_request(channel.id, itx.user.id, text))
        except L.LineReplyTransportError as error:
            log.warning("公式LINE の返信の確認がアプリに届かなかった: %s", error)
            await itx.followup.send(L.TRANSPORT_PREVIEW, ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        result = L.parse_preview(status, data)
        if isinstance(result, L.Failure):
            log.info("公式LINE の返信の確認を断られた: %s (HTTP %s)", result.code, status)
            await itx.followup.send(L.failure_text(result), ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        seconds = max(0.0, (result.expires_at - discord.utils.utcnow()).total_seconds())
        self._remember(result.consent_id, Pending(itx.user.id, channel.id, text, result.org_name,
                                                  time.monotonic() + seconds))
        content, attach = L.confirm_text(result, text)
        extra = {"file": _text_file(text)} if attach else {}
        await itx.followup.send(content, view=confirm_view(itx.user.id, result.consent_id), ephemeral=True,
                                allowed_mentions=NO_MENTIONS, **extra)

    # ---- ボタン ----

    async def handle_button(self, itx: discord.Interaction, action: str, user_id: int, consent_id: str):
        item = self.pending.get(consent_id)
        if itx.user.id != user_id or (item is not None and item.user_id != itx.user.id):
            await itx.response.send_message(L.NOT_YOURS, ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        # 二度押し・もう片方のボタンで重ねて動かないよう、先に取り除いてボタンを消す
        item = self.pending.pop(consent_id, None)
        if action == "stop":
            await itx.response.edit_message(content=L.STOPPED, view=None, attachments=[],
                                             allowed_mentions=NO_MENTIONS)
            return
        if item is None or item.deadline <= time.monotonic() or not self.configured:
            await itx.response.edit_message(content=L.STALE, view=None, attachments=[],
                                            allowed_mentions=NO_MENTIONS)
            return
        await itx.response.edit_message(content=L.SENDING, view=None, attachments=[],
                                        allowed_mentions=NO_MENTIONS)
        try:
            status, data = await self._post(L.SEND_PATH, L.send_request(consent_id, itx.user.id))
        except L.LineReplyTransportError as error:
            log.warning("公式LINE の返信の送信で応答が無かった(結果不明): %s", error)
            await self._show(itx, L.TRANSPORT_SEND)
            return
        result = L.parse_send(status, data)
        if isinstance(result, L.Failure):
            log.info("公式LINE の返信の送信を断られた: %s (HTTP %s)", result.code, status)
            await self._show(itx, L.failure_text(result))
            return
        log.info("公式LINE の返信: %s", result.status)
        text = L.send_result_text(result)
        if result.accepted and not await self._record(item, itx.user):
            text += L.RECORD_FAILED
        await self._show(itx, text)

    async def _show(self, itx: discord.Interaction, content: str) -> None:
        try:
            await itx.edit_original_response(content=content, view=None, allowed_mentions=NO_MENTIONS)
        except discord.HTTPException:
            try:
                await itx.followup.send(content, ephemeral=True, allowed_mentions=NO_MENTIONS)
            except discord.HTTPException as error:
                log.warning("公式LINE の返信の結果を本人に返せなかった: %s", type(error).__name__)

    async def _record(self, item: Pending, user) -> bool:
        """スレッドに本文つきの記録を 1 件。メンションは鳴らさない。"""
        content, attach = L.record_text(getattr(user, "display_name", None) or str(user), item.text)
        try:
            thread = self.bot.get_channel(item.thread_id) or await self.bot.fetch_channel(item.thread_id)
            extra = {"file": _text_file(item.text)} if attach else {}
            await thread.send(content, allowed_mentions=NO_MENTIONS, **extra)
            return True
        except (discord.HTTPException, AttributeError) as error:
            log.warning("公式LINE の返信の記録をスレッドに投稿できなかった: %s", type(error).__name__)
            return False
