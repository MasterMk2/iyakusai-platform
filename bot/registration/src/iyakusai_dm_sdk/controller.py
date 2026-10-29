"""Inactive signed DM controller. No listener, key loading, trust or registration."""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import hmac
import json
import re
import threading
import time


PATH = "/v1/dm/login-code"
CLIENT = "smm-auth"
SIGNATURE_VERSION = "svc-auth/v1"
MAX_SKEW_MS = 30_000
MAX_BODY_BYTES = 4096
HEADER_NAMES = (
    "x-svc-client", "x-svc-timestamp", "x-svc-nonce",
    "x-svc-actor", "x-svc-signature",
)


@dataclass(frozen=True)
class PurposeKey:
    purpose: str
    material: bytes = field(repr=False)

    def __post_init__(self):
        if (type(self.purpose) is not str or self.purpose not in {"smm-auth", "dm-fingerprint"}
                or type(self.material) is not bytes or len(self.material) < 32
                or len(set(self.material)) == 1):
            raise ValueError("invalid purpose key")


class RequestRejected(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__("request rejected")


@dataclass(frozen=True)
class Reply:
    status: int
    body: dict


def canonical_bytes(*, client, method, path, timestamp, nonce, actor, body):
    """Exact Mail signing.ts order; SHA-256 covers the original UTF-8 body bytes."""
    return "\n".join((SIGNATURE_VERSION, client, method.upper(), path,
                       timestamp, nonce, actor, hashlib.sha256(body).hexdigest())).encode("utf-8")


def _headers(raw):
    # Preserve duplicate evidence: never accept a dict or comma-coalesced headers.
    if type(raw) not in {list, tuple} or len(raw) > 48:
        raise RequestRejected(401, "unauthenticated")
    result, size = {}, 0
    for pair in raw:
        if type(pair) not in {list, tuple} or len(pair) != 2:
            raise RequestRejected(401, "unauthenticated")
        name, value = pair
        if (type(name) is not str or type(value) is not str
                or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", name)
                or len(value) > 1024 or any(ord(c) < 32 or ord(c) > 126 for c in value)):
            raise RequestRejected(401, "unauthenticated")
        name = name.lower()
        if name in result:
            raise RequestRejected(401, "unauthenticated")
        result[name] = value
        size += len(name) + len(value)
    if size > 16_384:
        raise RequestRejected(401, "unauthenticated")
    return result


class ReplayGuard:
    """Bounded, atomic process-local replay guard. Durable delivery IDs live in Core."""
    def __init__(self, *, clock=time.time, capacity=4096):
        if type(capacity) is not int or not 1 <= capacity <= 65536:
            raise ValueError("invalid replay capacity")
        self.clock, self.capacity = clock, capacity
        self.used = {}
        self.latest_ms = None
        self.lock = threading.Lock()

    def consume(self, nonce, timestamp):
        now = int(self.clock() * 1000)
        with self.lock:
            if (abs(now - timestamp) > MAX_SKEW_MS
                    or self.latest_ms is not None and now < self.latest_ms):
                raise RequestRejected(401, "unauthenticated")
            self.used = {n: expiry for n, expiry in self.used.items() if expiry >= now}
            if nonce in self.used or len(self.used) >= self.capacity:
                raise RequestRejected(401, "unauthenticated")
            self.used[nonce] = timestamp + MAX_SKEW_MS
            self.latest_ms = now


class LedgerReplayGuard:
    """Explicit migration of an injected dedicated DM ledger; never shared Task SQLite.

    Persists only nonce digests, expiry and accepted clock metadata. No request body,
    identity, signature or code. Construction is a future approved state change.
    """
    def __init__(self, ledger, *, clock=time.time, capacity=4096):
        from .delivery import APP_ID, Ledger
        if (type(ledger) is not Ledger or ledger.db is None
                or ledger.db.execute("PRAGMA application_id").fetchone()[0] != APP_ID):
            raise ValueError("dedicated DM ledger required")
        if type(capacity) is not int or not 1 <= capacity <= 65536:
            raise ValueError("invalid replay capacity")
        self.ledger, self.clock, self.capacity = ledger, clock, capacity
        self.lock = threading.Lock()
        ledger.db.executescript(
            "CREATE TABLE IF NOT EXISTS svc_nonces (nonce_digest TEXT PRIMARY KEY, expires_ms INTEGER NOT NULL);"
            "CREATE TABLE IF NOT EXISTS svc_auth_clock (id INTEGER PRIMARY KEY CHECK(id=1), latest_ms INTEGER NOT NULL);"
        )
        expected = {
            "svc_nonces": [("nonce_digest", "TEXT", 0, 1), ("expires_ms", "INTEGER", 1, 0)],
            "svc_auth_clock": [("id", "INTEGER", 0, 1), ("latest_ms", "INTEGER", 1, 0)],
        }
        for table, wanted in expected.items():
            rows = ledger.db.execute("PRAGMA table_info(" + table + ")").fetchall()
            if [(r[1], r[2], r[3], r[5]) for r in rows] != wanted:
                raise ValueError("unrecognized replay ledger")

    def consume(self, nonce, timestamp):
        now = int(self.clock() * 1000)
        digest = hashlib.sha256(b"svc-auth/v1\0smm-auth\0" + nonce.encode("ascii")).hexdigest()
        db = self.ledger.db
        with self.lock:
            try:
                db.execute("BEGIN IMMEDIATE")
                last = db.execute("SELECT latest_ms FROM svc_auth_clock WHERE id=1").fetchone()
                if abs(now - timestamp) > MAX_SKEW_MS or last is not None and now < last[0]:
                    raise RequestRejected(401, "unauthenticated")
                db.execute("DELETE FROM svc_nonces WHERE expires_ms < ?", (now,))
                if (db.execute("SELECT 1 FROM svc_nonces WHERE nonce_digest=?", (digest,)).fetchone()
                        or db.execute("SELECT COUNT(*) FROM svc_nonces").fetchone()[0] >= self.capacity):
                    raise RequestRejected(401, "unauthenticated")
                db.execute("INSERT INTO svc_nonces VALUES (?,?)", (digest, timestamp + MAX_SKEW_MS))
                db.execute("INSERT INTO svc_auth_clock VALUES (1,?) ON CONFLICT(id) DO UPDATE SET latest_ms=excluded.latest_ms", (now,))
                db.execute("COMMIT")
                return
            except RequestRejected:
                try:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                except Exception:
                    pass
                raise
            except Exception:
                try:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                except Exception:
                    pass
        raise RequestRejected(503, "unavailable") from None


def _json_pairs(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("duplicate JSON member")
        result[name] = value
    return result


def _bad_constant(_):
    raise ValueError("invalid JSON constant")


def strict_json(body):
    return json.loads(body.decode("utf-8"), object_pairs_hook=_json_pairs,
                      parse_constant=_bad_constant)


class SignedDMController:
    """Call on the existing Bot/Core event loop after trusted transport metadata exists.

    Mail client=smm-auth omits the actor header. Zero or one empty actor is accepted;
    canonical actor is always empty. A posted/forwarded actor is never trusted.
    The transport verifier receives server connection metadata, not an HTTP claim.
    """
    def __init__(self, *, core, signing_key, verify_transport, replay_guard, clock=time.time):
        if (not isinstance(signing_key, PurposeKey) or signing_key.purpose != CLIENT
                or not callable(verify_transport)
                or hmac.compare_digest(signing_key.material, core.key)
                or not isinstance(replay_guard, LedgerReplayGuard)
                or replay_guard.ledger is not core.ledger):
            raise ValueError("invalid controller composition")
        self.core, self.signing_key = core, signing_key
        self.verify_transport, self.clock = verify_transport, clock
        self.replay = replay_guard

    def _authenticate(self, method, path, headers, body):
        required = set(HEADER_NAMES) - {"x-svc-actor"}
        if (not required <= headers.keys()
                or any(name.startswith("x-svc-") and name not in HEADER_NAMES for name in headers)):
            raise RequestRejected(401, "unauthenticated")
        client = headers["x-svc-client"]
        timestamp = headers["x-svc-timestamp"]
        nonce = headers["x-svc-nonce"]
        actor = headers.get("x-svc-actor", "")
        signature = headers["x-svc-signature"]
        if (client != CLIENT or actor != "" or not re.fullmatch(r"[0-9]{13}", timestamp)
                or abs(int(self.clock() * 1000) - int(timestamp)) > MAX_SKEW_MS
                or not re.fullmatch(r"[A-Za-z0-9_-]{22,64}", nonce)
                or not re.fullmatch(r"[0-9a-f]{64}", signature)):
            raise RequestRejected(401, "unauthenticated")
        data = canonical_bytes(client=client, method=method, path=path,
                               timestamp=timestamp, nonce=nonce, actor=actor, body=body)
        expected = hmac.new(self.signing_key.material, data, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise RequestRejected(401, "unauthenticated")
        self.replay.consume(nonce, int(timestamp))

    async def handle(self, *, method, path, headers, body, connection):
        if method != "POST":
            return Reply(405, {"error": "method_not_allowed"})
        if path != PATH:
            return Reply(404, {"error": "not_found"})
        if type(body) is not bytes or len(body) > MAX_BODY_BYTES:
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
            envelope = strict_json(body)
            # Validation is the same candidate Core contract, not a normalization.
            from .delivery import validate
            validate(envelope, self.core.origin, self.clock())
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
            return Reply(400, {"error": "invalid_envelope"})
        try:
            ack = await self.core.deliver(envelope)
        except ValueError:
            return Reply(409, {"error": "delivery_conflict"})
        except Exception:
            return Reply(503, {"error": "unavailable"})
        if (type(ack) is not dict or ack.get("deliveryId") != envelope["deliveryId"]
                or type(ack.get("status")) is not str
                or ack.get("status") not in {"delivered", "failed"}):
            return Reply(503, {"error": "unavailable"})
        if ack["status"] == "delivered" and set(ack) != {"deliveryId", "status"}:
            return Reply(503, {"error": "unavailable"})
        if ack["status"] == "failed":
            from .delivery import REASONS
            if (set(ack) != {"deliveryId", "status", "reason"}
                    or type(ack["reason"]) is not str or ack["reason"] not in REASONS):
                return Reply(503, {"error": "unavailable"})
        return Reply(200, dict(ack))
