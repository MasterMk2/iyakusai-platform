# -*- coding: utf-8 -*-
"""AI消費の記帳と集計。

利用枠全体の残量は API/CLI から取得できないため、
「Bot が消費した分」を data/ai_usage.jsonl に記帳し /usage で集計表示する。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")


def fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


class UsageLog:
    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "ai_usage.jsonl"

    def record(self, command: str, user: str, result) -> None:
        """result は ai_provider.AIResult。失敗は記帳しない(呼び出し側で成功時のみ)。"""
        u = result.usage or {}
        entry = {
            "ts": datetime.now(JST).isoformat(timespec="seconds"),
            "command": command,
            "user": user,
            "model": result.model,
            "in": u.get("input_tokens", 0),
            "cache_w": u.get("cache_creation_input_tokens", 0),
            "cache_r": u.get("cache_read_input_tokens", 0),
            "out": u.get("output_tokens", 0),
            "cost_usd": round(result.cost_usd, 6),
            "dur_ms": result.duration_ms,
            # 2026-10-09: 深さ(--effort)別に所要時間・トークンを比べられるように記帳する。
            # 空 = --effort を渡していない(CLI/モデルの既定)。
            "effort": getattr(result, "effort", "") or "",
        }
        # 出力のうち thinking の分(CLI が内訳を返す版のみ)。無い版では列ごと出さない。
        think = (u.get("output_tokens_details") or {}).get("thinking_tokens") \
            if isinstance(u.get("output_tokens_details"), dict) else None
        if isinstance(think, (int, float)):
            entry["think"] = int(think)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def _entries(self) -> list[dict]:
        try:
            out = []
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
            return out
        except FileNotFoundError:
            return []

    @staticmethod
    def _ts(e: dict) -> datetime | None:
        """記帳1行の ts を **aware な** datetime に。読めなければ None(2026-08-12)。

        jsonl は追記専用のプレーンテキストで、手編集やスキーマ変更で欠けた/壊れた行が
        混じりうる。1行の欠損で `/usage` 全体が KeyError で落ちるのを防ぐための保護
        (下の集計キーを `.get` に統一したのと同じ理由)。

        tz の無い ts は **JST とみなす**(2026-08-12 第2ラウンドで追加)。
        `fromisoformat` は naive を naive のまま返すので、素通しすると直後の
        `t >= since`(aware)で TypeError になり、この関数が塞いだはずの
        「1行で `/usage` が丸ごと落ちる」が1手ずれて残っていた。
        ※ このドライブには naive を **UTC** とみなす箇所(mirror._parse_ts /
          knowledge_search._parse_ts)もあるが、あちらは Discord・メールの raw という
          **UTC 表記が慣習の外部ソース**。ai_usage.jsonl は record() が
          `datetime.now(JST)` で書く自前のログで、naive 行が生まれるとしたら手編集か
          旧スキーマ=書き手が見ていたのは JST の壁時計。集計の「今日」「今週」も
          JST 境界なので、JST 解釈が表示と一致する。
        """
        try:
            t = datetime.fromisoformat(e["ts"])
        except (KeyError, TypeError, ValueError):
            return None
        return t if t.tzinfo is not None else t.replace(tzinfo=JST)

    def summarize(self, now: datetime | None = None) -> dict:
        """期間別・モデル別の集計を返す。"""
        now = now or datetime.now(JST)
        today0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week0 = today0 - timedelta(days=now.weekday())  # 月曜0時
        periods = {
            "直近5時間": now - timedelta(hours=5),
            "今日": today0,
            "今週": week0,
            "累計": None,
        }
        entries = self._entries()
        summary: dict = {"periods": {}, "week_by_model": {}, "total_entries": len(entries)}
        for name, since in periods.items():
            # ts が読めない行は期間の内外を判定できないので「累計(since=None)」だけに含める。
            # 集計キーは `.get` に統一する(2026-08-12: 従来 `e["in"]` 等は直接アクセスで、
            # 隣の cost_usd だけ .get という不統一だった。手編集された行や将来のスキーマ
            # 変更が1行混じるだけで `/usage` が丸ごと KeyError になる)。
            # `or 0` まで付けるのは、欠落だけでなく **値が null の行**も同じ壊れ方をするため
            # (手で金額を消すと `"cost_usd": null` になり `None + 0` で TypeError)。
            sel = [e for e in entries
                   if since is None or ((t := self._ts(e)) is not None and t >= since)]
            summary["periods"][name] = {
                "calls": len(sel),
                "tok_in": sum((e.get("in") or 0) + (e.get("cache_w") or 0)
                              + (e.get("cache_r") or 0) for e in sel),
                "tok_out": sum((e.get("out") or 0) for e in sel),
                "cost_usd": sum((e.get("cost_usd") or 0) for e in sel),
            }
        for e in entries:
            t = self._ts(e)
            if t is not None and t >= week0:
                # model が欠けた/null の行でもキーにできるよう "?" に寄せる
                # (呼び出し側 usage.py:43 が sorted() するので None が混ざると TypeError)。
                m = summary["week_by_model"].setdefault(e.get("model") or "?",
                                                        {"calls": 0, "out": 0})
                m["calls"] += 1
                m["out"] += e.get("out") or 0
        return summary
