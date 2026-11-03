# -*- coding: utf-8 -*-
"""ロール付与状況(/roles・discord/roles_current.md)の試験。実 Discord には接続しない。"""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import discord  # noqa: E402

from iyakusai_bot import help as H  # noqa: E402
from iyakusai_bot import role_logic as L  # noqa: E402
from iyakusai_bot import roles as R  # noqa: E402

G = 900
SOUMU, KAIKEI, EMPTY, BOT_ROLE = 10, 11, 12, 13
ROLES = [
    {"id": str(G), "name": "@everyone", "position": 0, "managed": False},
    {"id": str(KAIKEI), "name": "会計課", "position": 2, "managed": False},
    {"id": str(SOUMU), "name": "総務部", "position": 3, "managed": False},
    {"id": str(EMPTY), "name": "空のロール", "position": 1, "managed": False},
    {"id": str(BOT_ROLE), "name": "IyakusaiBot", "position": 4, "managed": True},
]


def member(uid, *roles, nick=None, global_name=None, username="handle", bot=False):
    return {"nick": nick, "roles": [str(r) for r in roles],
            "user": {"id": str(uid), "username": username, "global_name": global_name, "bot": bot}}


MEMBERS = [
    member(1, SOUMU, KAIKEI, nick="医薬 花子", global_name="ExampleUser"),
    member(2, SOUMU, global_name="全名だけ"),
    member(3, username="ハンドルだけ"),
    member(4, BOT_ROLE, nick="IyakusaiBot", bot=True),
]


def roster():
    return L.build_roster(G, "テスト委員会", ROLES, MEMBERS)


class FakeHttp:
    """Discord の REST の代わり。ページごとの呼び出しを記録する。"""

    def __init__(self, members=MEMBERS, forbidden=False):
        self.members = sorted(members, key=lambda m: int(m["user"]["id"]))
        self.forbidden = forbidden
        self.calls = []

    async def get_members(self, guild_id, limit, after):
        self.calls.append((guild_id, limit, after))
        if self.forbidden:
            raise discord.Forbidden(SimpleNamespace(status=403, reason="Forbidden"), "Missing Access")
        rest = [m for m in self.members if after is None or int(m["user"]["id"]) > after]
        return rest[:limit]

    async def get_roles(self, guild_id):
        return ROLES


class FakeFollowup:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, *, embed=None, ephemeral=False):
        self.sent.append(SimpleNamespace(content=content, embed=embed, ephemeral=ephemeral))


class FakeResponse:
    def __init__(self):
        self.deferred = None

    async def defer(self, *, ephemeral=False):
        self.deferred = ephemeral


def interaction():
    return SimpleNamespace(guild=SimpleNamespace(id=G, name="テスト委員会"),
                           response=FakeResponse(), followup=FakeFollowup())


class RosterTests(unittest.TestCase):
    def test_leaves_out_everyone_managed_roles_and_bots(self):
        r = roster()
        self.assertEqual([x.name for x in r.roles], ["総務部", "会計課", "空のロール"])
        self.assertEqual({p.id for p in r.people}, {1, 2, 3})

    def test_name_prefers_server_nickname(self):
        self.assertEqual({p.id: p.name for p in roster().people},
                         {1: "医薬 花子", 2: "全名だけ", 3: "ハンドルだけ"})

    def test_lookups(self):
        r = roster()
        self.assertEqual([p.id for p in r.members_of(KAIKEI)], [1])
        self.assertEqual([x.name for x in r.roles_of(r.person(1))], ["総務部", "会計課"])
        self.assertEqual([p.id for p in r.without_role()], [3])

    def test_person_with_only_a_bot_role_counts_as_having_no_role(self):
        r = L.build_roster(G, "x", ROLES, [member(5, BOT_ROLE, nick="人")])
        self.assertEqual([p.id for p in r.without_role()], [5])


class TextTests(unittest.TestCase):
    def test_markdown_lists_both_directions_with_time_in_jst(self):
        now = datetime(2026, 10, 30, 19, 5, tzinfo=timezone.utc)
        text = L.render_markdown([roster()], now, 10)
        self.assertIn("生成: 2026-10-31 04:05 JST(約10分ごとに更新)", text)
        self.assertIn("- 総務部(2人): 全名だけ、医薬 花子", text)
        self.assertIn("- 空のロール(0人): (なし)", text)
        self.assertIn("- 医薬 花子: 総務部、会計課", text)
        self.assertIn("### ロールが付いていない人\nハンドルだけ", text)
        self.assertNotIn("IyakusaiBot", text)

    def test_summary_and_single_lookups(self):
        r = roster()
        self.assertIn("**総務部**: 2人", L.summary_text(r))
        self.assertIn("ロールが付いていない人: ハンドルだけ", L.summary_text(r))
        self.assertEqual(L.role_text(r, KAIKEI), "**会計課**(1人)\n医薬 花子")
        self.assertEqual(L.person_text(r, 1), "**医薬 花子**\n総務部、会計課")

    def test_out_of_scope_targets_say_so(self):
        r = roster()
        self.assertIn("対象外", L.role_text(r, BOT_ROLE))
        self.assertIn("対象外", L.person_text(r, 4))

    def test_long_text_stays_inside_the_embed_limit(self):
        many = [member(100 + i, SOUMU, nick=f"委員{i:04}") for i in range(1000)]
        text = L.role_text(L.build_roster(G, "x", ROLES, many), SOUMU)
        self.assertLessEqual(len(text), 4096)
        self.assertTrue(text.endswith("(長いので省略)"))


class FetchTests(unittest.TestCase):
    def test_follows_pages_to_the_end(self):
        http = FakeHttp([member(i, nick=f"委員{i}") for i in range(1, 1502)])
        r = asyncio.run(R.fetch_roster(http, G, "x"))
        self.assertEqual(len(r.people), 1501)
        self.assertEqual([c[2] for c in http.calls], [None, 1000])

    def test_full_last_page_needs_one_empty_page(self):
        http = FakeHttp([member(i, nick=f"委員{i}") for i in range(1, 1001)])
        self.assertEqual(len(asyncio.run(R.fetch_roster(http, G, "x")).people), 1000)
        self.assertEqual(len(http.calls), 2)


class CogTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="roles-"))
        self.bot = SimpleNamespace(http=FakeHttp(), guilds=[SimpleNamespace(id=G, name="テスト委員会")])
        self.cog = R.RoleStatus(self.bot, self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def command(self, **kwargs):
        itx = interaction()
        args = {"ロール": None, "人": None, **kwargs}
        asyncio.run(R.RoleStatus.roles.callback(self.cog, itx, **args))
        return itx

    def test_refresh_writes_the_mirror_file(self):
        asyncio.run(self.cog.loop.coro(self.cog))
        path = self.dir / "discord" / "roles_current.md"
        self.assertIn("- 会計課(1人): 医薬 花子", path.read_text(encoding="utf-8"))
        self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_failed_refresh_keeps_the_previous_file_and_does_not_raise(self):
        asyncio.run(self.cog.loop.coro(self.cog))
        path = self.dir / "discord" / "roles_current.md"
        before = path.read_text(encoding="utf-8")
        self.bot.http.forbidden = True
        with self.assertLogs("iyakusai.roles", level="WARNING"):
            asyncio.run(self.cog.loop.coro(self.cog))
        self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_no_mirror_means_command_only(self):
        cog = R.RoleStatus(self.bot, None)
        asyncio.run(cog.cog_load())
        self.assertFalse(cog.loop.is_running())

    def test_command_without_options_shows_summary_only_to_the_caller(self):
        itx = self.command()
        self.assertTrue(itx.response.deferred)
        sent = itx.followup.sent[0]
        self.assertTrue(sent.ephemeral)
        self.assertIn("**総務部**: 2人", sent.embed.description)

    def test_command_with_role_and_person(self):
        itx = self.command(ロール=SimpleNamespace(id=KAIKEI), 人=SimpleNamespace(id=2))
        text = itx.followup.sent[0].embed.description
        self.assertIn("**会計課**(1人)\n医薬 花子", text)
        self.assertIn("**全名だけ**\n総務部", text)

    def test_forbidden_gets_a_clear_message(self):
        self.bot.http.forbidden = True
        with self.assertLogs("iyakusai.roles", level="ERROR"):
            itx = self.command()
        self.assertIn("Server Members Intent", itx.followup.sent[0].content)
        self.assertTrue(itx.followup.sent[0].ephemeral)


class HelpTests(unittest.TestCase):
    def names(self, **kwargs):
        return [f.name for f in H.build_help_embed(True, **kwargs).fields]

    def test_help_line_only_when_enabled(self):
        self.assertFalse(any("/roles" in n for n in self.names()))
        self.assertTrue(any("/roles" in n for n in self.names(roles_enabled=True)))


if __name__ == "__main__":
    unittest.main()
