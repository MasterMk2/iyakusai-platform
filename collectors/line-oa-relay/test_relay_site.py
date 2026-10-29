"""relay_site.py: deployment values come only from site.json, with no defaults."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent / "relay_site.py"
EXAMPLE = Path(__file__).resolve().parent / "site.example.json"


def load(site_text, mode=0o600):
    """Import a private copy of relay_site.py whose directory holds site_text."""
    root = Path(tempfile.mkdtemp())
    try:
        shutil.copy(SOURCE, root / "relay_site.py")
        if site_text is not None:
            (root / "site.json").write_text(site_text, encoding="utf-8")
            (root / "site.json").chmod(mode)
        spec = importlib.util.spec_from_file_location("relay_site_under_test", root / "relay_site.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        shutil.rmtree(root)


class RelaySiteTests(unittest.TestCase):
    def setUp(self):
        self.example = json.loads(EXAMPLE.read_text(encoding="utf-8"))

    def refused(self, site_text, mode=0o600):
        with self.assertRaises(RuntimeError) as caught:
            load(site_text, mode)
        self.assertEqual(str(caught.exception), "deployment site values refused")

    def test_example_values_load(self):
        site = load(json.dumps(self.example)).SITE
        self.assertEqual(site["guild"], self.example["guildId"])
        self.assertEqual(site["committee_roles"], frozenset(self.example["committeeRoleIds"]))
        self.assertEqual(str(site["store"]), self.example["storeDirectory"])

    def test_missing_or_shared_file_is_refused(self):
        self.refused(None)
        self.refused(json.dumps(self.example), mode=0o644)

    def test_malformed_values_are_refused(self):
        cases = [
            {"guildId": "12345"},
            {"botId": self.example["guildId"]},
            {"committeeRoleIds": []},
            {"committeeRoleIds": [self.example["botId"]]},
            {"storeDirectory": "relative/events"},
            {"legacyOrganizationIds": ["Has Space"]},
            {"internalSourceFingerprints": ["xyz"]},
        ]
        for change in cases:
            with self.subTest(change=sorted(change)):
                self.refused(json.dumps({**self.example, **change}))

    def test_unknown_or_missing_keys_are_refused(self):
        self.refused(json.dumps({**self.example, "debug": True}))
        self.refused(json.dumps({k: v for k, v in self.example.items() if k != "approvedForumId"}))
        self.refused("not json")


if __name__ == "__main__":
    unittest.main()
