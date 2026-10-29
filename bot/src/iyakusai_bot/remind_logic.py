# -*- coding: utf-8 -*-
"""リマインドの純ロジック(Discord 非依存 = オフラインでテスト可能)。

リマインド1件のスキーマ(reminders.json の items 要素):
{
  "id": 1,
  "text": "会計中間報告の提出",
  "due": "2026-07-20T18:00:00+09:00",   # ISO・JST
  "creator_id": 123,                      # 登録者の Discord user ID
  "target_id": 456,                       # 催促対象(null なら登録者)
  "channel_id": 789,                      # 通知先チャンネル(登録したチャンネル)
  "repeat": "none" | "daily" | "weekly" | "monthly",
  "flags": {"day_before": false, "due": false},
  "last_ping": null,                      # 最後に超過催促した時刻(ISO)
  "created_at": "...", "done": false
}
"""

from __future__ import annotations

import calendar
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
DAY = timedelta(days=1)
DEFAULT_TIME = (9, 0)  # 時刻未指定なら 9:00


class ParseError(ValueError):
    pass


def now_jst() -> datetime:
    return datetime.now(JST)


def parse_due(text: str, now: datetime | None = None) -> datetime:
    """期限文字列を JST の datetime にする。

    対応形式:
      2026-07-20 / 2026/07/20 [18:00]
      7/20 / 07-20 [18:00]          … 過去なら翌年
      今日 / 明日 / 明後日 [18:00]
      18:00                          … 今日(過ぎていれば明日)
      +3d / +12h                     … 相対
    """
    now = now or now_jst()
    s = text.strip().replace("　", " ")

    m = re.fullmatch(r"\+(\d+)([dh])", s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return now + (timedelta(days=n) if unit == "d" else timedelta(hours=n))

    # 時刻部分を切り出す
    tm = re.search(r"(\d{1,2}):(\d{2})\s*$", s)
    hour, minute = DEFAULT_TIME
    if tm:
        hour, minute = int(tm.group(1)), int(tm.group(2))
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ParseError(f"時刻が不正です: {tm.group(0)}")
        s = s[: tm.start()].strip()

    if s in ("今日", ""):
        d = now.date()
        if s == "" and not tm:
            raise ParseError("期限を指定してください(例: 7/20 18:00, 明日, +3d)")
    elif s == "明日":
        d = (now + DAY).date()
    elif s == "明後日":
        d = (now + 2 * DAY).date()
    else:
        m = re.fullmatch(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", s)
        if m:
            d = _make_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        else:
            m = re.fullmatch(r"(\d{1,2})[-/](\d{1,2})", s)
            if m:
                d = _make_date(now.year, int(m.group(1)), int(m.group(2)))
                if datetime(d.year, d.month, d.day, hour, minute, tzinfo=JST) <= now:
                    d = _make_date(now.year + 1, int(m.group(1)), int(m.group(2)))
            else:
                raise ParseError(f"期限の形式が読めません: {text}")

    due = datetime(d.year, d.month, d.day, hour, minute, tzinfo=JST)
    if s == "" and tm and due <= now:  # 「18:00」だけで過ぎていたら明日
        due += DAY
    return due


def _make_date(y: int, m: int, day: int):
    try:
        return datetime(y, m, day).date()
    except ValueError as e:
        raise ParseError(f"日付が不正です: {y}-{m}-{day}") from e


def next_occurrence(due: datetime, repeat: str) -> datetime:
    if repeat == "daily":
        return due + DAY
    if repeat == "weekly":
        return due + 7 * DAY
    if repeat == "monthly":
        y, m = (due.year, due.month + 1) if due.month < 12 else (due.year + 1, 1)
        day = min(due.day, calendar.monthrange(y, m)[1])
        return due.replace(year=y, month=m, day=day)
    raise ValueError(f"repeat が不正: {repeat}")


def pending_actions(rem: dict, now: datetime) -> list[str]:
    """このリマインドに今必要な通知を返す。

    - "day_before": 期限24時間前(登録時点で期限まで24時間以上あった場合のみ)
    - "due":        期限到来
    - "overdue":    期限超過の再催促(24時間ごと・repeat なしのみ)
    """
    if rem.get("done"):
        return []
    acts: list[str] = []
    due = datetime.fromisoformat(rem["due"])
    flags = rem.setdefault("flags", {})
    created = datetime.fromisoformat(rem["created_at"])

    if (not flags.get("day_before")
            and created <= due - DAY
            and due - DAY <= now < due):
        acts.append("day_before")

    if not flags.get("due") and now >= due:
        acts.append("due")
    elif (flags.get("due") and rem.get("repeat", "none") == "none" and now >= due):
        last = rem.get("last_ping")
        if last is None or now - datetime.fromisoformat(last) >= timedelta(hours=24):
            acts.append("overdue")
    return acts


def fmt_due(iso: str) -> str:
    d = datetime.fromisoformat(iso).astimezone(JST)
    return d.strftime("%Y-%m-%d %H:%M")
