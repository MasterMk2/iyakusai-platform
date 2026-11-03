# -*- coding: utf-8 -*-
"""2026-11-03 セキュリティレビュー M2: /export・/media の接続元の制限と、トークン不一致の連続に対する一時的な拒否。"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("oa_server", Path(__file__).with_name("oa_server.py"))
oa = importlib.util.module_from_spec(spec)
sys.modules["oa_server"] = oa
spec.loader.exec_module(oa)


class PullGuardTests(unittest.TestCase):
    def test_empty_allow_list_permits_everyone_and_cidrs_limit(self):
        self.assertTrue(oa.PullGuard([]).permitted("203.0.113.9"))
        guard = oa.PullGuard(["127.0.0.1/32", "172.18.0.0/16"])
        self.assertTrue(guard.permitted("127.0.0.1"))
        self.assertTrue(guard.permitted("172.18.0.44"))
        self.assertFalse(guard.permitted("203.0.113.9"))
        self.assertFalse(guard.permitted("not an address"))

    def test_lockout_after_repeated_failures_and_release_after_the_window(self):
        now = [1000.0]
        guard = oa.PullGuard([], limit=3, window=60, clock=lambda: now[0])
        client = "172.18.0.44"
        for _ in range(3):
            self.assertFalse(guard.blocked(client))
            guard.record(client, False)
        self.assertTrue(guard.blocked(client))
        self.assertFalse(guard.blocked("172.18.0.45"), "ほかの接続元は数えない")
        now[0] += 61
        self.assertFalse(guard.blocked(client))

    def test_success_clears_the_count(self):
        guard = oa.PullGuard([], limit=2, window=60)
        guard.record("10.0.0.1", False)
        guard.record("10.0.0.1", True)
        guard.record("10.0.0.1", False)
        self.assertFalse(guard.blocked("10.0.0.1"))

    def test_table_stays_bounded(self):
        guard = oa.PullGuard([], limit=5, window=60)
        for i in range(1500):
            guard.record(f"10.{(i >> 16) & 255}.{(i >> 8) & 255}.{i & 255}", False)
        self.assertLessEqual(len(guard._failures), 1024)

    def test_config_defaults(self):
        import json
        import tempfile
        tmp = Path(tempfile.mkdtemp()) / "line_oa_server.json"
        tmp.write_text(json.dumps({"channel_secret": "s", "pull_token": "t"}), encoding="utf-8")
        cfg = oa.load_config(tmp)
        self.assertEqual(cfg["pull_allowed_clients"], [])
        self.assertEqual(cfg["pull_failure_limit"], 10)
        self.assertEqual(cfg["pull_failure_window_sec"], 900)
        tmp.write_text(json.dumps({"channel_secret": "s", "pull_token": "t", "pull_allowed_clients": ["999.1.1.1/32"]}), encoding="utf-8")
        with self.assertRaises(SystemExit):
            oa.load_config(tmp)


if __name__ == "__main__":
    unittest.main()
