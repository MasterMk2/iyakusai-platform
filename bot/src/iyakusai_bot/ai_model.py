# -*- coding: utf-8 -*-
"""Bot の AI のモデルを切り替える（2026-11-21）。

- 替えるのは Bot 専用の Claude の設定（CLAUDE_CONFIG_DIR/settings.json）の env のうち、モデルの読み替え 4 つだけ
  （opus・sonnet・haiku・サブエージェント → 同じモデル）。接続先とキーには触らない。Bot・定期スクリーニング・
  議事録の要約は呼び出しのたびにこのファイルを読むので、再起動は要らない（次の呼び出しから替わる）。
- 選べるのは go_quota.MODEL_LABELS のモデルだけ（11/20〜21 の試験で 5/5 だったもの）。OpenCode Go 経由で
  キーがあるときだけ切り替えられる。
- 書き方は同じフォルダの一時ファイル → os.replace（読む側は古いか新しいかのどちらかだけを見る）。0600 のまま。
  キー入りの控えは作らない（押すたびに増えるため）。記録に残すのは前後のモデル名・誰・いつ だけ。
- 統合アプリからの切り替えは、連携口が依頼（REQUEST_KEY）を書き、Bot が 2 秒ごとの見回りで当てて結果
  （RESULT_KEY）を書く。設定ファイルを書くのは Bot だけ（連携口は書かない）。
- 標準ライブラリだけ。
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import go_quota

MODEL_KEYS = ("ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
              "CLAUDE_CODE_SUBAGENT_MODEL")
# 連携口との受け渡し（assistant.sqlite3 の meta）。名前は連携口（gateway/assistant_gateway.py）と同じ。
REQUEST_KEY = "ai_model_request"
RESULT_KEY = "ai_model_result"
HISTORY_KEY = "ai_model_history"
# 依頼が古ければ当てない（Bot が止まっていた間の依頼が、誰も見ていない時に効かないように）。
REQUEST_TTL_SEC = 120
HISTORY_MAX = 20
_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
_ACTOR = re.compile(r"discord-[0-9]{5,25}")

_lock = threading.Lock()


class SwitchError(Exception):
    """切り替えられない。code は短い英字（記録と連携口用）、str(self) は利用者に見せる日本語。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _settings_path() -> Path | None:
    d = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(d) / "settings.json" if d else None


def label(model: str | None) -> str | None:
    return go_quota.MODEL_LABELS.get(model or "", model) if model else None


def switch(model: str) -> dict:
    """モデルの読み替えを model に替える。{"before", "model", "changed"} を返す。替えられなければ SwitchError。"""
    if model not in go_quota.MODEL_LABELS:
        raise SwitchError("UNKNOWN_MODEL", "そのモデルは選べません。")
    path = _settings_path()
    if path is None:
        raise SwitchError("NOT_GO", "いまの Bot は OpenCode Go を使っていないため、モデルを切り替えられません。")
    with _lock:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise SwitchError("NOT_GO", "Bot の AI の設定を読めないため、モデルを切り替えられません。") from None
        env = data.get("env") if isinstance(data, dict) else None
        if (not isinstance(env, dict) or go_quota.GO_BASE_MARK not in str(env.get("ANTHROPIC_BASE_URL", ""))
                or not env.get("ANTHROPIC_AUTH_TOKEN")):
            raise SwitchError("NOT_GO", "いまの Bot は OpenCode Go を使っていないため、モデルを切り替えられません。")
        before = str(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL") or "") or None
        if all(env.get(k) == model for k in MODEL_KEYS):
            return {"before": before, "model": model, "changed": False}
        for k in MODEL_KEYS:
            env[k] = model
        _write(path, data)
    go_quota.forget()
    return {"before": before, "model": model, "changed": True}


def _write(path: Path, data: dict) -> None:
    """同じフォルダの一時ファイル（mkstemp は 0600 で作る）に書いてから置き換える。"""
    fd, tmp = tempfile.mkstemp(prefix=".settings-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---- 連携口との受け渡し ----

def parse_request(raw: str | None) -> dict | None:
    """連携口が書いた依頼。形が違えば None。"""
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    rid, model, by, at = value.get("id"), value.get("model"), value.get("by"), value.get("at")
    if not (isinstance(rid, str) and _REQUEST_ID.fullmatch(rid) and isinstance(model, str) and len(model) <= 60
            and isinstance(by, str) and _ACTOR.fullmatch(by) and isinstance(at, str) and len(at) <= 40):
        return None
    return {"id": rid, "model": model, "by": by, "at": at}


def handled(request: dict, result_raw: str | None) -> bool:
    """この依頼の結果が、もう書いてあるか。"""
    try:
        result = json.loads(result_raw) if result_raw else None
    except ValueError:
        return False
    return isinstance(result, dict) and result.get("id") == request["id"]


def expired(request: dict, now: datetime | None = None) -> bool:
    try:
        at = datetime.fromisoformat(request["at"].replace("Z", "+00:00"))
    except ValueError:
        return True
    if at.tzinfo is None:
        return True
    age = ((now or datetime.now(timezone.utc)) - at).total_seconds()
    return not -30 <= age <= REQUEST_TTL_SEC


def change_record(outcome: dict, *, by: str, by_name: str | None, source: str) -> dict:
    """記録の 1 件（モデル名・誰・いつ・どこから）。"""
    return {"model": outcome["model"], "previous": outcome.get("before"), "at": _now_iso(), "by": by,
            "byName": (by_name or "")[:40] or None, "source": source}


def push_history(history_raw: str | None, record: dict) -> str:
    try:
        history = json.loads(history_raw) if history_raw else []
    except ValueError:
        history = []
    if not isinstance(history, list):
        history = []
    history = [h for h in history if isinstance(h, dict)][-(HISTORY_MAX - 1):] + [record]
    return json.dumps(history, ensure_ascii=False)


def with_change(snapshot: dict | None, record: dict) -> dict:
    """ai_status の写しを、切り替えた直後の形にする（残り枠はそのまま・モデルと最後の切り替えだけ替える）。"""
    base = dict(snapshot) if isinstance(snapshot, dict) else {"provider": "opencode_go", "ok": False, "windows": [],
                                                              "error": None, "fetchedAt": None}
    base.update({"provider": "opencode_go", "model": record["model"], "modelLabel": label(record["model"]),
                 "choices": go_quota.choices(),
                 "lastChange": {k: record.get(k) for k in ("model", "previous", "at", "byName")}})
    return base
