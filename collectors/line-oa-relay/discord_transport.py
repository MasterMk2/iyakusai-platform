"""Discord REST transport with explicit write enablement and safe errors.

No credential is stored. The caller supplies the existing IyakusaiBot token.
Unknown POST outcomes are never silently retried, even with enforce_nonce.
"""
from dataclasses import dataclass
import hashlib
import json
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from oa_relay import ValidationError

API_ROOT = "https://discord.com/api/v10"


class OutcomeUnknown(RuntimeError):
    def __init__(self):
        super().__init__("discord_result_unknown_requires_readback")


class Rejected(RuntimeError):
    def __init__(self, status: int, retry_after: float | None = None):
        self.status, self.retry_after = status, retry_after
        super().__init__(f"discord_http_{status}")


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes
    headers: dict


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_request(method, path, body, headers) -> Response:
    request = urllib.request.Request(API_ROOT + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as result:
            return Response(result.status, result.read(4 * 1024 * 1024 + 1), dict(result.headers))
    except urllib.error.HTTPError as error:
        return Response(error.code, error.read(4 * 1024 * 1024 + 1), dict(error.headers))


class DiscordAPI:
    def __init__(self, token: str, *, writes_enabled: bool = False, requester=http_request, clock=time.time):
        if not token or "\r" in token or "\n" in token:
            raise ValidationError("existing_bot_token_unavailable")
        self._token = token
        self.writes_enabled, self._requester, self.clock = writes_enabled, requester, clock
        self.retry_not_before = 0.0

    def __repr__(self):
        return f"DiscordAPI(writes_enabled={self.writes_enabled!r})"

    def request(self, method: str, path: str, *, payload=None, attachment=None, media_root=None):
        if method not in {"GET", "POST", "PATCH"} or not re.fullmatch(r"/[A-Za-z0-9_@/?=&.%:-]+", path):
            raise ValidationError("invalid_discord_request")
        if method != "GET" and not self.writes_enabled:
            raise ValidationError("live_writes_disabled")
        if self.clock() < self.retry_not_before:
            raise Rejected(429, self.retry_not_before - self.clock())
        headers = {"Authorization": "Bot " + self._token,
                   "User-Agent": "IyakusaiOfficialLINE/1.0"}
        body = None
        if payload is not None:
            if attachment is not None:
                if media_root is None:
                    raise ValidationError("attachment_store_scope_required")
                body, content_type = multipart(payload, attachment, media_root)
                headers["Content-Type"] = content_type
            else:
                body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
                headers["Content-Type"] = "application/json"
        try:
            result = self._requester(method, path, body, headers)
        except (OSError, TimeoutError, urllib.error.URLError):
            raise OutcomeUnknown() from None
        if len(result.body) > 4 * 1024 * 1024:
            raise OutcomeUnknown()
        if result.status == 429:
            try:
                response = json.loads(result.body)
                after = float(response.get("retry_after", result.headers.get("Retry-After", 1)))
                if not 0 < after <= 86400:
                    after = 60.0
            except (ValueError, TypeError, AttributeError):
                after = 60.0
            self.retry_not_before = self.clock() + after
            raise Rejected(429, after)
        if result.status >= 500 or result.status in {408, 409}:
            raise OutcomeUnknown()
        if not 200 <= result.status < 300:
            raise Rejected(result.status)
        try:
            value = json.loads(result.body)
        except (ValueError, UnicodeDecodeError):
            raise OutcomeUnknown() from None
        if not isinstance(value, (dict, list)):
            raise OutcomeUnknown()
        if method != "GET" and not isinstance(value, dict):
            raise OutcomeUnknown()
        return value

    def get(self, path: str):
        return self.request("GET", path)

    def create_forum_thread(self, forum_id: str, plan, media_root):
        first = plan.parts[0]
        message = first.discord_payload()
        if first.attachment:
            message["attachments"] = [{"id": 0, "filename": first.attachment.name}]
        payload = {"name": plan.thread_name, "auto_archive_duration": 10080, "message": message}
        return self.request("POST", f"/channels/{forum_id}/threads", payload=payload,
                            attachment=first.attachment, media_root=media_root)

    def create_message(self, thread_id: str, plan, part, media_root):
        payload = part.discord_payload()
        # Discord's nonce protection is only a few minutes. Durable intent and
        # positive receipt reconciliation remain necessary after a restart.
        payload.update(nonce=hashlib.sha256(f"{plan.event.identity}:{part.number}".encode()).hexdigest()[:25],
                       enforce_nonce=True)
        if part.attachment:
            payload["attachments"] = [{"id": 0, "filename": part.attachment.name}]
        return self.request("POST", f"/channels/{thread_id}/messages", payload=payload,
                            attachment=part.attachment, media_root=media_root)


def multipart(payload, attachment, media_root):
    root = media_root.resolve(strict=True)
    path = attachment.path.resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValidationError("media_outside_official_store")
    # Read/hash/upload the same byte buffer. No reopen after verification.
    with path.open("rb") as source:
        data = source.read(attachment.size + 1)
    if len(data) != attachment.size or hashlib.sha256(data).hexdigest() != attachment.sha256:
        raise ValidationError("attachment_changed_after_plan")
    name = attachment.name
    if any(c in name for c in ['"', "\r", "\n", "\\", "/"]) or len(data) > 10 * 1024 * 1024:
        raise ValidationError("invalid_upload_filename_or_size")
    boundary = "oa-" + secrets.token_hex(16)
    prefix = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n"
              "Content-Type: application/json\r\n\r\n").encode()
    body = prefix + json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    body += (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; "
             f"filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode()
    body += data + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"
