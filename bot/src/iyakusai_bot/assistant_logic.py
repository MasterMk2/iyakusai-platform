# -*- coding: utf-8 -*-
"""統合アプリ「Bot」タブの入力検査・権限規則・ファイル規則(純ロジック・2026-10-14 追加)。

Discord にも SQLite にも触らない。連携口(gateway)と Bot(assistant_cog)の両方が使うので、
ここに置いた規則は両方で同じに働く。契約 §3-2・§3-4 の値をそのまま書いてある。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from .remind_logic import JST, ParseError, parse_due

ASK_MODELS = ("auto", "sonnet", "opus")          # gemini は選択肢に出さない(未導入)
ASK_EFFORTS = ("auto", "low", "medium", "high", "xhigh")
ASK_FORMATS = ("docx", "md", "txt")
DOC_TYPE_IDS = ("request", "notice", "report", "minutes", "mail", "free")
DOC_FORMATS = ("docx", "md", "txt")
IMAGE_ASPECTS = ("1:1", "16:9", "9:16", "4:3", "3:4")
REMIND_REPEATS = ("none", "daily", "weekly", "monthly")
SCREENING_ACTIONS = ("ok", "ng", "undo", "return")

MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
DOWNLOAD_MIMES = {
    "png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/markdown; charset=utf-8", "txt": "text/plain; charset=utf-8",
}
_EXT_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
             ".docx": DOWNLOAD_MIMES["docx"], ".md": DOWNLOAD_MIMES["md"], ".txt": DOWNLOAD_MIMES["txt"]}

# 制御文字は改行とタブ以外を削る(契約 §3-4)。CR も制御文字なので削る。
_CONTROL_RE = re.compile("[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]")
_CLIENT_OP_RE = re.compile(r"[A-Za-z0-9_.:-]{1,160}\Z")
_SNOWFLAKE_RE = re.compile(r"[1-9][0-9]{16,19}\Z")
_ISO_DUE_RE = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?\Z")
_UNSAFE_NAME_RE = re.compile(r"[\\/\x00-\x1f\x7f]")


class InputError(ValueError):
    """入力の不備。code は HTTP の code(既定 VALIDATION。モデル未対応だけ MODEL_UNAVAILABLE)。"""

    def __init__(self, message: str, code: str = "VALIDATION"):
        super().__init__(message)
        self.message = message
        self.code = code


def clean_text(value, *, field: str, max_len: int, min_len: int = 0, multiline: bool = False,
               optional: bool = False) -> str | None:
    """前後の空白を削り、制御文字を落とし、字数を検査する。optional で空なら None。

    multiline=False のときは改行とタブを空白に変える(1 行の項目。リマインドの内容など)。
    """
    if value is None:
        if optional:
            return None
        value = ""
    if not isinstance(value, str):
        raise InputError(f"{field} は文字列で指定してください")
    text = _CONTROL_RE.sub("", value)
    if not multiline:
        text = text.replace("\n", " ").replace("\t", " ")
    text = text.strip()
    if not text:
        if optional:
            return None
        raise InputError(f"{field} を入力してください")
    if len(text) > max_len:
        raise InputError(f"{field} は{max_len}字以内で入力してください")
    if len(text) < min_len:
        raise InputError(f"{field} を入力してください")
    return text


def _only(payload: dict, allowed: set[str]) -> None:
    if set(payload) - allowed:
        raise InputError("未対応の項目が含まれています")


def _choice(value, allowed, *, field: str, default=None, code: str = "VALIDATION"):
    if value is None:
        return default
    if value not in allowed:
        raise InputError(f"{field} の値が正しくありません", code=code)
    return value


def ask_input(payload: dict, *, gemini: bool) -> dict:
    _only(payload, {"question", "model", "effort", "tone", "format"})
    models = ASK_MODELS + (("gemini",) if gemini else ())
    model = payload.get("model")
    if model == "gemini" and not gemini:
        raise InputError("Gemini はいまの設定では使えません", code="MODEL_UNAVAILABLE")
    return {
        "question": clean_text(payload.get("question"), field="質問", max_len=1000, min_len=1),
        "model": _choice(model, models, field="モデル", default="auto"),
        "effort": _choice(payload.get("effort"), ASK_EFFORTS, field="考える深さ", default="auto"),
        "tone": clean_text(payload.get("tone"), field="口調", max_len=100, optional=True),
        "format": _choice(payload.get("format"), ASK_FORMATS, field="形式", default=None),
    }


def doc_input(payload: dict, *, gemini: bool) -> dict:
    _only(payload, {"docType", "content", "format", "useSources", "model"})
    model = payload.get("model")
    if model == "gemini" and not gemini:
        raise InputError("Gemini はいまの設定では使えません", code="MODEL_UNAVAILABLE")
    use_sources = payload.get("useSources")
    if type(use_sources) is not bool:
        raise InputError("資料参照は true / false で指定してください")
    return {
        "docType": _choice(payload.get("docType"), DOC_TYPE_IDS, field="文書の種類"),
        "content": clean_text(payload.get("content"), field="内容", max_len=2000, min_len=1, multiline=True),
        "format": _choice(payload.get("format"), DOC_FORMATS, field="形式"),
        "useSources": use_sources,
        "model": _choice(model, ASK_MODELS + (("gemini",) if gemini else ()), field="モデル", default="auto"),
    }


def image_input(payload: dict) -> dict:
    _only(payload, {"prompt", "aspect"})
    return {
        "prompt": clean_text(payload.get("prompt"), field="説明", max_len=1000, min_len=1, multiline=True),
        "aspect": _choice(payload.get("aspect"), IMAGE_ASPECTS, field="縦横比", default="1:1"),
    }


def remind_create_input(payload: dict, *, now: datetime | None = None) -> dict:
    _only(payload, {"text", "due", "targetId", "repeat", "channelId"})
    due_text = clean_text(payload.get("due"), field="期限", max_len=40, min_len=1)
    parse_due_input(due_text, now=now)   # 読めない期限は受け付けない(連携口でも 400)
    target = payload.get("targetId")
    channel = payload.get("channelId")
    return {
        "text": clean_text(payload.get("text"), field="内容", max_len=500, min_len=1),
        "due": due_text,
        "targetId": None if target is None else user_id_text(target, field="対象"),
        "repeat": _choice(payload.get("repeat"), REMIND_REPEATS, field="繰り返し", default="none"),
        "channelId": None if channel is None else snowflake_text(channel, field="通知先"),
    }


def screening_input(action: str, payload: dict) -> dict:
    _only(payload, {"comment"})
    if action not in SCREENING_ACTIONS:
        raise InputError("操作の指定が正しくありません", code="VALIDATION")
    comment = clean_text(payload.get("comment"), field="コメント", max_len=1000,
                         multiline=True, optional=action != "return")
    if action == "return" and not comment:
        raise InputError("差し戻しにはコメントが必要です")
    return {"comment": comment}


def client_operation_id(value) -> str:
    if not isinstance(value, str) or not _CLIENT_OP_RE.fullmatch(value):
        raise InputError("clientOperationId の形式が正しくありません")
    return value


def snowflake_text(value, *, field: str = "ID") -> str:
    if not isinstance(value, str) or not _SNOWFLAKE_RE.fullmatch(value):
        raise InputError(f"{field} の形式が正しくありません")
    return value


def user_id_text(value, *, field: str = "ユーザー") -> str:
    """"discord-<ID>" を受け、<ID> の数字だけを返す。"""
    if not isinstance(value, str) or not value.startswith("discord-"):
        raise InputError(f"{field} の形式が正しくありません")
    return snowflake_text(value[len("discord-"):], field=field)


def reminder_id(value) -> int:
    if type(value) is not int or not 1 <= value <= 2**31 - 1:
        raise InputError("リマインドの番号が正しくありません")
    return value


def parse_due_input(text: str, now: datetime | None = None) -> datetime:
    """Discord の /remind と同じ書き方(remind_logic.parse_due)か、ブラウザの ISO(+09:00)を読む。

    ISO で時刻帯が無ければ JST とみなす。読めなければ InputError。
    """
    value = str(text or "").strip()
    if _ISO_DUE_RE.fullmatch(value):
        try:
            parsed = datetime.fromisoformat(value.replace(" ", "T").replace("Z", "+00:00"))
        except ValueError as error:
            raise InputError("期限の形式が読めません") from error
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=JST)
    try:
        return parse_due(value, now)
    except ParseError as error:
        raise InputError(str(error)) from error


def may_complete(actor_id: int, is_admin: bool, rem: dict) -> bool:
    """完了できるのは登録者・催促対象・役員(manage_guild)。reminders.py の /remind done と同じ規則。"""
    return bool(is_admin or actor_id == rem.get("creator_id") or actor_id == rem.get("target_id"))


def may_delete(actor_id: int, is_admin: bool, rem: dict) -> bool:
    """削除できるのは登録者・役員(manage_guild)。reminders.py の /remind delete と同じ規則。"""
    return bool(is_admin or actor_id == rem.get("creator_id"))


def sniff_image_mime(data: bytes) -> str | None:
    """先頭のバイト列で画像の種類を判定する(PNG・JPEG・WebP のみ)。それ以外は None。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def mime_for_name(name: str) -> str | None:
    lowered = str(name or "").lower()
    for ext, mime in _EXT_MIME.items():
        if lowered.endswith(ext):
            return mime
    return None


def is_downloadable(mime: str | None) -> bool:
    """配ってよい型か(契約 §4: png/jpeg/webp/docx/md/txt だけ)。"""
    base = str(mime or "").split(";")[0].strip().lower()
    return base in {m.split(";")[0] for m in DOWNLOAD_MIMES.values()}


def safe_file_name(name: str, fallback: str = "出力") -> str:
    """保存名にする。フォルダの区切り・制御文字を落とし、長さを 120 字に切る。"""
    # 先に末尾の名前だけを取る(区切りを消してから取ると ../../x が ....x になって残る)
    base = str(name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = _UNSAFE_NAME_RE.sub("", base).strip().strip(".")
    if not base:
        base = fallback
    return base[:120]


def utc_to_jst_iso(when: datetime) -> str:
    """表示用の ISO(+09:00)。"""
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(JST).isoformat(timespec="seconds")


def jst_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    """now を含む JST の日の [0:00, 翌0:00)。"""
    local = now.astimezone(JST)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)
