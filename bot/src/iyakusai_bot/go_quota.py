# -*- coding: utf-8 -*-
"""OpenCode Go の残り枠（5 時間・週・月の %）を読む（2026-11-21）。

- Bot 専用の Claude の設定（CLAUDE_CONFIG_DIR/settings.json の env）で接続先が OpenCode Go のときだけ読む。
  経路とモデル名は**呼ぶたびに読み直す**（モデルは settings.json の書き換えだけで、Bot を再起動せずに替わるため）。
- 窓口は GET https://opencode.ai/zen/go/v1/usage（Authorization: Bearer <Go の API キー>）。公式の説明には
  載っていない。既定の Python の User-Agent は Cloudflare に弾かれる（403・error 1010）ので、名乗りを付ける。
- キー（ANTHROPIC_AUTH_TOKEN）は、この窓口へのヘッダーにだけ使う。戻り値・例外・ログには出さない
  （失敗は例外の種類の名前か HTTP の番号だけにする）。
- 標準ライブラリだけ（スレッドで呼ぶ。Bot は asyncio.to_thread から）。
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
USER_AGENT = "iyakusai-bot/1.0"
GO_BASE_MARK = "opencode.ai/inference/go"
WINDOWS = (("rolling", "5時間"), ("weekly", "週"), ("monthly", "月"))
MODEL_LABELS = {
    "claude-haiku-5-5": "Claude Haiku 5.5",
    "gemini-4-argon": "Gemini 4 Argon",
    "glm-5.3": "GLM-5.3",
    "gpt-5.6-luna": "GPT-5.6 Luna",
}
# Go の Limits(https://opencode.ai/go・2026-11-20〜21 時点)：月の枠を、そのモデルだけを使った場合の
# API 換算額で表したもの。表に無いモデルは換算せず API 換算額を出す(ai_provider・usage が使う)。
GO_MONTHLY_CAP_USD = {"claude-haiku-5-5": 15.0, "deepseek-v4-pro": 15.0, "gpt-5.6-luna": 15.0,
                      "glm-5.3-flash": 60.0, "gemini-4-argon": 30.0}
TIMEOUT_SEC = 10
WARN_PERCENT = 80

_cache: dict | None = None
_cache_at = 0.0


def _settings_env() -> dict:
    d = os.environ.get("CLAUDE_CONFIG_DIR")
    if not d:
        return {}
    try:
        data = json.loads((Path(d) / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    env = data.get("env") if isinstance(data, dict) else None
    return env if isinstance(env, dict) else {}


def current_route() -> dict:
    """いまの経路とモデル（キーは含めない）。"""
    env = _settings_env()
    if GO_BASE_MARK not in str(env.get("ANTHROPIC_BASE_URL", "")):
        return {"provider": "claude_subscription", "model": None, "modelLabel": None}
    model = str(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL") or "") or None
    return {"provider": "opencode_go", "model": model, "modelLabel": MODEL_LABELS.get(model or "", model)}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _windows(body: dict) -> list[dict]:
    usage = body.get("usage") if isinstance(body, dict) else None
    if not isinstance(usage, dict):
        raise ValueError("no usage")
    out = []
    for key, label in WINDOWS:
        w = usage.get(key)
        if not isinstance(w, dict) or not isinstance(w.get("percent"), (int, float)):
            raise ValueError(f"no {key}")
        resets = w.get("resetsAt")
        out.append({"key": key, "label": label, "percent": max(0.0, min(100.0, float(w["percent"]))),
                    "status": str(w.get("status") or "")[:20],
                    "resetsAt": resets if isinstance(resets, str) and len(resets) <= 40 else None})
    return out


def fetch(timeout: float = TIMEOUT_SEC, opener=urllib.request.urlopen) -> dict:
    """いまの残り枠。Go でなければ provider だけ。失敗しても例外にせず ok=False と短い理由を返す。"""
    route = current_route()
    result = {**route, "fetchedAt": _now_iso(), "ok": False, "windows": [], "error": None}
    if route["provider"] != "opencode_go":
        result["error"] = "not_go"
        return result
    result["choices"] = choices()
    key = str(_settings_env().get("ANTHROPIC_AUTH_TOKEN") or "")
    if not key:
        result["error"] = "no_key"
        return result
    req = urllib.request.Request(USAGE_URL, headers={"Authorization": f"Bearer {key}", "User-Agent": USER_AGENT,
                                                     "Accept": "application/json"})
    try:
        with opener(req, timeout=timeout) as res:
            body = json.loads(res.read(65536).decode("utf-8"))
        result["windows"] = _windows(body)
        result["ok"] = True
    except urllib.error.HTTPError as e:
        result["error"] = f"http_{e.code}"
    except (ValueError, KeyError):
        result["error"] = "bad_answer"
    except Exception as e:  # noqa: BLE001  通信の失敗。種類の名前だけ残す（ヘッダーは出さない）
        result["error"] = type(e).__name__[:40]
    return result


def choices() -> list[dict]:
    """切り替えで選べるモデル（2026-11-21。ai_model が使う。表示名の表と同じ並び）。"""
    return [{"model": m, "label": label} for m, label in MODEL_LABELS.items()]


def forget() -> None:
    """/usage の控え（max_age 秒）を捨てる。モデルを切り替えた直後に古いモデル名を出さないため。"""
    global _cache, _cache_at
    _cache, _cache_at = None, 0.0


def get(max_age: float = 60.0, **kwargs) -> dict:
    """直近 max_age 秒の結果があればそれを、無ければ取り直す（/usage の連打で窓口を叩かないため）。"""
    global _cache, _cache_at
    if _cache is not None and time.monotonic() - _cache_at < max_age:
        return _cache
    _cache, _cache_at = fetch(**kwargs), time.monotonic()
    return _cache


def merge_for_store(previous: dict | None, fresh: dict) -> dict:
    """連携口に渡す写し。取れなかったときは前の値を残し、stale と理由を付ける（0% に見せない）。"""
    # 最後の切り替え（ai_model が書く）は、読み直しても残す。
    last = previous.get("lastChange") if isinstance(previous, dict) else None
    keep = {"lastChange": last} if isinstance(last, dict) else {}
    if fresh.get("ok") or fresh.get("provider") != "opencode_go" or not previous or not previous.get("windows"):
        return {**fresh, **keep, "stale": False if fresh.get("ok") else bool(previous and previous.get("windows"))}
    return {**previous, "provider": fresh["provider"], "model": fresh.get("model"),
            "modelLabel": fresh.get("modelLabel"), "choices": fresh.get("choices"), "ok": False, "stale": True,
            "error": fresh.get("error"), "failedAt": fresh.get("fetchedAt"), **keep}


def _jst_clock(iso: str | None) -> str:
    if not iso:
        return "?"
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return "?"
    j = t + timedelta(hours=9)
    return j.strftime("%m/%d %H:%M")


def bar(percent: float, width: int = 10) -> str:
    filled = int(round(percent / 100 * width))
    return "█" * filled + "░" * (width - filled)


def lines(status: dict) -> list[str]:
    """Discord 用の行（/usage）。"""
    out = []
    for w in status.get("windows") or []:
        mark = " ⚠️" if w["percent"] >= WARN_PERCENT or w.get("status") not in ("", "ok") else ""
        out.append(f"{w['label']}　{bar(w['percent'])} **{w['percent']:.0f}%**　{_jst_clock(w.get('resetsAt'))} に戻る{mark}")
    return out
