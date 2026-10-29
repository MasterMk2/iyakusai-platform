# -*- coding: utf-8 -*-
"""統合アプリ発の依頼を、Discord の Interaction と同じ形で既存の Cog に渡す代役(2026-10-14)。

/ask(knowledge)・/doc(documents)・定期候補のボタン(screening_cog)は、discord.Interaction の
一部しか使わない: response.defer/send_message/is_done、followup.send、edit_original_response、
user・guild・channel・message・permissions。WebInteraction はその形だけを持ち、Cog の本体
(callback)をそのまま呼ぶ。Discord 側の経路と同じ関数を通るので、回答の中身は変わらない。

見せ方(契約 §1):
- 元の応答(original)= Cog が #bottest に先に出した「📱 アプリから … さんの質問」。進捗の編集と
  回答の 1 通目はこれに書く(Discord の /ask と同じ見え方)。
- 2 通目以降の followup = 同じチャンネルの新しい投稿。
- ephemeral(本人だけ)の送信は**投稿しない**。本文だけ覚えておく(候補の返事を結果に使うため)。
- 進捗の文(ProgressReporter の描画)は回答の本文に含めず、on_progress へ渡す(job.progress)。
"""

from __future__ import annotations

import io
import logging
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import discord

from .progress import FAILED_NOTE_PREFIX, PHASE_LABELS

log = logging.getLogger("iyakusai.web")

PROGRESS_THROTTLE_SEC = 2.0   # 進捗をジョブ表へ書く間隔(契約: 2 秒ごと)
_NO_MENTIONS = discord.AllowedMentions.none()
_PROGRESS_PREFIXES = tuple(PHASE_LABELS.values()) + (FAILED_NOTE_PREFIX,)


class WebUnsupported(RuntimeError):
    """統合アプリからは使えない Discord の操作(モーダルなど)。呼び出し側は失敗として扱う。"""


class WebAlreadyResponded(RuntimeError):
    """Discord と同じく、応答は 1 回だけ。二度目は例外(discord.py の InteractionResponded 相当)。"""


@dataclass
class CapturedFile:
    name: str
    data: bytes


def is_progress_text(text: str | None) -> bool:
    """ProgressReporter の描画か、進捗の後始末の文か。回答の本文とは区別する。"""
    return bool(text) and str(text).startswith(_PROGRESS_PREFIXES)


def phase_of(text: str | None) -> str:
    for key, label in PHASE_LABELS.items():
        if str(text or "").startswith(label):
            return key
    return "running"


def _read_file(file) -> bytes:
    """discord.File の中身を読み、読み出し位置を元に戻す(実際に送る分は失われない)。"""
    fp = getattr(file, "fp", None)
    if fp is None:
        return b""
    position = fp.tell()
    try:
        return fp.read()
    finally:
        fp.seek(position)


def _files_of(kwargs: dict) -> list:
    files = []
    if kwargs.get("file") is not None:
        files.append(kwargs["file"])
    files.extend(kwargs.get("files") or [])
    files.extend(kwargs.get("attachments") or [])
    return files


class _Response:
    def __init__(self, adapter: "WebInteraction"):
        self._adapter = adapter
        self._done = False

    def is_done(self) -> bool:
        return self._done

    async def defer(self, *, ephemeral: bool = False, thinking: bool = False) -> None:
        self._done = True

    async def send_message(self, content=None, **kwargs):
        if self._done:
            raise WebAlreadyResponded("この依頼にはすでに応答済みです")
        self._done = True
        return await self._adapter._followup(content, kwargs)

    async def send_modal(self, *args, **kwargs):
        raise WebUnsupported("入力欄(モーダル)は統合アプリからは使えません")


class _Followup:
    def __init__(self, adapter: "WebInteraction"):
        self._adapter = adapter

    async def send(self, content=None, **kwargs):
        return await self._adapter._followup(content, kwargs)


class WebInteraction:
    """Discord の Interaction の代役。1 回の依頼に 1 つ作る。

    capture されるもの: parts(回答の本文の各片)・files(添付の中身)・ephemeral(本人だけの返事)。
    Cog はこれを見て結果を組み立てる。送信先は channel(共有先)、元の応答は original。
    """

    def __init__(self, *, interaction_id: str, user, channel, guild=None, message=None,
                 original: discord.Message | None = None,
                 on_progress: Callable[[str, str], Awaitable[None]] | None = None,
                 clock: Callable[[], float] = time.monotonic, header: str | None = None):
        self._id = interaction_id
        # 元の応答の先頭に付け直す 1 行(「📱 アプリから … さんの質問」)。進捗と回答で書き換えても、
        # #bottest で誰の質問か分かるように残す(Discord の /ask の「◯◯ が /ask を使用」に当たる)。
        self._header = header
        self.user = user
        self.channel = channel
        self.guild = guild if guild is not None else getattr(channel, "guild", None)
        self.message = message
        self.original = original
        self._on_progress = on_progress
        self._clock = clock
        self._last_progress = None   # 直近に書いた時刻(None = まだ)
        self._last_progress_text = None
        self.response = _Response(self)
        self.followup = _Followup(self)
        self.parts: list[str] = []
        self.files: list[CapturedFile] = []
        self.ephemeral: list[str] = []
        self.first_message: discord.Message | None = original

    # ---- Discord の Interaction と同じ名前の属性 ----

    @property
    def id(self) -> str:
        return self._id

    @property
    def guild_id(self) -> int | None:
        return getattr(self.guild, "id", None)

    @property
    def channel_id(self) -> int | None:
        return getattr(self.channel, "id", None)

    @property
    def permissions(self) -> discord.Permissions:
        """依頼者の、この場所での権限(TaskCog.authorize が view_channel を見る)。"""
        try:
            return self.channel.permissions_for(self.user)
        except Exception:  # noqa: BLE001  取れない場合は何も許さない側に倒す
            return discord.Permissions.none()

    @property
    def app_permissions(self) -> discord.Permissions:
        try:
            return self.channel.permissions_for(self.guild.me)
        except Exception:  # noqa: BLE001
            return discord.Permissions.none()

    async def edit_original_response(self, content=None, **kwargs):
        """元の応答を編集する。進捗の更新と、回答の 1 通目の両方がここを通る。"""
        files = _files_of(kwargs)
        if files or not is_progress_text(content):
            # 回答の一片(本文)。進捗ではない。
            if content:
                self.parts.append(str(content))
            self._capture_files(files)
        else:
            await self._report_progress(str(content))
        if self.original is None:
            raise WebUnsupported("元の応答がありません")
        shown = content
        if self._header and content and len(self._header) + 1 + len(str(content)) <= 2000:
            shown = f"{self._header}\n{content}"
        edit = {"content": shown, "allowed_mentions": kwargs.get("allowed_mentions", _NO_MENTIONS)}
        if files:
            edit["attachments"] = files
        for key in ("embed", "embeds"):
            if key in kwargs:
                edit[key] = kwargs[key]
        self.original = await self.original.edit(**edit)
        return self.original

    # ---- 内部 ----

    async def _followup(self, content, kwargs: dict):
        if kwargs.get("ephemeral"):
            # 本人だけの返事は投稿しない。候補の処理の結果(⚠ を含む)として Cog が読む。
            if content:
                self.ephemeral.append(str(content))
            return None
        files = _files_of(kwargs)
        self._capture_files(files)
        if content:
            self.parts.append(str(content))
        send = {"allowed_mentions": kwargs.get("allowed_mentions", _NO_MENTIONS)}
        if files:
            send["files"] = files
        for key in ("embed", "embeds", "view"):
            if kwargs.get(key) is not None:
                send[key] = kwargs[key]
        message = await self.channel.send(content, **send)
        if self.first_message is None:
            self.first_message = message
        return message

    def _capture_files(self, files) -> None:
        for file in files:
            self.files.append(CapturedFile(name=str(getattr(file, "filename", "") or "出力"),
                                           data=_read_file(file)))

    async def _report_progress(self, text: str) -> None:
        if self._on_progress is None or text == self._last_progress_text:
            return
        now = self._clock()
        if self._last_progress is not None and now - self._last_progress < PROGRESS_THROTTLE_SEC:
            return
        self._last_progress = now
        self._last_progress_text = text
        try:
            await self._on_progress(phase_of(text), text)
        except Exception:  # noqa: BLE001  進捗の書き込みの失敗で回答を落とさない
            log.debug("進捗の書き込みに失敗(回答には影響なし)", exc_info=True)

    # ---- 結果(Cog が読む) ----

    def answer_text(self) -> str:
        """回答として届けた本文(分割された片を改行でつなぐ)。"""
        return "\n".join(part for part in self.parts if part)

    def ephemeral_text(self) -> str:
        return "\n".join(text for text in self.ephemeral if text)

    @property
    def jump_url(self) -> str | None:
        message = self.first_message
        return getattr(message, "jump_url", None) if message is not None else None
