"""Inactive bounded HTTPS registration issuer; anonymous factories are injectable.

Verified aiohttp 3.14.3 public signatures support this composition. No session,
network request or credential is created at module import/constructor time.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import re
import secrets
import ssl
import time
from dataclasses import dataclass, field

from iyakusai_dm_sdk.controller import PurposeKey, canonical_bytes

from .bootstrap import AuthenticatedSelfReference
from .member import MAX_SAFE_INTEGER
from .policy import RegistrationScope, checked_registration_scope
from .policy import BOOTSTRAP_USER_ID, FIXED_GUILD_ID, KNOWN_SHARED_ACCOUNT_IDS


ISSUER_ORIGIN = "https://task.iyakusai.com"
ISSUER_PATH = "/v1/registration/issue"
ISSUER_CLIENT = "iyakusai-bot"
_SOURCE = "authenticated_discord_self_interaction"
_MAX_BODY = 2048
_MAX_HEADERS = 48
_REQUEST_NAMES = frozenset({"content-type", "x-svc-client", "x-svc-timestamp", "x-svc-nonce", "x-svc-signature"})


class IssuerUnavailable(Exception):
    """Sanitized refusal: no codes, passwords, keys or HTTP/SDK error text."""


@dataclass(frozen=True)
class IssuerHTTPReply:
    status: int
    raw_headers: tuple = field(repr=False)
    body: bytes = field(repr=False)


def _identifier(value) -> bool:
    return type(value) is str and re.fullmatch(r"[1-9][0-9]{16,19}", value) is not None and int(value) < 2**64


def _clock_ms(clock) -> int:
    now = clock()
    if type(now) not in (int, float) or not math.isfinite(now):
        raise ValueError
    stamp = int(now * 1000)
    if not 10**12 <= stamp < 10**13:
        raise ValueError
    return stamp


def _verified_context(context) -> bool:
    return (isinstance(context, ssl.SSLContext) and context.check_hostname is True
            and context.verify_mode == ssl.CERT_REQUIRED
            and context.minimum_version >= ssl.TLSVersion.TLSv1_2)


def _response_headers(raw) -> dict:
    if type(raw) not in (tuple, list) or len(raw) > _MAX_HEADERS:
        raise ValueError
    result, size = {}, 0
    for pair in raw:
        if type(pair) not in (tuple, list) or len(pair) != 2 or any(type(value) is not bytes for value in pair):
            raise ValueError
        name, value = pair
        if not 1 <= len(name) <= 64 or len(value) > 1024:
            raise ValueError
        lowered = name.decode("ascii").lower()
        decoded = value.decode("ascii")
        if re.fullmatch(r"[a-z0-9!#$%&'*+.^_`|~-]+", lowered) is None or any(ord(char) < 32 or ord(char) > 126 for char in decoded) or lowered in result:
            raise ValueError
        result[lowered] = decoded
        size += len(name) + len(value)
    if size > 16_384:
        raise ValueError
    return result


class AiohttpIssuerTransport:
    """One POST, verified certificate+hostname, no proxy/redirect or retries here.

    aiohttp performs the real TLS handshake with the supplied verified context.
    Neither forwarded headers nor a caller-provided ``tls_verified`` flag is
    consulted. Session/HTTP response resources are owned by this request only;
    the existing Bot client and its SDK HTTP session are never used or closed.
    """
    def __init__(self, *, aiohttp_module, ssl_context, timeout=10, close_timeout=0.25, session_factory=None, origin=ISSUER_ORIGIN):
        valid = (getattr(aiohttp_module, "__version__", None) == "3.14.3"
                 and callable(getattr(aiohttp_module, "ClientTimeout", None))
                 and callable(getattr(aiohttp_module, "ClientSession", None))
                 and _verified_context(ssl_context) and origin == ISSUER_ORIGIN
                 and type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 15
                 and type(close_timeout) in (int, float) and math.isfinite(close_timeout) and 0 < close_timeout <= 0.25
                 and (session_factory is None or callable(session_factory)))
        if not valid:
            raise IssuerUnavailable("registration issuer configuration refused")
        self.aiohttp_module = aiohttp_module
        self.ssl_context = ssl_context
        self.origin = origin
        self.timeout = timeout
        self.close_timeout = close_timeout
        self._session_factory = session_factory or aiohttp_module.ClientSession
        self._operations = set()
        self._closed = False

    async def _close_session(self, session):
        closer = asyncio.create_task(asyncio.wait_for(session.close(), timeout=self.close_timeout))
        try:
            await asyncio.shield(closer)
        except asyncio.CancelledError:
            try:
                await closer
            except Exception:
                pass
            raise

    async def _post(self, raw_headers, body):
        if not _verified_context(self.ssl_context):
            raise ValueError
        if type(body) is not bytes or not 1 <= len(body) <= _MAX_BODY:
            raise ValueError
        if type(raw_headers) is not tuple or len(raw_headers) != len(_REQUEST_NAMES):
            raise ValueError
        headers = {}
        for pair in raw_headers:
            if type(pair) is not tuple or len(pair) != 2 or any(type(value) is not str for value in pair):
                raise ValueError
            name, value = pair
            if name not in _REQUEST_NAMES or name in headers or not value or len(value) > 1024 or any(ord(char) < 32 or ord(char) > 126 for char in value):
                raise ValueError
            headers[name] = value
        if set(headers) != _REQUEST_NAMES or headers["content-type"] != "application/json" or headers["x-svc-client"] != ISSUER_CLIENT:
            raise ValueError
        timeout = self.aiohttp_module.ClientTimeout(total=self.timeout)
        session = self._session_factory(timeout=timeout, trust_env=False, auto_decompress=False, raise_for_status=False,
                                        max_line_size=4096, max_field_size=1024, max_headers=_MAX_HEADERS)
        response = None
        try:
            if not _verified_context(self.ssl_context):
                raise ValueError
            async with session.post(ISSUER_ORIGIN + ISSUER_PATH, data=body, headers=headers,
                                    ssl=self.ssl_context, allow_redirects=False, proxy=None) as response:
                if not _verified_context(self.ssl_context) or type(response.status) is not int:
                    raise ValueError
                response_headers = tuple(response.raw_headers)
                parsed = _response_headers(response_headers)
                if parsed.get("content-encoding", "identity") != "identity":
                    raise ValueError
                length = parsed.get("content-length")
                if length is not None and (re.fullmatch(r"0|[1-9][0-9]{0,4}", length) is None or int(length) > _MAX_BODY):
                    raise ValueError
                chunks, total = [], 0
                while True:
                    chunk = await response.content.read(min(512, _MAX_BODY + 1 - total))
                    if type(chunk) is not bytes:
                        raise ValueError
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > _MAX_BODY:
                        raise ValueError
                if length is not None and total != int(length):
                    raise ValueError
                return IssuerHTTPReply(response.status, response_headers, b"".join(chunks))
        finally:
            # A fresh issuer session is closed even on rejection, cancellation or
            # receive timeout. Closure gets a separate bounded grace period.
            try:
                if response is not None:
                    response.release()
            finally:
                await self._close_session(session)

    async def post(self, *, raw_headers, body):
        reply = None
        operation = None
        try:
            if self._closed:
                raise ValueError
            operation = asyncio.create_task(self._post(raw_headers, body))
            self._operations.add(operation)
            reply = await asyncio.wait_for(operation, timeout=self.timeout)
        except Exception:
            pass
        finally:
            if operation is not None:
                self._operations.discard(operation)
        if reply is None:
            raise IssuerUnavailable("registration issuer unavailable")
        return reply

    async def close(self):
        """Stop only owned issuer operations; idempotent, no SDK logout/close."""
        self._closed = True
        operations = tuple(self._operations)
        for operation in operations:
            operation.cancel()
        if operations:
            await asyncio.wait_for(asyncio.gather(*operations, return_exceptions=True), timeout=self.close_timeout + 0.1)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _nonfinite(_):
    raise ValueError


class RegistrationIssuer:
    def __init__(self, *, signing_key, transport, clock=time.time, nonce_factory=None, max_reference_age=30, registration_scope=None):
        if (type(signing_key) is not PurposeKey or signing_key.purpose != "smm-auth" or len(signing_key.material) != 32
                or type(transport) is not AiohttpIssuerTransport or not callable(clock)
                or nonce_factory is not None and not callable(nonce_factory)
                or type(max_reference_age) not in (int, float) or not math.isfinite(max_reference_age) or not 0 < max_reference_age <= 30):
            raise IssuerUnavailable("registration issuer configuration refused")
        self.registration_scope = checked_registration_scope(registration_scope)
        self._key = signing_key
        self.transport = transport
        self._clock = clock
        self._nonce_factory = nonce_factory or (lambda: secrets.token_urlsafe(18))
        self.max_reference_age = max_reference_age

    @property
    def origin(self):
        return self.transport.origin

    async def issue(self, reference):
        result = None
        try:
            stamp = _clock_ms(self._clock)
            if (type(reference) is not AuthenticatedSelfReference
                    or not self.registration_scope.permits(reference.user_id) or reference.user_id in KNOWN_SHARED_ACCOUNT_IDS
                    or reference.guild_id != FIXED_GUILD_ID
                    or not self.registration_scope.permits_roles(reference.role_ids)
                    or reference.link_id != f"dcg:{FIXED_GUILD_ID}:{reference.user_id}"
                    or type(reference.link_version) is not int or not 1 <= reference.link_version <= MAX_SAFE_INTEGER
                    or type(reference.observed_at) is not int or not 10**12 <= reference.observed_at < 10**13
                    or reference.link_version > reference.observed_at
                    or not 0 <= stamp - reference.observed_at <= self.max_reference_age * 1000
                    or not _identifier(reference.interaction_id)):
                raise ValueError
            nonce = self._nonce_factory()
            if type(nonce) is not str or re.fullmatch(r"[-_A-Za-z0-9]{24,128}", nonce) is None:
                raise ValueError
            body = json.dumps({"guildId": reference.guild_id, "discordUserId": reference.user_id,
                               "source": _SOURCE, "interactionId": reference.interaction_id},
                              ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            canonical = canonical_bytes(client=ISSUER_CLIENT, method="POST", path=ISSUER_PATH,
                                        timestamp=str(stamp), nonce=nonce, actor="", body=body)
            signature = hmac.new(self._key.material, canonical, hashlib.sha256).hexdigest()
            headers = (("content-type", "application/json"), ("x-svc-client", ISSUER_CLIENT),
                       ("x-svc-timestamp", str(stamp)), ("x-svc-nonce", nonce), ("x-svc-signature", signature))
            reply = await self.transport.post(raw_headers=headers, body=body)
            if type(reply) is not IssuerHTTPReply or reply.status != 200 or type(reply.body) is not bytes or not 1 <= len(reply.body) <= _MAX_BODY:
                raise ValueError
            response_headers = _response_headers(reply.raw_headers)
            if response_headers.get("content-type", "").lower() not in {"application/json", "application/json; charset=utf-8"}:
                raise ValueError
            decoded = json.loads(reply.body.decode("utf-8", errors="strict"), object_pairs_hook=_unique_object, parse_constant=_nonfinite)
            if (type(decoded) is not dict or set(decoded) != {"initialLoginId", "deliveryStatus"}
                    or type(decoded["initialLoginId"]) is not str or re.fullmatch(r"iy-[0-9]{8}", decoded["initialLoginId"]) is None
                    or decoded["deliveryStatus"] != "delivered"):
                raise ValueError
            result = dict(decoded)
        except Exception:
            pass
        if result is None:
            raise IssuerUnavailable("registration issuer unavailable")
        return result

    async def __call__(self, reference):
        return await self.issue(reference)

    async def close(self):
        await self.transport.close()

