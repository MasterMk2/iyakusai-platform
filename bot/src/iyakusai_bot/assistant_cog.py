# -*- coding: utf-8 -*-
"""統合アプリ「Bot」タブの依頼を Bot の中で実行する Cog(2026-10-14)。

Pi の連携口(gateway)が受けたジョブを、poll_sec ごとに claim して実行する:
- ask / doc: 既存の /ask・/doc の本体を WebInteraction 越しに呼ぶ(Discord と同じ経路)。#bottest に投稿。
- remind: ReminderStore を Discord の /remind と同じ権限規則で書き、通知先に確認を出す。
- screening: TaskScreening のボタン処理(handle / submit_return)をそのまま呼ぶ(TaskCog.authorize を通る)。
- image: Images の /image 本体(Claude が SVG を書き PNG にする)を WebInteraction 越しに呼ぶ。#bottest に投稿。
- taskdraft: 概略からタスクの分け方と担当の案を作る(2026-11-09・taskdraft_logic)。Documents と同じ AI を使い、
  Discord には投稿しない(依頼した本人だけが結果を読む。起票はアプリが既存のタスク作成で行う)。
  [assistant] image_enabled が false か、Images が使えない(未設定・点検失敗)ときは受けて即 IMAGE_DISABLED。
- reminder_snapshot / capabilities / heartbeat: 連携口が読む写しを 30 秒ごと・変更の直後に書く。

並行数: ask/doc/taskdraft は 2 本まで(Knowledge の同時実行枠と CLI の上限はそのまま効く)。image は 1 本
(1 枚に数十秒〜数分かかり、AI の枠と Pi のメモリを /ask と分け合うため)。remind/screening は軽いので、
受けたら順に即実行する(使えないときの image の即失敗も同じ列)。
ログには依頼の中身(質問・名前・内容)を出さない。ジョブ番号と種類、例外の型名だけ。
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import time
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks

from . import access as A
from . import access_check
from . import assistant_logic as L
from . import remind_logic as rl
from . import taskdraft_logic as TD
from . import write_guard
from .assistant_store import AssistantStore, Job
from .ai_provider import AIError
from .config import AssistantSettings
from .notify import routed_channel_id
from .reminders import _fmt_item
from .storage import ReminderStore
from .web_interaction import WebInteraction

log = logging.getLogger("iyakusai.assistant")

ASK_DOC_LANES = 2
IMAGE_LANES = 1
SNAPSHOT_SEC = 30
MEMBER_INDEX_SEC = 600
USER_FAILURE = "⚠ 処理中に想定外のエラーが発生しました。少し待ってから、もう一度依頼してください。"
DOC_TYPE_LABELS = {
    "request": ("依頼文(対外)", "依頼文(学外の企業・団体宛)"),
    "notice": ("お知らせ(学内・委員向け)", "お知らせ・周知文(学内または委員会内向け)"),
    "report": ("報告書", "報告書"),
    "minutes": ("議事録たたき台", "議事録のたたき台(日時・出席者・議題・決定事項の枠組み)"),
    "mail": ("メール文面", "メール文面(件名+本文)"),
    "free": ("自由", "自由形式"),
}
TASKDRAFT_SEARCH_SEC = 60   # 資料を探すのに使ってよい時間(超えたら資料なしで下書きする)
TASKDRAFT_UNAVAILABLE = "タスクの下書き(AI)はいま使えません。少し待ってから、もう一度依頼してください。"
IMAGE_DISABLED_MESSAGE = "画像の作成はいま使えません(Bot の設定で止めているか、準備ができていません)。"


class JobError(Exception):
    """利用者に返す失敗。message は日本語・code は連携口がそのまま使う。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _JobDenied(JobError):
    """操作の種類の権限で拒否された依頼。拒否は access_check が denied として残すので、完了の失敗は残さない。"""


class _FallbackUser:
    """依頼者の Member が取れないとき(キャッシュに無い等)の代わり。/ask・/doc は id と名前しか使わない。"""

    bot = False

    def __init__(self, user_id: int, name: str):
        self.id = user_id
        self.name = name
        self.display_name = name

    def __str__(self) -> str:
        return self.name


def _actor_int(job: Job) -> int:
    return int(str(job.actor_id).split("-", 1)[1])


def _id_value(value) -> int:
    """入力の ID を整数にする。連携口は数字だけで保存するが、"discord-<ID>" の形も受ける。"""
    text = str(value).strip()
    if text.startswith("discord-"):
        text = text[len("discord-"):]
    return int(text)


class Assistant(commands.Cog):
    def __init__(self, bot: commands.Bot, settings: AssistantSettings, store: AssistantStore, *,
                 reminders: ReminderStore):
        self.bot = bot
        self.settings = settings
        self.store = store
        self.reminders = reminders
        self.files_dir = Path(settings.files_dir)
        self._lanes = {"ask_doc": 0, "image": 0}
        self._jobs: set[asyncio.Task] = set()
        self._started = False
        self._snapshot_at: float | None = None
        self._names: dict[int, tuple[float, str]] = {}   # 表示名のキャッシュ(""=サーバーにいない)
        self.poll.change_interval(seconds=settings.poll_sec)

    @property
    def image_enabled(self) -> bool:
        """アプリの画像を受けるか。設定(image_enabled)と、Images(/image)が点検を通って使えること。"""
        images = self.bot.get_cog("Images")
        return bool(self.settings.image_enabled and images is not None and images.available())

    async def cog_load(self):
        self.poll.start()

    async def cog_unload(self):
        self.poll.cancel()
        for task in list(self._jobs):
            task.cancel()

    # ---- 定期処理 ----

    @tasks.loop(seconds=2)
    async def poll(self):
        try:
            if not self._started:
                count = await asyncio.to_thread(self.store.recover_interrupted)
                if count:
                    log.warning("前回の停止で中断したジョブを %d 件 failed にしました", count)
                self._started = True
            await asyncio.to_thread(self.store.heartbeat)
            due = self._snapshot_at is None or time.monotonic() - self._snapshot_at >= SNAPSHOT_SEC
            if due:
                await self.publish_state()
            await self._claim()
        except Exception as error:  # noqa: BLE001  ループを止めない(次の周期で再試行)
            log.warning("アシスタントの定期処理で失敗: %s", type(error).__name__)

    @poll.before_loop
    async def _before_poll(self):
        await self.bot.wait_until_ready()

    async def _claim(self) -> None:
        # 軽い依頼(remind/screening と、使えないときの image の即失敗)は受けた順に即実行
        image_on = self.image_enabled
        light = ("remind", "screening") if image_on else ("remind", "screening", "image")
        while True:
            job = await asyncio.to_thread(self.store.claim_next, light)
            if job is None:
                break
            self._spawn(job, None)
        while image_on and self._lanes["image"] < IMAGE_LANES:
            job = await asyncio.to_thread(self.store.claim_next, ("image",))
            if job is None:
                break
            self._spawn(job, "image")
        while self._lanes["ask_doc"] < ASK_DOC_LANES:
            job = await asyncio.to_thread(self.store.claim_next, ("ask", "doc", "taskdraft"))
            if job is None:
                break
            self._spawn(job, "ask_doc")

    def _spawn(self, job: Job, lane: str | None) -> None:
        if lane:
            self._lanes[lane] += 1
        task = asyncio.create_task(self._run(job, lane))
        self._jobs.add(task)
        task.add_done_callback(self._jobs.discard)

    async def _run(self, job: Job, lane: str | None) -> None:
        try:
            result, url = await self._execute(job)
            await asyncio.to_thread(self.store.finish, job.id, result, url)
            log.info("依頼 %s(%s)が完了", job.id, job.kind)
            self._job_outcome(job, "ok")
        except _JobDenied as error:
            # 拒否は監査に denied として残し済み。ここでは失敗の行を重ねず、依頼の失敗だけを返す
            log.info("依頼 %s(%s)は権限の表で拒否", job.id, job.kind)
            await self._fail(job, error.code, error.message)
        except JobError as error:
            log.info("依頼 %s(%s)を失敗で終了: %s", job.id, job.kind, error.code)
            self._job_outcome(job, "failed", error.code)
            await self._fail(job, error.code, error.message)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001  必ず failed にする(running のまま残さない)
            log.error("依頼 %s(%s)が想定外のエラー: %s", job.id, job.kind, type(error).__name__)
            log.debug("依頼 %s の詳細", job.id, exc_info=True)
            self._job_outcome(job, "failed", "INTERNAL")
            await self._fail(job, "INTERNAL", USER_FAILURE)
        finally:
            if lane:
                self._lanes[lane] -= 1

    def _job_outcome(self, job: Job, result: str, code: str | None = None) -> None:
        """統合アプリの依頼の完了・失敗を監査に残す（依頼の中身は書かない）。

        読む系の依頼（ask）は、受付も完了も残さない方針なので書かない（access_check の説明と同じ）。
        """
        command = A.WEB_JOB_KEYS.get(job.kind)
        if command is None or A.kind_of(command) == "read":
            return
        access_check.log_outcome(command, actor_id=_actor_int(job), result=result, code=code)

    async def _enforce_job(self, job: Job) -> None:
        """統合アプリの依頼の操作の種類の権限（access.py）。Discord のコマンドの check を通らないので、ここで確かめる。

        依頼者が委員のサーバーのメンバーでなければ役割が無い扱い（表で絞った種類は拒否・全員の種類は今と同じ）。
        """
        command = A.WEB_JOB_KEYS.get(job.kind)
        if command is None:
            return   # 未対応の依頼は _execute の UNSUPPORTED で止まる
        actor = _actor_int(job)
        roles: list[str] = []
        if access_check.needs_roles(command):   # 表で絞った命令だけ会員を引く（既定では Discord を呼ばない）
            member = await self._guild_member(self._guild(), actor)
            roles = access_check.role_names_of(member) if member is not None else []
        try:
            access_check.enforce(command, actor_id=actor, role_names=roles)
        except access_check.AccessDenied as error:
            raise _JobDenied("FORBIDDEN", str(error)) from error

    async def _fail(self, job: Job, code: str, message: str) -> None:
        try:
            await asyncio.to_thread(self.store.fail, job.id, code, message)
        except Exception as error:  # noqa: BLE001  記録できないときはログだけ(起動時に INTERRUPTED で回収)
            log.error("依頼 %s の失敗を記録できませんでした: %s", job.id, type(error).__name__)

    async def _execute(self, job: Job) -> tuple[dict, str | None]:
        await self._enforce_job(job)
        if job.kind == "ask":
            return await self._do_ask(job)
        if job.kind == "doc":
            return await self._do_doc(job)
        if job.kind == "image":
            return await self._do_image(job)
        if job.kind == "remind":
            return await self._do_remind(job)
        if job.kind == "screening":
            return await self._do_screening(job)
        if job.kind == "taskdraft":
            return await self._do_taskdraft(job)
        raise JobError("UNSUPPORTED", "未対応の依頼です")

    # ---- 共通: 共有先・依頼者 ----

    def _share_channel(self):
        # 送り先は [notify] の app_share(無ければ従来の assistant.share_channel_id・2026-11-03)
        share_id = self.settings.share_channel_id
        routed = routed_channel_id(self.bot, "app_share", share_id)
        channel = self._channel(routed)
        if channel is None and routed != share_id:
            channel = self._channel(share_id)     # 上書き先が見えないときは従来の共有先に戻す
        if channel is None:
            raise JobError("UNAVAILABLE", "共有先のチャンネル(#bottest)に接続できません。少し待って再実行してください。")
        return channel

    def _channel(self, channel_id: int):
        channel = self.bot.get_channel(channel_id)
        return channel if channel is not None and hasattr(channel, "send") else None

    def _reminder_channel(self, channel_id: int):
        """リマインドの確認の投稿先。[notify] の reminder が設定されていればそこ(無ければ登録のチャンネル)。"""
        channel = self._channel(routed_channel_id(self.bot, "reminder", channel_id))
        return channel if channel is not None else self._channel(channel_id)

    async def _guild_member(self, guild, user_id: int):
        """サーバーのメンバーを返す(キャッシュ → 取得)。見つからなければ None。"""
        if guild is None:
            return None
        member = guild.get_member(user_id)
        if member is None:
            try:
                member = await guild.fetch_member(user_id)
            except discord.HTTPException:
                return None
        return member

    async def _actor(self, guild, job: Job):
        member = await self._guild_member(guild, _actor_int(job))
        return member if member is not None else _FallbackUser(_actor_int(job), job.actor_name)

    def _adapter(self, job: Job, user, channel, original) -> WebInteraction:
        async def progress(phase: str, text: str) -> None:
            await asyncio.to_thread(self.store.set_progress, job.id, {"phase": phase, "text": text})

        return WebInteraction(interaction_id=job.id, user=user, channel=channel,
                              guild=getattr(channel, "guild", None), original=original,
                              on_progress=progress, header=getattr(original, "content", None))

    # ---- ask / doc ----

    async def _do_ask(self, job: Job) -> tuple[dict, str | None]:
        knowledge = self.bot.get_cog("Knowledge")
        if knowledge is None:
            raise JobError("UNAVAILABLE", "資料検索(/ask)は現在使えません。")
        channel = self._share_channel()
        user = await self._actor(channel.guild, job)
        header = await channel.send(f"📱 アプリから {job.actor_name} さんの質問",
                                    allowed_mentions=discord.AllowedMentions.none())
        adapter = self._adapter(job, user, channel, header)
        inp = job.input
        fmt = app_commands.Choice(name=inp["format"], value=inp["format"]) if inp.get("format") else None
        model = app_commands.Choice(name=inp["model"], value=inp["model"])
        effort = app_commands.Choice(name=inp["effort"], value=inp["effort"])
        # 本体は Discord の /ask と同じ関数。cog・interaction 以外の引数は Discord 版と同じ形。
        await knowledge.ask.callback(knowledge, adapter, inp["question"], fmt, model, inp.get("tone"), effort)
        text = adapter.answer_text()
        if not text.strip() and not adapter.files:
            raise JobError("NO_ANSWER", adapter.ephemeral_text() or "回答を作れませんでした。時間をおいて再実行してください。")
        files = await asyncio.to_thread(self._persist, job.id, [(f.name, f.data) for f in adapter.files])
        return {"text": text, "files": files}, header.jump_url

    async def _do_doc(self, job: Job) -> tuple[dict, str | None]:
        documents = self.bot.get_cog("Documents")
        if documents is None:
            raise JobError("UNAVAILABLE", "文書の起草(/doc)は現在使えません。")
        channel = self._share_channel()
        user = await self._actor(channel.guild, job)
        header = await channel.send(f"📱 アプリから {job.actor_name} さんの文書作成",
                                    allowed_mentions=discord.AllowedMentions.none())
        adapter = self._adapter(job, user, channel, header)
        inp = job.input
        label, value = DOC_TYPE_LABELS[inp["docType"]]
        kind = app_commands.Choice(name=label, value=value)
        fmt = app_commands.Choice(name=inp["format"], value=inp["format"])
        model = app_commands.Choice(name=inp["model"], value=inp["model"])
        await documents.doc.callback(documents, adapter, kind, inp["content"], fmt, inp["useSources"], model)
        if not adapter.files:
            raise JobError("NO_ANSWER", adapter.ephemeral_text() or "文書を作れませんでした。時間をおいて再実行してください。")
        files = await asyncio.to_thread(self._persist, job.id, [(f.name, f.data) for f in adapter.files])
        body = _document_body(inp["format"], adapter.files[0].data)
        text = adapter.answer_text() + (f"\n\n{body}" if body else "")
        return {"text": text, "files": files}, header.jump_url

    # ---- image(Claude が SVG で描く・2026-10-14 夜に再開) ----

    async def _do_image(self, job: Job) -> tuple[dict, str | None]:
        images = self.bot.get_cog("Images")
        if not self.image_enabled or images is None:
            raise JobError("IMAGE_DISABLED", IMAGE_DISABLED_MESSAGE)
        if not images.has_quota(_actor_int(job)):
            # #bottest に見出しだけ残さないよう、投稿の前に確かめる(数えるのは本体の中)
            raise JobError("LIMIT", f"画像は 1 人 1 日 {images.settings.daily_limit_per_user} 枚までです。"
                                    "明日また使ってください。")
        channel = self._share_channel()
        user = await self._actor(channel.guild, job)
        header = await channel.send(f"📱 アプリから {job.actor_name} さんの画像",
                                    allowed_mentions=discord.AllowedMentions.none())
        adapter = self._adapter(job, user, channel, header)
        inp = job.input
        aspect = app_commands.Choice(name=inp["aspect"], value=inp["aspect"])
        # 本体は Discord の /image と同じ関数(1 日の上限・書き直し・無害化も同じ)
        await images.image.callback(images, adapter, inp["prompt"], aspect)
        pngs = [f for f in adapter.files if f.name.lower().endswith(".png")]
        if not pngs:
            raise JobError("NO_ANSWER", adapter.ephemeral_text() or adapter.answer_text()
                           or "画像を作れませんでした。時間をおいて再実行してください。")
        # 配るのは PNG だけ(SVG は #bottest の投稿に付いている。アプリでは配らない型)
        files = await asyncio.to_thread(self._persist, job.id, [(f.name, f.data) for f in pngs])
        return {"text": adapter.answer_text(), "files": files}, header.jump_url

    # ---- remind ----

    async def _do_remind(self, job: Job) -> tuple[dict, str | None]:
        if job.op == "create":
            return await self._remind_create(job)
        if job.op in ("done", "delete"):
            return await self._remind_change(job)
        if job.op == "notice":
            return await self._notice(job)
        raise JobError("VALIDATION", "リマインドの操作が正しくありません")

    def _notice_channel(self):
        """DM で届かない人へのメンションの投稿先。[notify] の app_notice(無ければ共有先)。見えなければ None。"""
        share_id = self.settings.share_channel_id
        channel = self._channel(routed_channel_id(self.bot, "app_notice", share_id))
        return channel if channel is not None else self._channel(share_id)

    async def _notice(self, job: Job) -> tuple[dict, str | None]:
        """統合アプリからの個人あての知らせ(2026-11-11。メールの承認依頼など)。

        本文はアプリが作る(宛先のアドレスや本文の中身は入れない取り決め)。まず DM で送り、DM を受け取らない
        設定の人には、知らせ用のチャンネルでその人だけにメンションして同じ本文を出す。1 人にも届かなければ失敗。
        """
        guild = self._guild()
        if guild is None:
            raise JobError("UNAVAILABLE", "委員のサーバーに接続できません。")
        text = job.input["text"]
        sent, closed = 0, []
        for raw in job.input["targetIds"]:
            member = await self._guild_member(guild, _id_value(raw))
            if member is None or getattr(member, "bot", False):
                continue
            try:
                await member.send(text, allowed_mentions=discord.AllowedMentions.none())
                sent += 1
            except discord.HTTPException:   # DM を閉じている(Forbidden)を含む
                closed.append(member)
        posted = 0
        channel = self._notice_channel() if closed else None
        if channel is not None:
            mentions = " ".join(f"<@{member.id}>" for member in closed)
            try:
                await channel.send(f"{mentions}\n{text}",
                                   allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, users=closed))
                posted = len(closed)
            except discord.HTTPException as error:
                log.warning("アプリからの知らせの投稿に失敗: %s", type(error).__name__)
        if sent + posted == 0:
            raise JobError("UNAVAILABLE", "知らせを届けられませんでした。")
        return {"text": "", "files": [], "message": f"{sent + posted} 人に知らせました"}, None

    async def _remind_create(self, job: Job) -> tuple[dict, str | None]:
        inp = job.input
        allowed = list(self.settings.reminder_channel_ids)
        channel_id = _id_value(inp["channelId"]) if inp.get("channelId") else allowed[0]
        if channel_id not in allowed:
            raise JobError("VALIDATION", "その通知先には登録できません。")
        channel = self._channel(channel_id)
        if channel is None:
            raise JobError("UNAVAILABLE", "通知先のチャンネルに接続できません。")
        actor = _actor_int(job)
        if await self._guild_member(channel.guild, actor) is None:
            raise JobError("FORBIDDEN", "このサーバーの委員として確認できません。")
        target = _id_value(inp["targetId"]) if inp.get("targetId") else actor
        if target != actor and await self._guild_member(channel.guild, target) is None:
            raise JobError("VALIDATION", "対象の委員が見つかりません。")
        try:
            due = L.parse_due_input(inp["due"])
        except L.InputError as error:
            raise JobError("VALIDATION", error.message) from None
        now = rl.now_jst()
        rem = await asyncio.to_thread(self.reminders.add, {
            "text": inp["text"],
            "due": due.isoformat(),
            "creator_id": actor,
            "target_id": target,
            "channel_id": channel_id,
            "repeat": inp.get("repeat") or "none",
            "flags": {},
            "last_ping": None,
            "created_at": now.isoformat(),
            "done": False,
        })
        repeat = {"daily": "毎日", "weekly": "毎週", "monthly": "毎月"}.get(rem["repeat"], "")
        rep = f"(繰り返し: {repeat})" if repeat else ""
        # 保存が済んだ後の失敗で依頼を failed にすると、利用者が再依頼して二重登録になる。
        # だから確認の投稿と写しの更新は失敗しても登録の結果は変えない(ログに残すだけ)。
        confirmed = await self._post_quietly(
            self._reminder_channel(channel_id),
            f"📱 アプリから {job.actor_name} さんが登録\n"
            f"⏰ 登録しました {_fmt_item(rem)} {rep}\n"
            f"通知: 前日・期限時刻・超過中は24時間ごとに催促(`/remind done id:{rem['id']}` で完了)")
        await self.publish_state()
        message = f"⏰ #{rem['id']} を登録しました(通知先: #{getattr(channel, 'name', '')})"
        if not confirmed:
            message += "(確認の投稿は届きませんでした。通知は届きます)"
        reminder = _reminder_json(rem, self._name_for(channel.guild, actor, job.actor_name),
                                  self._name_for(channel.guild, target, ""), channel)
        return {"text": "", "files": [], "reminder": reminder, "message": message}, None

    async def _remind_change(self, job: Job) -> tuple[dict, str | None]:
        rem_id = int(job.input["reminderId"])
        rem = await asyncio.to_thread(self.reminders.get, rem_id)
        if rem is None:
            raise JobError("NOT_FOUND", f"#{rem_id} は見つかりません。")
        channel = self._channel(int(rem.get("channel_id") or 0))
        guild = getattr(channel, "guild", None) or getattr(self._share_or_none(), "guild", None)
        member = await self._guild_member(guild, _actor_int(job))
        is_admin = bool(member is not None and member.guild_permissions.manage_guild)
        actor = _actor_int(job)
        if job.op == "done":
            if not L.may_complete(actor, is_admin, rem):
                raise JobError("FORBIDDEN", "完了にできるのは登録者・催促対象か役員だけです。")
            await asyncio.to_thread(self.reminders.update, rem_id, done=True)
            message = f"✅ 完了にしました: `#{rem_id}` {rem['text']}"
        else:
            if not L.may_delete(actor, is_admin, rem):
                raise JobError("FORBIDDEN", "削除できるのは登録者か役員だけです。")
            await asyncio.to_thread(self.reminders.delete, rem_id)
            message = f"🗑️ 削除しました: `#{rem_id}` {rem['text']}"
        if channel is not None:
            verb = "完了" if job.op == "done" else "削除"
            await self._post_quietly(self._reminder_channel(channel.id),
                                     f"📱 アプリから {job.actor_name} さんが{verb}\n{message}")
        await self.publish_state()
        return {"text": "", "files": [], "message": message}, None

    async def _post_quietly(self, channel, content: str) -> bool:
        """確認の投稿。届かなくても変更は済んでいるので、失敗は記録して False を返す。"""
        try:
            await channel.send(content, allowed_mentions=discord.AllowedMentions.none())
            return True
        except discord.HTTPException as error:
            log.warning("リマインドの確認投稿に失敗(変更は保存済み): %s", type(error).__name__)
            return False

    # ---- screening(定期タスク候補) ----

    async def _do_screening(self, job: Job) -> tuple[dict, str | None]:
        # TaskScreening.handle は知らない操作を「誤起票として閉じる」に落とすので、ここで必ず弾く
        if job.op not in ("ok", "ng", "undo", "return"):
            raise JobError("VALIDATION", "候補の操作が正しくありません")
        screening = self.bot.get_cog("TaskScreening")
        if screening is None:
            raise JobError("UNAVAILABLE", "タスク候補の機能は現在使えません。")
        cid = int(job.input["candidateId"])
        row = await asyncio.to_thread(screening.store.get, cid)
        if row is None:
            raise JobError("NOT_FOUND", "この候補は見つかりません。")
        # 投稿先の判定は TaskScreening の規則そのもの(許可された場所・書ける権限)
        channel = screening._channel(row)
        if channel is None:
            raise JobError("UNAVAILABLE", "候補の投稿先に書けません。")
        member = await self._guild_member(channel.guild, _actor_int(job))
        if member is None:
            raise JobError("FORBIDDEN", "このサーバーの委員として確認できません。")
        message = None
        if row.message_id:
            try:
                message = await channel.fetch_message(row.message_id)
            except discord.HTTPException:
                message = None
        adapter = WebInteraction(interaction_id=job.id, user=member, channel=channel,
                                 guild=channel.guild, message=message)
        if job.op == "return":
            await screening.submit_return(adapter, cid, job.input.get("comment") or "", message)
        else:
            # ok/ng/undo は TaskScreening.handle が TaskCog.authorize を通してから処理する
            await screening.handle(adapter, job.op, cid)
        reply = "\n".join(part for part in [adapter.ephemeral_text(), *adapter.parts] if part)
        if reply.startswith("⚠"):
            raise JobError("REJECTED", reply)
        after = await asyncio.to_thread(screening.store.get, cid)
        result = {"text": "", "files": [], "message": reply,
                  "taskNumber": after.task_number if after is not None else None}
        return result, (message.jump_url if message is not None else None)

    # ---- taskdraft(タスクの起票支援・2026-11-09) ----

    def _taskdraft_ai(self):
        """/doc と同じ AI と記帳(Documents の provider・usage_log)。同時実行の枠も /doc と分け合う。"""
        documents = self.bot.get_cog("Documents")
        provider = getattr(documents, "provider", None)
        return documents, provider

    async def _taskdraft_sources(self, documents, overview: str) -> tuple[str, list[dict]]:
        """委員会の資料から、段取りの手がかりになる抜粋を探す。失敗・時間切れは資料なしで続ける。"""
        kb = getattr(documents, "kb", None)
        if kb is None:
            return "", []
        from .knowledge_search import render_context   # Bot の中だけで使う(純ロジックの試験で読み込まない)

        def search():
            return list(kb.search(overview, 6, use_fields=False).excerpts)

        try:
            excerpts = await asyncio.wait_for(asyncio.to_thread(search), timeout=TASKDRAFT_SEARCH_SEC)
        except Exception as error:  # noqa: BLE001  時間切れ・索引の不具合でも下書きは作る
            log.warning("タスクの下書きの資料検索に失敗(資料なしで続行): %s", type(error).__name__)
            return "", []
        context = render_context(excerpts, budget_chars=TD.CONTEXT_MAX)
        sources = [{"label": str(e.source)[:160], "excerpt": TD.scrub(" ".join(str(e.text).split()))[:160]}
                   for e in excerpts[:4]]
        return context, sources

    async def _do_taskdraft(self, job: Job) -> tuple[dict, str | None]:
        documents, provider = self._taskdraft_ai()
        if provider is None:
            raise JobError("UNAVAILABLE", TASKDRAFT_UNAVAILABLE)
        inp = job.input

        async def progress(phase: str, text: str) -> None:
            await asyncio.to_thread(self.store.set_progress, job.id, {"phase": phase, "text": text})

        context, sources = "", []
        if inp.get("useSources"):
            await progress("search", "委員会の資料から手がかりを探しています…")
            context, sources = await self._taskdraft_sources(documents, inp["overview"])
        await progress("think", "Bot がタスクの分け方と担当の案を考えています…")
        now = rl.now_jst()
        prompt = TD.build_prompt(inp, now=now, actor_id=job.actor_id, actor_name=job.actor_name, context=context)
        model = provider.choose_model(inp["overview"])
        try:
            res = await provider.complete(prompt, model)
        except AIError as error:
            log.warning("依頼 %s のタスクの下書きで AI が失敗: %s", job.id, getattr(error, "kind", "unknown"))
            raise JobError("AI_ERROR", TASKDRAFT_UNAVAILABLE) from None
        usage_log = getattr(documents, "usage_log", None)
        if usage_log is not None:
            try:   # 記帳は落ちてよい・下書きは落とさない(/doc と同じ)
                await asyncio.to_thread(usage_log.record, "assistant.taskdraft", job.actor_name, res)
            except Exception as error:  # noqa: BLE001
                log.warning("使用量の記帳に失敗(下書きは返す): %s", type(error).__name__)
        try:
            draft = TD.parse_result(res.text, inp, now=now)
        except ValueError:
            raise JobError("NO_ANSWER", "下書きを作れませんでした。概略をもう少し具体的にして、もう一度依頼してください。") from None
        draft["sources"] = sources
        draft["model"] = str(getattr(res, "model", "") or model)
        return {"text": TD.summary_text(draft), "files": [], "draft": draft}, None

    # ---- 写し・生存記録・能力(連携口が読む) ----

    def _share_or_none(self):
        try:
            return self._share_channel()
        except JobError:
            return None

    def _guild(self):
        share = self._share_or_none()
        if share is not None and getattr(share, "guild", None) is not None:
            return share.guild
        for channel_id in self.settings.reminder_channel_ids:
            channel = self._channel(channel_id)
            if channel is not None and getattr(channel, "guild", None) is not None:
                return channel.guild
        return None

    async def _names_for(self, guild, ids) -> dict[int, str]:
        """リマインドに出てくる人だけの表示名(キャッシュ → 1 人ずつ取得。10 分保持)。

        2026-10-14: この Bot はメンバー一覧の特権インテント(members)を要求していないので、
        guild.fetch_members(一覧)は使えない。1 人ずつの取得(REST)は特権なしで使える。
        役員かどうかは連携口が見ている本人の権限から判定するので、ここでは名前だけ集める。
        """
        now = time.monotonic()
        out: dict[int, str] = {}
        for uid in ids:
            cached = self._names.get(uid)
            if cached is not None and now - cached[0] < MEMBER_INDEX_SEC:
                out[uid] = cached[1]
                continue
            member = await self._guild_member(guild, uid)
            if member is not None:
                self._names[uid] = (now, member.display_name)
                out[uid] = member.display_name
            elif cached is not None:
                out[uid] = cached[1]   # 一時的に取れないときは前の名前(「Discordユーザー」に化けさせない)
            else:
                self._names[uid] = (now, "")   # サーバーにいない人を 30 秒ごとに取り直さない
                out[uid] = ""
        return out

    def _name_for(self, guild, user_id: int, fallback: str) -> str:
        if guild is not None:
            member = guild.get_member(user_id)
            if member is not None:
                return member.display_name
        cached = self._names.get(user_id)
        if cached is not None and cached[1]:
            return cached[1]
        return fallback or "Discordユーザー"

    async def publish_state(self) -> None:
        """リマインドの写し・能力を連携口が読むためにジョブ表へ書く。失敗は記録するだけ(Bot は止めない)。

        呼び出し側は依頼の結果を決めた後で呼ぶので、ここで例外を出すと保存済みの変更が失敗に見える。
        """
        self._snapshot_at = time.monotonic()   # 失敗時も周期を守る(毎回 2 秒ごとに再試行して警告を溢れさせない)
        try:
            await self._publish_state()
        except Exception as error:  # noqa: BLE001
            log.warning("連携口へのリマインド・能力の書き出しに失敗(次の周期で再試行): %s", type(error).__name__)

    async def _publish_state(self) -> None:
        guild = self._guild()
        try:
            items = await asyncio.to_thread(self.reminders.active)
        except Exception as error:  # noqa: BLE001  読めないときは前の写しを残す(0 件にしない)
            log.warning("リマインドを読めないため写しは据え置き: %s", type(error).__name__)
            items = None
        if items is not None:
            ids = {int(rem.get(key) or 0) for rem in items for key in ("creator_id", "target_id")} - {0}
            names = await self._names_for(guild, ids) if guild is not None else {}
            body = {
                "takenAt": rl.now_jst().isoformat(timespec="seconds"),
                "reminders": [_snapshot_item(rem, names, self) for rem in items],
            }
            await asyncio.to_thread(self.store.write_snapshot, body)
        share = self._share_or_none()
        documents = self.bot.get_cog("Documents")
        capabilities = {
            "features": {
                "ask": self.bot.get_cog("Knowledge") is not None,
                # /doc は AI が使えるときだけ(Documents 自身の判定と同じ)
                "doc": documents is not None and getattr(documents, "provider", None) is not None,
                "image": self.image_enabled,   # Claude の SVG 方式(2026-10-14 夜)。Gemini は使わない
                "remind": True,
                "screening": self.bot.get_cog("TaskScreening") is not None,
                # タスクの起票支援は /doc と同じ AI があるときだけ(2026-11-09)
                "taskdraft": self._taskdraft_ai()[1] is not None,
            },
            # Gemini の依頼は受け付けない(延期中)。連携口はこの値が false のとき gemini を出さない
            "gemini": False,
            # アプリからの個人あての知らせ(remind の op=notice・2026-11-11)を扱える
            "notice": True,
            "maxActivePerUser": self.settings.max_active_per_user,
            "reminderChannels": [{"id": str(cid), "name": getattr(self._channel(cid), "name", "不明")}
                                 for cid in self.settings.reminder_channel_ids],
            # 実際に投稿する先の id(上書き時は [notify] の app_share。無ければ従来の共有先と同じ)
            "shareChannel": ({"id": str(getattr(share, "id", self.settings.share_channel_id)),
                              "name": getattr(share, "name", "不明")}
                             if share is not None else None),
            "updatedAt": rl.now_jst().isoformat(timespec="seconds"),
        }
        await asyncio.to_thread(self.store.set_meta, "capabilities", json.dumps(capabilities, ensure_ascii=False))
        self._snapshot_at = time.monotonic()

    # ---- 生成物の保存 ----

    def _persist(self, job_id: str, items: list[tuple[str, bytes]]) -> list[dict]:
        """生成物を files_dir/<ジョブ>/ に書き、連携口に見せる分だけ登録する(スレッドで呼ぶ)。"""
        folder = self.files_dir / job_id
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        saved, used = [], set()
        for raw_name, data in items:
            if len(data) > L.MAX_DOWNLOAD_BYTES:
                raise JobError("TOO_LARGE", "出力ファイルが大きすぎるため配れません(20 MB まで)。")
            name = L.safe_file_name(raw_name)
            mime = L.mime_for_name(name)
            if not L.is_downloadable(mime):
                continue
            # 生成物は Bot が作ったものなので先頭に【AI】を付ける（write_guard）。重複の番号は接頭辞の
            # 後ろに付け、判定は接頭辞を付けた後の名前で行う（同じパスを 2 回使い、後の内容で上書きしないため）。
            base = name.removeprefix(write_guard.AI_PREFIX)
            index = 2
            name = write_guard.ai_name(base)
            while name in used:
                name = write_guard.ai_name(f"{index}-{base}")
                index += 1
            used.add(name)
            # 置き先は files_dir の中だけ（contained）
            write_guard.contained(self.files_dir, folder / name).write_bytes(data)
            self.store.add_file(job_id, name, mime, len(data),
                                hashlib.sha256(data).hexdigest(), f"{job_id}/{name}")
            saved.append({"name": name, "mime": mime, "size": len(data)})
        return saved


def _document_body(fmt: str, data: bytes) -> str:
    """結果の本文(アプリに表示する分)。md/txt はそのまま、docx は段落の文字だけ取り出す。"""
    try:
        if fmt in ("md", "txt"):
            text = data.decode("utf-8")
        else:
            import docx   # python-docx(requirements にある)
            document = docx.Document(io.BytesIO(data))
            text = "\n".join(p.text for p in document.paragraphs)
    except Exception:  # noqa: BLE001  本文が取れなくてもファイルは届く
        return ""
    return text[:20000]


def _reminder_json(rem: dict, creator_name: str, target_name: str, channel) -> dict:
    """契約 §3-3 の Reminder の形。依頼者(登録者)本人の画面向けなので、完了・削除はできる。"""
    return {
        "id": rem["id"], "text": rem["text"], "due": rem["due"], "repeat": rem.get("repeat", "none"),
        "creator": {"id": f"discord-{rem['creator_id']}", "name": creator_name},
        "target": {"id": f"discord-{rem['target_id']}", "name": target_name},
        "channel": ({"id": str(rem["channel_id"]), "name": getattr(channel, "name", "不明")}
                    if channel is not None else None),
        "canComplete": True, "canDelete": True,
    }


def _snapshot_item(rem: dict, names: dict, cog: Assistant) -> dict:
    creator = int(rem.get("creator_id") or 0)
    target = int(rem.get("target_id") or creator)
    channel = cog._channel(int(rem.get("channel_id") or 0)) if rem.get("channel_id") else None
    return {
        "id": rem["id"], "text": rem["text"], "due": rem["due"], "repeat": rem.get("repeat", "none"),
        "creator": {"id": f"discord-{creator}", "name": names.get(creator) or "Discordユーザー"},
        "target": {"id": f"discord-{target}", "name": names.get(target) or "Discordユーザー"},
        "channel": ({"id": str(rem["channel_id"]), "name": getattr(channel, "name", "不明")}
                    if rem.get("channel_id") else None),
    }
