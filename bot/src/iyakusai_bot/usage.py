# -*- coding: utf-8 -*-
"""/usage — Bot の AI消費量の集計表示(本人にだけ見える)。

※ 利用枠全体の「残り」は API/CLI から取得できないため、
   ここで見えるのは Bot が消費した分の記帳。
"""

from __future__ import annotations

import asyncio

import discord
from discord import app_commands
from discord.ext import commands

from .usage_log import UsageLog, fmt_tokens


class Usage(commands.Cog):
    def __init__(self, bot: commands.Bot, usage_log: UsageLog):
        self.bot = bot
        self.usage_log = usage_log

    @app_commands.command(name="usage", description="BotのAI使用量(トークン)を表示する")
    async def usage(self, itx: discord.Interaction):
        s = await asyncio.to_thread(self.usage_log.summarize)
        e = discord.Embed(
            title="Bot の AI使用量",
            description="このBotが消費したトークンの記帳です。",
            color=0x4169E1,
        )
        lines = []
        for name, p in s["periods"].items():
            lines.append(
                f"**{name}**: {p['calls']}回 ｜ 入力 {fmt_tokens(p['tok_in'])} / "
                f"出力 {fmt_tokens(p['tok_out'])} ｜ API換算 ${p['cost_usd']:.2f}"
            )
        e.add_field(name="期間別", value="\n".join(lines) or "記録なし", inline=False)
        if s["week_by_model"]:
            by_model = "\n".join(
                f"`{m}`: {v['calls']}回 / 出力 {fmt_tokens(v['out'])}"
                for m, v in sorted(s["week_by_model"].items())
            )
            e.add_field(name="今週のモデル別", value=by_model, inline=False)
        e.add_field(
            name="ℹ️ 残り枠について",
            value=(
                "利用枠全体の残量は外部から取得できないため表示できません。\n"
                "「API換算」は API の従量課金で使った場合の参考額です。"
            ),
            inline=False,
        )
        await itx.response.send_message(embed=e, ephemeral=True)
