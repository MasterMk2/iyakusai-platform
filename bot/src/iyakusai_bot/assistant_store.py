# -*- coding: utf-8 -*-
"""統合アプリ「Bot」タブのジョブ表(SQLite・2026-10-14 追加)。

Bot プロセス(assistant_cog)と連携口(gateway/assistant_gateway.py)の**両方が開く**。
どちらも discord を import しない純粋な保存層にしてある。書き手の分担は契約 §1 のとおり:
- ジョブの受付(enqueue)と取り消しは連携口、実行(claim/進捗/完了/失敗)は Bot だけ。
- reminder_snapshot と bot_heartbeat は Bot だけが書く。連携口は読むだけ。

置き場はローカルディスク(共有ドライブ・ドライブの同期フォルダに置かない)。WAL で
2 プロセスが同時に読み書きできる。書き込みは BEGIN IMMEDIATE にして取り合いを 1 文で決める。

ジョブの状態: queued → running → done / failed。queued のままなら本人が canceled にできる。
Bot 起動時に残っていた running は INTERRUPTED で failed にする(単一インスタンスなので
前の Bot の残り=中断扱いで正しい)。

meta の既定キー(Bot が起動時と定期に書き、連携口が読む):
- capabilities: {"features":{ask,doc,image,remind,screening: bool}, "gemini": bool,
  "maxActivePerUser": int, "reminderChannels": [{"id","name"}], "shareChannel": {"id","name"}|None,
  "updatedAt": ISO}
reminder_snapshot.body の形: {"takenAt": ISO, "reminders": [未完了のリマインド]}(役員の判定は連携口が本人の権限で行う)
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

JST = timezone(timedelta(hours=9))
BUSY_TIMEOUT_MS = 5000
SCHEMA_VERSION = "1"

KINDS = ("ask", "doc", "image", "remind", "screening")
# 利用者ごとの同時受付上限(max_active_per_user)の対象。remind/screening は即時処理なので数えない。
ACTIVE_KINDS = ("ask", "doc", "image")
STATES = ("queued", "running", "done", "failed", "canceled")
ACTIVE_STATES = ("queued", "running")
JOB_ID_RE = re.compile(r"j_[a-z0-9]{20}\Z")
_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

SIMILAR_MIN_SCORE = 0.35   # 文字 2-gram の Dice 係数(契約 §3-3 の 0.35 以上)
SIMILAR_LIMIT = 5
SIMILAR_SCAN = 1000        # 比較するのは直近この件数の完了した ask まで(ホームの応答時間を守る)

INTERRUPTED_CODE = "INTERRUPTED"
INTERRUPTED_MESSAGE = "処理の途中で Bot が止まったため中断しました。少し待ってから、もう一度依頼してください。"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ask','doc','image','remind','screening')),
  op TEXT,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','canceled')),
  progress_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  discord_url TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (actor_id, client_operation_id)
);
CREATE INDEX IF NOT EXISTS jobs_by_state ON jobs(state, seq);
CREATE INDEX IF NOT EXISTS jobs_by_kind ON jobs(kind, seq);
CREATE TABLE IF NOT EXISTS job_files(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  relpath TEXT NOT NULL,
  UNIQUE (job_id, name)
);
CREATE TABLE IF NOT EXISTS reminder_snapshot(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  taken_at TEXT NOT NULL,
  body_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_heartbeat(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seen_at TEXT NOT NULL
);
"""

_JOB_COLUMNS = ("seq, id, kind, op, actor_id, actor_name, client_operation_id, input_json, state, "
                "progress_json, result_json, error_code, error_message, discord_url, created_at, "
                "started_at, finished_at, updated_at, attempts")


class AssistantStoreError(RuntimeError):
    """ジョブ表の操作の失敗。code は連携口がそのまま HTTP の code に使える形。"""

    code = "LOAD_FAILED"


class TooManyJobs(AssistantStoreError):
    code = "TOO_MANY_JOBS"


class JobNotFound(AssistantStoreError):
    code = "NOT_FOUND"


class JobForbidden(AssistantStoreError):
    code = "FORBIDDEN"


class JobConflict(AssistantStoreError):
    code = "CONFLICT"


@dataclass
class Job:
    seq: int
    id: str
    kind: str
    op: str | None
    actor_id: str
    actor_name: str
    client_operation_id: str
    input: dict
    state: str
    progress: dict | None = None
    result: dict | None = None
    error_code: str | None = None
    error_message: str | None = None
    discord_url: str | None = None
    created_at: str = ""
    started_at: str | None = None
    finished_at: str | None = None
    updated_at: str = ""
    attempts: int = 0


def new_job_id() -> str:
    return "j_" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(20))


def now_iso() -> str:
    return datetime.now(JST).isoformat(timespec="seconds")


# ---- 類似度(「似た質問」)----

def normalize_question(text: str) -> str:
    """比較用の正規化。全角半角・大文字小文字・空白の差で取りこぼさないため NFKC と小文字化、空白除去。"""
    value = unicodedata.normalize("NFKC", str(text or "")).lower()
    return re.sub(r"\s+", "", value)


def bigrams(text: str) -> set[str]:
    value = normalize_question(text)
    if not value:
        return set()
    if len(value) == 1:
        return {value}
    return {value[i:i + 2] for i in range(len(value) - 1)}


def similarity(a: str, b: str) -> float:
    """文字 2-gram 集合の Dice 係数(0〜1)。日本語の短い質問に強く、語の区切りを要らない。"""
    grams_a, grams_b = bigrams(a), bigrams(b)
    if not grams_a or not grams_b:
        return 0.0
    return 2 * len(grams_a & grams_b) / (len(grams_a) + len(grams_b))


def _job(row) -> Job:
    (seq, job_id, kind, op, actor_id, actor_name, client_operation_id, input_json, state,
     progress_json, result_json, error_code, error_message, discord_url, created_at,
     started_at, finished_at, updated_at, attempts) = row
    return Job(
        seq=seq, id=job_id, kind=kind, op=op, actor_id=actor_id, actor_name=actor_name,
        client_operation_id=client_operation_id, input=json.loads(input_json), state=state,
        progress=json.loads(progress_json) if progress_json else None,
        result=json.loads(result_json) if result_json else None,
        error_code=error_code, error_message=error_message, discord_url=discord_url,
        created_at=created_at, started_at=started_at, finished_at=finished_at,
        updated_at=updated_at, attempts=attempts,
    )


class AssistantStore:
    """1 つの SQLite ファイル。操作ごとに接続を開くので、スレッドからも別プロセスからも使える。"""

    def __init__(self, path: Path):
        self.path = Path(path)

    @classmethod
    def open(cls, path: Path) -> "AssistantStore":
        path = Path(path)
        if not path.is_absolute():
            raise AssistantStoreError("ジョブ表の保存先は絶対パスで指定してください")
        if path.is_symlink():
            raise AssistantStoreError("ジョブ表にシンボリックリンクは使えません")
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        store = cls(path)
        with store._connect() as con:
            con.execute("PRAGMA journal_mode = WAL")
            con.executescript(_SCHEMA)
            con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
                        (SCHEMA_VERSION,))
            version = con.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0]
        if version != SCHEMA_VERSION:
            raise AssistantStoreError("ジョブ表の版が対応外です")
        return store

    @contextmanager
    def _connect(self):
        con = sqlite3.connect(str(self.path), timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
        try:
            con.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
            con.execute("PRAGMA foreign_keys = ON")
            yield con
        finally:
            con.close()

    @contextmanager
    def _write(self):
        """書き込みの1トランザクション。BEGIN IMMEDIATE で他の書き手を待たせる(取り合いを防ぐ)。"""
        with self._connect() as con:
            con.execute("BEGIN IMMEDIATE")
            try:
                yield con
            except BaseException:
                con.execute("ROLLBACK")
                raise
            con.execute("COMMIT")

    # ---- ジョブの受付・取り消し(連携口と Bot の両方から呼ぶ) ----

    def enqueue(self, actor_id: str, actor_name: str, client_operation_id: str, kind: str,
                op: str | None, input_obj: dict, *, max_active: int | None = None) -> tuple[Job, bool]:
        """ジョブを作る。同じ actor・同じ clientOperationId は既存のジョブを返す(replayed=True)。

        ask/doc/image は actor ごとの受付中(queued・running)の件数が max_active 以上なら TooManyJobs。
        """
        if kind not in KINDS:
            raise AssistantStoreError("未対応の種類です")
        with self._write() as con:
            row = con.execute(f"SELECT {_JOB_COLUMNS} FROM jobs WHERE actor_id = ? AND client_operation_id = ?",
                              (actor_id, client_operation_id)).fetchone()
            if row is not None:
                return _job(row), True
            if kind in ACTIVE_KINDS and max_active is not None:
                marks = ",".join("?" * len(ACTIVE_KINDS))
                active = con.execute(
                    f"SELECT COUNT(*) FROM jobs WHERE actor_id = ? AND kind IN ({marks}) "
                    f"AND state IN ('queued','running')", (actor_id, *ACTIVE_KINDS)).fetchone()[0]
                if active >= max_active:
                    raise TooManyJobs("同時に依頼できる件数の上限です。完了を待ってから、もう一度依頼してください。")
            now = now_iso()
            job_id = new_job_id()
            while con.execute("SELECT 1 FROM jobs WHERE id = ?", (job_id,)).fetchone() is not None:
                job_id = new_job_id()
            con.execute(
                "INSERT INTO jobs(id, kind, op, actor_id, actor_name, client_operation_id, input_json, "
                "state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (job_id, kind, op, actor_id, actor_name, client_operation_id,
                 json.dumps(input_obj, ensure_ascii=False), "queued", now, now))
            row = con.execute(f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _job(row), False

    def cancel(self, job_id: str, actor_id: str) -> Job:
        """本人の queued だけ取り消せる。他人のジョブは JobForbidden、実行中・終了済みは JobConflict。"""
        with self._write() as con:
            row = con.execute(f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise JobNotFound("ジョブが見つかりません")
            job = _job(row)
            if job.actor_id != actor_id:
                raise JobForbidden("本人のジョブだけ取り消せます")
            if job.state != "queued":
                raise JobConflict("実行が始まったジョブは取り消せません")
            now = now_iso()
            con.execute("UPDATE jobs SET state = 'canceled', finished_at = ?, updated_at = ? "
                        "WHERE id = ? AND state = 'queued'", (now, now, job_id))
            row = con.execute(f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _job(row)

    # ---- 実行(Bot だけが呼ぶ) ----

    def claim_next(self, kinds: Iterable[str]) -> Job | None:
        """queued の最古の 1 件を running にして返す。2 つの接続が同時に呼んでも 1 件は 1 回しか渡らない。"""
        kinds = tuple(kinds)
        if not kinds:
            return None
        marks = ",".join("?" * len(kinds))
        with self._write() as con:
            found = con.execute(
                f"SELECT id FROM jobs WHERE state = 'queued' AND kind IN ({marks}) ORDER BY seq LIMIT 1",
                kinds).fetchone()
            if found is None:
                return None
            now = now_iso()
            changed = con.execute(
                "UPDATE jobs SET state = 'running', started_at = ?, updated_at = ?, attempts = attempts + 1 "
                "WHERE id = ? AND state = 'queued'", (now, now, found[0])).rowcount
            if changed != 1:
                return None
            row = con.execute(f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (found[0],)).fetchone()
        return _job(row)

    def set_progress(self, job_id: str, progress: dict) -> bool:
        with self._write() as con:
            changed = con.execute(
                "UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ? AND state = 'running'",
                (json.dumps(progress, ensure_ascii=False), now_iso(), job_id)).rowcount
        return changed == 1

    def finish(self, job_id: str, result: dict, discord_url: str | None = None) -> bool:
        now = now_iso()
        with self._write() as con:
            changed = con.execute(
                "UPDATE jobs SET state = 'done', result_json = ?, discord_url = ?, progress_json = NULL, "
                "finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'",
                (json.dumps(result, ensure_ascii=False), discord_url, now, now, job_id)).rowcount
        return changed == 1

    def fail(self, job_id: str, code: str, message: str) -> bool:
        now = now_iso()
        with self._write() as con:
            changed = con.execute(
                "UPDATE jobs SET state = 'failed', error_code = ?, error_message = ?, progress_json = NULL, "
                "finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'",
                (code, message, now, now, job_id)).rowcount
        return changed == 1

    def recover_interrupted(self) -> int:
        """Bot 起動時に呼ぶ。前の Bot が途中で止まった running を INTERRUPTED で失敗させる。"""
        now = now_iso()
        with self._write() as con:
            return con.execute(
                "UPDATE jobs SET state = 'failed', error_code = ?, error_message = ?, progress_json = NULL, "
                "finished_at = ?, updated_at = ? WHERE state = 'running'",
                (INTERRUPTED_CODE, INTERRUPTED_MESSAGE, now, now)).rowcount

    def add_file(self, job_id: str, name: str, mime: str, size: int, sha256: str, relpath: str) -> None:
        """生成物を登録する。連携口はここに登録された (job, name) だけを配る。"""
        with self._write() as con:
            con.execute("INSERT INTO job_files(job_id, name, mime, size, sha256, relpath) VALUES (?,?,?,?,?,?)",
                        (job_id, name, mime, size, sha256, relpath))

    def get_file(self, job_id: str, name: str) -> dict | None:
        with self._connect() as con:
            row = con.execute("SELECT name, mime, size, sha256, relpath FROM job_files "
                              "WHERE job_id = ? AND name = ?", (job_id, name)).fetchone()
        if row is None:
            return None
        return {"name": row[0], "mime": row[1], "size": row[2], "sha256": row[3], "relpath": row[4]}

    def files_for(self, job_id: str) -> list[dict]:
        with self._connect() as con:
            rows = con.execute("SELECT name, mime, size, sha256, relpath FROM job_files "
                               "WHERE job_id = ? ORDER BY id", (job_id,)).fetchall()
        return [{"name": r[0], "mime": r[1], "size": r[2], "sha256": r[3], "relpath": r[4]} for r in rows]

    # ---- 読み取り(連携口・Bot の両方) ----

    def get(self, job_id: str) -> Job | None:
        with self._connect() as con:
            row = con.execute(f"SELECT {_JOB_COLUMNS} FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return None if row is None else _job(row)

    def list_jobs(self, *, kinds: Iterable[str] | None = None, actor_id: str | None = None,
                  before: str | None = None, limit: int = 20) -> tuple[list[Job], str | None]:
        """新しい順。before は「このジョブより古いもの」の起点(ジョブ ID)。次があれば next に起点を返す。"""
        where, params = [], []
        if kinds is not None:
            kinds = tuple(kinds)
            if not kinds:
                return [], None
            where.append(f"kind IN ({','.join('?' * len(kinds))})")
            params.extend(kinds)
        if actor_id is not None:
            where.append("actor_id = ?")
            params.append(actor_id)
        with self._connect() as con:
            if before is not None:
                cursor = con.execute("SELECT seq FROM jobs WHERE id = ?", (before,)).fetchone()
                if cursor is None:
                    raise JobNotFound("起点のジョブが見つかりません")
                where.append("seq < ?")
                params.append(cursor[0])
            sql = f"SELECT {_JOB_COLUMNS} FROM jobs"
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY seq DESC LIMIT ?"
            rows = con.execute(sql, (*params, int(limit) + 1)).fetchall()
        jobs = [_job(r) for r in rows[:int(limit)]]
        next_cursor = jobs[-1].id if len(rows) > int(limit) and jobs else None
        return jobs, next_cursor

    def similar(self, question: str, *, limit: int = SIMILAR_LIMIT,
                min_score: float = SIMILAR_MIN_SCORE) -> list[tuple[Job, float]]:
        """完了した ask のうち、質問が似ているものを (ジョブ, 類似度) で上位から返す。"""
        with self._connect() as con:
            rows = con.execute(
                f"SELECT {_JOB_COLUMNS} FROM jobs WHERE kind = 'ask' AND state = 'done' "
                f"ORDER BY seq DESC LIMIT ?", (SIMILAR_SCAN,)).fetchall()
        scored = []
        for row in rows:
            job = _job(row)
            score = similarity(question, str(job.input.get("question", "")))
            if score >= min_score:
                scored.append((job, round(score, 3)))
        scored.sort(key=lambda item: (-item[1], -item[0].seq))
        return scored[:limit]

    def count_active(self, actor_id: str) -> int:
        marks = ",".join("?" * len(ACTIVE_KINDS))
        with self._connect() as con:
            return con.execute(
                f"SELECT COUNT(*) FROM jobs WHERE actor_id = ? AND kind IN ({marks}) "
                f"AND state IN ('queued','running')", (actor_id, *ACTIVE_KINDS)).fetchone()[0]

    # ---- Bot の生存記録・リマインドの写し・meta ----

    def heartbeat(self) -> None:
        with self._write() as con:
            con.execute("INSERT OR REPLACE INTO bot_heartbeat(id, seen_at) VALUES (1, ?)", (now_iso(),))

    def last_heartbeat(self) -> str | None:
        with self._connect() as con:
            row = con.execute("SELECT seen_at FROM bot_heartbeat WHERE id = 1").fetchone()
        return None if row is None else row[0]

    def write_snapshot(self, body: dict) -> str:
        """リマインドの写し(reminder_snapshot)を 1 行だけ置き換える。取れた時刻を返す。"""
        taken = now_iso()
        with self._write() as con:
            con.execute("INSERT OR REPLACE INTO reminder_snapshot(id, taken_at, body_json) VALUES (1, ?, ?)",
                        (taken, json.dumps(body, ensure_ascii=False)))
        return taken

    def read_snapshot(self) -> tuple[str, dict] | None:
        with self._connect() as con:
            row = con.execute("SELECT taken_at, body_json FROM reminder_snapshot WHERE id = 1").fetchone()
        return None if row is None else (row[0], json.loads(row[1]))

    def set_meta(self, key: str, value: str) -> None:
        with self._write() as con:
            con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        with self._connect() as con:
            row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return default if row is None else row[0]
