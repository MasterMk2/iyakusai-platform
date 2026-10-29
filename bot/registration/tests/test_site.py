"""site.py: deployment values come only from site.json, with no defaults."""

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src" / "iyakusai_registration_runtime" / "site.py"
EXAMPLE = Path(__file__).resolve().parents[1] / "site.example.json"


def load(site_text, mode=0o600):
    """Import a private copy of site.py whose release directory holds site_text."""
    root = Path(tempfile.mkdtemp())
    try:
        package = root / "src" / "pkg"
        package.mkdir(parents=True)
        shutil.copy(SOURCE, package / "site.py")
        if site_text is not None:
            (root / "site.json").write_text(site_text, encoding="utf-8")
            (root / "site.json").chmod(mode)
        spec = importlib.util.spec_from_file_location("site_under_test", package / "site.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module  # dataclass resolves its module by name
        try:
            spec.loader.exec_module(module)
        finally:
            del sys.modules[spec.name]
        return module
    finally:
        shutil.rmtree(root)


class SiteTests(unittest.TestCase):
    def setUp(self):
        self.example = json.loads(EXAMPLE.read_text(encoding="utf-8"))

    def refused(self, site_text, mode=0o600):
        with self.assertRaises(RuntimeError) as caught:
            load(site_text, mode)
        self.assertEqual(str(caught.exception), "deployment site values refused")

    def test_example_values_load(self):
        site = load(json.dumps(self.example)).SITE
        self.assertEqual(site.guild_id, self.example["guildId"])
        self.assertEqual(site.shared_account_ids, frozenset(self.example["sharedAccountIds"]))
        self.assertEqual(site.listen_port, 18432)
        self.assertEqual(str(site.server_private_key), self.example["serverPrivateKey"])

    def test_missing_file_is_refused(self):
        self.refused(None)

    def test_file_readable_by_others_is_refused(self):
        self.refused(json.dumps(self.example), mode=0o644)

    def test_malformed_values_are_refused(self):
        cases = [
            {"guildId": "12345"},
            {"listenHost": "0.0.0.0"},
            {"listenHost": "203.0.113.5"},
            {"listenPort": 80},
            {"sharedAccountIds": []},
            {"sharedAccountIds": [self.example["bootstrapUserId"]]},
            {"configDirectory": "relative/path"},
        ]
        for change in cases:
            with self.subTest(change=sorted(change)):
                self.refused(json.dumps({**self.example, **change}))

    def test_unknown_or_missing_keys_are_refused(self):
        extra = {**self.example, "debug": True}
        missing = {k: v for k, v in self.example.items() if k != "callerIp"}
        self.refused(json.dumps(extra))
        self.refused(json.dumps(missing))
        self.refused("not json")


if __name__ == "__main__":
    unittest.main()
