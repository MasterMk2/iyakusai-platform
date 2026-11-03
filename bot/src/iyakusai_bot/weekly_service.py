# -*- coding: utf-8 -*-
"""週1回の一覧と追い投稿を進める(Discord に依存しない)。weekly_cog が Discord の口を渡す。

順序の決まり(二重投稿を防ぐため):
- 一覧: 記録を先に保存してから送る。1 通も送れなかったときだけ記録を戻す(次の回にもう一度出す)。
  途中の 1 通だけ失敗したときは記録を残す(戻すと、前半が次の回にもう一度出てしまう)。
- 追い投稿: 送る前に「送った」と記録し、送れなかったときだけ記録を消す。
- 担当の有無・完了は、送る直前にタスク DB を読んで確かめる(一覧を作ったあとで変わっているかもしれないため)。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Awaitable, Callable

from .decisions_logic import Decision
from .task_domain import JST, TaskView
from .weekly_logic import (
    Outgoing, WeeklySettings, build_follow_up, build_weekly, follow_up_due, is_due,
    rank_candidates, week_of,
)
from .weekly_store import WeeklyStateStore

log = logging.getLogger("iyakusai.weekly")

MAX_FOLLOW_UPS_PER_TICK = 5

LoadViews = Callable[[], Awaitable[list[TaskView]]]
LoadDecisions = Callable[[], Awaitable[list[Decision] | None]]
GetView = Callable[[int], Awaitable[TaskView | None]]
Send = Callable[[int, Outgoing], Awaitable[None]]


@dataclass
class WeeklyService:
    settings: WeeklySettings
    store: WeeklyStateStore
    channel_id: int                         # 一覧の送り先([notify] の weekly_tasks)
    load_views: LoadViews
    load_decisions: LoadDecisions
    get_view: GetView
    send: Send
    clock: Callable[[], datetime]
    # 追い投稿の送り先([notify] の weekly_follow_up)。None なら追い投稿はしない(一覧は続ける)
    follow_up_channel_id: int | None = None

    async def tick(self) -> None:
        if not self.settings.enabled:   # [weekly] が無いときは何もしない
            return
        now = self.clock()
        await self._post_weekly_if_due(now)
        await self._follow_ups(now)

    async def _post_weekly_if_due(self, now: datetime) -> None:
        posted = await asyncio.to_thread(self.store.posted_weeks)
        if not is_due(now, self.settings, posted):
            return
        views = await self.load_views()
        decisions = await self.load_decisions()
        plan = build_weekly(views, now, candidate_limit=self.settings.candidate_limit, decisions=decisions)
        reserved = await asyncio.to_thread(self.store.reserve_week, plan.week, now.isoformat(),
                                           self.channel_id, list(plan.listed_numbers))
        if not reserved:
            return
        sent = 0
        try:
            for out in plan.messages:
                await self.send(self.channel_id, out)
                sent += 1
        except Exception:
            if sent == 0:
                await asyncio.to_thread(self.store.release_week, plan.week)
            raise
        log.info("週1回のタスク一覧を投稿しました(%s・%d 通・担当なし %d 件を候補に)",
                 plan.week, len(plan.messages), len(plan.listed_numbers))

    async def _follow_ups(self, now: datetime) -> None:
        if self.follow_up_channel_id is None:
            return
        days = self.settings.follow_up_days
        posts = await asyncio.to_thread(self.store.posts)
        budget = MAX_FOLLOW_UPS_PER_TICK
        all_views: list[TaskView] | None = None
        for post in posts:
            try:
                posted_at = datetime.fromisoformat(str(post["posted_at"]))
            except (KeyError, ValueError):
                continue
            if not follow_up_due(posted_at, now, days):
                continue
            for raw_number in post.get("numbers", []):
                number = int(raw_number)
                if budget <= 0:
                    return
                if await asyncio.to_thread(self.store.followup_state, number) is not None:
                    continue   # 1 回だけ。送った・閉じたタスクは二度と見ない
                view = await self.get_view(number)
                if view is None or view.task.status == "done" or view.task.assignee_id is not None:
                    await asyncio.to_thread(self.store.mark_followup, number, "closed", now.isoformat())
                    continue
                if all_views is None:
                    all_views = await self.load_views()
                candidates = rank_candidates(view.task, [v.task for v in all_views])
                days_since = max(days, (now.astimezone(JST).date() - posted_at.astimezone(JST).date()).days)
                out = build_follow_up(view, days_since=days_since, candidates=candidates,
                                      mention=self.settings.mention_candidates)
                await asyncio.to_thread(self.store.mark_followup, number, "followed", now.isoformat())
                try:
                    await self.send(self.follow_up_channel_id, out)
                except Exception:
                    await asyncio.to_thread(self.store.clear_followup, number)
                    raise
                budget -= 1
                log.info("担当なしタスクの追い投稿を送りました(%s・%d 日後)", week_of(posted_at), days_since)
