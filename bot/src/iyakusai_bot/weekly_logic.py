# -*- coding: utf-8 -*-
"""週1回のタスク一覧と、担当なしタスクの追い投稿の中身(純ロジック・Discord に依存しない)。

- 設定は [weekly]。無ければ何もしない(WeeklySettings.enabled=False)。
- 一覧: 部局ごとの進行中・期限切れ・今週が期限、担当なしの上位(引き受けボタン付き)、
  統合アプリの「今週の決定・変更」(その口が使えないときは節ごと出さない)。
- 追い投稿: 一覧に載せた担当なしのタスクが follow_up_days 過ぎても担当なしなら、同じ部局で
  担当の実績がある人を持ちの少ない順に名前で添えて 1 回だけ。
  候補はタスク DB の主担当・副担当から選ぶ(Bot はサーバーのメンバー一覧を読めないため)。
- 時刻は日本時間。週は ISO 週(月曜始まり)。投稿の既定は月曜 8:40。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Collection, Sequence

from .decisions_logic import Decision, changed_within, decision_rows
from .task_domain import (
    DEPARTMENTS, JST, STATUS_LABELS, Task, TaskView, format_date_only, md_inline,
)

MESSAGE_LIMIT = 1900          # Discord の 2000 文字上限に余裕を持たせる
DEFAULT_WEEKDAY = 1           # 1=月曜 … 7=日曜(ISO)
DEFAULT_HOUR = 8
DEFAULT_MINUTE = 40
DEFAULT_FOLLOW_UP_DAYS = 2
DEFAULT_CANDIDATE_LIMIT = 5
MAX_FOLLOW_UP_CANDIDATES = 3
_TIME = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])")
_SNOWFLAKE_MAX = 2**63


class WeeklyConfigError(ValueError):
    """[weekly] の形や値が正しくない。起動時のエラーに出す(パスや ID の中身は含めない)。"""


@dataclass(frozen=True)
class WeeklySettings:
    enabled: bool = False
    channel_id: int | None = None
    weekday: int = DEFAULT_WEEKDAY
    hour: int = DEFAULT_HOUR
    minute: int = DEFAULT_MINUTE
    follow_up_days: int = DEFAULT_FOLLOW_UP_DAYS
    mention_candidates: bool = False
    candidate_limit: int = DEFAULT_CANDIDATE_LIMIT

    @classmethod
    def from_mapping(cls, raw: Any) -> "WeeklySettings":
        """[weekly] が無い・enabled=false のときは何もしない設定を返す。"""
        if raw is None:
            return cls()
        if not isinstance(raw, dict):
            raise WeeklyConfigError("weekly: [weekly] の形式が正しくありません")
        allowed = {"enabled", "channel_id", "weekday", "time", "follow_up_days",
                   "mention_candidates", "candidate_limit"}
        unknown = set(raw) - allowed
        if unknown:
            raise WeeklyConfigError(f"weekly: 未知の項目があります: {', '.join(sorted(unknown))}")
        enabled = raw.get("enabled", True)
        if type(enabled) is not bool:
            raise WeeklyConfigError("weekly: enabled は true / false で指定してください")
        if not enabled:
            return cls()
        channel = raw.get("channel_id")
        if type(channel) is not int or not 1 <= channel < _SNOWFLAKE_MAX:
            raise WeeklyConfigError("weekly: channel_id は投稿先チャンネルの ID(整数)で指定してください")
        weekday = _bounded(raw.get("weekday"), "weekly.weekday", 1, 7, DEFAULT_WEEKDAY)
        hour, minute = DEFAULT_HOUR, DEFAULT_MINUTE
        if raw.get("time") is not None:
            match = _TIME.fullmatch(str(raw["time"])) if isinstance(raw["time"], str) else None
            if match is None:
                raise WeeklyConfigError("weekly: time は 00:00〜23:59 の形式(例 08:40)で指定してください")
            hour, minute = int(match.group(1)), int(match.group(2))
        mention = raw.get("mention_candidates", False)
        if type(mention) is not bool:
            raise WeeklyConfigError("weekly: mention_candidates は true / false で指定してください")
        return cls(
            enabled=True,
            channel_id=channel,
            weekday=weekday,
            hour=hour,
            minute=minute,
            follow_up_days=_bounded(raw.get("follow_up_days"), "weekly.follow_up_days", 1, 14,
                                    DEFAULT_FOLLOW_UP_DAYS),
            mention_candidates=mention,
            candidate_limit=_bounded(raw.get("candidate_limit"), "weekly.candidate_limit", 1, 5,
                                     DEFAULT_CANDIDATE_LIMIT),
        )


def _bounded(value: Any, where: str, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    if type(value) is not int or not low <= value <= high:
        raise WeeklyConfigError(f"weekly: {where} は {low}〜{high} の整数で指定してください")
    return value


# ---- 週と時刻 ----

def week_key(day: date) -> str:
    """ISO 週のキー(例 2026-W45)。12 月末と 1 月初めは ISO の年で数える。"""
    iso_year, iso_week, _ = day.isocalendar()
    return f"{iso_year:04d}-W{iso_week:02d}"


def week_of(now: datetime) -> str:
    return week_key(now.astimezone(JST).date())


def slot_for(now: datetime, settings: WeeklySettings) -> datetime:
    """now と同じ ISO 週で、設定した曜日・時刻(日本時間)。"""
    local = now.astimezone(JST)
    monday = local.date() - timedelta(days=local.weekday())
    day = monday + timedelta(days=settings.weekday - 1)
    return datetime(day.year, day.month, day.day, settings.hour, settings.minute, tzinfo=JST)


def is_due(now: datetime, settings: WeeklySettings, posted_weeks: Collection[str]) -> bool:
    """今週の投稿時刻を過ぎていて、今週まだ投稿していないとき True。

    時刻を過ぎてから有効にした・Bot が止まっていた場合も、同じ週の中なら追いつく。
    週が変われば、次の週の時刻まで待つ。
    """
    return now >= slot_for(now, settings) and week_of(now) not in posted_weeks


# ---- 投稿の中身 ----

@dataclass(frozen=True)
class Outgoing:
    text: str
    assign_numbers: tuple[int, ...] = ()   # 引き受けボタンを付けるタスク番号
    mention_ids: tuple[int, ...] = ()      # 本文で名指しする人(通知を鳴らすのはこの人だけ)


@dataclass(frozen=True)
class WeeklyPlan:
    week: str
    messages: tuple[Outgoing, ...]
    listed_numbers: tuple[int, ...]        # 担当なし一覧に載せた番号(追い投稿の対象)


def _person(user_id: int | None) -> str:
    return "未割当" if user_id is None else f"<@{user_id}>"


def _depts(tags: Sequence[str]) -> str:
    names = [DEPARTMENTS[t][0] for t in tags if t in DEPARTMENTS]
    return "・".join(names) or "部局なし"


def _due(view: TaskView) -> str:
    return format_date_only(view.task.deadline)


def _order(view: TaskView) -> tuple[str, int]:
    return (view.task.deadline or "9999-99-99", view.task.number)


def _task_line(view: TaskView, *, with_person: bool) -> str:
    t = view.task
    overdue = "・期限切れ" if view.overdue else ""
    if with_person:
        where = f"担当: {_person(t.assignee_id)}・期限: {_due(view)}{overdue}"
    else:
        where = f"部局: {_depts(t.tags)}・期限: {_due(view)}{overdue}"
    return f"・#{t.number} [{STATUS_LABELS[t.status]}] {md_inline(t.title)}（{where}）"


def _split_text(text: str) -> list[str]:
    """MESSAGE_LIMIT を超える本文を、行の境で分ける(1 行が長すぎるときだけ字で切る)。"""
    parts: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > MESSAGE_LIMIT:
            head, line = line[:MESSAGE_LIMIT], line[MESSAGE_LIMIT:]
            if current:
                parts.append(current)
                current = ""
            parts.append(head)
        candidate = line if not current else current + "\n" + line
        if len(candidate) > MESSAGE_LIMIT:
            parts.append(current)
            current = line
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


def _pack(blocks: Sequence[Outgoing]) -> tuple[Outgoing, ...]:
    """ブロックを 2000 字未満の投稿にまとめる。ボタンや名指しを付けるブロックは単独の投稿にする。"""
    out: list[Outgoing] = []
    buf: list[str] = []

    def flush() -> None:
        if buf:
            out.append(Outgoing("\n\n".join(buf)))
            buf.clear()

    size = 0
    for block in blocks:
        if block.assign_numbers or block.mention_ids:
            flush()
            size = 0
            parts = _split_text(block.text)
            for i, part in enumerate(parts):
                last = i == len(parts) - 1   # ボタンや名指しは最後の分割だけに付ける(重複させない)
                out.append(Outgoing(part, block.assign_numbers if last else (),
                                    block.mention_ids if last else ()))
            continue
        for part in _split_text(block.text):
            if buf and size + len(part) + 2 > MESSAGE_LIMIT:
                flush()
                size = 0
            buf.append(part)
            size += len(part) + 2
    flush()
    return tuple(out)


def build_weekly(views: Sequence[TaskView], now: datetime, *, candidate_limit: int,
                 decisions: Sequence[Decision] | None) -> WeeklyPlan:
    """週1回の一覧の中身。decisions が None のときは「決定・変更」の節を出さない。"""
    local = now.astimezone(JST)
    today = local.date()
    today_s = today.isoformat()
    end_s = (today + timedelta(days=6)).isoformat()
    open_views = sorted((v for v in views if v.task.status != "done"), key=_order)
    unassigned = [v for v in open_views if v.task.assignee_id is None]
    overdue_total = sum(1 for v in open_views if v.overdue)

    def due_soon(v: TaskView) -> bool:
        d = v.task.deadline
        return d is not None and today_s <= d <= end_s and not v.overdue

    blocks = [Outgoing(
        f"📋 **今週のタスク一覧**（{today:%Y/%m/%d} 時点）\n"
        f"未完了 {len(open_views)} 件・未割当 {len(unassigned)} 件・期限切れ {overdue_total} 件。"
        "見た人は、担当の人に進み具合を催促してください。")]

    for key, (label, _parent) in DEPARTMENTS.items():
        rows = [v for v in open_views if key in v.task.tags]
        in_progress = [v for v in rows if v.task.status == "in_progress"]
        overdue = [v for v in rows if v.overdue]
        soon = [v for v in rows if due_soon(v)]
        picked: list[TaskView] = []
        for v in overdue + soon + in_progress:
            if v not in picked:
                picked.append(v)
        if not picked:
            continue
        lines = [f"■ **{label}**　進行中 {len(in_progress)}・期限切れ {len(overdue)}・今週が期限 {len(soon)}"]
        lines += [_task_line(v, with_person=True) for v in picked]
        blocks.append(Outgoing("\n".join(lines)))

    top = unassigned[: max(1, candidate_limit)]
    if top:
        lines = [f"🙋 **未割当**（期限の近い順・上位 {len(top)} 件 ／ 全 {len(unassigned)} 件）",
                 "下のボタンを押すと、押した人が主担当になります。"]
        lines += [_task_line(v, with_person=False) for v in top]
        blocks.append(Outgoing("\n".join(lines), assign_numbers=tuple(v.task.number for v in top)))
    else:
        blocks.append(Outgoing("🙋 **未割当**: 未完了で主担当の決まっていないタスクはありません。"))

    if decisions is not None:
        recent = changed_within(decisions, now)
        titles = {d.id: d.title for d in decisions}     # 差し替え先は ID ではなく件名で出す
        lines = ["📌 **今週の決定・変更**（直近 7 日）"]
        if not recent:
            lines.append("（なし）")
        else:
            rows = decision_rows(recent[:20], titles)
            lines += rows
            if len(recent) > 20:
                lines.append(f"ほか {len(recent) - 20} 件。統合アプリの決定の一覧を見てください。")
        blocks.append(Outgoing("\n".join(lines)))

    return WeeklyPlan(
        week=week_of(now),
        messages=_pack(blocks),
        listed_numbers=tuple(v.task.number for v in top),
    )


# ---- 追い投稿 ----

@dataclass(frozen=True)
class Candidate:
    user_id: int
    open_count: int      # その部局の未完了タスクで、主担当・副担当になっている件数


def _holders(task: Task) -> set[int]:
    holders = set(task.helpers)
    if task.assignee_id is not None:
        holders.add(task.assignee_id)
    return holders


def rank_candidates(task: Task, all_tasks: Sequence[Task], limit: int = MAX_FOLLOW_UP_CANDIDATES) -> list[Candidate]:
    """同じ部局のタスクで担当の実績がある人を、持ちの少ない順に並べる(同数は ID の小さい順)。

    同じ部局 = 部局タグを 1 つでも共有すること。実績 = その部局のタスクで主担当・副担当になったこと。
    """
    tags = set(task.tags)
    if not tags:
        return []
    peers = [t for t in all_tasks if t.number != task.number and tags & set(t.tags)]
    pool: set[int] = set()
    for peer in peers:
        pool |= _holders(peer)
    loads = []
    for user_id in pool:
        count = sum(1 for p in peers if p.status != "done" and user_id in _holders(p))
        loads.append(Candidate(user_id, count))
    loads.sort(key=lambda c: (c.open_count, c.user_id))
    return loads[:limit]


def build_follow_up(view: TaskView, *, days_since: int, candidates: Sequence[Candidate],
                    mention: bool) -> Outgoing:
    t = view.task
    if candidates:
        names = "、".join(f"<@{c.user_id}>（この部局の未完了 {c.open_count} 件）" for c in candidates)
        cand = f"同じ部局で担当の実績がある人（持ちの少ない順）: {names}"
    else:
        cand = "同じ部局で担当の実績がある人がいないため、候補は出せません。"
    text = (f"⏰ **#{t.number}** {md_inline(t.title)} は、一覧に載せてから {days_since} 日たっても未割当のままです"
            f"（期限: {_due(view)}）。\n{cand}\n"
            "引き受ける人は下のボタンを押すか、`/todo assign` で担当を決めてください。")
    ids = tuple(c.user_id for c in candidates) if (mention and candidates) else ()
    return Outgoing(text, assign_numbers=(t.number,), mention_ids=ids)


def follow_up_due(posted_at: datetime, now: datetime, days: int) -> bool:
    return now >= posted_at + timedelta(days=days)
