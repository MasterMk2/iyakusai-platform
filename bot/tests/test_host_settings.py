"""連絡先([help] contact)・委員会名とキャンパス([org])・ホスト側の口調プリセット(persona_presets.json)。

どちらも名前や個人の素材をコードに置かないための仕組み。無いときはコード内の既定で動く。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import ai_provider, contact, knowledge_search, mail_draft, mirror, org, persona  # noqa: E402
from iyakusai_bot.config import load_config  # noqa: E402


class ContactTests(unittest.TestCase):
    def tearDown(self):
        contact.set_contact(None)

    def test_unset_falls_back_to_default(self):
        contact.set_contact("  ")
        self.assertEqual(contact.name(), contact.DEFAULT)

    def test_notes_use_the_configured_name(self):
        contact.set_contact("広報課")
        self.assertEqual(contact.ask_note(), "(続くようなら広報課へ)。")
        self.assertEqual(contact.ask_note("一時的な不調かもしれません。"), "(一時的な不調かもしれません。続くようなら広報課へ)。")

    def test_config_reads_help_contact(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "config.toml"
            path.write_text(f"[paths]\ndata_dir = '{Path(d).as_posix()}'\n\n[help]\ncontact = \"広報課\"\n", encoding="utf-8")
            self.assertEqual(load_config(path).contact, "広報課")
            path.write_text(f"[paths]\ndata_dir = '{Path(d).as_posix()}'\n", encoding="utf-8")
            self.assertEqual(load_config(path).contact, contact.DEFAULT)


class OrgTests(unittest.TestCase):
    def tearDown(self):
        org.configure()

    def test_unset_falls_back_to_defaults(self):
        org.configure(" ", None, "")
        self.assertEqual(org.fill("{委員会名}／{キャンパス}／{他キャンパス}"),
                         f"{org.DEFAULT_NAME}／{org.DEFAULT_CAMPUS}／{org.DEFAULT_OTHER_CAMPUSES}")

    def test_prompts_use_the_configured_names(self):
        org.configure("架空大学医学薬学祭実行委員会", "南キャンパス", "北=北祭/東=東祭")
        self.assertIn("あなたは架空大学医学薬学祭実行委員会(医薬祭)", ai_provider.build_doc_prompt("案内状", "x", ""))
        self.assertIn("医薬祭=南キャンパスの学祭", org.fill(ai_provider.SYSTEM_INSTRUCTIONS))
        self.assertIn("\n架空大学医学薬学祭実行委員会\n", mail_draft.build_prompt("x", ""))
        self.assertNotIn("{委員会名}", mail_draft.build_prompt("x", ""))

    def test_kept_mail_domains_follow_the_setting(self):
        own = "a@" + org.OWN_MAIL_DOMAINS[0]
        text = own + " b@adm.example.ac.jp c@ems.example.ac.jp d@adm.example.ac.jp.evil.test"
        self.assertEqual(knowledge_search._scrub_doc(text).count("【メールマスク】"), 3)
        org.configure(keep_mail_domains=["adm.example.ac.jp"])
        masked = knowledge_search._scrub_doc(text)
        self.assertIn(own + " b@adm.example.ac.jp", masked)
        self.assertEqual(masked.count("【メールマスク】"), 2)
        self.assertEqual(mirror._scrub_plain(text), masked)

    def test_config_reads_and_checks_org(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "config.toml"
            head = f"[paths]\ndata_dir = '{Path(d).as_posix()}'\n\n[org]\n"
            path.write_text(head + 'name = "架空委員会"\nkeep_mail_domains = ["adm.example.ac.jp"]\n', encoding="utf-8")
            cfg = load_config(path)
            self.assertEqual((cfg.org_name, cfg.org_keep_mail_domains), ("架空委員会", ("adm.example.ac.jp",)))
            for bad in ('keep_mail_domains = ["Adm.Example.ac.jp"]', 'keep_mail_domains = "adm.example.ac.jp"',
                        'campus = 1', 'school = "x"'):
                with self.subTest(bad=bad):
                    path.write_text(head + bad + "\n", encoding="utf-8")
                    with self.assertRaises(SystemExit):
                        load_config(path)


class HostPresetTests(unittest.TestCase):
    def setUp(self):
        self.saved = (dict(persona.PRESETS), dict(persona._ONDO_ALIASES))
        self.dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        persona.PRESETS.clear(); persona.PRESETS.update(self.saved[0])
        persona._ONDO_ALIASES.clear(); persona._ONDO_ALIASES.update(self.saved[1])
        for p in self.dir.iterdir():
            p.unlink()
        self.dir.rmdir()

    def write(self, data):
        (self.dir / persona.HOST_PRESETS_NAME).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def test_missing_file_keeps_only_code_presets(self):
        self.assertEqual(persona.load_host_presets(self.dir), 0)
        self.assertEqual(set(persona.PRESETS), set(self.saved[0]))

    def test_host_presets_and_aliases_resolve(self):
        self.write({"presets": {"架空の語り口": {"emoji": "🦉", "style": "架空の口調指示", "neta": True}},
                    "aliases": {"架空": "架空の語り口"}})
        self.assertEqual(persona.load_host_presets(self.dir), 1)
        self.assertEqual(persona.resolve_ondo("架空"), "架空の口調指示")
        self.assertEqual(persona.resolve_ondo("🦉 架空の語り口"), "架空の口調指示")
        self.assertTrue(persona.ondo_wants_neta("架空"))

    def test_malformed_file_adds_nothing(self):
        for bad in ([], {"presets": {"x": {"emoji": "x"}}}, {"presets": {}, "aliases": {"a": "存在しない"}}):
            with self.subTest(bad=bad):
                self.write(bad)
                with self.assertLogs("iyakusai.persona", "ERROR"):
                    self.assertEqual(persona.load_host_presets(self.dir), 0)
                self.assertEqual(set(persona.PRESETS), set(self.saved[0]))


if __name__ == "__main__":
    unittest.main()
