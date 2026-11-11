# -*- coding: utf-8 -*-
"""Bot が自分から投稿する先を [notify] で一か所に決める(2026-11-03)。

- 設定が無ければ何も変えない。各機能の従来のチャンネル(collect.staleness_channel_id・haiku.channel_id・
  assistant.share_channel_id・reminders の登録先・タスク候補の部局の経路・weekly.channel_id)へ送る。
- 解決の順: [notify.kinds].<種類> → [notify].channel_id(既定)→ 従来の設定。
- 既定(channel_id)を使うのは、送り先が 1 つに決まっている種類だけ。リマインドは登録した本人の
  チャンネル、タスク候補は部局ごとの経路が意味を持つので、既定では動かさない(種類の上書きでだけ変える)。
- 返事(コマンドの応答・ボタンの応答)と、既存のメッセージへの返信(俳句の返信)は対象外。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# 種類 -> (説明, [notify].channel_id を既定として使うか)
NOTIFY_KINDS: dict[str, tuple[str, bool]] = {
    "weekly_tasks": ("週1回のタスク一覧", True),
    "weekly_follow_up": ("未割当タスクの追い投稿", True),
    "task_candidates": ("タスク候補の投稿(部局ごとの経路)", False),
    "reminder": ("リマインド(登録したチャンネルへの通知・確認)", False),
    "haiku_digest": ("俳句の転記(digest)", True),
    "collect_staleness": ("収集の遅れの知らせ", True),
    "app_share": ("統合アプリ発の依頼の投稿", True),
    "app_notice": ("統合アプリからの個人あての知らせ(DM で届かない人へのメンション)", True),
}


class NotifyConfigError(ValueError):
    """[notify] の形が正しくない。メッセージはそのまま起動時のエラーに出す。"""


def _snowflake(value: Any, where: str) -> int:
    if type(value) is not int or not 1 <= value < 2**63:
        raise NotifyConfigError(f"{where} は Discord の ID(整数)で指定してください")
    return value


@dataclass(frozen=True)
class NotifySettings:
    channel_id: int | None = None
    kinds: tuple[tuple[str, int], ...] = field(default_factory=tuple)

    @classmethod
    def from_mapping(cls, raw: Any) -> "NotifySettings":
        if raw is None:
            return cls()
        if not isinstance(raw, dict):
            raise NotifyConfigError("notify: [notify] の形式が正しくありません")
        unknown = set(raw) - {"channel_id", "kinds"}
        if unknown:
            raise NotifyConfigError(f"notify: 未知の項目があります: {', '.join(sorted(unknown))}")
        channel_id = None
        if raw.get("channel_id") is not None:
            channel_id = _snowflake(raw["channel_id"], "notify.channel_id")
        kinds_raw = raw.get("kinds", {})
        if not isinstance(kinds_raw, dict):
            raise NotifyConfigError("notify: [notify.kinds] は 種類 = ID の表で指定してください")
        pairs = []
        for kind, value in kinds_raw.items():
            if kind not in NOTIFY_KINDS:
                raise NotifyConfigError(f"notify: 未知の種類です: {kind}"
                                        f"(使えるもの: {', '.join(NOTIFY_KINDS)})")
            pairs.append((kind, _snowflake(value, f"notify.kinds.{kind}")))
        return cls(channel_id=channel_id, kinds=tuple(sorted(pairs)))

    def resolve(self, kind: str, legacy: int | None) -> int | None:
        """種類の送り先。上書きも既定も無ければ、従来の送り先(legacy)をそのまま返す。"""
        if kind not in NOTIFY_KINDS:
            return legacy
        for name, channel in self.kinds:
            if name == kind:
                return channel
        if self.channel_id is not None and NOTIFY_KINDS[kind][1]:
            return self.channel_id
        return legacy


def routed_channel_id(bot: Any, kind: str, legacy: int | None) -> int | None:
    """bot.cfg.notify から送り先を引く。cfg が無い・[notify] が無いときは legacy を返す。"""
    settings = getattr(getattr(bot, "cfg", None), "notify", None)
    if not isinstance(settings, NotifySettings):
        return legacy
    return settings.resolve(kind, legacy)
