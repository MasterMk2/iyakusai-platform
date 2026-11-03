# -*- coding: utf-8 -*-
"""入口の権限確認(access_check)の試験: 拒否の返事・監査の書き方・Discord の check の形・命令本体の完了と失敗。

discord.py が無い環境では全体を飛ばす（合成の Member・Interaction だけを使う）。
どの試験も、設定と監査の先を addCleanup で既定に戻す（access_check は 1 プロセスの大域状態のため）。
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

HAVE_DISCORD = importlib.util.find_spec("discord") is not None   # discord.py 未導入の環境では全体を飛ばす
if HAVE_DISCORD:
    from iyakusai_bot import access as A  # noqa: E402
    from iyakusai_bot import access_check as AC  # noqa: E402
    from iyakusai_bot import help as HELP  # noqa: E402
    from iyakusai_bot import persona as PERSONA  # noqa: E402
    from iyakusai_bot import persona_cmd as PERSONA_CMD  # noqa: E402
    from iyakusai_bot import reminders as REMINDERS  # noqa: E402
    from iyakusai_bot import screening_cog as SCREENING  # noqa: E402
    from iyakusai_bot import storage as STORAGE  # noqa: E402
    from iyakusai_bot import documents as DOCUMENTS  # noqa: E402
    from iyakusai_bot import task_cog as TASK  # noqa: E402
    from iyakusai_bot import bot as BOT  # noqa: E402
    from iyakusai_bot.audit import AuditLog  # noqa: E402
    from iyakusai_bot.task_domain import TaskError  # noqa: E402

JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 11, 3, 10, 0, tzinfo=JST)


def role(name, default=False):
    return SimpleNamespace(name=name, is_default=lambda: default)


def member(user_id, *role_names):
    roles = [role("@everyone", default=True)] + [role(n) for n in role_names]
    return SimpleNamespace(id=user_id, roles=roles)


def interaction(user, guild_id=900000000000000010, channel_id=900000000000000020):
    return SimpleNamespace(user=user, guild_id=guild_id, channel_id=channel_id)


class FakeResponse:
    """discord.py の InteractionResponse の代わり。送った内容を残す。"""

    def __init__(self):
        self.sent = []
        self._done = False

    async def send_message(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        self._done = True

    async def defer(self, **kwargs):
        self._done = True

    def is_done(self):
        return self._done


def fake_itx(user, *, guild_id=900000000000000010, channel_id=900000000000000020, command_name="doc"):
    return SimpleNamespace(user=user, guild_id=guild_id, channel_id=channel_id, response=FakeResponse(),
                           command=SimpleNamespace(name=command_name), data={})


class AuditedCase(unittest.TestCase):
    """監査の先を一時フォルダにし、後始末で既定に戻す。"""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.audit = AuditLog(self.dir / "audit", clock=lambda: NOW)
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(AC.configure, A.AccessSettings(), None)

    def configure(self, roles=None, admin=("役員",)):
        settings = A.AccessSettings.from_mapping({"roles": roles or {}}, admin_roles=admin)
        AC.configure(settings, self.audit)

    def rows(self):
        path = self.dir / "audit" / "audit.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def pairs(self):
        return [(r["cmd"], r["result"], r["code"]) for r in self.rows()]


@unittest.skipUnless(HAVE_DISCORD, "discord.py が無いため入口の試験を飛ばす")
class EnforceTests(AuditedCase):
    def test_default_settings_allow_and_write_an_accepted_row_for_writes_only(self):
        AC.configure(A.AccessSettings(), self.audit)
        user = member(900000000000000001, "委員")
        AC.enforce("ask", actor_id=user.id, role_names=AC.role_names_of(user))
        AC.enforce("todo.create", actor_id=user.id, role_names=AC.role_names_of(user))
        self.assertEqual([(r["cmd"], r["result"]) for r in self.rows()], [("todo.create", "accepted")])

    def test_denied_write_raises_access_denied_with_a_polite_japanese_message(self):
        self.configure({"write": ["タスク係"]})
        user = member(900000000000000001, "委員")
        with self.assertRaises(AC.AccessDenied) as ctx:
            AC.enforce("todo.create", actor_id=user.id, role_names=AC.role_names_of(user), guild_id=1, channel_id=2)
        message = str(ctx.exception)
        self.assertIn("書く", message)
        self.assertIn("許可されていません", message)
        self.assertIn("役員に確かめてください", message)
        # 拒否の文面に、表のロール名や他の人の情報は出さない
        self.assertNotIn("タスク係", message)
        self.assertNotIn("900000000000000001", message)
        self.assertEqual([(r["cmd"], r["result"], r["kind"]) for r in self.rows()],
                         [("todo.create", "denied", "write")])

    def test_send_kind_is_described_as_publishing_and_drafting_not_as_leaving_the_room(self):
        # /doc・/mail は草案を依頼者に返すだけ。種類の名前は「投稿・配布・起草」（外へ送る、とは書かない）
        self.configure({"send": ["広報係"]})
        user = member(900000000000000003, "委員")
        with self.assertRaises(AC.AccessDenied) as ctx:
            AC.enforce("doc", actor_id=user.id, role_names=AC.role_names_of(user))
        self.assertIn("投稿・配布・起草", str(ctx.exception))
        self.assertNotIn("外へ送る", str(ctx.exception))

    def test_denied_read_is_audited_but_allowed_read_is_not(self):
        self.configure({"read": ["役員"]})
        user = member(900000000000000001, "委員")
        with self.assertRaises(AC.AccessDenied):
            AC.enforce("ask", actor_id=user.id, role_names=AC.role_names_of(user))
        AC.enforce("ask", actor_id=900000000000000002, role_names=["役員"])   # 役員は通る（受付は残さない）
        self.assertEqual([(r["cmd"], r["result"]) for r in self.rows()], [("ask", "denied")])

    def test_record_accepted_false_writes_no_accepted_row_but_keeps_the_denial(self):
        # 差し戻しのように入口が 2 つある操作では、片方だけ受付を残す
        AC.configure(A.AccessSettings(), self.audit)
        AC.enforce("screening.return", actor_id=900000000000000001, role_names=[], record_accepted=False)
        self.assertEqual(self.rows(), [])
        self.configure({"write": ["タスク係"]})
        with self.assertRaises(AC.AccessDenied):
            AC.enforce("screening.return", actor_id=900000000000000001, role_names=[], record_accepted=False)
        self.assertEqual(self.pairs(), [("screening.return", "denied", None)])

    def test_outcome_rows_carry_only_result_and_code(self):
        AC.configure(A.AccessSettings(), self.audit)
        AC.log_outcome("assistant.remind", actor_id=900000000000000001, result="failed", code="UNAVAILABLE",
                       guild_id=1, channel_id=2)
        rows = self.rows()
        self.assertEqual(rows[0]["cmd"], "assistant.remind")
        self.assertEqual(rows[0]["result"], "failed")
        self.assertEqual(rows[0]["code"], "UNAVAILABLE")
        self.assertEqual(set(rows[0]), {"ts", "cmd", "kind", "actor", "guild", "channel", "result", "code", "ref"})

    def test_audit_failure_does_not_block_the_command(self):
        blocker = self.dir / "file-not-dir"
        blocker.write_text("x", encoding="utf-8")
        AC.configure(A.AccessSettings(), AuditLog(blocker, clock=lambda: NOW))
        user = member(900000000000000001)
        self.assertTrue(AC.enforce("todo.create", actor_id=user.id, role_names=[]).allowed)

    def test_needs_roles_is_true_for_commands_missing_from_the_table(self):
        # 表に無い命令は admin_roles の判定に会員の情報が要る。既定の設定でも同じ
        AC.configure(A.AccessSettings(), None)
        self.assertTrue(AC.needs_roles("no.such.command"))
        self.assertFalse(AC.needs_roles("doc"))


@unittest.skipUnless(HAVE_DISCORD, "discord.py が無いため入口の試験を飛ばす")
class AuditedTests(AuditedCase):
    """命令の本体を囲む audited() の完了・失敗の書き方。"""

    def setUp(self):
        super().setUp()
        AC.configure(A.AccessSettings(), self.audit)
        self.itx = fake_itx(member(900000000000000001))

    def test_a_block_that_finishes_is_recorded_as_ok(self):
        with AC.audited("doc", self.itx):
            pass
        self.assertEqual(self.pairs(), [("doc", "ok", None)])

    def test_a_branch_that_marks_failure_is_recorded_with_its_code(self):
        with AC.audited("remind.done", self.itx) as out:
            out.fail("NOT_FOUND")
        self.assertEqual(self.pairs(), [("remind.done", "failed", "NOT_FOUND")])

    def test_return_after_a_failure_mark_is_recorded_as_failed(self):
        # 早い return でも、抜けるときに記録される（ok のまま残らない）
        def command(itx):
            with AC.audited("persona.off", itx) as out:
                out.fail("FORBIDDEN")
                return "stopped"

        self.assertEqual(command(self.itx), "stopped")
        self.assertEqual(self.pairs(), [("persona.off", "failed", "FORBIDDEN")])

    def test_an_exception_is_recorded_as_internal_and_raised_again(self):
        with self.assertRaises(RuntimeError):
            with AC.audited("doc", self.itx):
                raise RuntimeError("boom")
        self.assertEqual(self.pairs(), [("doc", "failed", "INTERNAL")])

    def test_cancellation_is_recorded_as_cancelled(self):
        with self.assertRaises(asyncio.CancelledError):
            with AC.audited("neta_video", self.itx):
                raise asyncio.CancelledError()
        self.assertEqual(self.pairs(), [("neta_video", "failed", "CANCELLED")])

    def test_an_invalid_code_falls_back_to_FAILED(self):
        with AC.audited("doc", self.itx) as out:
            out.fail("not a code")
        self.assertEqual(self.pairs(), [("doc", "failed", "FAILED")])


@unittest.skipUnless(HAVE_DISCORD, "discord.py が無いため入口の試験を飛ばす")
class SlashCheckTests(AuditedCase):
    def setUp(self):
        super().setUp()
        self.configure({"send": ["広報係"]})

    def test_predicate_passes_for_listed_role_and_raises_for_others(self):
        predicate = AC.predicate_for("doc")
        self.assertTrue(predicate(interaction(member(900000000000000001, "広報係"))))
        self.assertTrue(predicate(interaction(member(900000000000000002, "役員"))))
        with self.assertRaises(AC.AccessDenied):
            predicate(interaction(member(900000000000000003, "委員")))

    def test_dm_users_without_roles_are_refused_only_for_restricted_kinds(self):
        dm_user = SimpleNamespace(id=900000000000000004)   # roles が無い（DM）
        with self.assertRaises(AC.AccessDenied):
            AC.predicate_for("doc")(interaction(dm_user, guild_id=None))
        self.assertTrue(AC.predicate_for("ask")(interaction(dm_user, guild_id=None)))

    def test_require_attaches_exactly_one_check_to_the_function(self):
        def fake_command():
            return None

        decorated = AC.require("doc")(fake_command)
        self.assertIs(decorated, fake_command)     # 関数はそのまま返り、check が 1 つ付くだけ
        self.assertEqual(len(fake_command.__discord_app_commands_checks__), 1)

    def test_role_names_skip_the_everyone_role(self):
        names = AC.role_names_of(member(900000000000000005, "委員", "役員"))
        self.assertEqual(names, ["委員", "役員"])

    def test_enforce_for_tolerates_a_bare_interaction_without_user_or_guild(self):
        # 属性が無い相手でも落ちない。既定の設定は許可、表で絞った種類は拒否（閉じる側）
        bare = SimpleNamespace()
        AC.configure(A.AccessSettings(), self.audit)
        self.assertTrue(AC.enforce_for("ask", bare).allowed)
        self.configure({"read": []})
        with self.assertRaises(AC.AccessDenied):
            AC.enforce_for("ask", bare)

    def test_roles_are_looked_up_only_for_restricted_kinds(self):
        # 既定では会員の問い合わせ（Discord の呼び出し）を増やさない
        AC.configure(A.AccessSettings(), self.audit)
        self.assertFalse(AC.needs_roles("doc"))
        self.configure({"send": ["広報係"], "read": ["*"]})
        self.assertTrue(AC.needs_roles("doc"))
        self.assertFalse(AC.needs_roles("ask"))    # "*" は全員と同じなので問い合わせない


@unittest.skipUnless(HAVE_DISCORD, "discord.py が無いため入口の試験を飛ばす")
class RequireWiringTests(unittest.TestCase):
    """拒否の確かめが、実際のコマンドに付いていること（付け忘れを見つける）。"""

    WIRED = (
        ("documents", "Documents", "doc"),
        ("documents", "Documents", "mail"),
        ("images", "Images", "image"),
        ("neta_video", "NetaVideo", "neta_video"),
        ("neta_video", "NetaVideo", "cancel_video"),
        ("reminders", "Reminders", "add"),
        ("reminders", "Reminders", "done"),
        ("reminders", "Reminders", "delete"),
        ("persona_cmd", "Persona", "set_"),
        ("persona_cmd", "Persona", "off"),
        ("haiku", "Haiku", "optout"),
        ("haiku", "Haiku", "optin"),
        ("roles", "RoleStatus", "roles"),
    )

    def test_each_restricted_write_or_send_command_carries_its_check(self):
        for module_name, class_name, attribute in self.WIRED:
            with self.subTest(command=f"{class_name}.{attribute}"):
                module = importlib.import_module(f"iyakusai_bot.{module_name}")
                command = getattr(getattr(module, class_name), attribute)
                self.assertEqual(len(command.checks), 1)


@unittest.skipUnless(HAVE_DISCORD, "discord.py が無いため入口の試験を飛ばす")
class CommandBodyAuditTests(AuditedCase):
    """拒否・失敗の分岐が、監査の失敗の行を残すこと（命令の本体を直接呼ぶ）。

    本番では check（enforce_for）が先に受付の行を残す。試験でも同じ順で呼ぶ。
    """

    def setUp(self):
        super().setUp()
        AC.configure(A.AccessSettings(), self.audit)

    def test_persona_set_by_a_non_admin_is_failed_with_forbidden_and_says_so_privately(self):
        itx = fake_itx(member(900000000000000001, "委員"), command_name="persona")
        AC.enforce_for("persona.set", itx)
        obj = SimpleNamespace(store=PERSONA.PersonaStore(self.dir / "data"))
        asyncio.run(PERSONA_CMD.Persona.set_.callback(obj, itx, None, "にゃ"))
        self.assertEqual(self.pairs(), [("persona.set", "accepted", None), ("persona.set", "failed", "FORBIDDEN")])
        self.assertIn("役員のみ", itx.response.sent[-1][0])

    def test_persona_off_by_a_non_admin_is_failed_with_forbidden(self):
        itx = fake_itx(member(900000000000000001, "委員"), command_name="persona")
        AC.enforce_for("persona.off", itx)
        obj = SimpleNamespace(store=PERSONA.PersonaStore(self.dir / "data"))
        asyncio.run(PERSONA_CMD.Persona.off.callback(obj, itx))
        self.assertEqual(self.pairs(), [("persona.off", "accepted", None), ("persona.off", "failed", "FORBIDDEN")])

    def test_doc_without_an_ai_provider_is_failed_with_unavailable(self):
        itx = fake_itx(member(900000000000000001, "委員"))
        AC.enforce_for("doc", itx)
        docs = DOCUMENTS.Documents(None, None, None)
        category = DOCUMENTS.DOC_TYPES[0]
        asyncio.run(DOCUMENTS.Documents.doc.callback(docs, itx, category, "内容", None, False, None))
        self.assertEqual(self.pairs(), [("doc", "accepted", None), ("doc", "failed", "UNAVAILABLE")])

    def test_remind_done_for_an_unknown_id_is_failed_with_not_found(self):
        itx = fake_itx(member(900000000000000001, "委員"), command_name="remind")
        AC.enforce_for("remind.done", itx)
        obj = SimpleNamespace(store=STORAGE.ReminderStore(self.dir / "data"))
        asyncio.run(REMINDERS.Reminders.done.callback(obj, itx, 999))
        self.assertEqual(self.pairs(), [("remind.done", "accepted", None), ("remind.done", "failed", "NOT_FOUND")])

    def test_remind_add_with_an_unreadable_due_is_failed_with_validation(self):
        itx = fake_itx(member(900000000000000001, "委員"), command_name="remind")
        AC.enforce_for("remind.add", itx)
        obj = SimpleNamespace(store=STORAGE.ReminderStore(self.dir / "data"))
        asyncio.run(REMINDERS.Reminders.add.callback(obj, itx, "不正な期限", "内容", None, None))
        self.assertEqual(self.pairs(), [("remind.add", "accepted", None), ("remind.add", "failed", "VALIDATION")])

    def test_todo_run_refused_by_the_table_answers_privately_and_records_only_the_denial(self):
        AC.configure(A.AccessSettings.from_mapping({"roles": {"write": ["タスク係"]}}, admin_roles=("役員",)),
                     self.audit)
        cog = TASK.TaskCog(None, None, object())   # 保存先は開かない（権限の確かめより前に止まる）
        cog.authorize = lambda itx, *, edit: None
        itx = fake_itx(member(900000000000000001, "委員"), command_name="todo")
        asyncio.run(cog._run(itx, edit=True, work=None, name="create"))
        sent, kwargs = itx.response.sent[-1]
        self.assertIn("役員に確かめてください", sent)
        self.assertTrue(kwargs.get("ephemeral"))
        self.assertEqual(self.pairs(), [("todo.create", "denied", None)])

    def test_screening_return_button_writes_no_accepted_row_when_only_opening_the_form(self):
        # 差し戻しの入力欄を開く押下では受付を残さない（送信のときに残す）
        itx = fake_itx(member(900000000000000001, "委員"), command_name="screening")
        SCREENING._enforce(itx, "screening.return", record_accepted=False)
        self.assertEqual(self.rows(), [])

    def test_screening_button_denial_is_a_task_error_for_the_user(self):
        AC.configure(A.AccessSettings.from_mapping({"roles": {"write": ["タスク係"]}}, admin_roles=("役員",)),
                     self.audit)
        itx = fake_itx(member(900000000000000001, "委員"), command_name="screening")
        with self.assertRaises(TaskError) as ctx:
            SCREENING._enforce(itx, "screening.ok")
        self.assertEqual(ctx.exception.code, "FORBIDDEN")
        self.assertEqual(self.pairs(), [("screening.ok", "denied", None)])


@unittest.skipUnless(HAVE_DISCORD, "discord.py が無いため入口の試験を飛ばす")
class ReplyAndHelpTests(AuditedCase):
    def test_the_error_reply_for_a_denial_is_private_and_names_no_role(self):
        AC.configure(A.AccessSettings.from_mapping({"roles": {"send": ["広報係"]}}, admin_roles=("役員",)),
                     self.audit)
        itx = fake_itx(member(900000000000000001, "委員"))
        error = AC.AccessDenied("send")
        asyncio.run(BOT.IyakusaiBot._on_app_command_error(None, itx, error))
        sent, kwargs = itx.response.sent[-1]
        self.assertIn("役員に確かめてください", sent)
        self.assertNotIn("広報係", sent)
        self.assertTrue(kwargs.get("ephemeral"))

    def test_help_mentions_restricted_operations_only_when_a_table_restricts_them(self):
        AC.configure(A.AccessSettings(), None)
        plain = HELP.build_help_embed(True).to_dict()
        self.assertFalse(any("役割により" in f["name"] for f in plain["fields"]))
        AC.configure(A.AccessSettings.from_mapping({"roles": {"send": ["広報係"], "read": ["*"]}},
                                                   admin_roles=("役員",)), None)
        restricted = HELP.build_help_embed(True).to_dict()
        fields = {f["name"]: f["value"] for f in restricted["fields"]}
        note = next(v for n, v in fields.items() if "役割により" in n)
        self.assertIn("投稿・配布・起草", note)
        self.assertNotIn("広報係", note)   # 役割の名前は /help にも出さない
        self.assertNotIn("読む", note)     # 「*」だけの種類は全員なので数えない


if __name__ == "__main__":
    unittest.main()
