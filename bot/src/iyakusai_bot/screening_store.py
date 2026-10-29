# -*- coding: utf-8 -*-
"""定期タスクスクリーニングの候補台帳(SQLite)。

スクリーニング(タイマーで起動する別プロセス)が候補を書き込み、Bot の TaskScreening Cog が
読み出して Discord に投稿・起票する。2 つのプロセスが同じファイルを使うため、状態の変更は
「今の状態が X なら Y にする」という 1 文の UPDATE で行い、取り合いを防ぐ。

候補の状態:
  new        スクリーニングが書いた直後(未投稿)
  publishing Cog が投稿・自動起票の処理中
  posted     部署チャンネルに投稿済み(承認待ち)
  creating   承認ボタンが押され、起票の処理中
  created    起票済み(自動 / 承認)
  rejected   「不要」が押された
  returned   コメント付きで差し戻された(次のスクリーニングで AI が修正版を作る)
  revised    差し戻しを反映した修正版を出した(revised_to に修正版の候補番号)
  undoing    自動起票の取り消し処理中
  undone     自動起票を「誤起票として閉じる」で閉じた
  failed     投稿先に書けない等で処理できなかった(error に理由)

判定の記録(decisions)は追記だけ。誰が・いつ・何をしたか(自動起票・起票・不要・差し戻し・
誤起票・修正版の投稿)を候補ごとに残し、スクリーニングが共有ドライブの判定記録.tsv に書き出す。
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA_VERSION = "3"
BUSY_TIMEOUT_MS = 5000

STATES = ("new", "publishing", "posted", "creating", "created", "rejected", "returned", "revised",
          "undoing", "undone", "failed")
ACTIONS = ("auto", "ok", "ng", "return", "undo", "revised")

_CANDIDATES = f"""
CREATE TABLE candidates(
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  route_key TEXT NOT NULL,
  route_label TEXT NOT NULL,
  channel_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  purpose TEXT NOT NULL,
  deliverable TEXT NOT NULL,
  completion_criteria TEXT NOT NULL,
  open_questions TEXT NOT NULL,
  assignee_name TEXT,
  assignee_id INTEGER,
  deadline TEXT,
  confidence TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('auto','review')),
  decision_note TEXT NOT NULL,
  reason TEXT NOT NULL,
  sources TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ({','.join(repr(s) for s in STATES)})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_id INTEGER,
  task_number INTEGER,
  decided_by INTEGER,
  error TEXT,
  comment TEXT,
  revision_of INTEGER,
  revised_to TEXT,
  tags TEXT
)"""

_SCHEMA = [
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE runs(
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  auto INTEGER NOT NULL DEFAULT 0,
  review INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
)""",
    _CANDIDATES,
    "CREATE INDEX candidates_by_state ON candidates(state, id)",
    f"""CREATE TABLE decisions(
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ({','.join(repr(a) for a in ACTIONS)})),
  actor_id INTEGER,
  at TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  task_number INTEGER,
  related TEXT NOT NULL DEFAULT ''
)""",
    "CREATE INDEX decisions_by_candidate ON decisions(candidate_id, id)",
]

_V1_COLUMNS = ("id, run_id, fingerprint, route_key, route_label, channel_id, title, description, purpose, "
               "deliverable, completion_criteria, open_questions, assignee_name, assignee_id, deadline, "
               "confidence, decision, decision_note, reason, sources, state, created_at, updated_at, "
               "message_id, task_number, decided_by, error")
COLUMNS = _V1_COLUMNS + ", comment, revision_of, revised_to, tags"


class ScreeningStoreError(RuntimeError):
    pass


@dataclass
class CandidateRow:
    id: int
    run_id: int
    fingerprint: str
    route_key: str
    route_label: str
    channel_id: int
    title: str
    description: str
    purpose: str
    deliverable: str
    completion_criteria: str
    open_questions: str
    assignee_name: str | None
    assignee_id: int | None
    deadline: str | None
    confidence: str
    decision: str
    decision_note: str
    reason: str
    sources: str
    state: str
    created_at: str
    updated_at: str
    message_id: int | None
    task_number: int | None
    decided_by: int | None
    error: str | None
    comment: str | None = None
    revision_of: int | None = None
    revised_to: str | None = None
    tags: str | None = None          # 部局タグ(JSON の配列。v3 から。空なら投稿先の部)

    @property
    def source_list(self) -> list[dict]:
        try:
            value = json.loads(self.sources)
        except ValueError:
            return []
        return value if isinstance(value, list) else []

    @property
    def requirements(self) -> dict[str, str]:
        return {"purpose": self.purpose, "deliverable": self.deliverable,
                "completion_criteria": self.completion_criteria, "open_questions": self.open_questions}

    @property
    def tag_list(self) -> list[str]:
        """部局タグ。v3 より前の候補は投稿先の部(route_key = soumu/naimu/gaimu/yakuin)を使う。"""
        try:
            value = json.loads(self.tags) if self.tags else []
        except ValueError:
            value = []
        value = [t for t in value if isinstance(t, str)] if isinstance(value, list) else []
        return value or [self.route_key]


@dataclass
class DecisionRow:
    id: int
    candidate_id: int
    action: str
    actor_id: int | None
    at: str
    comment: str
    task_number: int | None
    related: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ScreeningStore:
    def __init__(self, path: Path):
        self.path = path

    @classmethod
    def open(cls, path: Path, *, create: bool = True) -> "ScreeningStore":
        path = Path(path)
        if path.is_symlink():
            raise ScreeningStoreError("候補台帳にシンボリックリンクは使えません")
        if not path.exists():
            if not create:
                raise ScreeningStoreError("候補台帳がありません")
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_BINARY", 0), 0o600)
            os.close(fd)
        if os.name == "posix" and stat.S_IMODE(path.stat().st_mode) != 0o600:
            os.chmod(path, 0o600)
        store = cls(path)
        store._init()
        return store

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(f"{self.path.resolve().as_uri()}?mode=rw", uri=True,
                              timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
        con.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        con.execute("PRAGMA synchronous = FULL")
        return con

    def _init(self) -> None:
        con = self._connect()
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not tables:
                    for statement in _SCHEMA:
                        con.execute(statement)
                    con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (SCHEMA_VERSION,))
                else:
                    row = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                    if row == ("1",):
                        self._migrate_v1(con)
                    elif row == ("2",):
                        # v2 → v3(2026-10-14): 部局タグの列を足す。既存の候補は投稿先の部を部局とみなす
                        con.execute("ALTER TABLE candidates ADD COLUMN tags TEXT")
                        con.execute("UPDATE meta SET value=? WHERE key='schema_version'", (SCHEMA_VERSION,))
                    elif row != (SCHEMA_VERSION,):
                        raise ScreeningStoreError("候補台帳の形式が違います")
                con.execute("COMMIT")
            except BaseException:
                con.execute("ROLLBACK")
                raise
        finally:
            con.close()

    @staticmethod
    def _migrate_v1(con: sqlite3.Connection) -> None:
        """v1 → v2: 状態に returned / revised を足し、差し戻しの列と判定の記録を追加する。

        状態の CHECK 制約は変更できないので表を作り直す(行はそのまま移す)。
        既に起票済みの候補は、判定の記録を台帳の内容から起こしておく。
        """
        con.execute("ALTER TABLE candidates RENAME TO candidates_v1")
        con.execute("DROP INDEX IF EXISTS candidates_by_state")
        con.execute(_CANDIDATES)
        con.execute(f"INSERT INTO candidates({_V1_COLUMNS}) SELECT {_V1_COLUMNS} FROM candidates_v1")
        con.execute("DROP TABLE candidates_v1")
        for statement in _SCHEMA[3:]:
            con.execute(statement)
        con.execute(
            "INSERT INTO decisions(candidate_id, action, actor_id, at, task_number) "
            "SELECT id, CASE decision WHEN 'auto' THEN 'auto' ELSE 'ok' END, decided_by, updated_at, task_number "
            "FROM candidates WHERE state='created' ORDER BY updated_at, id")
        con.execute("INSERT INTO decisions(candidate_id, action, actor_id, at) "
                    "SELECT id, 'ng', decided_by, updated_at FROM candidates WHERE state='rejected' ORDER BY id")
        con.execute("INSERT INTO decisions(candidate_id, action, actor_id, at, task_number) "
                    "SELECT id, 'undo', decided_by, updated_at, task_number FROM candidates WHERE state='undone' "
                    "ORDER BY id")
        con.execute("UPDATE meta SET value=? WHERE key='schema_version'", (SCHEMA_VERSION,))

    # ---- スクリーニング側 ----

    def get_meta(self, key: str, default=None):
        con = self._connect()
        try:
            row = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        finally:
            con.close()
        return default if row is None else json.loads(row[0])

    def set_meta(self, key: str, value) -> None:
        con = self._connect()
        try:
            con.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, json.dumps(value, ensure_ascii=False)))
        finally:
            con.close()

    def start_run(self) -> int:
        con = self._connect()
        try:
            return con.execute("INSERT INTO runs(started_at, status) VALUES (?, 'running')", (_now(),)).lastrowid
        finally:
            con.close()

    def finish_run(self, run_id: int, status: str, *, messages: int = 0, candidates: int = 0,
                   auto: int = 0, review: int = 0, note: str = "") -> None:
        con = self._connect()
        try:
            con.execute("UPDATE runs SET finished_at=?, status=?, messages=?, candidates=?, auto=?, review=?, note=? "
                        "WHERE id=?", (_now(), status, messages, candidates, auto, review, note[:2000], run_id))
        finally:
            con.close()

    def recent(self, days: int) -> list[CandidateRow]:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
        con = self._connect()
        try:
            rows = con.execute(f"SELECT {COLUMNS} FROM candidates WHERE created_at >= ? ORDER BY id", (since,)).fetchall()
        finally:
            con.close()
        return [CandidateRow(*r) for r in rows]

    def add(self, run_id: int, row: dict) -> int | None:
        """候補を追加する。同じ指紋(振り分け先+タイトル)が既にあれば追加せず None。"""
        now = _now()
        values = dict(row, run_id=run_id, state="new", created_at=now, updated_at=now)
        values.setdefault("revision_of", None)
        values.setdefault("tags", None)
        names = ["run_id", "fingerprint", "route_key", "route_label", "channel_id", "title", "description",
                 "purpose", "deliverable", "completion_criteria", "open_questions", "assignee_name", "assignee_id",
                 "deadline", "confidence", "decision", "decision_note", "reason", "sources", "state", "created_at",
                 "updated_at", "revision_of", "tags"]
        con = self._connect()
        try:
            cur = con.execute(f"INSERT OR IGNORE INTO candidates({', '.join(names)}) "
                              f"VALUES ({','.join('?' * len(names))})", tuple(values[n] for n in names))
            return cur.lastrowid if cur.rowcount == 1 else None
        finally:
            con.close()

    def returned(self) -> list[CandidateRow]:
        con = self._connect()
        try:
            rows = con.execute(f"SELECT {COLUMNS} FROM candidates WHERE state='returned' ORDER BY id").fetchall()
        finally:
            con.close()
        return [CandidateRow(*r) for r in rows]

    def mark_revised(self, cid: int, new_ids: list[int], note: str) -> bool:
        related = ",".join(str(i) for i in new_ids)
        return self.transition(cid, "returned", "revised", revised_to=related,
                               log=("revised", None, note, None, related))

    def decisions(self) -> list[DecisionRow]:
        con = self._connect()
        try:
            rows = con.execute("SELECT id, candidate_id, action, actor_id, at, comment, task_number, related "
                               "FROM decisions ORDER BY at, id").fetchall()
        finally:
            con.close()
        return [DecisionRow(*r) for r in rows]

    def candidates_by_id(self) -> dict[int, CandidateRow]:
        con = self._connect()
        try:
            rows = con.execute(f"SELECT {COLUMNS} FROM candidates").fetchall()
        finally:
            con.close()
        return {r[0]: CandidateRow(*r) for r in rows}

    # ---- Bot(Cog)側 ----

    def get(self, cid: int) -> CandidateRow | None:
        con = self._connect()
        try:
            row = con.execute(f"SELECT {COLUMNS} FROM candidates WHERE id=?", (cid,)).fetchone()
        finally:
            con.close()
        return None if row is None else CandidateRow(*row)

    def posted(self) -> list[CandidateRow]:
        con = self._connect()
        try:
            rows = con.execute(f"SELECT {COLUMNS} FROM candidates WHERE state='posted' AND message_id IS NOT NULL "
                               "ORDER BY id").fetchall()
        finally:
            con.close()
        return [CandidateRow(*r) for r in rows]

    def auto_created(self) -> list[CandidateRow]:
        """自動起票のお知らせ(ボタンが残っているもの)。"""
        con = self._connect()
        try:
            rows = con.execute(f"SELECT {COLUMNS} FROM candidates WHERE state='created' AND decision='auto' "
                               "AND message_id IS NOT NULL ORDER BY id").fetchall()
        finally:
            con.close()
        return [CandidateRow(*r) for r in rows]

    def claim_new(self, limit: int) -> list[CandidateRow]:
        """未投稿の候補を publishing にして返す(取り合い防止のため 1 件ずつ状態を確認)。"""
        con = self._connect()
        try:
            ids = [r[0] for r in con.execute("SELECT id FROM candidates WHERE state='new' ORDER BY id LIMIT ?", (limit,))]
            claimed = []
            for cid in ids:
                cur = con.execute("UPDATE candidates SET state='publishing', updated_at=? WHERE id=? AND state='new'",
                                  (_now(), cid))
                if cur.rowcount == 1:
                    claimed.append(cid)
            rows = [con.execute(f"SELECT {COLUMNS} FROM candidates WHERE id=?", (cid,)).fetchone() for cid in claimed]
        finally:
            con.close()
        return [CandidateRow(*r) for r in rows if r]

    def transition(self, cid: int, before: str, after: str, *, log: tuple | None = None, **fields) -> bool:
        """状態が before のときだけ after にする。fields は同時に書く列。

        log=(action, actor_id, comment, task_number, related) を渡すと、状態の変更と同じ
        トランザクションで判定の記録を 1 行追記する(状態が変わらなかったときは書かない)。
        """
        allowed = {"message_id", "task_number", "decided_by", "error", "decision", "comment", "revised_to"}
        if set(fields) - allowed:
            raise ValueError("unknown fields")
        sets = ", ".join(["state=?", "updated_at=?"] + [f"{k}=?" for k in fields])
        now = _now()
        con = self._connect()
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                cur = con.execute(f"UPDATE candidates SET {sets} WHERE id=? AND state=?",
                                  (after, now, *fields.values(), cid, before))
                changed = cur.rowcount == 1
                if changed and log is not None:
                    action, actor, comment, task_number, related = (tuple(log) + (None,) * 5)[:5]
                    con.execute("INSERT INTO decisions(candidate_id, action, actor_id, at, comment, task_number, related) "
                                "VALUES (?,?,?,?,?,?,?)",
                                (cid, action, actor, now, comment or "", task_number, related or ""))
                con.execute("COMMIT")
            except BaseException:
                con.execute("ROLLBACK")
                raise
            return changed
        finally:
            con.close()

    def release_stale(self, minutes: int = 10) -> int:
        """処理中のまま止まった候補を戻す(Bot の再起動・異常終了の後始末)。

        publishing → new(投稿前に止まった可能性が高い。まれに二重投稿になりうる)
        creating → posted、undoing → created(起票は操作 ID で二重にならない)
        """
        before = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds")
        con = self._connect()
        try:
            n = 0
            for src, dst in (("publishing", "new"), ("creating", "posted"), ("undoing", "created")):
                n += con.execute("UPDATE candidates SET state=?, updated_at=? WHERE state=? AND updated_at < ?",
                                 (dst, _now(), src, before)).rowcount
            return n
        finally:
            con.close()
