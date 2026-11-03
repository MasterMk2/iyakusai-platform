# -*- coding: utf-8 -*-
"""Discord のロール付与状況の整理と文面。Discord に接続しない(取得は roles.py)。

入力は Discord API の形のまま(GET /guilds/{id}/roles と /members の dict)。
Bot のアカウントと、連携で自動で付くロール(managed)・@everyone は委員の話ではないので外す。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

_JST = timezone(timedelta(hours=9))
EMBED_LIMIT = 4000   # Embed の description は 4096 字まで


@dataclass(frozen=True)
class RoleInfo:
    id: int
    name: str
    position: int


@dataclass(frozen=True)
class Person:
    id: int
    name: str
    role_ids: frozenset[int]


@dataclass(frozen=True)
class Roster:
    guild_name: str
    roles: tuple[RoleInfo, ...]    # サーバーの表示順(上位が先)
    people: tuple[Person, ...]     # 名前順

    def members_of(self, role_id: int) -> list[Person]:
        return [p for p in self.people if role_id in p.role_ids]

    def roles_of(self, person: Person) -> list[RoleInfo]:
        return [r for r in self.roles if r.id in person.role_ids]

    def without_role(self) -> list[Person]:
        return [p for p in self.people if not self.roles_of(p)]

    def person(self, user_id: int) -> Person | None:
        return next((p for p in self.people if p.id == user_id), None)


def _display_name(member: dict) -> str:
    user = member.get("user") or {}
    return member.get("nick") or user.get("global_name") or user.get("username") or str(user.get("id", "?"))


def build_roster(guild_id: int, guild_name: str, roles: list[dict], members: list[dict]) -> Roster:
    kept = [RoleInfo(int(r["id"]), str(r["name"]), int(r.get("position", 0))) for r in roles
            if int(r["id"]) != guild_id and not r.get("managed")]   # @everyone の ID はサーバーの ID と同じ
    people = [Person(int(m["user"]["id"]), _display_name(m), frozenset(int(i) for i in m.get("roles", [])))
              for m in members if not m["user"].get("bot")]
    return Roster(guild_name, tuple(sorted(kept, key=lambda r: -r.position)),
                  tuple(sorted(people, key=lambda p: p.name)))


def _names(people: list[Person]) -> str:
    return "、".join(p.name for p in people) or "(なし)"


def _role_names(roles: list[RoleInfo]) -> str:
    return "、".join(r.name for r in roles) or "(なし)"


def _jst(now: datetime) -> str:
    return now.astimezone(_JST).strftime("%Y-%m-%d %H:%M")


def render_markdown(rosters: list[Roster], now: datetime, interval_min: int) -> str:
    """/ask が読むミラーの discord/roles_current.md の中身。"""
    out = ["# Discord のロール付与状況",
           f"- 生成: {_jst(now)} JST(約{interval_min}分ごとに更新)",
           "- Discord のサーバーのいまの設定の写し。Bot のアカウントと、連携で自動で付くロールは除く",
           "- ロールは Discord 上の設定で、部長・課長などの役職や正式な名簿そのものではない"]
    for roster in rosters:
        out += ["", f"## {roster.guild_name}", "", f"委員 {len(roster.people)} 人", "", "### ロール別"]
        for role in roster.roles:
            members = roster.members_of(role.id)
            out.append(f"- {role.name}({len(members)}人): {_names(members)}")
        out += ["", "### 人別"]
        out += [f"- {p.name}: {_role_names(roster.roles_of(p))}" for p in roster.people]
        out += ["", "### ロールが付いていない人", _names(roster.without_role())]
    return "\n".join(out) + "\n"


def _fit(text: str) -> str:
    return text if len(text) <= EMBED_LIMIT else text[:EMBED_LIMIT] + "\n…(長いので省略)"


def summary_text(roster: Roster) -> str:
    """/roles を指定なしで呼んだときの一覧。"""
    lines = [f"**{r.name}**: {len(roster.members_of(r.id))}人" for r in roster.roles]
    lines += ["", f"委員 {len(roster.people)} 人 ・ ロールが付いていない人: {_names(roster.without_role())}"]
    return _fit("\n".join(lines))


def role_text(roster: Roster, role_id: int) -> str:
    role = next((r for r in roster.roles if r.id == role_id), None)
    if role is None:
        return "このロールは一覧の対象外です(Bot の連携ロールか @everyone)。"
    members = roster.members_of(role_id)
    return _fit(f"**{role.name}**({len(members)}人)\n{_names(members)}")


def person_text(roster: Roster, user_id: int) -> str:
    person = roster.person(user_id)
    if person is None:
        return "この人は一覧の対象外です(Bot のアカウント)。"
    return _fit(f"**{person.name}**\n{_role_names(roster.roles_of(person))}")
