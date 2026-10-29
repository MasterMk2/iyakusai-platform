import dataclasses
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from oa_relay import (ACCOUNT, Attachment, Binding, GUILD, Journal, Registry,
    ValidationError, normalize_store, plan_event, read_store_events, safe_name,
    utf16_len, validate_destination, verify_attachment, EXISTING_MYLINE_FORUM)
from operating_policy import CATEGORY as CATEGORY_ID


TEST_ROOT = Path(__file__).resolve().parent / ".test-tmp"
TEST_ROOT.mkdir(exist_ok=True)


def test_directory():
    result = tempfile.TemporaryDirectory(prefix="case-", dir=TEST_ROOT)
    if not Path(result.name).resolve().is_relative_to(TEST_ROOT.resolve()):
        raise RuntimeError("test_temp_outside_workspace")
    return result


def key(n):
    return f"ev:20261011:{1791640000000+n:015d}:00:{n:08x}"


def event(n, *, message_id=None, uid="Ufixture", kind="text", text="試験用本文", **overrides):
    record = {"event_type": "message", "timestamp": 1791640000123,
              "source_type": "user", "user_id": uid, "group_id": None,
              "message_type": kind, "message_id": message_id if message_id is not None else str(50000+n),
              "text": text, "file_name": None, "extra": None,
              "media_error": None, "display_name": "名前から団体を推測しない"}
    record.update(overrides)
    return normalize_store(record, key(n), provenance="official_oa_store")


def registry(*, verified=True, uid="Ufixture"):
    return Registry([Binding("user", uid, "org_test", "試験団体", verified,
                             "fixture:manual-confirmation", "fixture-reviewer")])


class NormalizeTests(unittest.TestCase):
    def test_private_myline_provenance_rejected(self):
        with self.assertRaisesRegex(ValidationError, "non_official"):
            normalize_store({}, key(1), provenance="myline")

    def test_jst_original_seconds_and_milliseconds_preserved(self):
        item = event(1)
        self.assertEqual(item.sent_at.utcoffset().total_seconds(), 9 * 3600)
        self.assertEqual(item.sent_at.microsecond, 123000)
        self.assertEqual(item.sent_at.timestamp(), 1791640000.123)

    def test_same_message_new_receive_key_has_same_identity(self):
        first = event(1, message_id="777")
        second = event(2, message_id="777")
        self.assertEqual(first.identity, second.identity)
        self.assertNotEqual(first.receive_key, second.receive_key)

    def test_unsend_separate_identity_from_original(self):
        message = event(1, message_id="777")
        unsend = event(2, message_id="777", event_type="unsend", message_type=None)
        self.assertNotEqual(message.identity, unsend.identity)

    def test_missing_original_timestamp_rejected(self):
        with self.assertRaisesRegex(ValidationError, "timestamp"):
            event(1, timestamp=None)

    def test_missing_message_identity_rejected(self):
        with self.assertRaisesRegex(ValidationError, "stable_message"):
            event(1, message_id="")

    def test_unsafe_media_identity_rejected(self):
        with self.assertRaisesRegex(ValidationError, "unsafe_media"):
            event(1, message_id="../outside", kind="file")

    def test_group_routes_by_group_not_author(self):
        item = event(1, source_type="group", group_id="Gfixture")
        self.assertEqual(item.source_id, "Gfixture")

    def test_store_reader_uses_filename_receive_key(self):
        with test_directory() as directory:
            root = Path(directory)
            day = root / "20261011"
            day.mkdir()
            record = {"event_type": "message", "timestamp": 1791640000123,
                      "source_type": "user", "user_id": "Ufixture",
                      "message_type": "text", "message_id": "777", "text": "試験"}
            (day / (key(1).replace(":", "-") + ".json")).write_text(json.dumps(record), encoding="utf-8")
            self.assertEqual(list(read_store_events(root))[0].receive_key, key(1))


class RegistryTests(unittest.TestCase):
    def test_display_name_does_not_resolve_organization(self):
        self.assertIsNone(Registry([]).resolve(event(1)))

    def test_unverified_binding_remains_held(self):
        result = plan_event(event(1), registry(verified=False), Path("does-not-exist"))
        self.assertEqual(result.disposition, "held")
        self.assertEqual(result.parts, ())

    def test_duplicate_source_binding_rejected(self):
        first = Binding("user", "Ufixture", "org_a", "団体A", True, "proof", "reviewer")
        second = Binding("user", "Ufixture", "org_b", "団体B", True, "proof", "reviewer")
        with self.assertRaisesRegex(ValidationError, "ambiguous"):
            Registry([first, second])

    def test_two_verified_contacts_share_one_org(self):
        bindings = [Binding("user", source, "org_a", "団体A", True, "proof", "reviewer")
                    for source in ["Ua", "Ub"]]
        table = Registry(bindings)
        self.assertEqual(table.resolve(event(1, uid="Ua")).org_id,
                         table.resolve(event(2, uid="Ub")).org_id)

    def test_conflicting_names_for_one_org_rejected(self):
        bindings = [Binding("user", "Ua", "org_a", "団体A", True, "proof", "reviewer"),
                    Binding("user", "Ub", "org_a", "団体B", True, "proof", "reviewer")]
        with self.assertRaisesRegex(ValidationError, "conflicting_org"):
            Registry(bindings)

    def test_verified_without_evidence_rejected(self):
        with self.assertRaisesRegex(ValidationError, "without_evidence"):
            Registry([Binding("user", "Ufixture", "org_a", "団体A", True, "", "reviewer")])


class PlanTests(unittest.TestCase):
    def test_long_emoji_text_split_with_jst_mentions_disabled(self):
        source = "😀@everyone<@123456789012345678>\n" * 130
        result = plan_event(event(1, text=source), registry(), Path("unused"))
        self.assertGreater(len(result.parts), 1)
        rebuilt = ""
        for part in result.parts:
            self.assertLessEqual(utf16_len(part.content), 2000)
            self.assertIn("JST", part.content)
            self.assertEqual(part.discord_payload()["allowed_mentions"]["parse"], [])
            self.assertEqual(part.discord_payload()["flags"], 4096 | 4)
            rebuilt += part.content.split("\n", 1)[1].rsplit("\n[", 1)[0]
        self.assertEqual(rebuilt, source)

    def test_unsupported_content_is_held_not_dropped(self):
        result = plan_event(event(1, kind="new_kind"), registry(), Path("unused"))
        self.assertEqual((result.disposition, result.reason), ("held", "unsupported_message_type"))

    def test_follow_does_not_publish_body(self):
        result = plan_event(event(1, event_type="follow", text="private-system-value"), registry(), Path("unused"))
        self.assertEqual(result.disposition, "policy_skipped")
        self.assertFalse(result.parts)

    def test_attachment_only_first_part_and_hash(self):
        with test_directory() as directory:
            root = Path(directory)
            (root / "50001").write_bytes(b"fixture-file")
            item = event(1, kind="file", file_name="../../name.pdf")
            result = plan_event(item, registry(), root)
            attachment = result.parts[0].attachment
            self.assertEqual(attachment.name, "name.pdf")
            self.assertEqual(attachment.size, 12)
            self.assertEqual(len(attachment.sha256), 64)

    def test_missing_attachment_reported_without_external_url(self):
        result = plan_event(event(1, kind="image"), registry(), Path("not-a-directory"))
        self.assertEqual(result.attachment_issue, "media_unavailable")
        self.assertIn("media_unavailable", result.parts[0].content)
        self.assertNotIn("http", result.parts[0].content)

    def test_source_attachment_error_not_echoed(self):
        result = plan_event(event(1, kind="file", media_error="secret-url-value"), registry(), Path("unused"))
        self.assertEqual(result.attachment_issue, "source_media_error")
        self.assertNotIn("secret-url-value", result.parts[0].content)

    def test_oversize_attachment_explicit(self):
        with test_directory() as directory:
            root = Path(directory)
            (root / "50001").write_bytes(b"0123456789")
            result = plan_event(event(1, kind="file"), registry(), root, max_attachment_bytes=5)
            self.assertEqual(result.attachment_issue, "media_over_upload_limit")
            self.assertIsNone(result.parts[0].attachment)

    def test_symlink_resolving_outside_store_rejected(self):
        with test_directory() as directory:
            root = Path(directory) / "media"
            root.mkdir()
            candidate = root / "50001"
            candidate.write_bytes(b"fixture")
            outside = Path(directory) / "outside"
            outside.write_bytes(b"private")
            original_resolve = Path.resolve

            def resolve(path, *args, **kwargs):
                return outside if path == candidate else original_resolve(path, *args, **kwargs)

            with patch.object(Path, "resolve", resolve):
                with self.assertRaisesRegex(ValidationError, "outside_official"):
                    plan_event(event(1, kind="file"), registry(), root)

    def test_location_keeps_coordinates(self):
        result = plan_event(event(1, kind="location", extra={"latitude": 36.7, "longitude": 137.2}), registry(), Path("unused"))
        self.assertIn("36.7", result.parts[0].content)
        self.assertIn("137.2", result.parts[0].content)

    def test_attachment_changed_before_send_is_rejected(self):
        with test_directory() as directory:
            root = Path(directory)
            (root / "50001").write_bytes(b"original")
            plan = plan_event(event(1, kind="file"), registry(), root)
            attachment = plan.parts[0].attachment
            verify_attachment(attachment, root)
            (root / "50001").write_bytes(b"modified")
            with self.assertRaisesRegex(ValidationError, "changed_after_plan"):
                verify_attachment(attachment, root)


class StateFixture:
    def setUp(self):
        self.temp = test_directory()
        self.root = Path(self.temp.name)
        self.path = self.root / "oa-test.sqlite"
        self.state = Journal(self.path)
        self.state.initialize([event(1)])

    def tearDown(self):
        self.state.close()
        self.temp.cleanup()

    def plan(self, number, **kwargs):
        return plan_event(event(number, **kwargs), registry(), self.root)

    def deliver(self, plan):
        for part in plan.parts:
            self.state.begin_part(plan, part.number)
            self.state.receipt(plan.event.identity, part.number, str(1111111111111111110 + part.number))


class JournalTests(StateFixture, unittest.TestCase):
    def test_baseline_never_generates_ready_parts(self):
        self.assertEqual(self.state.ready_parts(event(1).identity), [])
        self.assertEqual(self.state.value("baseline"), key(1))

    def test_history_redelivery_new_key_suppressed(self):
        result = self.plan(2, message_id="50001")
        self.assertEqual(self.state.register(result), "duplicate")
        self.assertEqual(self.state.ready_parts(result.event.identity), [])

    def test_no_initialize_without_baseline(self):
        other = Journal(self.root / "empty.sqlite")
        try:
            with self.assertRaisesRegex(ValidationError, "observed_events"):
                other.initialize([])
            with self.assertRaisesRegex(ValidationError, "baseline_missing"):
                other.register(self.plan(2))
        finally:
            other.close()

    def test_cannot_reset_existing_baseline(self):
        with self.assertRaisesRegex(ValidationError, "already_initialized"):
            self.state.initialize([event(9)])
        self.assertEqual(self.state.value("baseline"), key(1))

    def test_held_cursor_separate_from_scan_cursor(self):
        held = plan_event(event(2, uid="unknown"), registry(), self.root)
        self.assertEqual(self.state.register(held), "held")
        later = self.plan(3)
        self.state.register(later)
        self.deliver(later)
        self.assertEqual(self.state.value("scan_cursor"), key(3))
        self.assertEqual(self.state.value("delivered_cursor"), key(1))

    def test_no_automatic_release_on_mapping_change(self):
        held = plan_event(event(2), Registry([]), self.root)
        self.state.register(held)
        now_verified = self.plan(2)
        self.assertEqual(self.state.register(now_verified), "held")
        self.assertFalse(self.state.ready_parts(now_verified.event.identity))

    def test_part_cursor_only_after_all_receipts(self):
        plan = self.plan(2, text="😀" * 4000)
        self.state.register(plan)
        self.state.begin_part(plan, 1)
        self.state.receipt(plan.event.identity, 1, "1111111111111111111")
        self.assertEqual(self.state.value("delivered_cursor"), key(1))
        for part in plan.parts[1:]:
            self.state.begin_part(plan, part.number)
            self.state.receipt(plan.event.identity, part.number, str(1111111111111111110+part.number))
        self.assertEqual(self.state.value("delivered_cursor"), key(2))

    def test_uncertain_post_survives_process_restart(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.state.begin_part(plan, 1)
        self.state.close()
        self.state = Journal(self.path)
        self.assertFalse(self.state.ready_parts(plan.event.identity))
        with self.assertRaisesRegex(ValidationError, "reconciliation"):
            self.state.begin_part(plan, 1)
        # A transport must verify this receipt through Discord before supplying it.
        self.state.receipt(plan.event.identity, 1, "1111111111111111111")
        self.assertEqual(self.state.value("delivered_cursor"), key(2))

    def test_next_part_blocked_while_previous_unconfirmed(self):
        plan = self.plan(2, text="x" * 5000)
        self.state.register(plan)
        self.state.begin_part(plan, 1)
        with self.assertRaisesRegex(ValidationError, "previous_part"):
            self.state.begin_part(plan, 2)

    def test_changed_plan_rejected(self):
        plan = self.plan(2)
        self.state.register(plan)
        changed = dataclasses.replace(plan, thread_name="different-target")
        with self.assertRaisesRegex(ValidationError, "plan_changed"):
            self.state.begin_part(changed, 1)

    def test_body_not_persisted_in_private_state(self):
        plan = self.plan(2, text="do-not-persist-fixture-body")
        self.state.register(plan)
        dump = "\n".join(self.state.db.iterdump())
        self.assertNotIn("do-not-persist-fixture-body", dump)
        self.assertNotIn("Ufixture", dump)

    def test_conflicting_duplicate_is_held(self):
        first = self.plan(2, message_id="888", text="first")
        self.state.register(first)
        second = self.plan(3, message_id="888", text="changed")
        self.assertEqual(self.state.register(second), "held")

    def test_invalid_receipt_does_not_advance_cursor(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.state.begin_part(plan, 1)
        with self.assertRaisesRegex(ValidationError, "invalid_discord"):
            self.state.receipt(plan.event.identity, 1, "not-a-receipt")
        self.assertEqual(self.state.value("delivered_cursor"), key(1))

    def test_transaction_rolls_back_on_partial_insert_failure(self):
        plan = self.plan(2)
        with patch.object(self.state, "_advance", side_effect=RuntimeError("fixture crash")):
            with self.assertRaisesRegex(RuntimeError, "fixture crash"):
                self.state.register(plan)
        self.assertFalse(self.state.db.execute("SELECT key FROM entries WHERE key=?", (key(2),)).fetchone())
        self.assertFalse(self.state.db.execute("SELECT identity FROM deliveries WHERE identity=?", (plan.event.identity,)).fetchone())
        self.assertEqual(self.state.value("scan_cursor"), key(1))

    def test_same_key_cannot_change_identity(self):
        first = self.plan(2)
        self.state.register(first)
        second = self.plan(2, message_id="changed")
        with self.assertRaisesRegex(ValidationError, "changed_identity"):
            self.state.register(second)

    def test_same_key_cannot_silently_change_body(self):
        self.state.register(self.plan(2, text="original"))
        with self.assertRaisesRegex(ValidationError, "changed_content"):
            self.state.register(self.plan(2, text="modified"))

    def test_missing_attachment_keeps_full_delivery_cursor_blocked(self):
        plan = self.plan(2, kind="file")
        self.state.register(plan)
        self.deliver(plan)
        self.assertEqual(self.state.db.execute("SELECT status FROM deliveries WHERE identity=?", (plan.event.identity,)).fetchone()[0], "partial")
        self.assertEqual(self.state.value("delivered_cursor"), key(1))
        self.assertEqual(self.state.db.execute("SELECT issue FROM attachment_issues WHERE identity=?", (plan.event.identity,)).fetchone()[0], "media_unavailable")


FORUM = {"id": "1666666666666666666", "guild_id": GUILD, "type": 15,
         "parent_id": CATEGORY_ID}
CATEGORY = {"id": CATEGORY_ID, "guild_id": GUILD, "type": 4}
THREAD = {"id": "1777777777777777777", "guild_id": GUILD, "type": 11,
          "parent_id": FORUM["id"]}


class ThreadTests(StateFixture, unittest.TestCase):
    def test_excludes_existing_myline_forum(self):
        wrong = dict(FORUM, id=EXISTING_MYLINE_FORUM)
        with self.assertRaisesRegex(ValidationError, "myline_forum_excluded"):
            validate_destination(wrong, CATEGORY)

    def test_forum_cannot_be_parent_of_forum(self):
        wrong = dict(CATEGORY, type=15)
        with self.assertRaisesRegex(ValidationError, "parent_invalid"):
            validate_destination(FORUM, wrong)

    def test_wrong_guild_rejected(self):
        with self.assertRaisesRegex(ValidationError, "scope"):
            validate_destination(dict(FORUM, guild_id="100000000000000999"), CATEGORY)

    def test_starter_receipt_and_thread_mapping_atomic(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.assertIsNone(self.state.begin_thread(plan, FORUM, CATEGORY))
        self.assertFalse(self.state.ready_parts(plan.event.identity))
        self.state.thread_receipt(plan, THREAD, "1777777777777777777")
        self.assertEqual(self.state.value("delivered_cursor"), key(2))
        self.assertEqual(self.state.begin_thread(plan, FORUM, CATEGORY), THREAD["id"])

    def test_create_outcome_unknown_no_duplicate_after_restart(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.state.begin_thread(plan, FORUM, CATEGORY)
        self.state.close()
        self.state = Journal(self.path)
        with self.assertRaisesRegex(ValidationError, "requires_reconciliation"):
            self.state.begin_thread(plan, FORUM, CATEGORY)
        self.state.thread_receipt(plan, THREAD, "1777777777777777777")

    def test_two_contacts_of_org_use_same_thread(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.state.begin_thread(plan, FORUM, CATEGORY)
        self.state.thread_receipt(plan, THREAD, "1777777777777777777")
        second = plan_event(event(3, uid="other_user"), registry(uid="other_user"), self.root)
        self.state.register(second)
        self.assertEqual(self.state.begin_thread(second, FORUM, CATEGORY), THREAD["id"])
        self.assertEqual(self.state.db.execute("SELECT count(*) FROM threads").fetchone()[0], 1)

    def test_wrong_thread_parent_receipt_rolls_back(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.state.begin_thread(plan, FORUM, CATEGORY)
        with self.assertRaisesRegex(ValidationError, "wrong_destination"):
            self.state.thread_receipt(plan, dict(THREAD, parent_id="1888888888888888888"), "1777777777777777777")
        self.assertEqual(self.state.value("delivered_cursor"), key(1))
        self.assertEqual(self.state.db.execute("SELECT state FROM threads").fetchone()[0], "creating")

    def test_starter_invalid_receipt_does_not_store_ready_thread(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.state.begin_thread(plan, FORUM, CATEGORY)
        with self.assertRaisesRegex(ValidationError, "invalid_discord"):
            self.state.thread_receipt(plan, THREAD, "invalid")
        self.assertEqual(self.state.db.execute("SELECT state FROM threads").fetchone()[0], "creating")

    def test_org_forum_change_does_not_create_second_thread(self):
        plan = self.plan(2)
        self.state.register(plan)
        self.state.begin_thread(plan, FORUM, CATEGORY)
        self.state.thread_receipt(plan, THREAD, "1777777777777777777")
        with self.assertRaisesRegex(ValidationError, "forum_changed"):
            self.state.begin_thread(plan, dict(FORUM, id="1888888888888888888"), CATEGORY)


if __name__ == "__main__":
    unittest.main()
