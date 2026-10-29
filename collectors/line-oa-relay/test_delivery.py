import dataclasses
import hashlib
import json
from pathlib import Path
import unittest

from oa_relay import Attachment, Part, ValidationError, Journal, plan_event
from operating_policy import BOT, plan_for_committee
from discord_transport import DiscordAPI, OutcomeUnknown, Rejected, Response, multipart
from delivery import Delivery, validate_message
from test_oa_relay import StateFixture, FORUM, CATEGORY, THREAD, event, key, registry, test_directory


def message(plan, number=1, *, thread_id=THREAD["id"], message_id="1888888888888888888"):
    part = plan.parts[number - 1]
    result = {"id": message_id, "channel_id": thread_id, "author": {"id": BOT},
              "content": part.content, "attachments": []}
    if part.attachment:
        result["attachments"] = [{"filename": part.attachment.name, "size": part.attachment.size}]
    return result


class FakeAPI:
    def __init__(self):
        self.posts = []
        self.thread_posts = []
        self.messages = []
        self.threads = []
        self.failure = None
        self.bad_author = False

    def create_forum_thread(self, forum_id, plan, root):
        if plan.parts[0].attachment:
            multipart({}, plan.parts[0].attachment, root)
        self.posts.append(("thread", forum_id))
        result = dict(THREAD, name=plan.thread_name, thread_metadata={"archived": False, "locked": False})
        result["message"] = message(plan)
        if self.bad_author:
            result["message"]["author"] = {"id": "1999999999999999999"}
        self.thread_posts.append(result)
        if isinstance(self.failure, Rejected):
            raise self.failure
        self.threads.append(result)
        self.messages.append(result["message"])
        if self.failure:
            raise self.failure
        return result

    def create_message(self, thread_id, plan, part, root):
        self.posts.append(("message", thread_id))
        result = message(plan, part.number, message_id=str(1888888888888888888 + len(self.messages)))
        if isinstance(self.failure, Rejected):
            raise self.failure
        self.messages.append(result)
        if self.failure:
            raise self.failure
        return result

    def get(self, path):
        if path.endswith("/threads/active"):
            return {"threads": self.threads}
        if "/threads/archived/public" in path:
            return {"threads": [], "has_more": False}
        if "/messages?" in path:
            return self.messages[:]
        if path == f"/channels/{THREAD['id']}":
            return self.threads[0]
        raise AssertionError(path)


class TransportTests(unittest.TestCase):
    def normalized_attachment_receipt(self):
        item = Attachment(Path("unused"), "転送動作確認.csv", 81, "0" * 64)
        part = Part(1, "安全な試験 [oa-check:fixture]", "oa-check:fixture", item)
        received = {"id": "1888888888888888888", "channel_id": THREAD["id"],
                    "author": {"id": BOT}, "content": part.content,
                    "attachments": [{"filename": "6b088199a39aa398.csv", "title": "転送動作確認", "size": 81}]}
        return part, received

    def test_live_japanese_filename_normalization_is_confirmed(self):
        part, received = self.normalized_attachment_receipt()
        self.assertEqual(validate_message(received, THREAD["id"], part), received["id"])

    def test_normalized_filename_requires_exact_title_suffix_size(self):
        for field, value in [("title", None), ("title", "別のファイル"),
                             ("filename", "6b088199a39aa398.pdf"),
                             ("filename", "different.csv"), ("size", 82)]:
            with self.subTest(field=field, value=value):
                part, received = self.normalized_attachment_receipt()
                received["attachments"][0][field] = value
                with self.assertRaisesRegex(ValidationError, "attachment_mismatch"):
                    validate_message(received, THREAD["id"], part)

    def test_normalized_attachment_does_not_relax_author_body_destination(self):
        for field, value in [("author", {"id": "1999999999999999999"}),
                             ("content", "違う本文"), ("channel_id", "1999999999999999999")]:
            part, received = self.normalized_attachment_receipt()
            received[field] = value
            with self.assertRaisesRegex(ValidationError, "author_destination_or_content"):
                validate_message(received, THREAD["id"], part)

    def test_default_read_only_gate_stops_before_http(self):
        calls = []
        api = DiscordAPI("fixture-token-not-real", requester=lambda *args: calls.append(args))
        with self.assertRaisesRegex(ValidationError, "writes_disabled"):
            api.request("POST", "/channels/123/messages", payload={"content": "fixture"})
        self.assertEqual(calls, [])
        self.assertNotIn("fixture-token", repr(api))

    def test_http_5xx_timeout_bad_json_leave_result_unknown_without_retry(self):
        for response in [Response(502, b'{}', {}), Response(200, b'broken', {}), Response(200, b'[]', {})]:
            calls = []
            def request(*args):
                calls.append(args)
                return response
            api = DiscordAPI("fixture", writes_enabled=True, requester=request)
            with self.assertRaises(OutcomeUnknown):
                api.request("POST", "/channels/123/messages", payload={"content": "fixture"})
            self.assertEqual(len(calls), 1)
        def timeout(*args):
            raise TimeoutError("fixture")
        with self.assertRaises(OutcomeUnknown):
            DiscordAPI("fixture", requester=timeout).get("/users/@me")

    def test_429_uses_server_delay_and_suppresses_early_requests(self):
        calls = []
        def request(*args):
            calls.append(args)
            return Response(429, b'{"retry_after":12.5}', {})
        api = DiscordAPI("fixture", requester=request, clock=lambda: 1000)
        for _ in range(2):
            with self.assertRaises(Rejected) as raised:
                api.get("/users/@me")
            self.assertEqual(raised.exception.retry_after, 12.5)
        self.assertEqual(len(calls), 1)

    def test_enforce_nonce_and_mentions_are_exact_for_regular_message(self):
        calls = []
        def request(method, path, body, headers):
            calls.append((path, json.loads(body)))
            return Response(200, b'{}', {})
        plan = plan_for_committee(event(2, text="備品を提出します。"), registry(), Path("unused"))
        api = DiscordAPI("fixture", writes_enabled=True, requester=request)
        api.create_message(THREAD["id"], plan, plan.parts[0], Path("unused"))
        api.create_message(THREAD["id"], plan, plan.parts[0], Path("unused"))
        one, two = [x[1] for x in calls]
        self.assertTrue(one["enforce_nonce"])
        self.assertEqual(one["nonce"], two["nonce"])
        self.assertEqual(len(one["nonce"]), 25)
        self.assertEqual(one["allowed_mentions"]["parse"], [])

    def test_attachment_bytes_hash_verified_in_upload_buffer(self):
        with test_directory() as folder:
            root = Path(folder)
            path = root / "file"
            path.write_bytes("備品,数量\n机,2".encode())
            data = path.read_bytes()
            item = Attachment(path, "備品.csv", len(data), hashlib.sha256(data).hexdigest())
            body, mime = multipart({"message": {"content": "備品"}}, item, root)
            self.assertIn(data, body)
            self.assertIn(b'files[0]', body)
            self.assertTrue(mime.startswith("multipart/form-data; boundary="))
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValidationError, "changed_after_plan"):
                multipart({}, item, root)


class DeliveryTests(StateFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.api = FakeAPI()
        self.delivery = Delivery(self.api, self.state, FORUM, CATEGORY, self.root)

    def operational_plan(self, n, text="説明会は10時から会場で開催します。"):
        return plan_for_committee(event(n, text=text), registry(), self.root)

    def test_success_creates_one_org_thread_and_cursor_advances(self):
        first = self.operational_plan(2)
        self.state.register(first)
        self.assertEqual(self.delivery.dispatch(first), "delivered")
        self.assertEqual(self.state.value("delivered_cursor"), first.event.receive_key)
        second = self.operational_plan(3, "当日の備品は机2台です。")
        self.state.register(second)
        self.assertEqual(self.delivery.dispatch(second), "delivered")
        self.assertEqual([p[0] for p in self.api.posts], ["thread", "message"])

    def test_restart_unknown_creation_positive_readback_no_repost(self):
        plan = self.operational_plan(2)
        self.state.register(plan)
        self.api.failure = OutcomeUnknown()
        self.assertEqual(self.delivery.dispatch(plan), "unknown")
        self.state.close()
        self.state = Journal(self.path)
        self.delivery = Delivery(self.api, self.state, FORUM, CATEGORY, self.root)
        self.api.failure = None
        self.assertEqual(self.delivery.dispatch(plan), "delivered")
        self.assertEqual(len(self.api.posts), 1)

    def test_missing_receipt_never_authorizes_repost(self):
        plan = self.operational_plan(2)
        self.state.register(plan)
        self.api.failure = OutcomeUnknown()
        self.delivery.dispatch(plan)
        self.api.threads.clear()
        self.api.messages.clear()
        self.assertEqual(self.delivery.dispatch(plan), "unknown")
        self.assertEqual(len(self.api.posts), 1)
        self.assertEqual(self.state.value("delivered_cursor"), key(1))

    def test_regular_message_timeout_reconciles_exact_bot_body(self):
        first = self.operational_plan(2)
        self.state.register(first)
        self.delivery.dispatch(first)
        second = self.operational_plan(3, "会場へ備品を搬入します。")
        self.state.register(second)
        self.api.failure = OutcomeUnknown()
        self.assertEqual(self.delivery.dispatch(second), "unknown")
        self.api.failure = None
        self.assertEqual(self.delivery.dispatch(second), "delivered")
        self.assertEqual(len(self.api.posts), 2)

    def test_other_author_same_marker_not_a_receipt(self):
        plan = self.operational_plan(2)
        self.state.register(plan)
        self.api.bad_author = True
        self.assertEqual(self.delivery.dispatch(plan), "unknown")
        self.assertEqual(self.delivery.dispatch(plan), "unknown")
        self.assertEqual(len(self.api.posts), 1)

    def test_ambiguous_duplicate_receipts_do_not_confirm(self):
        plan = self.operational_plan(2)
        self.state.register(plan)
        self.api.failure = OutcomeUnknown()
        self.delivery.dispatch(plan)
        self.api.messages.append(dict(self.api.messages[0], id="1999999999999999999"))
        self.assertEqual(self.delivery.reconcile(plan), "ambiguous_receipts")
        self.assertEqual(self.state.status(plan.event.identity), "planned")

    def test_explicit_4xx_is_held_while_429_can_be_retried_later(self):
        for status in [403, 429]:
            with self.subTest(status=status):
                plan = self.operational_plan(status)
                self.state.register(plan)
                self.api.failure = Rejected(status, 1 if status == 429 else None)
                result = self.delivery.dispatch(plan)
                self.assertEqual(result, "rate_limited" if status == 429 else "rejected")
                self.assertFalse(self.state.sending_parts(plan.event.identity))
                self.assertEqual(self.state.status(plan.event.identity), "planned" if status == 429 else "held")
                self.assertFalse(self.state.db.execute("SELECT org_id FROM threads").fetchone())

    def test_generic_planner_cannot_bypass_sensitive_gate(self):
        plan = plan_event(event(2, text="password=fixture-value"), registry(), self.root)
        self.state.register(plan)
        with self.assertRaisesRegex(ValidationError, "not_screened"):
            self.delivery.dispatch(plan)
        self.assertEqual(self.api.posts, [])

    def test_long_free_text_all_parts_ordered_and_receipted(self):
        plan = self.operational_plan(2, "備品の搬入を調整します。" * 500)
        self.state.register(plan)
        self.assertEqual(self.delivery.dispatch(plan), "delivered")
        self.assertEqual(len(self.api.posts), len(plan.parts))
        self.assertFalse(self.state.ready_parts(plan.event.identity))


if __name__ == "__main__":
    unittest.main()
