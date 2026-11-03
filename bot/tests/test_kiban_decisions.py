"""統合アプリの決定・変更(sources: decisions)を Bot が読む部分の試験。合成データだけ。

- 既定の要求には decisions を入れない(アプリが未対応のとき 401 で物品・受信箱まで止めないため)。
- 応答の形の検査、写し(kiban/decisions.md)に本文・リンクの危険な形を出さないこと。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from iyakusai_bot import kiban as K  # noqa: E402
from iyakusai_bot.decisions_logic import changed_within, parse_decisions  # noqa: E402
from iyakusai_bot.task_domain import JST  # noqa: E402

NOW = datetime(2026, 11, 2, 8, 40, tzinfo=JST)


def _item(**overrides):
    item = {
        "id": "d-1", "title": "合成の決定", "departments": ["naimu", "unknown-dept"], "decidedAt": "2026-10-30",
        "venue": "役員会", "status": "changed", "supersededBy": None, "changeNote": "日程を変更",
        "changedAt": "2026-11-01T01:00:00Z", "url": "https://app.example.test/#/decisions?d=d-1",
        "body": "この本文は Bot の写しに入らない",
    }
    item.update(overrides)
    return item


class SourceSettingsTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.key = str(Path(self._dir.name) / "key.txt")

    def tearDown(self):
        self._dir.cleanup()

    def _settings(self, **extra):
        raw = {"enabled": True, "tasks": False, "app_url": "https://app.example.test", "key_file": self.key}
        raw.update(extra)
        return K.KibanSettings.from_mapping(raw, shared_roots=())

    def test_the_default_request_does_not_include_decisions(self):
        self.assertEqual(self._settings().sources, ("rental", "mailbox"))

    def test_decisions_can_be_requested_when_configured(self):
        self.assertEqual(self._settings(sources=["decisions"]).sources, ("decisions",))

    def test_unknown_sources_are_still_refused(self):
        with self.assertRaises(K.KibanConfigError):
            self._settings(sources=["rental", "gossip"])


class SnapshotShapeTests(unittest.TestCase):
    BASE = {"version": 1, "generatedAt": "2026-11-02T00:00:00.000Z"}

    def test_a_decisions_block_with_items_is_accepted(self):
        data = dict(self.BASE, decisions={"items": [_item()]})
        self.assertIs(K.check_snapshot(data), data)

    def test_a_response_without_decisions_is_fine(self):
        K.check_snapshot(dict(self.BASE))

    def test_a_malformed_decisions_block_is_refused(self):
        for block in ({"items": "x"}, [], "x"):
            with self.subTest(block=block), self.assertRaises(K.KibanFetchError):
                K.check_snapshot(dict(self.BASE, decisions=block))


class ParseAndRenderTests(unittest.TestCase):
    def test_department_keys_become_labels_and_unknown_ones_stay_readable(self):
        decisions = parse_decisions({"items": [_item()]})
        self.assertEqual(decisions[0].departments, ("内務部", "unknown-dept"))

    def test_only_https_links_are_kept(self):
        for url in ("http://app.example.test/x", "javascript:alert(1)", None, 5):
            with self.subTest(url=url):
                decisions = parse_decisions({"items": [_item(url=url)]})
                self.assertIsNone(decisions[0].url)

    def test_a_link_with_spaces_or_angle_brackets_is_dropped(self):
        for url in ("https://a.example/x>y z", "https://a.example/x\nq", "https://a.example/<b>"):
            with self.subTest(url=url):
                self.assertIsNone(parse_decisions({"items": [_item(url=url)]})[0].url)

    def test_items_without_an_id_are_skipped(self):
        decisions = parse_decisions({"items": [_item(id=""), _item(id="d-2")]})
        self.assertEqual([d.id for d in decisions], ["d-2"])

    def test_a_decision_day_that_is_not_a_date_counts_as_no_day(self):
        for raw in ("2026/01/05", "zzz", "2026-13-01", "", 20261105, "2026-11-02T10:00:00"):
            with self.subTest(decidedAt=raw):
                decisions = parse_decisions({"items": [_item(decidedAt=raw, changedAt=None)]})
                self.assertEqual(decisions[0].decided_at, "")
                self.assertEqual(changed_within(decisions, NOW), [])     # 変更日も決定日も読めないものは出さない

    def test_a_valid_decision_day_is_kept_as_a_normalized_date(self):
        decisions = parse_decisions({"items": [_item(decidedAt="2026-10-30")]})
        self.assertEqual(decisions[0].decided_at, "2026-10-30")

    def test_the_recent_window_uses_the_change_time_and_falls_back_to_the_decision_day(self):
        recent = parse_decisions({"items": [_item(id="new"), _item(id="old", changedAt="2026-09-01T00:00:00Z")]})
        self.assertEqual([d.id for d in changed_within(recent, NOW)], ["new"])
        no_time = parse_decisions({"items": [_item(id="day", changedAt=None, decidedAt=(NOW - timedelta(days=2)).date().isoformat())]})
        self.assertEqual([d.id for d in changed_within(no_time, NOW)], ["day"])

    def test_the_mirror_page_shows_status_and_title_but_never_the_body(self):
        block = {"items": [_item()]}
        text = K.render_decisions(block, "2026-11-02T00:00:00.000Z", NOW, 5)
        self.assertIn("変更された", text)
        self.assertIn("合成の決定", text)
        self.assertIn("日程を変更", text)
        self.assertNotIn("この本文は Bot の写しに入らない", text)
        self.assertNotIn("https://app.example.test", text)     # リンクは写しに入れない(件名・状態だけ)

    def test_an_empty_register_still_writes_a_page(self):
        text = K.render_decisions({"items": []}, "2026-11-02T00:00:00.000Z", NOW, 5)
        self.assertIn("まだ決定・変更はありません", text)


if __name__ == "__main__":
    unittest.main()
