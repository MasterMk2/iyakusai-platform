from collections import Counter
import json
from pathlib import Path
import unittest

from oa_relay import GUILD, ValidationError
from operating_policy import ADMIN, BOT, CATEGORY, COMMITTEE_ROLES, VIEW, READ, SEND, IN_THREADS, forum_proposal
from live_access import ADMIN_BOT_EXCEPTION, inspect_access
from forum_provision import provision
from test_oa_relay import FORUM, test_directory


class FakeAccess:
    def __init__(self):
        self.role = next(iter(COMMITTEE_ROLES))
        self.people = [{"id": BOT, "bot": True, "roles": []},
                       {"id": ADMIN_BOT_EXCEPTION, "bot": True, "roles": ["admin"]},
                       {"id": "1777777777777777777", "bot": False, "roles": [self.role]}]
        self.roles = [{"id": GUILD, "permissions": str(VIEW | READ | SEND | IN_THREADS)},
                      {"id": "admin", "permissions": str(ADMIN)}]
        self.roles += [{"id": role, "permissions": "0"} for role in COMMITTEE_ROLES]
        self.counts = dict(Counter(r for m in self.people for r in m["roles"]))
        self.channels = []
        self.posts = []

    def get(self, path):
        if path == "/users/@me":
            return {"id": BOT}
        if path == f"/guilds/{GUILD}":
            return {"id": GUILD, "owner_id": "1777777777777777777"}
        if path.endswith("/roles"):
            return self.roles
        if path.endswith("/roles/member-counts"):
            return self.counts
        if path.endswith("/channels"):
            return self.channels
        if "/members/" in path:
            member = next(m for m in self.people if m["id"] == path.rsplit("/", 1)[-1])
            return {"user": {"id": member["id"], "bot": member["bot"]}, "roles": member["roles"]}
        if path == f"/channels/{CATEGORY}":
            return {"id": CATEGORY, "type": 4, "guild_id": GUILD}
        if path == f"/channels/{FORUM['id']}":
            return self.channels[0]
        raise AssertionError(path)

    def request(self, method, path, *, payload):
        self.posts.append((method, path))
        forum = dict(payload, name=payload["name"].lower(), id=FORUM["id"], guild_id=GUILD)
        self.channels.append(forum)
        return forum

    def ids(self):
        return [m["id"] for m in self.people]


class AccessTests(unittest.TestCase):
    def test_exact_audience_readback_accepts_only_approved_admin_bot(self):
        api = FakeAccess()
        _, _, _, report = inspect_access(api, api.ids(), approved_admin_bots=frozenset({ADMIN_BOT_EXCEPTION}))
        self.assertTrue(report["ready"])
        self.assertEqual(report["committee_administrative_writers"], 1)  # guild owner bypass
        with self.assertRaisesRegex(ValidationError, "audience"):
            inspect_access(api, api.ids())

    def test_unknown_new_role_holder_or_new_admin_blocks_before_post(self):
        for role in [next(iter(COMMITTEE_ROLES)), "admin"]:
            api = FakeAccess()
            api.counts[role] = api.counts.get(role, 0) + 1
            with self.assertRaisesRegex(ValidationError, "membership_changed"):
                inspect_access(api, api.ids(), approved_admin_bots=frozenset({ADMIN_BOT_EXCEPTION}))
            self.assertEqual(api.posts, [])

    def test_changed_forum_overwrite_blocks(self):
        api = FakeAccess()
        proposal = forum_proposal(api.roles, api.people)
        api.channels = [dict(proposal, id=FORUM["id"], guild_id=GUILD)]
        api.channels[0]["permission_overwrites"][0]["deny"] = "0"
        with self.assertRaisesRegex(ValidationError, "permissions_or_name"):
            inspect_access(api, api.ids(), forum_id=FORUM["id"], approved_admin_bots=frozenset({ADMIN_BOT_EXCEPTION}))

    def test_unknown_guild_owner_blocks_even_without_admin_role(self):
        api = FakeAccess()
        original = api.get
        def get(path):
            if path == f"/guilds/{GUILD}":
                return {"id": GUILD, "owner_id": "1999999999999999999"}
            return original(path)
        api.get = get
        with self.assertRaisesRegex(ValidationError, "owner_not_in_verified"):
            inspect_access(api, api.ids(), approved_admin_bots=frozenset({ADMIN_BOT_EXCEPTION}))
        self.assertEqual(api.posts, [])

    def test_provision_normalized_name_is_reused_without_duplicate_creation(self):
        api = FakeAccess()
        with test_directory() as folder:
            path = Path(folder) / "receipt.json"
            first = provision(api, api.ids(), path, approved_exception=True)
            second = provision(api, api.ids(), path, approved_exception=True)
            self.assertTrue(first["created_this_run"])
            self.assertFalse(second["created_this_run"])
            self.assertEqual(len(api.posts), 1)
            self.assertEqual(second["forum_id"], FORUM["id"])

    def test_unknown_creation_and_absent_forum_do_not_recreate(self):
        api = FakeAccess()
        with test_directory() as folder:
            path = Path(folder) / "receipt.json"
            path.write_text(json.dumps({"state": "creating"}))
            with self.assertRaisesRegex(ValidationError, "requires_reconciliation"):
                provision(api, api.ids(), path, approved_exception=True)
            self.assertEqual(api.posts, [])


if __name__ == "__main__":
    unittest.main()
