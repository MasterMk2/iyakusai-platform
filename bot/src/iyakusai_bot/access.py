# -*- coding: utf-8 -*-
"""Bot の操作の種類ごとの権限(2026-11-03)。純ロジック・Discord に依存しない。

操作の種類（kind）を 4 つに分け、Discord のロール名で許す表を設定 1 か所（[permissions.roles]）に持つ。

  read   読む          資料や自分の記録を読んで返す（/ask・一覧・使用量）
  write  書く          Bot が保存する台帳を変える（リマインド・タスク・候補の承認・俳句の除外）
  send   投稿・配布・起草 委員全体の Discord に出す・配る成果物を作る（/doc・/mail・/image・ネタ動画・アプリからの起草）
  admin  管理          Bot の設定や全体の掘り起こしに関わる（口調の恒久設定・過去ログの掘り起こし）

判定の規則:
- 表に kind が無い（設定が無い既定を含む）→ 全員が使える。今の Bot と同じ動き。
- 表の値がロール名の一覧 → そのロールの人と admin_roles の人だけ。
- 値が [] → admin_roles の人だけ。値に "*" がある → 全員。
- 表に無い命令（COMMAND_KINDS に無い名前）→ 表の内容に関係なく admin_roles の人だけ。
  綴りの誤りや後から足した命令で、全員に開いてしまうのを防ぐため。
- 不明なロール名（サーバーに無い名前）は一致しない。黙って全員にはしない（missing_roles で起動時に知らせる）。
- admin_roles（既存の [permissions] admin_roles）は、表で絞ったどの kind も通る。

ロールの確かめは Discord のロール名で行う。ロール名は「ロールの管理」権限を持つ人が変えられるため、
表の名前は変えたら設定も直す（設計書 bot/docs/permissions-design.md §4）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping

KINDS = ("read", "write", "send", "admin")
KIND_LABELS = {"read": "読む", "write": "書く", "send": "投稿・配布・起草", "admin": "管理"}
EVERYONE = "*"
DEFAULT_KIND = "admin"

# 命令の名前 → kind。名前は監査ログの cmd にそのまま入る（ここに無い名前は監査にも書けない）。
COMMAND_KINDS: dict[str, str] = {
    # 読む
    "ask": "read",
    "usage": "read",
    "remind.list": "read",
    "haiku.check": "read",
    "haiku.list": "read",
    "haiku.ranking": "read",
    "persona.show": "read",
    "todo.list": "read",
    "todo.show": "read",
    "todo.history": "read",
    "assistant.ask": "read",
    # 書く
    "remind.add": "write",
    "remind.done": "write",
    "remind.delete": "write",
    "haiku.optout": "write",
    "haiku.optin": "write",
    "todo.create": "write",
    "todo.tag": "write",
    "todo.assign": "write",
    "todo.helper": "write",
    "todo.deadline": "write",
    "todo.status": "write",
    "todo.reopen": "write",
    "todo.require": "write",
    "todo.weekly_assign": "write",   # 週1回のタスク一覧の「引き受ける」ボタン（weekly_cog）
    "screening.ok": "write",
    "screening.ng": "write",
    "screening.undo": "write",
    "screening.return": "write",
    "neta_video.cancel": "write",
    "assistant.remind": "write",
    "assistant.screening": "write",
    # 投稿・配布・起草（委員全体へ出す・配る文書を作る）
    "doc": "send",
    "mail": "send",
    "image": "send",
    "neta_video": "send",
    "assistant.doc": "send",
    "assistant.image": "send",
    # 管理
    "persona.set": "admin",
    "persona.off": "admin",
    "haiku.scan": "admin",
}

# 統合アプリの依頼（ジョブ）の種類 → 命令の名前。Discord のコマンドを経由しないので、ここで判定する。
WEB_JOB_KEYS = {
    "ask": "assistant.ask",
    "doc": "assistant.doc",
    "image": "assistant.image",
    "remind": "assistant.remind",
    "screening": "assistant.screening",
}

# admin_roles は既存の設定（config の admin_role_names）。この モジュールは読まないが、同じ節にあるので通す。
_TOP_KEYS = frozenset({"roles", "audit", "audit_dir", "admin_roles"})


class AccessConfigError(ValueError):
    """[permissions] の設定の誤り。起動を止める（綴りの誤りで黙って開けないため）。"""


def kind_of(command: str) -> str:
    """命令の kind。表に無ければ DEFAULT_KIND（最も厳しい側）。"""
    return COMMAND_KINDS.get(command, DEFAULT_KIND)


def _role_list(value, where: str) -> tuple[str, ...]:
    """ロール名の一覧（文字列の配列）を読む。文字列を 1 文字ずつ割る誤りを、起動時に止める。"""
    if (isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple))
            or not all(isinstance(n, str) and n.strip() for n in value)):
        raise AccessConfigError(f"{where}: ロール名の一覧（文字列の配列）で指定してください")
    return tuple(dict.fromkeys(n.strip() for n in value))


@dataclass(frozen=True)
class AccessSettings:
    """[permissions] の設定。何も書かなければ全部許可・監査ログのみ（今と同じ動き）。"""

    roles: Mapping[str, tuple[str, ...]] = field(default_factory=dict)   # 表に無い kind = 全員
    admin_roles: tuple[str, ...] = ()
    audit: bool = True
    audit_dir: Path | None = None   # None なら監査ログを書かない

    @classmethod
    def from_mapping(cls, raw, *, admin_roles: Iterable[str] = (), shared_roots: Iterable[Path | None] = (),
                     default_audit_dir: Path | None = None) -> "AccessSettings":
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise AccessConfigError("permissions: [permissions] の形式が正しくありません")
        unknown = set(raw) - _TOP_KEYS
        if unknown:
            raise AccessConfigError("permissions: 未知の設定項目があります（" + "、".join(sorted(unknown)) + "）")

        table = raw.get("roles", {})
        if not isinstance(table, dict):
            raise AccessConfigError("permissions.roles: 操作の種類ごとの表で指定してください")
        roles: dict[str, tuple[str, ...]] = {}
        for kind, names in table.items():
            if kind not in KINDS:
                raise AccessConfigError(
                    "permissions.roles: 操作の種類は " + " / ".join(KINDS) + " のいずれかです（現在: " + str(kind) + "）")
            roles[kind] = _role_list(names, f"permissions.roles.{kind}")

        audit = raw.get("audit", True)
        if type(audit) is not bool:
            raise AccessConfigError("permissions: audit は true / false で指定してください")

        if "audit_dir" in raw:
            value = raw["audit_dir"]
            if not isinstance(value, str) or not value.strip():
                raise AccessConfigError("permissions: audit_dir は文字列で指定してください")
            audit_path = Path(value).expanduser()
            if not audit_path.is_absolute():
                raise AccessConfigError("permissions: audit_dir は絶対パスで指定してください")
        else:
            audit_path = default_audit_dir
        if audit and audit_path is not None:
            for root in shared_roots:
                if root is not None:
                    _reject_overlap(audit_path, root)
        return cls(roles=roles, admin_roles=_role_list(admin_roles, "permissions.admin_roles"), audit=audit,
                   audit_dir=audit_path if audit else None)

    def required(self, kind: str) -> tuple[str, ...] | None:
        """kind の許可ロール。None は全員（表に無い）。"""
        return self.roles.get(kind)


@dataclass(frozen=True)
class Decision:
    allowed: bool
    command: str
    kind: str
    matched: str   # everyone / role / admin / denied


def decide(settings: AccessSettings, command: str, role_names: Iterable[str] = ()) -> Decision:
    """命令を実行してよいかを返す。role_names はその人が持つロール名（@everyone を除く）。"""
    names = {str(n) for n in role_names}
    if command not in COMMAND_KINDS:
        # 表に無い命令は、表の内容に関係なく admin_roles の人だけ（既定の設定でも閉じる）
        if names & set(settings.admin_roles):
            return Decision(True, command, DEFAULT_KIND, "admin")
        return Decision(False, command, DEFAULT_KIND, "denied")
    kind = kind_of(command)
    allowed_roles = settings.required(kind)
    if allowed_roles is None or EVERYONE in allowed_roles:
        return Decision(True, command, kind, "everyone")
    if names & set(settings.admin_roles):
        return Decision(True, command, kind, "admin")
    if names & set(allowed_roles):
        return Decision(True, command, kind, "role")
    return Decision(False, command, kind, "denied")


def missing_roles(settings: AccessSettings, guild_role_names: Iterable[str]) -> list[str]:
    """表・admin_roles にあるが、サーバーに無いロール名（綴りの誤りの確認用・起動時に警告する）。"""
    if not settings.roles:
        return []   # 表を書いていなければ、ロール名は使われていないので警告しない（既定の動き）
    present = set(guild_role_names)
    wanted: set[str] = set(settings.admin_roles)
    for names in settings.roles.values():
        wanted.update(n for n in names if n != EVERYONE)
    return sorted(wanted - present)


def _reject_overlap(path: Path, root: Path) -> None:
    target = Path(path).resolve()
    base = Path(root).resolve()
    if target == base or target.is_relative_to(base) or base.is_relative_to(target):
        raise AccessConfigError("permissions: audit_dir は共有データ・検索対象の外に置いてください")
