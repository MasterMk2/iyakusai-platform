# -*- coding: utf-8 -*-
"""Discord の #公式line転送 のスレッドから公式LINE へ返信する(/line返信)の純ロジック。2026-11-02

Bot はアプリの内部の口(取り決め C)を呼ぶだけ。権限・月の上限・送信記録・LINE のトークンは
**すべてアプリが持つ**(Bot は通数を数えない)。流れ:

1. `/line返信 本文:…` をフォーラムのスレッドの中で受ける → `POST /internal/line/discord/preview`
2. 本人にだけ見える確認(宛先・本文・通数・「すぐ届き取り消せない」)とボタン「送信する」「やめる」
3. 「送信する」→ `POST /internal/line/discord/send` → スレッドに本文つきの記録を 1 件(メンション抑止)

このモジュールは discord に依存しない(要求の組み立て・応答の解釈・表示文・設定・HTTP)。
Discord の部分は line_reply_cog.py。鍵の中身・本文はログに出さない。
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

PREVIEW_PATH = "/internal/line/discord/preview"
SEND_PATH = "/internal/line/discord/send"
TEXT_MAX = 5000                     # 取り決め C-1 の本文の上限(字)
DEFAULT_TIMEOUT_SEC = 15            # 取り決め C-3: 応答の待ち時間は 15 秒まで
MAX_RESPONSE_BYTES = 64 * 1024
MESSAGE_LIMIT = 2000                # Discord の 1 メッセージの上限
APP_MESSAGE_MAX = 600               # アプリの message をそのまま見せるときの上限
CONSENT_TTL = timedelta(minutes=5)  # expiresAt が読めないときの既定(アプリの確認の有効期限)
JST = timezone(timedelta(hours=9))

NOT_CONFIGURED = "この機能は設定されていません。"
WRONG_PLACE = ("このコマンドは #公式line転送 のフォーラムの、団体ごとのスレッドの中でだけ使えます。"
               "返信したい団体のスレッドを開いてから使ってください。")
IRREVOCABLE = "⚠️ 送るとすぐ相手の LINE に届き、取り消せません。"

# custom_id = "lnr:<send|stop>:<Discord のユーザー ID>:<consentId>"(Discord の上限 100 文字に収める)
CONSENT_ID = re.compile(r"[A-Za-z0-9._~-]{1,64}")
CUSTOM_ID_TEMPLATE = r"lnr:(?P<action>send|stop):(?P<uid>[0-9]{15,20}):(?P<cid>[A-Za-z0-9._~-]{1,64})"
_KEY = re.compile(r"[A-Za-z0-9._~+/=-]{32,512}")
# http を許す私設の網(RFC 1918 と IPv6 の ULA)。Docker の内部の網はこの中にある
_INTERNAL_NETWORKS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))

ERROR_TEXT = {
    "unknown_thread": "このスレッドは公式LINE の相手と結び付いていません(転送の対応表にありません)。",
    "unknown_member": "アプリに委員として登録された Discord アカウントではないため送れません(臨時スタッフは送れません)。",
    "forbidden": "公式LINE を送る権限がありません。",
    "quota": "今月の送信の上限に達しているため送れません。",
    "invalid": f"本文が送れない形です(1〜{TEXT_MAX} 字)。",
    "unavailable": "いま公式LINE に送れません。時間をおいてもう一度試してください。",
    "expired": "確認の期限(5 分)が切れたか、もう使われています。送り直すときは、もう一度 /line返信 から。",
    "unauthorized": "Bot とアプリの鍵が合いません。システム担当に連絡してください(送っていません)。",
    "disabled": "アプリ側でこの機能が有効になっていません。システム担当に連絡してください(送っていません)。",
    "bad_response": "アプリの応答が読めませんでした(送っていません)。",
    "bad_send_response": "アプリの応答が読めませんでした。",
}


class LineReplyConfigError(ValueError):
    """[line_reply] の設定が使えない。message に鍵の中身・パスは含めない。"""


class LineReplyInputError(ValueError):
    """本文が送れない形。message は本人に見せてよい文。"""


class LineReplyTransportError(RuntimeError):
    """アプリに届かない・応答が読めない(タイムアウトを含む)。"""


# ---------------------------------------------------------------------------
# 設定

@dataclass(frozen=True)
class LineReplySettings:
    """[line_reply]。app_url・key_file・forum_channel_id のどれかが無ければ未設定(configured=False)。"""
    app_url: str = ""
    key_file: Path | None = None
    forum_channel_id: int | None = None
    timeout_sec: int = DEFAULT_TIMEOUT_SEC

    _KEYS = frozenset({"app_url", "key_file", "forum_channel_id", "timeout_sec"})

    @property
    def configured(self) -> bool:
        return bool(self.app_url and self.key_file and self.forum_channel_id)

    @classmethod
    def from_mapping(cls, raw) -> "LineReplySettings":
        if raw is None:
            return cls()
        if not isinstance(raw, dict):
            raise LineReplyConfigError("line_reply: [line_reply] の形式が正しくありません")
        unknown = set(raw) - cls._KEYS
        if unknown:
            raise LineReplyConfigError(f"line_reply: 未知の設定項目があります: {', '.join(sorted(unknown))}")
        timeout = raw.get("timeout_sec", DEFAULT_TIMEOUT_SEC)
        if type(timeout) is not int or not 1 <= timeout <= DEFAULT_TIMEOUT_SEC:
            raise LineReplyConfigError(f"line_reply: timeout_sec は 1〜{DEFAULT_TIMEOUT_SEC} の整数で指定してください")
        url = raw.get("app_url")
        key = raw.get("key_file")
        forum = raw.get("forum_channel_id")
        if url in (None, "") or key in (None, "") or forum in (None, 0, ""):
            return cls(timeout_sec=timeout)          # どれかが無い = 未設定(Bot は止めない)
        if not isinstance(url, str) or not url_ok(url.strip().rstrip("/")):
            raise LineReplyConfigError(
                "line_reply: app_url は http(s) のオリジン(パスなし)で指定してください。"
                "http は内部の網(ループバック・ドットの無いホスト名・私設 IP)だけ")
        if not isinstance(key, str) or not Path(key.strip()).expanduser().is_absolute():
            raise LineReplyConfigError("line_reply: key_file は絶対パスで指定してください")
        if type(forum) is not int or not 1 <= forum < 2**63:
            raise LineReplyConfigError("line_reply: forum_channel_id は Discord のチャンネル ID(整数)で指定してください")
        return cls(app_url=url.strip().rstrip("/"), key_file=Path(key.strip()).expanduser(),
                   forum_channel_id=forum, timeout_sec=timeout)


def url_ok(url: str) -> bool:
    """https のオリジンか、内部の網の http のオリジン。鍵(Bearer)を外へ平文で出さない。"""
    m = re.fullmatch(r"(https?)://([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?", url)
    if not m or (m.group(3) and not 1 <= int(m.group(3)) <= 65535):
        return False
    scheme, host = m.group(1), m.group(2)
    if scheme == "https":
        return True
    if host == "localhost" or "." not in host and not host.startswith("["):
        return True                                  # Docker の内部の網のサービス名など
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return address.is_loopback or any(address in network for network in _INTERNAL_NETWORKS)


def load_key(path: Path) -> str:
    """鍵ファイルを読む。権限が広い・読めない・形式違反は LineReplyConfigError(中身は出さない)。"""
    try:
        st = path.stat()
        if os.name != "nt" and (st.st_mode & 0o077):
            raise LineReplyConfigError("line_reply: key_file は所有者だけが読める権限(600 など)にしてください")
        text = path.read_text(encoding="ascii").strip()
    except LineReplyConfigError:
        raise
    except (OSError, UnicodeDecodeError):
        raise LineReplyConfigError("line_reply: key_file を読み込めません") from None
    if not _KEY.fullmatch(text):
        raise LineReplyConfigError("line_reply: key_file の鍵は 32〜512 文字の英数字・記号(空白なし)にしてください")
    return text


# ---------------------------------------------------------------------------
# 本文と要求

def normalize_text(raw: str) -> str:
    """スラッシュコマンドの入力は 1 行なので、`\\n` を改行として扱う。1〜5000 字。"""
    text = (raw or "").replace("\r\n", "\n").replace("\\n", "\n")
    if not text.strip():
        raise LineReplyInputError("⚠️ 本文が空です。送る文を入力してください。")
    if len(text) > TEXT_MAX:
        raise LineReplyInputError(f"⚠️ 本文が長すぎます({len(text)} 字)。{TEXT_MAX} 字以内にしてください。")
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in text):
        raise LineReplyInputError("⚠️ 制御文字を含む本文は送れません。")
    return text


def in_reply_forum(is_thread: bool, parent_id: int | None, forum_id: int | None) -> bool:
    return bool(is_thread and forum_id and parent_id == forum_id)


def preview_request(thread_id: int, discord_user_id: int, text: str) -> dict:
    return {"threadId": str(thread_id), "discordUserId": str(discord_user_id), "text": text}


def send_request(consent_id: str, discord_user_id: int) -> dict:
    return {"consentId": consent_id, "discordUserId": str(discord_user_id)}


def custom_id(action: str, user_id: int, consent_id: str) -> str:
    value = f"lnr:{action}:{user_id}:{consent_id}"
    if action not in ("send", "stop") or not re.fullmatch(CUSTOM_ID_TEMPLATE, value) or len(value) > 100:
        raise ValueError("custom_id")
    return value


# ---------------------------------------------------------------------------
# 応答の解釈

@dataclass(frozen=True)
class Failure:
    code: str
    message: str


@dataclass(frozen=True)
class Preview:
    consent_id: str
    expires_at: datetime
    org_name: str
    recipients: int
    message: str


@dataclass(frozen=True)
class SendResult:
    status: str          # accepted / failed_retryable / unknown / needs_review
    status_label: str
    message: str

    @property
    def accepted(self) -> bool:
        return self.status == "accepted"


def _app_message(data, fallback: str) -> str:
    message = data.get("message") if isinstance(data, dict) else None
    if isinstance(message, str) and message.strip():
        return clip(message.strip(), APP_MESSAGE_MAX)
    return fallback


def _failure(status: int, data) -> Failure:
    if status == 401:
        return Failure("unauthorized", ERROR_TEXT["unauthorized"])
    code = data.get("code") if isinstance(data, dict) else None
    if status == 404 and code is None:
        return Failure("disabled", ERROR_TEXT["disabled"])
    if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,40}", code):
        code = "unavailable" if status >= 500 or status in (408, 429) else "bad_response"
    return Failure(code, _app_message(data, ERROR_TEXT.get(code, ERROR_TEXT["unavailable"])))


def parse_preview(status: int, data, *, now: datetime | None = None) -> Preview | Failure:
    if status != 200 or not isinstance(data, dict) or data.get("ok") is not True:
        return _failure(status, data)
    consent = data.get("consentId")
    org = data.get("orgName")
    recipients = data.get("recipients", 1)
    if (not isinstance(consent, str) or not CONSENT_ID.fullmatch(consent)
            or not isinstance(org, str) or not org.strip()
            or type(recipients) is not int or recipients < 1):
        return Failure("bad_response", ERROR_TEXT["bad_response"])
    now = now or datetime.now(timezone.utc)
    expires = now + CONSENT_TTL
    raw_expires = data.get("expiresAt")
    if isinstance(raw_expires, str):
        try:
            parsed = datetime.fromisoformat(raw_expires.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                expires = min(parsed, expires)       # Bot の側でアプリより長くは待たない
        except ValueError:
            pass
    fallback = f"{org.strip()} に {recipients} 通送ります。"
    return Preview(consent, expires, org.strip(), recipients, _app_message(data, fallback))


SEND_STATUSES = {"accepted", "failed_retryable", "unknown", "needs_review"}
STATUS_FALLBACK = {
    "accepted": "受付済み",
    "failed_retryable": "送信失敗(再送できます)",
    "unknown": "結果不明",
    "needs_review": "要確認",
}


def parse_send(status: int, data) -> SendResult | Failure:
    if status != 200 or not isinstance(data, dict) or data.get("ok") is not True:
        code = data.get("code") if isinstance(data, dict) else None
        if status == 200 or (status >= 500 and not isinstance(code, str)):
            # 200 なのに ok でない・理由の無い 5xx は、送ったかどうか分からない
            return SendResult("unknown", STATUS_FALLBACK["unknown"], ERROR_TEXT["bad_send_response"])
        return _failure(status, data)
    result = data.get("status")
    if result not in SEND_STATUSES:
        result = "unknown"
    label = data.get("statusLabel")
    label = clip(label.strip(), 40) if isinstance(label, str) and label.strip() else STATUS_FALLBACK[result]
    return SendResult(result, label, _app_message(data, label))


# ---------------------------------------------------------------------------
# 表示文

def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def quote(text: str) -> str:
    return "\n".join("> " + line if line else ">" for line in text.split("\n"))


def escape_name(name: str) -> str:
    return re.sub(r"([\\*_~`|>#\[\]()<@])", r"\\\1", (name or "").strip() or "(名前不明)")


def confirm_text(preview: Preview, text: str) -> tuple[str, bool]:
    """本人にだけ見せる確認。戻り値の bool は「本文が長いので全文をファイルで添える」。"""
    deadline = preview.expires_at.astimezone(JST).strftime("%H:%M")
    head = [
        "**公式LINE への送信の確認**(あなたにだけ見えています)",
        f"宛先: **{escape_name(preview.org_name)}**({preview.recipients} 通)",
        preview.message,
        "本文:",
    ]
    tail = [IRREVOCABLE, f"よければ「送信する」、やめるなら「やめる」。確認は {deadline} まで有効です。"]
    fixed = len("\n".join(head + tail)) + 2
    body = quote(text)
    attach = False
    if fixed + len(body) > MESSAGE_LIMIT:
        note = f"\n(長いので先頭だけ表示しています。全文 {len(text)} 字を添付の本文.txt で確認してください)"
        body = clip(quote(text), MESSAGE_LIMIT - fixed - len(note)) + note
        attach = True
    return "\n".join(head + [body] + tail), attach


def record_text(display_name: str, text: str) -> tuple[str, bool]:
    """スレッドに残す送信の記録(全員に見える)。bool は「全文をファイルで添える」。"""
    head = f"📤 {escape_name(display_name)} が公式LINE で送信：\n"
    body = quote(text)
    if len(head) + len(body) <= MESSAGE_LIMIT:
        return head + body, False
    note = f"\n(全文 {len(text)} 字は添付の本文.txt)"
    return head + clip(body, MESSAGE_LIMIT - len(head) - len(note)) + note, True


def failure_text(failure: Failure) -> str:
    return f"⚠️ {failure.message}"


def send_result_text(result: SendResult) -> str:
    if result.accepted:
        return f"✅ {result.message}"
    if result.status == "unknown":
        return (f"❓ {result.status_label}: {result.message}\n"
                "届いたかどうか分かりません。二重に送らないよう、アプリの送信記録を確かめてから送り直してください。")
    return f"⚠️ {result.status_label}: {result.message}\nアプリの送信記録で状態を確かめてください。"


TRANSPORT_PREVIEW = "⚠️ アプリに届きませんでした(送っていません)。時間をおいてもう一度試してください。"
TRANSPORT_SEND = ("❓ アプリの応答がありませんでした。届いたかどうか分かりません。"
                  "二重に送らないよう、アプリの送信記録を確かめてから送り直してください。")
STOPPED = "やめました。公式LINE には送っていません。"
NOT_YOURS = "⚠️ これはほかの人の確認です。押せるのは /line返信 を使った本人だけです。"
STALE = ("⚠️ この確認はもう使えません(送信済み・取り消し済み・期限切れ・Bot の再起動のどれか)。"
         "この操作では何も送っていません。送るときは、もう一度 /line返信 から。")
SENDING = "送信しています…"
RECORD_FAILED = "\n(スレッドへの記録の投稿に失敗しました。送信そのものは上のとおりです)"


# ---------------------------------------------------------------------------
# HTTP(同期。Cog から asyncio.to_thread で呼ぶ)

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """転送には従わない(鍵の付いた要求を別の宛先へ持っていかせない)。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def _decode(raw: bytes):
    if len(raw) > MAX_RESPONSE_BYTES:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def call_app(settings: LineReplySettings, key: str, path: str, payload: dict, *, opener=None) -> tuple[int, object]:
    """アプリの内部の口に POST する。(HTTP の状態, JSON か None)。届かないときは LineReplyTransportError。"""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(settings.app_url + path, data=body, method="POST", headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
    })
    if opener is None:
        # 内部の網なので環境変数のプロキシは使わない
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=settings.timeout_sec) as response:
            return response.status, _decode(response.read(MAX_RESPONSE_BYTES + 1))
    except urllib.error.HTTPError as error:
        try:
            raw = error.read(MAX_RESPONSE_BYTES + 1) if error.fp is not None else b""
        except (OSError, http.client.HTTPException):
            raw = b""
        return error.code, _decode(raw)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
        raise LineReplyTransportError(type(error).__name__) from None
