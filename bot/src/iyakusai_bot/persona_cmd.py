# -*- coding: utf-8 -*-
"""/persona — /ask の恒久口調(ペルソナ)の切替。

恒久設定はサーバー共有のためON/OFF・変更は役員(manage_guild)に限定。
show は誰でも可。単発の口調は /ask の 口調 オプションで(誰でも)。
"""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from .persona import PRESETS, PersonaStore

PRESET_CHOICES = [
    app_commands.Choice(name=f"{v['emoji']} {k}", value=k) for k, v in PRESETS.items()
]


def _is_admin(user) -> bool:
    return isinstance(user, discord.Member) and user.guild_permissions.manage_guild


class Persona(commands.Cog):
    persona = app_commands.Group(name="persona", description="Botの口調(/ask)の設定")

    def __init__(self, bot: commands.Bot, store: PersonaStore):
        self.bot = bot
        self.store = store

    @persona.command(name="show", description="現在の口調設定を表示")
    async def show(self, itx: discord.Interaction):
        presets = "、".join(f"{v['emoji']}{k}" for k, v in PRESETS.items())
        await itx.response.send_message(
            f"現在の口調: **{self.store.describe()}**\n"
            f"-# プリセット: {presets} ｜ 変更は役員が `/persona set`。"
            f"単発なら `/ask` の `口調:` で誰でも指定できます。",
            ephemeral=True,
        )

    @persona.command(name="set", description="口調を設定(役員のみ)。プリセットかカスタム文のどちらか")
    @app_commands.describe(プリセット="用意された口調から選ぶ", カスタム="自由に口調を指定(例: 語尾に「にゃ」を付ける)")
    @app_commands.choices(プリセット=PRESET_CHOICES)
    async def set_(
        self,
        itx: discord.Interaction,
        プリセット: app_commands.Choice[str] | None = None,
        カスタム: str | None = None,
    ):
        if not _is_admin(itx.user):
            await itx.response.send_message("⚠️ 口調の恒久変更は役員のみです(単発は `/ask` の `口調:` で)。", ephemeral=True)
            return
        if カスタム:
            self.store.set_custom(カスタム)
        elif プリセット:
            self.store.set_preset(プリセット.value)
        else:
            await itx.response.send_message("⚠️ プリセットかカスタムのどちらかを指定してください。", ephemeral=True)
            return
        await itx.response.send_message(f"✅ 口調を **{self.store.describe()}** に設定しました(/ask に反映)。")

    @persona.command(name="off", description="口調を標準に戻す(役員のみ)")
    async def off(self, itx: discord.Interaction):
        if not _is_admin(itx.user):
            await itx.response.send_message("⚠️ 口調の恒久変更は役員のみです。", ephemeral=True)
            return
        self.store.off()
        await itx.response.send_message("✅ 口調を標準に戻しました。")
