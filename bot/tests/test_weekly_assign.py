"""週1回の一覧の「引き受ける」ボタン(実際のタスク DB に対して)の試験。合成データだけ。

権限の確認そのもの(TaskCog.authorize・本人だけへの返事)は /todo の既存の試験の範囲。ここでは
ボタンが TaskCog._run を通ること、担当の更新が /todo assign と同じ店(TaskStore.update)を通ることを確かめる。
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import discord  # noqa: E402

from iyakusai_bot import weekly_cog as WC  # noqa: E402
from iyakusai_bot.task_cog import TaskCog  # noqa: E402
from iyakusai_bot.task_domain import Actor, Scope, TaskError  # noqa: E402
from iyakusai_bot.task_store import TaskSettings, TaskStore  # noqa: E402

GUILD = 9000000000000001
CHANNEL = 9000000000000002
OTHER_CHANNEL = 9000000000000003
CLICKER = 9000000000000042
OTHER = 9000000000000043


class FakeTaskCog:
    """TaskCog のうち、ボタンの処理が使う部分だけを持つ。_call は実物と同じく保存処理を呼ぶ。"""

    def __init__(self, store: TaskStore):
        self.store = store
        self.run_calls: list[dict] = []

    async def _call(self, fn, *args, **kwargs):
        return fn(*args, **kwargs)

    @staticmethod
    def assignable(access, user):
        # 実物は discord.Member を要求する。ここでは ID を持つ相手として扱う(検査の中身は実物の試験で見る)
        if getattr(user, "bot", False):
            raise TaskError("VALIDATION", "Bot アカウントには割り当てられません。")
        return user.id

    async def _run(self, itx, *, edit, work, name):
        self.run_calls.append({"edit": edit, "name": name})
        access = SimpleNamespace(scope=Scope(GUILD, 1), actor=Actor(user_id=itx.user.id, operation_id="op-button-0001"))
        try:
            content, _file = await work(access)
        except TaskError as error:
            content = f"⚠ {error.message}"
        return content


def _user(uid):
    return SimpleNamespace(id=uid, bot=False)


class AssignWorkTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.store = TaskStore.open(Path(self._dir.name) / "tasks")
        self.cog = FakeTaskCog(self.store)
        actor = Actor(user_id=OTHER, operation_id="op-create-0001")
        self.number = self.store.create(actor, Scope(GUILD, 1), title="合成の依頼", tags=["naimu"]).view.task.number

    def tearDown(self):
        self._dir.cleanup()

    def _click(self, uid):
        """押したときの返信。TaskCog._run と同じく、TaskError は利用者向けの文に変えて返す。"""
        work = WC._assign_work(self.cog, _user(uid), self.number)
        access = SimpleNamespace(scope=Scope(GUILD, 1), actor=Actor(user_id=uid, operation_id="op-button-0001"))

        async def run():
            try:
                return await work(access)
            except TaskError as error:
                return f"⚠ {error.message}", None

        return asyncio.run(run())

    def test_unassigned_task_is_assigned_to_the_clicker_with_history(self):
        content, file = self._click(CLICKER)
        self.assertIsNone(file)
        self.assertIn("主担当を引き受けました", content)
        view = self.store.get_task(Scope(GUILD, 1), self.number)
        self.assertEqual(view.task.assignee_id, CLICKER)
        entries, total = self.store.history(Scope(GUILD, 1), self.number)
        self.assertGreaterEqual(total, 2)                      # 作成のあとに更新の記録が残る

    def test_a_task_that_already_has_an_owner_is_not_changed(self):
        self._click(CLICKER)
        content, _ = self._click(OTHER)
        self.assertIn("すでに主担当が決まっています", content)
        self.assertEqual(self.store.get_task(Scope(GUILD, 1), self.number).task.assignee_id, CLICKER)

    def test_a_second_click_by_the_same_person_says_so_without_changing_anything(self):
        self._click(CLICKER)
        version_before = self.store.get_task(Scope(GUILD, 1), self.number).task.version
        content, _ = self._click(CLICKER)
        self.assertIn("すでにあなたが主担当です", content)
        self.assertEqual(self.store.get_task(Scope(GUILD, 1), self.number).task.version, version_before)

    def test_done_task_cannot_be_taken(self):
        self.store.update(Actor(user_id=OTHER), Scope(GUILD, 1), self.number,
                          self.store.get_task(Scope(GUILD, 1), self.number).task.version,
                          {"status": "done"}, confirmed=True)
        content, _ = self._click(CLICKER)
        self.assertIn("すでに完了", content)
        self.assertIsNone(self.store.get_task(Scope(GUILD, 1), self.number).task.assignee_id)

    def test_missing_task_is_reported_as_not_found(self):
        work = WC._assign_work(self.cog, _user(CLICKER), 987654)
        access = SimpleNamespace(scope=Scope(GUILD, 1), actor=Actor(user_id=CLICKER))
        with self.assertRaises(TaskError) as ctx:
            asyncio.run(work(access))
        self.assertEqual(ctx.exception.code, "NOT_FOUND")


class ButtonTests(unittest.TestCase):
    def test_custom_id_carries_the_task_number_and_matches_the_template(self):
        button = WC.AssignButton(12)
        self.assertEqual(button.item.custom_id, "weekly:assign:12")
        pattern = WC.AssignButton.__discord_ui_compiled_template__
        self.assertIsNotNone(pattern.fullmatch("weekly:assign:12"))
        self.assertIsNone(pattern.fullmatch("weekly:assign:12x"))

    def test_button_goes_through_the_task_command_runner_like_todo_assign(self):
        fake = FakeTaskCog(store=object())                 # 保存先がある(停止中ではない)状態
        fake._run = mock.AsyncMock(return_value=None)
        cogs = {"TaskCog": fake, "WeeklyCog": object()}
        itx = SimpleNamespace(client=SimpleNamespace(get_cog=lambda name: cogs.get(name)),
                              user=_user(CLICKER))
        asyncio.run(WC.assign_from_button(itx, 12))
        fake._run.assert_awaited_once()
        args, kwargs = fake._run.await_args
        self.assertIs(args[0], itx)
        self.assertTrue(kwargs["edit"])
        self.assertEqual(kwargs["name"], "weekly_assign")

    def test_button_reports_when_the_task_feature_is_stopped(self):
        cogs = {"WeeklyCog": object()}                     # 一覧は動いているが、タスク DB が無い
        itx = SimpleNamespace(client=SimpleNamespace(get_cog=lambda name: cogs.get(name)), user=_user(CLICKER),
                              response=SimpleNamespace(send_message=mock.AsyncMock()))
        asyncio.run(WC.assign_from_button(itx, 12))
        itx.response.send_message.assert_awaited_once()
        self.assertTrue(itx.response.send_message.await_args.kwargs["ephemeral"])
        self.assertIn("タスク機能は現在停止中", itx.response.send_message.await_args.args[0])

    def test_an_old_button_reports_when_the_weekly_list_is_stopped(self):
        # [weekly] を止めた後に残っているボタン。タスク機能は動いていても、引き受けは行わない
        cogs = {"TaskCog": object()}
        itx = SimpleNamespace(client=SimpleNamespace(get_cog=lambda name: cogs.get(name)), user=_user(CLICKER),
                              response=SimpleNamespace(send_message=mock.AsyncMock()))
        asyncio.run(WC.assign_from_button(itx, 12))
        itx.response.send_message.assert_awaited_once()
        self.assertIn("週1回のタスク一覧は現在停止中", itx.response.send_message.await_args.args[0])


class MentionTests(unittest.TestCase):
    def test_weekly_posts_send_no_notification_by_default(self):
        mentions = WC._mentions(())
        self.assertFalse(mentions.users)
        self.assertFalse(mentions.everyone)

    def test_candidate_mentions_are_limited_to_the_named_people(self):
        mentions = WC._mentions((CLICKER, OTHER))
        ids = sorted(obj.id for obj in mentions.users)
        self.assertEqual(ids, sorted([CLICKER, OTHER]))
        self.assertFalse(mentions.everyone)
        self.assertFalse(mentions.roles)


def _member(uid, guild_id=GUILD):
    member = mock.Mock(spec=discord.Member)
    member.id = uid
    member.bot = False
    member.guild = SimpleNamespace(id=guild_id)
    member.roles = []    # 本物の Member と同じく一覧を持つ（操作の種類の権限は役割の名前を読む）
    return member


class RealRunTests(unittest.TestCase):
    """本物の TaskCog._run を通す。権限の確認(許可外・閲覧権限なし・メンバーでない)と、本人だけへの返事、DB の無変更を確かめる。"""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.store = TaskStore.open(Path(self._dir.name) / "tasks")
        self.cog = TaskCog(None, TaskSettings(enabled=True, guild_ids=(GUILD,), channel_ids=(CHANNEL,)), self.store)
        self.number = self.store.create(Actor(user_id=OTHER, operation_id="op-create-0001"),
                                        Scope(GUILD, CHANNEL), title="合成の依頼", tags=["naimu"]).view.task.number
        self.guild = SimpleNamespace(id=GUILD, me=SimpleNamespace(name="bot"))

    def tearDown(self):
        self._dir.cleanup()

    def _channel(self, *, channel_id=CHANNEL, user_can_view=True):
        channel = mock.Mock(spec=discord.TextChannel)
        channel.id = channel_id
        channel.name = "naimu"
        channel.guild = self.guild
        bot_perms = SimpleNamespace(view_channel=True, send_messages=True)
        member_perms = SimpleNamespace(view_channel=user_can_view, send_messages=True)
        channel.permissions_for = lambda target: bot_perms if target is self.guild.me else member_perms
        return channel

    def _itx(self, user, channel, cogs):
        defer = mock.AsyncMock()
        return SimpleNamespace(
            id=900000000000000001, guild=self.guild, guild_id=GUILD, channel=channel, user=user,
            permissions=SimpleNamespace(view_channel=True), app_permissions=SimpleNamespace(view_channel=True),
            message=None,
            response=SimpleNamespace(defer=defer, send_message=mock.AsyncMock(),
                                     is_done=mock.Mock(side_effect=lambda: defer.await_count > 0)),
            followup=SimpleNamespace(send=mock.AsyncMock()),
            client=SimpleNamespace(get_cog=lambda name: cogs.get(name)),
        )

    def _state(self):
        view = self.store.get_task(Scope(GUILD, CHANNEL), self.number)
        _entries, total = self.store.history(Scope(GUILD, CHANNEL), self.number)
        return view.task.version, view.task.assignee_id, total

    def _assert_refused(self, itx, fragment):
        itx.response.defer.assert_not_awaited()          # 権限で止まったので、処理は始まらない
        itx.response.send_message.assert_awaited_once()  # 返事は本人にだけ(ephemeral)
        args, kwargs = itx.response.send_message.await_args
        self.assertTrue(kwargs["ephemeral"])
        self.assertIn(fragment, args[0])

    def _cogs(self):
        return {"TaskCog": self.cog, "WeeklyCog": object()}

    def test_a_user_who_is_not_a_member_is_refused_and_nothing_changes(self):
        user = mock.Mock(spec=discord.User)
        user.id = CLICKER
        before = self._state()
        itx = self._itx(user, self._channel(), self._cogs())
        with mock.patch.object(WC, "_retire_button", new=mock.AsyncMock()) as retire:
            asyncio.run(WC.assign_from_button(itx, self.number))
        self._assert_refused(itx, "メンバーだけ")
        retire.assert_not_awaited()
        self.assertEqual(self._state(), before)

    def test_a_channel_outside_the_task_permission_is_refused_and_nothing_changes(self):
        before = self._state()
        itx = self._itx(_member(CLICKER), self._channel(channel_id=OTHER_CHANNEL), self._cogs())
        asyncio.run(WC.assign_from_button(itx, self.number))
        self._assert_refused(itx, "この場所ではタスク機能を使えません")
        self.assertEqual(self._state(), before)

    def test_a_member_who_cannot_view_the_channel_is_refused_and_nothing_changes(self):
        before = self._state()
        itx = self._itx(_member(CLICKER), self._channel(user_can_view=False), self._cogs())
        asyncio.run(WC.assign_from_button(itx, self.number))
        self._assert_refused(itx, "閲覧する権限がありません")
        self.assertEqual(self._state(), before)

    def test_an_allowed_member_takes_the_task_and_the_original_post_is_updated(self):
        clicker = _member(CLICKER)
        itx = self._itx(clicker, self._channel(), self._cogs())
        with mock.patch.object(WC, "_retire_button", new=mock.AsyncMock()) as retire:
            asyncio.run(WC.assign_from_button(itx, self.number))
        self.assertEqual(self.store.get_task(Scope(GUILD, CHANNEL), self.number).task.assignee_id, CLICKER)
        self.assertIn("主担当を引き受けました", itx.followup.send.await_args.args[0])
        retire.assert_awaited_once_with(itx, self.number, CLICKER)

    def test_a_second_person_gets_a_private_answer_and_the_post_is_not_touched(self):
        asyncio.run(WC.assign_from_button(self._itx(_member(CLICKER), self._channel(), self._cogs()), self.number))
        before = self._state()
        other = self._itx(_member(OTHER), self._channel(), self._cogs())
        with mock.patch.object(WC, "_retire_button", new=mock.AsyncMock()) as retire:
            asyncio.run(WC.assign_from_button(other, self.number))
        self.assertIn("すでに主担当が決まっています", other.followup.send.await_args.args[0])
        retire.assert_not_awaited()
        self.assertEqual(self._state(), before)


class RetireButtonTests(unittest.TestCase):
    def test_only_the_assigned_button_goes_and_a_line_is_added(self):
        content, remaining = WC.retire_assign_message(
            "一覧\n・#3 資料\n・#4 会場", ["weekly:assign:3", "weekly:assign:4", None, "other:1"], 3, CLICKER)
        self.assertEqual(remaining, [4])
        self.assertTrue(content.startswith("一覧\n・#3 資料"))            # 本文は残す
        self.assertTrue(content.endswith(f"✅ #3 は <@{CLICKER}> が引き受けました。"))

    def test_a_message_at_the_size_limit_keeps_its_text_but_still_loses_the_button(self):
        text = "x" * 1990
        content, remaining = WC.retire_assign_message(text, ["weekly:assign:3", "weekly:assign:4"], 3, CLICKER)
        self.assertEqual(content, text)
        self.assertEqual(remaining, [4])

    def test_the_last_button_leaves_none(self):
        _content, remaining = WC.retire_assign_message("一覧", ["weekly:assign:3"], 3, CLICKER)
        self.assertEqual(remaining, [])


class RetireMessageTests(unittest.TestCase):
    def _itx(self, message):
        return SimpleNamespace(message=message, user=_user(CLICKER))

    def _message(self, custom_ids):
        return SimpleNamespace(content="一覧", edit=mock.AsyncMock(),
                               components=[SimpleNamespace(children=[SimpleNamespace(custom_id=c)
                                                                     for c in custom_ids])])

    def test_the_original_post_loses_the_button_and_says_who_took_it(self):
        message = self._message(["weekly:assign:3", "weekly:assign:4"])
        asyncio.run(WC._retire_button(self._itx(message), 3, CLICKER))
        message.edit.assert_awaited_once()
        kwargs = message.edit.await_args.kwargs
        self.assertIn(f"✅ #3 は <@{CLICKER}> が引き受けました。", kwargs["content"])
        self.assertEqual([button.number for button in kwargs["view"].children], [4])
        self.assertIs(kwargs["allowed_mentions"].users, False)     # 名指しで通知を鳴らさない

    def test_a_failed_edit_does_not_undo_the_assignment(self):
        message = self._message(["weekly:assign:3"])
        message.edit.side_effect = discord.HTTPException(SimpleNamespace(status=500, reason="x"), "x")
        asyncio.run(WC._retire_button(self._itx(message), 3, CLICKER))   # 例外を外に出さない
        message.edit.assert_awaited_once()

    def test_a_missing_message_is_a_no_op(self):
        asyncio.run(WC._retire_button(self._itx(None), 3, CLICKER))


if __name__ == "__main__":
    unittest.main()
