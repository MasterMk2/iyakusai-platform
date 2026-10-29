# -*- coding: utf-8 -*-
"""JSON ストレージ(要件定義 §4.1: SQLite 不採用・ドライブが正)。

書き込みは「一時ファイル → os.replace」でアトミックに行う。
Bot はシングルプロセス・シングルループなのでプロセス内の競合はない。
ホスト間の競合は InstanceLock が防ぐ。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

# write_json のリトライ(2026-08-12・レビュー#6)。
# 待ちを 1 秒未満に抑えているのは、write_json が**イベントループ上から同期で**呼ばれる
# ため(reminders.py の ReminderStore 経由、haiku.py にも同期呼び出しがある)。
# 長いスリープはそのまま Bot 全体の停止時間になるので、3回・0.2s→0.4s で打ち切る。
_WRITE_ATTEMPTS = 3
_WRITE_BACKOFF_SEC = 0.2


def read_json(path: Path, default: Any) -> Any:
    # 2026-08-12(レビュー#19): ここに OSError を足して default を返すのは**やらない**。
    # ドライブの一時I/O失敗で ReminderStore._load() が {"seq":0,"items":[]} を返すと、
    # 直後の add()/update()/delete() がその空データを書き戻して**リマインドが全部消える**。
    # 「読めなかった」は握らず呼び出し元に伝える(reminders.check_loop はログして次tick)。
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data: Any) -> None:
    """tmp+os.replace でアトミックに書く。一時I/O失敗は短くリトライする。

    2026-08-12(レビュー#6): 共有ドライブ(Google Drive)は同期中に PermissionError/
    OSError を一時的に返す。ハートビート側は bot.py:112-114 が「次回に賭ける」と
    明示的に握っているのに、永続化側は1回の失敗がそのまま
    「リマインドの送信済みフラグが保存されない → 毎分同じ通知を連投」になっていた。
    最後まで駄目なら**例外は投げる**(握ると呼び出し元が保存できたと誤認する)。
    """
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    text = json.dumps(data, ensure_ascii=False, indent=1)   # 直列化の失敗は即座に投げる
    for attempt in range(_WRITE_ATTEMPTS):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, path)
            return
        except OSError:
            if attempt == _WRITE_ATTEMPTS - 1:
                raise
            time.sleep(_WRITE_BACKOFF_SEC * (2 ** attempt))


class ReminderStore:
    """reminders.json: {"seq": 最終ID, "items": [リマインド...]}"""

    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "reminders.json"

    def _load(self) -> dict:
        return read_json(self.path, {"seq": 0, "items": []})

    def all(self) -> list[dict]:
        return self._load()["items"]

    def active(self) -> list[dict]:
        return [r for r in self.all() if not r.get("done")]

    # 読んで書き戻す区間は同じプロセス内で直列にする(2026-10-14)。統合アプリの Bot タブ
    # (assistant_cog)が別スレッドから書くため、Reminders の _patch と競ってリマインドを失わないように。
    # 1 プロセス内の直列化で足りる(単一インスタンスはホストロックで保証済み)。
    _write_lock = threading.RLock()

    def add(self, rem: dict) -> dict:
        with self._write_lock:
            data = self._load()
            data["seq"] += 1
            rem["id"] = data["seq"]
            data["items"].append(rem)
            write_json(self.path, data)
        return rem

    def update(self, rem_id: int, **fields) -> dict | None:
        with self._write_lock:
            data = self._load()
            for r in data["items"]:
                if r["id"] == rem_id:
                    r.update(fields)
                    write_json(self.path, data)
                    return r
        return None

    def get(self, rem_id: int) -> dict | None:
        return next((r for r in self.all() if r["id"] == rem_id), None)

    def delete(self, rem_id: int) -> bool:
        with self._write_lock:
            data = self._load()
            before = len(data["items"])
            data["items"] = [r for r in data["items"] if r["id"] != rem_id]
            if len(data["items"]) == before:
                return False
            write_json(self.path, data)
            return True
