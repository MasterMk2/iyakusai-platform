# -*- coding: utf-8 -*-
"""操作の種類と権限の表(access)・監査ログ(audit)・ファイル名と書き込み先のガード(write_guard)の試験。

Discord に依存しない。合成の名前・ID だけを使う（実在の人・サーバーの値は入れない）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import access as A  # noqa: E402
from iyakusai_bot import audit as AU  # noqa: E402
from iyakusai_bot import config as CF  # noqa: E402
from iyakusai_bot import write_guard as W  # noqa: E402

JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 11, 3, 10, 0, tzinfo=JST)
ADMIN = ("役員",)


def settings(roles=None, admin=ADMIN, **kw):
    """テスト用の設定。roles は {kind: [ロール名...]}。"""
    return A.AccessSettings(roles={k: tuple(v) for k, v in (roles or {}).items()},
                            admin_roles=tuple(admin), **kw)


class PolicyDefaultTests(unittest.TestCase):
    def test_without_settings_every_command_is_open_to_everyone(self):
        # 設定が無い既定は今と同じ動き（誰でも使える）
        base = A.AccessSettings()
        for command in A.COMMAND_KINDS:
            self.assertTrue(A.decide(base, command, []).allowed, command)
            self.assertEqual(A.decide(base, command, []).matched, "everyone")

    def test_every_command_maps_to_a_known_kind(self):
        self.assertTrue(A.COMMAND_KINDS)
        for command, kind in A.COMMAND_KINDS.items():
            self.assertIn(kind, A.KINDS, command)
        for kind in A.WEB_JOB_KEYS.values():
            self.assertIn(kind, A.COMMAND_KINDS)

    def test_unknown_command_is_treated_as_the_strictest_kind(self):
        self.assertEqual(A.kind_of("no.such.command"), A.DEFAULT_KIND)
        restricted = settings({"admin": []})
        self.assertFalse(A.decide(restricted, "no.such.command", ["委員"]).allowed)
        # 表に無い命令は、既定の設定でも閉じる（全員には開かない）。通るのは admin_roles の人だけ
        self.assertFalse(A.decide(A.AccessSettings(), "no.such.command", []).allowed)
        self.assertFalse(A.decide(A.AccessSettings(), "no.such.command", ["委員"]).allowed)
        self.assertTrue(A.decide(A.AccessSettings(admin_roles=ADMIN), "no.such.command", ["役員"]).allowed)

    def test_unknown_command_stays_closed_even_when_the_table_has_no_admin_row(self):
        # 綴りの誤りや後から足した命令が、表に admin の行が無いせいで全員に開くのを防ぐ
        s = A.AccessSettings.from_mapping({"roles": {"send": ["広報係"]}}, admin_roles=ADMIN)
        self.assertFalse(A.decide(s, "future.cmd", ["広報係"]).allowed)
        self.assertTrue(A.decide(s, "future.cmd", ["役員"]).allowed)
        self.assertEqual(A.decide(s, "future.cmd", ["役員"]).matched, "admin")


class PolicyRestrictedTests(unittest.TestCase):
    def test_listed_role_is_allowed_and_others_are_denied(self):
        s = settings({"write": ["タスク係"]})
        self.assertTrue(A.decide(s, "todo.create", ["タスク係"]).allowed)
        denied = A.decide(s, "todo.create", ["委員"])
        self.assertFalse(denied.allowed)
        self.assertEqual(denied.matched, "denied")
        self.assertEqual(denied.kind, "write")

    def test_admin_roles_pass_every_restricted_kind(self):
        s = settings({"write": [], "send": [], "read": []})
        for kind_command in ("todo.create", "doc", "ask"):
            self.assertTrue(A.decide(s, kind_command, ["役員"]).allowed, kind_command)
            self.assertEqual(A.decide(s, kind_command, ["役員"]).matched, "admin")

    def test_empty_list_means_admins_only(self):
        s = settings({"send": []})
        self.assertFalse(A.decide(s, "doc", ["委員"]).allowed)
        self.assertFalse(A.decide(s, "doc", []).allowed)
        self.assertTrue(A.decide(s, "doc", ["役員"]).allowed)

    def test_star_means_everyone(self):
        s = settings({"read": ["*"]})
        self.assertTrue(A.decide(s, "ask", []).allowed)

    def test_kinds_not_in_the_table_stay_open(self):
        s = settings({"admin": ["役員"]})
        self.assertTrue(A.decide(s, "ask", ["委員"]).allowed)        # read は表に無い → 全員
        self.assertTrue(A.decide(s, "todo.create", ["委員"]).allowed)  # write も表に無い → 全員
        self.assertFalse(A.decide(s, "haiku.scan", ["委員"]).allowed)  # admin は絞った

    def test_unknown_role_name_matches_nothing(self):
        # 綴りの誤り（サーバーに無い名前）は黙って全員にしない。一致しないので拒否になる
        typo = A.AccessSettings.from_mapping({"roles": {"write": ["タスク掛"]}}, admin_roles=ADMIN)
        self.assertFalse(A.decide(typo, "todo.create", ["タスク係"]).allowed)
        self.assertFalse(A.decide(typo, "todo.create", []).allowed)
        self.assertTrue(A.decide(typo, "todo.create", ["役員"]).allowed)   # 役員は通る

    def test_missing_roles_lists_names_the_guild_does_not_have(self):
        s = settings({"write": ["タスク係", "*"]}, admin=("役員", "システム課"))
        self.assertEqual(A.missing_roles(s, ["役員", "タスク係"]), ["システム課"])
        self.assertEqual(A.missing_roles(s, ["役員", "システム課", "タスク係"]), [])


class SettingsParsingTests(unittest.TestCase):
    def test_absent_section_gives_open_defaults_with_audit_off_when_no_dir(self):
        s = A.AccessSettings.from_mapping(None, admin_roles=ADMIN)
        self.assertEqual(s.roles, {})
        self.assertEqual(s.admin_roles, ADMIN)
        self.assertIsNone(s.audit_dir)

    def test_valid_table_is_parsed_and_strips_and_dedupes(self):
        raw = {"roles": {"write": [" タスク係 ", "タスク係", "委員長"]}, "audit": True}
        s = A.AccessSettings.from_mapping(raw, admin_roles=ADMIN, default_audit_dir=Path("/x/audit"))
        self.assertEqual(s.required("write"), ("タスク係", "委員長"))
        self.assertEqual(s.audit_dir, Path("/x/audit"))

    def test_typos_are_rejected_not_silently_opened(self):
        bad_inputs = [
            {"roles": {"wirte": ["役員"]}},          # 操作の種類の綴り
            {"roles": {"write": "役員"}},            # 配列ではない
            {"roles": {"write": [""]}},              # 空の名前
            {"rols": {}},                            # 未知の項目
            {"audit": "yes"},                        # 真偽値ではない
            {"audit_dir": "relative/audit"},         # 絶対パスではない
        ]
        for raw in bad_inputs:
            with self.subTest(raw=raw), self.assertRaises(A.AccessConfigError):
                A.AccessSettings.from_mapping(raw, admin_roles=ADMIN)

    def test_audit_dir_must_not_overlap_shared_roots(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            shared = tmp / "shared-data"
            with self.assertRaises(A.AccessConfigError):
                A.AccessSettings.from_mapping({"audit_dir": str(shared / "audit")}, admin_roles=ADMIN,
                                              shared_roots=[shared])
            with self.assertRaises(A.AccessConfigError):
                A.AccessSettings.from_mapping({"audit_dir": str(tmp)}, admin_roles=ADMIN,
                                              shared_roots=[shared])
            ok = A.AccessSettings.from_mapping({"audit_dir": str(tmp / "local-audit")}, admin_roles=ADMIN,
                                               shared_roots=[shared])
            self.assertEqual(ok.audit_dir, (tmp / "local-audit"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_admin_roles_must_be_a_list_of_names(self):
        # 文字列で書くと一文字ずつに割れて、管理者の例外が効かなくなる。起動を止める
        for bad in ("役員", ["役員", 3], [" "], ("役", "員", 1)):
            with self.subTest(admin_roles=bad), self.assertRaises(A.AccessConfigError):
                A.AccessSettings.from_mapping(None, admin_roles=bad)
        self.assertEqual(A.AccessSettings.from_mapping(None, admin_roles=[]).admin_roles, ())
        self.assertEqual(A.AccessSettings.from_mapping(None, admin_roles=["役員"]).admin_roles, ("役員",))

    def test_audit_off_clears_the_directory(self):
        s = A.AccessSettings.from_mapping({"audit": False}, admin_roles=ADMIN, default_audit_dir=Path("/x"))
        self.assertIsNone(s.audit_dir)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.log = AU.AuditLog(self.dir / "audit", clock=lambda: NOW)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def read_lines(self):
        return [json.loads(line) for line in self.log.path.read_text(encoding="utf-8").splitlines()]

    def test_writes_one_json_line_with_only_the_whitelisted_columns(self):
        rec = self.log.record(cmd="todo.create", kind="write", actor=900000000000000001, result="accepted",
                              guild=900000000000000002, channel=900000000000000003, ref=12)
        self.assertIsNotNone(rec)
        lines = self.read_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(set(lines[0]), {"ts", "cmd", "kind", "actor", "guild", "channel", "result", "code", "ref"})
        self.assertEqual(lines[0]["ts"], "2026-11-03T10:00:00+09:00")
        self.assertEqual(lines[0]["result"], "accepted")
        self.assertEqual(lines[0]["ref"], 12)

    def test_free_text_cannot_enter_the_log(self):
        # 本文・表示名・メールアドレス・ファイル名は、どの列にも入らない（規則に合わないので書かない）
        leak_attempts = [
            dict(cmd="依頼文の本文を書いた名前", kind="write", actor=1, result="ok"),
            dict(cmd="todo.create", kind="write", actor="表示名", result="ok"),
            dict(cmd="todo.create", kind="write", actor=1, result="ok", code="address(sample)"),
            dict(cmd="todo.create", kind="write", actor=1, result="ok", ref="タスク本文"),
            dict(cmd="todo.create", kind="write", actor=1, result="done"),
            dict(cmd="todo.create", kind="nonsense", actor=1, result="ok"),
        ]
        for attempt in leak_attempts:
            with self.subTest(attempt=attempt):
                self.assertIsNone(self.log.record(**attempt))
        self.assertFalse(self.log.path.exists())

    def test_record_has_no_room_for_names_or_bodies(self):
        rec = AU.build_record(cmd="doc", kind="send", actor=5, result="accepted", guild=None, channel=None,
                              code=None, ref=None, now=NOW)
        self.assertEqual(sorted(rec), sorted(["ts", "cmd", "kind", "actor", "guild", "channel", "result", "code", "ref"]))
        self.assertTrue(all(isinstance(v, (str, int, type(None))) for v in rec.values()))

    def test_rotation_keeps_only_the_configured_generations(self):
        log = AU.AuditLog(self.dir / "rot", max_bytes=1024, generations=2, clock=lambda: NOW)
        for index in range(200):
            log.record(cmd="ask", kind="read", actor=1 + index, result="denied")
        names = sorted(p.name for p in (self.dir / "rot").iterdir())
        self.assertEqual(names, ["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"])

    def test_write_failure_is_reported_as_none_and_never_raises(self):
        blocker = self.dir / "not-a-dir"
        blocker.write_text("x", encoding="utf-8")
        log = AU.AuditLog(blocker, clock=lambda: NOW)     # ディレクトリにできない場所
        self.assertIsNone(log.record(cmd="ask", kind="read", actor=1, result="denied"))

    def test_no_directory_means_no_log(self):
        self.assertIsNone(AU.AuditLog(None).record(cmd="ask", kind="read", actor=1, result="denied"))


class WriteGuardTests(unittest.TestCase):
    def test_ai_prefix_is_added_once_and_separators_are_removed(self):
        self.assertEqual(W.ai_name("依頼文_20261103.docx"), "【AI】依頼文_20261103.docx")
        self.assertEqual(W.ai_name("【AI】依頼文.txt"), "【AI】依頼文.txt")
        self.assertEqual(W.ai_name("../../escape.md"), "【AI】escape.md")
        self.assertEqual(W.ai_name("..\\..\\x.md"), "【AI】x.md")
        self.assertEqual(W.ai_name(""), "【AI】出力")
        self.assertEqual(W.ai_name("..."), "【AI】出力")

    def test_control_and_reserved_characters_become_underscores(self):
        self.assertEqual(W.ai_name('a<b>:"c|?*.md'), "【AI】a_b___c___.md")

    def test_long_names_keep_the_extension(self):
        name = W.ai_name("あ" * 300 + ".docx")
        self.assertLessEqual(len(name), W.MAX_NAME)
        self.assertTrue(name.endswith(".docx"))
        self.assertTrue(name.startswith(W.AI_PREFIX))

    def test_targets_must_stay_inside_the_root(self):
        root = Path(tempfile.mkdtemp())
        try:
            inside = W.target_in(root, "報告.docx")
            self.assertEqual(inside.name, "【AI】報告.docx")
            self.assertTrue(inside.is_relative_to(root.resolve()))
            self.assertEqual(W.target_in(root, "../../x.txt").parent, root.resolve())
            with self.assertRaises(W.WriteDenied):
                W.contained(root, root / ".." / "outside.txt")
            with self.assertRaises(W.WriteDenied):
                W.contained(root, root)     # 置き場そのものへは書けない
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_symlink_out_of_the_root_is_refused_when_the_platform_allows_it(self):
        root = Path(tempfile.mkdtemp())
        outside = Path(tempfile.mkdtemp())
        try:
            link = root / "link"
            try:
                os.symlink(outside, link, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("シンボリックリンクを作れない環境")
            with self.assertRaises(W.WriteDenied):
                W.contained(root, link / "x.txt")
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(outside, ignore_errors=True)


class ConfigPermissionsTests(unittest.TestCase):
    """config の [permissions] の読み方（起動を止める誤りと、省略時の既定）。"""

    def test_omitted_section_uses_the_default_admin_roles_and_an_open_table(self):
        s = CF._access_settings({}, roots=())
        self.assertEqual(s.roles, {})
        self.assertEqual(s.admin_roles, ("役員", "システム課"))

    def test_string_admin_roles_stop_the_start_instead_of_splitting_characters(self):
        with self.assertRaises(SystemExit):
            CF._access_settings({"permissions": {"admin_roles": "役員"}}, roots=())

    def test_a_non_table_permissions_section_stops_the_start(self):
        with self.assertRaises(SystemExit):
            CF._access_settings({"permissions": "役員"}, roots=())


class CodeFormTests(unittest.TestCase):
    def test_codes_are_upper_snake_symbols_only(self):
        self.assertTrue(AU.is_code("NOT_FOUND"))
        self.assertTrue(AU.is_code("VIDEO_TEXT_LENGTH"))
        self.assertFalse(AU.is_code("not found"))
        self.assertFalse(AU.is_code("address(sample)"))
        self.assertFalse(AU.is_code("_LEADING"))
        self.assertFalse(AU.is_code(""))


class SourceNameTests(unittest.TestCase):
    """権限の名前（require・enforce_for・audited・_run の name・候補のボタン）が、表と食い違わないこと。

    綴りを誤ると、その命令は表に無い命令として閉じる（admin_roles の人だけになる）。
    逆に、表に書いたのに使われない名前は、保守で迷うので見つける。
    """

    PKG = SRC / "iyakusai_bot"
    DEFINITION_FILES = {"access.py", "access_check.py", "audit.py"}   # 名前の定義そのものは数えない
    PATTERNS = (
        r'access_check\.require\("([^"]+)"\)',
        r'enforce_for\("([^"]+)"',
        r'audited\("([^"]+)"',
        r'outcome_for\("([^"]+)"',
        r'log_outcome\("([^"]+)"',
        r'"(screening\.\w+)"',   # 候補のボタン（screening_cog._SCREENING_KEYS）
    )

    def referenced_names(self) -> set[str]:
        names: set[str] = set()
        for path in self.PKG.glob("*.py"):
            if path.name in self.DEFINITION_FILES:
                continue
            text = path.read_text(encoding="utf-8")
            for pattern in self.PATTERNS:
                names.update(re.findall(pattern, text))
            if path.name in ("task_cog.py", "weekly_cog.py"):   # /todo（と週1回の引き受け）は name= の値が命令名（todo.<name>）になる
                names.update("todo." + n for n in re.findall(r'_run\(itx, edit=\w+, work=work, name="(\w+)"\)', text))
        names.update(A.WEB_JOB_KEYS.values())   # 統合アプリの依頼は、この対応表で命令名になる
        return names

    def test_every_name_used_in_the_source_is_in_the_table(self):
        self.assertEqual(sorted(self.referenced_names() - set(A.COMMAND_KINDS)), [])

    def test_every_name_in_the_table_is_used_somewhere(self):
        self.assertEqual(sorted(set(A.COMMAND_KINDS) - self.referenced_names()), [])


class EveryCommandIsCheckedTests(unittest.TestCase):
    """登録するスラッシュコマンドすべてに、権限の判定が付いていること（付け忘れは表でも監査でも見えないため）。

    判定の付き方は 2 通り: デコレーターの access_check.require(...)、または /todo の _run(...)（中で enforce_for）。
    使い方を出すだけの /help と /todo help は対象外（何も読まず、何も書かない）。
    """

    PKG = SRC / "iyakusai_bot"
    EXEMPT = {("help.py", "help"), ("task_cog.py", "help")}
    COMMAND = re.compile(r'^(\s*)@(?:app_commands|\w+)\.command\(name="([^"]+)"')

    def commands(self) -> list[tuple[str, str, str, str]]:
        """(ファイル名, コマンド名, デコレーターの並び, 関数の本体) の一覧。"""
        found = []
        for path in sorted(self.PKG.glob("*.py")):
            lines = path.read_text(encoding="utf-8").splitlines()
            for i, line in enumerate(lines):
                m = self.COMMAND.match(line)
                if not m:
                    continue
                depth = len(m.group(1))
                j = i + 1
                while j < len(lines) and not lines[j].lstrip().startswith(("async def ", "def ")):
                    j += 1
                k = j + 1
                while k < len(lines) and (not lines[k].strip() or len(lines[k]) - len(lines[k].lstrip()) > depth):
                    k += 1
                found.append((path.name, m.group(2), "\n".join(lines[i:j]), "\n".join(lines[j:k])))
        return found

    def test_every_registered_command_carries_a_check(self):
        missing = [f"{f}: {name}" for f, name, decorators, body in self.commands()
                   if "access_check.require(" not in decorators and "self._run(itx" not in body
                   and (f, name) not in self.EXEMPT]
        self.assertEqual(missing, [])

    def test_the_scan_sees_the_commands(self):
        # 走査が空振りして通るのを防ぐ: 既知のコマンドが数に入っていること
        names = {name for _, name, _, _ in self.commands()}
        self.assertTrue({"ask", "roles", "usage", "create", "doc", "help"} <= names)


if __name__ == "__main__":
    unittest.main()
