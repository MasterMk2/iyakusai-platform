# -*- coding: utf-8 -*-
"""2026-11-03 セキュリティレビューの修正の試験(H1・M1・L6)。

- 収集・保守スクリプトは Bot と同じホストのローカルの写し(tools_dir)だけ。共有データの中は拒む。
- 子プロセスは `python -I` で起き、環境変数は必要なものだけ(Discord のトークンは収集スクリプトだけに)。
- claude CLI の禁止リストは 1 か所で、現行のツール名(Agent・Skill など)を含む。--strict-mcp-config は設定で外せる。
"""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import ai_provider, tools_runner as collector  # noqa: E402
from iyakusai_bot.config import load_config  # noqa: E402


class DenyListTests(unittest.TestCase):
    def test_oneshot_list_names_the_current_tools(self):
        names = set(ai_provider.ONESHOT_DENIED_TOOLS.split(","))
        for tool in ("Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "Skill", "ToolSearch", "Monitor"):
            self.assertIn(tool, names)
        self.assertIs(ai_provider._ONESHOT_DENIED_TOOLS, ai_provider.ONESHOT_DENIED_TOOLS)

    def test_agent_list_denies_delegation_and_writes_but_not_reading(self):
        names = set(ai_provider._AGENT_DENIED_TOOLS.split(","))
        for tool in ("Bash", "Edit", "Write", "WebFetch", "Task", "Agent", "Skill"):
            self.assertIn(tool, names)
        self.assertNotIn("Read", names)
        self.assertEqual(ai_provider._AGENT_ALLOWED_TOOLS, "Read(./**),Glob(./**),Grep(./**)")

    @unittest.skipIf(os.name == "nt", "screening_run は fcntl を使う(Linux の Bot ホストで動く)")
    def test_screening_uses_the_same_list(self):
        from iyakusai_bot import screening_run
        self.assertIs(screening_run.DENIED_TOOLS, ai_provider.ONESHOT_DENIED_TOOLS)

    def test_minutes_worker_list_is_a_subset(self):
        """統合アプリの議事録の処理役と同じ内容にそろえる(あちらが増やしたら Bot も増やす)。"""
        worker = Path(__file__).resolve().parents[2] / "app" / "deploy" / "minutes-worker" / "minutes_worker.py"
        if not worker.is_file():
            self.skipTest("minutes_worker.py が無い配置")
        text = worker.read_text(encoding="utf-8")
        import re
        block = re.search(r"DENIED_TOOLS = \((.*?)\)", text, re.S).group(1)
        worker_names = set("".join(re.findall(r'"([^"]*)"', block)).split(","))
        worker_names.discard("")
        self.assertTrue(worker_names <= set(ai_provider.ONESHOT_DENIED_TOOLS.split(",")), worker_names - set(ai_provider.ONESHOT_DENIED_TOOLS.split(",")))


class CliArgumentsTests(unittest.TestCase):
    def test_oneshot_passes_strict_mcp_by_default_and_can_drop_it(self):
        strict = ai_provider.ClaudeCLIProvider(command=sys.executable)
        args = strict._resolve_cmd("sonnet")
        self.assertIn("--strict-mcp-config", args)
        self.assertEqual(args[args.index("--disallowedTools") + 1], ai_provider.ONESHOT_DENIED_TOOLS)
        loose = ai_provider.ClaudeCLIProvider(command=sys.executable, strict_mcp=False)
        self.assertNotIn("--strict-mcp-config", loose._resolve_cmd("sonnet"))

    def test_make_provider_reads_the_setting(self):
        cfg = types.SimpleNamespace(ai_provider="claude-cli", ai_model="sonnet", ai_heavy_model="opus", ai_auto_route=True,
                                    ai_timeout_sec=180, ai_strict_mcp_config=False)
        self.assertFalse(ai_provider.make_provider(cfg).strict_mcp)
        cfg.ai_strict_mcp_config = True
        self.assertTrue(ai_provider.make_provider(cfg).strict_mcp)

    def test_child_env_drops_discord_variables(self):
        with mock.patch.dict(os.environ, {"DISCORD_TOKEN": "synthetic", "DISCORD_TOKEN_FILE": "/x", "CLAUDE_CONFIG_DIR": "/c", "PATH": os.environ.get("PATH", "")}):
            env = ai_provider.child_env({"EXTRA": "1"})
        self.assertNotIn("DISCORD_TOKEN", env)
        self.assertNotIn("DISCORD_TOKEN_FILE", env)
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], "/c")
        self.assertEqual(env["EXTRA"], "1")
        self.assertIn("PATH", env)


class ToolsDirTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.knowledge = self.root / "mokuroku"
        (self.knowledge / "discord" / "tools").mkdir(parents=True)
        (self.knowledge / "discord" / "tools" / "collect_discord_v2.py").write_text("# drive copy\n", encoding="utf-8")
        self.local = self.root / "local-tools"
        self.local.mkdir()
        (self.local / "collect_discord_v2.py").write_text("# local copy\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def cfg(self, tools_dir):
        return types.SimpleNamespace(collect_tools_dir=tools_dir, knowledge_dir=self.knowledge, data_dir=self.knowledge / "discord" / "bot" / "data",
                                     mirror_dir=self.root / "mirror", config_path=None)

    def test_default_is_the_repository_collectors_folder(self):
        default = collector.default_tools_dir()
        self.assertEqual(default.name, "discord")
        self.assertEqual(default.parent.name, "collectors")
        self.assertTrue((default / "collect_discord_v2.py").is_file())
        self.assertTrue((default / "fetch_attachments.py").is_file())
        self.assertTrue((default / "digest_staleness.py").is_file())
        self.assertTrue((default / "build_semantic_indexes.py").is_file())

    def test_local_copy_is_used_and_the_drive_copy_refused(self):
        self.assertEqual(collector.resolve_tools_dir(self.cfg(self.local)), self.local.resolve())
        self.assertIsNone(collector.resolve_tools_dir(self.cfg(self.knowledge / "discord" / "tools")))
        self.assertIsNone(collector.resolve_tools_dir(self.cfg(self.root / "mirror" / "tools")))
        self.assertIsNone(collector.resolve_tools_dir(self.cfg(self.root / "nothing-here")))

    def test_child_env_passes_only_what_the_scripts_need(self):
        with mock.patch.dict(os.environ, {"DISCORD_TOKEN": "synthetic", "DISCORD_TOKEN_FILE": "/t", "CLAUDE_CONFIG_DIR": "/c",
                                          "OLLAMA_HOST": "http://127.0.0.1:11434", "PATH": os.environ.get("PATH", "")}):
            plain = collector.child_env(self.knowledge, config_path=self.root / "config.toml")
            with_token = collector.child_env(self.knowledge, discord_token=True)
        self.assertEqual(plain["IYAKUSAI_KNOWLEDGE_DIR"], str(self.knowledge))
        self.assertEqual(plain["IYAKUSAI_CONFIG"], str(self.root / "config.toml"))
        self.assertTrue(Path(plain["IYAKUSAI_BOT_SRC"]).joinpath("iyakusai_bot", "collector.py").is_file())
        self.assertEqual(plain["OLLAMA_HOST"], "http://127.0.0.1:11434")
        self.assertEqual(plain["PYTHONIOENCODING"], "utf-8")
        for name in ("DISCORD_TOKEN", "DISCORD_TOKEN_FILE", "CLAUDE_CONFIG_DIR"):
            self.assertNotIn(name, plain)
        # The collector itself gets the token's file, never the value when a file exists.
        self.assertEqual(with_token["DISCORD_TOKEN_FILE"], "/t")
        self.assertNotIn("DISCORD_TOKEN", with_token)

    def test_scripts_run_isolated(self):
        self.assertEqual(collector.script_command(Path("x.py"), "--json")[:2], [sys.executable, "-I"])


class ConfigTests(unittest.TestCase):
    def write(self, extra: str) -> Path:
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir()
        config = tmp / "config.toml"
        config.write_text(
            "[host]\nname = 'synthetic'\n[paths]\ndata_dir = '" + str(tmp / "data").replace("\\", "/") + "'\n" + extra,
            encoding="utf-8")
        return config

    def test_tools_dir_outside_shared_data_and_strict_mcp_setting(self):
        tmp_tools = Path(tempfile.mkdtemp())
        cfg = load_config(self.write("[collect]\ntools_dir = '" + str(tmp_tools).replace("\\", "/") + "'\n[ai]\nstrict_mcp_config = false\n"))
        self.assertEqual(cfg.collect_tools_dir, tmp_tools.resolve())
        self.assertFalse(cfg.ai_strict_mcp_config)
        self.assertTrue(cfg.config_path.is_file())
        default = load_config(self.write(""))
        self.assertIsNone(default.collect_tools_dir)
        self.assertTrue(default.ai_strict_mcp_config)

    def test_tools_dir_inside_data_dir_refuses_startup(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data" / "tools").mkdir(parents=True)
        config = tmp / "config.toml"
        config.write_text("[host]\nname = 'synthetic'\n[paths]\ndata_dir = '" + str(tmp / "data").replace("\\", "/")
                          + "'\n[collect]\ntools_dir = '" + str(tmp / "data" / "tools").replace("\\", "/") + "'\n", encoding="utf-8")
        with self.assertRaises(SystemExit):
            load_config(config)


if __name__ == "__main__":
    unittest.main()
