"""週1回のタスク一覧・追い投稿の中身(純ロジック)の試験。合成データだけ。"""

from __future__ import annotations

import sys
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from iyakusai_bot import weekly_logic as W  # noqa: E402
from iyakusai_bot.decisions_logic import parse_decisions  # noqa: E402
from iyakusai_bot.task_domain import JST, Task, to_view  # noqa: E402

# 2026-11-02 は月曜日(日本時間)。投稿の既定は 08:40。
MONDAY_0840 = datetime(2026, 11, 2, 8, 40, tzinfo=JST)
TODAY = "2026-11-02"


def make_task(number, *, title="合成のタスク", status="todo", assignee=None, deadline=None,
              tags=("naimu",), helpers=(), version=1):
    return Task(
        number=number, title=title, description="", assignee_id=assignee, deadline=deadline,
        status=status,
        requirements={"purpose": "目的", "deliverable": "成果物", "completion_criteria": "完了条件",
                      "open_questions": ""},
        version=version, created_at="2026-10-30T00:00:00+00:00", created_by=1,
        updated_at="2026-10-30T00:00:00+00:00", updated_by=1, tags=tuple(tags), helpers=tuple(helpers))


def view(task, today=TODAY):
    return to_view(task, today)


class SettingsTests(unittest.TestCase):
    def test_absent_or_disabled_settings_do_nothing(self):
        self.assertFalse(W.WeeklySettings.from_mapping(None).enabled)
        disabled = W.WeeklySettings.from_mapping({"enabled": False, "channel_id": 123})
        self.assertFalse(disabled.enabled)

    def test_defaults_are_monday_0840_and_two_day_follow_up(self):
        s = W.WeeklySettings.from_mapping({"channel_id": 123})
        self.assertTrue(s.enabled)
        self.assertEqual((s.weekday, s.hour, s.minute), (1, 8, 40))
        self.assertEqual(s.follow_up_days, 2)
        self.assertFalse(s.mention_candidates)
        self.assertEqual(s.candidate_limit, 5)

    def test_rejects_bad_values(self):
        bad = [
            {"channel_id": "123"},                  # 文字列
            {"weekday": 1},                         # channel_id が無い
            {"channel_id": 1, "time": "25:00"},
            {"channel_id": 1, "time": 840},
            {"channel_id": 1, "weekday": 8},
            {"channel_id": 1, "follow_up_days": 0},
            {"channel_id": 1, "candidate_limit": 6},
            {"channel_id": 1, "mention_candidates": "yes"},
            {"channel_id": 1, "unknown": True},
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(W.WeeklyConfigError):
                W.WeeklySettings.from_mapping(raw)


class WeekTests(unittest.TestCase):
    def test_week_key_follows_iso_year_across_new_year(self):
        self.assertEqual(W.week_key(date(2026, 12, 31)), "2026-W53")
        self.assertEqual(W.week_key(date(2027, 1, 1)), "2026-W53")
        self.assertEqual(W.week_key(date(2027, 1, 4)), "2027-W01")

    def test_due_at_slot_once_per_week_and_catches_up_within_the_week(self):
        s = W.WeeklySettings.from_mapping({"channel_id": 1})
        before = MONDAY_0840 - timedelta(minutes=1)
        self.assertFalse(W.is_due(before, s, set()))
        self.assertTrue(W.is_due(MONDAY_0840, s, set()))
        # 同じ週に投稿済みなら、同じ週のあとの時刻でも出さない
        week = W.week_of(MONDAY_0840)
        self.assertFalse(W.is_due(MONDAY_0840 + timedelta(hours=5), s, {week}))
        # 週の途中で気づいたら(同じ週・未投稿)追いつく
        self.assertTrue(W.is_due(MONDAY_0840 + timedelta(days=2), s, set()))
        # 次の週は次の時刻まで待つ
        next_monday_before = MONDAY_0840 + timedelta(days=7) - timedelta(minutes=1)
        self.assertFalse(W.is_due(next_monday_before, s, {week}))
        self.assertTrue(W.is_due(MONDAY_0840 + timedelta(days=7), s, {week}))


class BuildWeeklyTests(unittest.TestCase):
    def test_sections_counts_and_unassigned_order(self):
        tasks = [
            make_task(1, title="進行中の件", status="in_progress", assignee=10, deadline="2026-12-01"),
            make_task(2, title="期限切れの件", status="todo", assignee=11, deadline="2026-10-20"),
            make_task(3, title="今週が期限の件", status="todo", assignee=12, deadline="2026-11-04"),
            make_task(4, title="完了した件", status="done", assignee=10),
            make_task(5, title="担当なし・期限あり", deadline="2026-11-20"),
            make_task(6, title="担当なし・期限なし"),
            make_task(7, title="担当なし・期限が早い", deadline="2026-11-10"),
        ]
        plan = W.build_weekly([view(t) for t in tasks], MONDAY_0840, candidate_limit=2, decisions=None)
        text = "\n".join(m.text for m in plan.messages)
        self.assertIn("未完了 6 件", text)                # 完了の 1 件は数えない
        self.assertIn("未割当 3 件", text)               # 担当なしは「未割当」と書く(/todo と同じ言い方)
        self.assertIn("期限切れ 1", text)
        self.assertIn("■ **内務部**　進行中 1・期限切れ 1・今週が期限 1", text)
        self.assertIn("<@10>", text)                     # 担当は名指しの形(通知は鳴らさない)
        self.assertNotIn("完了した件", text)
        # 担当なしは期限の近い順に上位 2 件だけ。ボタンはその 2 件
        self.assertEqual(plan.listed_numbers, (7, 5))
        buttons = [m for m in plan.messages if m.assign_numbers]
        self.assertEqual(len(buttons), 1)
        self.assertEqual(buttons[0].assign_numbers, (7, 5))
        self.assertIn("期限の近い順・上位 2 件", buttons[0].text)

    def test_no_unassigned_message_when_everything_is_assigned(self):
        tasks = [make_task(1, status="in_progress", assignee=10)]
        plan = W.build_weekly([view(t) for t in tasks], MONDAY_0840, candidate_limit=5, decisions=None)
        self.assertEqual(plan.listed_numbers, ())
        self.assertFalse(any(m.assign_numbers for m in plan.messages))
        self.assertIn("未完了で主担当の決まっていないタスクはありません", "\n".join(m.text for m in plan.messages))

    def test_decisions_section_only_when_source_is_available(self):
        tasks = [make_task(1, status="in_progress", assignee=10)]
        without = W.build_weekly([view(t) for t in tasks], MONDAY_0840, candidate_limit=5, decisions=None)
        self.assertNotIn("今週の決定・変更", "\n".join(m.text for m in without.messages))
        empty = W.build_weekly([view(t) for t in tasks], MONDAY_0840, candidate_limit=5, decisions=[])
        self.assertIn("今週の決定・変更", "\n".join(m.text for m in empty.messages))
        self.assertIn("（なし）", "\n".join(m.text for m in empty.messages))

    def test_decisions_show_recent_changes_without_body(self):
        block = {"items": [
            {"id": "d-1", "title": "会場の変更", "departments": ["kaijo"], "decidedAt": "2026-10-30",
             "venue": "役員会", "status": "changed", "supersededBy": None,
             "changeNote": "正門から西門へ", "changedAt": "2026-11-01T02:00:00Z",
             "url": "https://app.example.test/#/decisions?d=d-1", "body": "本文はここに入らない"},
            {"id": "d-2", "title": "古い決定", "departments": [], "decidedAt": "2026-09-01",
             "venue": "", "status": "active", "supersededBy": None, "changeNote": "",
             "changedAt": "2026-09-01T00:00:00Z", "url": None},
        ]}
        decisions = parse_decisions(block)
        plan = W.build_weekly([], MONDAY_0840, candidate_limit=5, decisions=decisions)
        text = "\n".join(m.text for m in plan.messages)
        self.assertIn("会場の変更", text)
        self.assertIn("正門から西門へ", text)
        self.assertIn("会場課", text)                  # 部局のキーは表示名に直す
        self.assertNotIn("古い決定", text)            # 直近 7 日の外は出さない
        self.assertNotIn("本文はここに入らない", text)
        self.assertIn("<https://app.example.test/#/decisions?d=d-1>", text)

    def test_long_lists_are_split_under_the_limit_and_buttons_are_not_duplicated(self):
        tasks = [make_task(n, title="長い題名" * 20, status="in_progress", assignee=10,
                           deadline="2026-11-30") for n in range(1, 121)]
        tasks += [make_task(200 + n, title="担当なし" * 15) for n in range(5)]
        plan = W.build_weekly([view(t) for t in tasks], MONDAY_0840, candidate_limit=5, decisions=[])
        self.assertGreater(len(plan.messages), 1)
        for message in plan.messages:
            self.assertLessEqual(len(message.text), W.MESSAGE_LIMIT)
        numbered = [m for m in plan.messages if m.assign_numbers]
        self.assertEqual(len(numbered), 1)
        self.assertEqual(sorted(numbered[0].assign_numbers), sorted(plan.listed_numbers))

    def test_weekly_messages_never_notify_anyone(self):
        tasks = [make_task(1, status="in_progress", assignee=10), make_task(2)]
        plan = W.build_weekly([view(t) for t in tasks], MONDAY_0840, candidate_limit=5, decisions=None)
        self.assertTrue(all(m.mention_ids == () for m in plan.messages))


class CandidateTests(unittest.TestCase):
    def test_ranks_people_from_the_same_department_by_open_load(self):
        target = make_task(9, tags=("naimu",))
        everything = [
            target,
            make_task(1, status="in_progress", assignee=20, tags=("naimu",)),
            make_task(2, status="todo", assignee=20, tags=("naimu",)),
            make_task(3, status="done", assignee=21, tags=("naimu",)),        # 完了は持ちに数えない
            make_task(4, status="todo", assignee=22, helpers=(23,), tags=("naimu",)),
            make_task(5, status="todo", assignee=30, tags=("soumu",)),        # 別の部局は候補にしない
        ]
        ranked = W.rank_candidates(target, everything, limit=10)
        # 持ちが同数(22 と 23)のときは ID の小さい順
        self.assertEqual([c.user_id for c in ranked], [21, 22, 23, 20])
        self.assertEqual(ranked[0].open_count, 0)
        self.assertEqual(ranked[-1].open_count, 2)
        # 既定では上位 3 人まで
        self.assertEqual(len(W.rank_candidates(target, everything)), 3)

    def test_no_candidates_without_department_history(self):
        target = make_task(9, tags=("naimu",))
        self.assertEqual(W.rank_candidates(target, [target]), [])


class FollowUpTests(unittest.TestCase):
    def test_follow_up_names_candidates_and_mentions_only_when_allowed(self):
        target = make_task(9, title="資料の確認", deadline="2026-11-10", tags=("naimu",))
        cands = [W.Candidate(21, 0), W.Candidate(20, 2)]
        quiet = W.build_follow_up(view(target), days_since=2, candidates=cands, mention=False)
        self.assertIn("<@21>", quiet.text)
        self.assertEqual(quiet.mention_ids, ())
        self.assertEqual(quiet.assign_numbers, (9,))
        loud = W.build_follow_up(view(target), days_since=2, candidates=cands, mention=True)
        self.assertEqual(loud.mention_ids, (21, 20))

    def test_follow_up_without_candidates_says_so(self):
        target = make_task(9, tags=("naimu",))
        out = W.build_follow_up(view(target), days_since=2, candidates=[], mention=True)
        self.assertIn("候補は出せません", out.text)
        self.assertEqual(out.mention_ids, ())

    def test_follow_up_waits_for_the_configured_days(self):
        posted = MONDAY_0840
        self.assertFalse(W.follow_up_due(posted, posted + timedelta(days=1, hours=23), 2))
        self.assertTrue(W.follow_up_due(posted, posted + timedelta(days=2), 2))

    def test_candidate_counts_are_scoped_to_the_department(self):
        target = make_task(9, title="資料の確認", deadline="2026-11-10", tags=("naimu",))
        out = W.build_follow_up(view(target), days_since=2, candidates=[W.Candidate(20, 2)], mention=False)
        self.assertIn("この部局の未完了 2 件", out.text)     # 件数の範囲を書く(他の部局の負荷ではない)

    def test_the_follow_up_wording_says_unassigned(self):
        target = make_task(9, title="資料の確認", deadline="2026-11-10", tags=("naimu",))
        out = W.build_follow_up(view(target), days_since=2, candidates=[], mention=False)
        self.assertIn("未割当のままです", out.text)
        self.assertNotIn("担当なし", out.text)


class DecisionRenderTests(unittest.TestCase):
    """決定・変更の節の表示: 件名などは Discord の書式を効かせない。差し替え先は件名で出し、ID は出さない。"""

    def _block(self, **over):
        item = {"id": "d-1", "title": "会場の変更", "departments": ["kaijo"], "decidedAt": "2026-10-30",
                "venue": "", "status": "changed", "supersededBy": None, "changeNote": "",
                "changedAt": "2026-11-01T02:00:00Z", "url": None}
        item.update(over)
        return {"items": [item]}

    def _text(self, block):
        decisions = parse_decisions(block)
        plan = W.build_weekly([], MONDAY_0840, candidate_limit=5, decisions=decisions)
        return "\n".join(m.text for m in plan.messages)

    def test_title_and_note_cannot_form_a_link_or_a_mention(self):
        text = self._text(self._block(title="[link](https://evil.example) @everyone",
                                      changeNote="*強調* _斜体_ `code`"))
        self.assertIn("\\[link\\]", text)
        self.assertNotIn("[link](https://evil.example)", text)
        self.assertIn("\\*強調\\*", text)
        self.assertIn("\\`code\\`", text)

    def test_superseded_decision_is_shown_by_title_never_by_id(self):
        block = {"items": [
            {"id": "d-1", "title": "旧: 会場", "departments": [], "decidedAt": "2026-10-30", "status": "revoked",
             "supersededBy": "dc_0123456789abcdef", "changedAt": "2026-11-01T02:00:00Z"},
            {"id": "dc_0123456789abcdef", "title": "新: 会場", "departments": [], "decidedAt": "2026-11-01",
             "status": "active", "supersededBy": None, "changedAt": "2026-11-01T01:00:00Z"},
        ]}
        text = self._text(block)
        self.assertIn("差し替え先: 新: 会場", text)
        self.assertNotIn("dc_0123456789abcdef", text)

    def test_an_unknown_superseding_decision_is_marked_without_its_id(self):
        text = self._text(self._block(supersededBy="dc_fedcba9876543210", status="changed"))
        self.assertIn("（差し替え先あり）", text)
        self.assertNotIn("dc_fedcba9876543210", text)

    def test_a_link_with_spaces_or_angle_brackets_is_dropped(self):
        for url in ("https://a.example/x>y z", "https://a.example/x\nq"):
            with self.subTest(url=url):
                text = self._text(self._block(url=url))
                self.assertNotIn("<https", text)


if __name__ == "__main__":
    unittest.main()
