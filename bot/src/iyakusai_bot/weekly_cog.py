# -*- coding: utf-8 -*-
"""週1回のタスク一覧・担当なしタスクの追い投稿・「引き受ける」ボタン(Discord の口)。

中身の組み立てと順序は weekly_logic・weekly_service にある。ここは次の 4 つだけ:
- 送り先と投稿の許可(タスク機能の guild_ids・channel_ids に入っているかと、@everyone から見えない
  チャンネルかを起動時に確かめる。一覧の中身は委員の情報なので、見える場所には出さない)
- 投稿(名指しの通知は候補の人に限る。それ以外は通知を鳴らさない)
- 「引き受ける」ボタン: TaskCog の _run をそのまま使う(権限の確認・本人だけへの返事・
  操作 ID・履歴が /todo assign と同じになる)。成功したら元の投稿のボタンを外す
- 決定・変更の読み取り(統合アプリの decisions。使えないときは None で節を出さない)
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import discord
from discord.ext import commands, tasks

from .decisions_logic import Decision, parse_decisions
from .kiban import KibanConfigError, KibanFetchError, KibanSettings, fetch_app, load_key
from .notify import routed_channel_id
from .task_cog import _mutation_text
from .task_domain import JST, Scope, TaskError, TaskView
from .task_store import TaskSettings, TaskStore
from .weekly_logic import Outgoing, WeeklySettings
from .weekly_service import WeeklyService
from .weekly_store import STATE_FILE, WeeklyStateStore

log = logging.getLogger("iyakusai.weekly")


def _mentions(user_ids: tuple[int, ...]) -> discord.AllowedMentions:
    """名指しは候補の人に限る。それ以外(一覧の担当の表示など)は通知を鳴らさない。"""
    if not user_ids:
        return discord.AllowedMentions.none()
    return discord.AllowedMentions(everyone=False, roles=False, replied_user=False,
                                   users=[discord.Object(id=uid) for uid in user_ids])


def _assign_work(task_cog: Any, clicker: discord.abc.User, number: int):
    """ボタンで主担当にする処理。/todo assign と同じ更新(版の確認・履歴・操作 ID)を使う。"""

    async def work(access):
        view = await task_cog._call(task_cog.store.get_task, access.scope, number)
        task = view.task
        if task.status == "done":
            raise TaskError("DONE", f"#{number} はすでに完了しています。")
        if task.assignee_id is not None:
            if task.assignee_id == clicker.id:   # 二度押しなど。変更はせず、そのまま伝える
                return f"ℹ #{number} はすでにあなたが主担当です。", None
            raise TaskError("ALREADY_ASSIGNED", f"#{number} はすでに主担当が決まっています。")
        user_id = task_cog.assignable(access, clicker)
        result = await task_cog._call(task_cog.store.update, access.actor, access.scope, number,
                                      task.version, {"assignee_id": user_id})
        return _mutation_text("主担当を引き受けました", result), None

    return work


_ASSIGN_ID = re.compile(r"weekly:assign:([0-9]{1,12})")
_CONTENT_MAX = 2000   # Discord の本文の上限


def retire_assign_message(content: str, custom_ids: Iterable[str | None], number: int,
                          user_id: int) -> tuple[str, list[int]]:
    """引き受けたタスクのボタンを外したあとの本文と、残すボタンのタスク番号(純粋な関数)。

    本文の末尾に「引き受けた」一行を足す。2000 字を超えるときは足さない(ボタンを外すことだけは行う)。
    """
    remaining: list[int] = []
    for custom_id in custom_ids:
        match = _ASSIGN_ID.fullmatch(custom_id or "")
        if match and int(match.group(1)) != number:
            remaining.append(int(match.group(1)))
    note = f"✅ #{number} は <@{user_id}> が引き受けました。"
    candidate = f"{content}\n{note}" if content else note
    return (candidate if len(candidate) <= _CONTENT_MAX else content), remaining


async def _retire_button(itx: discord.Interaction, number: int, user_id: int) -> None:
    """引き受けに成功した元の投稿から、そのタスクのボタンを外す。編集できなくても引き受けは有効のまま。"""
    message = itx.message
    if message is None:
        return
    custom_ids = [getattr(child, "custom_id", None)
                  for row in message.components for child in getattr(row, "children", ())]
    content, remaining = retire_assign_message(message.content, custom_ids, number, user_id)
    view = None
    if remaining:
        view = discord.ui.View(timeout=None)
        for other in remaining:
            view.add_item(AssignButton(other))
    try:
        await message.edit(content=content, view=view, allowed_mentions=discord.AllowedMentions.none())
    except discord.HTTPException as error:
        log.warning("引き受けた投稿の更新に失敗(引き受けは反映済み): %s", error.status)


async def assign_from_button(itx: discord.Interaction, number: int) -> None:
    if itx.client.get_cog("WeeklyCog") is None:    # [weekly] を止めた後に押された、残っているボタン
        await itx.response.send_message("⚠ 週1回のタスク一覧は現在停止中のため操作できません。", ephemeral=True)
        return
    task_cog = itx.client.get_cog("TaskCog")
    if task_cog is None or getattr(task_cog, "store", None) is None:
        await itx.response.send_message("⚠ タスク機能は現在停止中のため操作できません。", ephemeral=True)
        return
    base = _assign_work(task_cog, itx.user, number)
    assigned: list[bool] = []

    async def work(access):
        result = await base(access)    # 失敗(TaskError など)は例外のまま _run が本人に返す
        assigned.append(True)          # ここまで返れば、今回の引き受けか、押した人がすでに主担当
        return result

    await task_cog._run(itx, edit=True, work=work, name="weekly-assign")
    if assigned:
        await _retire_button(itx, number, itx.user.id)


class AssignButton(discord.ui.DynamicItem[discord.ui.Button],
                   template=r"weekly:assign:(?P<number>[0-9]{1,12})"):
    """再起動のあとも効くボタン(custom_id にタスク番号を入れる。screening と同じ方式)。

    登録は bot.py(TaskCog を載せるとき)。[weekly] を止めた後も登録しておき、押すと「停止中」と返す。
    """

    def __init__(self, number: int):
        super().__init__(discord.ui.Button(label=f"引き受ける #{number}"[:80],
                                           style=discord.ButtonStyle.primary,
                                           custom_id=f"weekly:assign:{number}"))
        self.number = number

    @classmethod
    async def from_custom_id(cls, interaction, item, match, /):
        return cls(int(match["number"]))

    async def callback(self, interaction: discord.Interaction):
        await assign_from_button(interaction, self.number)


class WeeklyCog(commands.Cog):
    def __init__(self, bot: commands.Bot, settings: WeeklySettings, task_settings: TaskSettings,
                 task_store: TaskStore, data_dir: Path, *, poll_sec: int = 60):
        self.bot = bot
        self.settings = settings
        self.task_settings = task_settings
        self.task_store = task_store
        self.state = WeeklyStateStore(Path(data_dir) / STATE_FILE)
        # 送り先は [notify] で決まる(無ければ [weekly].channel_id)。一覧と追い投稿は別の種類なので別に解決する
        self.channel_id = routed_channel_id(bot, "weekly_tasks", settings.channel_id)
        self.follow_up_channel_id = routed_channel_id(bot, "weekly_follow_up", settings.channel_id)
        self.guild_id: int | None = None
        self.service: WeeklyService | None = None
        self.tick.change_interval(seconds=poll_sec)

    async def cog_load(self):
        self.tick.start()

    async def cog_unload(self):
        self.tick.cancel()

    @tasks.loop(seconds=60)
    async def tick(self):
        if self.service is None:
            return
        try:
            await self.service.tick()
        except Exception:  # noqa: BLE001  一覧の失敗で Bot を止めない。次の回に読み直す
            log.warning("週1回の一覧の処理に失敗(次の回に再試行します)", exc_info=True)

    @tick.before_loop
    async def _before(self):
        await self.bot.wait_until_ready()
        guild_id = self._check_channel(self.channel_id, "一覧")
        if guild_id is None:                 # 一覧の投稿先が使えないときは、週1回の一覧ごと止める
            return
        self.guild_id = guild_id
        # 追い投稿の送り先は一覧と同じサーバーでだけ使える(タスクの読み取りが同じサーバーを見るため)。
        # 使えないときは追い投稿だけ止め、一覧は続ける
        follow_guild = self._check_channel(self.follow_up_channel_id, "追い投稿")
        follow_up = None
        if follow_guild == guild_id:
            follow_up = self.follow_up_channel_id
        elif follow_guild is not None:
            log.error("追い投稿: 送り先が一覧と別のサーバーにあるため、追い投稿を止めます")
        self.service = WeeklyService(
            settings=self.settings,
            store=self.state,
            channel_id=self.channel_id,
            load_views=self._load_views,
            load_decisions=self._load_decisions,
            get_view=self._get_view,
            send=self._send,
            clock=lambda: datetime.now(JST),
            follow_up_channel_id=follow_up,
        )
        log.info("週1回のタスク一覧を有効化(%s・%02d:%02d・追い投稿 %d 日後・追い投稿%s)",
                 ["", "月", "火", "水", "木", "金", "土", "日"][self.settings.weekday],
                 self.settings.hour, self.settings.minute, self.settings.follow_up_days,
                 "あり" if follow_up is not None else "なし")

    def _check_channel(self, channel_id: int | None, label: str) -> int | None:
        """投稿先が使えるか。使えなければ ERROR を残し、None を返す(Bot は止めない)。成功ならサーバーの ID。"""
        if channel_id is None:
            log.error("%s: 投稿先が決まりません。停止します", label)
            return None
        channel = self.bot.get_channel(channel_id)
        if not isinstance(channel, discord.TextChannel):
            log.error("%s: 投稿先が通常のテキストチャンネルではないか、見つかりません。停止します", label)
            return None
        if not self.task_settings.allows(channel.guild.id, channel.id):
            log.error("%s: 投稿先がタスク機能の許可(tasks の guild_ids・channel_ids)に入っていません。"
                      "引き受けボタンが拒否されるため停止します", label)
            return None
        me = channel.guild.me
        if me is None:
            log.error("%s: Bot のメンバー情報が取れません。停止します", label)
            return None
        perms = channel.permissions_for(me)
        if not (perms.view_channel and perms.send_messages):
            log.error("%s: 投稿先に閲覧・送信の権限がありません。停止します", label)
            return None
        # 一覧と追い投稿には担当・期限・タスク名が載る。@everyone(サーバーの全員)から見えるチャンネルには出さない
        if channel.permissions_for(channel.guild.default_role).view_channel:
            log.error("%s: 投稿先が @everyone から見えるため停止します(委員だけが見えるチャンネルを指定してください)",
                      label)
            return None
        return channel.guild.id

    # ---- 読み取り(タスク DB・統合アプリの決定の口) ----

    async def _load_views(self) -> list[TaskView]:
        return await asyncio.to_thread(self.task_store.list_tasks, Scope(self.guild_id))

    async def _get_view(self, number: int) -> TaskView | None:
        try:
            return await asyncio.to_thread(self.task_store.get_task, Scope(self.guild_id), number)
        except TaskError as error:
            if error.code == "NOT_FOUND":
                return None
            raise

    def _decisions_settings(self) -> KibanSettings | None:
        cfg = self.bot.cfg
        try:
            base = KibanSettings.from_mapping(cfg.kiban, shared_roots=(cfg.data_dir, cfg.knowledge_dir, cfg.mirror_dir))
        except KibanConfigError:
            return None
        if not base.enabled or not base.app_url or base.key_file is None:
            return None
        # 決定の口は、物品・受信箱の写しとは別の要求で取る(未対応の口が混ざると 401 で全部止まるため)
        return replace(base, sources=("decisions",))

    async def _load_decisions(self) -> list[Decision] | None:
        """統合アプリの決定・変更。口が無い・取れないときは None(一覧は節を出さずに続ける)。

        想定外の例外(途中で切れた応答、形の壊れた応答など)もここで止める。外に出すと、その週の一覧が
        出ないまま次の回に再試行されてしまうため。
        """
        try:
            settings = self._decisions_settings()
            if settings is None:
                return None
            key = await asyncio.to_thread(load_key, settings.key_file)
            data = await asyncio.to_thread(fetch_app, settings, key)
            block = data.get("decisions")
            if block is None:
                return None
            return parse_decisions(block)
        except (KibanConfigError, KibanFetchError) as error:
            log.warning("決定・変更を読めないため、一覧の節を省きます(%s)", error)
            return None
        except Exception as error:  # noqa: BLE001  一覧を止めない(節だけ省く)
            log.warning("決定・変更を読めないため、一覧の節を省きます(%s)", type(error).__name__)
            return None

    # ---- 送信 ----

    async def _send(self, channel_id: int, out: Outgoing) -> None:
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            channel = await self.bot.fetch_channel(channel_id)
        kwargs: dict[str, Any] = {"allowed_mentions": _mentions(out.mention_ids)}
        if out.assign_numbers:
            view = discord.ui.View(timeout=None)
            for number in out.assign_numbers:
                view.add_item(AssignButton(number))
            kwargs["view"] = view
        await channel.send(out.text, **kwargs)
