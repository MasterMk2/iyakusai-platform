"""Offline candidate core. No network entry point, Bot import, or credential generation."""
import asyncio
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

APP_ID = 0x534D444D
REASONS = {"dm_closed", "blocked", "rate_limited", "timeout", "recipient_mismatch", "unavailable"}


class DeliveryFailure(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else "unavailable"
        super().__init__("delivery failed")


def validate(envelope, origin, now):
    # Two explicit purpose/template pairs; never infer a legacy login's audience.
    required = {"kind", "deliveryId", "template", "purpose", "audience", "recipient", "code", "expiresAt", "context"}
    if type(envelope) is not dict or set(envelope) != required:
        raise ValueError("invalid envelope")
    pairs = (("password_setup", "password_setup_code_v1"), ("login", "login_code_v1"))
    if (envelope["kind"] != "login_code"
            or (envelope["purpose"], envelope["template"]) not in pairs
            or envelope["audience"] != origin):
        raise ValueError("invalid purpose")
    if not isinstance(envelope["deliveryId"], str) or not re.fullmatch(r"dl_[0-9a-f]{32}", envelope["deliveryId"]):
        raise ValueError("invalid delivery id")
    recipient = envelope["recipient"]
    if type(recipient) is not dict or set(recipient) != {"discordUserId", "linkId", "linkVersion"}:
        raise ValueError("invalid recipient")
    if (not isinstance(recipient["discordUserId"], str) or not re.fullmatch(r"[0-9]{17,20}", recipient["discordUserId"])
            or not isinstance(recipient["linkId"], str) or not 1 <= len(recipient["linkId"]) <= 128
            or type(recipient["linkVersion"]) is not int or recipient["linkVersion"] < 1):
        raise ValueError("invalid recipient")
    if not isinstance(envelope["code"], str) or not re.fullmatch(r"[0-9]{8}", envelope["code"]):
        raise ValueError("invalid code")
    context = envelope["context"]
    if type(context) is not dict or not {"serviceLabel", "requestedAt"} <= set(context) <= {"serviceLabel", "requestedAt", "verifiedEmail"}:
        raise ValueError("invalid context")
    for key in ("serviceLabel", "verifiedEmail"):
        if key in context and (not isinstance(context[key], str) or not 1 <= len(context[key]) <= 254
                or any(ord(c) < 32 or ord(c) == 127 for c in context[key])):
            raise ValueError("invalid context")
    try:
        expires = dt.datetime.fromisoformat(envelope["expiresAt"].replace("Z", "+00:00"))
        requested = dt.datetime.fromisoformat(context["requestedAt"].replace("Z", "+00:00"))
        if expires.tzinfo is None or requested.tzinfo is None:
            raise ValueError()
        if not now < expires.timestamp() <= now + 300 or abs(now - requested.timestamp()) > 30:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ValueError("invalid time") from None
    encoded = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    if len(encoded) > 4096:
        raise ValueError("oversize envelope")
    return encoded


class Ledger:
    """Dedicated owner-private SQLite; reserves before SDK invocation, never shared Task DB."""
    def __init__(self, directory):
        parent = Path(directory)
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o700:
            raise ValueError("unsafe ledger directory")
        if parent.resolve() != parent.absolute():
            raise ValueError("symlink ledger directory")
        lock_path = parent / "dm-deliveries.lock"
        self.lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.db = None
        try:
            self._check_file(os.fstat(self.lock_fd))
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = parent / "dm-deliveries.sqlite3"
            fresh = False
            try:
                fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                fresh = True
            except FileExistsError:
                fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
            try:
                before = os.fstat(fd)
                self._check_file(before)
                self.db = sqlite3.connect(str(path), isolation_level=None, timeout=3)
                after = path.lstat()
                if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                    raise ValueError("ledger identity changed")
                if fresh:
                    self.db.executescript(f"PRAGMA application_id={APP_ID}; PRAGMA user_version=1; CREATE TABLE deliveries (delivery_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, observed_at REAL NOT NULL);")
                elif (self.db.execute("PRAGMA application_id").fetchone()[0] != APP_ID
                        or self.db.execute("PRAGMA user_version").fetchone()[0] != 1):
                    raise ValueError("unrecognized ledger")
                self.db.execute("PRAGMA synchronous=FULL")
            finally:
                os.close(fd)
        except Exception:
            self.close()
            raise

    @staticmethod
    def _check_file(s):
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o600:
            raise ValueError("unsafe ledger file")

    def reserve(self, delivery_id, fingerprint):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("SELECT fingerprint,state,reason FROM deliveries WHERE delivery_id=?", (delivery_id,)).fetchone()
            if row is None:
                self.db.execute("INSERT INTO deliveries VALUES (?,?,'CLAIMED',NULL,?)", (delivery_id, fingerprint, time.time()))
                self.db.execute("COMMIT")
                return None
            self.db.execute("COMMIT")
            if not hmac.compare_digest(row[0], fingerprint):
                raise ValueError("delivery id conflict")
            return row[1], row[2]
        except Exception:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def complete(self, delivery_id, state, reason=None):
        self.db.execute("UPDATE deliveries SET state=?,reason=?,observed_at=? WHERE delivery_id=? AND state='CLAIMED'", (state, reason, time.time(), delivery_id))

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None


class DeliveryCore:
    """Call only after smm-auth verification. Inject current canonical-link verifier and SDK sender."""
    def __init__(self, ledger, fingerprint_key, origin, verify_recipient, send, timeout=5):
        if not isinstance(fingerprint_key, bytes) or len(fingerprint_key) < 32:
            raise ValueError("fingerprint key required")
        self.ledger, self.key, self.origin = ledger, fingerprint_key, origin
        self.verify_recipient, self.send, self.timeout = verify_recipient, send, timeout
        self.inflight = {}

    @staticmethod
    def failed(delivery_id, reason):
        return {"deliveryId": delivery_id, "status": "failed", "reason": reason}

    async def deliver(self, envelope):
        encoded = validate(envelope, self.origin, time.time())
        # Deep snapshot: the caller cannot mutate recipient/code during awaits.
        envelope = json.loads(encoded)
        delivery_id = envelope["deliveryId"]
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
