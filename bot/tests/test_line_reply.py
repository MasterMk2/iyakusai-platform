"""/line返信(line_reply.py)の設定・本文・応答の解釈・アプリへの呼び出しの試験。

Discord には触れない。アプリへの呼び出しは opener を差し替えて、送る中身と応答の扱いだけを見る。
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iyakusai_bot import access  # noqa: E402
from iyakusai_bot import line_reply as L  # noqa: E402

FORUM = 1000000000000000007


class SettingsTests(unittest.TestCase):
    def test_missing_values_mean_not_configured(self):
        self.assertFalse(L.LineReplySettings.from_mapping({}).configured)
        self.assertFalse(L.LineReplySettings.from_mapping(None).configured)
        self.assertFalse(L.LineReplySettings.from_mapping({"app_url": "http://iyakusai-app:5178"}).configured)

    def test_complete_values_are_configured(self):
        s = L.LineReplySettings.from_mapping({"app_url": "http://iyakusai-app:5178/", "key_file": "/srv/k.key",
                                              "forum_channel_id": FORUM})
        self.assertTrue(s.configured)
        self.assertEqual(s.app_url, "http://iyakusai-app:5178")
        self.assertEqual(s.timeout_sec, L.DEFAULT_TIMEOUT_SEC)

    def test_unknown_key_and_bad_values_are_refused(self):
        bad = [
            {"app_url": "x", "nope": 1},
            {"app_url": "http://example.com", "key_file": "/srv/k.key", "forum_channel_id": FORUM},  # 外への平文
            {"app_url": "https://app.example/path", "key_file": "/srv/k.key", "forum_channel_id": FORUM},
            {"app_url": "http://iyakusai-app:5178", "key_file": "relative.key", "forum_channel_id": FORUM},
            {"app_url": "http://iyakusai-app:5178", "key_file": "/srv/k.key", "forum_channel_id": "1"},
            {"timeout_sec": 60},
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(L.LineReplyConfigError):
                L.LineReplySettings.from_mapping(raw)

    def test_url_ok_allows_https_and_internal_http_only(self):
        for url in ("https://app.example", "http://localhost:5178", "http://iyakusai-app:5178",
                    "http://127.0.0.1:5178", "http://172.18.0.19:5178", "http://10.1.2.3"):
            self.assertTrue(L.url_ok(url), url)
        for url in ("http://app.example", "http://8.8.8.8", "ftp://x", "http://x:99999"):
            self.assertFalse(L.url_ok(url), url)


class KeyTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / "k.key"

    def tearDown(self):
        self._dir.cleanup()

    def test_reads_a_private_key(self):
        self.path.write_text("a" * 40 + "\n", encoding="ascii")
        os.chmod(self.path, 0o600)
        self.assertEqual(L.load_key(self.path), "a" * 40)

    def test_short_or_missing_key_is_refused_without_showing_it(self):
        self.path.write_text("short", encoding="ascii")
        os.chmod(self.path, 0o600)
        with self.assertRaises(L.LineReplyConfigError) as caught:
            L.load_key(self.path)
        self.assertNotIn("short", str(caught.exception))
        with self.assertRaises(L.LineReplyConfigError):
            L.load_key(Path(self._dir.name) / "none.key")

    @unittest.skipIf(os.name == "nt", "権限の確認は POSIX だけ")
    def test_key_readable_by_others_is_refused(self):
        self.path.write_text("a" * 40, encoding="ascii")
        os.chmod(self.path, 0o644)
        with self.assertRaises(L.LineReplyConfigError):
            L.load_key(self.path)


class TextTests(unittest.TestCase):
    def test_backslash_n_becomes_a_newline(self):
        self.assertEqual(L.normalize_text("こんにちは\\nよろしく"), "こんにちは\nよろしく")

    def test_empty_long_and_control_characters_are_refused(self):
        for raw in ("", "   ", "a" * (L.TEXT_MAX + 1), "a\x07b"):
            with self.subTest(raw=raw[:10]), self.assertRaises(L.LineReplyInputError):
                L.normalize_text(raw)

    def test_only_threads_of_the_forum_are_accepted(self):
        self.assertTrue(L.in_reply_forum(True, FORUM, FORUM))
        self.assertFalse(L.in_reply_forum(False, FORUM, FORUM))
        self.assertFalse(L.in_reply_forum(True, 1, FORUM))
        self.assertFalse(L.in_reply_forum(True, FORUM, None))

    def test_custom_id_round_trip_and_refusal(self):
        value = L.custom_id("send", 123456789012345678, "abc-1")
        self.assertRegex(value, L.CUSTOM_ID_TEMPLATE)
        with self.assertRaises(ValueError):
            L.custom_id("delete", 123456789012345678, "abc")
        with self.assertRaises(ValueError):
            L.custom_id("send", 123456789012345678, "bad id")

    def test_requests_send_ids_as_strings(self):
        self.assertEqual(L.preview_request(5, 6, "t"), {"threadId": "5", "discordUserId": "6", "text": "t"})
        self.assertEqual(L.send_request("c1", 6), {"consentId": "c1", "discordUserId": "6"})


class ParseTests(unittest.TestCase):
    NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)

    def test_preview_ok_never_waits_longer_than_the_app(self):
        later = (self.NOW + timedelta(hours=1)).isoformat()
        p = L.parse_preview(200, {"ok": True, "consentId": "c1", "orgName": "団体A", "recipients": 2,
                                  "expiresAt": later}, now=self.NOW)
        self.assertIsInstance(p, L.Preview)
        self.assertEqual(p.expires_at, self.NOW + L.CONSENT_TTL)
        sooner = (self.NOW + timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        p = L.parse_preview(200, {"ok": True, "consentId": "c1", "orgName": "団体A", "expiresAt": sooner}, now=self.NOW)
        self.assertEqual(p.expires_at, self.NOW + timedelta(minutes=1))

    def test_preview_failures(self):
        self.assertEqual(L.parse_preview(401, None).code, "unauthorized")
        self.assertEqual(L.parse_preview(404, None).code, "disabled")
        self.assertEqual(L.parse_preview(200, {"ok": True, "consentId": "bad id", "orgName": "A"}).code, "bad_response")
        self.assertEqual(L.parse_preview(503, None).code, "unavailable")

    def test_send_unclear_results_are_unknown(self):
        self.assertEqual(L.parse_send(200, {"ok": False}).status, "unknown")
        self.assertEqual(L.parse_send(502, None).status, "unknown")
        self.assertEqual(L.parse_send(200, {"ok": True, "status": "weird"}).status, "unknown")
        self.assertTrue(L.parse_send(200, {"ok": True, "status": "accepted"}).accepted)
        self.assertIsInstance(L.parse_send(409, {"code": "expired"}), L.Failure)

    def test_long_text_is_clipped_and_attached(self):
        preview = L.Preview("c1", self.NOW, "団体*A", 1, "団体A に 1 通送ります。")
        text, attach = L.confirm_text(preview, "あ" * 3000)
        self.assertTrue(attach)
        self.assertLessEqual(len(text), L.MESSAGE_LIMIT)
        self.assertIn("団体\\*A", text)
        record, attach = L.record_text("名前", "短い")
        self.assertFalse(attach)
        self.assertIn("> 短い", record)


class _Response:
    def __init__(self, status: int, body: bytes):
        self.status, self._body = status, body

    def read(self, n=-1):
        return self._body[:n] if n >= 0 else self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Opener:
    def __init__(self, result):
        self.result, self.requests = result, []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class CallAppTests(unittest.TestCase):
    SETTINGS = L.LineReplySettings(app_url="http://iyakusai-app:5178", key_file=Path("/srv/k.key"),
                                   forum_channel_id=FORUM, timeout_sec=5)

    def test_posts_json_with_the_bearer_key(self):
        opener = _Opener(_Response(200, b'{"ok":true}'))
        status, data = L.call_app(self.SETTINGS, "k" * 40, L.PREVIEW_PATH, {"text": "あ"}, opener=opener)
        self.assertEqual((status, data), (200, {"ok": True}))
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, "http://iyakusai-app:5178" + L.PREVIEW_PATH)
        self.assertEqual(request.get_header("Authorization"), "Bearer " + "k" * 40)
        self.assertEqual(json.loads(request.data.decode("utf-8")), {"text": "あ"})
        self.assertEqual(timeout, 5)

    def test_http_errors_return_the_status_and_body(self):
        error = urllib.error.HTTPError("u", 403, "x", {}, io.BytesIO(b'{"code":"forbidden"}'))
        self.assertEqual(L.call_app(self.SETTINGS, "k" * 40, L.SEND_PATH, {}, opener=_Opener(error)),
                         (403, {"code": "forbidden"}))

    def test_unreachable_app_is_a_transport_error(self):
        with self.assertRaises(L.LineReplyTransportError):
            L.call_app(self.SETTINGS, "k" * 40, L.SEND_PATH, {}, opener=_Opener(urllib.error.URLError("down")))

    def test_oversized_or_broken_bodies_become_none(self):
        big = b"{" + b" " * L.MAX_RESPONSE_BYTES + b"}"
        self.assertEqual(L.call_app(self.SETTINGS, "k" * 40, L.SEND_PATH, {}, opener=_Opener(_Response(200, big)))[1], None)
        self.assertEqual(L.call_app(self.SETTINGS, "k" * 40, L.SEND_PATH, {}, opener=_Opener(_Response(200, b"x")))[1], None)


class PermissionTableTests(unittest.TestCase):
    def test_line_reply_is_in_the_table_as_send(self):
        self.assertEqual(access.kind_of("line返信"), "send")


if __name__ == "__main__":
    unittest.main()
