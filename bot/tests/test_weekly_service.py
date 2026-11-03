"""週1回の一覧と追い投稿の進み方・記録(Discord なし)の試験。合成データだけ。"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from iyakusai_bot.task_domain import JST, Task, TaskView, to_view  # noqa: E402
from iyakusai_bot.weekly_logic import WeeklySettings  # noqa: E402
from iyakusai_bot.weekly_service import WeeklyService  # noqa: E402
from iyakusai_bot.weekly_store import WeeklyStateError, WeeklyStateStore  # noqa: E402

MONDAY_0840 = datetime(2026, 11, 2, 8, 40, tzinfo=JST)
CHANNEL = 555


def make_task(number, *, status="todo", assignee=None, deadline=None, tags=("naimu",), title="合成のタスク"):
    return Task(
        number=number, title=title, description="", assignee_id=assignee, deadline=deadline, status=status,
        requirements={"purpose": "目的", "deliverable": "成果物", "completion_criteria": "完了条件",
                      "open_questions": ""},
        version=1, created_at="2026-10-30T00:00:00+00:00", created_by=1,
        updated_at="2026-10-30T00:00:00+00:00", updated_by=1, tags=tuple(tags))


class Harness:
    """時計・タスク DB・送信を置き換えた進行役。送信は fail_at の番号(0 始まり)で失敗させられる。"""

    def __init__(self, folder: Path, settings: WeeklySettings, *, list_channel: int = CHANNEL,
                 follow_up_channel: int | None = CHANNEL):
        self.store = WeeklyStateStore(folder / "weekly_state.json")
        self.now = MONDAY_0840
        self.tasks: dict[int, Task] = {}
        self.sent: list[tuple[int, object]] = []
        self.fail_at: set[int] = set()
        self.decisions = None
        self.service = WeeklyService(
            settings=settings, store=self.store, channel_id=list_channel,
            load_views=self._views, load_decisions=self._decisions, get_view=self._view,
            send=self._send, clock=lambda: self.now, follow_up_channel_id=follow_up_channel)

    async def _views(self) -> list[TaskView]:
        return [to_view(t, "2026-11-02") for t in self.tasks.values()]

    async def _decisions(self):
        return self.decisions

    async def _view(self, number: int):
        task = self.tasks.get(number)
        return None if task is None else to_view(task, "2026-11-02")

    async def _send(self, channel_id: int, out):
        if len(self.sent) in self.fail_at:
            raise RuntimeError("送れない(試験用)")
        self.sent.append((channel_id, out))

    def tick(self):
        return asyncio.run(self.service.tick())

    def at(self, when: datetime):
        self.now = when


class WeeklyPostTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.folder = Path(self._dir.name)
        self.h = Harness(self.folder, WeeklySettings.from_mapping({"channel_id": CHANNEL}))
        self.h.tasks[1] = make_task(1, title="担当なしの件", deadline="2026-11-10")

    def tearDown(self):
        self._dir.cleanup()

    def test_posts_once_per_week(self):
        self.h.tick()
        first = len(self.h.sent)
        self.assertGreater(first, 0)
        self.h.tick()
        self.h.at(MONDAY_0840 + timedelta(hours=3))
        self.h.tick()
        self.assertEqual(len(self.h.sent), first)           # 二重に出さない

    def test_nothing_before_the_slot(self):
        self.h.at(MONDAY_0840 - timedelta(minutes=1))
        self.h.tick()
        self.assertEqual(self.h.sent, [])

    def test_first_message_failure_releases_the_week_for_the_next_tick(self):
        self.h.fail_at = {0}
        with self.assertRaises(RuntimeError):
            self.h.tick()
        self.assertEqual(self.h.store.posted_weeks(), set())
        self.h.fail_at = set()
        self.h.tick()
        self.assertEqual(len(self.h.store.posted_weeks()), 1)
        self.assertGreater(len(self.h.sent), 0)

    def test_partial_failure_keeps_the_record_so_the_front_part_is_not_repeated(self):
        for n in range(2, 121):    # 行数が多く、一覧が複数の投稿になる
            self.h.tasks[n] = make_task(n, status="in_progress", assignee=10,
                                        title="長い題名" * 20, deadline="2026-11-30")
        self.h.fail_at = {1}
        with self.assertRaises(RuntimeError):
            self.h.tick()
        self.assertEqual(len(self.h.store.posted_weeks()), 1)   # 途中まで出た週は記録を残す
        self.h.fail_at = set()
        before = len(self.h.sent)
        self.h.tick()
        self.assertEqual(len(self.h.sent), before)               # 次の回に前半を出し直さない

    def test_decisions_section_is_omitted_when_the_source_is_unavailable(self):
        self.h.decisions = None
        self.h.tick()
        text = "\n".join(out.text for _, out in self.h.sent)
        self.assertNotIn("今週の決定・変更", text)

    def test_disabled_settings_do_nothing(self):
        folder = Path(self._dir.name) / "off"
        folder.mkdir()
        off = Harness(folder, WeeklySettings())
        off.tasks[1] = make_task(1)
        off.tick()
        self.assertEqual(off.sent, [])
        self.assertFalse((folder / "weekly_state.json").exists())


class FollowUpTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.h = Harness(Path(self._dir.name), WeeklySettings.from_mapping({"channel_id": CHANNEL}))
        self.h.tasks[1] = make_task(1, title="担当なしの件", deadline="2026-11-10", tags=("naimu",))
        # 同じ部局で担当の実績がある人(候補)
        self.h.tasks[2] = make_task(2, status="in_progress", assignee=20, tags=("naimu",))
        self.h.tick()                                         # 一覧で 1 番を載せる
        self.listed_at = MONDAY_0840

    def tearDown(self):
        self._dir.cleanup()

    def test_follow_up_is_sent_once_after_the_configured_days(self):
        before = len(self.h.sent)
        self.h.at(self.listed_at + timedelta(days=1))
        self.h.tick()
        self.assertEqual(len(self.h.sent), before)            # まだ 2 日たっていない
        self.h.at(self.listed_at + timedelta(days=2))
        self.h.tick()
        follow = [out for _, out in self.h.sent[before:]]
        self.assertEqual(len(follow), 1)
        self.assertEqual(follow[0].assign_numbers, (1,))
        self.assertIn("<@20>", follow[0].text)
        self.assertEqual(follow[0].mention_ids, ())           # mention_candidates=false なので名指しは鳴らさない
        self.h.at(self.listed_at + timedelta(days=5))
        self.h.tick()
        self.assertEqual(len(self.h.sent), before + 1)        # 1 回だけ

    def test_no_follow_up_when_the_task_was_assigned_in_the_meantime(self):
        before = len(self.h.sent)
        self.h.tasks[1] = make_task(1, status="in_progress", assignee=30, deadline="2026-11-10")
        self.h.at(self.listed_at + timedelta(days=2))
        self.h.tick()
        self.assertEqual(len(self.h.sent), before)
        self.assertEqual(self.h.store.followup_state(1), "closed")

    def test_mention_candidates_true_limits_notifications_to_the_candidates(self):
        folder = Path(self._dir.name) / "m"
        folder.mkdir()
        self.h = Harness(folder, WeeklySettings.from_mapping(
            {"channel_id": CHANNEL, "mention_candidates": True}))
        self.h.tasks[1] = make_task(1, title="担当なしの件", deadline="2026-11-10")
        self.h.tasks[2] = make_task(2, status="in_progress", assignee=20)
        self.h.tick()                                          # 一覧(1 番を載せる)
        before = len(self.h.sent)
        self.h.at(self.listed_at + timedelta(days=2))
        self.h.tick()                                          # 追い投稿
        self.assertEqual(len(self.h.sent), before + 1)
        self.assertEqual(self.h.sent[before][1].mention_ids, (20,))


class RoutingTests(unittest.TestCase):
    """一覧と追い投稿は、それぞれの送り先へ届く(上書きが実際の送信に使われること)。"""

    LIST_CH = 555
    FOLLOW_CH = 666

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        folder = Path(self._dir.name)
        self.h = Harness(folder, WeeklySettings.from_mapping({"channel_id": self.LIST_CH}),
                         list_channel=self.LIST_CH, follow_up_channel=self.FOLLOW_CH)
        self.h.tasks[1] = make_task(1, title="担当なしの件", deadline="2026-11-10")
        self.h.tasks[2] = make_task(2, status="in_progress", assignee=20)

    def tearDown(self):
        self._dir.cleanup()

    def test_list_goes_to_the_list_channel_and_follow_up_to_its_own_channel(self):
        self.h.tick()
        self.h.at(MONDAY_0840 + timedelta(days=2))
        self.h.tick()
        channels = [ch for ch, _ in self.h.sent]
        self.assertEqual(channels[0], self.LIST_CH)
        self.assertEqual(channels[-1], self.FOLLOW_CH)
        self.assertTrue(all(ch == self.LIST_CH for ch in channels[:-1]))

    def test_without_a_follow_up_channel_no_follow_up_is_sent(self):
        folder = Path(self._dir.name) / "nofollow"
        folder.mkdir()
        h = Harness(folder, WeeklySettings.from_mapping({"channel_id": self.LIST_CH}),
                    list_channel=self.LIST_CH, follow_up_channel=None)
        h.tasks[1] = make_task(1, title="担当なしの件", deadline="2026-11-10")
        h.tasks[2] = make_task(2, status="in_progress", assignee=20)
        h.tick()
        listed = len(h.sent)
        h.at(MONDAY_0840 + timedelta(days=2))
        h.tick()
        self.assertEqual(len(h.sent), listed)                  # 一覧は出たが、追い投稿はしない
        self.assertIsNone(h.store.followup_state(1))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / "weekly_state.json"
        self.store = WeeklyStateStore(self.path)

    def tearDown(self):
        self._dir.cleanup()

    def test_reserve_is_refused_for_a_week_already_recorded(self):
        self.assertTrue(self.store.reserve_week("2026-W45", "2026-11-02T08:40:00+09:00", CHANNEL, [1]))
        self.assertFalse(self.store.reserve_week("2026-W45", "2026-11-02T09:00:00+09:00", CHANNEL, [2]))
        self.assertEqual(self.store.posted_weeks(), {"2026-W45"})

    def test_release_forgets_only_that_week(self):
        self.store.reserve_week("2026-W45", "2026-11-02T08:40:00+09:00", CHANNEL, [])
        self.store.reserve_week("2026-W46", "2026-11-09T08:40:00+09:00", CHANNEL, [])
        self.store.release_week("2026-W45")
        self.assertEqual(self.store.posted_weeks(), {"2026-W46"})

    def test_follow_up_state_can_be_set_and_cleared(self):
        self.assertIsNone(self.store.followup_state(7))
        self.store.mark_followup(7, "followed", "2026-11-04T08:40:00+09:00")
        self.assertEqual(self.store.followup_state(7), "followed")
        self.store.clear_followup(7)
        self.assertIsNone(self.store.followup_state(7))

    def test_a_broken_state_file_is_an_error_not_an_empty_record(self):
        self.path.write_text("{ this is not json", encoding="utf-8")
        with self.assertRaises(WeeklyStateError):
            self.store.posted_weeks()
        self.path.write_text(json.dumps({"posts": "x", "followups": {}}), encoding="utf-8")
        with self.assertRaises(WeeklyStateError):
            self.store.posts()

    def test_only_recent_weeks_are_kept(self):
        for week in range(70):
            self.store.reserve_week(f"2026-W{week:02d}", "2026-11-02T08:40:00+09:00", CHANNEL, [])
        self.assertEqual(len(self.store.posts()), 60)


if __name__ == "__main__":
    unittest.main()
