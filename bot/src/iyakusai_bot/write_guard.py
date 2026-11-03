# -*- coding: utf-8 -*-
"""Bot が作るファイルの名前と書き込み先のガード(2026-11-03)。純ロジック。

- ai_name(): Bot が作る文書・画像のファイル名の先頭に【AI】を付ける（既にあれば付けない）。
  AI が生成したものは、委員が開かなくても判別できるようにするため（_目録の運用ルールと同じ）。
  フォルダの区切り・制御文字は落とし、拡張子は残す。
- contained(): 書き込み先が許可された置き場の中にあることを確かめる。
  「..」・絶対パス・シンボリックリンクで外へ出る名前は WriteDenied にする（resolve で実体を比べる）。
- target_in(): 上の 2 つを合わせて、名前から安全な書き込み先を作る。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

AI_PREFIX = "【AI】"
MAX_NAME = 180
_UNSAFE = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')


class WriteDenied(ValueError):
    """書き込み先が許可された置き場の外にある。"""


def ai_name(name: str, fallback: str = "出力") -> str:
    base = re.split(r"[\\/]", str(name or ""))[-1]
    base = _UNSAFE.sub("_", base).strip().strip(".")
    if not base:
        base = fallback
    if not base.startswith(AI_PREFIX):
        base = AI_PREFIX + base
    if len(base) > MAX_NAME:
        stem, ext = os.path.splitext(base)
        if len(ext) > 10:
            stem, ext = base, ""
        base = stem[: MAX_NAME - len(ext)] + ext
    return base


def contained(root: Path, target: Path) -> Path:
    """target の実体（シンボリックリンクを辿った先）が root の中にあれば、その実体を返す。"""
    base = Path(root).resolve()
    resolved = Path(target).resolve()
    if resolved == base or not resolved.is_relative_to(base):
        raise WriteDenied("書き込み先が許可された場所の外にあります")
    return resolved


def target_in(root: Path, name: str) -> Path:
    """name を【AI】付きの安全な名前にして、root の中の書き込み先を返す（区切りは落としてから結ぶ）。"""
    return contained(root, Path(root) / ai_name(name))
