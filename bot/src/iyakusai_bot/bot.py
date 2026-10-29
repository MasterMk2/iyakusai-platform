# -*- coding: utf-8 -*-
"""Bot 本体。Cog の組み立て・コマンド同期・ハートビート。"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks

from . import contact, mail_draft, org
from . import __version__
from .config import Config
from .lockfile import InstanceLock, LockBusy
from .reminders import Reminders
from .storage import ReminderStore

log = logging.getLogger("iyakusai.bot")


class IyakusaiBot(commands.Bot):
    def __init__(self, cfg: Config, lock: InstanceLock):
        intents = discord.Intents.default()
        # message_content は特権インテント。俳句検出(F5)が有効なときだけ要求する。
        # ※ポータル側の MESSAGE CONTENT INTENT は収集スクリプトで既に有効化済み(raw に本文がある)。
        #   有効化していない状態でこれを True にすると起動時に PrivilegedIntentsRequired で落ちる。
        if cfg.haiku_enabled:
            intents.message_content = True
        # 2026-10-14 セキュリティレビュー M-7: 既定で @everyone/@here・ロールを鳴らさない(個人宛・返信は従来どおり)。
        super().__init__(command_prefix="!iyk ", intents=intents,
                         allowed_mentions=discord.AllowedMentions(
                             everyone=False, roles=False, users=True, replied_user=True))
        self.cfg = cfg
        self.lock = lock
        self._synced = False
        # スラッシュコマンドの最終防波堤。各コマンド側の捕捉漏れをここで受ける
        # (2026-08-12 追加・レビュー#9)。__init__ で張るのは、setup_hook より前に
        # 起きた例外も拾えるようにするため(tree は super().__init__ で用意済み)。
        self.tree.on_error = self._on_app_command_error

    async def setup_hook(self):
        contact.set_contact(self.cfg.contact)
        mail_draft.set_address(self.cfg.mail_address)
        org.configure(self.cfg.org_name, self.cfg.org_campus, self.cfg.org_other_campuses,
                      self.cfg.org_keep_mail_domains)
        store = ReminderStore(self.cfg.data_dir)
        await self.add_cog(Reminders(self, store, self.cfg.reminder_check_sec))
        from .ai_provider import make_provider
        from .documents import Documents
        from .persona import PersonaStore, load_host_presets
        from .usage_log import UsageLog
        provider = make_provider(self.cfg)
        usage_log = UsageLog(self.cfg.data_dir)
        persona = PersonaStore(self.cfg.data_dir)
        # 個人の素材から作った口調はネタ帳と同じフォルダ(ドライブ外)から足す。/persona の選択肢より先に読む
        log.info("ホスト側の口調プリセット %d 件", load_host_presets(self.cfg.neta_dir))
        kb = None
        if self.cfg.knowledge_dir:
            from .knowledge import Knowledge
            from .knowledge_search import KnowledgeBase
            kb = KnowledgeBase(
                self.cfg.knowledge_dir,
                digest_roots=self.cfg.kn_digest_roots,
                blocklist=self.cfg.kn_blocklist,
                raw_blocklist=self.cfg.kn_raw_blocklist,
                discord_raw=self.cfg.kn_discord_raw,
                discord_raw_days=self.cfg.kn_discord_raw_days,
                vector=self.cfg.kn_vector,
                vector_min_score=self.cfg.kn_vector_min_score,
                vector_topk=self.cfg.kn_vector_topk,
            )
            await self.add_cog(Knowledge(self, kb, provider, usage_log, self.cfg.ai_usd_jpy,
                                         persona, self.cfg.neta_dir))
            log.info("ナレッジ検索を有効化 (provider=%s, model=%s)", self.cfg.ai_provider, self.cfg.ai_model)
        else:
            log.info("knowledge_dir 未設定のため /ask は無効")
        await self.add_cog(Documents(self, kb, provider, usage_log, self.cfg.ai_usd_jpy))
        # /image(Claude が SVG を書き、Pi で PNG にする・2026-10-14)。[image] enabled かつ AI が有効なときだけ。
        # 変換の部品・書体の点検は Cog が裏で行い、通るまでは「使えない」と返す(Bot の起動は止めない)。
        if self.cfg.image.enabled and provider is not None:
            from .images import Images
            await self.add_cog(Images(self, self.cfg.image, provider, usage_log, self.cfg.ai_usd_jpy))
        from .usage import Usage
        await self.add_cog(Usage(self, usage_log))
        if provider is not None:
            from .persona_cmd import Persona
            await self.add_cog(Persona(self, persona))
        # F5: 偶然の俳句(川柳)検出。AI不使用・純ロジック。SudachiPy が無ければ自動で無効
        if self.cfg.haiku_enabled:
            from .haiku import Haiku, HaikuStore
            await self.add_cog(Haiku(self, HaikuStore(self.cfg.data_dir), self.cfg))
        video_enabled = False
        if self.cfg.neta_video.get("enabled", False):
            from .neta_video import NetaVideo
            from .neta_video_core import VideoSettings
            settings = VideoSettings.from_mapping(self.cfg.neta_video)
            spool = Path(settings.spool_dir)
            for shared in (self.cfg.knowledge_dir, self.cfg.data_dir):
                if shared and spool.is_relative_to(shared.resolve()):
                    raise ValueError("neta_video.spool_dir must be outside shared data/search roots")
            await self.add_cog(NetaVideo(self, settings))
            video_enabled = settings.enabled
        from .task_store import TaskSettings
        task_settings = TaskSettings.from_mapping(
            self.cfg.tasks, shared_roots=(self.cfg.data_dir, self.cfg.knowledge_dir, self.cfg.mirror_dir))
        task_store = None
        if task_settings.enabled:
            from .task_cog import TaskCog
            from .task_store import TaskStore, TaskStoreUnavailable
            try:
                task_store = await asyncio.to_thread(TaskStore.open, task_settings.store_dir)
            except TaskStoreUnavailable as e:
                # 既存DBを初期化しない。/todo は停止状態で応答する
                log.error("タスク保存先を開けないため /todo を停止状態で登録: %s", e)
                task_store = None
            await self.add_cog(TaskCog(self, task_settings, task_store))
            # 定期タスクスクリーニングの候補を投稿・起票する。
            # 候補台帳を開けなくても /todo 本体は動かし続ける。
            screening = self.cfg.task_screening
            if task_store is not None and isinstance(screening, dict) and screening.get("enabled", False):
                from .screening_cog import make_cog
                try:
                    cog = await asyncio.to_thread(make_cog, self, screening, task_settings, task_store)
                except Exception as e:  # noqa: BLE001
                    log.error("タスク候補台帳を開けないため定期スクリーニングの投稿を停止: %s", type(e).__name__)
                else:
                    await self.add_cog(cog)
                    log.info("定期タスクスクリーニングの投稿を有効化")
        await self._setup_kiban(task_settings, task_store)
        # 統合アプリの「Bot」タブ(2026-10-14)。[assistant] enabled のときだけ読み込む。
        # ジョブ表を開けなくても Bot 本体は動かし続ける(/todo と同じ扱い)。
        if self.cfg.assistant.enabled:
            from .assistant_cog import Assistant
            from .assistant_store import AssistantStore
            try:
                assistant_store = await asyncio.to_thread(AssistantStore.open, self.cfg.assistant.store_path)
            except Exception as e:  # noqa: BLE001
                log.error("統合アプリ連携のジョブ表を開けないため Bot タブを停止: %s", type(e).__name__)
            else:
                await self.add_cog(Assistant(self, self.cfg.assistant, assistant_store,
                                             reminders=ReminderStore(self.cfg.data_dir)))
                log.info("統合アプリの Bot タブ連携を有効化")
        from .help import Help
        await self.add_cog(Help(self, ai_enabled=provider is not None,
                                haiku_enabled=self.cfg.haiku_enabled,
                                haiku_mode=self.cfg.haiku_mode, video_enabled=video_enabled,
                                tasks_enabled=task_settings.enabled,
                                assistant_enabled=self.get_cog("Assistant") is not None,
                                image_enabled=self.get_cog("Images") is not None))
        # F3: Discord 収集の常駐化(raw を最新化 → /ask の raw 検索に反映)
        if self.cfg.collect_enabled and self.cfg.knowledge_dir:
            from .collector import Collector
            script = self.cfg.knowledge_dir / "discord" / "tools" / "collect_discord_v2.py"
            await self.add_cog(Collector(self, script, self.cfg.collect_interval_min))
            log.info("Discord 収集を常駐化 (間隔=%d分, script=%s)",
                     self.cfg.collect_interval_min, script.name)
            # F8: 編集・削除を Gateway でリアルタイム記録(差分収集では拾えない穴を埋める)。
            # 収集が有効なときだけ意味があるので同じ条件下に置く。
            if self.cfg.edit_watch_enabled:
                from .edit_watch import EditWatch
                edits_file = self.cfg.knowledge_dir / "discord" / "raw" / "_edits.jsonl"
                await self.add_cog(EditWatch(self, edits_file))
                log.info("編集・削除の記録: 有効 (→ %s)", edits_file.name)
        self.heartbeat_loop.change_interval(seconds=self.cfg.heartbeat_sec)
        self.heartbeat_loop.start()

    async def _setup_kiban(self, task_settings, task_store) -> None:
        """基盤システム(統合アプリ)の写しを /ask の検索空間(ミラーの kiban/)に置く。2026-10-14

        補助機能なので、設定の誤りでも Bot 全体は止めない(ERROR を残して連携だけ止める)。
        無効・設定誤りのときは古い写しを消す(止まった写しが「いまの状態」として読まれないように)。
        """
        from .kiban import KibanConfigError, KibanSettings, KibanSync, load_key, remove_kiban
        mirror = self.cfg.mirror_dir
        try:
            settings = KibanSettings.from_mapping(
                self.cfg.kiban, shared_roots=(self.cfg.data_dir, self.cfg.knowledge_dir, mirror))
            key = load_key(settings.key_file) if settings.enabled and settings.key_file else None
        except KibanConfigError as e:
            log.error("基盤システムの写しを停止(設定の誤り): %s", e)
            settings, key = KibanSettings(), None
        if not settings.enabled or mirror is None:
            if mirror is not None and await asyncio.to_thread(remove_kiban, mirror):
                log.info("基盤システムの写し(ミラーの kiban/)を削除しました(連携が無効)")
            return
        list_tasks = None
        if settings.tasks and task_store is not None:
            from .task_domain import Scope

            def list_tasks():
                return [v for g in task_settings.guild_ids for v in task_store.list_tasks(Scope(g))]
        knowledge_dir = self.cfg.knowledge_dir

        def names():
            if not knowledge_dir:
                return {}
            from .knowledge_search import load_author_aliases
            return load_author_aliases(knowledge_dir)["by_id"]

        from .kiban_cog import KibanSyncCog
        sync = KibanSync(settings, mirror, list_tasks=list_tasks, names=names, key=key)
        await self.add_cog(KibanSyncCog(self, sync, settings.interval_sec))
        log.info("基盤システムの写しを有効化 (タスク=%s, アプリ=%s, 間隔=%d秒)",
                 "あり" if list_tasks else "なし", "/".join(settings.sources) or "なし", settings.interval_sec)

    async def _on_app_command_error(self, itx: discord.Interaction, error: Exception):
        """どのコマンドでも捕り漏らした例外を最後に受け止め、**必ず利用者に返す**。

        2026-08-12 追加(レビュー#9)。ここが無いと、コマンド内の想定外例外は
        discord.py のログに出るだけで、defer 済みの interaction は「考え中…」の
        まま腐る=利用者から見て完全な無応答になる(/ask の劣化ラダーが守っている
        「沈黙させない」を、コマンド全体に広げるための一枚)。
        **応答済みかどうかで送り口が違う**ので is_done() で分岐する(defer 済みなら
        followup、未応答なら response)。ここでの送信失敗はもう打つ手が無いので
        ログだけ残す(期限切れ・権限不足など)。
        """
        cmd = getattr(itx.command, "name", "?")
        # 権限拒否・クールダウンは「想定内の拒否」なので文面を分ける。現状この Bot の
        # 権限判定はコマンド本体の中で行っており(reminders.py)checks デコレータは
        # 使っていないため通常ここには来ないが、将来 checks を足したときに**正常な拒否が
        # 「想定外のエラー」と表示される**のを防ぐ。返さずに return すると今度は無応答に
        # なる(それがこの関数の防ごうとしている事象)ので、必ず何か返す。
        if isinstance(error, (app_commands.CheckFailure, app_commands.CommandOnCooldown)):
            log.info("/%s は実行条件を満たさず拒否: %s", cmd, error)
            msg = f"⚠️ このコマンドは実行できませんでした({error})。"
        else:
            log.error("/%s が想定外の例外で失敗(最終防波堤で捕捉)", cmd, exc_info=error)
            msg = ("⚠ コマンドの処理中に想定外のエラーが発生しました。"
                   "少し待って再実行してください"
                   + contact.ask_note())
        # /todo は全返答を本人だけ・メンション無しにする(コマンド本体より前の変換・署名不一致・
        # 未同期で command が None の場合も含む)。既存コマンドの返し方は変えない。
        root = getattr(itx.command, "root_parent", None) or itx.command
        data = itx.data if isinstance(getattr(itx, "data", None), dict) else {}
        is_todo = (getattr(root, "name", None) == "todo" if root is not None
                   else data.get("name") == "todo")
        extra = ({"ephemeral": True, "allowed_mentions": discord.AllowedMentions.none()}
                 if is_todo else {})
        try:
            if itx.response.is_done():
                await itx.followup.send(msg, **extra)
            else:
                await itx.response.send_message(msg, **extra)
        except discord.HTTPException as e:
            log.error("エラー通知の送信にも失敗(内容は届いていない): %s", e)
        except Exception:  # noqa: BLE001  ここで再送出すると discord.py 側で握られて沈黙する
            log.exception("エラー通知の送信で想定外の例外")

    async def on_ready(self):
        log.info("ログイン: %s (v%s, host=%s, mode=%s)",
                 self.user, __version__, self.cfg.host_name, self.cfg.mode)
        if not self._synced:
            for g in self.guilds:
                self.tree.copy_global_to(guild=g)
                cmds = await self.tree.sync(guild=g)
                log.info("コマンド同期: %s に %d 件", g.name, len(cmds))
            self._synced = True

    @tasks.loop(seconds=300)
    async def heartbeat_loop(self):
        try:
            self.lock.heartbeat()
        except LockBusy as e:
            # 別ホストに乗っ取られた → 二重稼働を避けるため自分が退く
            log.error("ロックを失いました(%s)。安全のため停止します。", e.holder.get("host"))
            await self.close()
        except OSError:
            # ドライブ同期の一時失敗などは次回ハートビートに賭ける
            log.warning("ハートビート書き込みに失敗(次回再試行)", exc_info=True)

    @heartbeat_loop.before_loop
    async def before_heartbeat(self):
        await self.wait_until_ready()
