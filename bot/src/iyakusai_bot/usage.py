# -*- coding: utf-8 -*-
"""/usage — Bot の AI消費量の集計表示(本人にだけ見える)。

- 期間別の記帳は、Bot が消費した分（このプロセスの記録）。
- OpenCode Go 経由のときは、Go の残り枠（5 時間・週・月の %）も窓口から読んで出す（2026-11-21。go_quota）。
  読めないときは、前のとおりコンソールで見るよう案内する。

/model — Bot の既定の AI のモデルを見る・切り替える（2026-11-21。ai_model）。切り替えは役員（サーバー管理の権限が
ある人）だけ。モデルを選ばなければ、いまの既定と選べるモデルを出す（本人にだけ見える）。その回だけ別のモデルを
使うのは、/ask・/doc・/mail の モデル: で誰でもできる（2026-11-22）。
"""

from __future__ import annotations

import asyncio

import discord
from discord import app_commands
from discord.ext import commands

from . import access_check, ai_model, go_quota
from .ai_provider import GO_MONTHLY_CAP_USD, GO_PLAN_USD
from .usage_log import UsageLog, fmt_tokens


def _go_cap(route: dict | None = None) -> float | None:
    """OpenCode Go 経由なら、使っているモデルの Go の月の枠(API 換算額)。Go でなければ None。
    モデルは settings.json を読み直して決める(再起動せずに替わるため。2026-11-21)。"""
    route = route or go_quota.current_route()
    if route["provider"] != "opencode_go":
        return None
    return GO_MONTHLY_CAP_USD.get(route.get("model") or "")


class Usage(commands.Cog):
    def __init__(self, bot: commands.Bot, usage_log: UsageLog):
        self.bot = bot
        self.usage_log = usage_log

    @app_commands.command(name="usage", description="BotのAI使用量(トークン)を表示する")
    @access_check.require("usage")
    async def usage(self, itx: discord.Interaction):
        # Go の残り枠を窓口から読む(最大 10 秒)ので、先に応答を保留する(Discord は 3 秒で打ち切る)
        await itx.response.defer(ephemeral=True, thinking=True)
        s = await asyncio.to_thread(self.usage_log.summarize)
        quota = await asyncio.to_thread(go_quota.get)
        cap = _go_cap(quota)
        go = quota["provider"] == "opencode_go"
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
        if go and quota.get("ok"):
            e.add_field(name=f"OpenCode Go の残り枠（いま・{quota.get('modelLabel') or quota.get('model') or '?'}）",
                        value="\n".join(go_quota.lines(quota)), inline=False)
        e.add_field(
            name="ℹ️ 残り枠について",
            value=((
                f"OpenCode Go(月額${GO_PLAN_USD:.0f}の定額)は 5 時間で月の 20%・週で 50% まで使え、"
                "どれかが 100% になると戻るまで Bot の AI が止まります(追加の請求はありません)。"
                "「API換算」と月枠の%は、Bot が使った分の目安です。"
            ) if go and quota.get("ok") else (
                f"OpenCode Go(月額${GO_PLAN_USD:.0f}の定額)の残り枠を、いまは読めませんでした"
                f"({quota.get('error') or '不明'})。OpenCode のコンソールの使用量で見てください。"
                "5 時間で月の 20%・週で 50% まで使え、使い切ると戻るまで Bot の AI が止まります(追加の請求はありません)。"
            ) if go else (
                "利用枠全体の残量は外部から取得できないため表示できません。\n"
                "「API換算」は API の従量課金で使った場合の参考額です。"
            )),
            inline=False,
        )
        await itx.followup.send(embed=e, ephemeral=True)

    @app_commands.command(name="model", description="Bot の既定の AI のモデルを見る・切り替える(切り替えは役員だけ)")
    @app_commands.describe(モデル="新しい既定(選ばなければ、いまの既定を表示)")
    @app_commands.choices(モデル=[app_commands.Choice(name=c["label"], value=c["model"]) for c in go_quota.choices()])
    @access_check.require("model")
    async def model(self, itx: discord.Interaction, モデル: app_commands.Choice[str] | None = None):
        route = go_quota.current_route()
        if route["provider"] != "opencode_go":
            await itx.response.send_message("いまの Bot は OpenCode Go を使っていないため、モデルは切り替えられません。",
                                            ephemeral=True)
            return
        now = route.get("modelLabel") or route.get("model") or "?"
        if モデル is None:
            others = "・".join(c["label"] for c in go_quota.choices())
            await itx.response.send_message(
                f"いまの Bot の既定の AI：**{now}**（OpenCode Go）\n選べるモデル：{others}\n"
                "既定の切り替えは役員だけができます（`/model モデル:…`、または統合アプリの Bot タブ）。"
                "`/ask`・`/doc`・`/mail` の `モデル:` で、その回だけ別のモデルを選べます。", ephemeral=True)
            return
        member = itx.user if isinstance(itx.user, discord.Member) else None
        if member is None or not member.guild_permissions.manage_guild:
            await itx.response.send_message("モデルを切り替えられるのは役員(サーバー管理の権限がある人)だけです。",
                                            ephemeral=True)
            return
        try:
            access_check.enforce_for("model.set", itx)   # 見るのは read(/model)、切り替えは admin(権限の表で絞れる)
        except access_check.AccessDenied as error:
            await itx.response.send_message(str(error), ephemeral=True)
            return
        assistant = self.bot.get_cog("Assistant")
        try:
            if assistant is not None and hasattr(assistant, "apply_model"):
                record = await assistant.apply_model(モデル.value, actor_id=member.id, actor_name=member.display_name,
                                                     source="discord")
                changed = record["previous"] != モデル.value
            else:
                changed = (await asyncio.to_thread(ai_model.switch, モデル.value))["changed"]
        except ai_model.SwitchError as error:
            await itx.response.send_message(str(error), ephemeral=True)
            return
        if not changed:
            await itx.response.send_message(f"もう **{モデル.name}** になっています。", ephemeral=True)
            return
        await itx.response.send_message(
            f"Bot の既定の AI を **{now}** から **{モデル.name}** に切り替えました。次の依頼から使われます"
            "（モデルを選ばない質問・文書、定期スクリーニング、議事録の要約。処理中のものは途中から替わります）。",
            ephemeral=True)
