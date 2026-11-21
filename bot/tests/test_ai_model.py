# -*- coding: utf-8 -*-
"""Bot の AI のモデルの切り替え(ai_model・2026-11-21)。合成の settings.json だけを使う。"""
import json
import os
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iyakusai_bot import ai_model, go_quota  # noqa: E402

GO = "https://opencode.ai/inference/go/anthropic"
KEY = "synthetic-key-should-stay-0123456789"


class SwitchTest(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.get("CLAUDE_CONFIG_DIR")
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = Path(d.name)
        self.path = self.dir / "settings.json"
        os.environ["CLAUDE_CONFIG_DIR"] = d.name

    def tearDown(self):
        if self.saved is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = self.saved

    def write(self, env, **extra):
        self.path.write_text(json.dumps({"env": env, **extra}), encoding="utf-8")
        os.chmod(self.path, 0o600)

    def go_env(self, model="gemini-4-argon"):
        return {"ANTHROPIC_BASE_URL": GO, "ANTHROPIC_AUTH_TOKEN": KEY, "ANTHROPIC_API_KEY": "",
                **{k: model for k in ai_model.MODEL_KEYS}}

    def test_switch_changes_only_the_four_model_keys(self):
        self.write(self.go_env(), permissions={"deny": ["Bash"]})
        out = ai_model.switch("claude-haiku-5-5")
        self.assertEqual(out, {"before": "gemini-4-argon", "model": "claude-haiku-5-5", "changed": True})
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data["env"], self.go_env("claude-haiku-5-5"))
        self.assertEqual(data["permissions"], {"deny": ["Bash"]})   # ほかの設定はそのまま
        self.assertEqual(go_quota.current_route()["model"], "claude-haiku-5-5")
        self.assertEqual([p.name for p in self.dir.iterdir()], ["settings.json"])   # 一時ファイル・控えを残さない

    @unittest.skipIf(os.name == "nt", "POSIX の権限だけ")
    def test_file_stays_owner_only(self):
        self.write(self.go_env())
        ai_model.switch("glm-5.3")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_same_model_is_not_a_change(self):
        self.write(self.go_env("glm-5.3"))
        before = self.path.stat().st_mtime_ns
        self.assertFalse(ai_model.switch("glm-5.3")["changed"])
        self.assertEqual(self.path.stat().st_mtime_ns, before)

    def test_unknown_model_is_refused_without_touching_the_file(self):
        self.write(self.go_env())
        text = self.path.read_text(encoding="utf-8")
        for model in ("deepseek-v4-pro", "opus", "", "../x"):
            with self.assertRaises(ai_model.SwitchError) as err:
                ai_model.switch(model)
            self.assertEqual(err.exception.code, "UNKNOWN_MODEL")
        self.assertEqual(self.path.read_text(encoding="utf-8"), text)

    def test_refused_when_not_go_or_no_key(self):
        for env in ({"ANTHROPIC_BASE_URL": "https://api.anthropic.com"}, {"ANTHROPIC_BASE_URL": GO}):
            self.write(env)
            with self.assertRaises(ai_model.SwitchError) as err:
                ai_model.switch("glm-5.3")
            self.assertEqual(err.exception.code, "NOT_GO")
        self.path.unlink()
        with self.assertRaises(ai_model.SwitchError):
            ai_model.switch("glm-5.3")

    def test_error_text_never_holds_the_key(self):
        self.write({"ANTHROPIC_BASE_URL": "x", "ANTHROPIC_AUTH_TOKEN": KEY})
        with self.assertRaises(ai_model.SwitchError) as err:
            ai_model.switch("glm-5.3")
        self.assertNotIn(KEY, str(err.exception))


class RequestTest(unittest.TestCase):
    def request(self, **over):
        value = {"id": "ui-abcdefgh", "model": "glm-5.3", "by": "discord-1000000000000000004",
                 "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        value.update(over)
        return json.dumps(value)

    def test_parse_and_handled(self):
        req = ai_model.parse_request(self.request())
        self.assertEqual(req["model"], "glm-5.3")
        self.assertFalse(ai_model.handled(req, None))
        self.assertFalse(ai_model.handled(req, json.dumps({"id": "ui-other"})))
        self.assertTrue(ai_model.handled(req, json.dumps({"id": "ui-abcdefgh", "ok": True})))

    def test_malformed_requests(self):
        for raw in (None, "", "{", "[]", self.request(by="1000"), self.request(id="ui:bad"), self.request(model=5)):
            self.assertIsNone(ai_model.parse_request(raw), raw)

    def test_expiry(self):
        old = (datetime.now(timezone.utc) - timedelta(seconds=ai_model.REQUEST_TTL_SEC + 5)).isoformat()
        self.assertTrue(ai_model.expired(ai_model.parse_request(self.request(at=old))))
        self.assertFalse(ai_model.expired(ai_model.parse_request(self.request())))
        self.assertTrue(ai_model.expired(ai_model.parse_request(self.request(at="2026-11-21T10:00:00"))))  # 時刻帯なし

    def test_history_keeps_the_last_entries(self):
        raw = None
        for i in range(ai_model.HISTORY_MAX + 3):
            raw = ai_model.push_history(raw, {"model": f"m{i}"})
        history = json.loads(raw)
        self.assertEqual(len(history), ai_model.HISTORY_MAX)
        self.assertEqual(history[-1]["model"], f"m{ai_model.HISTORY_MAX + 2}")
        self.assertEqual(json.loads(ai_model.push_history("{bad", {"model": "x"})), [{"model": "x"}])

    def test_snapshot_after_a_change_keeps_the_quota(self):
        record = ai_model.change_record({"before": "gemini-4-argon", "model": "claude-haiku-5-5"},
                                        by="discord-1000000000000000004", by_name="委員長", source="app")
        snap = {"provider": "opencode_go", "model": "gemini-4-argon", "ok": True, "windows": [{"key": "weekly"}]}
        body = ai_model.with_change(snap, record)
        self.assertEqual((body["model"], body["modelLabel"]), ("claude-haiku-5-5", "Claude Haiku 5.5"))
        self.assertEqual(body["windows"], [{"key": "weekly"}])
        self.assertEqual(body["lastChange"]["previous"], "gemini-4-argon")
        self.assertEqual(body["lastChange"]["byName"], "委員長")
        self.assertNotIn("by", body["lastChange"])   # Discord の ID はアプリに渡さない
        self.assertEqual([c["model"] for c in body["choices"]], list(go_quota.MODEL_LABELS))

    def test_last_change_survives_the_next_quota_read(self):
        prev = {"provider": "opencode_go", "windows": [{"key": "weekly", "percent": 1}],
                "lastChange": {"model": "glm-5.3"}}
        fresh = {"provider": "opencode_go", "ok": True, "windows": [], "model": "glm-5.3"}
        self.assertEqual(go_quota.merge_for_store(prev, fresh)["lastChange"], {"model": "glm-5.3"})
        failed = {"provider": "opencode_go", "ok": False, "windows": [], "model": "glm-5.3", "error": "http_500"}
        self.assertEqual(go_quota.merge_for_store(prev, failed)["lastChange"], {"model": "glm-5.3"})


class RequestChoicesTest(unittest.TestCase):
    """質問・文書を頼むときに選べるモデル(2026-11-22)。"""

    def setUp(self):
        self.saved = os.environ.get("CLAUDE_CONFIG_DIR")
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = d.name

    def tearDown(self):
        if self.saved is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = self.saved

    def test_go_offers_the_default_then_each_model(self):
        Path(self.dir, "settings.json").write_text(json.dumps({"env": {"ANTHROPIC_BASE_URL": GO}}), encoding="utf-8")
        os.environ["CLAUDE_CONFIG_DIR"] = self.dir
        choices = go_quota.request_choices()
        self.assertEqual(choices[0], (go_quota.DEFAULT_CHOICE_LABEL, "auto"))
        self.assertEqual([v for _, v in choices[1:]], list(go_quota.MODEL_LABELS))

    def test_nothing_without_go(self):
        os.environ["CLAUDE_CONFIG_DIR"] = self.dir   # settings.json が無い
        self.assertEqual(go_quota.request_choices(), [])

    def test_the_input_check_takes_the_go_models_only_when_given(self):
        from iyakusai_bot import assistant_logic as L
        self.assertEqual(L.ask_input({"question": "q", "model": "glm-5.3"}, gemini=False, extra_models=("glm-5.3",))["model"],
                         "glm-5.3")
        with self.assertRaises(L.InputError):
            L.ask_input({"question": "q", "model": "glm-5.3"}, gemini=False)
        doc = {"docType": "free", "content": "c", "format": "md", "useSources": False, "model": "gpt-5.6-luna"}
        self.assertEqual(L.doc_input(doc, gemini=False, extra_models=("gpt-5.6-luna",))["model"], "gpt-5.6-luna")


if __name__ == "__main__":
    unittest.main()
