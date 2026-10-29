# -*- coding: utf-8 -*-
"""/image(images.py・svg_render.py)の試験。AI は偽物、Discord は WebInteraction と偽のチャンネル。

実際の変換(resvg_py)の試験は、変換用の python(環境変数 IYAKUSAI_TEST_RENDER_PYTHON。省略時は
この python)で resvg_py が読めて、書体のフォルダ(環境変数 IYAKUSAI_TEST_FONT_DIR。NotoSansJP-*.otf を
含む)があるときだけ動く。無ければ skip。Pi では本番と同じく Bot の venv と変換用の venv が別になる。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

import discord  # noqa: E402

from iyakusai_bot import images as IM  # noqa: E402
from iyakusai_bot.ai_provider import AIError, AIResult  # noqa: E402
from iyakusai_bot.config import ImageSettings  # noqa: E402
from iyakusai_bot.web_interaction import WebInteraction  # noqa: E402

GUILD, CHANNEL, ACTOR = 1000000000000000101, 1000000000000000102, 1000000000000000001
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
GOOD_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">'
            '<title>模擬店の値段表</title><rect width="1080" height="1080" fill="#ffd400"/>'
            '<text x="80" y="300" font-family="Dela Gothic One" font-size="120">焼きそば 300円</text></svg>')
FONT_DIR = os.environ.get("IYAKUSAI_TEST_FONT_DIR", "")
RENDER_PYTHON = os.environ.get("IYAKUSAI_TEST_RENDER_PYTHON", "") or sys.executable
HAVE_RESVG = subprocess.run([RENDER_PYTHON, "-I", "-c", "import resvg_py"], capture_output=True).returncode == 0
REAL = HAVE_RESVG and FONT_DIR and any(Path(FONT_DIR).glob("NotoSansJP-*"))


def result(text: str) -> AIResult:
    return AIResult(text=text, model="opus", usage={"input_tokens": 10, "output_tokens": 5})


class FakeProvider:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.prompts = []
        self.calls = []

    async def complete(self, prompt, model=None, timeout=None, effort=None):
        self.prompts.append(prompt)
        self.calls.append((model, effort))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return result(answer)


class FakeMaker(IM.ImageMaker):
    """変換だけ偽物(resvg を使わない)。"""

    def __init__(self, provider, settings, png=PNG, fail=None):
        super().__init__(provider, settings)
        self.png, self.fail, self.rendered = png, fail, []

    async def render(self, svg, width, height):
        self.rendered.append((svg, width, height))
        if self.fail:
            raise self.fail
        return self.png


class FakeMessage:
    def __init__(self, channel, mid, content, files):
        self.channel, self.id, self.content = channel, mid, content
        self.attachments = list(files)
        self.jump_url = f"https://discord.com/channels/{GUILD}/{channel.id}/{mid}"

    async def edit(self, content=None, attachments=None, **kwargs):
        if content is not None:
            self.content = content
        return self


class FakeChannel:
    def __init__(self):
        self.id, self.name = CHANNEL, "bottest"
        self.guild = SimpleNamespace(id=GUILD, me=SimpleNamespace(id=1))
        self.sent = []

    def permissions_for(self, member):
        return discord.Permissions(view_channel=True, send_messages=True)

    async def send(self, content=None, *, file=None, files=None, allowed_mentions=None, **kwargs):
        message = FakeMessage(self, 7000 + len(self.sent), content, [file] if file else list(files or []))
        self.sent.append(message)
        return message


class FakeUser:
    id, name, display_name, bot = ACTOR, "テスト委員", "テスト委員", False

    def __str__(self):   # discord.Member と同じく名前を返す(使用量の記帳に使う)
        return self.name


class FakeUsage:
    def __init__(self):
        self.records = []

    def record(self, command, user, res):
        self.records.append((command, user, res.model))


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="images-"))
        (self.dir / "fonts").mkdir()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def settings(self, **over):
        base = dict(enabled=True, model="opus", effort="", font_dir=self.dir / "fonts", work_dir=self.dir / "work",
                    render_python="", render_timeout_sec=60, daily_limit_per_user=2, max_concurrent=1)
        base.update(over)
        return ImageSettings(**base)

    def itx(self, channel):
        return WebInteraction(interaction_id="j_test", user=FakeUser(), channel=channel)


class MakerTests(Case):
    def test_good_svg_is_cleaned_sized_and_rendered(self):
        provider = FakeProvider("できました:\n```svg\n" + GOOD_SVG.replace('width="1080"', 'width="5000"', 1) + "\n```")
        maker = FakeMaker(provider, self.settings(effort="medium"))
        out = asyncio.run(maker.make("模擬店の値段表", "9:16", "sonnet"))
        self.assertEqual(out.png, PNG)
        self.assertEqual(out.title, "模擬店の値段表")
        self.assertEqual(len(out.results), 1)
        svg, width, height = maker.rendered[0]
        self.assertEqual((width, height), (900, 1600))
        self.assertIn('width="900" height="1600"', svg)
        self.assertEqual(provider.calls, [("sonnet", "medium")])
        self.assertIn("<<<\n模擬店の値段表\n>>>", provider.prompts[0])

    def test_unreadable_svg_is_retried_once_with_the_reason(self):
        provider = FakeProvider("描けませんでした", GOOD_SVG)
        maker = FakeMaker(provider, self.settings())
        out = asyncio.run(maker.make("看板", "1:1", "opus"))
        self.assertEqual(len(out.results), 2)
        self.assertIn("SVG が見つかりませんでした", provider.prompts[1])

    def test_two_bad_answers_fail_with_both_results_for_the_usage_log(self):
        maker = FakeMaker(FakeProvider("いいえ", '<svg xmlns="http://www.w3.org/2000/svg"><rect'), self.settings())
        with self.assertRaises(IM.ImageFailure) as error:
            asyncio.run(maker.make("看板", "1:1", "opus"))
        self.assertEqual(error.exception.code, "BAD_SVG")
        self.assertEqual(len(error.exception.results), 2)
        self.assertEqual(maker.rendered, [])

    def test_ai_error_keeps_the_earlier_results(self):
        maker = FakeMaker(FakeProvider("いいえ", AIError("枠切れ", kind="rate_limit")), self.settings())
        with self.assertRaises(AIError) as error:
            asyncio.run(maker.make("看板", "1:1", "opus"))
        self.assertEqual(len(error.exception.results), 1)

    def test_self_check_needs_the_japanese_face(self):
        maker = FakeMaker(FakeProvider(), self.settings())
        self.assertIn("Noto Sans JP", asyncio.run(maker.self_check()))
        (self.dir / "fonts" / "NotoSansJP-Regular.otf").write_bytes(b"x")
        self.assertIsNone(asyncio.run(maker.self_check()))
        broken = FakeMaker(FakeProvider(), self.settings(), fail=IM.ImageFailure("RENDER_FAILED", "変換に失敗"))
        self.assertEqual(asyncio.run(broken.self_check()), "変換に失敗")


class RendererProcessTests(Case):
    """svg_render.py を本番と同じ `python -I` の子プロセスで動かす。"""

    def run_script(self, payload: bytes):
        script = SRC / "iyakusai_bot" / "svg_render.py"
        return subprocess.run([sys.executable, "-I", str(script)], input=payload, capture_output=True, timeout=60)

    def test_bad_input_exits_2_with_a_reason(self):
        done = self.run_script(b"not json")
        self.assertEqual(done.returncode, 2)
        self.assertIn("入力が読めません", done.stderr.decode("utf-8"))
        done = self.run_script(json.dumps({"svg": "<svg/>", "width": 99999, "height": 10, "font_dir": ".",
                                           "resources_dir": "."}).encode())
        self.assertEqual(done.returncode, 2)

    @unittest.skipUnless(REAL, "resvg_py と書体(IYAKUSAI_TEST_FONT_DIR)が無い")
    def test_real_render_of_japanese_text(self):
        maker = IM.ImageMaker(FakeProvider(), self.settings(font_dir=Path(FONT_DIR), render_python=RENDER_PYTHON))
        from iyakusai_bot import image_logic as IL
        clean = IL.sanitize_svg(GOOD_SVG, 1080, 1080)
        png = asyncio.run(maker.render(clean.svg, 1080, 1080))
        self.assertTrue(png.startswith(IM.PNG_MAGIC))
        self.assertEqual(struct.unpack(">II", png[16:24]), (1080, 1080))
        self.assertIsNone(asyncio.run(maker.self_check()))
        self.assertFalse(any((self.dir / "work").iterdir()))   # 作業フォルダは毎回消える

    @unittest.skipUnless(REAL, "resvg_py と書体(IYAKUSAI_TEST_FONT_DIR)が無い")
    def test_a_local_file_named_in_the_svg_never_reaches_the_png(self):
        """resvg は <image href> の手元のパスを読む(2026-10-14 実測)。無害化を通すと読まれないこと。"""
        secret = self.dir / "secret.png"
        raw = b"".join(b"\x00" + b"\xff\x00\x00" * 8 for _ in range(8))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        secret.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
        path = secret.as_posix()
        attack = (f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" '
                  f'fill="#fff"/><image href="{path}" width="64" height="64"/>'
                  f'<filter id="f"><feImage href="{path}"/></filter><rect width="64" height="64" filter="url(#f)" '
                  f'opacity="0"/></svg>')
        blank = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/></svg>'
        maker = IM.ImageMaker(FakeProvider(), self.settings(font_dir=Path(FONT_DIR), render_python=RENDER_PYTHON))
        from iyakusai_bot import image_logic as IL
        raw_png = asyncio.run(maker.render(attack, 64, 64))   # 無害化しないと読まれる(前提の確認)
        cleaned = asyncio.run(maker.render(IL.sanitize_svg(attack, 64, 64).svg, 64, 64))
        expected = asyncio.run(maker.render(IL.sanitize_svg(blank, 64, 64).svg, 64, 64))
        self.assertNotEqual(raw_png, expected)
        self.assertEqual(cleaned, expected)


class CogTests(Case):
    def cog(self, maker, **over):
        settings = self.settings(**over)
        cog = IM.Images(SimpleNamespace(), settings, maker.provider, FakeUsage(), 160.0, maker=maker,
                        today=lambda: self.today)
        cog.ready = True
        return cog

    def setUp(self):
        super().setUp()
        self.today = "2026-10-14"

    def test_posts_the_png_and_the_svg_with_a_note(self):
        channel = FakeChannel()
        maker = FakeMaker(FakeProvider(GOOD_SVG), self.settings())
        cog = self.cog(maker)
        itx = self.itx(channel)
        aspect = discord.app_commands.Choice(name="縦長", value="9:16")
        asyncio.run(cog.image.callback(cog, itx, "模擬店の値段表", aspect))
        self.assertEqual(len(channel.sent), 1)
        self.assertEqual([f.filename for f in channel.sent[0].attachments], ["image.png", "image.svg"])
        self.assertIn("🎨 **模擬店の値段表**(縦長(9:16)・Claude が描いた図)", channel.sent[0].content)
        self.assertIn("写真風・写実的な絵は作れません", channel.sent[0].content)
        self.assertEqual([f.name for f in itx.files], ["image.png", "image.svg"])
        self.assertEqual(cog.usage_log.records, [("/image", "テスト委員", "opus")])
        self.assertEqual(maker.rendered[0][1:], (900, 1600))

    def test_daily_limit_counts_successes_and_refunds_failures(self):
        channel = FakeChannel()
        maker = FakeMaker(FakeProvider(GOOD_SVG, "だめ", "だめ", GOOD_SVG, GOOD_SVG), self.settings())
        cog = self.cog(maker, daily_limit_per_user=2)

        def run():
            itx = self.itx(channel)
            asyncio.run(cog.image.callback(cog, itx, "看板", None))
            return itx
        run()                                   # 1 枚目(成功)
        failed = run()                          # 2 回とも読めない → 失敗。枚数は戻す
        self.assertIn("画像にできませんでした", failed.answer_text())
        self.assertTrue(cog.has_quota(ACTOR))
        run()                                   # 2 枚目(成功)
        self.assertFalse(cog.has_quota(ACTOR))
        over = run()                            # 3 枚目は本人だけの断り。投稿しない
        self.assertIn("1 日 2 枚まで", over.ephemeral_text())
        self.assertEqual(len([m for m in channel.sent if m.attachments]), 2)
        self.today = "2026-10-15"               # 日が変われば数え直し
        self.assertTrue(cog.has_quota(ACTOR))

    def test_refuses_quietly_when_not_ready_or_the_request_is_empty_or_long(self):
        channel = FakeChannel()
        maker = FakeMaker(FakeProvider(), self.settings())
        cog = self.cog(maker)
        for text, expect in (("   ", "説明を入力"), ("あ" * 1001, "1000 字まで")):
            itx = self.itx(channel)
            asyncio.run(cog.image.callback(cog, itx, text, None))
            self.assertIn(expect, itx.ephemeral_text())
        cog.ready = False
        itx = self.itx(channel)
        asyncio.run(cog.image.callback(cog, itx, "看板", None))
        self.assertIn("いま使えません", itx.ephemeral_text())
        self.assertEqual(channel.sent, [])
        self.assertEqual(maker.provider.prompts, [])

    def test_render_failure_is_reported_and_refunded(self):
        channel = FakeChannel()
        maker = FakeMaker(FakeProvider(GOOD_SVG), self.settings(),
                          fail=IM.ImageFailure("RENDER_TIMEOUT", "画像への変換が時間内に終わりませんでした。"))
        cog = self.cog(maker, daily_limit_per_user=1)
        itx = self.itx(channel)
        asyncio.run(cog.image.callback(cog, itx, "看板", None))
        self.assertIn("時間内に終わりませんでした", itx.answer_text())
        self.assertEqual(itx.files, [])
        self.assertTrue(cog.has_quota(ACTOR))
        self.assertEqual(len(cog.usage_log.records), 1)   # AI は使ったので記帳はする

    def test_ai_failure_message_reaches_the_user(self):
        channel = FakeChannel()
        maker = FakeMaker(FakeProvider(AIError("AI応答がタイムアウト(180秒)")), self.settings())
        cog = self.cog(maker)
        itx = self.itx(channel)
        asyncio.run(cog.image.callback(cog, itx, "看板", None))
        self.assertIn("画像の作成に失敗しました", itx.answer_text())
        self.assertTrue(cog.has_quota(ACTOR))

    def test_model_and_effort_come_from_the_settings(self):
        maker = FakeMaker(FakeProvider(GOOD_SVG), self.settings(effort="low"))
        cog = self.cog(maker)
        asyncio.run(cog.image.callback(cog, self.itx(FakeChannel()), "看板", None))
        self.assertEqual(maker.provider.calls, [("opus", "low")])
        self.assertNotIn("モデル", [p.name for p in cog.image.parameters])

    def test_self_check_turns_the_cog_on(self):
        (self.dir / "fonts" / "NotoSansJP-Regular.otf").write_bytes(b"x")
        maker = FakeMaker(FakeProvider(), self.settings())
        cog = IM.Images(SimpleNamespace(), self.settings(), maker.provider, maker=maker)
        self.assertFalse(cog.available())
        asyncio.run(cog._self_check())
        self.assertTrue(cog.available())


if __name__ == "__main__":
    unittest.main()
