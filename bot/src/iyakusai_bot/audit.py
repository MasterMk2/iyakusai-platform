# -*- coding: utf-8 -*-
"""操作の監査ログ(2026-11-03)。誰が・いつ・どの操作を・どういう結果で、を 1 行 1 件の JSON に残す。

書く項目は次の列だけ（それ以外は作れない・受け付けない）:
  ts      JST の ISO 8601（秒まで）
  cmd     操作の名前。access.COMMAND_KINDS のキーだけ（自由文は入らない）
  kind    read / write / send / admin
  actor   依頼した人の Discord の数値 ID（表示名は書かない）
  guild / channel  数値 ID（任意）
  result  accepted（受付）・denied（拒否）・ok（完了）・failed（失敗）
  code    大文字の短い記号（任意。例: FORBIDDEN）
  ref     対象の番号（数値だけ・任意。例: タスク番号・リマインド番号）

本文・表示名・メールアドレス・ファイル名・資料の抜粋は、列の検査で必ず弾く。
置き場はホストのローカル（既定 ~/.iyakusai/audit。共有ドライブとミラーの外・access.py で検査）。
容量: 1 ファイルが max_bytes を超えたら audit.jsonl.1 へ回し、generations 世代まで残して古いものを消す。
書けないとき（ディスクの障害など）は操作を止めず、警告だけ残す（usage_log と同じ扱い）。
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .access import COMMAND_KINDS, KINDS

log = logging.getLogger("iyakusai.audit")

AUDIT_FILE = "audit.jsonl"
RESULTS = ("accepted", "denied", "ok", "failed")
JST = timezone(timedelta(hours=9))
DEFAULT_MAX_BYTES = 1_000_000
DEFAULT_GENERATIONS = 5

_CODE_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


def _is_id(value) -> bool:
    return type(value) is int and value > 0


def is_code(value) -> bool:
    """監査に書ける code の形か（大文字で始まる 40 字以内の記号）。access_check も使う。"""
    return (isinstance(value, str) and 1 <= len(value) <= 40 and value[0].isalpha() and value[0].isupper()
            and set(value) <= _CODE_CHARS)


def build_record(*, cmd, kind, actor, result, guild=None, channel=None, code=None, ref=None,
                 now: datetime) -> dict | None:
    """列を検査して 1 件分の辞書を作る。どれか 1 つでも外れたら None（書かない）。"""
    if not isinstance(cmd, str) or cmd not in COMMAND_KINDS:
        return None
    if kind not in KINDS:
        return None
    if not _is_id(actor) or result not in RESULTS:
        return None
    if guild is not None and not _is_id(guild):
        return None
    if channel is not None and not _is_id(channel):
        return None
    if code is not None and not is_code(code):
        return None
    if ref is not None and (type(ref) is not int or ref < 0):
        return None
    return {
        "ts": now.astimezone(JST).isoformat(timespec="seconds"),
        "cmd": cmd,
        "kind": kind,
        "actor": actor,
        "guild": guild,
        "channel": channel,
        "result": result,
        "code": code,
        "ref": ref,
    }


class AuditLog:
    def __init__(self, directory: Path | None, *, max_bytes: int = DEFAULT_MAX_BYTES,
                 generations: int = DEFAULT_GENERATIONS, clock: Callable[[], datetime] | None = None):
        self.directory = Path(directory) if directory is not None else None
        self.max_bytes = max(1024, int(max_bytes))
        self.generations = max(1, int(generations))
        self._clock = clock or (lambda: datetime.now(JST))
        self._lock = threading.Lock()

    @property
    def path(self) -> Path | None:
        return self.directory / AUDIT_FILE if self.directory is not None else None

    def record(self, *, cmd, kind, actor, result, guild=None, channel=None, code=None, ref=None) -> dict | None:
        """1 件書く。書いた内容を返す（書かなかったとき・書けなかったときは None）。例外は外に出さない。"""
        if self.directory is None:
            return None
        rec = build_record(cmd=cmd, kind=kind, actor=actor, result=result, guild=guild, channel=channel,
                           code=code, ref=ref, now=self._clock())
        if rec is None:
            log.warning("監査ログの項目が規則に合わないため書きません(cmd=%r)", cmd if isinstance(cmd, str) else "?")
            return None
        line = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            try:
                self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                self._rotate_if_needed()
                with open(self.path, "a", encoding="utf-8", newline="\n") as fh:
                    fh.write(line)
            except OSError as error:
                log.warning("監査ログを書けませんでした(操作は続行): %s", type(error).__name__)
                return None
        return rec

    def _rotate_if_needed(self) -> None:
        path = self.path
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return
        if size < self.max_bytes:
            return
        oldest = path.with_name(f"{AUDIT_FILE}.{self.generations}")
        if oldest.exists():
            oldest.unlink()
        for index in range(self.generations - 1, 0, -1):
            src = path.with_name(f"{AUDIT_FILE}.{index}")
            if src.exists():
                os.replace(src, path.with_name(f"{AUDIT_FILE}.{index + 1}"))
        os.replace(path, path.with_name(f"{AUDIT_FILE}.1"))
