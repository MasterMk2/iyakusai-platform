# -*- coding: utf-8 -*-
"""/image — Claude が図・ポスター風の画像を描く(2026-10-14 追加)。

Claude は画像(ピクセル)そのものを出力できないので、SVG(図を描くコード)を書かせて Pi で PNG にする
(画像の生成も文章と同じ Claude で行う)。得意なのはポスター・案内図・看板・
値段表・図解など、文字と図形の組み合わせ。写真風・写実的なイラストは作れない(説明と回答にそう書く)。

流れ: 依頼文 → claude -p(one-shot・ツールは全部無効)→ SVG を取り出す → 無害化(image_logic)
      → 子プロセスで PNG に変換(svg_render.py)→ PNG と SVG(編集用)を添付して返す。
読めない SVG が返ったら、理由を添えて 1 回だけ書き直してもらう。
統合アプリの「画像」は assistant_cog がこの image コマンドの本体を WebInteraction 越しに呼ぶ
(Discord と同じ処理・同じ 1 日の上限)。ログに依頼の中身は出さない(種類・寸法・時間だけ)。
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

from . import image_logic as IL
from . import remind_logic as rl
from .ai_provider import AIError, AIResult, elapsed_note
from .config import ImageSettings
from .knowledge import safe_send

log = logging.getLogger("iyakusai.images")

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_PNG_BYTES = 20 * 1024 * 1024
# 順番待ちの上限。最悪の合計 = 待ち 300 + AI 180 秒([ai] timeout_sec)×2 回 + 変換 60×2 = 780 秒で、
# Discord の応答期限(defer から 15 分)の内側に収める
QUEUE_WAIT_SEC = 300
ATTEMPTS = 2                   # 読めない SVG のときの書き直しは 1 回だけ
_SELF_CHECK_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
                   '<rect width="64" height="64" fill="#fff"/>'
                   '<text x="4" y="44" font-family="Noto Sans JP" font-size="40">医</text></svg>')

ASPECT_CHOICES = [app_commands.Choice(name=label, value=key) for key, label in IL.ASPECT_LABELS.items()]
UNAVAILABLE = "⚠️ 画像の作成はいま使えません(Bot の準備ができていません)。"


class ImageFailure(Exception):
    """利用者に返す失敗(日本語)。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ImageOutput:
    png: bytes
    svg: str
    title: str
    model: str
    removed: int
    results: list[AIResult] = field(default_factory=list)   # 使用量の記帳用(書き直した分も含む)


class ImageMaker:
    """AI に SVG を書かせ、無害化して PNG にする(Discord に触らない部分)。"""

    def __init__(self, provider, settings: ImageSettings, *, script: Path | None = None):
        self.provider = provider
        self.settings = settings
        self.script = Path(script) if script else Path(__file__).with_name("svg_render.py")
        self.python = settings.render_python or sys.executable

    async def render(self, svg: str, width: int, height: int) -> bytes:
        """子プロセスで PNG にする。作業場所は毎回新しい空のフォルダ(resources_dir に使う)。"""
        base = Path(self.settings.work_dir)
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="render-", dir=base))
        payload = json.dumps({"svg": svg, "width": width, "height": height,
                              "font_dir": str(self.settings.font_dir), "resources_dir": str(work)},
                             ensure_ascii=False).encode("utf-8")
        try:
            try:
                proc = await asyncio.create_subprocess_exec(
                    self.python, "-I", str(self.script),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, cwd=str(work))
            except OSError as error:
                log.error("/image 変換の起動に失敗: %s", type(error).__name__)
                raise ImageFailure("RENDER_FAILED", "画像への変換を始められませんでした。") from None
            try:
                out, err = await asyncio.wait_for(proc.communicate(payload),
                                                  timeout=self.settings.render_timeout_sec)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except (ProcessLookupError, asyncio.TimeoutError):
                    pass
                raise ImageFailure("RENDER_TIMEOUT",
                                   "画像への変換が時間内に終わりませんでした。もっと簡単な絵で試してください。") from None
        finally:
            shutil.rmtree(work, ignore_errors=True)
        if proc.returncode != 0:
            reason = err.decode("utf-8", "replace").strip().splitlines()[:1]
            log.warning("/image 変換に失敗 code=%s: %s", proc.returncode, (reason or ["(理由なし)"])[0][:200])
            raise ImageFailure("RENDER_FAILED", "画像への変換に失敗しました。もう一度試してください。")
        if not out.startswith(PNG_MAGIC):
            raise ImageFailure("RENDER_FAILED", "画像への変換で PNG ができませんでした。")
        if len(out) > MAX_PNG_BYTES:
            raise ImageFailure("TOO_LARGE", "画像が大きすぎました(20 MB まで)。もっと簡単な絵で試してください。")
        return out

    async def make(self, request: str, aspect: str, model: str) -> ImageOutput:
        width, height = IL.size_for(aspect)
        prompt = IL.build_image_prompt(request, aspect)
        results: list[AIResult] = []
        reason = ""
        for attempt in range(1, ATTEMPTS + 1):
            # effort は "" なら provider が [ai] effort を使う。AIError は呼び出し側へ(記帳は済ませる)
            try:
                res = await self.provider.complete(prompt, model, effort=self.settings.effort)
            except AIError as error:
                error.results = results   # 1 回目の分の記帳を失わない
                raise
            results.append(res)
            try:
                clean = IL.sanitize_svg(IL.extract_svg(res.text), width, height)
            except IL.SvgError as error:
                reason = error.message
                log.info("/image %d 回目の出力は画像にできない: %s", attempt, reason)
                prompt = IL.build_retry_prompt(request, aspect, reason)
                continue
            try:
                png = await self.render(clean.svg, width, height)
            except ImageFailure as error:
                error.results = results   # AI は使ったので記帳は残す
                raise
            return ImageOutput(png=png, svg=clean.svg, title=IL.title_for(clean, request), model=model,
                               removed=clean.removed, results=results)
        failure = ImageFailure("BAD_SVG", f"Claude の出力を画像にできませんでした({reason})。"
                                          "依頼を短くして、もう一度試してください。")
        failure.results = results
        raise failure

    async def self_check(self) -> str | None:
        """変換の部品・書体がそろっているか(起動時に 1 回)。問題があれば理由、無ければ None。"""
        font_dir = Path(self.settings.font_dir)
        try:
            if not any(font_dir.glob("NotoSansJP-*")):
                return f"書体(Noto Sans JP)が {font_dir} にありません"
        except OSError as error:
            return f"書体のフォルダを読めません: {type(error).__name__}"
        try:
            await self.render(_SELF_CHECK_SVG, 64, 64)
        except ImageFailure as error:
            return error.message
        return None


class Images(commands.Cog):
    def __init__(self, bot: commands.Bot, settings: ImageSettings, provider, usage_log=None,
                 usd_jpy: float = 160.0, *, maker: ImageMaker | None = None, today=None):
        self.bot = bot
        self.settings = settings
        self.provider = provider
        self.usage_log = usage_log
        self.usd_jpy = usd_jpy
        self.maker = maker or (ImageMaker(provider, settings) if provider is not None else None)
        self.ready = False   # 起動時の点検が通るまで使わない(capabilities にも出さない)
        self._sem = asyncio.Semaphore(settings.max_concurrent)
        self._counts: dict[tuple[str, int], int] = {}
        self._today = today or (lambda: rl.now_jst().date().isoformat())
        self._check_task: asyncio.Task | None = None

    async def cog_load(self):
        # 点検は裏で走らせる(変換が固まっても Bot の起動を止めない)
        self._check_task = asyncio.create_task(self._self_check())

    async def cog_unload(self):
        if self._check_task is not None:
            self._check_task.cancel()

    async def _self_check(self) -> None:
        if self.maker is None:
            log.warning("/image: AI が無効のため使えません")
            return
        problem = await self.maker.self_check()
        if problem:
            log.error("/image を停止(点検に失敗): %s", problem)
            return
        self.ready = True
        log.info("/image を有効化 (model=%s, 1人1日%d枚, 同時%d枚)",
                 self.settings.model, self.settings.daily_limit_per_user, self.settings.max_concurrent)

    def available(self) -> bool:
        return self.maker is not None and self.ready

    # ---- 1 人 1 日の上限(Discord とアプリの合計。再起動で数え直し) ----

    def _reserve(self, user_id: int) -> bool:
        today = self._today()
        for key in [k for k in self._counts if k[0] != today]:
            del self._counts[key]
        key = (today, int(user_id))
        if self._counts.get(key, 0) >= self.settings.daily_limit_per_user:
            return False
        self._counts[key] = self._counts.get(key, 0) + 1
        return True

    def has_quota(self, user_id: int) -> bool:
        """今日まだ作れるか(数えない。アプリの依頼で #bottest に投稿する前の確認用)。"""
        return self._counts.get((self._today(), int(user_id)), 0) < self.settings.daily_limit_per_user

    def _refund(self, user_id: int) -> None:
        key = (self._today(), int(user_id))
        if self._counts.get(key, 0) > 0:
            self._counts[key] -= 1

    def _record(self, user, results) -> None:
        if not self.usage_log:
            return
        for res in results or []:
            try:
                self.usage_log.record("/image", str(user), res)
            except Exception as error:  # noqa: BLE001  記帳は落ちてよい・画像は落とさない
                log.warning("使用量の記帳に失敗(送信を優先・記帳のみ欠落): %s", type(error).__name__)

    @app_commands.command(name="image", description="Claude が図・ポスター風の画像を描く(写真風・写実的な絵は不可)")
    @app_commands.describe(
        説明="どんな画像か(例: 模擬店の値段表。焼きそば300円・フランク200円。赤と黄色で元気に)",
        縦横比="画像の形(既定: 正方形)",
    )
    @app_commands.choices(縦横比=ASPECT_CHOICES)
    async def image(
        self,
        itx: discord.Interaction,
        説明: str,
        縦横比: app_commands.Choice[str] | None = None,
    ):
        # モデル・考える深さは選ばせない([image] の設定どおり)。アプリと同じ動きにし、Pi での実測
        # (2026-10-14: opus・low 27〜31 秒、opus・既定 111 秒、sonnet・既定 140〜180 秒超)で
        # 時間切れになりにくい組み合わせに固定するため。
        if not self.available():
            await itx.response.send_message(UNAVAILABLE, ephemeral=True)
            return
        request = IL.clean_request(説明)
        if not request:
            await itx.response.send_message("⚠️ どんな画像か、説明を入力してください。", ephemeral=True)
            return
        if len(request) > IL.PROMPT_MAX:
            await itx.response.send_message(f"⚠️ 説明は {IL.PROMPT_MAX} 字までです。短くしてから送ってください。",
                                            ephemeral=True)
            return
        aspect = 縦横比.value if 縦横比 and 縦横比.value in IL.ASPECT_SIZES else "1:1"
        model = self.settings.model
        user_id = itx.user.id
        if not self._reserve(user_id):
            await itx.response.send_message(
                f"⚠️ 画像は 1 人 1 日 {self.settings.daily_limit_per_user} 枚までです。明日また使ってください。",
                ephemeral=True)
            return
        await itx.response.defer(thinking=True)
        t0 = time.time()
        out = None
        try:
            try:
                await asyncio.wait_for(self._sem.acquire(), timeout=QUEUE_WAIT_SEC)
            except asyncio.TimeoutError:
                await safe_send(itx, "⚠️ 画像の作成が混み合っています。少し待ってから、もう一度依頼してください。")
                return
            try:
                out = await self.maker.make(request, aspect, model)
            finally:
                self._sem.release()
        except AIError as error:
            self._record(itx.user, getattr(error, "results", None))
            log.warning("/image AI失敗: kind=%s", getattr(error, "kind", "?"))
            await safe_send(itx, f"⚠️ 画像の作成に失敗しました({error})。時間をおいて再試行してください。")
            return
        except ImageFailure as error:
            self._record(itx.user, getattr(error, "results", None))
            log.info("/image 失敗: %s", error.code)
            await safe_send(itx, f"⚠️ {error.message}")
            return
        finally:
            if out is None:
                self._refund(user_id)
        self._record(itx.user, out.results)
        last = out.results[-1]
        log.info("/image 完了: 縦横比=%s model=%s %d回 %dKB %.1f秒 by %s", aspect, out.model, len(out.results),
                 len(out.png) // 1024, time.time() - t0, itx.user)
        note = (
            f"🎨 **{out.title}**({IL.ASPECT_LABELS[aspect]}・Claude が描いた図)\n"
            + ("-# 安全のため、外部を読み込む部分などを取り除いて描きました。\n" if out.removed else "")
            + "-# 写真風・写実的な絵は作れません。文字・数字・日付は使う前に必ず確認してください。"
              "編集用の SVG も付けています。\n"
            f"-# model: {out.model} / {last.tokens_note()} / {last.cost_note(self.usd_jpy)} / {elapsed_note(t0)}"
        )
        files = [discord.File(io.BytesIO(out.png), filename="image.png"),
                 discord.File(io.BytesIO(out.svg.encode("utf-8")), filename="image.svg")]
        await safe_send(itx, note, files=files)
