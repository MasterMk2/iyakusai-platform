"""Contract B thread map: verified bindings with ready threads only, atomic 0600 write, never fatal."""
from datetime import datetime
import json
import os
from pathlib import Path
import stat
import unittest
from unittest.mock import patch

from oa_relay import JST, Binding, Registry
import runner
from thread_map import build_thread_map, publish_thread_map, write_atomic
from test_oa_relay import StateFixture, FORUM

OTHER_FORUM = "1888888888888888888"
NOW = datetime(2026, 11, 2, 22, 0, 0, 123456, tzinfo=JST)


def binding(org_id, source_id, *, verified=True, source_type="user", org_name=None):
    return Binding(source_type, source_id, org_id, org_name or f"架空団体{org_id[-1]}", verified,
                   "fixture:manual-confirmation", "fixture-reviewer")


class ThreadMapFixture(StateFixture):
    def setUp(self):
        super().setUp()
        self.registry = Registry([
            binding("org_a", "U" + "a" * 32),
            binding("org_b", "U" + "b" * 32),
            binding("org_c", "C" + "c" * 32, source_type="group"),
            binding("org_d", "U" + "d" * 32, verified=False),
            binding("org_e", "U" + "e" * 32, org_name="架空団体E"),
            binding("org_e", "U" + "f" * 32, org_name="架空団体E"),
        ])
        rows = [
            ("org_a", FORUM["id"], "ready", "1700000000000000001"),
            ("org_b", FORUM["id"], "creating", None),
            ("org_c", FORUM["id"], "ready", "1700000000000000003"),
            ("org_d", FORUM["id"], "ready", "1700000000000000004"),
            ("org_e", FORUM["id"], "ready", "1700000000000000005"),
            ("org_f", OTHER_FORUM, "ready", "1700000000000000006"),
        ]
        self.state.db.executemany("INSERT INTO threads VALUES (?,?,?,?)", rows)
        self.target = self.root / "share" / "threads.json"
        self.target.parent.mkdir()


class BuildTests(ThreadMapFixture, unittest.TestCase):
    def test_only_verified_ready_threads_in_the_approved_forum(self):
        document, skipped = build_thread_map(self.registry, self.state, FORUM["id"], now=NOW)
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["generatedAt"], "2026-11-02T22:00:00+09:00")
        self.assertEqual(document["threads"], {
            "1700000000000000001": {"sourceType": "user", "sourceId": "U" + "a" * 32,
                                    "orgId": "org_a", "orgName": "架空団体a"},
            "1700000000000000003": {"sourceType": "group", "sourceId": "C" + "c" * 32,
                                    "orgId": "org_c", "orgName": "架空団体c"},
        })
        # org_b is still creating; org_f is in another forum: neither is counted as skipped.
        self.assertEqual(skipped, {"no_verified_binding": 1, "ambiguous_organization_source": 1})

    def test_generated_at_is_jst_seconds_even_from_utc_clock(self):
        document, _ = build_thread_map(self.registry, self.state, FORUM["id"],
                                       now=datetime.fromisoformat("2026-11-02T13:00:00.5+00:00"))
        self.assertEqual(document["generatedAt"], "2026-11-02T22:00:00+09:00")

    def test_malformed_or_shared_thread_id_is_left_out(self):
        self.state.db.execute("UPDATE threads SET thread_id='1700000000000000001' WHERE org_id='org_c'")
        document, skipped = build_thread_map(self.registry, self.state, FORUM["id"], now=NOW)
        self.assertNotIn("1700000000000000001", document["threads"])
        self.assertEqual(skipped["invalid_thread"], 2)


class WriteTests(ThreadMapFixture, unittest.TestCase):
    def test_write_is_0600_complete_json_and_leaves_no_temporary(self):
        result = publish_thread_map(self.target, self.registry, self.state, FORUM["id"], now=NOW)
        self.assertEqual(result, {"written": True, "threads": 2,
                                  "skipped": {"no_verified_binding": 1, "ambiguous_organization_source": 1}})
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)
        data = json.loads(self.target.read_text(encoding="utf-8"))
        self.assertEqual(sorted(data), ["generatedAt", "threads", "version"])
        self.assertEqual(data["threads"]["1700000000000000001"]["orgId"], "org_a")
        self.assertEqual(sorted(p.name for p in self.target.parent.iterdir()), ["threads.json"])

    def test_rewrite_replaces_by_rename_and_tightens_mode(self):
        self.target.write_text("{}", encoding="utf-8")
        self.target.chmod(0o644)
        before = self.target.stat().st_ino
        publish_thread_map(self.target, self.registry, self.state, FORUM["id"], now=NOW)
        self.assertNotEqual(self.target.stat().st_ino, before)   # a reader holding the old file sees it whole
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)
        self.state.db.execute("DELETE FROM threads WHERE org_id='org_c'")
        publish_thread_map(self.target, self.registry, self.state, FORUM["id"], now=NOW)
        self.assertEqual(list(json.loads(self.target.read_text(encoding="utf-8"))["threads"]),
                         ["1700000000000000001"])

    def test_failures_return_a_code_and_never_raise(self):
        missing = self.root / "absent" / "threads.json"
        self.assertEqual(publish_thread_map(missing, self.registry, self.state, FORUM["id"]),
                         {"written": False, "reason": "thread_map_directory_missing"})
        self.assertEqual(publish_thread_map(None, self.registry, self.state, FORUM["id"]),
                         {"written": False, "reason": "not_configured"})
        with patch("thread_map.os.replace", side_effect=PermissionError("denied /secret/path")):
            result = publish_thread_map(self.target, self.registry, self.state, FORUM["id"])
        self.assertEqual(result, {"written": False, "reason": "PermissionError"})
        self.assertEqual(list(self.target.parent.iterdir()), [])   # the temporary file was removed

    def test_failed_write_keeps_previous_map(self):
        publish_thread_map(self.target, self.registry, self.state, FORUM["id"], now=NOW)
        previous = self.target.read_bytes()
        with patch("thread_map.os.fsync", side_effect=OSError("disk")):
            self.assertFalse(publish_thread_map(self.target, Registry([]), self.state, FORUM["id"])["written"])
        self.assertEqual(self.target.read_bytes(), previous)

    def test_symlinked_directory_is_refused(self):
        link = self.root / "linked"
        os.symlink(self.target.parent, link)
        result = publish_thread_map(link / "threads.json", self.registry, self.state, FORUM["id"])
        self.assertEqual(result, {"written": False, "reason": "thread_map_directory_missing"})

    def test_write_atomic_rejects_oversized_document(self):
        with self.assertRaisesRegex(ValueError, "too_large"):
            write_atomic(self.target, {"x": "あ" * (2 * 1024 * 1024)})
        self.assertFalse(self.target.exists())


class RunOnceTests(ThreadMapFixture, unittest.TestCase):
    """The map is written at the end of run_once, and its failure does not stop the cycle."""

    def run_cycle(self, path):
        class KeptOpen:
            def __init__(inner, journal):
                inner.journal = journal

            def __getattr__(inner, name):
                return getattr(inner.journal, name)

            def close(inner):
                pass

        self.state._set("activated_at", NOW.isoformat())
        patches = [
            patch.object(runner, "validate_config", return_value=FORUM["id"]),
            patch.object(runner, "existing_token", return_value="synthetic"),
            patch.object(runner, "DiscordAPI"),
            patch.object(runner, "inspect_access", return_value=(None, FORUM, None, {"synthetic": True})),
            patch.object(runner, "read_store_events", return_value=[]),
            patch.object(runner, "read_contacts", return_value={}),
            patch.object(runner, "approved_scope", return_value=(frozenset(), {})),
            patch.object(runner, "load_registry", return_value=self.registry),
            patch.object(runner, "Journal", return_value=KeptOpen(self.state)),
            patch.object(runner, "Delivery"),
            patch.object(runner, "process_cycle", return_value={"delivered": 1}),
            patch.object(runner, "THREAD_MAP_FILE", path),
        ]
        for item in patches:
            item.start()
        try:
            return runner.run_once({"known_member_ids": [], "approved_admin_bot_exceptions": []}, [])
        finally:
            for item in reversed(patches):
                item.stop()

    def test_cycle_reports_written_map(self):
        result = self.run_cycle(self.target)
        self.assertEqual(result["outcomes"], {"delivered": 1})
        self.assertEqual(result["thread_map"]["written"], True)
        self.assertTrue(self.target.exists())

    def test_cycle_continues_when_map_cannot_be_written(self):
        result = self.run_cycle(self.root / "absent" / "threads.json")
        self.assertEqual(result["outcomes"], {"delivered": 1})
        self.assertEqual(result["thread_map"], {"written": False, "reason": "thread_map_directory_missing"})
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_cycle_without_configured_map(self):
        self.assertEqual(self.run_cycle(None)["thread_map"], {"written": False, "reason": "not_configured"})


if __name__ == "__main__":
    unittest.main()
