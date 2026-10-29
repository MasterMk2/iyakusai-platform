# -*- coding: utf-8 -*-
"""起動エントリポイント。

    python -m iyakusai_bot [--config PATH] [--force]

起動シーケンス(要件定義 §4.1): ロック取得 → 開始。停止時にロック解放。
mirror モードの down/up 同期は外側のラッパースクリプト(RPi 側)が担う。
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .bot import IyakusaiBot
from .config import load_config, load_token
from .lockfile import InstanceLock, LockBusy


def main() -> int:
    ap = argparse.ArgumentParser(prog="iyakusai_bot")
    ap.add_argument("--config", help="config.toml のパス(既定: ~/.iyakusai/config.toml)")
    ap.add_argument("--force", action="store_true",
                    help="他ホストのロックを強制的に乗っ取る(相手の停止を確認してから)")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    cfg = load_config(args.config)
    token = load_token()

    lock = InstanceLock(cfg.data_dir, cfg.host_name, cfg.takeover_after_sec)
    try:
        lock.acquire(force=args.force)
    except LockBusy as e:
        print(f"起動中止: {e}", file=sys.stderr)
        return 1

    bot = IyakusaiBot(cfg, lock)

    async def runner():
        async with bot:
            await bot.start(token)

    try:
        asyncio.run(runner())
    except KeyboardInterrupt:
        pass
    finally:
        lock.release()
        logging.getLogger("iyakusai").info("ロックを解放して終了")
    return 0


if __name__ == "__main__":
    sys.exit(main())
