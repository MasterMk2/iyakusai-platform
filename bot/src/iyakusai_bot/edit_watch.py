# -*- coding: utf-8 -*-
r"""F8: メッセージの編集・削除を Gateway イベントでリアルタイムに記録する。

## なぜ要るか

`collect_discord_v2.py` は**差分取得**(取得済みは再取得しない)なので、
**収集後に編集・削除されても raw は古いまま**。収集側で後から再走査して
突き合わせれば大半は拾えるが、**再走査では原理的に埋まらない穴が2つある**:

1. **収集(30分tick)と再走査の両方の隙間で「投稿 → 削除」**されると、
   **メッセージの存在自体がどこにも残らない**(API で取り直しても既に無い)。
2. **短時間に複数回編集**されると、再走査時点の最終版しか取れず**中間版が失われる**。

Gateway なら**編集・削除が起きた瞬間**にイベントが来るので、この2つを埋められる。
とくに `payload.cached_message` には**変更前の版**が入っている——
**Discord の REST API は旧版を返さないので、旧版を取れる経路はここだけ**。

## 何をするか

`raw/_edits.jsonl` に追記するだけ(収集側の再走査と同じファイル・同じ形)。
**raw 本体は書き換えない。** 理由: 収集サブプロセスと同じファイルを同時に書くと壊れるため。
raw への反映は収集側の再走査が担当する(役割分担を分けておく)。

`source` フィールドで出どころを区別する: `"gateway"`(本モジュール) / 無印(収集側の再走査)。

## 限界(承知して使う)

- **Bot が止まっている間のイベントは永久に失われる**(通算3回の無言停止あり)。
  → **Gateway=主 / 再走査=保険**の二段で持つこと。片方だけでは不十分。
- `cached_message` は**Bot 起動後にキャッシュされたメッセージにしか無い**。
  起動前の古いメッセージが編集されると**旧版は取れない**(その旨を `before_unavailable` で明示する)。
"""

from __future__ import annotations

import datetime
import json
import logging
from pathlib import Path

import discord
from discord.ext import commands

log = logging.getLogger("iyakusai.editwatch")


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _msg_to_dict(m: discord.Message | None) -> dict | None:
    """discord.Message を raw/_edits.jsonl と同じ形に落とす(collect_discord_v2.simplify 相当)。"""
    if m is None:
        return None
    return {
        "id": str(m.id),
        "ts": m.created_at.isoformat(),
        "author": (m.author.global_name or m.author.name) if m.author else "?",
        "author_id": str(m.author.id) if m.author else None,
        "bot": bool(m.author.bot) if m.author else False,
        "content": m.content or "",
        "attachments": [a.filename for a in m.attachments],
        "reply_to": (str(m.reference.message_id)
                     if m.reference and m.reference.message_id else None),
        "edited": m.edited_at is not None,
        "edited_ts": m.edited_at.isoformat() if m.edited_at else None,
        "reactions": [{"name": str(r.emoji), "count": r.count} for r in m.reactions],
    }


def _strike_delta(before: str, after: str) -> str | None:
    """取り消し線(~~)の増減。このドライブでは `~~` = 完了・送信済みの記法。

    4文字しか変わらず「意味」も変わらないため、LLM に判断させると書式変更として
    捨てられる。機械的にフラグ化しておく(`AI作業方針.md` §3-4)。
    """
    nb, na = before.count("~~"), after.count("~~")
    if na > nb:
        return "added"
    if na < nb:
        return "removed"
    return None


class EditWatch(commands.Cog):
    """編集・削除を Gateway で拾って `_edits.jsonl` に追記する。"""

    def __init__(self, bot: commands.Bot, edits_file: Path):
        self.bot = bot
        self.edits_file = Path(edits_file)

    # ---- 追記 ---------------------------------------------------------
    def _append(self, rec: dict) -> None:
        try:
            self.edits_file.parent.mkdir(parents=True, exist_ok=True)
            with self.edits_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError as e:
            # 共有ドライブが一時的に見えない等。Bot 本体は止めない。
            log.warning("編集履歴の追記に失敗: %s", e)

    def _channel_label(self, channel_id: int) -> str:
        ch = self.bot.get_channel(channel_id)
        if ch is None:
            return str(channel_id)
        parent = getattr(ch, "parent", None)
        if parent is not None:                     # スレッド
            return f"{parent.name}__スレッド_{ch.name}"
        return getattr(ch, "name", str(channel_id))

    # ---- 編集 ---------------------------------------------------------
    @commands.Cog.listener()
    async def on_raw_message_edit(self, payload: discord.RawMessageUpdateEvent):
        data = payload.data or {}
        # 埋め込み展開(リンクのプレビュー生成)でも edit イベントは飛ぶ。
        # content キーが無いものは本文の変更ではないので無視する。
        if "content" not in data:
            return
        before = _msg_to_dict(payload.cached_message)
        after_content = data.get("content") or ""
        if before is not None and (before.get("content") or "") == after_content:
            return                                  # 本文が同じなら記録しない

        rec = {
            "detected_at": _now(),
            "source": "gateway",
            "channel": self._channel_label(payload.channel_id),
            "id": str(payload.message_id),
            "kind": "changed",
            "fields": ["content"],
            "before": before,
            "after": {
                "id": str(payload.message_id),
                "content": after_content,
                "edited_ts": data.get("edited_timestamp"),
                "author": ((data.get("author") or {}).get("global_name")
                           or (data.get("author") or {}).get("username")),
            },
        }
        if before is None:
            # Bot 起動前のメッセージ等。旧版は取得不能なので、その事実を明示する
            # (推測で埋めない。`digest作成指示書.md` の方針)。
            rec["before_unavailable"] = "Bot のキャッシュに無いため旧版は取得できない"
        else:
            st = _strike_delta(before.get("content") or "", after_content)
            if st:
                rec["strike"] = st
        self._append(rec)
        log.info("編集を記録: #%s %s", rec["channel"], rec["id"])

    # ---- 削除 ---------------------------------------------------------
    @commands.Cog.listener()
    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent):
        before = _msg_to_dict(payload.cached_message)
        rec = {
            "detected_at": _now(),
            "source": "gateway",
            "channel": self._channel_label(payload.channel_id),
            "id": str(payload.message_id),
            "kind": "deleted",
            "before": before,
        }
        if before is None:
            rec["before_unavailable"] = "Bot のキャッシュに無いため本文は取得できない"
        self._append(rec)
        log.info("削除を記録: #%s %s (本文=%s)",
                 rec["channel"], rec["id"], "あり" if before else "取得不能")

    @commands.Cog.listener()
    async def on_raw_bulk_message_delete(self, payload: discord.RawBulkMessageDeleteEvent):
        for mid in payload.message_ids:
            cached = discord.utils.get(getattr(payload, "cached_messages", []) or [], id=mid)
            rec = {
                "detected_at": _now(),
                "source": "gateway",
                "channel": self._channel_label(payload.channel_id),
                "id": str(mid),
                "kind": "deleted",
                "bulk": True,
                "before": _msg_to_dict(cached),
            }
            if rec["before"] is None:
                rec["before_unavailable"] = "Bot のキャッシュに無いため本文は取得できない"
            self._append(rec)
        log.info("一括削除を記録: #%s %d件",
                 self._channel_label(payload.channel_id), len(payload.message_ids))
