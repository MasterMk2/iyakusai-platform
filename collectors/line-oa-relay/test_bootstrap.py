import unittest

from bootstrap_threads import ensure_thread
from oa_relay import Binding, GUILD
from operating_policy import BOT
from discord_transport import OutcomeUnknown, Rejected
from test_oa_relay import StateFixture, FORUM, CATEGORY

BINDING = Binding("user", "Ufixture", "org_test", "試験団体", True, "fixture-proof", "fixture-reviewer")


class BootstrapAPI:
    def __init__(self):
        self.channels = []
        self.posts = 0
        self.failure = None
        self.lost = False

    def get(self, path):
        if path.endswith("/threads/active"):
            return {"threads": self.channels}
        if "/threads/archived/" in path:
            return {"threads": [], "has_more": False}
        if "/messages?" in path:
            return [self.channels[0]["message"]]
        if "/messages/" in path:
            return self.channels[0]["message"]
        return self.channels[0]

    def request(self, method, path, *, payload):
        self.posts += 1
        if isinstance(self.failure, Rejected):
            raise self.failure
        channel = {"id": "1777777777777777777", "guild_id": GUILD, "parent_id": FORUM["id"], "type": 11, "name": payload["name"]}
        channel["message"] = {"id": channel["id"], "channel_id": channel["id"], "author": {"id": BOT}, "content": payload["message"]["content"], "attachments": []}
        if not self.lost:
            self.channels.append(channel)
        if self.failure:
            raise self.failure
        return channel


class BootstrapTests(StateFixture, unittest.TestCase):
    def test_safe_setup_once_then_ready_thread_is_reused(self):
        api = BootstrapAPI()
        first = ensure_thread(api, self.state, BINDING, FORUM, CATEGORY)
        second = ensure_thread(api, self.state, BINDING, FORUM, CATEGORY)
        self.assertTrue(first["created_this_run"])
        self.assertFalse(second["created_this_run"])
        self.assertEqual(api.posts, 1)
        self.assertIn("LINEの受信原文ではありません", api.channels[0]["message"]["content"])
        self.assertEqual(self.state.db.execute("SELECT state FROM threads").fetchone()[0], "ready")

    def test_unknown_creation_positive_reconciliation_does_not_repost(self):
        api = BootstrapAPI()
        api.failure = OutcomeUnknown()
        with self.assertRaises(OutcomeUnknown):
            ensure_thread(api, self.state, BINDING, FORUM, CATEGORY)
        api.failure = None
        result = ensure_thread(api, self.state, BINDING, FORUM, CATEGORY)
        self.assertFalse(result["created_this_run"])
        self.assertEqual(api.posts, 1)

    def test_unknown_creation_without_evidence_remains_unconfirmed(self):
        api = BootstrapAPI()
        api.failure, api.lost = OutcomeUnknown(), True
        for _ in range(2):
            with self.assertRaises(OutcomeUnknown):
                ensure_thread(api, self.state, BINDING, FORUM, CATEGORY)
        self.assertEqual(api.posts, 1)

    def test_explicit_rejection_is_blocked_no_automatic_repeat(self):
        api = BootstrapAPI()
        api.failure = Rejected(403)
        with self.assertRaises(Rejected):
            ensure_thread(api, self.state, BINDING, FORUM, CATEGORY)
        with self.assertRaisesRegex(ValueError, "previous_rejection"):
            ensure_thread(api, self.state, BINDING, FORUM, CATEGORY)
        self.assertEqual(api.posts, 1)


if __name__ == "__main__":
    unittest.main()
