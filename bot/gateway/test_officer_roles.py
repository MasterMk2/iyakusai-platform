"""2026-11-03 セキュリティレビュー L5: 役員の判定はロール ID(officer_role_ids)で行い、名前は設定が無いときの代替。"""
from __future__ import annotations

import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("bot_task_gateway", Path(__file__).with_name("bot_task_gateway.py"))
api = importlib.util.module_from_spec(spec)
sys.modules["bot_task_gateway"] = api
spec.loader.exec_module(api)

GUILD, OWNER, ALICE, BOT, NAMED_ROLE, OTHER_ROLE = (str(2000000000000000000 + n) for n in range(1, 7))
SETTINGS = types.SimpleNamespace(guild_ids={int(GUILD)}, allows=lambda *_: True)
DEPTS = {"naimu": ("Naimu", None)}


def discord(member_roles):
    guild = {"id": GUILD, "owner_id": OWNER, "roles": [
        {"id": GUILD, "permissions": str(api.VIEW | api.SEND), "name": "@everyone"},
        {"id": NAMED_ROLE, "permissions": "0", "name": "委員長"},
        {"id": OTHER_ROLE, "permissions": "0", "name": "Synthetic role"},
    ]}
    members = {ALICE: {"user": {"id": ALICE, "username": "Synthetic", "bot": False}, "roles": list(member_roles)}}

    def get(path, deadline, optional_member=False):
        if path == f"/guilds/{GUILD}":
            return guild
        for identifier, member in members.items():
            if path == f"/guilds/{GUILD}/members/{identifier}":
                return member
        if optional_member:
            return None
        raise AssertionError(path)
    return types.SimpleNamespace(get=get)


class OfficerRoleTests(unittest.TestCase):
    def context(self, roles, officer_role_ids=None):
        return api.LiveContext(discord(roles), SETTINGS, api.uid(ALICE), BOT, api.SharedDiscordCache(), DEPTS, officer_role_ids=officer_role_ids)

    def test_role_ids_decide_when_configured(self):
        # A role merely named 委員長 is not enough once IDs are configured.
        self.assertEqual(self.context([NAMED_ROLE], officer_role_ids={OTHER_ROLE}).committee_role(), "editor")
        self.assertEqual(self.context([OTHER_ROLE], officer_role_ids={OTHER_ROLE}).committee_role(), "admin")
        self.assertEqual(self.context([], officer_role_ids={OTHER_ROLE}).committee_role(), "editor")

    def test_names_are_the_fallback_without_configuration(self):
        self.assertEqual(self.context([NAMED_ROLE]).committee_role(), "admin")
        self.assertEqual(self.context([OTHER_ROLE]).committee_role(), "editor")

    def test_configuration_parsing(self):
        self.assertEqual(api.officer_role_ids({}), frozenset())
        self.assertEqual(api.officer_role_ids({"officer_role_ids": [NAMED_ROLE, OTHER_ROLE]}), frozenset({NAMED_ROLE, OTHER_ROLE}))
        for bad in ([], "x", [123], ["not-an-id"], [NAMED_ROLE, 5]):
            with self.assertRaises(ValueError):
                api.officer_role_ids({"officer_role_ids": bad})

    def test_example_site_json_still_parses(self):
        json.loads(Path(__file__).with_name("site.example.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
