# -*- coding: utf-8 -*-
"""委員会タスク(/todo)の純ロジック。Discord・SQLite に依存しない。

移植元: 非公開リポジトリ discord-task-manager @ 88d6150 の
src/shared/{types,schemas,dates,limits}.ts と src/server/domain/taskService.ts。
入力規則・状態遷移・変更点の記録・期限の判定を同じ規則で再現する。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

TASK_STATUSES = ("todo", "in_progress", "blocked", "done")
STATUS_LABELS = {"todo": "未着手", "in_progress": "進行中", "blocked": "保留", "done": "完了"}
STATUS_ORDER = {"in_progress": 0, "blocked": 1, "todo": 2, "done": 3}

REQUIREMENT_FIELDS = ("purpose", "deliverable", "completion_criteria", "open_questions")
REQUIREMENT_LABELS = {
    "purpose": "目的",
    "deliverable": "成果物",
    "completion_criteria": "完了条件",
    "open_questions": "不明点",
}
TEXT_FIELDS = ("description",) + REQUIREMENT_FIELDS
TASK_FIELDS = ("title", "description", "assignee_id", "helpers", "deadline", "status", "tags", "parent") + REQUIREMENT_FIELDS
FIELD_LABELS = {
    "title": "タイトル",
    "description": "説明",
    "assignee_id": "主担当",
    "helpers": "副担当",
    "deadline": "期限",
    "status": "状態",
    "tags": "部局",
    "parent": "親タスク",
    **REQUIREMENT_LABELS,
}

# 部局タグ。タスクはチャンネルではなく部局に属し、複数の部局に付けてよい。
# 部と課の両方をタグにでき、部の一覧にはその部の課のタスクも出す。委員なら全員が全部局を見て編集できる。
# キー -> (表示名, 親の部のキー)。並び順は表示・保存の順。
DEPARTMENTS = {
    "yakuin": ("役員会", None),
    "soumu": ("総務部", None),
    "kaikei": ("会計課", "soumu"),
    "system": ("システム課", "soumu"),
    "naimu": ("内務部", None),
    "kikaku": ("企画課", "naimu"),
    "kaijo": ("会場課", "naimu"),
    "gaimu": ("外務部", None),
    "koho": ("広報課", "gaimu"),
    "shogai": ("渉外課", "gaimu"),
}
MAX_TAGS = 5
# 副担当(2026-10-28)。主担当 1 人(assignee_id)に、補助の委員を何人か付ける。
MAX_HELPERS = 10
_LABEL_TO_KEY = {label: key for key, (label, _) in DEPARTMENTS.items()}
DEADLINE_FILTERS = ("overdue", "set", "none")

TITLE_MAX = 120
TEXT_MAX = 2000

# 期限の「今日」は運用地域に合わせて日本時間で判定する(日本は夏時間なし)。
JST = timezone(timedelta(hours=9), "Asia/Tokyo")

# 改行とタブ以外の制御文字を拒否する(schemas.ts の CONTROL_CHARS と同じ範囲)。
_CONTROL_CHARS = re.compile("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
# JS の String.prototype.trim() が除く空白・行終端文字。Python の strip() は
# \x1c-\x1f も除いてしまい規則が変わるため、対象を明示する。
_JS_TRIM = "\t\n\u000b\u000c\r                  　﻿"
# JS の \d は ASCII 数字だけ。Python の \d は全角数字も通すので [0-9] を使う。
_DATE_PATTERN = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_OPERATION_ID = re.compile(r"[A-Za-z0-9_-]{8,80}")


class TaskError(Exception):
    """利用者に返してよい失敗。message はそのまま Discord に出す。"""

    def __init__(self, code: str, message: str, *, details: list[str] | None = None,
                 current: "TaskView | None" = None):
        super().__init__(code)
        self.code = code
        self.message = message
        self.details = details or []
        self.current = current


def not_found() -> TaskError:
    # 別チャンネル・存在しない番号・権限外を区別しない(存在を明かさない)。
    return TaskError("NOT_FOUND", "タスクが見つからないか、表示する権限がありません。")


def _js_length(value: str) -> int:
    """zod の max() と同じく UTF-16 のコード単位で数える(絵文字は 2)。"""
    return len(value.encode("utf-16-le")) // 2


def _invalid(message: str) -> TaskError:
    return TaskError("VALIDATION", "入力内容を確認してください。", details=[message])


def clean_title(value: object) -> str:
    if not isinstance(value, str):
        raise _invalid("タイトルを入力してください")
    text = value.strip(_JS_TRIM)
    if text == "":
        raise _invalid("タイトルを入力してください")
    if _js_length(text) > TITLE_MAX:
        raise _invalid(f"タイトルは {TITLE_MAX} 文字以内で入力してください")
    if "\r" in text or "\n" in text:
        raise _invalid("タイトルに改行は使えません")
    if _CONTROL_CHARS.search(text):
        raise _invalid("使用できない制御文字が含まれています")
    return text


def clean_text(value: object) -> str:
    """説明・目的・成果物・完了条件・不明点。空文字は「未入力に戻す」。"""
    if not isinstance(value, str):
        raise _invalid("文字列で入力してください")
    text = value.strip(_JS_TRIM)
    if _js_length(text) > TEXT_MAX:
        raise _invalid(f"{TEXT_MAX} 文字以内で入力してください")
    if _CONTROL_CHARS.search(text):
        raise _invalid("使用できない制御文字が含まれています")
    return text


def is_valid_date_only(value: str) -> bool:
    match = _DATE_PATTERN.fullmatch(value)
    if not match:
        return False
    year, month, day = (int(part) for part in match.groups())
    if year < 2000 or year > 2100:
        return False
    try:
        date(year, month, day)
    except ValueError:
        return False
    return True


def clean_deadline(value: object) -> str | None:
    """None は「期限なし」(明示解除)。"""
    if value is None:
        return None
    if not isinstance(value, str) or not is_valid_date_only(value):
        raise _invalid("期限は 2000〜2100 年の実在する日付（YYYY-MM-DD）で入力してください")
    return value


def clean_status(value: object) -> str:
    if value not in TASK_STATUSES:
        raise _invalid("状態は未着手・進行中・保留・完了のいずれかです")
    return value  # type: ignore[return-value]


def department_key(value: object) -> str | None:
    """部局のキー(naimu)か表示名(内務部)をキーにする。知らないものは None。"""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value in DEPARTMENTS else _LABEL_TO_KEY.get(value)


def clean_tags(value: object) -> tuple[str, ...]:
    """部局タグを検証して、決まった並び順のキーの組にする(重複は 1 つに)。1 つ以上必須。"""
    if isinstance(value, str):
        value = [part for part in re.split(r"[,、・\s]+", value) if part]
    if not isinstance(value, (list, tuple)) or not value:
        raise _invalid("部局を 1 つ以上選んでください")
    keys = set()
    for item in value:
        key = department_key(item)
        if key is None:
            raise _invalid("部局は 役員会・総務部・会計課・システム課・内務部・企画課・会場課・外務部・広報課・渉外課 から選んでください")
        keys.add(key)
    if len(keys) > MAX_TAGS:
        raise _invalid(f"部局は {MAX_TAGS} つまでです")
    return tuple(k for k in DEPARTMENTS if k in keys)


def clean_parent(value: object) -> int | None:
    """親タスクの番号。None は「親なし」(明示解除)。存在や段数の確認は保存処理が行う。"""
    if value is None:
        return None
    if type(value) is not int or value < 1:
        raise _invalid("親タスクの番号が正しくありません")
    return value


def clean_assignee(value: object) -> int | None:
    if value is not None and (type(value) is not int or value <= 0):
        raise _invalid("担当者の指定が正しくありません")
    return value


def clean_helpers(value: object) -> tuple[int, ...]:
    """副担当のユーザー ID の組。並びは指定の順(重複は 1 つに)。空の組は「副担当なし」。"""
    if not isinstance(value, (list, tuple)):
        raise _invalid("副担当の指定が正しくありません")
    out: list[int] = []
    for item in value:
        if type(item) is not int or item <= 0:
            raise _invalid("副担当の指定が正しくありません")
        if item not in out:
            out.append(item)
    if len(out) > MAX_HELPERS:
        raise _invalid(f"副担当は {MAX_HELPERS} 人までです")
    return tuple(out)


def check_assignees(assignee_id: int | None, helpers: tuple[int, ...]) -> None:
    """主担当と副担当の組み合わせの規則。副担当は主担当のいるタスクにだけ付き、主担当とは別の人。"""
    if helpers and assignee_id is None:
        raise TaskError("INVALID_ASSIGNEES", "副担当がいるタスクは、主担当を未割当にできません。"
                                             "先に副担当を外すか、主担当をほかの人に替えてください。")
    if assignee_id is not None and assignee_id in helpers:
        raise TaskError("INVALID_ASSIGNEES", "主担当の人は副担当にできません。")


def department_filter(key: str) -> tuple[str, ...]:
    """一覧の絞り込み: 部ならその部の課も含める。"""
    return (key,) + tuple(k for k, (_, parent) in DEPARTMENTS.items() if parent == key)


def department_from_name(name: str) -> str | None:
    """チャンネル名から既定の部局を推す(「内務部todo」→内務部、「システム課todo」→システム課)。"""
    hits = [label for label in _LABEL_TO_KEY if (name or "").startswith(label)]
    return _LABEL_TO_KEY[max(hits, key=len)] if hits else None


def format_tags(tags) -> str:
    return "・".join(DEPARTMENTS[t][0] for t in tags if t in DEPARTMENTS) or "（部局なし）"


def clean_operation_id(value: object) -> str:
    if not isinstance(value, str) or not _OPERATION_ID.fullmatch(value):
        raise _invalid("操作 ID の形式が正しくありません")
    return value


def today_jst(now: datetime) -> str:
    return now.astimezone(JST).date().isoformat()


def is_overdue(deadline: str | None, status: str, today: str) -> bool:
    return deadline is not None and status != "done" and deadline < today


_WEEKDAYS = "月火水木金土日"


def format_date_only(value: str | None) -> str:
    if value is None:
        return "期限なし"
    if not is_valid_date_only(value):
        return value
    d = date.fromisoformat(value)
    return f"{d:%Y/%m/%d}（{_WEEKDAYS[d.weekday()]}）"


def format_timestamp(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).astimezone(JST).strftime("%Y/%m/%d %H:%M:%S")
    except ValueError:
        return iso


@dataclass(frozen=True)
class Scope:
    """操作の場所。2026-10-14 からタスクはギルド全体で共有し(部局はタグ)、channel_id は
    操作したチャンネル(Web は 0)として履歴・操作記録に残すだけ。読み書きの限定はギルド単位。"""
    guild_id: int
    channel_id: int = 0


@dataclass(frozen=True)
class Actor:
    user_id: int
    operation_id: str | None = None
    source: str = "discord"


@dataclass
class Task:
    number: int
    title: str
    description: str
    assignee_id: int | None
    deadline: str | None
    status: str
    requirements: dict[str, str]
    version: int
    created_at: str
    created_by: int
    updated_at: str
    updated_by: int
    tags: tuple[str, ...] = ()
    # 親タスクの番号(2026-10-25)。親子は 1 段だけ: 親を持つタスクは親になれない。
    parent: int | None = None
    # 副担当のユーザー ID(2026-10-28)。付けた順。主担当(assignee_id)は含まない。
    helpers: tuple[int, ...] = ()

    def is_assigned_to(self, user_id: int) -> bool:
        """主担当か副担当か。「自分の担当」の絞り込みに使う。"""
        return self.assignee_id == user_id or user_id in self.helpers


@dataclass
class TaskView:
    task: Task
    overdue: bool
    missing: list[str]


def to_view(task: Task, today: str) -> TaskView:
    missing = [f for f in REQUIREMENT_FIELDS if task.requirements[f].strip() == ""]
    return TaskView(task, is_overdue(task.deadline, task.status, today), missing)


@dataclass(frozen=True)
class FieldChange:
    field: str
    before: str | None
    after: str | None

    def as_dict(self) -> dict:
        return {"field": self.field, "before": self.before, "after": self.after}


@dataclass
class HistoryEntry:
    version: int
    action: str
    actor_id: int
    at: str
    source: str
    operation_id: str | None
    changes: list[FieldChange] = field(default_factory=list)


def _str_or_none(value) -> str | None:
    return None if value is None else str(value)


def format_helpers(helpers) -> str | None:
    """履歴に残す副担当の値(ID をカンマでつなぐ)。いなければ None(「なし」)。"""
    return ",".join(str(h) for h in helpers) or None


def parse_helpers(value: str | None) -> tuple[int, ...]:
    """履歴の副担当の値を ID の組に戻す。"""
    return tuple(int(part) for part in (value or "").split(",") if part.isdigit())


def creation_changes(task: Task) -> list[FieldChange]:
    """作成時の履歴。taskService.createTask と同じく空の項目は記録しない。"""
    changes = [FieldChange("title", None, task.title)]
    if task.description:
        changes.append(FieldChange("description", None, task.description))
    if task.assignee_id is not None:
        changes.append(FieldChange("assignee_id", None, str(task.assignee_id)))
    if task.helpers:
        changes.append(FieldChange("helpers", None, format_helpers(task.helpers)))
    if task.deadline is not None:
        changes.append(FieldChange("deadline", None, task.deadline))
    changes.append(FieldChange("status", None, task.status))
    if task.tags:
        changes.append(FieldChange("tags", None, ",".join(task.tags)))
    if task.parent is not None:
        changes.append(FieldChange("parent", None, str(task.parent)))
    for f in REQUIREMENT_FIELDS:
        if task.requirements[f]:
            changes.append(FieldChange(f, None, task.requirements[f]))
    return changes


_UNSET = object()


def clean_changes(changes: dict) -> dict:
    """更新内容を検証して正規化する。キーは TASK_FIELDS のみ。"""
    if not isinstance(changes, dict) or not changes:
        raise _invalid("変更する項目を 1 つ以上指定してください")
    unknown = set(changes) - set(TASK_FIELDS)
    if unknown:
        raise _invalid("変更できない項目が含まれています")
    out: dict = {}
    for key, value in changes.items():
        if key == "title":
            out[key] = clean_title(value)
        elif key in TEXT_FIELDS:
            out[key] = clean_text(value)
        elif key == "deadline":
            out[key] = clean_deadline(value)
        elif key == "status":
            out[key] = clean_status(value)
        elif key == "tags":
            out[key] = clean_tags(value)
        elif key == "parent":
            out[key] = clean_parent(value)
        elif key == "assignee_id":
            out[key] = clean_assignee(value)
        elif key == "helpers":
            out[key] = clean_helpers(value)
    return out


def apply_changes(task: Task, changes: dict) -> list[FieldChange]:
    """taskService.applyTaskUpdate と同じ順序で差分を作り、task に反映する。

    完了からの通常更新は INVALID_TRANSITION、差分が無ければ NO_CHANGE。
    副担当の人を主担当にすると、その人は副担当から外れる(副担当も変えた記録が残る)。
    """
    recorded: list[FieldChange] = []
    changes = dict(changes)
    assignee = changes.get("assignee_id", task.assignee_id)
    if "helpers" not in changes and assignee in task.helpers:
        changes["helpers"] = tuple(h for h in task.helpers if h != assignee)
    # 担当を変えないときは確かめない(ほかの項目の変更を担当の状態で止めない)
    if "assignee_id" in changes or "helpers" in changes:
        check_assignees(assignee, changes.get("helpers", task.helpers))

    def record(name: str, before, after):
        if before != after:
            recorded.append(FieldChange(name, _str_or_none(before), _str_or_none(after)))

    if "title" in changes:
        record("title", task.title, changes["title"])
    if "description" in changes:
        record("description", task.description, changes["description"])
    if "assignee_id" in changes:
        record("assignee_id", task.assignee_id, changes["assignee_id"])
    if "helpers" in changes:
        record("helpers", format_helpers(task.helpers), format_helpers(changes["helpers"]))
    if "deadline" in changes:
        record("deadline", task.deadline, changes["deadline"])
    if "status" in changes:
        if task.status == "done" and changes["status"] != "done":
            raise TaskError("INVALID_TRANSITION",
                            "完了したタスクは「再開」操作で未着手に戻してから変更してください。")
        record("status", task.status, changes["status"])
    if "tags" in changes:
        record("tags", ",".join(task.tags), ",".join(changes["tags"]))
    if "parent" in changes:
        record("parent", task.parent, changes["parent"])
    for f in REQUIREMENT_FIELDS:
        if f in changes:
            record(f, task.requirements[f], changes[f])
    if not recorded:
        raise TaskError("NO_CHANGE", "変更点がありません。")
    for name in {c.field for c in recorded}:
        value = changes[name]
        if name in REQUIREMENT_FIELDS:
            task.requirements[name] = value
        else:
            setattr(task, name, value)
    return recorded


def fingerprint(kind: str, target: object, payload: object, scope: Scope) -> str:
    """操作 ID の再送判定用。scope を含めるので別チャンネルの再送は別内容になる。"""
    body = json.dumps({"kind": kind, "target": target, "payload": payload,
                       "scope": [scope.guild_id, scope.channel_id]},
                      sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()
