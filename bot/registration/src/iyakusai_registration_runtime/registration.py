"""Strict Discord-only initial-registration wire and existing-client SDK renderer."""
from __future__ import annotations

import datetime as dt
import json
import math
import re
from urllib.parse import urlsplit

from iyakusai_dm_sdk.sdk_transport import DiscordSDKTransport, _safe_label


from .policy import FIXED_GUILD_ID as GUILD_ID
_TOP_KEYS = frozenset({"kind", "deliveryId", "template", "purpose", "audience",
                       "recipient", "code", "expiresAt", "context"})
_RECIPIENT_KEYS = frozenset({"discordUserId", "linkId", "linkVersion"})
_CONTEXT_KEYS = frozenset({"serviceLabel", "requestedAt", "initialLoginId", "registrationUrl"})


def _registration_url(origin):
    if (type(origin) is not str or not origin
            or any(ord(c) <= 32 or ord(c) == 127 for c in origin)):
        raise ValueError("invalid origin")
    try:
        parsed = urlsplit(origin)
        if (parsed.scheme != "https" or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment
                or parsed.geturl() != origin
                or parsed.port is not None and not 1 <= parsed.port <= 65535):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("invalid origin") from None
    return origin + "/register"


def _timestamp(value):
    if type(value) is not str or not 1 <= len(value) <= 64:
        raise ValueError("invalid time")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        stamp = parsed.timestamp()
        if not math.isfinite(stamp):
            raise ValueError()
        return stamp
    except (ValueError, TypeError, OverflowError, OSError):
        raise ValueError("invalid time") from None


def validate_registration(envelope, origin, now):
    """Return canonical anonymous JSON bytes; never normalize a legacy envelope."""
    url = _registration_url(origin)
    if type(now) not in {int, float} or not math.isfinite(now):
        raise ValueError("invalid clock")
    if type(envelope) is not dict or set(envelope) != _TOP_KEYS:
        raise ValueError("invalid envelope")
    if (envelope["kind"] != "registration_code"
            or envelope["template"] != "password_setup_code_v2"
            or envelope["purpose"] != "password_setup"
            or envelope["audience"] != origin):
        raise ValueError("invalid registration purpose")
    if (type(envelope["deliveryId"]) is not str
            or re.fullmatch(r"dl_[0-9a-f]{32}", envelope["deliveryId"]) is None):
        raise ValueError("invalid delivery id")
    recipient = envelope["recipient"]
    if type(recipient) is not dict or set(recipient) != _RECIPIENT_KEYS:
        raise ValueError("invalid recipient")
    user_id = recipient["discordUserId"]
    if (type(user_id) is not str or re.fullmatch(r"[1-9][0-9]{16,19}", user_id) is None
            or int(user_id) >= 2 ** 64):
        raise ValueError("invalid recipient")
    if (type(recipient["linkId"]) is not str
            or recipient["linkId"] != "dcg:" + GUILD_ID + ":" + user_id
            or type(recipient["linkVersion"]) is not int
            or not 1 <= recipient["linkVersion"] <= 2 ** 53 - 1):
        raise ValueError("invalid recipient")
    if (type(envelope["code"]) is not str
            or re.fullmatch(r"[0-9]{8}", envelope["code"]) is None):
        raise ValueError("invalid registration code")
    context = envelope["context"]
    if type(context) is not dict or set(context) != _CONTEXT_KEYS:
        raise ValueError("invalid registration context")
    if (type(context["serviceLabel"]) is not str or not _safe_label(context["serviceLabel"])
            or type(context["initialLoginId"]) is not str
            or re.fullmatch(r"iy-[0-9]{8}", context["initialLoginId"]) is None
            or type(context["registrationUrl"]) is not str or context["registrationUrl"] != url):
        raise ValueError("invalid registration context")
    requested = _timestamp(context["requestedAt"])
    expires = _timestamp(envelope["expiresAt"])
    if abs(now - requested) > 30 or not now < expires <= now + 300:
        raise ValueError("invalid time")
    encoded = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(encoded) > 4096:
        raise ValueError("oversize envelope")
    return encoded


validate = validate_registration


class RegistrationSDKTransport(DiscordSDKTransport):
    """Inherit SDK identity/private-DM/one-send checks; replace only wire and text."""
    def _snapshot(self, envelope):
        encoded = validate_registration(envelope, self.origin, self.clock())
        result = json.loads(encoded)
        if result["context"]["serviceLabel"] != self.service_label:
            raise ValueError("invalid registration context")
        return result

    def _render(self, envelope):
        expires = dt.datetime.fromisoformat(envelope["expiresAt"].replace("Z", "+00:00"))
        return (f"{self.service_label} の初回登録\n"
                f"初回登録用ID：{envelope['context']['initialLoginId']}\n"
                f"初回登録URL：{envelope['context']['registrationUrl']}\n"
                f"初回登録コード：{envelope['code']}（1回限り）\n"
                f"有効期限：{expires.astimezone(dt.timezone.utc).isoformat()}\n"
                "ご自身で初回登録を要求した場合だけ入力してください。\n"
                "コードを他の人へ共有しないでください。心当たりがない場合は管理者に連絡してください。")
