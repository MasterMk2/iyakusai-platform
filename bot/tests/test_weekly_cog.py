"""週1回の一覧の Discord の口(weekly_cog)のうち、Discord に接続しないで試せる部分の試験。合成データだけ。

- 投稿先: @everyone から見えるチャンネルは使わない(一覧の中身が委員以外にも見えるため)
- 決定・変更の読み取り: 何で失敗しても節を省いて続く(その週の一覧が出ないまま止まらない)
"""

from __future__ import annotations

import asyncio
import http.client
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import discord  # noqa: E402

from iyakusai_bot import weekly_cog as WC  # noqa: E402
from iyakusai_bot.kiban import KibanFetchError  # noqa: E402
from iyakusai_bot.task_domain import JST  # noqa: E402
from iyakusai_bot.task_store import TaskSettings  # noqa: E402
from iyakusai_bot.weekly_logic import WeeklySettings  # noqa: E402
from iyakusai_bot.weekly_service import WeeklyService  # noqa: E402
from iyakusai_bot.weekly_store import WeeklyStateStore  # noqa: E402

GUILD = 9000000000000001
CHANNEL = 9000000000000002
MONDAY_0840 = datetime(2026, 11, 2, 8, 40, tzinfo=JST)
KIBAN_LINKED = {"enabled": True, "tasks": False, "app_url": "https://app.example.test"}


def _cog(folder: Path, *, kiban=None, channel=None) -> WC.WeeklyCog:
    cfg = SimpleNamespace(kiban=kiban, data_dir=None, knowledge_dir=None, mirror_dir=None, notify=None)
    bot = SimpleNamespace(cfg=cfg, get_channel=lambda channel_id: channel)
    return WC.WeeklyCog(bot, WeeklySettings.from_mapping({"channel_id": CHANNEL}),
                        TaskSettings(enabled=True, guild_ids=(GUILD,)), None, folder)


def _text_channel(*, everyone_sees: bool):
    role = SimpleNamespace(name="@everyone")
    guild = SimpleNamespace(id=GUILD, me=SimpleNamespace(name="bot"), default_role=role)
    channel = mock.Mock(spec=discord.TextChannel)
    channel.id = CHANNEL
    channel.guild = guild

    def permissions_for(target):
        if target is role:
            return SimpleNamespace(view_channel=everyone_sees, send_messages=False)
        return SimpleNamespace(view_channel=True, send_messages=True)

    channel.permissions_for = permissions_for
    return channel


class PostingChannelTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.cog = _cog(Path(self._dir.name))

    def tearDown(self):
        self._dir.cleanup()

    def test_a_channel_hidden_from_everyone_is_accepted(self):
        channel = _text_channel(everyone_sees=False)
        self.cog.bot.get_channel = lambda channel_id: channel
        self.assertEqual(self.cog._check_channel(CHANNEL, "一覧"), GUILD)

    def test_a_channel_visible_to_everyone_is_refused_with_an_error(self):
        channel = _text_channel(everyone_sees=True)
        self.cog.bot.get_channel = lambda channel_id: channel
        with self.assertLogs("iyakusai.weekly", level="ERROR") as logs:
            self.assertIsNone(self.cog._check_channel(CHANNEL, "一覧"))
        self.assertIn("@everyone", logs.output[0])

    def test_the_follow_up_channel_is_refused_the_same_way(self):
        channel = _text_channel(everyone_sees=True)
        self.cog.bot.get_channel = lambda channel_id: channel
        with self.assertLogs("iyakusai.weekly", level="ERROR"):
            self.assertIsNone(self.cog._check_channel(CHANNEL, "追い投稿"))


class DecisionsReadTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.folder = Path(self._dir.name)
        self.cog = _cog(self.folder, kiban=dict(KIBAN_LINKED, key_file=str(self.folder / "key.txt")))

    def tearDown(self):
        self._dir.cleanup()

    def _load(self, **fetch_behaviour):
        with mock.patch.object(WC, "load_key", return_value=b"k" * 32), \
                mock.patch.object(WC, "fetch_app", **fetch_behaviour) as fetch:
            result = asyncio.run(self.cog._load_decisions())
        return result, fetch

    def test_any_failure_to_read_the_decisions_leaves_the_section_out(self):
        failures = [
            KibanFetchError("応答が途中で壊れた(IncompleteRead)"),
            http.client.IncompleteRead(b"partial", 10),
            http.client.BadStatusLine("HTTP/9"),
            OSError("接続できない"),
            ValueError("想定外の形"),
        ]
        for error in failures:
            with self.subTest(error=type(error).__name__):
                result, _ = self._load(side_effect=error)
                self.assertIsNone(result)

    def test_a_decisions_answer_is_read_with_its_own_request(self):
        data = {"version": 1, "generatedAt": "2026-11-02T00:00:00.000Z",
                "decisions": {"items": [{"id": "d-1", "title": "合成の決定", "status": "active",
                                         "decidedAt": "2026-11-01"}]}}
        result, fetch = self._load(return_value=data)
        self.assertEqual([d.id for d in result], ["d-1"])
        self.assertEqual(fetch.call_args.args[0].sources, ("decisions",))   # 物品・受信箱とは別の要求

    def test_without_the_kiban_link_nothing_is_fetched(self):
        cog = _cog(self.folder, kiban={"enabled": False})
        with mock.patch.object(WC, "fetch_app") as fetch:
            self.assertIsNone(asyncio.run(cog._load_decisions()))
        fetch.assert_not_called()


class ListStillPostsTests(unittest.TestCase):
    """決定の口が壊れていても、その週の一覧は節を省いて出る(記録も残る)。"""

    def test_a_broken_decisions_read_still_posts_the_week_without_the_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            cog = _cog(folder, kiban=dict(KIBAN_LINKED, key_file=str(folder / "key.txt")))
            sent: list = []

            async def no_views():
                return []

            async def no_view(number):
                return None

            async def send(channel_id, out):
                sent.append(out)

            store = WeeklyStateStore(folder / "weekly_state.json")
            service = WeeklyService(
                settings=WeeklySettings.from_mapping({"channel_id": CHANNEL}), store=store, channel_id=CHANNEL,
                load_views=no_views, load_decisions=cog._load_decisions, get_view=no_view, send=send,
                clock=lambda: MONDAY_0840, follow_up_channel_id=None)
            with mock.patch.object(WC, "load_key", return_value=b"k" * 32), \
                    mock.patch.object(WC, "fetch_app", side_effect=http.client.IncompleteRead(b"x", 9)):
                asyncio.run(service.tick())
            self.assertTrue(sent)
            self.assertNotIn("今週の決定・変更", "\n".join(out.text for out in sent))
            self.assertEqual(len(WeeklyStateStore(folder / "weekly_state.json").posted_weeks()), 1)


if __name__ == "__main__":
    unittest.main()
