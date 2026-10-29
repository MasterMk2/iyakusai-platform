import dataclasses
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import patch

from oa_relay import Journal, Registry, ValidationError, plan_event
from operating_policy import plan_for_committee
from review_controls import make_approval, review_candidate
from runner import process_cycle, summary, validate_config
from delivery import Delivery
from test_delivery import FakeAPI
from test_oa_relay import StateFixture, FORUM, CATEGORY, event, key, registry

REVIEWER = "1999999999999999999"


class ReviewTests(StateFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.held = plan_for_committee(event(2, text="そちらはいかがでしょうか。"), Registry([]), self.root)
        self.state.register(self.held)
        self.candidate = review_candidate(self.held.event, registry(), self.root)
        self.approval = make_approval(self.candidate, FORUM["id"], REVIEWER, reviewed_non_sensitive=True)

    def release(self, **kwargs):
        options = {"forum_id": FORUM["id"], "approved_reviewers": frozenset({REVIEWER})}
        options.update(kwargs)
        self.state.release(self.candidate, self.approval, **options)

    def test_single_exact_release_and_delivery_after_restart(self):
        self.release()
        self.state.close()
        self.state = Journal(self.path)
        self.assertTrue(self.state.has_review(self.candidate, FORUM["id"]))
        api = FakeAPI()
        delivery = Delivery(api, self.state, FORUM, CATEGORY, self.root)
        self.assertEqual(delivery.dispatch(self.candidate), "delivered")
        self.assertEqual(len(api.posts), 1)
        dump = "\n".join(self.state.db.iterdump())
        self.assertNotIn(self.candidate.event.text, dump)
        self.assertNotIn(self.candidate.event.source_id, dump)

    def test_wrong_reviewer_target_or_changed_body_not_released(self):
        with self.assertRaisesRegex(ValidationError, "reviewer"):
            self.release(approved_reviewers=frozenset())
        with self.assertRaisesRegex(ValidationError, "target_or_content_changed"):
            self.release(forum_id="1888888888888888888")
        changed = review_candidate(event(2, text="内容が変わりました。"), registry(), self.root)
        with self.assertRaisesRegex(ValidationError, "target_or_content_changed"):
            self.state.release(changed, self.approval, forum_id=FORUM["id"], approved_reviewers=frozenset({REVIEWER}))
        self.assertEqual(self.state.status(self.held.event.identity), "held")
        self.assertFalse(self.state.ready_parts(self.held.event.identity))

    def test_changed_org_or_plan_not_released(self):
        altered = dataclasses.replace(self.candidate, org_id="other_org")
        with self.assertRaisesRegex(ValidationError, "target_or_content_changed"):
            self.state.release(altered, self.approval, forum_id=FORUM["id"], approved_reviewers=frozenset({REVIEWER}))

    def test_review_expiry_and_future_timestamp_rejected(self):
        now = datetime.now(timezone.utc)
        for difference in [timedelta(days=-2), timedelta(hours=1)]:
            original = self.approval
            self.approval = dataclasses.replace(original, reviewed_at=(now+difference).isoformat())
            with self.assertRaisesRegex(ValidationError, "expired_or_future"):
                self.release(now=now)
            self.approval = original

    def test_baseline_history_not_released(self):
        old = review_candidate(event(1), registry(), self.root)
        approval = make_approval(old, FORUM["id"], REVIEWER, reviewed_non_sensitive=True)
        with self.assertRaisesRegex(ValidationError, "baseline_history"):
            self.state.release(old, approval, forum_id=FORUM["id"], approved_reviewers=frozenset({REVIEWER}))

    def test_original_time_before_activation_not_released(self):
        self.state._set("activated_at", (self.candidate.event.sent_at+timedelta(seconds=1)).isoformat())
        with self.assertRaisesRegex(ValidationError, "pre_activation_history"):
            self.release()

    def test_release_transaction_failure_retains_hold_and_no_parts(self):
        with patch.object(self.state, "_advance", side_effect=RuntimeError("fixture database fault")):
            with self.assertRaises(RuntimeError):
                self.release()
        self.assertEqual(self.state.status(self.held.event.identity), "held")
        self.assertFalse(self.state.has_review(self.candidate, FORUM["id"]))
        self.assertEqual(self.state.ready_parts(self.held.event.identity), [])

    def test_no_bulk_release_and_same_approval_cannot_be_reused(self):
        self.release()
        with self.assertRaisesRegex(ValidationError, "not_releasable"):
            self.release()
        other = review_candidate(event(3, text="そちらはいかがでしょうか。"), registry(), self.root)
        self.state.register(plan_for_committee(other.event, Registry([]), self.root))
        with self.assertRaisesRegex(ValidationError, "target_or_content_changed"):
            self.state.release(other, self.approval, forum_id=FORUM["id"], approved_reviewers=frozenset({REVIEWER}))

    def test_recognizable_credentials_or_unknown_org_cannot_get_review_candidate(self):
        with self.assertRaisesRegex(ValidationError, "not_releasable"):
            review_candidate(event(3, text="提出用 password=fixture-value"), registry(), self.root)
        with self.assertRaisesRegex(ValidationError, "verified_organization"):
            review_candidate(event(3, text="会場で準備します"), Registry([]), self.root)

    def test_generic_candidate_or_forged_approval_cannot_release_credential_material(self):
        unsafe = plan_event(event(3, text="申請の password=fixture-value"), registry(), self.root)
        self.state.register(plan_for_committee(unsafe.event, Registry([]), self.root))
        with self.assertRaisesRegex(ValidationError, "not_releasable"):
            make_approval(unsafe, FORUM["id"], REVIEWER, reviewed_non_sensitive=True)
        forged = dataclasses.replace(self.approval, receive_key=unsafe.event.receive_key,
            identity=unsafe.event.identity, event_digest=unsafe.event.digest,
            plan_fingerprint=unsafe.fingerprint)
        with self.assertRaisesRegex(ValidationError, "not_releasable"):
            self.state.release(unsafe, forged, forum_id=FORUM["id"], approved_reviewers=frozenset({REVIEWER}))
        self.assertEqual(self.state.status(unsafe.event.identity), "held")


class RunnerTests(StateFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.state._set("activated_at", (event(1).sent_at-timedelta(seconds=1)).isoformat())
        self.api = FakeAPI()
        self.delivery = Delivery(self.api, self.state, FORUM, CATEGORY, self.root)

    def cycle(self, events, table=None, contacts=None):
        return process_cycle(events, table or registry(), contacts or {}, self.root, self.state, self.delivery)

    def test_baseline_and_redelivery_do_not_post(self):
        old = event(1)
        duplicate = event(2, message_id="50001", text=old.text)
        counts = self.cycle([old, duplicate])
        self.assertEqual(counts, {"baseline_ignored": 1, "duplicate": 1})
        self.assertEqual(self.api.posts, [])

    def test_unknown_and_internal_hold_while_other_new_ops_event_delivers(self):
        unknown = event(2, uid="unknown", text="会場で備品を準備します")
        internal = event(3, uid="internal", text="会場で備品を準備します")
        safe = event(4, text="会場で備品を準備します")
        counts = self.cycle([unknown, internal, safe], contacts={"internal": {}})
        self.assertEqual(counts, {"held": 2, "delivered": 1})
        result = summary(self.state)
        self.assertEqual(result["scan_cursor"], key(4))
        self.assertEqual(result["delivered_cursor"], key(1))
        self.assertEqual(result["confirmed_parts"], 1)

    def test_old_sent_time_new_receive_key_is_held(self):
        old = event(2, text="会場で準備します", timestamp=1791640000000-10000)
        self.assertEqual(self.cycle([old]), {"held": 1})
        self.assertEqual(self.api.posts, [])

    def test_mapping_added_later_does_not_auto_release_held_backlog(self):
        unknown = event(2, uid="unmapped", text="会場で準備します")
        self.cycle([unknown])
        counts = self.cycle([unknown], table=registry(uid="unmapped"))
        self.assertEqual(counts, {"held": 1})
        self.assertEqual(self.api.posts, [])

    def test_delivery_time_budget_queues_without_post_and_retries_next_cycle(self):
        safe = event(2, text="会場で準備します")
        first = process_cycle([safe], registry(), {}, self.root, self.state, self.delivery, max_seconds=0)
        self.assertEqual(first, {"queued_for_next_cycle": 1})
        self.assertEqual(self.api.posts, [])
        self.assertEqual(self.cycle([safe]), {"delivered": 1})

    def test_prepare_config_never_enables_live_flow(self):
        with self.assertRaisesRegex(ValidationError, "not_explicitly_approved"):
            validate_config({"mode": "prepare_only"})


if __name__ == "__main__":
    unittest.main()
