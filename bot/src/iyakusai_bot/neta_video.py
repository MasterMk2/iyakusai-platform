"""/ネタ動画: private reply; allowlisted invocation; isolated local renderer."""
from __future__ import annotations

import asyncio
import io
import logging

import discord
from discord import app_commands
from discord.ext import commands

from .neta_video_core import VideoError, VideoQueue, VideoSettings

log = logging.getLogger("iyakusai.neta_video")
ERRORS = {
    "text_length": "文言は80文字以内で指定してください。",
    "text_lines": "空でない文言を3行以内で指定してください。",
    "text_control": "制御文字を含む文言は使えません。",
    "template_invalid": "そのテンプレートは使えません。",
    "already_pending": "あなたの動画を処理中です。完成を待つか、キャンセルしてください。",
    "cooldown": "少し待ってから再度指定してください。",
    "queue_full": "動画の待ち行列がいっぱいです。少し待って再度指定してください。",
    "queue_timeout": "待ち時間の上限に達しました。時間をおいて再度指定してください。",
    "render_timeout": "動画生成の時間上限に達したため停止しました。",
    "cancelled": "動画生成をキャンセルしました。",
    "disabled": "ネタ動画は現在停止中です。",
    "video_size": "動画が添付サイズの上限に収まりませんでした。",
}


class NetaVideo(commands.Cog):
    def __init__(self, bot: commands.Bot, settings: VideoSettings, manager: VideoQueue | None = None):
        self.bot = bot; self.settings = settings
        self.manager = manager or VideoQueue(settings)

    async def cog_unload(self):
        await self.manager.close()

    async def _send(self, itx, message: str, **kwargs):
        try:
            if itx.response.is_done():
                return await itx.followup.send(message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none(), **kwargs)
            return await itx.response.send_message(message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none(), **kwargs)
        except Exception as error:
            # Interaction tokens and titles are never copied to logs.
            log.warning("ネタ動画の通知が届かなかった: %s", type(error).__name__)
            return None

    @app_commands.command(name="ネタ動画", description="短い文言を壮大なファンファーレ付き動画にする（本人に返却）")
    @app_commands.guild_only()
    @app_commands.describe(文言="80文字・3行以内。\\nで改行。絵文字は文字表記に変換", テンプレート="動画の演出")
    @app_commands.choices(テンプレート=[app_commands.Choice(name="壮大なファンファーレ", value="fanfare")])
    async def neta_video(self, itx: discord.Interaction, 文言: app_commands.Range[str, 1, 80],
                         テンプレート: app_commands.Choice[str] | None = None):
        if not self.settings.allows(itx.guild_id, itx.channel_id):
            await self._send(itx, "この場所ではネタ動画を使えません。")
            return
        job = None
        try:
            # Acknowledge before process launch; no collector/model/Drive call.
            await itx.response.defer(thinking=True, ephemeral=True)
            limit = min(self.settings.max_bytes, getattr(itx.guild, "filesize_limit", self.settings.max_bytes))
            job = self.manager.submit(itx.guild_id, itx.user.id, 文言,
                                      テンプレート.value if テンプレート else "fanfare", max_bytes=limit)
            await self._send(itx, f"動画を受け付けました。完成するとここへ返します。\nキャンセル: `/ネタ動画キャンセル id:{job.id}`")
            result = await asyncio.shield(job.future)
            note = "完成しました。" + (" 絵文字は文字表記に変換しました。" if result.emoji_replaced else "")
            attachment = discord.File(io.BytesIO(result.data), filename=result.filename)
            try:
                await self._send(itx, note, file=attachment)
            finally:
                attachment.close()
        except VideoError as error:
            await self._send(itx, ERRORS.get(str(error), "動画を生成できませんでした。設定を確認するか、時間をおいて再度指定してください。"))
        except asyncio.CancelledError:
            if job:
                self.manager.cancel(job.id, itx.guild_id, itx.user.id)
            raise
        except Exception as error:
            log.warning("ネタ動画の処理に失敗: %s", type(error).__name__)
            if job:
                self.manager.cancel(job.id, itx.guild_id, itx.user.id)
            await self._send(itx, "動画の処理に失敗しました。時間をおいて再度指定してください。")

    @app_commands.command(name="ネタ動画キャンセル", description="自分が依頼した動画の待機・生成を止める")
    @app_commands.guild_only()
    @app_commands.describe(id="受付に表示された動画ID")
    async def cancel_video(self, itx: discord.Interaction, id: app_commands.Range[str, 16, 16]):
        if not self.settings.allows(itx.guild_id, itx.channel_id):
            await self._send(itx, "この場所ではネタ動画を使えません。")
            return
        changed = self.manager.cancel(id, itx.guild_id, itx.user.id)
        await self._send(itx, "停止を受け付けました。" if changed else "キャンセルできる自分の動画が見つかりません。")
