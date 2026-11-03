# -*- coding: utf-8 -*-
"""Bot が動かす収集・保守スクリプトの置き場と子プロセスの環境(discord に依存しない部分。collector.py が使う)。

2026-11-03 セキュリティレビュー H1: 共有ドライブ(knowledge_dir)上のスクリプトは実行しない。実行するのは Bot と同じ
ホストのローカルの写し(tools_dir)だけ。子プロセスは `python -I` で起き、環境変数は必要なものだけ渡す。
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

log = logging.getLogger("iyakusai.collect")

# Bot が動かす収集・保守スクリプト(tools_dir に置く。リポジトリでは collectors/discord/)。
COLLECT_SCRIPT = "collect_discord_v2.py"
ATTACHMENTS_SCRIPT = "fetch_attachments.py"
STALENESS_SCRIPT = "digest_staleness.py"
SEMANTIC_SCRIPT = "build_semantic_indexes.py"

# 子プロセスへそのまま渡してよい環境変数(OS が要るもの・文字コード・証明書・プロキシ・Ollama)。
# それ以外(DISCORD_TOKEN、CLAUDE_*、鍵の場所など)は渡さない。
_PASS_ENV = (
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    "https_proxy", "http_proxy", "no_proxy", "OLLAMA_HOST", "PYTHONUTF8", "VIRTUAL_ENV",
)


def default_tools_dir() -> Path:
    """リポジトリの配置(bot/src/iyakusai_bot/tools_runner.py)から見た collectors/discord。"""
    return Path(__file__).resolve().parents[3] / "collectors" / "discord"


def _inside(path: Path, root: Path) -> bool:
    try:
        # realpath: Windows の短い名前(8.3 形式)やシンボリックリンクを展開して比べる
        a, b = os.path.realpath(path), os.path.realpath(root)
        return os.path.commonpath([a, b]) == b
    except (ValueError, OSError):  # Windows で別ドライブなど
        return False


def resolve_tools_dir(cfg) -> Path | None:
    """実行してよいスクリプトの置き場。無い・共有データの中にある・collect_discord_v2.py が無いなら None(収集しない)。

    cfg は Config(collect_tools_dir・knowledge_dir・data_dir・mirror_dir を見る)。
    """
    candidate = Path(getattr(cfg, "collect_tools_dir", None) or default_tools_dir()).expanduser()
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    for root in (getattr(cfg, "knowledge_dir", None), getattr(cfg, "data_dir", None), getattr(cfg, "mirror_dir", None)):
        if root is not None and _inside(resolved, Path(root)):
            log.error("収集スクリプトの置き場が共有データ・ミラーの中を指しています(実行しません): %s", resolved)
            return None
    if not (resolved / COLLECT_SCRIPT).is_file():
        return None
    return resolved


def child_env(knowledge_dir: Path, *, discord_token: bool = False, config_path: Path | None = None) -> dict[str, str]:
    """子プロセスの環境変数。必要なものだけ渡す(Bot の環境をそのまま継がない)。"""
    env = {k: os.environ[k] for k in _PASS_ENV if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env["IYAKUSAI_KNOWLEDGE_DIR"] = str(knowledge_dir)
    env["IYAKUSAI_BOT_SRC"] = str(Path(__file__).resolve().parents[1])
    if config_path is not None:
        env["IYAKUSAI_CONFIG"] = str(config_path)
    if discord_token:
        # 収集スクリプトだけ。ファイルの場所があれば場所を、無ければ値を(Bot 自身がそうして起きたときだけ)。
        if os.environ.get("DISCORD_TOKEN_FILE"):
            env["DISCORD_TOKEN_FILE"] = os.environ["DISCORD_TOKEN_FILE"]
        elif os.environ.get("DISCORD_TOKEN"):
            env["DISCORD_TOKEN"] = os.environ["DISCORD_TOKEN"]
    return env


def script_command(script: Path, *args: str) -> list[str]:
    """`python -I <script> ...`。-I は cwd・PYTHONPATH・ユーザー site を読まない(同名の .py を置かれても拾わない)。"""
    return [sys.executable, "-I", str(script), *args]
