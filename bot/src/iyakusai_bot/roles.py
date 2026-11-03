# -*- coding: utf-8 -*-
"""/roles とロール付与状況の写し。文面は role_logic.py。

メンバーは Gateway の特権インテントを使わず REST で読む: インテントを要求すると、ポータルの設定が
外れたときに Bot 全体が起動できなくなる(bot.py の message_content の注記)。REST なら 403 で
この機能だけが止まる。discord.py の Guild.fetch_members は Intents.members を要求するので、
その下の http.get_members を直接呼ぶ。
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks

from . import access_check
from .mirror import _scrub_plain
from .role_logic import Roster, build_roster, person_text, render_markdown, role_text, summary_text

log = logging.getLogger("iyakusai.roles")

REFRESH_SEC = 600
ROLES_FILE = "discord/roles_current.md"
_PAGE = 1000   # Discord の 1 回の上限
_COLOR = 0x2E8B57
_FORBIDDEN_NOTE = "⚠ Discord からメンバーの一覧を読めません。Bot の Server Members Intent の設定を確認してください。"


async def fetch_roster(http, guild_id: int, guild_name: str) -> Roster:
    members: list[dict] = []
    after = None
    while True:
        page = await http.get_members(guild_id, _PAGE, after)
        members += page
        if len(page) < _PAGE:
            break
        after = int(page[-1]["user"]["id"])
    return build_roster(guild_id, guild_name, await http.get_roles(guild_id), members)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(_scrub_plain(text), encoding="utf-8")
    os.replace(tmp, path)


class RoleStatus(commands.Cog):
    def __init__(self, bot: commands.Bot, mirror_dir: Path | None):
        self.bot = bot
        self.path = Path(mirror_dir) / ROLES_FILE if mirror_dir else None
        self._last_ok: bool | None = None

    async def cog_load(self):
        if self.path is not None:
            self.loop.start()

    async def cog_unload(self):
        self.loop.cancel()

    @tasks.loop(seconds=REFRESH_SEC)
    async def loop(self):
        # kiban_cog.py と同じ理由で tick 本体を必ず握る(tasks.Loop は未捕捉の例外で無言停止する)
        try:
            rosters = [await fetch_roster(self.bot.http, g.id, g.name) for g in self.bot.guilds]
            text = render_markdown(rosters, datetime.now(timezone.utc), REFRESH_SEC // 60)
            await asyncio.to_thread(_write, self.path, text)
        except Exception as e:  # noqa: BLE001  前回の写しを残して次回に再試行
            ok = False
            log.warning("ロール付与状況の写しに失敗(次回に再試行): %s", type(e).__name__)
        else:
            ok = True
            if self._last_ok is not True:
                log.info("ロール付与状況の写しを更新: %s", self.path.name)
        self._last_ok = ok

    @loop.before_loop
    async def before_loop(self):
        await self.bot.wait_until_ready()

    @app_commands.command(name="roles", description="Discord のロールが誰に付いているかを表示する")
    @access_check.require("roles")
    @app_commands.describe(ロール="このロールが付いている人を出す", 人="この人に付いているロールを出す")
    @app_commands.guild_only()
    async def roles(self, itx: discord.Interaction, ロール: discord.Role | None = None,
                    人: discord.Member | None = None):
        await itx.response.defer(ephemeral=True)
        try:
            roster = await fetch_roster(self.bot.http, itx.guild.id, itx.guild.name)
        except discord.Forbidden:
            log.error("メンバー一覧の取得を拒否された(Server Members Intent を確認)")
            await itx.followup.send(_FORBIDDEN_NOTE, ephemeral=True)
            return
        parts = []
        if ロール is not None:
            parts.append(role_text(roster, ロール.id))
        if 人 is not None:
            parts.append(person_text(roster, 人.id))
        embed = discord.Embed(title="Discord のロール付与状況",
                              description="\n\n".join(parts) or summary_text(roster), color=_COLOR)
        await itx.followup.send(embed=embed, ephemeral=True)
