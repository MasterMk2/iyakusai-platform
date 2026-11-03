# -*- coding: utf-8 -*-
"""統合アプリの「決定・変更」(sources: decisions)の読み方。Discord・ネットワークに依存しない。

取り決めは docs/contracts/bot-datasource.md の §3（decisions）。応答の形は {"decisions": {"items": [...]}}。
本文(body)と決定の ID(id)は届くが、body は読まず、id は表示しない（変更先 supersededBy を件名に引き直すためだけに使う）。
人の名前・人の ID・出典・履歴・取り消しの理由は、統合アプリが渡さない。知らない値(状態・部局のキー)は、
読める形のまま表示する。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence

from .task_domain import DEPARTMENTS, md_inline

STATUS_LABELS = {"active": "有効", "changed": "変更された", "revoked": "取り消し"}
CHANGE_WINDOW_DAYS = 7
MAX_LIST = 20

_TITLE_MAX = 120
_NOTE_MAX = 200
_SHORT_MAX = 80
_LINK_MAX = 500
# https のリンクで、空白・< >・制御文字を含まないもの(Discord の <...> の囲みが崩れないように)
_LINK = re.compile(r"https://[^\s<>\x00-\x1f\x7f]+")


@dataclass(frozen=True)
class Decision:
    id: str
    title: str
    departments: tuple[str, ...]      # 表示名(知らないキーはそのまま)
    decided_at: str                   # YYYY-MM-DD(日本時間)
    venue: str
    status: str                       # 生の値(active / changed / revoked など)
    status_label: str
    superseded_by: str | None
    change_note: str
    changed_at: datetime | None       # UTC。読めなければ None
    url: str | None                   # https のリンクだけ


def _text(value: Any, limit: int) -> str:
    """改行を空白にして、長さを切る。型が違えば空文字。"""
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _day(value: Any) -> str:
    """決定日(YYYY-MM-DD)。読めない形は決定日なしとして扱う(""を返す)。日付として正規化して返す。"""
    if not isinstance(value, str) or not value or len(value) > 20:
        return ""
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return ""


def _link(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > _LINK_MAX or not _LINK.fullmatch(value):
        return None
    return value


def _instant(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _departments(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    names = []
    for item in value[:10]:
        key = _text(item, _SHORT_MAX)
        if not key:
            continue
        names.append(DEPARTMENTS[key][0] if key in DEPARTMENTS else key)
    return tuple(names)


def parse_decisions(block: Any) -> list[Decision]:
    """応答の decisions 節({"items": [...]})を読む。形の違う要素は読み飛ばす。"""
    if not isinstance(block, dict) or not isinstance(block.get("items"), list):
        return []
    out: list[Decision] = []
    for raw in block["items"]:
        if not isinstance(raw, dict):
            continue
        item_id = _text(raw.get("id"), _SHORT_MAX)
        if not item_id:
            continue
        status = _text(raw.get("status"), _SHORT_MAX)
        superseded = _text(raw.get("supersededBy"), _SHORT_MAX) or None
        out.append(Decision(
            id=item_id,
            title=_text(raw.get("title"), _TITLE_MAX) or "（無題）",
            departments=_departments(raw.get("departments")),
            decided_at=_day(raw.get("decidedAt")),
            venue=_text(raw.get("venue"), 40),
            status=status,
            status_label=STATUS_LABELS.get(status, status or "不明"),
            superseded_by=superseded,
            change_note=_text(raw.get("changeNote"), _NOTE_MAX),
            changed_at=_instant(raw.get("changedAt")),
            url=_link(raw.get("url")),
        ))
    return out


def changed_within(decisions: Iterable[Decision], now: datetime, days: int = CHANGE_WINDOW_DAYS) -> list[Decision]:
    """直近 days 日に変わったもの(新しい順)。変更日が読めないものは決定日で判断する。"""
    since = now.astimezone(timezone.utc) - timedelta(days=days)
    since_day = (now.astimezone(timezone.utc) - timedelta(days=days)).date().isoformat()
    picked = []
    for d in decisions:
        if d.changed_at is not None:
            if d.changed_at >= since:
                picked.append(d)
        elif d.decided_at and d.decided_at >= since_day:
            picked.append(d)
    picked.sort(key=lambda d: d.changed_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return picked


def decision_line(d: Decision, titles: Mapping[str, str] | None = None) -> str:
    """Discord の 1 件分の行。本文は出さず、件名・状態・部局・決定日・変更の要点・リンクだけ。

    件名などは Markdown の書式が効かないように無害化する。差し替え先は ID ではなく件名で出し、
    titles(ID→件名)に無いときは「（差し替え先あり）」とだけ書く。
    """
    head = f"・[{md_inline(d.status_label)}] {md_inline(d.title)}"
    tail = []
    if d.departments:
        tail.append("・".join(md_inline(name) for name in d.departments))
    if d.decided_at:
        tail.append(f"決定 {d.decided_at}")
    if tail:
        head += f"（{'・'.join(tail)}）"
    lines = [head]
    if d.change_note:
        lines.append(f"　変更: {md_inline(d.change_note)}")
    if d.superseded_by:
        name = (titles or {}).get(d.superseded_by)
        lines.append(f"　差し替え先: {md_inline(name)}" if name else "　（差し替え先あり）")
    if d.url:
        lines.append(f"　<{d.url}>")
    return "\n".join(lines)


def decision_rows(decisions: Sequence[Decision], titles: Mapping[str, str] | None = None) -> list[str]:
    return [decision_line(d, titles) for d in decisions]
