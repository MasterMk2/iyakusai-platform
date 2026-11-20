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

from . import access_check
from .ai_provider import GO_MONTHLY_CAP_USD, GO_PLAN_USD, ROUTING
from .usage_log import UsageLog, fmt_tokens


def _go_cap() -> float | None:
    """OpenCode Go 経由なら、使っているモデルの Go の月の枠(API 換算額)。Go でなければ None。"""
    if ROUTING["provider"] != "opencode_go":
        return None
    return GO_MONTHLY_CAP_USD.get(ROUTING["aliases"].get("opus") or "")


class Usage(commands.Cog):
    def __init__(self, bot: commands.Bot, usage_log: UsageLog):
        self.bot = bot
        self.usage_log = usage_log

    @app_commands.command(name="usage", description="BotのAI使用量(トークン)を表示する")
    @access_check.require("usage")
    async def usage(self, itx: discord.Interaction):
        s = await asyncio.to_thread(self.usage_log.summarize)
        cap = _go_cap()
        go = ROUTING["provider"] == "opencode_go"
        e = discord.Embed(
            title="Bot の AI使用量",
            description=("このBotが消費したトークンの記帳です(OpenCode Go の月の枠から消費)。" if go
                         else "このBotが消費したトークンの記帳です。"),
            color=0x4169E1,
        )
        lines = []
        for name, p in s["periods"].items():
            lines.append(
                f"**{name}**: {p['calls']}回 ｜ 入力 {fmt_tokens(p['tok_in'])} / "
                f"出力 {fmt_tokens(p['tok_out'])} ｜ API換算 ${p['cost_usd']:.2f}"
                + (f"(Go の月枠の{p['cost_usd'] / cap * 100:.1f}%)" if cap else "")
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
            value=((
                f"OpenCode Go(月額${GO_PLAN_USD:.0f}の定額)の残り枠は OpenCode のコンソールの使用量で見てください。"
                "5 時間で月の 20%・週で 50% まで使え、使い切ると戻るまで Bot の AI が止まります(追加の請求はありません)。"
                "「API換算」と月枠の%は、Go の枠の減り方の目安です。"
            ) if go else (
                "利用枠全体の残量は外部から取得できないため表示できません。\n"
                "「API換算」は API の従量課金で使った場合の参考額です。"
            )),
            inline=False,
        )
        await itx.response.send_message(embed=e, ephemeral=True)
