# -*- coding: utf-8 -*-
"""週1回の一覧と追い投稿の記録(weekly_state.json)。Discord に依存しない。

記録すること: 投稿した週(二重投稿の防止)・一覧に載せたタスク番号(追い投稿の対象)・
追い投稿を済ませた(または閉じた)タスク番号(1 回だけの保証)。
- 場所は Bot の data_dir(ReminderStore と同じ)。書き込みは storage.write_json のアトミック書き込み。
- 読めないとき(形が壊れている・権限)は空とみなさず例外にする。空とみなすと、同じ週の一覧を
  もう一度出してしまうため。
- 送る前に記録し、送れなかったときだけ記録を戻す(呼び出し側の WeeklyService が行う)。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from .storage import write_json

STATE_FILE = "weekly_state.json"
KEEP_POSTS = 60


class WeeklyStateError(RuntimeError):
    """記録を読めない。投稿は止めて、次の回に読み直す。"""


def _empty() -> dict[str, Any]:
    return {"version": 1, "posts": [], "followups": {}}


class WeeklyStateStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def _load(self) -> dict[str, Any]:
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return _empty()
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            raise WeeklyStateError("weekly_state.json の形式が壊れています") from None
        if (not isinstance(data, dict) or not isinstance(data.get("posts"), list)
                or not isinstance(data.get("followups"), dict)):
            raise WeeklyStateError("weekly_state.json の形式が想定と違います")
        return data

    def _save(self, data: dict[str, Any]) -> None:
        data["posts"] = data["posts"][-KEEP_POSTS:]
        write_json(self.path, data)

    def posted_weeks(self) -> set[str]:
        with self._lock:
            return {str(p.get("week")) for p in self._load()["posts"]}

    def posts(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(p) for p in self._load()["posts"]]

    def reserve_week(self, week: str, posted_at: str, channel_id: int, numbers: list[int]) -> bool:
        """この週をまだ投稿していなければ記録して True。記録済みなら False(二重投稿しない)。"""
        with self._lock:
            data = self._load()
            if any(p.get("week") == week for p in data["posts"]):
                return False
            data["posts"].append({"week": week, "posted_at": posted_at,
                                  "channel_id": channel_id, "numbers": list(numbers)})
            self._save(data)
            return True

    def release_week(self, week: str) -> None:
        """1 通も送れなかったときだけ呼ぶ。次の回にもう一度投稿させるため記録を消す。"""
        with self._lock:
            data = self._load()
            data["posts"] = [p for p in data["posts"] if p.get("week") != week]
            self._save(data)

    def followup_state(self, number: int) -> str | None:
        with self._lock:
            entry = self._load()["followups"].get(str(number))
            return entry.get("state") if isinstance(entry, dict) else None

    def mark_followup(self, number: int, state: str, at: str) -> None:
        """state: followed(追い投稿を送った) / closed(担当が決まった・完了・見つからない)。"""
        with self._lock:
            data = self._load()
            data["followups"][str(number)] = {"state": state, "at": at}
            self._save(data)

    def clear_followup(self, number: int) -> None:
        """送れなかったときだけ呼ぶ。次の回にもう一度送るため。"""
        with self._lock:
            data = self._load()
            data["followups"].pop(str(number), None)
            self._save(data)
