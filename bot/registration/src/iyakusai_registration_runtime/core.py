"""Initial-registration-only Core, preserving reservation/result/crash semantics."""
import asyncio
import hashlib
import hmac
import json
import re
import time

from iyakusai_dm_sdk.delivery import APP_ID, DeliveryCore as HistoricalDeliveryCore, DeliveryFailure, Ledger, REASONS
from .registration import validate_registration as validate
from .policy import RegistrationScope, checked_registration_scope
from .policy import BOOTSTRAP_USER_ID


class RegistrationDeliveryCore(HistoricalDeliveryCore):
    def __init__(self, ledger, fingerprint_key, origin, verify_recipient, send,
                 timeout=5, *, bootstrap_user_id, registration_scope=None):
        if (type(bootstrap_user_id) is not str
                or bootstrap_user_id != BOOTSTRAP_USER_ID
                or re.fullmatch(r"[1-9][0-9]{16,19}", bootstrap_user_id) is None
                or int(bootstrap_user_id) >= 2**64):
            raise ValueError("explicit authenticated bootstrap subject required")
        self.registration_scope = checked_registration_scope(registration_scope)
        self.bootstrap_user_id = bootstrap_user_id
        super().__init__(ledger, fingerprint_key, origin, verify_recipient, send, timeout=timeout)

    async def deliver(self, envelope):
        encoded = validate(envelope, self.origin, time.time())
        # Deep snapshot: the caller cannot mutate recipient/code during awaits.
        envelope = json.loads(encoded)
        delivery_id = envelope["deliveryId"]
        if not self.registration_scope.permits(envelope["recipient"]["discordUserId"]):
            return self.failed(delivery_id, "recipient_mismatch")
        fingerprint = hmac.new(self.key, b"smm-dm-envelope/v1\0" + encoded, hashlib.sha256).hexdigest()
        try:
            verified = await self.verify_recipient(dict(envelope["recipient"]))
        except Exception:
            return self.failed(delivery_id, "unavailable")
        if verified is not True:
            return self.failed(delivery_id, "recipient_mismatch")
        if delivery_id in self.inflight:
            old_fingerprint, future = self.inflight[delivery_id]
            if not hmac.compare_digest(old_fingerprint, fingerprint):
                raise ValueError("delivery id conflict")
            return dict(await asyncio.shield(future))
        row = self.ledger.reserve(delivery_id, fingerprint)
        if row is not None:
            state, reason = row
            if state == "DELIVERED":
                return {"deliveryId": delivery_id, "status": "delivered"}
            # A crash after claim or after SDK acceptance is ambiguous: never retry this ID.
            return self.failed(delivery_id, reason if state == "FAILED" and reason in REASONS else "timeout")
        future = asyncio.get_running_loop().create_future()
        self.inflight[delivery_id] = fingerprint, future
        ack = self.failed(delivery_id, "unavailable")
        try:
            try:
                sent = await asyncio.wait_for(self.send(envelope), timeout=self.timeout)
                if sent is not True:
                    raise DeliveryFailure("unavailable")
                self.ledger.complete(delivery_id, "DELIVERED")
                ack = {"deliveryId": delivery_id, "status": "delivered"}
            except (asyncio.TimeoutError, DeliveryFailure) as e:
                reason = "timeout" if isinstance(e, asyncio.TimeoutError) else e.reason
                self.ledger.complete(delivery_id, "FAILED", reason)
                ack = self.failed(delivery_id, reason)
            except Exception:
                # CLAIMED survives even if storing a result fails; no second SDK attempt.
                ack = self.failed(delivery_id, "unavailable")
            return ack
        finally:
            future.set_result(dict(ack))
            self.inflight.pop(delivery_id, None)

