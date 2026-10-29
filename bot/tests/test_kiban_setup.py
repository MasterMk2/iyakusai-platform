# -*- coding: utf-8 -*-
"""Bot 起動時の配線(IyakusaiBot._setup_kiban)の試験。discord.py が無い環境では飛ばす。"""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

try:
    from iyakusai_bot.bot import IyakusaiBot
    from iyakusai_bot.kiban_cog import KibanSyncCog
except ModuleNotFoundError:  # discord.py 未導入
    IyakusaiBot = None

from iyakusai_bot import task_domain as D  # noqa: E402
from iyakusai_bot import task_store as S  # noqa: E402

G = 9001


@unittest.skipIf(IyakusaiBot is None, "discord.py が無い")
class SetupTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="kiban-setup-"))
        self.mirror = self.dir / "mirror"
        self.knowledge = self.dir / "knowledge"
        (self.knowledge / "discord" / "raw").mkdir(parents=True)
        (self.knowledge / "discord" / "raw" / "_authors.json").write_text(
            '{"people": {"100000000000000001": {"nick": "医薬 花子"}}}', encoding="utf-8")
        self.cogs = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def fake(self, kiban: dict):
        async def add_cog(cog):
            self.cogs.append(cog)
        cfg = SimpleNamespace(kiban=kiban, mirror_dir=self.mirror, data_dir=self.dir / "data",
                              knowledge_dir=self.knowledge)
        return SimpleNamespace(cfg=cfg, add_cog=add_cog)

    def run_setup(self, kiban, task_settings=None, task_store=None):
        bot = self.fake(kiban)
        asyncio.run(IyakusaiBot._setup_kiban(bot, task_settings or S.TaskSettings(), task_store))

    def test_disabled_removes_old_copy(self):
        (self.mirror / "kiban").mkdir(parents=True)
        (self.mirror / "kiban" / "tasks.md").write_text("old", encoding="utf-8")
        self.run_setup({"enabled": False})
        self.assertEqual(self.cogs, [])
        self.assertFalse((self.mirror / "kiban").exists())

    def test_config_error_does_not_stop_bot(self):
        (self.mirror / "kiban").mkdir(parents=True)
        with self.assertLogs("iyakusai.bot", "ERROR"):
            self.run_setup({"enabled": True, "app_url": "http://example.invalid"})
        self.assertEqual(self.cogs, [])
        self.assertFalse((self.mirror / "kiban").exists())

    def test_tasks_only_end_to_end(self):
        store_dir = self.dir / "tasks"
        store = S.TaskStore.open(store_dir)
        store.create(D.Actor(100000000000000001, "op-00000001", "discord"), D.Scope(G, 1),
                     title="配線の確認", tags=["system"], assignee_id=100000000000000001)
        settings = S.TaskSettings(enabled=True, guild_ids=(G,), store_dir=store_dir)
        self.run_setup({"enabled": True}, settings, store)
        self.assertEqual(len(self.cogs), 1)
        cog = self.cogs[0]
        self.assertIsInstance(cog, KibanSyncCog)
        self.assertEqual(cog.sync.run_once(), {"tasks": "成功", "rental": "未設定", "mailbox": "未設定"})
        text = (self.mirror / "kiban" / "tasks.md").read_text(encoding="utf-8")
        self.assertIn("#1 配線の確認", text)
        self.assertIn("担当: 医薬 花子", text)
        self.assertIn("部局: システム課", text)


if __name__ == "__main__":
    unittest.main()
