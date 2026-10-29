"""Inactive Discord registration HTTPS composition. No Bot login or automatic hook.

All live resources/providers must be supplied by the authorized owner. Construction
does not create a ledger, listener, task, credential or TLS context.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hmac
import ipaddress
import ssl

from iyakusai_dm_sdk.controller import LedgerReplayGuard, PurposeKey, Reply
from .controller import make_auth_controller
from .member import FreshGuildMemberVerifier, FIXED_GUILD_ID
from .policy import RegistrationScope, checked_registration_scope
from .policy import BOOTSTRAP_USER_ID, KNOWN_SHARED_ACCOUNT_IDS
from .site import SITE


MEMBER_PATH = "/v1/discord/member"
REGISTRATION_PATH = "/v1/dm/registration-code"
ALLOWED_PATHS = frozenset({MEMBER_PATH, REGISTRATION_PATH})


class RuntimeFailure(RuntimeError):
    pass


class RuntimeDisabled(RuntimeFailure):
    pass


@dataclass(frozen=True)
class RuntimeSettings:
    host: str = SITE.listen_host
    port: int = SITE.listen_port
    caller_ip: str = SITE.caller_ip
    receive_timeout: float = 5
    shutdown_timeout: float = 15
    max_active: int = 4
    max_chunks: int = 64
    backlog: int = 16
    delivery_timeout: float = 5
    provider_timeout: float = 2
    dispatch_timeout: float = 15

    def __post_init__(self):
        # This proposed endpoint has not been approved. No wildcard/public bind.
        if (self.host != SITE.listen_host or type(self.port) is not int
                or self.port != SITE.listen_port or self.caller_ip != SITE.caller_ip):
            raise ValueError("endpoint outside candidate scope")
        for value, upper in ((self.receive_timeout, 10), (self.shutdown_timeout, 30),
                             (self.delivery_timeout, 5), (self.provider_timeout, 2),
                             (self.dispatch_timeout, 15)):
            if type(value) not in {int, float} or not 0 < value <= upper:
                raise ValueError("invalid runtime deadline")
        for value, upper in ((self.max_active, 32), (self.max_chunks, 128), (self.backlog, 32)):
            if type(value) is not int or not 1 <= value <= upper:
                raise ValueError("invalid runtime bound")


def _check_tls_context(context):
    if (not isinstance(context, ssl.SSLContext)
            or context.protocol != ssl.PROTOCOL_TLS_SERVER
            or context.minimum_version < ssl.TLSVersion.TLSv1_2):
        raise ValueError("verified server TLS context required")


class TransportVerifier:
    """Read actual TLS and socket metadata only; no request/forwarded claims.

    Server certificate loading and the caller's certificate/CA verification are
    separate authorized operations. Peer IP plus request HMAC is not mutual TLS.
    """
    def __init__(self, settings, tls_context):
        _check_tls_context(tls_context)
        self.settings, self.context = settings, tls_context

    async def __call__(self, transport):
        try:
            if transport is None or transport.is_closing() is not False:
                return False
            tls = transport.get_extra_info("ssl_object")
            peer = transport.get_extra_info("peername")
            local = transport.get_extra_info("sockname")
            if (not isinstance(tls, (ssl.SSLObject, ssl.SSLSocket))
                    or tls.server_side is not True or tls.context is not self.context
                    or tls.version() not in {"TLSv1.2", "TLSv1.3"}):
                return False
            cipher = tls.cipher()
            if (type(cipher) is not tuple or len(cipher) != 3
                    or type(cipher[0]) is not str or not cipher[0]
                    or type(cipher[2]) is not int or cipher[2] < 128):
                return False
            if (type(peer) is not tuple or len(peer) != 2
                    or type(local) is not tuple or len(local) != 2
                    or type(peer[1]) is not int or not 1 <= peer[1] <= 65535
                    or type(local[1]) is not int or local[1] != self.settings.port):
                return False
            return (str(ipaddress.ip_address(peer[0])) == self.settings.caller_ip
                    and str(ipaddress.ip_address(local[0])) == self.settings.host)
        except Exception:
            return False


class AiohttpHTTPSAdapter:
    """Bounded raw HTTP seam. The separately injected server owns socket lifecycle."""
    def __init__(self, controller, verifier, settings):
        if not callable(verifier):
            raise ValueError("transport verifier required")
        self.controller, self.verifier, self.settings = controller, verifier, settings
        self._closing = False
        self._active = {}

    def begin_shutdown(self):
        self._closing = True

    async def drain(self):
        self.begin_shutdown()
        current = asyncio.current_task()
        tasks = {task for task in self._active if not task.done()}
        if current in tasks:
            raise RuntimeFailure("shutdown cannot run inside a request")
        # Reading has not reached Core/reservation/SDK; cancel it immediately.
        for task in tasks:
            if self._active.get(task) == "reading":
                task.cancel()
        if not tasks:
            return
        _, pending = await asyncio.wait(tasks, timeout=self.settings.shutdown_timeout)
        for task in pending:
            task.cancel()
        if pending:
            _, pending = await asyncio.wait(pending, timeout=1)
        if pending:
            # The owner retains the open ledger while cancellation is incomplete.
            raise RuntimeFailure("shutdown incomplete")

    async def handle(self, request):
        if self._closing or len(self._active) >= self.settings.max_active:
            return Reply(503, {"error": "unavailable"})
        task = asyncio.current_task()
        if task in self._active:
            return Reply(503, {"error": "unavailable"})
        self._active[task] = "reading"
        try:
            return await self._handle(request, task)
        except asyncio.CancelledError:
            raise
        except Exception:
            return Reply(503, {"error": "unavailable"})
        finally:
            self._active.pop(task, None)

    async def _handle(self, request, task):
        if request.method != "POST":
            return Reply(405, {"error": "method_not_allowed"})
        if request.raw_path not in ALLOWED_PATHS:
            return Reply(404, {"error": "not_found"})
        if await self.verifier(request.transport) is not True:
            return Reply(403, {"error": "transport_unverified"})
        try:
            raw = request.raw_headers
            if type(raw) not in {list, tuple} or len(raw) > 48:
                raise ValueError()
            headers, total = [], 0
            for name, value in raw:
                if type(name) is not bytes or type(value) is not bytes:
                    raise ValueError()
                total += len(name) + len(value)
                if len(name) > 64 or len(value) > 1024 or total > 16_384:
                    raise ValueError()
                headers.append((name.decode("ascii"), value.decode("ascii")))
        except (ValueError, TypeError, UnicodeError):
            return Reply(400, {"error": "invalid_headers"})
        # Preserve raw duplicate evidence; the signed controller validates it.
        for name, value in headers:
            if name.lower() == "transfer-encoding":
                return Reply(400, {"error": "invalid_framing"})
            if name.lower() == "content-encoding":
                return Reply(415, {"error": "unsupported_media_type"})
            if name.lower() == "expect":
                return Reply(417, {"error": "expectation_failed"})
            if name.lower() == "content-length":
                if not value.isascii() or not value.isdecimal():
                    return Reply(400, {"error": "invalid_framing"})
                if int(value) > 4096:
                    return Reply(413, {"error": "body_too_large"})
        body = bytearray()
        deadline = asyncio.get_running_loop().time() + self.settings.receive_timeout
        for _ in range(self.settings.max_chunks):
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return Reply(408, {"error": "request_timeout"})
            try:
                chunk = await asyncio.wait_for(request.content.read(min(1024, 4097 - len(body))),
                                               timeout=remaining)
            except asyncio.TimeoutError:
                return Reply(408, {"error": "request_timeout"})
            if type(chunk) is not bytes:
                return Reply(400, {"error": "invalid_request"})
            if not chunk:
                self._active[task] = "dispatching"
                try:
                    return await asyncio.wait_for(
                        self.controller.handle(method=request.method, path=request.raw_path,
                                               headers=headers, body=bytes(body),
                                               connection=request.transport),
                        timeout=self.settings.dispatch_timeout)
                except asyncio.TimeoutError:
                    # Ambiguous delivery has no success ACK. Core retains its claim.
                    return Reply(503, {"error": "unavailable"})
            body.extend(chunk)
            if len(body) > 4096:
                return Reply(413, {"error": "body_too_large"})
        return Reply(400, {"error": "invalid_request"})


class BotDMRuntime:
    """Explicit start/stop on the existing Bot loop, without another SDK client.

    ledger_factory creates only an owner-approved dedicated DM ledger at start.
    Keys/TLS/context/providers are already supplied; there are no default paths,
    identity bindings, key readers or allow-all verifiers here. The fixed Guild
    verifier must be supplied explicitly and bound to this exact client and SDK.
    """
    def __init__(self, *, client, sdk, ledger_factory, signing_key, fingerprint_key,
                 origin, service_label, member_provider, bootstrap_user_id,
                 tls_context, settings=None,
                 server_factory=None, registration_scope=None):
        if not callable(ledger_factory) or client is None or sdk is None:
            raise ValueError("existing client and dedicated ledger factory required")
        if type(origin) is not str or not origin or type(service_label) is not str or not service_label:
            raise ValueError("configured exact audience and service label required")
        if type(bootstrap_user_id) is not str or bootstrap_user_id != BOOTSTRAP_USER_ID:
            raise ValueError("explicit verified bootstrap recipient required")
        if (not isinstance(signing_key, PurposeKey) or signing_key.purpose != "smm-auth"
                or not isinstance(fingerprint_key, PurposeKey)
                or fingerprint_key.purpose != "dm-fingerprint"
                or hmac.compare_digest(signing_key.material, fingerprint_key.material)):
            raise ValueError("separate purpose keys required")
        self.settings = settings or RuntimeSettings()
        self.verifier = TransportVerifier(self.settings, tls_context)
        self.client, self.sdk, self.ledger_factory = client, sdk, ledger_factory
        self.signing_key, self.fingerprint_key = signing_key, fingerprint_key
        self.origin, self.service_label = origin, service_label
        self.member_provider, self.tls_context = member_provider, tls_context
        self.registration_scope = checked_registration_scope(registration_scope)
        self.bootstrap_user_id = bootstrap_user_id
        self._check_member_provider()
        self.server_factory = server_factory
        self._ledger = self._server = self._adapter = None
        self._loop = None
        self._lock = asyncio.Lock()
        self._state = "stopped"

    @property
    def state(self):
        return self._state

    def _check_member_provider(self):
        # Do not replace a real fresh provider with a generic callable/default
        # allow. Exclude subclasses that could override its eligibility contract.
        provider = self.member_provider
        if (type(self.bootstrap_user_id) is not str
                or self.bootstrap_user_id != BOOTSTRAP_USER_ID
                or type(provider) is not FreshGuildMemberVerifier
                or provider.client is not self.client or provider.sdk is not self.sdk
                or provider.registration_scope is not self.registration_scope
                or type(provider.shared_account_ids) is not frozenset
                or not KNOWN_SHARED_ACCOUNT_IDS <= provider.shared_account_ids
                or type(provider.timeout) not in {int, float}
                or not 0 < provider.timeout <= self.settings.provider_timeout
                or FIXED_GUILD_ID != SITE.guild_id):
            raise ValueError("bound fresh fixed Guild member provider required")

    def _same_loop(self):
        loop = asyncio.get_running_loop()
        client_loop = getattr(self.client, "loop", None)
        if not isinstance(client_loop, asyncio.AbstractEventLoop) or client_loop is not loop:
            raise RuntimeFailure("existing Bot event loop required")
        if self._loop is None:
            self._loop = loop
        if loop is not self._loop:
            raise RuntimeFailure("existing Bot event loop required")

    async def start(self, *, activate=False):
        if activate is not True:
            raise RuntimeDisabled("listener activation has not been supplied")
        self._same_loop()
        async with self._lock:
            if self._state == "running":
                return False
            if self._state != "stopped":
                raise RuntimeFailure("previous shutdown incomplete")
            if getattr(self.client, "user", None) is None:
                raise RuntimeFailure("existing Bot client is not ready")
            self._check_member_provider()
            self._state = "starting"
            failed = False
            try:
                self._ledger = self.ledger_factory()
                replay = LedgerReplayGuard(self._ledger)
                controller = make_auth_controller(
                    client=self.client, sdk=self.sdk, ledger=self._ledger,
                    signing_key=self.signing_key, fingerprint_key=self.fingerprint_key,
                    origin=self.origin, service_label=self.service_label,
                    member_provider=self.member_provider,
                    bootstrap_user_id=self.bootstrap_user_id,
                    verify_transport=self.verifier, replay_guard=replay,
                    timeout=self.settings.delivery_timeout, registration_scope=self.registration_scope)
                self._adapter = AiohttpHTTPSAdapter(controller, self.verifier, self.settings)
                factory = self.server_factory
                if factory is None:
                    from .aiohttp_server import AiohttpServer
                    factory = AiohttpServer
                self._server = factory(self._adapter, self.settings, self.tls_context)
                await self._server.start()
                self._state = "running"
                return True
            except asyncio.CancelledError:
                await self._cleanup_partial_start()
                raise
            except Exception:
                failed = True
            if failed:
                await self._cleanup_partial_start()
                raise RuntimeFailure("runtime start unavailable") from None

    async def _cleanup_partial_start(self):
        self._state = "stopping"
        safe = False
        try:
            if self._adapter is not None:
                self._adapter.begin_shutdown()
            if self._server is not None:
                await self._server.stop()
            if self._adapter is not None:
                await self._adapter.drain()
            safe = True
        except Exception:
            pass
        if safe:
            try:
                if self._ledger is not None:
                    self._ledger.close()
            except Exception:
                safe = False
        if safe:
            self._ledger = self._server = self._adapter = None
            self._state = "stopped"

    async def stop(self):
        self._same_loop()
        async with self._lock:
            if self._state == "stopped":
                return False
            self._state = "stopping"
            failed = False
            try:
                if self._adapter is not None:
                    self._adapter.begin_shutdown()
                if self._server is not None:
                    await self._server.stop()
                if self._adapter is not None:
                    await self._adapter.drain()
                if self._ledger is not None:
                    self._ledger.close()
            except Exception:
                failed = True
            if failed:
                # Do not release the durable writer while work might still exist.
                raise RuntimeFailure("runtime shutdown incomplete") from None
            self._ledger = self._server = self._adapter = None
            self._state = "stopped"
            return True


class ExistingClientAttachment:
    """Owner-invoked lifecycle seam; installs no cog or monkeypatch on the client."""
    def __init__(self, runtime):
        self.runtime = runtime

    async def after_existing_client_ready(self, *, activate=False):
        return await self.runtime.start(activate=activate)

    async def before_existing_client_close(self):
        return await self.runtime.stop()

