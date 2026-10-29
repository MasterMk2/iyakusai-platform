# -*- coding: utf-8 -*-
"""基盤システムの写し(ミラーの kiban/)を定期的に作り直す常駐ループ。本体は kiban.py。

Discord 収集(collector.py)の 30 分間隔とは別に回す: 祭り当日は物品の貸出・返却が分単位で動くため、
「いまどこにあるか」の答えが 30 分古いと困る。1回の同期はタスク DB の読み取りと HTTPS 1 往復だけで軽い。
"""

from __future__ import annotations

import asyncio
import logging

from discord.ext import commands, tasks

from .kiban import KibanSync

log = logging.getLogger("iyakusai.kiban")


class KibanSyncCog(commands.Cog):
    def __init__(self, bot: commands.Bot, sync: KibanSync, interval_sec: int):
        self.bot = bot
        self.sync = sync
        self._last: dict[str, str] = {}
        self.loop.change_interval(seconds=interval_sec)

    async def cog_load(self):
        self.loop.start()

    async def cog_unload(self):
        self.loop.cancel()

    @tasks.loop(seconds=300)
    async def loop(self):
        # collector.py と同じ理由で tick 本体を必ず握る(tasks.Loop は未捕捉の例外で無言停止する)。
        try:
            result = await asyncio.to_thread(self.sync.run_once)
        except Exception:
            log.error("基盤システムの写しの同期で想定外の例外(次回に再試行)", exc_info=True)
            return
        # 状態が変わったときだけ INFO(5 分ごとに同じ行を出さない)
        if result != self._last:
            log.info("基盤システムの写し: %s", " / ".join(f"{k}={v}" for k, v in result.items()))
            self._last = result

    @loop.error
    async def loop_error(self, exc: Exception):
        log.error("基盤システムの写しのループが停止しました → 再起動します", exc_info=exc)
        try:
            self.loop.restart()
        except Exception:
            log.error("基盤システムの写しのループの再起動に失敗(Bot の再起動が必要)", exc_info=True)
