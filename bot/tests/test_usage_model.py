# -*- coding: utf-8 -*-
"""/model（Bot の AI のモデルを見る・切り替える・2026-11-21）。合成の settings.json だけを使う。"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import discord  # noqa: E402
from discord import app_commands  # noqa: E402

from iyakusai_bot import ai_model  # noqa: E402
from iyakusai_bot.usage import Usage  # noqa: E402

GO = "https://opencode.ai/inference/go/anthropic"


class FakeResponse:
    def __init__(self):
        self.sent = []

    async def send_message(self, content=None, *, ephemeral=False, **kwargs):
        self.sent.append((content, ephemeral))


class FakeMember(discord.Member):
    """isinstance(itx.user, discord.Member) を通すための最小の偽物（discord.Member の初期化は通さない）。"""

    def __init__(self, uid, name, manage):  # noqa: D401  pylint: disable=super-init-not-called
        self._fake = SimpleNamespace(id=uid, display_name=name, guild_permissions=discord.Permissions(manage_guild=manage))

    id = property(lambda self: self._fake.id)
    display_name = property(lambda self: self._fake.display_name)
    guild_permissions = property(lambda self: self._fake.guild_permissions)


class ModelCommandTest(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.get("CLAUDE_CONFIG_DIR")
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.path = Path(d.name, "settings.json")
        self.path.write_text(json.dumps({"env": {"ANTHROPIC_BASE_URL": GO, "ANTHROPIC_AUTH_TOKEN": "synthetic-0123456789",
                                                 **{k: "gemini-4-argon" for k in ai_model.MODEL_KEYS}}}),
                             encoding="utf-8")
        os.environ["CLAUDE_CONFIG_DIR"] = d.name
        self.cog = Usage(SimpleNamespace(get_cog=lambda name: None), usage_log=None)

    def tearDown(self):
        if self.saved is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = self.saved

    def run_model(self, user, choice=None):
        itx = SimpleNamespace(user=user, response=FakeResponse())
        asyncio.run(Usage.model.callback(self.cog, itx, choice))
        return itx.response.sent

    def model_now(self):
        return json.loads(self.path.read_text(encoding="utf-8"))["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"]

    def test_without_a_choice_it_only_shows(self):
        sent = self.run_model(FakeMember(1, "委員", manage=False))
        self.assertIn("Gemini 4 Argon", sent[0][0])
        self.assertTrue(sent[0][1])
        self.assertEqual(self.model_now(), "gemini-4-argon")

    def test_non_officer_cannot_switch(self):
        sent = self.run_model(FakeMember(1, "委員", manage=False), app_commands.Choice(name="GLM-5.3", value="glm-5.3"))
        self.assertIn("役員", sent[0][0])
        self.assertEqual(self.model_now(), "gemini-4-argon")

    def test_officer_switches(self):
        sent = self.run_model(FakeMember(2, "役員", manage=True), app_commands.Choice(name="GLM-5.3", value="glm-5.3"))
        self.assertIn("GLM-5.3 に切り替えました", sent[0][0].replace("**", ""))
        self.assertEqual(self.model_now(), "glm-5.3")
        again = self.run_model(FakeMember(2, "役員", manage=True), app_commands.Choice(name="GLM-5.3", value="glm-5.3"))
        self.assertIn("もう", again[0][0])


if __name__ == "__main__":
    unittest.main()
