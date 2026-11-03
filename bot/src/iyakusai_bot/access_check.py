# -*- coding: utf-8 -*-
"""Bot の入口で権限を確かめ、監査ログに残す(access.py の Discord 側・2026-11-03)。

- スラッシュコマンド: 関数に require("命令名") を付ける（app_commands.check）。拒否は AccessDenied。
- /todo・スクリーニングのボタン・統合アプリの依頼: 本体の中で enforce_for()・enforce() を呼ぶ（同じ判定）。
  依頼の経路は Discord の check を通らないため、ここを通さないと表の外から実行できてしまう。
- 既定の設定では全部許可し、監査ログだけ残す（今と同じ動き）。configure() で [permissions] を入れる。
- 監査: 受付（accepted）と拒否（denied）は入口で書く。書き込みのある命令の完了（ok）と失敗（failed）は、
  audited() で本体を囲んで書く。読む系の命令は、受付も完了も残さない（拒否だけ残す）。
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager

import discord
from discord import app_commands

from . import access as A
from .audit import AuditLog, is_code

log = logging.getLogger("iyakusai.access")

_settings: A.AccessSettings = A.AccessSettings()
_audit: AuditLog | None = None


class AccessDenied(app_commands.CheckFailure):
    """この操作の種類は、この人の役割では許可されていない。str(error) は利用者に見せる日本語。"""

    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(
            f"この操作（{A.KIND_LABELS.get(kind, kind)}）は、あなたの役割では許可されていません。"
            "役員に確かめてください。"
        )


def configure(settings: A.AccessSettings, audit: AuditLog | None) -> None:
    global _settings, _audit
    _settings = settings
    _audit = audit


def settings() -> A.AccessSettings:
    return _settings


def role_names_of(user) -> list[str]:
    """Discord の Member のロール名（@everyone を除く）。Member でなければ空。"""
    roles = getattr(user, "roles", None) or []
    return [r.name for r in roles if not r.is_default()]


def _record(command: str, *, actor_id: int, result: str, guild_id: int | None, channel_id: int | None,
            code: str | None = None, ref: int | None = None) -> None:
    if _audit is None:
        return
    try:
        _audit.record(cmd=command, kind=A.kind_of(command), actor=actor_id, result=result,
                      guild=guild_id, channel=channel_id, code=code, ref=ref)
    except Exception:  # noqa: BLE001  監査の失敗で操作を止めない
        log.warning("監査ログの記録に失敗(操作は続行)")


def enforce(command: str, *, actor_id: int, role_names, guild_id: int | None = None,
            channel_id: int | None = None, record_accepted: bool = True) -> A.Decision:
    """命令の実行を確かめる。拒否なら AccessDenied。拒否は監査に残す。

    受付（accepted）は読む系以外で、record_accepted が真のときだけ残す。同じ操作に入口が 2 つある
    ボタン（候補の差し戻しのように、入力の画面を先に開く）では、片方だけ False にして受付を重ねない。
    """
    decision = A.decide(_settings, command, role_names)
    if not decision.allowed:
        _record(command, actor_id=actor_id, result="denied", guild_id=guild_id, channel_id=channel_id)
        raise AccessDenied(decision.kind)
    if record_accepted and decision.kind != "read":
        _record(command, actor_id=actor_id, result="accepted", guild_id=guild_id, channel_id=channel_id)
    return decision


def log_outcome(command: str, *, actor_id: int, result: str, guild_id: int | None = None,
                channel_id: int | None = None, code: str | None = None, ref: int | None = None) -> None:
    """完了（ok）・失敗（failed）を監査に残す。書くのは result と code だけ（本文・例外の文面は書かない）。"""
    _record(command, actor_id=actor_id, result=result, guild_id=guild_id, channel_id=channel_id,
            code=code, ref=ref)


def needs_roles(command: str) -> bool:
    """この命令の判定にロールが要るか。表で絞られているとき・表に無い命令（admin_roles だけが通す）のとき要る。

    要らなければ Discord に会員を問い合わせない（既定の設定では問い合わせを増やさない）。
    """
    if command not in A.COMMAND_KINDS:
        return True
    allowed = _settings.required(A.kind_of(command))
    return allowed is not None and A.EVERYONE not in allowed


def _int_or(value, default):
    return value if type(value) is int else default


def enforce_for(command: str, itx, *, record_accepted: bool = True) -> A.Decision:
    """Interaction から依頼者・サーバー・チャンネルを読んで enforce する。属性が無くても落ちない（無ければ 0・None）。"""
    user = getattr(itx, "user", None)
    return enforce(command, actor_id=_int_or(getattr(user, "id", None), 0), role_names=role_names_of(user),
                   guild_id=_int_or(getattr(itx, "guild_id", None), None),
                   channel_id=_int_or(getattr(itx, "channel_id", None), None),
                   record_accepted=record_accepted)


def outcome_for(command: str, itx, *, result: str, code: str | None = None) -> None:
    """Interaction から依頼者・サーバー・チャンネルを読んで完了・失敗を残す（enforce_for と同じ読み方）。"""
    user = getattr(itx, "user", None)
    log_outcome(command, actor_id=_int_or(getattr(user, "id", None), 0), result=result,
                guild_id=_int_or(getattr(itx, "guild_id", None), None),
                channel_id=_int_or(getattr(itx, "channel_id", None), None), code=code)


class Outcome:
    """audited() の中で結果を決める。既定は完了（ok）。失敗の分岐に入ったら fail() を呼ぶ。"""

    def __init__(self) -> None:
        self.result = "ok"
        self.code: str | None = None

    def fail(self, code: str = "FAILED") -> None:
        """失敗として残す。code は大文字の記号（例: NOT_FOUND）。形が合わなければ FAILED にする。"""
        self.result = "failed"
        self.code = code if is_code(code) else "FAILED"


@contextmanager
def audited(command: str, itx):
    """書き込みのある命令の本体を囲み、完了（ok）か失敗（failed）を監査に残す。

    失敗の分岐に入ったら out.fail(コード) を呼ぶ。呼ばなければ完了として残る。例外はそのまま外へ出し、
    その行は failed（キャンセルは CANCELLED、それ以外は INTERNAL）。
    """
    out = Outcome()
    try:
        yield out
    except BaseException as error:
        if out.result == "failed":
            code = out.code
        elif isinstance(error, asyncio.CancelledError):
            code = "CANCELLED"
        else:
            code = "INTERNAL"
        outcome_for(command, itx, result="failed", code=code)
        raise
    outcome_for(command, itx, result=out.result, code=out.code)


def predicate_for(command: str):
    """スラッシュコマンド用の判定関数。テストでは直接呼べる形にしておく。"""

    def predicate(itx: discord.Interaction) -> bool:
        enforce_for(command, itx)
        return True

    return predicate


def require(command: str):
    """スラッシュコマンドに付ける check。判定の結果は predicate_for と同じ。"""
    return app_commands.check(predicate_for(command))
