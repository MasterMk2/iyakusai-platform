# -*- coding: utf-8 -*-
"""F2 リマインド・催促(Discord Cog)。ロジックは remind_logic.py に分離。"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import discord
from discord import app_commands
from discord.ext import commands, tasks

from . import remind_logic as rl
from .storage import ReminderStore

log = logging.getLogger("iyakusai.reminders")

REPEAT_CHOICES = [
    app_commands.Choice(name="なし", value="none"),
    app_commands.Choice(name="毎日", value="daily"),
    app_commands.Choice(name="毎週", value="weekly"),
    app_commands.Choice(name="毎月", value="monthly"),
]


def _is_owner_or_admin(itx: discord.Interaction, rem: dict) -> bool:
    """登録者本人か役員(manage_guild)か。/remind done と /remind delete で共有する。

    2026-08-12: done 側に権限チェックが無く、**誰でも他人の督促を完了扱いにして黙らせ
    られた**(レビュー#13)。delete にだけあった判定をここに1本化して両方から呼ぶ。
    """
    is_admin = isinstance(itx.user, discord.Member) and itx.user.guild_permissions.manage_guild
    return itx.user.id == rem.get("creator_id") or is_admin


def _fmt_item(r: dict) -> str:
    mark = "✅" if r.get("done") else ("🔁" if r.get("repeat", "none") != "none" else "⏰")
    target = f" → <@{r['target_id']}>" if r.get("target_id") else ""
    return f"{mark} `#{r['id']}` **{rl.fmt_due(r['due'])}** {r['text']}{target}"


class Reminders(commands.Cog):
    remind = app_commands.Group(name="remind", description="リマインド・催促")

    def __init__(self, bot: commands.Bot, store: ReminderStore, check_sec: int):
        self.bot = bot
        self.store = store
        self.check_loop.change_interval(seconds=check_sec)

    async def cog_load(self):
        self.check_loop.start()

    async def cog_unload(self):
        self.check_loop.cancel()

    # ---------- スラッシュコマンド ----------

    @remind.command(name="add", description="リマインドを登録する")
    @app_commands.describe(
        期限="例: 7/20 18:00 / 明日 / 2026-08-01 / +3d",
        内容="何をリマインドするか",
        対象="催促する相手(省略時は自分)",
        繰り返し="定期リマインドにする場合",
    )
    @app_commands.choices(繰り返し=REPEAT_CHOICES)
    async def add(
        self,
        itx: discord.Interaction,
        期限: str,
        内容: str,
        対象: discord.Member | None = None,
        繰り返し: app_commands.Choice[str] | None = None,
    ):
        try:
            due = rl.parse_due(期限)
        except rl.ParseError as e:
            await itx.response.send_message(f"⚠️ {e}", ephemeral=True)
            return
        rem = self.store.add({
            "text": 内容,
            "due": due.isoformat(),
            "creator_id": itx.user.id,
            "target_id": 対象.id if 対象 else itx.user.id,
            "channel_id": itx.channel_id,
            "repeat": 繰り返し.value if 繰り返し else "none",
            "flags": {},
            "last_ping": None,
            "created_at": rl.now_jst().isoformat(),
            "done": False,
        })
        rep = f"(繰り返し: {繰り返し.name})" if 繰り返し and 繰り返し.value != "none" else ""
        await itx.response.send_message(
            f"⏰ 登録しました {_fmt_item(rem)} {rep}\n"
            f"通知: 前日・期限時刻・超過中は24時間ごとに催促(`/remind done id:{rem['id']}` で完了)"
        )

    @remind.command(name="list", description="リマインド一覧(未完了)")
    async def list_(self, itx: discord.Interaction):
        items = sorted(self.store.active(), key=lambda r: r["due"])
        if not items:
            await itx.response.send_message("未完了のリマインドはありません。", ephemeral=True)
            return
        lines = [_fmt_item(r) for r in items[:25]]
        more = f"\n…ほか {len(items) - 25} 件" if len(items) > 25 else ""
        await itx.response.send_message("\n".join(lines) + more, ephemeral=True)

    @remind.command(name="done", description="リマインドを完了にする(登録者・催促対象または役員)")
    @app_commands.describe(id="対象のリマインドID(/remind list で確認)")
    async def done(self, itx: discord.Interaction, id: int):
        rem = self.store.get(id)
        if not rem:
            await itx.response.send_message(f"⚠️ #{id} は見つかりません。", ephemeral=True)
            return
        # 催促された本人(target_id)も完了にできる。超過催促の本文(_notify の "overdue")が
        # **催促対象に向けて**「完了したら `/remind done id:N`」と案内しているので、ここを
        # 登録者・役員だけに絞ると Bot 自身の案内どおりに操作した委員が弾かれる(2026-08-12)。
        # target_id は .get で読む(古いレコードに欠けていても落とさないため)。
        if not (_is_owner_or_admin(itx, rem) or itx.user.id == rem.get("target_id")):
            await itx.response.send_message(
                "⚠️ 完了にできるのは登録者・催促対象か役員だけです。", ephemeral=True)
            return
        self.store.update(id, done=True)
        await itx.response.send_message(f"✅ 完了にしました: `#{id}` {rem['text']}")

    @remind.command(name="delete", description="リマインドを削除する(登録者または役員)")
    @app_commands.describe(id="対象のリマインドID")
    async def delete(self, itx: discord.Interaction, id: int):
        rem = self.store.get(id)
        if not rem:
            await itx.response.send_message(f"⚠️ #{id} は見つかりません。", ephemeral=True)
            return
        # delete は done と違い催促対象を含めない(記録ごと消える操作なので狭いまま)。
        if not _is_owner_or_admin(itx, rem):
            await itx.response.send_message("⚠️ 削除できるのは登録者か役員だけです。", ephemeral=True)
            return
        self.store.delete(id)
        await itx.response.send_message(f"🗑️ 削除しました: `#{id}` {rem['text']}")

    # ---------- 通知ループ ----------

    @tasks.loop(seconds=60)
    async def check_loop(self):
        now = rl.now_jst()
        for rem in self.store.active():
            for act in rl.pending_actions(rem, now):
                try:
                    await self._notify(rem, act)
                except Exception:  # 1件の失敗で全体を止めない
                    log.exception("通知失敗 id=%s act=%s", rem.get("id"), act)

    @check_loop.before_loop
    async def before_check(self):
        await self.bot.wait_until_ready()

    async def _notify(self, rem: dict, act: str):
        channel = self.bot.get_channel(rem["channel_id"])
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(rem["channel_id"])
            except discord.NotFound:
                # チャンネルが削除済み = 何度試しても届かない。従来はここが汎用 except に
                # 落ちるだけで、check_loop が **毎tick(60秒)エラーログを吐き続け**、その
                # リマインドは二度と誰にも届かないまま残り続けた(2026-08-12: レビュー#5)。
                # ※ Forbidden は捕まえない。役員が権限を直せば復旧しうる状態で督促を
                #    永久停止させる方が害が大きいため、従来どおり上位でログに出す。
                await self._abandon(rem, "channel_missing")
                return
        mention = f"<@{rem['target_id']}>"
        due_s = rl.fmt_due(rem["due"])
        now = rl.now_jst()

        # 先に「送る文面」と「保存するフラグ」を確定させ、**永続化してから送信する**。
        if act == "day_before":
            text = f"🔔 {mention} 明日が期限です: **{rem['text']}**(期限 {due_s})"
            patch = {"flags": {**rem["flags"], "day_before": True}}
        elif act == "due":
            text = f"⏰ {mention} 期限になりました: **{rem['text']}**(期限 {due_s})"
            if rem.get("repeat", "none") != "none":
                nxt = rl.next_occurrence(datetime.fromisoformat(rem["due"]), rem["repeat"])
                patch = {"due": nxt.isoformat(), "flags": {}, "last_ping": None}
            else:
                patch = {"flags": {**rem["flags"], "due": True}, "last_ping": now.isoformat()}
        elif act == "overdue":
            text = (f"📣 {mention} 期限を過ぎています: **{rem['text']}**(期限 {due_s})\n"
                    f"完了したら `/remind done id:{rem['id']}`")
            patch = {"last_ping": now.isoformat()}
        else:
            return

        # 2026-08-12(レビュー#6): 従来は send 成功後に _patch していた。共有ドライブの
        # I/O が詰まって write_json が例外を投げると check_loop がログだけ出して握りつぶし、
        # フラグ未保存のまま次tickも pending_actions が同じ act を返すため、**同じ通知が
        # 60秒ごとにチャンネルへ連投された**。先に保存しておけば、保存に失敗した回は
        # そもそも送らない(=ドライブ復旧後に1回だけ届く)。
        # 「通知が1回落ちる」より「毎分連投で会話が埋まる」方が害が大きい、という判断でこの順。
        before = {k: rem.get(k) for k in patch}   # 送信に失敗したときに書き戻す旧値
        await self._patch(rem, **patch)
        try:
            await channel.send(text)
        except discord.NotFound:
            # 解決してから送るまでの間にチャンネルが消えた場合。ここは巻き戻さない
            # (巻き戻すと、もう存在しない宛先へ永久に再送し続けることになる)。
            await self._abandon(rem, "channel_missing")
        except Exception:
            # 一時的な送信失敗(Discord 側の 5xx など)。保存を巻き戻して次tickで出し直す。
            try:
                await self._patch(rem, **before)
            except Exception:
                log.exception("通知フラグの巻き戻しに失敗 id=%s act=%s(この通知は1回落ちる)",
                              rem.get("id"), act)
            raise

    async def _abandon(self, rem: dict, reason: str):
        """通知先が恒久的に無くなったリマインドを停止する(2026-08-12: レビュー#5)。

        done=True にすると active() から外れて痕跡が残らないので、止めた理由と日付も
        一緒に書き込む(reminders.json を見て「消えた」ではなく「止めた」と分かるように)。
        停止を先に永続化してから DM する。順序が逆だと DM 失敗時に停止が入らず、
        毎tickエラーを吐き続ける元の状態に戻ってしまう。
        """
        log.warning("リマインド #%s: 通知先チャンネル %s が見つからないため停止します(%s)",
                    rem.get("id"), rem.get("channel_id"), reason)
        await self._patch(rem, done=True,
                          stopped_reason=f"{reason} {rl.now_jst().date().isoformat()}")
        try:
            uid = rem["creator_id"]
            user = self.bot.get_user(uid) or await self.bot.fetch_user(uid)
            await user.send(
                f"⚠️ リマインド `#{rem['id']}` の通知先チャンネルが見つからないため停止しました。\n"
                f"内容: **{rem['text']}**(期限 {rl.fmt_due(rem['due'])})\n"
                f"-# まだ必要なら、別のチャンネルで `/remind add` し直してください。"
            )
        except Exception:   # DM 拒否・退会など。停止は済んでいるので握ってよい
            log.warning("リマインド #%s の停止を登録者へDMできませんでした", rem.get("id"))

    async def _patch(self, rem: dict, **fields):
        """フラグ等を1件分だけ永続化する。**書き込みは必ずスレッドへ逃がす。**

        2026-08-12(レビュー追補): store.update → write_json は共有ドライブへの同期I/Oで、
        同日入れた一時失敗リトライ(最大0.6秒)を含む。ここを async 関数から同期で呼ぶと
        その分そのままイベントループが止まり、しかも送信失敗時は「保存+巻き戻し」で2回
        書くため **最悪 1.2秒/件/tick** 全 Bot が固まる(haiku.py が同日 to_thread へ
        逃がしたのと逆向きの非対称)。同じ形に揃える。
        rem.update は呼び出し側が組んだ patch をその場の dict にも反映する既存動作
        (in-memory 側は await をまたがずに確定させたいのでスレッドへ入れない)。
        """
        rem.update(fields)
        await asyncio.to_thread(self.store.update, rem["id"], **fields)
