# -*- coding: utf-8 -*-
"""F5: 偶然の俳句(川柳)検出 — Discord Cog。判定ロジックは haiku_logic.py。

委員の発言がたまたま 5-7-5 になっていたら反応する。AI 呼び出しは一切しない
(純ロジック=0円・数ミリ秒)。出し方は `[haiku] mode` で選ぶ:

    react  … 元の発言に 🎋 リアクションを付けるだけ【既定】
    reply  … その場(元チャンネル)にテキストで返信する
    digest … 専用チャンネルに転記する(元スレッドを汚さない)
    both   … 両方

■ なぜ react が既定か(2026-07-27)
  reply は silent=True でも「新着メッセージ」としてチャンネルに積まれるため、会話の
  流れを毎回分断する。通知が多すぎるという指摘を受けて、
  既定を「リアクションを付けるだけ」にした。詠まれた句そのものは
  `/haiku list` / `/haiku ranking`(どちらも本人にだけ見える)で後から読める。

■ 安全側の既定(要件定義 §3 の機微ガードに合わせる)
  - 機微チャンネル(blocklist)は対象外。既定は knowledge の blocklist / raw_blocklist を流用。
  - **@everyone が読めるチャンネルと公開スレッドだけ**を対象にする(限定公開CHの発言を
    全員が見えるチャンネルへ転記したり、共有ドライブの haiku.json に残したりするのを
    構造的に防ぐ)。react/reply でも同じ(2026-10-09: 記録は共有保存先に残るため)。
    private thread は親CHが公開でも対象外。`public_only = false` で解除可。
  - `/haiku list` / `ranking` は、使った本人が**今**その発言元CHを読める句だけを返す。
    発言元は新規記録の guild_id/channel_id、旧記録は jump_url から解決し、解決できない・
    別サーバー・キャッシュに無いCH・private thread で参加を確認できないものは出さない。
    `/haiku scan` も本人が読めるCHの raw だけを走査する。
  - 個人は `/haiku optout` でいつでも対象外にできる(既存分の削除も同時に行う)。
  - 転記は 1 日 `daily_limit` 件まで。同じ句は二度出さない。
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

from . import haiku_logic as hl
from .remind_logic import now_jst
from .storage import read_json, write_json

log = logging.getLogger("iyakusai.haiku")

EMBED_COLOR = 0x7BA05B
REACT_EMOJI = "🎋"      # react モードで元の発言に付ける絵文字(この機能の目印として全体で統一)
NO_MENTIONS = discord.AllowedMentions.none()
PUBLIC_THREAD_TYPES = (discord.ChannelType.public_thread, discord.ChannelType.news_thread)
JUMP_URL_RE = re.compile(
    r"https://(?:(?:ptb|canary)\.)?discord(?:app)?\.com/channels/([0-9]+)/([0-9]+)/([0-9]+)")


def _snowflake(v) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if v > 0 else None
    if isinstance(v, str) and re.fullmatch(r"[0-9]{1,20}", v):
        return int(v) or None
    return None


def item_origin(item: dict) -> tuple[int, int] | None:
    """記録の発言元 (guild_id, channel_id)。新規記録は明示のID、旧記録は jump_url から引く。
    欠損・不正・ID と jump_url の食い違いは None(=誰にも見せない)。"""
    url = item.get("jump_url")
    m = JUMP_URL_RE.fullmatch(url) if isinstance(url, str) else None
    if url is not None and m is None:
        return None
    if m and "message_id" in item and _snowflake(item["message_id"]) != int(m[3]):
        return None
    from_url = (int(m[1]), int(m[2])) if m else None
    if "guild_id" in item or "channel_id" in item:
        g, c = _snowflake(item.get("guild_id")), _snowflake(item.get("channel_id"))
        if g is None or c is None or (from_url is not None and from_url != (g, c)):
            return None
        return g, c
    return from_url


def member_can_read(member, ch) -> bool:
    """member が今 ch を読めるか。キャッシュだけで判定し、確認できなければ False。
    スレッドは親CHの権限に加え、private thread は参加(キャッシュ上のメンバー)も要る。"""
    if ch is None:
        return False
    try:
        if isinstance(ch, discord.Thread):
            parent = ch.parent
            if parent is None or not parent.permissions_for(member).read_messages:
                return False
            if ch.type in PUBLIC_THREAD_TYPES:
                return True
            # private thread: キャッシュ上の参加者だけで判定(fetch はしない)
            return (ch.type == discord.ChannelType.private_thread
                    and any(tm.id == member.id for tm in ch.members))
        if getattr(ch, "parent", None) is not None:
            return False                              # スレッド以外で親を持つ=想定外
        return bool(ch.permissions_for(member).read_messages)
    except Exception:
        return False


def visible_items(items: list[dict], guild, member) -> list[dict]:
    """操作した Member が今その発言元CHを読める句だけ(読み取り時の絞り込み。保存データは変えない)。"""
    if guild is None or not isinstance(member, discord.Member) or member.guild.id != guild.id:
        return []
    out = []
    for i in items:
        o = item_origin(i)
        if o is None or o[0] != guild.id:
            continue
        if member_can_read(member, guild.get_channel_or_thread(o[1])):
            out.append(i)
    return out


def readable_channel_ids(guild, member) -> set[int]:
    """scan 用: member が今読めるCH・キャッシュ済みスレッドのID(アーカイブ済み等は入らない)。"""
    if guild is None or not isinstance(member, discord.Member) or member.guild.id != guild.id:
        return set()
    return {c.id for c in [*guild.channels, *guild.threads] if member_can_read(member, c)}


class HaikuStore:
    """haiku.json: {"seq": 最終ID, "items": [句...], "optout": [user_id...]}"""

    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "haiku.json"

    def _load(self) -> dict:
        return read_json(self.path, {"seq": 0, "items": [], "optout": []})

    def all(self) -> list[dict]:
        return self._load()["items"]

    def add(self, item: dict) -> dict:
        data = self._load()
        data["seq"] += 1
        item["id"] = data["seq"]
        data["items"].append(item)
        write_json(self.path, data)
        return item

    def seen(self, text: str) -> bool:
        return any(i["text"] == text for i in self.all())

    def count_on(self, day: str) -> int:
        return sum(1 for i in self.all() if i.get("ts", "").startswith(day))

    def optout(self) -> list[int]:
        return self._load()["optout"]

    def set_optout(self, user_id: int, on: bool) -> int:
        """オプトアウトの登録/解除。登録時は既存の句も削除する。戻り値=削除件数。"""
        data = self._load()
        ids = set(data["optout"])
        removed = 0
        if on:
            ids.add(user_id)
            before = len(data["items"])
            data["items"] = [i for i in data["items"] if i.get("author_id") != user_id]
            removed = before - len(data["items"])
        else:
            ids.discard(user_id)
        data["optout"] = sorted(ids)
        write_json(self.path, data)
        return removed


def _note(h: hl.Haiku) -> str:
    return f"{h.score}点{'・' + h.label if h.label else ''}"


def build_embed(h: hl.Haiku, author: str, channel: str, jump_url: str | None) -> discord.Embed:
    """digest モード用(専用チャンネルへの転記)。誰のどの発言かが分かる形にする。"""
    e = discord.Embed(title="🎋 偶然の一句", description=f"**{h.formatted}**", color=EMBED_COLOR)
    where = f"[#{channel}]({jump_url})" if jump_url else f"#{channel}"
    e.add_field(name="詠み人", value=f"{author} — {where}", inline=False)
    e.set_footer(text=f"{_note(h)} ｜ 自動検出(5-7-5)")
    return e


def build_reply(h: hl.Haiku) -> str:
    """reply モード用(その場に返す)。会話を邪魔しないよう2行に収める。

    読み(フリガナ)と optout の案内は出さない(2026-07-22 ユーザー指示)。
    読みは `/haiku check`(自分にだけ見える)で確認でき、optout は /help に載っている。
    """
    return f"🎋 **{h.formatted}**\n-# {_note(h)}"


class Haiku(commands.Cog):
    haiku = app_commands.Group(name="haiku", description="偶然の俳句(川柳)")

    def __init__(self, bot: commands.Bot, store: HaikuStore, cfg):
        self.bot = bot
        self.store = store
        self.cfg = cfg
        self.analyzer = hl.Analyzer()
        self.blocklist = [b for b in (cfg.haiku_blocklist or []) if b]
        self.names: dict[str, dict[str, str]] = {"by_id": {}, "by_name": {}}

    async def cog_load(self):
        # 実名(サーバーニックネーム)の対応表。単一ソース = discord/raw/_authors.json
        if self.cfg.knowledge_dir:
            from .knowledge_search import load_author_aliases
            self.names = await asyncio.to_thread(load_author_aliases, self.cfg.knowledge_dir)
            log.info("俳句: 実名の対応表 %d件(id) / %d件(名前)",
                     len(self.names["by_id"]), len(self.names["by_name"]))
        # 辞書ロードは 1〜2 秒かかる。起動時にイベントループを止めないよう別スレッドで温める
        ok = await asyncio.to_thread(lambda: self.analyzer.available)
        log.info("俳句検出: %s(mode=%s, 転記先=%s, 閾値=%d点, 破調=%s)",
                 "有効" if ok else "無効(SudachiPy/辞書なし)", self.cfg.haiku_mode,
                 self.cfg.haiku_channel_id or "未設定", self.cfg.haiku_min_score,
                 "拾う" if self.cfg.haiku_allow_hachou else "定型のみ")
        if self.cfg.haiku_mode in ("digest", "both") and not self.cfg.haiku_channel_id:
            log.warning("haiku.mode=%s だが channel_id が未設定です(転記されません)",
                        self.cfg.haiku_mode)

    # ---------- 対象の判定 ----------

    def _real_name(self, user: discord.abc.User) -> str:
        """委員会での表示名(実名)。_authors.json を id → 名前の順で引き、
        載っていなければサーバーのニックネーム(display_name)にフォールバックする。"""
        return (self.names["by_id"].get(str(user.id))
                or self.names["by_name"].get(user.display_name)
                or self.names["by_name"].get(user.name)
                or user.display_name)

    def _target_channel(self) -> discord.abc.Messageable | None:
        cid = self.cfg.haiku_channel_id
        return self.bot.get_channel(int(cid)) if cid else None

    def _channel_ok(self, message: discord.Message) -> bool:
        """機微チャンネルを除外し、public_only なら公開CH・公開スレッドだけに限る(全モード)。"""
        ch = message.channel
        parent = getattr(ch, "parent", None)          # スレッドは親CHの名前・権限で判断する
        names = [getattr(ch, "name", "") or "", getattr(parent, "name", "") or ""]
        if any(b in n for n in names for b in self.blocklist):
            return False
        if self.cfg.haiku_channel_id and ch.id == int(self.cfg.haiku_channel_id):
            return False                              # 転記先そのものは対象外(自己言及の防止)
        # 公開CH限定は react/reply でも適用する。その場に付けるだけでも、句の本文は共有ドライブの
        # haiku.json に残り /haiku list で読めるため(2026-10-09)。
        if not self.cfg.haiku_public_only:
            return True
        try:
            everyone = message.guild.default_role
            if isinstance(ch, discord.Thread):
                # private thread は親CHが公開でも対象外
                return (ch.type in PUBLIC_THREAD_TYPES and parent is not None
                        and bool(parent.permissions_for(everyone).read_messages))
            if parent is not None:
                return False                          # スレッド以外で親を持つ=想定外
            return bool(ch.permissions_for(everyone).read_messages)
        except Exception:
            return False                              # 判定できないものは安全側で対象外

    # ---------- 検出 ----------

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if (message.author.bot or message.guild is None
                or not self.cfg.haiku_enabled or not self.analyzer.available):
            return
        mode = self.cfg.haiku_mode
        dest = self._target_channel() if mode in ("digest", "both") else None
        if mode in ("digest", "both") and dest is None:
            return                                    # 転記先が解決できない = 出しようがない
        if not self._channel_ok(message):
            return
        # store.* は haiku.json(共有ドライブ)を毎回まるごと読む同期I/O。on_message は
        # **メッセージ1件ごとに**通るので、素で呼ぶとドライブが詰まった瞬間にイベントループ
        # ごと止まり、チャンネル全体の受信処理とゲートウェイのハートビートまで巻き込む。
        # cog_load の辞書ロードや /haiku check・/haiku scan と同じく別スレッドへ逃がす
        # (2026-08-12: レビュー#17。この4箇所だけ to_thread 化が漏れていた)。
        if message.author.id in await asyncio.to_thread(self.store.optout):
            return
        today = now_jst().date().isoformat()
        if await asyncio.to_thread(self.store.count_on, today) >= self.cfg.haiku_daily_limit:
            return
        try:
            h = hl.detect(message.content, self.analyzer, self.cfg.haiku_min_score,
                          self.cfg.haiku_allow_hachou)
        except Exception:                             # 解析の失敗で受信処理を壊さない
            log.exception("俳句判定に失敗")
            return
        if h is None or await asyncio.to_thread(self.store.seen, h.text):
            return
        item = {
            "text": h.text, "ku": list(h.ku), "reading": list(h.reading_ku), "score": h.score,
            "pattern": h.pattern,
            "author": self._real_name(message.author), "author_id": message.author.id,
            "channel": getattr(message.channel, "name", "?"),
            # 発言元。/haiku list・ranking の閲覧権限の絞り込みに使う(2026-10-09〜)
            "guild_id": getattr(message.guild, "id", None), "channel_id": message.channel.id,
            "message_id": message.id, "jump_url": message.jump_url,
            "ts": now_jst().isoformat(),
        }
        sent = False
        if mode == "react":
            try:
                # 元の発言に 🎋 を付けるだけ。新着メッセージが増えないので通知は一切鳴らず、
                # 会話の流れも切れない(2026-07-27 の復活方針)。句の中身は /haiku list で読める。
                # ※ reply(SEND_MESSAGES)とは別の ADD_REACTIONS 権限が要る点に注意。
                await message.add_reaction(REACT_EMOJI)
                sent = True
            except discord.HTTPException:
                log.warning("俳句のリアクション付与に失敗(権限/元メッセージ削除済み)")
        if mode in ("reply", "both"):
            try:
                # silent=True: その場に返信はするが通知(プッシュ/音/赤バッジ)は鳴らさない
                # (Discord の SUPPRESS_NOTIFICATIONS フラグ = @silent)。俳句は「気づいたら
                # 詠まれてる」程度でよく、毎回通知が鳴るとうるさいという指摘への対応。
                await message.reply(build_reply(h), mention_author=False,
                                    allowed_mentions=discord.AllowedMentions.none(),
                                    silent=True)
                sent = True
            except discord.HTTPException:
                log.warning("俳句の返信に失敗(権限/元メッセージ削除済み)")
        if dest is not None:
            try:
                await dest.send(
                    embed=build_embed(h, item["author"], item["channel"], item["jump_url"]),
                    allowed_mentions=discord.AllowedMentions.none(),
                    silent=True,   # 転記も通知は鳴らさない(reply と同じ方針)
                )
                sent = True
            except discord.HTTPException:
                log.warning("俳句の転記に失敗(権限/チャンネル): %s", self.cfg.haiku_channel_id)
        if not sent:
            return                                    # どこにも出せていないなら記録もしない
        await asyncio.to_thread(self.store.add, item)   # 書き込みも同期I/O(上と同じ理由)
        log.info("俳句検出: %s(%s・%d点・%s)", h.formatted, item["author"], h.score, h.pattern)

    # ---------- スラッシュコマンド ----------

    @haiku.command(name="check", description="この文が5-7-5になっているか判定する(自分にだけ見える)")
    @app_commands.describe(文="判定したい文")
    async def check(self, itx: discord.Interaction, 文: str):
        if not self.analyzer.available:
            await itx.response.send_message(
                "⚠️ 解析辞書が入っていないため俳句判定は無効です"
                "(`pip install sudachipy sudachidict-small`)。", ephemeral=True)
            return
        h = await asyncio.to_thread(hl.detect, 文, self.analyzer, 0,
                                    self.cfg.haiku_allow_hachou)
        if h is None:
            await itx.response.send_message(
                f"5-7-5 ではありません: 「{文}」\n"
                "-# 数字・英字を含む文、語の途中で切れる区切りは対象外です", ephemeral=True)
            return
        await itx.response.send_message(
            f"**{h.formatted}**\n*{h.reading}*\n-# {h.score}点"
            f"{'・' + h.label if h.label else ''}"
            f"{'(閾値未満なので自動では出ません)' if h.score < self.cfg.haiku_min_score else ''}",
            ephemeral=True)

    async def _visible(self, itx: discord.Interaction) -> list[dict]:
        """haiku.json(共有ドライブ)は別スレッドで読み、本人が今読める発言元の句だけ返す。"""
        items = await asyncio.to_thread(self.store.all)
        return visible_items(items, itx.guild, itx.user)

    @haiku.command(name="list", description="最近検出された句を表示する")
    @app_commands.describe(件数="表示する件数(既定10)")
    async def list_(self, itx: discord.Interaction, 件数: int = 10):
        await itx.response.defer(ephemeral=True)
        items = (await self._visible(itx))[-max(1, min(件数, 25)):][::-1]
        if not items:
            await itx.followup.send("あなたが読めるチャンネルの句はまだありません。",
                                    ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        lines = [f"`{i['score']:3d}点` **{'　'.join(i['ku'])}** — {i['author']}"
                 f"({i['ts'][:10]})" for i in items]
        await itx.followup.send("\n".join(lines), ephemeral=True, allowed_mentions=NO_MENTIONS)

    @haiku.command(name="ranking", description="詠み人ランキング(検出数)")
    async def ranking(self, itx: discord.Interaction):
        await itx.response.defer(ephemeral=True)
        items = await self._visible(itx)
        if not items:
            await itx.followup.send("あなたが読めるチャンネルの句はまだありません。",
                                    ephemeral=True, allowed_mentions=NO_MENTIONS)
            return
        c = Counter(i["author"] for i in items)
        best = max(items, key=lambda i: i["score"])
        lines = [f"{n}. {a} — {v}句" for n, (a, v) in enumerate(c.most_common(10), 1)]
        await itx.followup.send(
            "**🎋 詠み人ランキング**\n" + "\n".join(lines)
            + f"\n\n**最高得点** `{best['score']}点` {'　'.join(best['ku'])} — {best['author']}",
            ephemeral=True, allowed_mentions=NO_MENTIONS)

    @haiku.command(name="scan", description="過去ログから俳句を発掘する(役員・システム課)")
    @app_commands.describe(件数="表示する件数(既定10)", 点数="この点以上のみ(既定は転記と同じ)")
    async def scan(self, itx: discord.Interaction, 件数: int = 10, 点数: int | None = None):
        if not (isinstance(itx.user, discord.Member) and itx.user.guild_permissions.manage_guild):
            await itx.response.send_message("⚠️ このコマンドは役員・システム課だけが使えます。",
                                            ephemeral=True)
            return
        raw = (self.cfg.knowledge_dir / "discord" / "raw") if self.cfg.knowledge_dir else None
        if not self.analyzer.available or raw is None or not raw.exists():
            await itx.response.send_message("⚠️ 過去ログ(discord/raw)か解析辞書がありません。",
                                            ephemeral=True)
            return
        await itx.response.defer(ephemeral=True, thinking=True)
        # 権限者でも、今その人が読めるCHの raw だけを掘る(ファイル名末尾のCH IDで絞る)
        allowed = readable_channel_ids(itx.guild, itx.user)
        rows = await asyncio.to_thread(
            hl.scan_raw, raw, self.analyzer,
            点数 if 点数 is not None else self.cfg.haiku_min_score, self.blocklist,
            self.cfg.haiku_allow_hachou, self.names, allowed)
        if not rows:
            await itx.followup.send("過去ログに俳句は見つかりませんでした。", ephemeral=True,
                                    allowed_mentions=NO_MENTIONS)
            return
        lines = [f"`{s:3d}点` **{t}** — {a}({d})"
                 for s, a, d, t in rows[:max(1, min(件数, 25))]]
        await itx.followup.send(f"**過去ログから {len(rows)} 句**\n" + "\n".join(lines),
                                ephemeral=True, allowed_mentions=NO_MENTIONS)

    @haiku.command(name="optout", description="自分の発言を俳句検出の対象外にする")
    async def optout(self, itx: discord.Interaction):
        await itx.response.defer(ephemeral=True)
        removed = await asyncio.to_thread(self.store.set_optout, itx.user.id, True)
        await itx.followup.send(
            f"🚫 今後あなたの発言は検出しません(既存の {removed} 句も削除しました)。\n"
            "-# 戻すときは `/haiku optin`", ephemeral=True, allowed_mentions=NO_MENTIONS)

    @haiku.command(name="optin", description="俳句検出の対象に戻す")
    async def optin(self, itx: discord.Interaction):
        await itx.response.defer(ephemeral=True)
        await asyncio.to_thread(self.store.set_optout, itx.user.id, False)
        await itx.followup.send("✅ 検出の対象に戻しました。", ephemeral=True,
                                allowed_mentions=NO_MENTIONS)
