"""Bot の投稿先([notify])と週1回の一覧の設定([weekly])の読み込みの試験。合成データだけ。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from iyakusai_bot.config import load_config  # noqa: E402
from iyakusai_bot.notify import NOTIFY_KINDS, NotifyConfigError, NotifySettings, routed_channel_id  # noqa: E402
from iyakusai_bot.weekly_logic import WeeklySettings  # noqa: E402


class ResolveTests(unittest.TestCase):
    def test_without_notify_section_every_kind_keeps_its_legacy_destination(self):
        s = NotifySettings.from_mapping(None)
        for kind in NOTIFY_KINDS:
            with self.subTest(kind=kind):
                self.assertEqual(s.resolve(kind, 7), 7)
                self.assertIsNone(s.resolve(kind, None))

    def test_a_kind_override_beats_the_default_and_the_legacy_setting(self):
        s = NotifySettings.from_mapping({"channel_id": 100, "kinds": {"haiku_digest": 200}})
        self.assertEqual(s.resolve("haiku_digest", 7), 200)

    def test_the_default_applies_only_to_kinds_with_one_destination(self):
        s = NotifySettings.from_mapping({"channel_id": 100})
        self.assertEqual(s.resolve("weekly_tasks", 7), 100)
        self.assertEqual(s.resolve("weekly_follow_up", 7), 100)
        self.assertEqual(s.resolve("collect_staleness", None), 100)
        self.assertEqual(s.resolve("app_share", 7), 100)
        self.assertEqual(s.resolve("reminder", 7), 7)           # 登録した本人のチャンネル
        self.assertEqual(s.resolve("task_candidates", 7), 7)    # 部局ごとの経路

    def test_a_kind_override_can_still_move_reminders_and_candidates(self):
        s = NotifySettings.from_mapping({"kinds": {"reminder": 300, "task_candidates": 400}})
        self.assertEqual(s.resolve("reminder", 7), 300)
        self.assertEqual(s.resolve("task_candidates", 7), 400)

    def test_unknown_kinds_and_bad_values_are_refused(self):
        bad = [
            "not-a-table",
            {"unknown": 1},
            {"kinds": {"no_such_kind": 5}},
            {"kinds": {"reminder": "5"}},
            {"channel_id": 0},
            {"channel_id": True},
            {"kinds": []},
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(NotifyConfigError):
                NotifySettings.from_mapping(raw)


class RoutedChannelTests(unittest.TestCase):
    def test_a_bot_without_config_or_with_a_fake_config_keeps_the_legacy_destination(self):
        self.assertEqual(routed_channel_id(SimpleNamespace(cfg=None), "haiku_digest", 7), 7)
        self.assertEqual(routed_channel_id(SimpleNamespace(), "haiku_digest", 7), 7)
        self.assertEqual(routed_channel_id(SimpleNamespace(cfg=SimpleNamespace()), "haiku_digest", 7), 7)

    def test_a_configured_bot_uses_the_resolved_destination(self):
        bot = SimpleNamespace(cfg=SimpleNamespace(notify=NotifySettings.from_mapping(
            {"channel_id": 100, "kinds": {"haiku_digest": 200}})))
        self.assertEqual(routed_channel_id(bot, "haiku_digest", 7), 200)
        self.assertEqual(routed_channel_id(bot, "weekly_tasks", 7), 100)
        self.assertEqual(routed_channel_id(bot, "reminder", 7), 7)


class WeeklySettingsTests(unittest.TestCase):
    def test_a_weekly_list_with_only_a_channel_uses_the_defaults(self):
        s = WeeklySettings.from_mapping({"channel_id": 123})
        self.assertEqual((s.weekday, s.hour, s.minute, s.follow_up_days), (1, 8, 40, 2))


class WeeklyCogRoutingTests(unittest.TestCase):
    def test_the_list_and_the_follow_up_resolve_their_own_destinations(self):
        from iyakusai_bot.task_store import TaskSettings
        from iyakusai_bot.weekly_cog import WeeklyCog
        bot = SimpleNamespace(cfg=SimpleNamespace(notify=NotifySettings.from_mapping(
            {"channel_id": 100, "kinds": {"weekly_follow_up": 200}})))
        with tempfile.TemporaryDirectory() as tmp:
            cog = WeeklyCog(bot, WeeklySettings.from_mapping({"channel_id": 7}), TaskSettings(), None, Path(tmp))
        self.assertEqual(cog.channel_id, 100)               # 既定([notify].channel_id)
        self.assertEqual(cog.follow_up_channel_id, 200)     # 種類の上書き
        with tempfile.TemporaryDirectory() as tmp:
            plain = WeeklyCog(SimpleNamespace(cfg=None), WeeklySettings.from_mapping({"channel_id": 7}),
                              TaskSettings(), None, Path(tmp))
        self.assertEqual((plain.channel_id, plain.follow_up_channel_id), (7, 7))   # 設定が無ければ従来どおり


class LoadConfigTests(unittest.TestCase):
    def _write(self, folder: Path, extra: str) -> Path:
        path = folder / "config.toml"
        data_dir = (folder / "data").as_posix()
        path.write_text(
            "[host]\nname = \"test-host\"\n\n"
            f"[paths]\ndata_dir = \"{data_dir}\"\n\n" + extra,
            encoding="utf-8")
        return path

    def test_missing_sections_give_the_old_behaviour(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(self._write(Path(tmp), ""))
        self.assertIsNone(cfg.notify.channel_id)
        self.assertEqual(cfg.notify.kinds, ())
        self.assertFalse(cfg.weekly.enabled)

    def test_notify_and_weekly_are_read(self):
        extra = ("[notify]\nchannel_id = 111\n\n[notify.kinds]\nreminder = 222\n\n"
                 "[weekly]\nchannel_id = 333\ntime = \"09:00\"\nmention_candidates = true\n")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = load_config(self._write(Path(tmp), extra))
        self.assertEqual(cfg.notify.channel_id, 111)
        self.assertEqual(cfg.notify.resolve("reminder", 9), 222)
        self.assertTrue(cfg.weekly.enabled)
        self.assertEqual((cfg.weekly.hour, cfg.weekly.minute), (9, 0))
        self.assertTrue(cfg.weekly.mention_candidates)

    def test_a_bad_notify_section_stops_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(Path(tmp), "[notify.kinds]\nmystery = 5\n")
            with self.assertRaises(SystemExit):
                load_config(path)


if __name__ == "__main__":
    unittest.main()
