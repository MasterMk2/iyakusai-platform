# -*- coding: utf-8 -*-
"""口調(ペルソナ)。/ask の会話部分にだけ効かせる。

- 恒久設定: data/persona.json(全ホスト共有)。/persona で役員が切替
- その場指定: /ask の 口調 オプション(誰でも・自由文)。恒久設定より優先
- 出典表記・禁止事項・原本確認注記は口調に関わらず厳守(ai_provider 側で担保)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .neta import DEFAULT_NETA_DIR
from .storage import read_json, write_json

log = logging.getLogger("iyakusai.persona")

HOST_PRESETS_NAME = "persona_presets.json"

# コード内プリセット(語尾・一人称キャラ)。style がそのままAIへの口調指示になる。
# 実在の人の語り口を写したプリセットは、個人の素材から作るのでコードに置かない。
# ネタ帳と同じフォルダ(ドライブ外)の persona_presets.json から起動時に足す(load_host_presets)。
PRESETS: dict[str, dict] = {
    "マスコット": {
        "emoji": "🌱",
        "style": (
            "一人称は「ぼく」。語尾は「〜だよ」「〜だね」を基調に、明るく親しみやすい"
            "医薬祭の応援マスコットとして話す。馴れ馴れしすぎず、要点は崩さない。"
            "回答の最後に医薬祭を盛り上げる短い一言を添えてもよい。"
        ),
    },
    "元気": {
        "emoji": "🔥",
        "style": "元気でテンション高め。語尾に「!」を多めに使い、前向きに励ます。ただし情報は正確に。",
    },
    "丁寧秘書": {
        "emoji": "🎩",
        "style": "落ち着いた有能な秘書の口調。丁寧語で簡潔に、要点を先に述べる。過度な装飾はしない。",
    },
    "お嬢様": {
        "emoji": "🌹",
        "style": "上品なお嬢様口調。語尾は「〜ですわ」「〜ますわ」。丁寧だが情報は正確に、簡潔に。",
    },
}


# 略称・別名 → プリセット名(/ask の 口調: にプリセット名で単発指定できるように)
_ONDO_ALIASES: dict[str, str] = {}


def load_host_presets(neta_dir: Path | None = None) -> int:
    """ホスト側の口調プリセット(persona_presets.json)を PRESETS と別名表に足す。足した件数を返す。

    形: {"presets": {名前: {"emoji", "style", "neta"(任意)}}, "aliases": {別名: 名前}}。
    無ければ 0(=コード内のプリセットだけで動く)。形が違えば何も足さずにログへ残す。
    """
    path = (Path(neta_dir) if neta_dir else DEFAULT_NETA_DIR) / HOST_PRESETS_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return 0
    except (OSError, ValueError):
        log.error("口調プリセットのファイルを読めません: %s", path.name)
        return 0
    if not isinstance(raw, dict):
        log.error("口調プリセットのファイルの形が違うので読みません: %s", path.name)
        return 0
    presets, aliases = raw.get("presets"), raw.get("aliases", {})
    if (not isinstance(presets, dict) or not isinstance(aliases, dict)
            or any(not isinstance(v, dict) or not isinstance(v.get("emoji"), str)
                   or not isinstance(v.get("style"), str) for v in presets.values())
            or any(not isinstance(t, str) or t not in {**PRESETS, **presets} for t in aliases.values())):
        log.error("口調プリセットのファイルの形が違うので読みません: %s", path.name)
        return 0
    for name, preset in presets.items():
        PRESETS[name] = dict(preset)
    _ONDO_ALIASES.update(aliases)
    return len(presets)


def _match_preset(text: str) -> str | None:
    """入力(絵文字/空白ゆれ許容・別名可)→ プリセット名。一致しなければ None。"""
    key = text.strip()
    bare = key
    for e in (v["emoji"] for v in PRESETS.values()):
        bare = bare.replace(e, "")
    bare = bare.strip()
    for cand in (key, bare):
        if cand in PRESETS:
            return cand
        if cand in _ONDO_ALIASES:
            return _ONDO_ALIASES[cand]
    return None


def resolve_ondo(text: str | None) -> str | None:
    """/ask の 口調: 入力を解決する。プリセット名なら style を返し、
    そうでなければ自由文をそのままカスタム口調として返す。"""
    if not text:
        return None
    name = _match_preset(text)
    return PRESETS[name]["style"] if name else text  # 一致しなければ自由文カスタム


def ondo_wants_neta(text: str | None) -> bool:
    """その場指定の 口調: がネタ枠か。自由文カスタムでネタは有効にしない
    (ネタ帳は明示的にネタ枠を選んだときだけ載せる)。"""
    if not text:
        return False
    name = _match_preset(text)
    return bool(name and PRESETS[name].get("neta"))


class PersonaStore:
    """data/persona.json: {"active": "off" | "<preset名>" | {"custom": "自由文"}}"""

    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "persona.json"

    def _load(self) -> dict:
        return read_json(self.path, {"active": "off"})

    def active_raw(self):
        return self._load().get("active", "off")

    def active_style(self) -> str | None:
        """現在有効な口調指示(なければ None)。"""
        a = self.active_raw()
        if a == "off" or a is None:
            return None
        if isinstance(a, dict):
            return a.get("custom") or None
        preset = PRESETS.get(a)
        return preset["style"] if preset else None

    def active_neta(self) -> bool:
        """恒久設定がネタ枠か(カスタム自由文では有効にしない)。"""
        a = self.active_raw()
        if not isinstance(a, str) or a == "off":
            return False
        return bool(PRESETS.get(a, {}).get("neta"))

    def describe(self) -> str:
        a = self.active_raw()
        if a == "off" or a is None:
            return "オフ(標準の口調)"
        if isinstance(a, dict):
            return f"カスタム: {a.get('custom', '')[:60]}"
        emoji = PRESETS.get(a, {}).get("emoji", "")
        return f"{emoji} {a}"

    def set_preset(self, name: str) -> None:
        write_json(self.path, {"active": name})

    def set_custom(self, text: str) -> None:
        write_json(self.path, {"active": {"custom": text.strip()}})

    def off(self) -> None:
        write_json(self.path, {"active": "off"})
