# -*- coding: utf-8 -*-
"""延期中の既定構成(Gemini・画像なし)で、Bot が従来の本番と同じに動くことの試験(2026-10-14)。

Gemini と画像生成は未導入。[ai.gemini] の節が無く、[assistant] の image_enabled が
false か省略のとき、次が本番と同じでなければならない:
- make_provider は素の ClaudeCLIProvider を返す(Gemini 用の束ね・import は一切しない)
- /ask・/doc のモデル選択肢は従来の 3 つだけ(gemini は出ない)
- /help の項目は従来のまま(統合アプリの案内は [assistant] 有効のときだけ)
- /image は登録されない。画像ジョブは即 IMAGE_DISABLED で失敗する
- 連携口の能力(meta)は features.image=false・gemini=false
"""

from __future__ import annotations

import asyncio
import inspect
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import ai_provider as P  # noqa: E402
from iyakusai_bot import documents as D  # noqa: E402
from iyakusai_bot import help as H  # noqa: E402
from iyakusai_bot import knowledge as K  # noqa: E402
from iyakusai_bot.assistant_store import AssistantStore  # noqa: E402
from iyakusai_bot.config import AssistantSettings  # noqa: E402
from iyakusai_bot.storage import ReminderStore  # noqa: E402

# tests/test_assistant_cog.py の偽 Discord をそのまま使う(実 Discord には接続しない)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_assistant_cog import FakeBot, FakeChannel, FakeGuild, FakeMember, SHARE, REMIND_CH, OTHER_CH  # noqa: E402

BASELINE_MODELS = ["auto", "sonnet", "opus"]
BASELINE_HELP_FIELDS = [
    "🔍 /ask — 資料から探して答える",
    "📄 /doc — 文書のたたき台を起草",
    "✉️ /mail — メールの草案",   # 設定に関係なく出す
    "⏰ /remind — リマインド・催促",
    "🗓 期限の書き方",
    "📊 /usage — AI使用量",
    "🎭 口調(キャラ)",
]


def provider_cfg(**overrides):
    base = dict(ai_provider="claude-cli", ai_model="sonnet", ai_heavy_model="opus", ai_auto_route=True,
                ai_timeout_sec=180, ai_agent_model="sonnet", ai_agent_max_turns=15, ai_agent_timeout_sec=300,
                ai_effort="", ai_agent_effort="")
    base.update(overrides)
    return SimpleNamespace(**base)


class ProviderParityTests(unittest.TestCase):
    def test_default_config_builds_the_plain_claude_provider(self):
        provider = P.make_provider(provider_cfg())
        self.assertIsInstance(provider, P.ClaudeCLIProvider)
        self.assertFalse(hasattr(P, "RoutedProvider"))

    def test_no_gemini_module_is_imported_by_the_default_path(self):
        for name in [m for m in sys.modules if "gemini" in m.lower()]:
            sys.modules.pop(name)
        P.make_provider(provider_cfg())
        self.assertEqual([m for m in sys.modules if "gemini" in m.lower()], [])

    def test_provider_none_is_unchanged(self):
        self.assertIsNone(P.make_provider(provider_cfg(ai_provider="none")))


class ChoiceParityTests(unittest.TestCase):
    def values(self, command):
        return [c.value for c in command._params["モデル"].choices]

    def test_ask_and_doc_offer_only_the_original_models(self):
        knowledge = K.Knowledge(SimpleNamespace(), None, None)
        documents = D.Documents(SimpleNamespace(), None, None)
        self.assertEqual(self.values(knowledge.ask), BASELINE_MODELS)
        self.assertEqual(self.values(documents.doc), BASELINE_MODELS)
        self.assertEqual(self.values(K.Knowledge.ask), BASELINE_MODELS)   # クラス直下も従来どおり

    def test_cogs_take_no_gemini_arguments(self):
        for init in (K.Knowledge.__init__, D.Documents.__init__):
            self.assertNotIn("gemini_enabled", inspect.signature(init).parameters)
        self.assertNotIn("gemini", inspect.getsource(P).lower())
        self.assertNotIn("gemini", inspect.getsource(K).lower())
        self.assertNotIn("gemini", inspect.getsource(D).lower())


class HelpParityTests(unittest.TestCase):
    def names(self, **kwargs):
        return [f.name for f in H.build_help_embed(True, **kwargs).fields]

    def test_help_fields_match_production_without_assistant(self):
        self.assertEqual(self.names(), BASELINE_HELP_FIELDS)

    def test_bot_tab_line_only_when_assistant_is_enabled(self):
        names = self.names(assistant_enabled=True)
        self.assertEqual(names[:-1], BASELINE_HELP_FIELDS)
        self.assertIn("🌐 統合アプリの「Bot」タブ", names[-1])
        self.assertFalse(any("/image" in n for n in names))


class AssistantDefaultTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="parity-"))
        self.store = AssistantStore.open(self.dir / "jobs.sqlite3")
        guild = FakeGuild([FakeMember(1000000000000000001, "テスト委員")])
        self.share = FakeChannel(SHARE, guild, "bottest")
        self.bot = FakeBot([self.share, FakeChannel(REMIND_CH, guild, "内務部"), FakeChannel(OTHER_CH, guild, "別部")])
        from iyakusai_bot.assistant_cog import Assistant
        settings = AssistantSettings(enabled=True, store_path=self.dir / "jobs.sqlite3",
                                     files_dir=self.dir / "files", share_channel_id=SHARE,
                                     reminder_channel_ids=[REMIND_CH, OTHER_CH])
        self.cog = Assistant(self.bot, settings, self.store, reminders=ReminderStore(self.dir))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_no_image_command_is_registered(self):
        self.assertNotIn("image", [c.name for c in self.cog.get_app_commands()])
        self.assertFalse(self.cog.image_enabled)

    def test_image_job_fails_fast_and_nothing_is_posted(self):
        job, _ = self.store.enqueue("discord-1000000000000000001", "テスト委員", "op-img", "image", None,
                                    {"prompt": "x", "aspect": "1:1"})
        asyncio.run(self.cog._run(self.store.claim_next(("image",)), None))
        done = self.store.get(job.id)
        self.assertEqual((done.state, done.error_code), ("failed", "IMAGE_DISABLED"))
        self.assertEqual(self.share.sent, [])

    def test_capabilities_say_no_image_and_no_gemini(self):
        asyncio.run(self.cog.publish_state())
        capabilities = json.loads(self.store.get_meta("capabilities"))
        self.assertFalse(capabilities["features"]["image"])
        self.assertFalse(capabilities["gemini"])


if __name__ == "__main__":
    unittest.main()
