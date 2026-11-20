# -*- coding: utf-8 -*-
"""OpenCode Go の残り枠を読む go_quota の試験(2026-11-21)。窓口には出ない(偽の opener)。"""
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iyakusai_bot import go_quota as gq  # noqa: E402

SECRET = "oc_sk_synthetic_secret_should_never_appear"
GO_ENV = {"ANTHROPIC_BASE_URL": "https://opencode.ai/inference/go/anthropic", "ANTHROPIC_AUTH_TOKEN": SECRET,
          "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-4-argon"}
ANSWER = {"usage": {"rolling": {"status": "ok", "percent": 14, "resetsAt": "2026-11-20T18:49:49.000Z"},
                    "weekly": {"status": "ok", "percent": 85.4, "resetsAt": "2026-11-23T00:00:00.000Z"},
                    "monthly": {"status": "ok", "percent": 2, "resetsAt": "2026-12-20T13:11:56.000Z"}}}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class GoQuotaTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get("CLAUDE_CONFIG_DIR")
        self.addCleanup(self._restore)
        gq._cache = None

    def _restore(self):
        if self._saved is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = self._saved

    def settings(self, env):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        Path(d.name, "settings.json").write_text(json.dumps({"env": env}), encoding="utf-8")
        os.environ["CLAUDE_CONFIG_DIR"] = d.name

    def test_reads_windows_and_sends_key_only_in_the_header(self):
        self.settings(GO_ENV)
        seen = {}

        def opener(req, timeout):
            seen["auth"] = req.get_header("Authorization")
            seen["ua"] = req.get_header("User-agent")
            seen["url"] = req.full_url
            return FakeResponse(json.dumps(ANSWER).encode())

        r = gq.fetch(opener=opener)
        self.assertTrue(r["ok"])
        self.assertEqual(seen["auth"], f"Bearer {SECRET}")
        self.assertEqual(seen["url"], gq.USAGE_URL)
        self.assertFalse(seen["ua"].startswith("Python-urllib"))  # 既定の名乗りは Cloudflare に弾かれる
        self.assertEqual([w["key"] for w in r["windows"]], ["rolling", "weekly", "monthly"])
        self.assertEqual(r["windows"][1]["percent"], 85.4)
        self.assertEqual(r["modelLabel"], "Gemini 4 Argon")
        self.assertNotIn(SECRET, json.dumps(r))

    def test_not_go_does_not_call_out(self):
        self.settings({"FOO": "1"})
        r = gq.fetch(opener=lambda *a, **k: self.fail("呼んではいけない"))
        self.assertEqual(r["provider"], "claude_subscription")
        self.assertEqual(r["error"], "not_go")

    def test_http_error_is_reported_without_the_key(self):
        self.settings(GO_ENV)

        def opener(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))

        r = gq.fetch(opener=opener)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "http_401")
        self.assertNotIn(SECRET, json.dumps(r))

    def test_network_error_keeps_only_the_kind(self):
        self.settings(GO_ENV)

        def opener(req, timeout):
            raise OSError(f"boom {req.get_header('Authorization')}")

        r = gq.fetch(opener=opener)
        self.assertEqual(r["error"], "OSError")
        self.assertNotIn(SECRET, json.dumps(r))

    def test_bad_answer(self):
        self.settings(GO_ENV)
        r = gq.fetch(opener=lambda req, timeout: FakeResponse(b'{"usage": {"rolling": {}}}'))
        self.assertEqual(r["error"], "bad_answer")

    def test_model_is_read_again_each_time(self):
        self.settings(GO_ENV)
        self.assertEqual(gq.current_route()["model"], "gemini-4-argon")
        self.settings({**GO_ENV, "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-haiku-5-5"})
        self.assertEqual(gq.current_route()["modelLabel"], "Claude Haiku 5.5")

    def test_merge_keeps_last_values_when_reading_fails(self):
        good = {"provider": "opencode_go", "model": "gemini-4-argon", "modelLabel": "Gemini 4 Argon", "ok": True,
                "windows": [{"key": "rolling", "label": "5時間", "percent": 14.0, "status": "ok", "resetsAt": None}],
                "fetchedAt": "2026-11-21T02:00:00Z", "error": None}
        bad = {"provider": "opencode_go", "model": "gemini-4-argon", "modelLabel": "Gemini 4 Argon", "ok": False,
               "windows": [], "fetchedAt": "2026-11-21T02:05:00Z", "error": "http_503"}
        merged = gq.merge_for_store(good, bad)
        self.assertTrue(merged["stale"])
        self.assertFalse(merged["ok"])
        self.assertEqual(merged["windows"][0]["percent"], 14.0)
        self.assertEqual(merged["fetchedAt"], "2026-11-21T02:00:00Z")
        self.assertEqual(merged["error"], "http_503")
        self.assertFalse(gq.merge_for_store(None, {**good})["stale"])

    def test_lines_mark_high_use(self):
        self.settings(GO_ENV)
        r = gq.fetch(opener=lambda req, timeout: FakeResponse(json.dumps(ANSWER).encode()))
        out = gq.lines(r)
        self.assertEqual(len(out), 3)
        self.assertIn("11/21 03:49 に戻る", out[0])
        self.assertIn("⚠️", out[1])
        self.assertNotIn("⚠️", out[0])

    def test_cache(self):
        self.settings(GO_ENV)
        calls = []

        def opener(req, timeout):
            calls.append(1)
            return FakeResponse(json.dumps(ANSWER).encode())

        gq.get(opener=opener)
        gq.get(opener=opener)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
