# -*- coding: utf-8 -*-
"""実際に答えたモデルの表示と、OpenCode Go の料金の換算(2026-11-21)。"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iyakusai_bot import ai_provider as ap  # noqa: E402


class UsedModelTest(unittest.TestCase):
    def test_picks_model_with_most_output(self):
        data = {"modelUsage": {"claude-haiku-5-5": {"outputTokens": 399, "costUSD": 0.006},
                               "small": {"outputTokens": 3, "costUSD": 0.0001}}}
        self.assertEqual(ap._used_model(data), "claude-haiku-5-5")

    def test_missing_model_usage(self):
        self.assertEqual(ap._used_model({}), "")
        self.assertEqual(ap._used_model({"modelUsage": "x"}), "")


class RoutingTest(unittest.TestCase):
    def setUp(self):
        self.saved = ap.ROUTING
        self.saved_env = os.environ.get("CLAUDE_CONFIG_DIR")

    def tearDown(self):
        ap.ROUTING = self.saved
        if self.saved_env is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = self.saved_env

    def _with_settings(self, env):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        Path(d.name, "settings.json").write_text(json.dumps({"env": env}), encoding="utf-8")
        os.environ["CLAUDE_CONFIG_DIR"] = d.name
        return ap._routing()

    def test_go_routing_detected_without_reading_the_key(self):
        r = self._with_settings({"ANTHROPIC_BASE_URL": "https://opencode.ai/inference/go/anthropic",
                                 "ANTHROPIC_AUTH_TOKEN": "secret-should-not-appear",
                                 "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-haiku-5-5"})
        self.assertEqual(r["provider"], "opencode_go")
        self.assertEqual(r["aliases"]["opus"], "claude-haiku-5-5")
        self.assertNotIn("secret-should-not-appear", json.dumps(r))

    def test_subscription_when_no_settings(self):
        os.environ["CLAUDE_CONFIG_DIR"] = "/nonexistent-iyakusai-test"
        self.assertEqual(ap._routing()["provider"], "claude_subscription")

    def test_go_cost_and_display(self):
        ap.ROUTING = {"provider": "opencode_go", "aliases": {"opus": "claude-haiku-5-5"}}
        self.assertEqual(ap.display_model("opus"), "claude-haiku-5-5")
        self.assertEqual(ap.display_model("glm-5.3"), "glm-5.3")
        note = ap.AIResult(text="x", model="claude-haiku-5-5", cost_usd=0.006).cost_note(160.0)
        self.assertEqual(note, "Go換算 月枠の0.04%(≒$0.0040・0.6円)")
        other = ap.AIResult(text="x", model="unknown-model", cost_usd=0.05).cost_note(160.0)
        self.assertEqual(other, "Go(月額$10定額) API換算 $0.050")
        self.assertIn("OpenCode Go", ap._billing_line())

    def test_subscription_cost_unchanged(self):
        ap.ROUTING = {"provider": "claude_subscription", "aliases": {}}
        self.assertEqual(ap.display_model("opus"), "opus")
        self.assertEqual(ap.AIResult(text="x", model="opus", cost_usd=0.006).cost_note(160.0),
                         "API換算 $0.006(≒1円)")


if __name__ == "__main__":
    unittest.main()
