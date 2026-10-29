# -*- coding: utf-8 -*-
"""不具合・要望の連絡先(保守担当が決まるまでの暫定)。

名前はコードに書かず、config.toml の [help] contact に置く(未設定なら DEFAULT)。
起動時に bot.setup_hook が set_contact を呼ぶ。/help のフッター・エラー文はここから読む
(使い方ガイド_委員向け.md の冒頭・FAQ / 運用保守ガイド冒頭の📣 と同時に直すこと)。
"""

DEFAULT = "システム課"
_name = DEFAULT


def set_contact(name: str | None) -> None:
    global _name
    _name = (name or "").strip() or DEFAULT


def name() -> str:
    return _name


def ask_note(prefix: str = "") -> str:
    """エラー文の末尾に添える「(続くようなら◯◯へ)。」。prefix は括弧の中の前置き。"""
    return f"({prefix}続くようなら{_name}へ)。"
