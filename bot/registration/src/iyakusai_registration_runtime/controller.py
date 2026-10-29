"""AUTH-only, fixed-guild qualification and initial-registration signed routes.

Unchanged svc-auth/v1 raw-body HMAC/nonce conventions are reused. No task,
ordinary-login DM, roster, guild administration or account/password/session store.
"""
from __future__ import annotations

import hmac
import re
import time

from iyakusai_dm_sdk.controller import (
    PurposeKey, Reply, RequestRejected, SignedDMController, _headers, strict_json,
)
from iyakusai_dm_sdk.delivery import REASONS

from .member import FIXED_GUILD_ID, FreshGuildMemberVerifier, MemberUnavailable
from .registration import RegistrationSDKTransport, validate_registration
from .policy import RegistrationScope, checked_registration_scope
from .policy import BOOTSTRAP_USER_ID, KNOWN_SHARED_ACCOUNT_IDS

MEMBER_PATH = "/v1/discord/member"
REGISTRATION_PATH = "/v1/dm/registration-code"
AUTH_PATHS = frozenset({MEMBER_PATH, REGISTRATION_PATH})


class AuthController(SignedDMController):
    """The purpose=smm-auth key is scoped only to these two AUTH operations."""
    def __init__(self, *, core, signing_key, verify_transport, replay_guard,
                 member_provider, bootstrap_user_id, clock=time.time, registration_scope=None):
        scope = checked_registration_scope(registration_scope)
        if (type(member_provider) is not FreshGuildMemberVerifier or getattr(core, 'registration_scope', None) is not scope
                or member_provider.registration_scope is not scope
                or core.verify_recipient is not member_provider
                or type(bootstrap_user_id) is not str
                or bootstrap_user_id != BOOTSTRAP_USER_ID
                or re.fullmatch(r"[1-9][0-9]{16,19}", bootstrap_user_id) is None
                or int(bootstrap_user_id) >= 2**64
                or core.bootstrap_user_id != bootstrap_user_id
                or not KNOWN_SHARED_ACCOUNT_IDS <= member_provider.shared_account_ids):
            raise ValueError("fresh canonical member provider required")
        super().__init__(core=core, signing_key=signing_key,
                         verify_transport=verify_transport, replay_guard=replay_guard,
                         clock=clock)
        self.registration_scope = scope
        self.member_provider = member_provider
        self.bootstrap_user_id = bootstrap_user_id

    async def handle(self, *, method, path, headers, body, connection):
        if method != "POST":
            return Reply(405, {"error": "method_not_allowed"})
        if path not in AUTH_PATHS:
            return Reply(404, {"error": "not_found"})
        if type(body) is not bytes or len(body) > 4096:
            return Reply(413, {"error": "body_too_large"})
        try:
            wire = _headers(headers)
            if "transfer-encoding" in wire:
                raise RequestRejected(400, "invalid_framing")
            if wire.get("content-type") != "application/json":
                raise RequestRejected(415, "unsupported_media_type")
            if "content-length" in wire and wire["content-length"] != str(len(body)):
                raise RequestRejected(400, "invalid_framing")
        except RequestRejected as error:
            return Reply(error.status, {"error": error.code})
        try:
            transport_ok = await self.verify_transport(connection)
        except Exception:
            transport_ok = False
        if transport_ok is not True:
            return Reply(403, {"error": "transport_unverified"})
        try:
            self._authenticate(method, path, wire, body)
        except RequestRejected as error:
            return Reply(error.status, {"error": error.code})
        try:
            request = strict_json(body)
        except (ValueError, TypeError, RecursionError, OverflowError):
            return Reply(400, {"error": "invalid_request"})
        if path == MEMBER_PATH:
            if (type(request) is not dict or set(request) != {"guildId", "userId"}
                    or request["guildId"] != FIXED_GUILD_ID
                    or type(request["userId"]) is not str
                    or re.fullmatch(r"[1-9][0-9]{16,19}", request["userId"]) is None
                    or int(request["userId"]) >= 2**64):
                return Reply(400, {"error": "invalid_request"})
            try:
                result = await self.member_provider.qualify(request["userId"])
            except ValueError:
                return Reply(400, {"error": "invalid_request"})
            except Exception:
                return Reply(503, {"error": "member_unavailable"})
            # Provider emits an exact, name/email-free snapshot or fails closed.
            return Reply(200, result)
        try:
            validate_registration(request, self.core.origin, self.clock())
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
            return Reply(400, {"error": "invalid_registration"})
        if not self.registration_scope.permits(request["recipient"]["discordUserId"]):
            return Reply(403, {"error": "registration_subject_required"})
        try:
            ack = await self.core.deliver(request)
        except ValueError:
            return Reply(409, {"error": "delivery_conflict"})
        except Exception:
            return Reply(503, {"error": "unavailable"})
        if (type(ack) is not dict or ack.get("deliveryId") != request["deliveryId"]
                or type(ack.get("status")) is not str):
            return Reply(503, {"error": "unavailable"})
        if ack["status"] == "delivered" and set(ack) == {"deliveryId", "status"}:
            return Reply(200, dict(ack))
        if (ack["status"] == "failed" and set(ack) == {"deliveryId", "status", "reason"}
                and type(ack["reason"]) is str and ack["reason"] in REASONS):
            return Reply(200, dict(ack))
        return Reply(503, {"error": "unavailable"})


def make_auth_controller(*, client, sdk, ledger, signing_key, fingerprint_key,
                         origin, service_label, member_provider, verify_transport,
                         replay_guard, bootstrap_user_id, timeout=5, registration_scope=None):
    """Inject only the existing client and an explicit fresh fixed-guild provider."""
    scope = checked_registration_scope(registration_scope)
    if (not isinstance(signing_key, PurposeKey) or signing_key.purpose != "smm-auth"
            or not isinstance(fingerprint_key, PurposeKey)
            or fingerprint_key.purpose != "dm-fingerprint"
            or hmac.compare_digest(signing_key.material, fingerprint_key.material)
            or type(member_provider) is not FreshGuildMemberVerifier
            or member_provider.client is not client or member_provider.sdk is not sdk
            or bootstrap_user_id != BOOTSTRAP_USER_ID
            or not KNOWN_SHARED_ACCOUNT_IDS <= member_provider.shared_account_ids):
        raise ValueError("separate AUTH keys and genuine member provider required")
    from . import core as core_module
    sender = RegistrationSDKTransport(client=client, sdk=sdk, core_module=core_module,
                                     origin=origin, service_label=service_label,
                                     verify_recipient=member_provider)
    core = core_module.RegistrationDeliveryCore(
        ledger, fingerprint_key.material, origin, member_provider, sender.send,
        timeout=timeout, bootstrap_user_id=bootstrap_user_id, registration_scope=scope)
    return AuthController(core=core, signing_key=signing_key,
                          verify_transport=verify_transport, replay_guard=replay_guard,
                          member_provider=member_provider, bootstrap_user_id=bootstrap_user_id, registration_scope=scope)

