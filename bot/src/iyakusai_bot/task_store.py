# -*- coding: utf-8 -*-
"""委員会タスク(/todo)の設定と SQLite 保存。

- 保存先はホストローカルの非公開ディレクトリ(既定 ~/.iyakusai/task-manager)。
  共有ドライブ(data_dir / knowledge_dir)や検索用ミラーとは重ねない。
- 変更・履歴・操作 ID の記録は 1 つのトランザクションで保存する。
- 既存 DB が壊れている・形式が違う場合は初期化もサンプル投入もせず、失敗のまま止める。
- ログには本文・利用者 ID・保存先のパスを出さない。
- 形式 2(2026-10-14): タスクはギルド全体で通し番号、部局はタグ(task_tags)。channel_id は
  起票したチャンネルの記録だけ。形式 1 からの移行は migrate_v1_to_v2 を配置時に明示的に行う
  (チャンネルの部局は推測せず、渡された対応表に従う)。
- 親子(2026-10-25): tasks に parent_id 列を足す(形式は 2 のまま)。旧コードは列を明示して読み書き
  するので、列があっても動き、親の付け外しだけが見えない。既存 DB への追加は add_parent_column を
  配置時に明示的に行い、列の無い DB はこの版では開かない。親子は 1 段だけ。
- 副担当(2026-10-28): task_helpers 表を足す(形式は 2 のまま)。主担当は今までどおり tasks.assignee_id。
  旧コードは表を読まないので、副担当が見えないだけで動く。既存 DB への追加は add_helpers_table を
  配置時に明示的に行い、表の無い DB はこの版では開かない。
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import stat
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from .task_domain import (
    DEPARTMENTS, REQUIREMENT_FIELDS, STATUS_ORDER, TASK_STATUSES, Actor, FieldChange, HistoryEntry, Scope,
    Task, TaskError, TaskView, apply_changes, check_assignees, clean_assignee, clean_changes, clean_deadline,
    clean_helpers, clean_operation_id, clean_parent, clean_status, clean_tags, clean_text, clean_title,
    creation_changes, department_filter, fingerprint, not_found, to_view, today_jst,
)

log = logging.getLogger("iyakusai.tasks")

DEFAULT_STORE_DIR = Path.home() / ".iyakusai" / "task-manager"
DB_NAME = "tasks.sqlite3"
SCHEMA_VERSION = "2"
MAX_OPERATION_RECORDS = 2000
BUSY_TIMEOUT_SEC = 5.0
DEFAULT_BUDGET_SEC = 7.0  # 期限を渡されなかった呼び出しの上限(ロック待ちを無期限にしない)
_MAX_ID = 2**63 - 1


class TaskConfigError(ValueError):
    """設定や保存先が安全条件を満たさない。起動を止める(パスは含めない)。"""


class TaskStoreUnavailable(RuntimeError):
    """既存 DB を安全に開けない。初期化せず /todo を停止状態にする。"""


def _id_list(value, *, allow_empty: bool) -> tuple[int, ...]:
    if not isinstance(value, list) or len(value) > 100 or (not value and not allow_empty):
        raise TaskConfigError("tasks: ID は整数の配列で指定してください")
    if any(type(n) is not int or n <= 0 or n > _MAX_ID for n in value):
        raise TaskConfigError("tasks: ID は正の整数で指定してください")
    return tuple(value)


def _overlaps(a: Path, b: Path) -> bool:
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


@dataclass(frozen=True)
class TaskSettings:
    enabled: bool = False
    guild_ids: tuple[int, ...] = ()
    channel_ids: tuple[int, ...] = ()  # 空 = 許可 guild 内の全 TextChannel(権限は都度確認)
    store_dir: Path = field(default=DEFAULT_STORE_DIR)

    @classmethod
    def from_mapping(cls, raw, *, shared_roots: Iterable[Path | None] = ()) -> "TaskSettings":
        if raw is None:
            return cls()
        if not isinstance(raw, dict):
            raise TaskConfigError("tasks: [tasks] の形式が正しくありません")
        enabled = raw.get("enabled", False)
        if type(enabled) is not bool:
            raise TaskConfigError("tasks: enabled は true / false で指定してください")
        if not enabled:
            return cls()
        if set(raw) - {"enabled", "guild_ids", "channel_ids", "store_dir"}:
            raise TaskConfigError("tasks: 未知の設定項目があります")
        guild_ids = _id_list(raw.get("guild_ids"), allow_empty=False)
        channel_ids = _id_list(raw.get("channel_ids", []), allow_empty=True)
        store_raw = raw.get("store_dir")
        if store_raw is None:
            store_dir = DEFAULT_STORE_DIR
        elif isinstance(store_raw, str) and store_raw.strip():
            store_dir = Path(store_raw).expanduser()
        else:
            raise TaskConfigError("tasks: store_dir は文字列で指定してください")
        if not store_dir.is_absolute():
            raise TaskConfigError("tasks: store_dir は絶対パスで指定してください")
        target = Path(os.path.abspath(store_dir))
        for root in shared_roots:
            if root is None:
                continue
            for candidate in {Path(os.path.abspath(root)), root.resolve()}:
                if _overlaps(target, candidate) or _overlaps(store_dir.resolve(), candidate):
                    raise TaskConfigError("tasks: store_dir は共有データ・検索対象の外に置いてください")
        return cls(enabled=True, guild_ids=guild_ids, channel_ids=channel_ids, store_dir=target)

    def allows(self, guild_id: int | None, channel_id: int | None) -> bool:
        if not self.enabled or guild_id not in self.guild_ids:
            return False
        return not self.channel_ids or channel_id in self.channel_ids


# ---- 保存先の検査 ----

_LOCAL_LINUX_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs"}


def _reject_links(path: Path) -> None:
    for part in [path, *path.parents]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise TaskConfigError("tasks: store_dir にシンボリックリンク等は使えません")


def _check_local_fs(path: Path) -> None:
    """既存のネットワーク・FUSE(rclone 等)・クラウド同期ドライブ上を拒否する。"""
    resolved = path.resolve()
    if os.name == "nt":
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
        if k.GetDriveTypeW(resolved.anchor) != 3:  # DRIVE_FIXED 以外(ネットワーク・UNC 等)
            raise TaskConfigError("tasks: store_dir はローカルの固定ディスクに置いてください")
        fs_name = ctypes.create_unicode_buffer(64)
        ok = k.GetVolumeInformationW(ctypes.c_wchar_p(resolved.anchor), None, 0, None, None, None,
                                     fs_name, len(fs_name))
        # 仮想ドライブ(クラウド同期等)は NTFS 以外を名乗るため拒否される。
        if not ok or fs_name.value.upper() not in ("NTFS", "REFS"):
            raise TaskConfigError("tasks: store_dir はローカルの NTFS/ReFS に置いてください")
    elif sys.platform.startswith("linux"):
        found = []
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            left, right = line.split(" - ", 1)
            mount = Path(left.split()[4].replace("\\040", " ").replace("\\134", "\\"))
            if resolved.is_relative_to(mount):
                found.append((len(str(mount)), right.split()[0]))
        if not found or max(found)[1] not in _LOCAL_LINUX_FS:
            raise TaskConfigError("tasks: store_dir はローカルのディスクに置いてください")
    else:
        raise TaskConfigError("tasks: この OS では保存先の安全確認ができません")


def _tighten(path: Path, mode: int, want_dir: bool) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or (stat.S_ISDIR(info.st_mode) != want_dir) or \
            (not want_dir and not stat.S_ISREG(info.st_mode)):
        raise TaskConfigError("tasks: 保存先の種類が正しくありません")
    if os.name == "posix":
        if info.st_uid != os.geteuid():
            raise TaskConfigError("tasks: 保存先の所有者が Bot の実行ユーザーと異なります")
        if stat.S_IMODE(info.st_mode) != mode:
            os.chmod(path, mode)


def prepare_store_dir(store_dir: Path) -> Path:
    _reject_links(store_dir)
    existing = store_dir
    while not existing.exists():
        existing = existing.parent
    _check_local_fs(existing)
    store_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    _reject_links(store_dir)
    _tighten(store_dir, 0o700, want_dir=True)
    _check_local_fs(store_dir)
    return store_dir


# ---- SQLite ----

_SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tasks(
  id INTEGER PRIMARY KEY,
  guild_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  assignee_id INTEGER,
  deadline TEXT,
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','blocked','done')),
  purpose TEXT NOT NULL,
  deliverable TEXT NOT NULL,
  completion_criteria TEXT NOT NULL,
  open_questions TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL,
  UNIQUE (guild_id, channel_id, number)
);
CREATE TABLE history(
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  guild_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  operation_id TEXT,
  changes TEXT NOT NULL
);
CREATE INDEX history_by_task ON history(task_id, id);
CREATE TABLE operations(
  seq INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  guild_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL,
  UNIQUE (source, actor_id, operation_id)
);
"""
# 形式 2 で足すもの(新規作成時も移行時も同じ)
_SCHEMA_V2 = """
CREATE UNIQUE INDEX tasks_by_guild_number ON tasks(guild_id, number);
CREATE TABLE task_tags(
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX task_tags_by_tag ON task_tags(tag, task_id);
CREATE TABLE legacy_numbers(
  guild_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (guild_id, channel_id, number)
);
"""
# 親子(2026-10-25)。形式 2 のまま足す。新規作成時・形式 1 からの移行時・add_parent_column で同じ文を使う。
_SCHEMA_PARENT = """
ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id);
CREATE INDEX tasks_by_parent ON tasks(parent_id);
"""
# 副担当(2026-10-28)。形式 2 のまま表を足す。新規作成時・形式 1 からの移行時・add_helpers_table で同じ文を使う。
# 旧コードはこの表を読まないので、足したあとも旧コードはそのまま動く(副担当が表示されないだけ)。
_SCHEMA_HELPERS = """
CREATE TABLE task_helpers(
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  user_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_helpers_by_user ON task_helpers(user_id, task_id);
"""
_TABLES = {"meta", "tasks", "history", "operations", "task_tags", "legacy_numbers"}
_TASK_COLUMNS = ("number, title, description, assignee_id, deadline, status, purpose, deliverable, "
                 "completion_criteria, open_questions, version, created_at, created_by, updated_at, updated_by")


def _statements(script: str):
    return filter(str.strip, script.split(";"))


def _has_parent_column(con) -> bool:
    return "parent_id" in {r[1] for r in con.execute("PRAGMA table_info(tasks)")}


def _has_helpers_table(con) -> bool:
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_helpers'").fetchone() is not None


def _row_to_task(row, tags=(), parent: int | None = None, helpers=()) -> Task:
    (number, title, description, assignee_id, deadline, status, purpose, deliverable,
     completion, questions, version, created_at, created_by, updated_at, updated_by) = row
    return Task(number=number, title=title, description=description, assignee_id=assignee_id,
                deadline=deadline, status=status,
                requirements={"purpose": purpose, "deliverable": deliverable,
                              "completion_criteria": completion, "open_questions": questions},
                version=version, created_at=created_at, created_by=created_by,
                updated_at=updated_at, updated_by=updated_by, tags=tuple(tags), parent=parent,
                helpers=tuple(helpers))


def _ordered_tags(tags) -> tuple[str, ...]:
    tags = set(tags)
    return tuple(k for k in DEPARTMENTS if k in tags)


def migrate_v1_to_v2(db_path: Path, channel_tags: dict[int, tuple[str, ...]]) -> dict:
    """形式 1(チャンネル単位)→ 形式 2(ギルド通し番号 + 部局タグ)。配置時に 1 回だけ明示的に行う。

    - 番号: ギルドごとに、タスクが最も多いチャンネルの番号はそのまま残し、ほかのチャンネルの
      タスクは作成順に続きの番号にする。旧番号は legacy_numbers に残す(古いリンクの読み替え用)。
    - タグ: そのタスクを起票したチャンネルの部局(channel_tags)。対応表に無いチャンネルがあれば止める。
    - 1 トランザクション。失敗したら何も変えない。戻り値は付け直しの結果(確認用)。
    """
    con = sqlite3.connect(f"{db_path.as_uri()}?mode=rw", uri=True, timeout=BUSY_TIMEOUT_SEC, isolation_level=None)
    try:
        con.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_SEC * 1000)}")
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("PRAGMA synchronous = FULL")
        con.execute("BEGIN IMMEDIATE")
        try:
            if con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() != ("1",):
                raise TaskStoreUnavailable("schema_version")
            rows = con.execute("SELECT id, guild_id, channel_id, number, created_at FROM tasks").fetchall()
            unknown = {ch for _, _, ch, _, _ in rows if ch not in channel_tags}
            if unknown:
                raise TaskConfigError("tasks: 部局の対応表に無いチャンネルのタスクがあります")
            renumbered = []
            for guild in sorted({g for _, g, _, _, _ in rows}):
                mine = [r for r in rows if r[1] == guild]
                counts: dict[int, int] = {}
                for r in mine:
                    counts[r[2]] = counts.get(r[2], 0) + 1
                keep = max(counts, key=lambda ch: (counts[ch], -ch))
                kept = [r for r in mine if r[2] == keep]
                others = sorted((r for r in mine if r[2] != keep), key=lambda r: (r[4], r[0]))
                nxt = max((r[3] for r in kept), default=0)
                for task_id, _, channel, number, _ in others:
                    nxt += 1
                    renumbered.append((task_id, guild, channel, number, nxt))
            # 一時的に負の番号へ逃がしてから付け直す(新しい一意索引とぶつけない)
            for task_id, _, _, _, new in renumbered:
                con.execute("UPDATE tasks SET number=? WHERE id=?", (-new, task_id))
            for task_id, _, _, _, new in renumbered:
                con.execute("UPDATE tasks SET number=? WHERE id=?", (new, task_id))
            for statement in filter(str.strip, _SCHEMA_V2.split(";")):
                con.execute(statement)
            for task_id, guild, channel, number, _ in rows:
                con.execute("INSERT INTO legacy_numbers(guild_id, channel_id, number, task_id) VALUES (?,?,?,?)",
                            (guild, channel, number, task_id))
                for tag in clean_tags(list(channel_tags[channel])):
                    con.execute("INSERT INTO task_tags(task_id, tag) VALUES (?,?)", (task_id, tag))
            # 今の形式 2 には親子の列(2026-10-25)と副担当の表(2026-10-28)もある
            for statement in _statements(_SCHEMA_PARENT + _SCHEMA_HELPERS):
                con.execute(statement)
            con.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
        return {"tasks": len(rows), "renumbered": [(ch, old, new) for _, _, ch, old, new in renumbered]}
    finally:
        con.close()


def add_parent_column(db_path: Path) -> bool:
    """形式 2 の既存 DB に親子の列を足す(2026-10-25)。配置時に、旧コードが動いたまま 1 回だけ明示的に行う。

    列と索引を足すだけで、既存の行は変えない(全タスクの親は「なし」)。旧コードは列を明示して読み書き
    するので、足したあとも旧コードはそのまま動く。すでに列があれば何もしない(戻り値 False)。
    1 トランザクション。失敗したら何も変えない。
    """
    con = sqlite3.connect(f"{db_path.as_uri()}?mode=rw", uri=True, timeout=BUSY_TIMEOUT_SEC, isolation_level=None)
    try:
        con.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_SEC * 1000)}")
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("PRAGMA synchronous = FULL")
        con.execute("BEGIN IMMEDIATE")
        try:
            if con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() != (SCHEMA_VERSION,):
                raise TaskStoreUnavailable("schema_version")
            if _has_parent_column(con):
                con.execute("ROLLBACK")
                return False
            for statement in _statements(_SCHEMA_PARENT):
                con.execute(statement)
            con.execute("COMMIT")
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
        return True
    finally:
        con.close()


def add_helpers_table(db_path: Path) -> bool:
    """形式 2 の既存 DB に副担当の表を足す(2026-10-28)。配置時に、旧コードが動いたまま 1 回だけ明示的に行う。

    表と索引を足すだけで、既存の行は変えない(全タスクの副担当は「なし」)。親子の列が無い DB では
    行わない(親子の列を先に足す)。すでに表があれば何もしない(戻り値 False)。
    1 トランザクション。失敗したら何も変えない。
    """
    con = sqlite3.connect(f"{db_path.as_uri()}?mode=rw", uri=True, timeout=BUSY_TIMEOUT_SEC, isolation_level=None)
    try:
        con.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_SEC * 1000)}")
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("PRAGMA synchronous = FULL")
        con.execute("BEGIN IMMEDIATE")
        try:
            if con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() != (SCHEMA_VERSION,):
                raise TaskStoreUnavailable("schema_version")
            if not _has_parent_column(con):
                raise TaskStoreUnavailable("parent_column")
            if _has_helpers_table(con):
                con.execute("ROLLBACK")
                return False
            for statement in _statements(_SCHEMA_HELPERS):
                con.execute(statement)
            con.execute("COMMIT")
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
        return True
    finally:
        con.close()


ANY = object()  # 一覧の担当者絞り込みなし


class Budget:
    """1 回の保存処理の打ち切り時刻(単調時計)。呼び出し側の取り消しでも打ち切る。

    ロック待ち・busy 待ちを残り時間内に収め、COMMIT の直前にも確認する。
    時間切れなら ROLLBACK して TIMEOUT を返すので、TIMEOUT のときは何も保存されていない。
    """

    def __init__(self, seconds: float):
        self.at = time.monotonic() + seconds
        self._cancelled = threading.Event()

    def cancel(self) -> None:
        self._cancelled.set()

    def remaining(self) -> float:
        return 0.0 if self._cancelled.is_set() else max(0.0, self.at - time.monotonic())

    def check(self) -> None:
        if self.remaining() <= 0:
            raise TaskError("TIMEOUT", "保存先の応答が時間内に返らなかったため、処理を取り消しました"
                                       "（変更は反映されていません）。少し待ってから再実行してください。")


@dataclass
class Mutation:
    view: TaskView
    replayed: bool


class TaskStore:
    """1 つの SQLite ファイル。操作ごとに接続を開き、スレッドから呼ばれる前提。"""

    def __init__(self, db_path: Path, clock: Callable[[], datetime] | None = None,
                 busy_timeout: float = BUSY_TIMEOUT_SEC):
        self.db_path = db_path
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.busy_timeout = busy_timeout
        self._lock = threading.Lock()

    # -- 開く --

    @classmethod
    def open(cls, store_dir: Path, **kwargs) -> "TaskStore":
        directory = prepare_store_dir(store_dir)
        db_path = directory / DB_NAME
        _reject_links(db_path)
        created = False
        if not db_path.exists():
            fd = os.open(db_path, os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_BINARY", 0), 0o600)
            os.close(fd)
            created = True
        _tighten(db_path, 0o600, want_dir=False)
        store = cls(db_path, **kwargs)
        # 0 バイトは「作成直後に止まった」ものだけ。中身のある既存 DB は初期化しない。
        store._initialize_or_verify(fresh=created or db_path.stat().st_size == 0)
        return store

    def _connect(self) -> sqlite3.Connection:
        # mode=rw: ファイルが消えていても新規作成しない(暗黙の空 DB で動き続けない)。
        con = sqlite3.connect(f"{self.db_path.as_uri()}?mode=rw", uri=True,
                              timeout=self.busy_timeout, isolation_level=None)
        try:
            con.execute(f"PRAGMA busy_timeout = {int(self.busy_timeout * 1000)}")
            con.execute("PRAGMA foreign_keys = ON")
            con.execute("PRAGMA synchronous = FULL")
        except BaseException:
            con.close()
            raise
        return con

    def _initialize_or_verify(self, fresh: bool) -> None:
        try:
            con = self._connect()
        except sqlite3.Error as error:
            raise TaskStoreUnavailable(type(error).__name__) from None
        try:
            if fresh:
                # executescript は暗黙の COMMIT を挟むため、文ごとに同じトランザクションで実行する。
                con.execute("BEGIN IMMEDIATE")
                for statement in _statements(_SCHEMA + _SCHEMA_V2 + _SCHEMA_PARENT + _SCHEMA_HELPERS):
                    con.execute(statement)
                con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (SCHEMA_VERSION,))
                con.execute("COMMIT")
                return
            if con.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise TaskStoreUnavailable("integrity")
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not _TABLES <= tables:
                raise TaskStoreUnavailable("schema")
            row = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if row != (SCHEMA_VERSION,):
                raise TaskStoreUnavailable("schema_version")
            # 親子の列は add_parent_column で足してから開く(暗黙には足さない)
            if not _has_parent_column(con):
                raise TaskStoreUnavailable("parent_column")
            # 副担当の表も add_helpers_table で足してから開く
            if not _has_helpers_table(con):
                raise TaskStoreUnavailable("helpers_table")
        except sqlite3.Error as error:
            raise TaskStoreUnavailable(type(error).__name__) from None
        finally:
            con.close()

    # -- 共通 --

    def _limit_busy(self, con, budget: Budget) -> None:
        budget.check()
        wait = min(self.busy_timeout, budget.remaining())
        con.execute(f"PRAGMA busy_timeout = {int(wait * 1000)}")

    @contextmanager
    def _session(self, write: bool, budget: Budget | None):
        budget = budget or Budget(DEFAULT_BUDGET_SEC)
        budget.check()
        if not self._lock.acquire(timeout=budget.remaining()):
            budget.check()
            raise TaskError("BUSY", "保存先が混み合っています。少し待ってから再実行してください。")
        try:
            try:
                con = self._connect()
            except sqlite3.Error as error:
                log.error("タスク保存先を開けません: %s", type(error).__name__)
                raise TaskError("STORE_FAILED", "タスクの保存先を開けませんでした。管理者に連絡してください。") from None
            try:
                self._limit_busy(con, budget)
                con.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                budget.check()
                yield con
                # COMMIT の直前に期限を確認する。過ぎていれば履歴・操作記録ごと ROLLBACK。
                self._limit_busy(con, budget)
                con.execute("COMMIT")
            except TaskError:
                if con.in_transaction:
                    con.execute("ROLLBACK")
                raise
            except sqlite3.OperationalError as error:
                if con.in_transaction:
                    con.execute("ROLLBACK")
                if "locked" in str(error) or "busy" in str(error):
                    raise TaskError("BUSY", "保存先が混み合っています。少し待ってから再実行してください。") from None
                log.error("タスク保存に失敗: %s", type(error).__name__)
                raise TaskError("STORE_FAILED", "保存に失敗しました。変更は反映されていません。") from None
            except sqlite3.Error as error:
                if con.in_transaction:
                    con.execute("ROLLBACK")
                log.error("タスク保存に失敗: %s", type(error).__name__)
                raise TaskError("STORE_FAILED", "保存に失敗しました。変更は反映されていません。") from None
            except BaseException:
                if con.in_transaction:
                    con.execute("ROLLBACK")
                raise
            finally:
                con.close()
        finally:
            self._lock.release()

    def _today(self) -> str:
        return today_jst(self.clock())

    def _now(self) -> str:
        return self.clock().astimezone(timezone.utc).isoformat(timespec="milliseconds")

    @staticmethod
    def _tags(con, task_ids) -> dict[int, tuple[str, ...]]:
        ids = list(task_ids)
        found: dict[int, list[str]] = {i: [] for i in ids}
        for start in range(0, len(ids), 500):
            part = ids[start:start + 500]
            for task_id, tag in con.execute(
                    f"SELECT task_id, tag FROM task_tags WHERE task_id IN ({','.join('?' * len(part))})", part):
                found[task_id].append(tag)
        return {i: _ordered_tags(tags) for i, tags in found.items()}

    @staticmethod
    def _parents(con, task_ids) -> dict[int, int]:
        """タスクの行 ID → 親タスクの番号(親のあるものだけ)。"""
        ids = list(task_ids)
        found: dict[int, int] = {}
        for start in range(0, len(ids), 500):
            part = ids[start:start + 500]
            for task_id, number in con.execute(
                    f"SELECT t.id, p.number FROM tasks t JOIN tasks p ON p.id = t.parent_id "
                    f"WHERE t.id IN ({','.join('?' * len(part))})", part):
                found[task_id] = number
        return found

    @staticmethod
    def _helpers(con, task_ids) -> dict[int, tuple[int, ...]]:
        """タスクの行 ID → 副担当のユーザー ID(付けた順)。"""
        ids = list(task_ids)
        found: dict[int, list[int]] = {i: [] for i in ids}
        for start in range(0, len(ids), 500):
            part = ids[start:start + 500]
            for task_id, user_id in con.execute(
                    f"SELECT task_id, user_id FROM task_helpers WHERE task_id IN ({','.join('?' * len(part))}) "
                    "ORDER BY task_id, position", part):
                found[task_id].append(user_id)
        return {i: tuple(users) for i, users in found.items()}

    @classmethod
    def _tasks(cls, con, rows) -> list[tuple[int, Task]]:
        """(行 ID, 列…) の行を、部局・親・副担当を付けたタスクにする。"""
        ids = [r[0] for r in rows]
        tags, parents, helpers = cls._tags(con, ids), cls._parents(con, ids), cls._helpers(con, ids)
        return [(r[0], _row_to_task(r[1:], tags[r[0]], parents.get(r[0]), helpers[r[0]])) for r in rows]

    @classmethod
    def _load(cls, con, scope: Scope, number: int) -> tuple[int, Task] | None:
        row = con.execute(
            f"SELECT id, {_TASK_COLUMNS} FROM tasks WHERE guild_id=? AND number=?",
            (scope.guild_id, number)).fetchone()
        return None if row is None else cls._tasks(con, [row])[0]

    @classmethod
    def _load_by_id(cls, con, scope: Scope, task_id: int) -> Task | None:
        row = con.execute(
            f"SELECT id, {_TASK_COLUMNS} FROM tasks WHERE id=? AND guild_id=?",
            (task_id, scope.guild_id)).fetchone()
        return None if row is None else cls._tasks(con, [row])[0][1]

    @staticmethod
    def _parent_id(con, scope: Scope, task_id: int | None, parent: int) -> int:
        """親にする番号を検査して、その行 ID を返す。親子は 1 段だけ(同じトランザクションの中で検査する)。"""
        row = con.execute("SELECT id, parent_id FROM tasks WHERE guild_id=? AND number=?",
                          (scope.guild_id, parent)).fetchone()
        if row is None:
            raise TaskError("INVALID_PARENT", f"親タスク #{parent} が見つかりません。")
        if row[0] == task_id:
            raise TaskError("INVALID_PARENT", "自分自身は親タスクにできません。")
        if row[1] is not None:
            raise TaskError("INVALID_PARENT", f"#{parent} はほかのタスクの子タスクなので、親にできません（親子は 1 段までです）。")
        if task_id is not None and con.execute("SELECT 1 FROM tasks WHERE parent_id=? LIMIT 1", (task_id,)).fetchone():
            raise TaskError("INVALID_PARENT", "子タスクがあるタスクは、ほかのタスクの下に入れられません（親子は 1 段までです）。")
        return row[0]

    @staticmethod
    def _write_tags(con, task_id: int, tags) -> None:
        con.execute("DELETE FROM task_tags WHERE task_id=?", (task_id,))
        for tag in tags:
            con.execute("INSERT INTO task_tags(task_id, tag) VALUES (?,?)", (task_id, tag))

    @staticmethod
    def _write_helpers(con, task_id: int, helpers) -> None:
        con.execute("DELETE FROM task_helpers WHERE task_id=?", (task_id,))
        for position, user_id in enumerate(helpers):
            con.execute("INSERT INTO task_helpers(task_id, user_id, position) VALUES (?,?,?)",
                        (task_id, user_id, position))

    # -- 読み取り(すべて guild で限定。部局はタグで絞る) --

    def legacy_number(self, guild_id: int, channel_id: int, number: int, *,
                      budget: Budget | None = None) -> int | None:
        """形式 1 の(チャンネル, 番号)→ 今の通し番号。古いリンク・投稿の読み替え用。"""
        with self._session(write=False, budget=budget) as con:
            row = con.execute(
                "SELECT t.number FROM legacy_numbers l JOIN tasks t ON t.id = l.task_id "
                "WHERE l.guild_id=? AND l.channel_id=? AND l.number=?", (guild_id, channel_id, number)).fetchone()
        return None if row is None else row[0]

    def list_tasks(self, scope: Scope, *, status: str | None = None, assignee=ANY,
                   deadline: str | None = None, tag: str | None = None,
                   budget: Budget | None = None) -> list[TaskView]:
        """ギルドのタスク一覧。tag を渡すとその部局(部ならその部の課も)のタスクだけ。"""
        if status is not None:
            clean_status(status)
        if deadline not in (None, "overdue", "set", "none"):
            raise TaskError("VALIDATION", "期限の絞り込みは overdue / set / none のいずれかです。")
        if tag is not None and tag not in DEPARTMENTS:
            raise TaskError("VALIDATION", "部局の指定が正しくありません。")
        with self._session(write=False, budget=budget) as con:
            if tag is None:
                rows = con.execute(f"SELECT id, {_TASK_COLUMNS} FROM tasks WHERE guild_id=?",
                                   (scope.guild_id,)).fetchall()
            else:
                keys = department_filter(tag)
                rows = con.execute(
                    f"SELECT id, {_TASK_COLUMNS} FROM tasks WHERE guild_id=? AND id IN "
                    f"(SELECT task_id FROM task_tags WHERE tag IN ({','.join('?' * len(keys))}))",
                    (scope.guild_id, *keys)).fetchall()
            tasks = self._tasks(con, rows)
        today = self._today()
        views = [to_view(task, today) for _, task in tasks]
        if status is not None:
            views = [v for v in views if v.task.status == status]
        # 担当者で絞るときは副担当のタスクも含める。None(未割当)は主担当のいないタスク。
        if assignee is None:
            views = [v for v in views if v.task.assignee_id is None]
        elif assignee is not ANY:
            views = [v for v in views if v.task.is_assigned_to(assignee)]
        if deadline == "none":
            views = [v for v in views if v.task.deadline is None]
        elif deadline == "set":
            views = [v for v in views if v.task.deadline is not None]
        elif deadline == "overdue":
            views = [v for v in views if v.overdue]
        views.sort(key=lambda v: (STATUS_ORDER[v.task.status], v.task.deadline or "9999-99-99", v.task.number))
        return views

    def get_task(self, scope: Scope, number: int, *, budget: Budget | None = None) -> TaskView:
        with self._session(write=False, budget=budget) as con:
            found = self._load(con, scope, number)
        if found is None:
            raise not_found()
        return to_view(found[1], self._today())

    def children(self, scope: Scope, number: int, *, budget: Budget | None = None) -> list[TaskView]:
        """タスクの子タスク(番号順)。親が無い番号は NOT_FOUND。"""
        with self._session(write=False, budget=budget) as con:
            found = self._load(con, scope, number)
            if found is None:
                raise not_found()
            rows = con.execute(f"SELECT id, {_TASK_COLUMNS} FROM tasks WHERE guild_id=? AND parent_id=? "
                               "ORDER BY number", (scope.guild_id, found[0])).fetchall()
            tasks = self._tasks(con, rows)
        today = self._today()
        return [to_view(task, today) for _, task in tasks]

    def history(self, scope: Scope, number: int, *, offset: int = 0, limit: int = 5,
                budget: Budget | None = None) -> tuple[list[HistoryEntry], int]:
        limit = max(1, min(limit, 20))
        offset = max(0, min(offset, 100000))
        with self._session(write=False, budget=budget) as con:
            found = self._load(con, scope, number)
            if found is None:
                raise not_found()
            total = con.execute("SELECT COUNT(*) FROM history WHERE task_id=? AND guild_id=?",
                                (found[0], scope.guild_id)).fetchone()[0]
            rows = con.execute(
                "SELECT version, action, actor_id, at, source, operation_id, changes FROM history "
                "WHERE task_id=? AND guild_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
                (found[0], scope.guild_id, limit, offset)).fetchall()
        entries = [HistoryEntry(version=r[0], action=r[1], actor_id=r[2], at=r[3], source=r[4],
                                operation_id=r[5], changes=[FieldChange(**c) for c in json.loads(r[6])])
                   for r in rows]
        return entries, total

    # -- 変更 --

    def create(self, actor: Actor, scope: Scope, *, title: str, description: str = "",
               assignee_id: int | None = None, deadline: str | None = None,
               requirements: dict[str, str] | None = None, tags=None, parent: int | None = None,
               helpers=(), budget: Budget | None = None) -> Mutation:
        """タスクを作る。番号はギルドの通し番号、tags(部局)は 1 つ以上必須。parent は親タスクの番号(任意)。
        helpers は副担当のユーザー ID(任意。主担当がいるときだけ)。"""
        reqs = {f: clean_text((requirements or {}).get(f, "")) for f in REQUIREMENT_FIELDS}
        payload = {"title": clean_title(title), "description": clean_text(description),
                   "assignee_id": clean_assignee(assignee_id),
                   "deadline": clean_deadline(deadline), "requirements": reqs,
                   "tags": list(clean_tags(tags))}
        # 親なし・副担当なしの作成は従来と同じ指紋にする(作成の再送の判定を変えない)
        if parent is not None:
            payload["parent"] = clean_parent(parent)
        helper_ids = clean_helpers(helpers)
        check_assignees(payload["assignee_id"], helper_ids)
        if helper_ids:
            payload["helpers"] = list(helper_ids)

        def apply(con, now: str) -> int:
            parent_id = None if parent is None else self._parent_id(con, scope, None, payload["parent"])
            number = con.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE guild_id=?",
                                 (scope.guild_id,)).fetchone()[0]
            task = Task(number=number, title=payload["title"], description=payload["description"],
                        assignee_id=payload["assignee_id"], deadline=payload["deadline"], status="todo",
                        requirements=dict(reqs), version=1, created_at=now, created_by=actor.user_id,
                        updated_at=now, updated_by=actor.user_id, tags=tuple(payload["tags"]),
                        parent=payload.get("parent"), helpers=helper_ids)
            cur = con.execute(
                f"INSERT INTO tasks(guild_id, channel_id, {_TASK_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (scope.guild_id, scope.channel_id, task.number, task.title, task.description, task.assignee_id,
                 task.deadline, task.status, reqs["purpose"], reqs["deliverable"], reqs["completion_criteria"],
                 reqs["open_questions"], task.version, now, actor.user_id, now, actor.user_id))
            if parent_id is not None:
                con.execute("UPDATE tasks SET parent_id=? WHERE id=?", (parent_id, cur.lastrowid))
            self._write_tags(con, cur.lastrowid, task.tags)
            self._write_helpers(con, cur.lastrowid, task.helpers)
            self._insert_history(con, cur.lastrowid, scope, actor, task.version, "created",
                                 creation_changes(task), now)
            return cur.lastrowid

        return self._mutate(actor, scope, "create-task", None, payload, apply, budget)

    def update(self, actor: Actor, scope: Scope, number: int, expected_version: int, changes: dict,
               *, confirmed: bool = False, budget: Budget | None = None) -> Mutation:
        cleaned = clean_changes(changes)
        version = self._check_expected(expected_version)

        def apply(con, now: str) -> int:
            task_id, task = self._require(con, scope, number)
            self._check_version(task, version)
            # 完了への変更は明示確認の後だけ(完了条件が空でも禁止はせず警告する)。
            if cleaned.get("status") == "done" and task.status != "done" and not confirmed:
                open_children = con.execute("SELECT COUNT(*) FROM tasks WHERE parent_id=? AND status<>'done'",
                                            (task_id,)).fetchone()[0]
                raise TaskError("CONFIRM_REQUIRED", _done_confirmation(task, open_children),
                                current=to_view(task, self._today()))
            parent_id = None
            if cleaned.get("parent") is not None and cleaned["parent"] != task.parent:
                parent_id = self._parent_id(con, scope, task_id, cleaned["parent"])
            recorded = apply_changes(task, cleaned)
            task.version += 1
            cur = con.execute(
                "UPDATE tasks SET title=?, description=?, assignee_id=?, deadline=?, status=?, purpose=?, "
                "deliverable=?, completion_criteria=?, open_questions=?, version=?, updated_at=?, updated_by=? "
                "WHERE id=? AND guild_id=? AND version=?",
                (task.title, task.description, task.assignee_id, task.deadline, task.status,
                 task.requirements["purpose"], task.requirements["deliverable"],
                 task.requirements["completion_criteria"], task.requirements["open_questions"],
                 task.version, now, actor.user_id, task_id, scope.guild_id, version))
            if cur.rowcount != 1:  # 版の比較と更新を同じ文で行う(取りこぼし防止)
                raise self._conflict(con, scope, number)
            if "tags" in cleaned:
                self._write_tags(con, task_id, task.tags)
            if any(c.field == "parent" for c in recorded):
                con.execute("UPDATE tasks SET parent_id=? WHERE id=?", (parent_id, task_id))
            # 副担当の人を主担当にしたときも、副担当の表から外す(apply_changes が helpers の変更を記録する)
            if any(c.field == "helpers" for c in recorded):
                self._write_helpers(con, task_id, task.helpers)
            self._insert_history(con, task_id, scope, actor, task.version, "updated", recorded, now)
            return task_id

        return self._mutate(actor, scope, "update-task", number,
                            {"changes": cleaned, "expected_version": version}, apply, budget)

    def reopen(self, actor: Actor, scope: Scope, number: int, expected_version: int,
               *, confirmed: bool = False, budget: Budget | None = None) -> Mutation:
        version = self._check_expected(expected_version)

        def apply(con, now: str) -> int:
            task_id, task = self._require(con, scope, number)
            self._check_version(task, version)
            if task.status != "done":
                raise TaskError("INVALID_TRANSITION", "再開できるのは完了したタスクだけです。")
            if not confirmed:
                raise TaskError("CONFIRM_REQUIRED",
                                f"「{task.title}」を未着手に戻します。よければ `確認:True` を付けて再実行してください。",
                                current=to_view(task, self._today()))
            cur = con.execute(
                "UPDATE tasks SET status='todo', version=version+1, updated_at=?, updated_by=? "
                "WHERE id=? AND guild_id=? AND version=?",
                (now, actor.user_id, task_id, scope.guild_id, version))
            if cur.rowcount != 1:
                raise self._conflict(con, scope, number)
            self._insert_history(con, task_id, scope, actor, version + 1, "reopened",
                                 [FieldChange("status", "done", "todo")], now)
            return task_id

        return self._mutate(actor, scope, "reopen-task", number, {"expected_version": version}, apply, budget)

    # -- 内部 --

    @staticmethod
    def _check_expected(value) -> int:
        if type(value) is not int or value < 1:
            raise TaskError("VALIDATION", "入力内容を確認してください。",
                            details=["更新版（版）を 1 以上の整数で指定してください"])
        return value

    def _require(self, con, scope: Scope, number: int) -> tuple[int, Task]:
        found = self._load(con, scope, number) if type(number) is int else None
        if found is None:
            raise not_found()
        return found

    def _check_version(self, task: Task, expected: int) -> None:
        if task.version != expected:
            raise TaskError(
                "VERSION_CONFLICT",
                f"他の操作で先に更新されています（現在の版: {task.version}）。"
                "最新の内容を確認してから、もう一度操作してください。",
                current=to_view(task, self._today()))

    def _conflict(self, con, scope: Scope, number: int) -> TaskError:
        found = self._load(con, scope, number)
        if found is None:
            return not_found()
        task = found[1]
        return TaskError("VERSION_CONFLICT",
                         f"他の操作で先に更新されています（現在の版: {task.version}）。"
                         "最新の内容を確認してから、もう一度操作してください。",
                         current=to_view(task, self._today()))

    def _insert_history(self, con, task_id: int, scope: Scope, actor: Actor, version: int, action: str,
                        changes: list[FieldChange], now: str) -> None:
        con.execute(
            "INSERT INTO history(task_id, guild_id, channel_id, version, action, actor_id, at, source, "
            "operation_id, changes) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (task_id, scope.guild_id, scope.channel_id, version, action, actor.user_id, now, actor.source,
             actor.operation_id, json.dumps([c.as_dict() for c in changes], ensure_ascii=False)))

    def _mutate(self, actor: Actor, scope: Scope, kind: str, target, payload,
                apply: Callable[[sqlite3.Connection, str], int], budget: Budget | None) -> Mutation:
        """操作 ID の確認 → 適用 → 履歴 → 操作記録 を 1 トランザクションで行う。"""
        op = None if actor.operation_id is None else clean_operation_id(actor.operation_id)
        print_ = fingerprint(kind, target, payload, scope)
        with self._session(write=True, budget=budget) as con:
            if op is not None:
                prior = con.execute(
                    "SELECT guild_id, channel_id, fingerprint, task_id FROM operations "
                    "WHERE source=? AND actor_id=? AND operation_id=?",
                    (actor.source, actor.user_id, op)).fetchone()
                if prior is not None:
                    # 別の場所・別内容の再送は拒否する(指紋に操作した場所を含む)。他ギルドのタスクは返さない。
                    if prior[2] != print_ or prior[0] != scope.guild_id:
                        raise TaskError("IDEMPOTENCY_CONFLICT",
                                        "同じ操作 ID で異なる内容が送られました。新しく操作し直してください。")
                    task = self._load_by_id(con, scope, prior[3])
                    if task is None:
                        raise not_found()
                    return Mutation(to_view(task, self._today()), replayed=True)
            now = self._now()
            task_id = apply(con, now)
            if op is not None:
                con.execute(
                    "INSERT INTO operations(source, actor_id, operation_id, guild_id, channel_id, fingerprint, "
                    "task_id, at) VALUES (?,?,?,?,?,?,?,?)",
                    (actor.source, actor.user_id, op, scope.guild_id, scope.channel_id, print_, task_id, now))
                con.execute(
                    "DELETE FROM operations WHERE seq <= (SELECT seq FROM operations ORDER BY seq DESC "
                    "LIMIT 1 OFFSET ?)", (MAX_OPERATION_RECORDS,))
            task = self._load_by_id(con, scope, task_id)
        return Mutation(to_view(task, self._today()), replayed=False)


def _done_confirmation(task: Task, open_children: int = 0) -> str:
    text = (f"「{task.title}」を完了にします。完了後の変更は `/todo reopen` から行います。"
            "よければ `確認:True` を付けて再実行してください。")
    if task.requirements["completion_criteria"] == "":
        text += "\n⚠ 完了条件が未入力です。完了にしてよいか確認してください。"
    if open_children:
        text += f"\n⚠ 未完了の子タスクが {open_children} 件あります（子タスクは完了になりません）。"
    return text
