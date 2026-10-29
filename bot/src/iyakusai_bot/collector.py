# -*- coding: utf-8 -*-
"""F3: Discord ログ収集の常駐化。

Bot の常駐プロセス内で collect_discord_v2.py を定期実行し、raw を最新に保つ。
raw が新しくなると /ask の Discord raw 検索(knowledge_search)が最新動向を拾える。

設計上の注意:
- 単一インスタンスは既存のホストロックで保証される。よって **RPi の systemd タイマー等で
  二重に走らせないこと**(_state.json 競合・二重収集になる)。収集の常駐はこのループに一本化。
- 収集は同期処理(urllib+sleep)。**サブプロセスで実行**しイベントループ(heartbeat/ /ask)を止めない。
- トークンは Bot と同じ環境変数(DISCORD_TOKEN / DISCORD_TOKEN_FILE)を継承して使う。
  トークンのファイルは、共有ドライブなど複数人が読める場所に置かない。
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import re
import sys
from pathlib import Path

from discord.ext import commands, tasks

log = logging.getLogger("iyakusai.collect")

_DONE_RE = re.compile(r"完了: 新規\s*(\d+)\s*件")

# 2026-08-12(レビュー#18): 「1日1回」の暦日は **JST 固定**で持つ。素の date.today() は
# ホストのTZ依存で、TZ が JST でないと日付の境界で二重通知・通知漏れが起きる
# (このプロジェクトが ts_jst を足して潰した UTC/JST 混同と同じ型。mirror.py の v10 参照)。
# zoneinfo ではなく固定オフセットなのは、Windows は tzdata が無いと ZoneInfoNotFoundError に
# なるうえ、JST は夏時間が無く固定オフセットで厳密に等価なため(query_fields.py:27-29 と同じ判断)。
_JST = datetime.timezone(datetime.timedelta(hours=9))


def _today_jst() -> str:
    return datetime.datetime.now(_JST).date().isoformat()


class Collector(commands.Cog):
    def __init__(self, bot: commands.Bot, script: Path, interval_min: int = 30,
                 timeout_sec: int = 600):
        self.bot = bot
        self.script = Path(script)
        self.timeout = timeout_sec
        self._running = False
        self.collect_loop.change_interval(minutes=max(1, interval_min))

    async def cog_load(self):
        self.collect_loop.start()

    async def cog_unload(self):
        self.collect_loop.cancel()

    @tasks.loop(minutes=30)
    async def collect_loop(self):
        # 2026-08-12(レビュー#8): tick 本体は必ずここで包む。discord.ext.tasks.Loop は
        # エラーハンドラ未登録だと想定外の例外で**自動再起動せず恒久停止**し、Bot 本体は
        # 生きているので誰も気づかない(edit_watch.py の docstring が記録する
        # 「通算3回の無言停止」と同じ障害クラス)。握って次の tick を必ず回す。
        try:
            await self._collect_tick()
        except Exception:
            log.error("収集tickで想定外の例外(次tickで継続)", exc_info=True)
        await self._maybe_rebuild_digest_index()

    @collect_loop.error
    async def collect_loop_error(self, exc: Exception):
        # 2026-08-12(レビュー#8)の二重の保険。上の try を抜けた例外(before_loop や
        # ラッパー自身の失敗)でループが止まると同じ恒久サイレント停止になるため、
        # ログを残して自分で再起動する。
        log.error("収集ループが停止しました → 再起動します", exc_info=exc)
        try:
            self.collect_loop.restart()
        except Exception:
            log.error("収集ループの再起動に失敗(Bot の再起動が必要)", exc_info=True)

    async def _collect_tick(self):
        """収集 1 回分。想定外の例外は collect_loop 側で握る(#8)。"""
        if self._running:            # 念のための多重実行ガード(tasks.loop は本来直列)
            return
        if not self.script.exists():
            log.warning("収集スクリプトが見つかりません: %s", self.script)
            return
        self._running = True
        proc = None
        try:
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            proc = await asyncio.create_subprocess_exec(
                sys.executable, str(self.script),
                cwd=str(self.script.parent),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            out, err = await asyncio.wait_for(proc.communicate(), timeout=self.timeout)
        except asyncio.TimeoutError:
            log.warning("Discord 収集がタイムアウト(%ds)。次回に持ち越し。", self.timeout)
            if proc is not None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            return
        except OSError as e:
            log.warning("Discord 収集の起動に失敗: %s", e)
            return
        finally:
            self._running = False
        if proc.returncode != 0:
            tail = (err or b"").decode("utf-8", "replace").strip()[-300:]
            log.warning("Discord 収集が異常終了(code=%s): %s", proc.returncode, tail)
            return
        m = _DONE_RE.search((out or b"").decode("utf-8", "replace"))
        n = m.group(1) if m else "?"
        # 常に INFO(30分毎・収集常駐の生存確認も兼ねる。新規>0 は明示マーク)
        log.info("Discord 収集: 新規 %s 件%s", n, "  ←新着あり" if n not in ("0", "?") else "")
        # 添付も同じtickで回収する。失敗は次tickで再試行し本文収集を止めない。
        await self._maybe_fetch_attachments()
        # digest が再生成されて意味検索の索引が古くなっていれば作り直す(手動手順に頼らない)
        # digest 本文が raw に遅れていたら人に知らせる(自動再生成はしない=劣化回避)
        await self._maybe_warn_content_stale()
        # エージェント検索用の無害化ミラーを追随させる(初回tickで全量ビルド)
        await self._maybe_sync_mirror()

    async def _maybe_fetch_attachments(self):
        """本文収集の後、同じ認証で添付を保存する。ログのみで外部通知はしない。"""
        script = self.script.with_name("fetch_attachments.py")
        if not script.exists():
            log.warning("添付回収スクリプトが見つかりません")
            return
        proc = None
        try:
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            proc = await asyncio.create_subprocess_exec(
                sys.executable, str(script), cwd=str(script.parent),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=self.timeout)
            if proc.returncode != 0:
                log.warning("Discord 添付回収が異常終了(code=%s)。次tickで再試行。", proc.returncode)
                return
            match = re.search(r"完了: 新規保存[^\r\n]*", (out or b"").decode("utf-8", "replace"))
            summary = match.group(0) if match else "完了(集計なし)"
            if re.search(r"失敗\s+[1-9]\d*", summary):
                log.warning("Discord 添付回収: %s", summary)
            else:
                log.info("Discord 添付回収: %s", summary)
        except asyncio.TimeoutError:
            log.warning("Discord 添付回収がタイムアウト(%ds)。次tickで再試行。", self.timeout)
        except Exception:
            log.warning("Discord 添付回収の実行に失敗。次tickで再試行。")
        finally:
            # timeout・Bot停止時にも子プロセスを残さず、次tickとの二重実行を防ぐ。
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.communicate()

    async def _maybe_sync_mirror(self):
        """_目録 → 無害化ミラー(/ask heavy のエージェント検索空間)の増分同期。
        失敗しても収集ループは止めない(ミラーが古いだけ=エージェントは古い資料で答えるか、
        未構築なら one-shot にフォールバックする)。"""
        cfg = self.bot.cfg
        mirror = getattr(cfg, "mirror_dir", None)
        if (str(getattr(cfg, "ai_agentic", "off")) not in ("all", "heavy")
                or not cfg.knowledge_dir or not mirror):
            return
        try:
            from .mirror import sync_mirror
            stats = await asyncio.to_thread(
                sync_mirror, Path(cfg.knowledge_dir), Path(mirror),
                getattr(cfg, "kn_blocklist", None), getattr(cfg, "kn_raw_blocklist", None))
        except Exception:
            log.warning("ミラー同期に失敗(次tickで再試行)", exc_info=True)
            return
        if stats["written"] or stats["removed"]:
            log.info("ミラー同期: 更新 %d / 削除 %d / 変化なし %d / 機微drop %d件 / %.1f秒",
                     stats["written"], stats["removed"], stats["unchanged"],
                     stats["dropped"], stats["secs"])

    async def _maybe_rebuild_digest_index(self):
        cfg = self.bot.cfg
        if not getattr(cfg, "kn_vector", False) or not cfg.knowledge_dir:
            return
        script = cfg.knowledge_dir / "tools" / "fulltext" / "build_semantic_indexes.py"
        if not script.is_file():
            log.warning("意味検索索引の更新ツールがありません")
            return
        proc = None
        try:
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            proc = await asyncio.create_subprocess_exec(
                sys.executable, str(script), cwd=str(script.parent),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=900)
            for line in (out or b"").decode("utf-8", "replace").splitlines():
                try:
                    report = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if isinstance(report, dict):
                    log.info("意味索引 kind=%s status=%s files=%s rows=%s embedded=%s reused=%s error=%s",
                             report.get("kind"), report.get("status"), report.get("files"),
                             report.get("rows"), report.get("embedded"), report.get("reused"),
                             report.get("error_type"))
            if proc.returncode:
                log.warning("意味索引更新は未完了(code=%s)。旧世代を保持し次回再試行", proc.returncode)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.communicate()
            if asyncio.current_task() is not None and asyncio.current_task().cancelling():
                raise
            log.warning("意味索引更新は時間切れ。旧世代と完了済み埋め込みを保持し次回再試行")
        except Exception:
            log.warning("意味索引更新に失敗。旧世代を保持し次回再試行", exc_info=True)

    async def _maybe_warn_content_stale(self):
        """digest 本文(.md)が raw に遅れていたら人に知らせる。**自動再生成はしない**
        (要約の劣化リスクを避け、②③の再生成判断は人が行う)。索引の陳腐化を直す
        `_maybe_rebuild_digest_index` とは役割が別(あちらは vector 索引を自動修復)。
        どんな失敗も収集ループを止めないよう、全て握りつぶして return する。"""
        cfg = self.bot.cfg
        kd = getattr(cfg, "knowledge_dir", None)
        if not kd:
            return
        script = Path(kd) / "discord" / "tools" / "digest_staleness.py"
        if not script.exists():
            return
        try:
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            proc = await asyncio.create_subprocess_exec(
                sys.executable, str(script), "--json",
                "--threshold", str(getattr(cfg, "collect_staleness_threshold", 30)),
                cwd=str(script.parent),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
            data = json.loads((out or b"").decode("utf-8", "replace").strip().splitlines()[-1])
        except Exception:
            return                       # 検出に失敗しても収集は続ける
        if not data.get("stale"):
            return
        total = data.get("total_new", 0)
        human = data.get("human_new", 0)
        # ログは毎回(WARNING で存在を残す)。再生成すれば --mark で基準が進み解消する。
        log.warning("digest が raw に遅れています(未反映 %s件・人間%s件)。digest を再生成してください。",
                    total, human)
        # Discord 通知は 1 日 1 回まで(チャンネル未設定ならログのみ)
        chan_id = getattr(cfg, "collect_staleness_channel_id", None)
        if not chan_id or not self._staleness_notify_due():
            return
        try:
            chan = self.bot.get_channel(int(chan_id))
            if chan is None:
                return
            await chan.send(
                f"🔔 Discord digest が最新に追いついていません(未反映 {total} 件・人間 {human} 件)。"
                f"digest を再生成してください"
                f"(/ask の直近 raw 検索は自動で最新を補完しています)。")
            self._mark_staleness_notified()
        except Exception:
            log.warning("staleness 通知の送信に失敗(権限/チャンネル)。ログのみ継続。")

    def _staleness_state_path(self) -> Path:
        return Path(self.bot.cfg.data_dir) / "_staleness_notify.json"

    def _staleness_notify_due(self) -> bool:
        """通知は 1 日 1 回まで(最後に通知した日付が今日なら見送り)。日付は JST(#18)。"""
        try:
            last = json.loads(self._staleness_state_path().read_text(encoding="utf-8")).get("date")
        except Exception:
            return True
        return last != _today_jst()

    def _mark_staleness_notified(self):
        try:
            self._staleness_state_path().write_text(
                json.dumps({"date": _today_jst()}), encoding="utf-8")
        except Exception:
            pass

    @collect_loop.before_loop
    async def before(self):
        await self.bot.wait_until_ready()
