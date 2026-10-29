# -*- coding: utf-8 -*-
"""定期タスクスクリーニングの候補を Discord に出し、起票する Cog。

- 候補台帳(screening_store)を数十秒ごとに見て、未投稿の候補を処理する。
  - 自動起票(decision=auto): Bot 名義で /todo のタスクを作り、振り分け先チャンネルにお知らせを出す。
    お知らせには「コメントして差し戻す」「誤起票として閉じる」ボタンを付ける。差し戻すとそのタスクは
    完了扱いで閉じ(説明にコメントを残す)、承認待ちと同じく AI の修正版を出し直す。
  - 承認待ち(decision=review): 振り分け先チャンネルに候補を出し、「起票する」「コメントして差し戻す」
    「不要」ボタンを付ける。差し戻しはコメント入力欄を開き、次のスクリーニング(Bot がすぐ起動を依頼する)で
    AI がコメントどおりの修正版を作って出し直す。
- ボタンを押せるのは、そのチャンネルで /todo を変更できる人(閲覧 + 発言権限)。権限の判定は
  TaskCog.authorize をそのまま使う。起票は押した人の名義で、操作 ID で二重起票を防ぐ。
- 判定(自動起票・起票・不要・差し戻し・誤起票)は台帳の decisions に追記し、スクリーニングが
  共有ドライブの判定記録.tsv に書き出す。判定のたびに followup.request に 1 行書いて、その書き出し
  (と差し戻しの修正)を systemd の path ユニット経由ですぐ起動させる。
- 投稿はメンション通知なし(AllowedMentions.none())。

/todo 自体(task_cog.py)は「公開投稿・定期処理をしない」設計のまま変えず、公開投稿はこの Cog だけが行う。
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

import discord
from discord.ext import commands, tasks

from .screening_store import CandidateRow, ScreeningStore
from .task_domain import JST, REQUIREMENT_LABELS, Actor, Scope, TaskError, format_date_only, format_tags
from .task_store import Budget, TaskSettings, TaskStore

log = logging.getLogger("iyakusai.screening")

MESSAGE_LIMIT = 1900
STORE_TIMEOUT_SEC = 10.0
COMMENT_MAX = 1000
UNDO_NOTE = "\n\n[自動起票を取り消し: 誤起票として閉じた]"
VIEW_VERSION = 3          # 投稿のボタンの版(2 = 承認待ちに差し戻し、3 = 自動起票にも差し戻し)

_LABELS = {"ok": "起票する", "rt": "コメントして差し戻す", "ng": "不要", "undo": "誤起票として閉じる"}
_STYLES = {"ok": discord.ButtonStyle.success, "rt": discord.ButtonStyle.primary,
           "ng": discord.ButtonStyle.secondary, "undo": discord.ButtonStyle.danger}


def _esc(text: str) -> str:
    return discord.utils.escape_markdown(text or "")


def _clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _jst(ts: str) -> str:
    try:
        return datetime.fromisoformat(ts).astimezone(JST).strftime("%m/%d %H:%M")
    except ValueError:
        return ts


def _sources(c: CandidateRow, limit: int = 3) -> list[str]:
    lines = []
    for s in c.source_list[:limit]:
        if s.get("kind") == "inventory":
            lines.append(f"・{_esc(s.get('source', ''))}（_目録/{_esc(s.get('link', ''))}）")
            continue
        where = s.get("link", "") if s.get("kind") == "discord" else "委員会メール"
        lines.append(f"・{_esc(s.get('source', ''))} {_jst(s.get('ts', ''))} {_esc(s.get('author', ''))} {where}")
    return lines


def _meta_line(c: CandidateRow, assignee_id: int | None) -> str:
    who = f"<@{assignee_id}>" if assignee_id else (f"{_esc(c.assignee_name)}(原文の名前)" if c.assignee_name else "未定")
    return f"部局: {format_tags(c.tag_list)}／期限: {format_date_only(c.deadline)}／担当: {who}"


def review_text(c: CandidateRow) -> str:
    head = "📝 **タスク候補・差し戻しの修正版**" if c.revision_of else "📝 **タスク候補**"
    lines = [f"{head}（定期スクリーニング・候補 {c.id}）— {c.route_label}",
             f"**{_esc(c.title)}**", _meta_line(c, c.assignee_id)]
    for key, label in REQUIREMENT_LABELS.items():
        value = c.requirements.get(key) or ""
        if value:
            lines.append(f"{label}: {_esc(_clip(value, 200))}")
    if c.revision_of:
        lines.append(f"元の候補: {c.revision_of}／{_esc(_clip(c.decision_note, 300))}")
        if c.reason:
            lines.append(f"直したこと: {_esc(_clip(c.reason, 200))}")
    elif c.reason:
        lines.append(f"拾った理由: {_esc(_clip(c.reason, 150))}")
    lines.append("出典:")
    lines += _sources(c)
    if not c.revision_of:
        lines.append(f"判定: 承認待ち（{_esc(_clip(c.decision_note, 120))}）")
    lines.append("→ タスクにするなら「起票する」（上の部局で起票）、直してほしい点（部局を含む）があれば「コメントして差し戻す」、"
                 "不要なら「不要」。起票後は `/todo` で担当・期限を直せます。")
    return _clip("\n".join(lines), MESSAGE_LIMIT)


def auto_text(c: CandidateRow, number: int, assignee_id: int | None) -> str:
    lines = [f"🤖 **自動起票しました**（定期スクリーニング・候補 {c.id}）— タスク #{number}",
             f"**{_esc(c.title)}**", _meta_line(c, assignee_id),
             f"自動起票の理由: {_esc(_clip(c.decision_note, 120))}", "出典:"]
    lines += _sources(c)
    lines.append(f"詳細は `/todo show id:{number}`。直してほしい点があれば「コメントして差し戻す」"
                 "（このタスクは閉じて修正版を出し直します）、誤りなら「誤起票として閉じる」。")
    return _clip("\n".join(lines), MESSAGE_LIMIT)


def _done_line(text: str, note: str) -> str:
    """元の投稿の 1〜2 行目(見出しとタイトル)を残し、結果を付ける。"""
    head = "\n".join((text or "").split("\n")[:2])
    return _clip(f"{head}\n{note}", MESSAGE_LIMIT)


class ScreeningButton(discord.ui.DynamicItem[discord.ui.Button],
                      template=r"tscr:(?P<action>ok|rt|ng|undo):(?P<cid>[0-9]{1,12})"):
    """再起動後も効くボタン(custom_id に操作と候補番号を入れる)。"""

    def __init__(self, action: str, cid: int):
        super().__init__(discord.ui.Button(label=_LABELS[action], style=_STYLES[action],
                                           custom_id=f"tscr:{action}:{cid}"))
        self.action = action
        self.cid = cid

    @classmethod
    async def from_custom_id(cls, interaction, item, match: re.Match[str], /):
        return cls(match["action"], int(match["cid"]))

    async def callback(self, interaction: discord.Interaction):
        cog = interaction.client.get_cog("TaskScreening")
        if cog is None:
            await interaction.response.send_message("⚠ 現在この操作は使えません。", ephemeral=True)
            return
        await cog.handle(interaction, self.action, self.cid)


class ReturnModal(discord.ui.Modal, title="コメントして差し戻す"):
    comment = discord.ui.TextInput(
        label="直してほしいこと", style=discord.TextStyle.paragraph, max_length=COMMENT_MAX,
        placeholder="例: 期限は10/16、担当は鈴蘭さん。発注と受け取りは別の仕事なので2つに分けて")

    def __init__(self, cog: "TaskScreening", cid: int, message: discord.Message | None):
        super().__init__(timeout=900)
        self.cog = cog
        self.cid = cid
        self.message = message

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog.submit_return(interaction, self.cid, str(self.comment.value or ""), self.message)


def review_view(cid: int) -> discord.ui.View:
    return _view(("ok", cid), ("rt", cid), ("ng", cid))


def auto_view(cid: int) -> discord.ui.View:
    return _view(("rt", cid), ("undo", cid))


def _can_return(c: CandidateRow) -> bool:
    """差し戻せるのは承認待ちと、自動起票したもの(人が承認して起票したものは /todo で直す)。"""
    return c.state == "posted" or (c.state == "created" and c.decision == "auto")


def _view(*actions_cid: tuple[str, int]) -> discord.ui.View:
    view = discord.ui.View(timeout=None)
    for action, cid in actions_cid:
        view.add_item(ScreeningButton(action, cid))
    return view


class TaskScreening(commands.Cog):
    def __init__(self, bot: commands.Bot, settings: TaskSettings, task_store: TaskStore,
                 store: ScreeningStore, *, poll_sec: int = 60, max_per_poll: int = 5,
                 auto_create: bool = True, trigger_path: Path | None = None):
        self.bot = bot
        self.settings = settings
        self.tasks = task_store
        self.store = store
        self.max_per_poll = max_per_poll
        self.auto_create = auto_create
        self.trigger_path = trigger_path
        self._upgrade_task: asyncio.Task | None = None
        self.poll.change_interval(seconds=poll_sec)

    async def cog_load(self):
        self.bot.add_dynamic_items(ScreeningButton)
        self.poll.start()

    async def cog_unload(self):
        self.poll.cancel()
        if self._upgrade_task is not None:
            self._upgrade_task.cancel()
        self.bot.remove_dynamic_items(ScreeningButton)

    # ---- 共通 ----

    async def _store(self, fn, *args, **kwargs):
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def _task(self, fn, *args, **kwargs):
        """TaskStore の処理をスレッドで実行(TaskCog._call と同じ考え方で期限付き)。"""
        budget = Budget(STORE_TIMEOUT_SEC * 0.7)
        return await asyncio.wait_for(asyncio.to_thread(fn, *args, budget=budget, **kwargs),
                                      timeout=STORE_TIMEOUT_SEC * 2)

    def _channel(self, c: CandidateRow) -> discord.TextChannel | None:
        channel = self.bot.get_channel(c.channel_id)
        if not isinstance(channel, discord.TextChannel) or not self.settings.allows(channel.guild.id, channel.id):
            return None
        me = channel.guild.me
        if me is None:
            return None
        perms = channel.permissions_for(me)
        if not (perms.view_channel and perms.send_messages):
            return None
        return channel

    async def _assignee(self, channel: discord.TextChannel, user_id: int | None) -> int | None:
        """担当候補は、そのチャンネルを見られる(Bot でない)メンバーのときだけ割り当てる。"""
        if not user_id:
            return None
        member = channel.guild.get_member(user_id)
        if member is None:
            try:
                member = await channel.guild.fetch_member(user_id)
            except discord.HTTPException:
                return None
        if member.bot:   # 2026-10-14: 部局タグ化で、担当はサーバーのメンバーなら誰でもよい
            return None
        return member.id

    def _write_trigger(self, cid: int, action: str) -> None:
        """判定のあと、スクリーニングの後続処理(差し戻しの修正・判定記録)をすぐ起動してもらう。"""
        if self.trigger_path is None:
            return
        with self.trigger_path.open("a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}\t{action}\t{cid}\n")

    async def _trigger(self, cid: int, action: str) -> None:
        try:
            await self._store(self._write_trigger, cid, action)
        except OSError as error:
            log.warning("後続処理の起動依頼を書けませんでした: %s", type(error).__name__)

    # ---- 定期処理: 台帳 → Discord ----

    @tasks.loop(seconds=60)
    async def poll(self):
        if self._upgrade_task is None:
            self._upgrade_task = asyncio.create_task(self._upgrade_views())
        try:
            await self._store(self.store.release_stale)
            rows = await self._store(self.store.claim_new, self.max_per_poll)
        except Exception:  # noqa: BLE001  台帳の一時的な読めなさで Bot を止めない
            log.warning("候補台帳を読めませんでした", exc_info=True)
            return
        for c in rows:
            try:
                await self._publish(c)
            except Exception as error:  # noqa: BLE001
                log.warning("候補 %d の投稿に失敗: %s", c.id, type(error).__name__)
                await self._store(self.store.transition, c.id, "publishing", "failed",
                                  error=f"投稿に失敗: {type(error).__name__}")
            await asyncio.sleep(1)

    @poll.before_loop
    async def _before(self):
        await self.bot.wait_until_ready()

    async def _upgrade_views(self):
        """差し戻しボタンが無い頃に出した投稿に、ボタンを付け直す(版ごとに 1 回だけ)。

        版 2: 承認待ちの投稿、版 3: 自動起票のお知らせ。本文は変えない。編集記録(edit_watch)に
        「旧版不明」の行が並ばないよう、取得したメッセージを先にキャッシュへ入れてから編集する
        (本文が同じなら記録されない)。
        """
        try:
            current = await self._store(self.store.get_meta, "view_version", 1)
            steps = [(2, self.store.posted, review_view, "承認待ち"),
                     (3, self.store.auto_created, auto_view, "自動起票")]
            for version, rows_of, view_of, label in steps:
                if current >= version:
                    continue
                rows = await self._store(rows_of)
                done = 0
                for c in rows:
                    channel = self._channel(c)
                    if channel is None:
                        continue
                    try:
                        msg = await channel.fetch_message(c.message_id)
                        cache = getattr(getattr(self.bot, "_connection", None), "_messages", None)
                        if cache is not None:
                            cache.append(msg)
                        await msg.edit(view=view_of(c.id), allowed_mentions=discord.AllowedMentions.none())
                        done += 1
                    except discord.HTTPException as error:
                        log.warning("候補 %d のボタンを付け直せませんでした: %s", c.id, type(error).__name__)
                    await asyncio.sleep(0.5)
                await self._store(self.store.set_meta, "view_version", version)
                log.info("%sの投稿 %d/%d 件に差し戻しボタンを付けました", label, done, len(rows))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.warning("差し戻しボタンの付け直しに失敗", exc_info=True)

    async def _publish(self, c: CandidateRow):
        channel = self._channel(c)
        if channel is None:
            await self._store(self.store.transition, c.id, "publishing", "failed",
                              error="投稿先チャンネルに書けない(存在しない・権限なし・/todo の対象外)")
            return
        if c.decision == "auto" and self.auto_create:
            assignee = await self._assignee(channel, c.assignee_id)
            try:
                result = await self._task(
                    self.tasks.create,
                    Actor(user_id=self.bot.user.id, operation_id=f"scr-auto-{c.id:08d}", source="screening"),
                    Scope(channel.guild.id, channel.id), title=c.title, description=c.description,
                    assignee_id=assignee, deadline=c.deadline, requirements=c.requirements, tags=c.tag_list)
            except TaskError as error:
                log.warning("候補 %d の自動起票に失敗(承認待ちに回す): %s", c.id, error.code)
            else:
                # 起票できた時点で台帳を確定させる(お知らせの投稿に失敗しても二重起票しない)
                number = result.view.task.number
                await self._store(self.store.transition, c.id, "publishing", "created",
                                  task_number=number, decided_by=self.bot.user.id,
                                  log=("auto", self.bot.user.id, "", number, ""))
                msg = await channel.send(auto_text(c, number, assignee), view=auto_view(c.id),
                                         allowed_mentions=discord.AllowedMentions.none())
                await self._store(self.store.transition, c.id, "created", "created", message_id=msg.id)
                await self._trigger(c.id, "auto")
                return
        msg = await channel.send(review_text(c), view=review_view(c.id),
                                 allowed_mentions=discord.AllowedMentions.none())
        await self._store(self.store.transition, c.id, "publishing", "posted", message_id=msg.id,
                          decision="review")

    # ---- ボタン ----

    async def _authorize(self, itx: discord.Interaction, cid: int):
        task_cog = self.bot.get_cog("TaskCog")
        if task_cog is None:
            raise TaskError("UNAVAILABLE", "タスク機能が停止中のため操作できません。")
        access = task_cog.authorize(itx, edit=True)
        c = await self._store(self.store.get, cid)
        if c is None or c.channel_id != access.channel.id:
            raise TaskError("NOT_FOUND", "この候補は見つかりません。")
        return access, c

    async def handle(self, itx: discord.Interaction, action: str, cid: int):
        try:
            access, c = await self._authorize(itx, cid)
        except TaskError as error:
            await self._reply(itx, f"⚠ {error.message}")
            return
        if action == "rt":
            # 入力欄は最初の応答でしか開けないので、defer せずにすぐ出す
            if not _can_return(c):
                await self._reply(itx, self._already(c))
                return
            try:
                await itx.response.send_modal(ReturnModal(self, cid, itx.message))
            except discord.HTTPException:
                log.warning("差し戻しの入力欄を開けませんでした")
            return
        try:
            await itx.response.defer(ephemeral=True, thinking=True)
        except discord.HTTPException:
            return
        try:
            if action == "ok":
                text = await self._approve(itx, access, c)
            elif action == "ng":
                text = await self._reject(itx, access, c)
            else:
                text = await self._undo(itx, access, c)
        except TaskError as error:
            text = f"⚠ {error.message}"
        except Exception as error:  # noqa: BLE001
            log.warning("候補 %d の操作(%s)に失敗: %s", cid, action, type(error).__name__)
            text = "⚠ 処理中に想定外のエラーが発生しました。変更は反映されていない可能性があります。"
        await self._reply(itx, text)

    async def submit_return(self, itx: discord.Interaction, cid: int, comment: str,
                            message: discord.Message | None):
        comment = _clip(comment.replace("\r", ""), COMMENT_MAX)
        try:
            access, c = await self._authorize(itx, cid)
            if not comment:
                raise TaskError("VALIDATION", "コメントを入力してください。")
        except TaskError as error:
            await self._reply(itx, f"⚠ {error.message}")
            return
        user = access.actor.user_id
        auto = c.state == "created" and c.decision == "auto"
        try:
            # 自動起票の差し戻しは /todo の更新を伴うので、応答期限(3 秒)に備えて先に受け付ける
            await itx.response.defer(ephemeral=True, thinking=True)
        except discord.HTTPException:
            pass
        try:
            if auto:
                ok = await self._return_auto(access, c, comment)
            else:
                ok = await self._store(self.store.transition, cid, "posted", "returned", decided_by=user,
                                       comment=comment, log=("return", user, comment, None, ""))
        except TaskError as error:
            await self._reply(itx, f"⚠ {error.message}")
            return
        except Exception as error:  # noqa: BLE001
            log.warning("候補 %d の差し戻しに失敗: %s", cid, type(error).__name__)
            await self._reply(itx, "⚠ 差し戻しを記録できませんでした。少し待ってからもう一度押してください。")
            return
        if not ok:
            await self._reply(itx, self._already(await self._store(self.store.get, cid)))
            return
        closed = f"#{c.task_number} は閉じ（完了扱い）、" if auto else ""
        await self._edit(message or itx.message,
                         f"↩ <@{user}> が差し戻し: {_esc(_clip(comment, 600))}\n"
                         f"→ {closed}修正版をこのチャンネルに出し直します（数分後）")
        await self._trigger(cid, "return")
        await self._reply(itx, f"↩ 差し戻しました。{closed}数分後に、コメントを反映した修正版をこのチャンネルに出します。")

    async def _return_auto(self, access, c: CandidateRow, comment: str) -> bool:
        """自動起票したタスクを差し戻す: タスクを完了扱いで閉じ(説明にコメントを残す)、候補を差し戻しにする。"""
        user = access.actor.user_id
        if c.task_number is None or not await self._store(self.store.transition, c.id, "created", "undoing"):
            return False
        try:
            view = await self._task(self.tasks.get_task, access.scope, c.task_number)
            task = view.task
            if task.status != "done":
                note = f"\n\n[差し戻し: {comment}。修正版を候補として出し直す]"
                await self._task(
                    self.tasks.update, Actor(user_id=user, operation_id=f"scr-rtc-{c.id:08d}", source="discord"),
                    access.scope, c.task_number, task.version,
                    {"status": "done", "description": _clip(task.description + note, 2000)}, confirmed=True)
        except BaseException:
            await self._store(self.store.transition, c.id, "undoing", "created")
            raise
        return await self._store(self.store.transition, c.id, "undoing", "returned", decided_by=user,
                                 comment=comment, log=("return", user, comment, c.task_number, ""))

    async def _reply(self, itx: discord.Interaction, text: str):
        kwargs = {"ephemeral": True, "allowed_mentions": discord.AllowedMentions.none()}
        try:
            if itx.response.is_done():
                await itx.followup.send(text, **kwargs)
            else:
                await itx.response.send_message(text, **kwargs)
        except discord.HTTPException:
            pass

    @staticmethod
    def _already(c: CandidateRow | None) -> str:
        if c is None:
            return "この候補は見つかりません。"
        who = f"<@{c.decided_by}>" if c.decided_by else "他の人"
        done = {"created": f"起票済みです（#{c.task_number}）", "rejected": f"{who} が「不要」にしました",
                "returned": f"{who} が差し戻しました（修正版を準備中）",
                "revised": f"差し戻されて修正版が出ています（候補 {c.revised_to}）",
                "undone": "誤起票として閉じられています", "creating": "他の人が処理中です",
                "undoing": "他の人が処理中です"}
        return "この候補はすでに" + done.get(c.state, f"処理されています（{c.state}）") + "。"

    async def _edit(self, message: discord.Message | None, note: str):
        if message is None:
            return
        try:
            await message.edit(content=_done_line(message.content, note), view=None,
                               allowed_mentions=discord.AllowedMentions.none())
        except discord.HTTPException:
            log.warning("候補の投稿を更新できませんでした")

    async def _approve(self, itx, access, c: CandidateRow) -> str:
        user = access.actor.user_id
        if not await self._store(self.store.transition, c.id, "posted", "creating", decided_by=user):
            return self._already(await self._store(self.store.get, c.id))
        assignee = await self._assignee(access.channel, c.assignee_id)
        try:
            result = await self._task(
                self.tasks.create, Actor(user_id=user, operation_id=f"scr-ok-{c.id:08d}", source="discord"),
                access.scope, title=c.title, description=c.description, assignee_id=assignee,
                deadline=c.deadline, requirements=c.requirements, tags=c.tag_list)
        except BaseException:
            await self._store(self.store.transition, c.id, "creating", "posted", decided_by=None)
            raise
        number = result.view.task.number
        await self._store(self.store.transition, c.id, "creating", "created", task_number=number,
                          log=("ok", user, "", number, ""))
        await self._edit(itx.message, f"✅ <@{user}> が起票 → タスク #{number}（`/todo show id:{number}`）")
        await self._trigger(c.id, "ok")
        note = "" if assignee or not c.assignee_id else "（担当候補がサーバーにいないため未割当）"
        return f"✅ 起票しました: #{number} {_esc(c.title)}{note}\n担当・期限の変更は `/todo assign` `/todo deadline` で。"

    async def _reject(self, itx, access, c: CandidateRow) -> str:
        user = access.actor.user_id
        if not await self._store(self.store.transition, c.id, "posted", "rejected", decided_by=user,
                                 log=("ng", user, "", None, "")):
            return self._already(await self._store(self.store.get, c.id))
        await self._edit(itx.message, f"🗑 <@{user}> が「不要」にしました")
        await self._trigger(c.id, "ng")
        return "「不要」にしました。同じ候補は今後出しません。"

    async def _undo(self, itx, access, c: CandidateRow) -> str:
        user = access.actor.user_id
        if c.task_number is None or not await self._store(self.store.transition, c.id, "created", "undoing"):
            return self._already(await self._store(self.store.get, c.id))
        try:
            view = await self._task(self.tasks.get_task, access.scope, c.task_number)
            task = view.task
            if task.status != "done":
                await self._task(
                    self.tasks.update, Actor(user_id=user, operation_id=f"scr-undo-{c.id:08d}", source="discord"),
                    access.scope, c.task_number, task.version,
                    {"status": "done", "description": _clip(task.description + UNDO_NOTE, 2000)}, confirmed=True)
        except BaseException:
            await self._store(self.store.transition, c.id, "undoing", "created")
            raise
        await self._store(self.store.transition, c.id, "undoing", "undone", decided_by=user,
                          log=("undo", user, "", c.task_number, ""))
        await self._edit(itx.message, f"🗑 <@{user}> が誤起票として閉じました（#{c.task_number} は完了扱い）")
        await self._trigger(c.id, "undo")
        return f"#{c.task_number} を誤起票として閉じました（完了扱い・説明に記録）。同じ候補は今後出しません。"


def make_cog(bot: commands.Bot, cfg: dict, settings: TaskSettings, task_store: TaskStore) -> TaskScreening:
    path = Path(str(cfg.get("store_path", ""))).expanduser()
    if not path.is_absolute():
        raise ValueError("task_screening.store_path は絶対パスで指定してください")
    store = ScreeningStore.open(path)
    trigger = cfg.get("trigger_path")
    return TaskScreening(bot, settings, task_store, store,
                         poll_sec=max(15, int(cfg.get("poll_sec", 60))),
                         max_per_poll=max(1, min(20, int(cfg.get("max_per_poll", 5)))),
                         auto_create=bool(cfg.get("auto_create", True)),
                         trigger_path=Path(trigger).expanduser() if trigger else path.parent / "followup.request")
