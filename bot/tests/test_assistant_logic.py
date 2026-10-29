# -*- coding: utf-8 -*-
"""入力検査・権限規則・型判定(assistant_logic)と、Bot の設定の [assistant] / [ai.gemini] の試験。"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import assistant_logic as L  # noqa: E402
from iyakusai_bot import config as C  # noqa: E402
from iyakusai_bot.remind_logic import JST  # noqa: E402

NOW = datetime(2026, 10, 14, 10, 0, tzinfo=JST)


class InputTests(unittest.TestCase):
    def test_text_is_trimmed_and_control_characters_removed_but_newlines_kept_for_multiline(self):
        self.assertEqual(L.clean_text("  a\x07b\r\nc\t ", field="x", max_len=20, multiline=True), "ab\nc")
        self.assertEqual(L.clean_text("a\nb\tc", field="x", max_len=20), "a b c")

    def test_length_and_required_checks(self):
        with self.assertRaises(L.InputError):
            L.clean_text("   ", field="質問", max_len=10, min_len=1)
        with self.assertRaises(L.InputError) as ctx:
            L.clean_text("あ" * 11, field="質問", max_len=10)
        self.assertIn("10字以内", ctx.exception.message)
        self.assertIsNone(L.clean_text("  ", field="口調", max_len=10, optional=True))

    def test_ask_defaults_and_unknown_keys(self):
        got = L.ask_input({"question": " 質問です "}, gemini=False)
        self.assertEqual(got, {"question": "質問です", "model": "auto", "effort": "auto", "tone": None, "format": None})
        with self.assertRaises(L.InputError):
            L.ask_input({"question": "x", "extra": 1}, gemini=False)
        with self.assertRaises(L.InputError):
            L.ask_input({"question": "x", "effort": "max"}, gemini=False)

    def test_gemini_model_is_refused_when_disabled_with_its_own_code(self):
        with self.assertRaises(L.InputError) as ctx:
            L.ask_input({"question": "x", "model": "gemini"}, gemini=False)
        self.assertEqual(ctx.exception.code, "MODEL_UNAVAILABLE")
        self.assertEqual(L.ask_input({"question": "x", "model": "gemini"}, gemini=True)["model"], "gemini")

    def test_doc_requires_boolean_use_sources_and_known_type(self):
        base = {"docType": "request", "content": "発電機の見積依頼", "format": "docx", "useSources": True}
        self.assertEqual(L.doc_input(base, gemini=False)["model"], "auto")
        with self.assertRaises(L.InputError):
            L.doc_input({**base, "useSources": "yes"}, gemini=False)
        with self.assertRaises(L.InputError):
            L.doc_input({**base, "docType": "unknown"}, gemini=False)

    def test_image_default_aspect_and_limit(self):
        self.assertEqual(L.image_input({"prompt": "ポスター"})["aspect"], "1:1")
        with self.assertRaises(L.InputError):
            L.image_input({"prompt": "x" * 1001})
        with self.assertRaises(L.InputError):
            L.image_input({"prompt": "x", "aspect": "2:1"})

    def test_remind_due_accepts_discord_form_and_iso_with_jst(self):
        for text in ("7/20 18:00", "明日", "+3d", "2030-01-05T18:00", "2030-01-05T18:00:00+09:00"):
            L.parse_due_input(text, now=NOW)
        iso = L.parse_due_input("2030-01-05T18:00+09:00", now=NOW)
        self.assertEqual(iso.utcoffset().total_seconds(), 9 * 3600)
        with self.assertRaises(L.InputError):
            L.parse_due_input("来年のどこか", now=NOW)

    def test_remind_create_checks_ids_and_repeat(self):
        got = L.remind_create_input({"text": "資料提出", "due": "2030-01-05T18:00+09:00",
                                     "targetId": "discord-1000000000000000001", "channelId": "1000000000000000002"},
                                    now=NOW)
        self.assertEqual((got["targetId"], got["channelId"], got["repeat"]),
                         ("1000000000000000001", "1000000000000000002", "none"))
        with self.assertRaises(L.InputError):
            L.remind_create_input({"text": "x", "due": "2030-01-05T18:00", "targetId": "1000000000000000001"}, now=NOW)
        with self.assertRaises(L.InputError):
            L.remind_create_input({"text": "x", "due": "2030-01-05T18:00", "channelId": "12"}, now=NOW)

    def test_screening_return_needs_comment_and_action_is_known(self):
        self.assertEqual(L.screening_input("return", {"comment": " 直して "}), {"comment": "直して"})
        with self.assertRaises(L.InputError):
            L.screening_input("return", {"comment": "  "})
        self.assertEqual(L.screening_input("ok", {}), {"comment": None})
        with self.assertRaises(L.InputError):
            L.screening_input("delete", {})

    def test_client_operation_id_and_reminder_id(self):
        self.assertEqual(L.client_operation_id("ui-123_a.b:c"), "ui-123_a.b:c")
        with self.assertRaises(L.InputError):
            L.client_operation_id("日本語")
        self.assertEqual(L.reminder_id(3), 3)
        with self.assertRaises(L.InputError):
            L.reminder_id("3")
        with self.assertRaises(L.InputError):
            L.reminder_id(True)


class RuleTests(unittest.TestCase):
    REM = {"creator_id": 1, "target_id": 2}

    def test_complete_allows_creator_target_or_admin_only(self):
        self.assertTrue(L.may_complete(1, False, self.REM))
        self.assertTrue(L.may_complete(2, False, self.REM))
        self.assertTrue(L.may_complete(9, True, self.REM))
        self.assertFalse(L.may_complete(9, False, self.REM))

    def test_delete_allows_creator_or_admin_not_target(self):
        self.assertTrue(L.may_delete(1, False, self.REM))
        self.assertFalse(L.may_delete(2, False, self.REM))
        self.assertTrue(L.may_delete(9, True, self.REM))

    def test_file_type_rules(self):
        self.assertEqual(L.sniff_image_mime(b"\x89PNG\r\n\x1a\n...."), "image/png")
        self.assertEqual(L.sniff_image_mime(b"\xff\xd8\xff\xe0...."), "image/jpeg")
        self.assertEqual(L.sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp")
        self.assertIsNone(L.sniff_image_mime(b"MZ....exe"))
        self.assertTrue(L.is_downloadable(L.mime_for_name("回答.docx")))
        self.assertTrue(L.is_downloadable("text/markdown; charset=utf-8"))
        self.assertFalse(L.is_downloadable("application/x-msdownload"))
        self.assertIsNone(L.mime_for_name("a.exe"))

    def test_safe_file_name_drops_separators_and_controls(self):
        self.assertEqual(L.safe_file_name("../../etc/passwd"), "passwd")
        self.assertEqual(L.safe_file_name("a\\b\x07.md"), "b.md")   # 区切りの後ろだけを残す
        self.assertEqual(L.safe_file_name("報告\x07書.docx"), "報告書.docx")
        self.assertEqual(L.safe_file_name(""), "出力")


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cfg-"))
        self.data = self.dir / "data"
        self.data.mkdir()
        self.env = dict(os.environ)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, extra: str) -> Path:
        path = self.dir / "config.toml"
        data = str(self.data).replace("\\", "/")
        path.write_text(
            f'[host]\nname = "test-host"\nmode = "direct"\n[paths]\ndata_dir = "{data}"\n{extra}\n',
            encoding="utf-8")
        return path

    def assistant_block(self, store, files, **overrides):
        values = {"enabled": "true", "store_path": f'"{store}"', "files_dir": f'"{files}"',
                  "share_channel_id": "1000000000000000001",
                  "reminder_channel_ids": "[1000000000000000002]"}
        values.update(overrides)
        return "[assistant]\n" + "\n".join(f"{k} = {v}" for k, v in values.items()) + "\n"

    def test_absent_section_is_disabled(self):
        cfg = C.load_config(self.write(""))
        self.assertFalse(cfg.assistant.enabled)

    def test_valid_section_parses_with_defaults(self):
        store = (self.dir / "ops" / "jobs.sqlite3").as_posix()
        files = (self.dir / "ops" / "files").as_posix()
        cfg = C.load_config(self.write(self.assistant_block(store, files)))
        self.assertTrue(cfg.assistant.enabled)
        self.assertEqual(cfg.assistant.share_channel_id, 1000000000000000001)
        self.assertEqual(cfg.assistant.reminder_channel_ids, [1000000000000000002])
        self.assertEqual((cfg.assistant.poll_sec, cfg.assistant.max_active_per_user), (2, 3))

    def test_invalid_sections_exit_with_a_message(self):
        ok_store = (self.dir / "ops" / "j.sqlite3").as_posix()
        ok_files = (self.dir / "ops" / "f").as_posix()
        bad_cases = [
            self.assistant_block("relative/jobs.sqlite3", ok_files),          # 相対パス
            self.assistant_block((self.data / "jobs.sqlite3").as_posix(), ok_files),   # 共有データの中
            self.assistant_block(ok_store, ok_files, share_channel_id='"12"'),        # 文字列の ID
            self.assistant_block(ok_store, ok_files, reminder_channel_ids="[]"),      # 空
            self.assistant_block(ok_store, ok_files, poll_sec="0"),                   # 範囲外
            self.assistant_block(ok_store, ok_files, unknown_key="1"),                # 未知の項目
        ]
        for block in bad_cases:
            with self.subTest(block=block[-60:]):
                with self.assertRaises(SystemExit):
                    C.load_config(self.write(block))

    def test_app_image_switch_is_read_and_defaults_off(self):
        # 2026-10-14 夜に Claude の SVG 方式で再開。省略・false は従来どおり(画像を受けない)
        store = (self.dir / "ops" / "j.sqlite3").as_posix()
        files = (self.dir / "ops" / "f").as_posix()
        self.assertFalse(C.load_config(self.write(self.assistant_block(store, files))).assistant.image_enabled)
        cfg = C.load_config(self.write(self.assistant_block(store, files, image_enabled="true")))
        self.assertTrue(cfg.assistant.image_enabled)
        with self.assertRaises(SystemExit):
            C.load_config(self.write(self.assistant_block(store, files, image_enabled='"yes"')))

    def image_block(self, **overrides):
        values = {"enabled": "true", "font_dir": f'"{(self.dir / "fonts").as_posix()}"',
                  "work_dir": f'"{(self.dir / "image-work").as_posix()}"'}
        values.update(overrides)
        return "[image]\n" + "\n".join(f"{k} = {v}" for k, v in values.items()) + "\n"

    def test_image_section_absent_is_off_and_valid_section_has_defaults(self):
        self.assertFalse(C.load_config(self.write("")).image.enabled)
        self.assertFalse(C.load_config(self.write("[image]\nenabled = false\n")).image.enabled)
        cfg = C.load_config(self.write(self.image_block()))
        image = cfg.image
        self.assertTrue(image.enabled)
        self.assertEqual((image.model, image.effort, image.render_python), ("opus", "low", ""))
        self.assertEqual((image.render_timeout_sec, image.daily_limit_per_user, image.max_concurrent), (60, 20, 1))
        self.assertEqual(image.font_dir, (self.dir / "fonts").resolve())
        python = (self.dir / "venv" / "bin" / "python").as_posix()
        cfg = C.load_config(self.write(self.image_block(model='"sonnet"', effort='"medium"',
                                                        render_python=f'"{python}"', daily_limit_per_user="5")))
        self.assertEqual((cfg.image.model, cfg.image.effort, cfg.image.daily_limit_per_user), ("sonnet", "medium", 5))
        self.assertEqual(Path(cfg.image.render_python), Path(python))

    def test_invalid_image_sections_exit_with_a_message(self):
        bad_cases = [
            self.image_block(font_dir='"relative/fonts"'),                                  # 相対パス
            self.image_block(work_dir=f'"{(self.data / "work").as_posix()}"'),              # 共有データの中
            self.image_block(model='"gemini"'),                                             # 対象外のモデル
            self.image_block(effort='"extreme"'),                                           # 知らない深さ
            self.image_block(render_python='"python3"'),                                    # 絶対パスでない
            self.image_block(max_concurrent="3"),                                           # 範囲外
            self.image_block(daily_limit_per_user="0"),                                     # 範囲外
            self.image_block(unknown_key="1"),                                              # 未知の項目
            "[image]\nenabled = true\n",                                                    # 置き場が無い
        ]
        for block in bad_cases:
            with self.subTest(block=block[-60:]):
                with self.assertRaises(SystemExit):
                    C.load_config(self.write(block))

    def test_gemini_section_changes_nothing_while_postponed(self):
        # Gemini は未導入。設定の読み方は本番と同じ(知らない節は読まない)で、
        # [ai.gemini] を書いても AI の設定・振り分けには何も効かない
        for text in ('[ai.gemini]\nenabled = false\n', '[ai.gemini]\nenabled = true\n',
                     '[ai]\nprovider = "claude-cli"\n[ai.gemini]\n'):
            with self.subTest(text=text):
                cfg = C.load_config(self.write(text))
                self.assertEqual(cfg.ai_provider, "claude-cli")
                self.assertFalse(hasattr(cfg, "gemini"))


if __name__ == "__main__":
    unittest.main()
