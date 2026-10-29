"""Offline OA relay planning and durable receipts. No network or credentials.

Inputs must come from the official OA Store, never MyLINE. The separate
transport requires an explicitly approved live config; this library sends none.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import mimetypes
from pathlib import Path
import re
import sqlite3
from typing import Iterable

from relay_site import SITE


ACCOUNT = "iyakusai_oa"
GUILD = SITE["guild"]
EXISTING_MYLINE_FORUM = SITE["myline_forum"]
JST = timezone(timedelta(hours=9))
KEY_PATTERN = re.compile(r"ev:\d{8}:\d{15}:\d{2}:[a-f0-9]{8}\Z")
MEDIA_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
SUPPORTED = {"text", "image", "file", "video", "audio", "sticker", "location"}
MEDIA_TYPES = {"image", "file", "video", "audio"}
TERMINAL = {"baseline", "delivered", "duplicate", "policy_skipped"}


class ValidationError(ValueError):
    pass


def canonical_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def valid_key(key: str) -> str:
    if not isinstance(key, str) or not KEY_PATTERN.fullmatch(key):
        raise ValidationError("invalid_official_receive_key")
    return key


@dataclass(frozen=True)
class Event:
    receive_key: str
    identity: str
    source_type: str
    source_id: str
    event_type: str
    kind: str | None
    sent_at: datetime
    text: str
    file_name: str | None
    media_id: str | None
    media_error: bool
    extra: dict
    digest: str


def normalize_store(record: dict, receive_key: str, *, provenance: str) -> Event:
    if provenance != "official_oa_store":
        raise ValidationError("non_official_source")
    valid_key(receive_key)
    if "_key" in record and record["_key"] != receive_key:
        raise ValidationError("receive_key_mismatch")
    stamp = record.get("timestamp")
    if type(stamp) is not int or stamp <= 0:
        raise ValidationError("missing_original_timestamp")
    try:
        sent_at = datetime.fromtimestamp(stamp / 1000, JST)
    except (OverflowError, OSError, ValueError) as exc:
        raise ValidationError("invalid_original_timestamp") from exc
    source_type = record.get("source_type")
    if source_type == "user":
        source_id = record.get("user_id")
    elif source_type in {"group", "room"}:
        source_id = record.get("group_id")
    else:
        raise ValidationError("unsupported_source_type")
    if not isinstance(source_id, str) or not source_id:
        raise ValidationError("missing_source_id")
    event_type = record.get("event_type")
    if not isinstance(event_type, str) or not event_type:
        raise ValidationError("missing_event_type")
    message_id = record.get("message_id")
    webhook_id = record.get("webhook_event_id") or record.get("webhookEventId")
    if event_type in {"message", "unsend"} and not message_id:
        raise ValidationError("missing_stable_message_id")
    stable_id = message_id or webhook_id or receive_key
    identity = canonical_hash([ACCOUNT, source_type, source_id, event_type, str(stable_id)])
    kind = record.get("message_type")
    file_name = record.get("file_name")
    if file_name is not None and not isinstance(file_name, str):
        raise ValidationError("invalid_file_name")
    media_id = str(message_id) if event_type == "message" and kind in MEDIA_TYPES else None
    if media_id and not MEDIA_ID_PATTERN.fullmatch(media_id):
        raise ValidationError("unsafe_media_id")
    text = record.get("text") or ""
    if not isinstance(text, str):
        raise ValidationError("invalid_text")
    extra = record.get("extra") or {}
    if not isinstance(extra, dict):
        raise ValidationError("invalid_extra")
    # Enrichment fields may change after reception. They do not change identity.
    digest = canonical_hash([event_type, kind, stamp, text, record.get("file_name"), extra])
    return Event(receive_key, identity, source_type, source_id, event_type, kind,
                 sent_at, text, file_name, media_id,
                 bool(record.get("media_error")), extra, digest)


def read_store_events(root: Path) -> Iterable[Event]:
    root = root.resolve(strict=True)
    paths = sorted(root.glob("*/*.json"), key=lambda path: path.stem)
    for path in paths:
        actual = path.resolve(strict=True)
        if not actual.is_relative_to(root):
            raise ValidationError("event_outside_official_store")
        key = path.stem.replace("-", ":")
        yield normalize_store(json.loads(actual.read_text(encoding="utf-8")), key,
                              provenance="official_oa_store")


@dataclass(frozen=True)
class Binding:
    source_type: str
    source_id: str
    org_id: str
    org_name: str
    verified: bool
    evidence: str
    verified_by: str


class Registry:
    def __init__(self, bindings: Iterable[Binding]):
        self.bindings = {}
        names = {}
        for binding in bindings:
            if binding.source_type not in {"user", "group", "room"}:
                raise ValidationError("invalid_binding_type")
            fields = [binding.source_id, binding.org_id, binding.org_name]
            if any(not isinstance(value, str) or not value.strip() for value in fields):
                raise ValidationError("incomplete_binding")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", binding.org_id):
                raise ValidationError("unsafe_org_id")
            if binding.verified is True and not (isinstance(binding.evidence, str) and binding.evidence.strip()
                and isinstance(binding.verified_by, str) and binding.verified_by.strip()):
                raise ValidationError("verified_binding_without_evidence")
            key = (binding.source_type, binding.source_id)
            if key in self.bindings:
                raise ValidationError("ambiguous_source_binding")
            if binding.org_id in names and names[binding.org_id] != binding.org_name:
                raise ValidationError("conflicting_org_names")
            self.bindings[key] = binding
            names[binding.org_id] = binding.org_name

    def resolve(self, event: Event) -> Binding | None:
        binding = self.bindings.get((event.source_type, event.source_id))
        return binding if binding and binding.verified is True else None


@dataclass(frozen=True)
class Attachment:
    path: Path
    name: str
    size: int
    sha256: str
    content_type: str = "application/octet-stream"


@dataclass(frozen=True)
class Part:
    number: int
    content: str
    marker: str
    attachment: Attachment | None

    def discord_payload(self) -> dict:
        return {"content": self.content, "allowed_mentions": {"parse": [], "replied_user": False},
                "flags": 4096 | 4}


@dataclass(frozen=True)
class Plan:
    event: Event
    disposition: str
    reason: str | None
    org_id: str | None
    thread_name: str | None
    parts: tuple[Part, ...]
    attachment_issue: str | None = None

    @property
    def fingerprint(self) -> str:
        return canonical_hash([self.org_id, self.thread_name,
            [(part.content, (part.attachment.name, part.attachment.size, part.attachment.sha256)
              if part.attachment else None) for part in self.parts]])


def safe_name(value: str) -> str:
    value = value.replace("\\", "/").rsplit("/", 1)[-1]
    value = re.sub(r"[\x00-\x1f<>:\"/\\|?*]", "_", value).strip(" .")
    return value[:120] or "LINE_attachment.bin"


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def split_text(text: str, capacity: int) -> list[str]:
    if capacity < 4:
        raise ValidationError("message_header_too_long")
    chunks, chunk, size = [], [], 0
    for character in text:
        weight = utf16_len(character)
        if chunk and size + weight > capacity:
            chunks.append("".join(chunk))
            chunk, size = [], 0
        chunk.append(character)
        size += weight
    if chunk or not chunks:
        chunks.append("".join(chunk))
    return chunks


def resolve_attachment(event: Event, media_root: Path, max_bytes: int) -> tuple[Attachment | None, str | None]:
    if event.kind not in MEDIA_TYPES:
        return None, None
    if event.media_error:
        return None, "source_media_error"
    if not event.media_id or not media_root.is_dir():
        return None, "media_unavailable"
    root = media_root.resolve(strict=True)
    path = root / event.media_id
    if not path.exists():
        return None, "media_unavailable"
    actual = path.resolve(strict=True)
    if not actual.is_relative_to(root) or not actual.is_file():
        raise ValidationError("media_outside_official_store")
    size = actual.stat().st_size
    if size > max_bytes:
        return None, "media_over_upload_limit"
    content_type = "application/octet-stream"
    meta_path = root / (event.media_id + ".meta.json")
    if meta_path.exists():
        if not meta_path.resolve(strict=True).is_relative_to(root):
            raise ValidationError("media_metadata_outside_store")
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        content_type = metadata.get("content_type") or content_type
        if not isinstance(content_type, str):
            raise ValidationError("invalid_media_content_type")
    extension = mimetypes.guess_extension(content_type) or ".bin"
    name = safe_name(event.file_name or ("LINE_" + event.media_id + extension))
    with actual.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    return Attachment(actual, name, size, digest, content_type), None


def verify_attachment(attachment: Attachment, media_root: Path) -> None:
    """Required immediately before a future transport opens the planned file."""
    root = media_root.resolve(strict=True)
    actual = attachment.path.resolve(strict=True)
    if not actual.is_relative_to(root) or not actual.is_file():
        raise ValidationError("media_outside_official_store")
    with actual.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    if actual.stat().st_size != attachment.size or digest != attachment.sha256:
        raise ValidationError("attachment_changed_after_plan")


def validate_destination(forum: dict, category: dict) -> str:
    if (forum.get("guild_id") != GUILD or category.get("guild_id") != GUILD
            or forum.get("type") != 15 or category.get("type") != 4
            or forum.get("parent_id") != category.get("id")):
        raise ValidationError("destination_scope_or_parent_invalid")
    forum_id = forum.get("id")
    if not isinstance(forum_id, str) or not re.fullmatch(r"\d{17,20}", forum_id):
        raise ValidationError("invalid_forum_id")
    if forum_id == EXISTING_MYLINE_FORUM:
        raise ValidationError("existing_myline_forum_excluded")
    return forum_id


def plan_event(event: Event, registry: Registry, media_root: Path,
               *, max_attachment_bytes: int = 10 * 1024 * 1024) -> Plan:
    if event.event_type not in {"message", "unsend"}:
        return Plan(event, "policy_skipped", "non_message_event", None, None, ())
    binding = registry.resolve(event)
    if binding is None:
        return Plan(event, "held", "organization_unverified", None, None, ())
    if event.event_type == "message" and event.kind not in SUPPORTED:
        return Plan(event, "held", "unsupported_message_type", binding.org_id, None, ())
    if max_attachment_bytes < 1 or max_attachment_bytes > 24 * 1024 * 1024:
        raise ValidationError("invalid_attachment_limit")
    attachment, issue = resolve_attachment(event, media_root, max_attachment_bytes)
    if event.event_type == "unsend":
        body = "[LINEで送信取消。元の投稿は自動削除しません。]"
    elif event.kind == "text":
        body = event.text or "[空のテキスト]"
    elif event.kind == "sticker":
        body = "[スタンプ]"
    elif event.kind == "location":
        body = "[位置情報]\n" + event.text
        if event.extra.get("latitude") is not None and event.extra.get("longitude") is not None:
            body += f"\n緯度: {event.extra['latitude']} / 経度: {event.extra['longitude']}"
    else:
        body = "[" + (event.kind or "添付") + "]"
        if event.text:
            body += "\n" + event.text
    if issue:
        body += "\n[添付を転送できません: " + issue + "]"
    name = safe_name(binding.org_name.replace("@", "＠"))
    thread_name = f"{binding.org_id}｜{name}"[:100]
    return Plan(event, "planned", None, binding.org_id, thread_name, render_parts(event, body, attachment), issue)


def render_parts(event: Event, body: str, attachment: Attachment | None = None) -> tuple[Part, ...]:
    header = "公式LINE受信｜" + event.sent_at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + " JST\n"
    # Reserve enough room for every part marker, including long part numbers.
    marker_prefix = "oa:" + event.identity[:24]
    capacity = 2000 - utf16_len(header + "\n[" + marker_prefix + ":999999/999999]")
    chunks = split_text(body, capacity)
    if len(chunks) > 999999:
        raise ValidationError("too_many_message_parts")
    parts = []
    for number, chunk in enumerate(chunks, 1):
        marker = f"{marker_prefix}:{number}/{len(chunks)}"
        content = header + chunk + "\n[" + marker + "]"
        parts.append(Part(number, content, marker, attachment if number == 1 else None))
    return tuple(parts)


class Journal:
    """Metadata-only local state. Unknown POST outcomes remain sending forever
    until a verified Discord receipt is supplied; there is no auto-retry path.
    """

    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, isolation_level=None, timeout=10)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS entries (
                key TEXT PRIMARY KEY, identity TEXT NOT NULL, status TEXT NOT NULL, reason TEXT);
            CREATE TABLE IF NOT EXISTS deliveries (
                identity TEXT PRIMARY KEY, digest TEXT NOT NULL, org_id TEXT,
                fingerprint TEXT, status TEXT NOT NULL, part_count INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS parts (
                identity TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL,
                discord_id TEXT, PRIMARY KEY(identity, number));
            CREATE TABLE IF NOT EXISTS attachment_issues (
                identity TEXT PRIMARY KEY, issue TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS threads (
                org_id TEXT PRIMARY KEY, forum_id TEXT NOT NULL,
                state TEXT NOT NULL, thread_id TEXT);
            CREATE TABLE IF NOT EXISTS attempts (
                identity TEXT NOT NULL, number INTEGER NOT NULL, operation TEXT NOT NULL,
                target_id TEXT NOT NULL, started_at TEXT NOT NULL,
                PRIMARY KEY(identity, number));
            CREATE TABLE IF NOT EXISTS reviews (
                identity TEXT PRIMARY KEY, receive_key TEXT NOT NULL, event_digest TEXT NOT NULL,
                org_id TEXT NOT NULL, fingerprint TEXT NOT NULL, forum_id TEXT NOT NULL,
                reviewer_user_id TEXT NOT NULL, reviewed_at TEXT NOT NULL, decision TEXT NOT NULL);
        """)

    def close(self):
        self.db.close()

    def value(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def _set(self, key: str, value: str):
        self.db.execute("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def _transaction(self, action):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            result = action()
            self.db.execute("COMMIT")
            return result
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def initialize(self, existing: Iterable[Event], *, activated_at: datetime | None = None):
        events = sorted(existing, key=lambda event: event.receive_key)
        if not events:
            raise ValidationError("baseline_requires_observed_events")
        if len({event.receive_key for event in events}) != len(events):
            raise ValidationError("duplicate_baseline_keys")

        def action():
            if self.value("account") is not None:
                raise ValidationError("baseline_already_initialized")
            self._set("account", ACCOUNT)
            self._set("guild", GUILD)
            self._set("baseline", events[-1].receive_key)
            self._set("scan_cursor", events[-1].receive_key)
            self._set("delivered_cursor", events[-1].receive_key)
            if activated_at is not None:
                if activated_at.tzinfo is None:
                    raise ValidationError("activation_timezone_required")
                self._set("activated_at", activated_at.astimezone(timezone.utc).isoformat())
            for event in events:
                self.db.execute("INSERT INTO entries VALUES (?,?,?,NULL)", (event.receive_key, event.identity, "baseline"))
                self.db.execute("INSERT OR IGNORE INTO deliveries VALUES (?,?,NULL,NULL,'baseline',0)", (event.identity, event.digest))
        self._transaction(action)

    def _scope(self):
        if self.value("account") != ACCOUNT or self.value("guild") != GUILD:
            raise ValidationError("state_scope_or_baseline_missing")

    def register(self, plan: Plan) -> str:
        event = plan.event

        def action():
            self._scope()
            existing = self.db.execute("SELECT identity,status FROM entries WHERE key=?", (event.receive_key,)).fetchone()
            if existing:
                if existing[0] != event.identity:
                    raise ValidationError("source_key_changed_identity")
                digest = self.db.execute("SELECT digest FROM deliveries WHERE identity=?", (event.identity,)).fetchone()
                if digest and digest[0] != event.digest:
                    raise ValidationError("source_key_changed_content")
                return existing[1]
            if event.receive_key <= self.value("baseline"):
                raise ValidationError("event_before_start_baseline")
            previous = self.db.execute("SELECT digest,status FROM deliveries WHERE identity=?", (event.identity,)).fetchone()
            status, reason = plan.disposition, plan.reason
            if previous:
                status = "duplicate" if previous[0] == event.digest else "held"
                reason = "duplicate_event" if status == "duplicate" else "stable_id_content_conflict"
            else:
                self.db.execute("INSERT INTO deliveries VALUES (?,?,?,?,?,?)",
                    (event.identity, event.digest, plan.org_id, plan.fingerprint,
                     status, len(plan.parts)))
                for part in plan.parts:
                    self.db.execute("INSERT INTO parts VALUES (?,?,'ready',NULL)", (event.identity, part.number))
                if plan.attachment_issue:
                    self.db.execute("INSERT INTO attachment_issues VALUES (?,?)", (event.identity, plan.attachment_issue))
            self.db.execute("INSERT INTO entries VALUES (?,?,?,?)", (event.receive_key, event.identity, status, reason))
            self._set("scan_cursor", max(self.value("scan_cursor"), event.receive_key))
            self._advance()
            return status
        return self._transaction(action)

    def ready_parts(self, identity: str) -> list[int]:
        return [row[0] for row in self.db.execute(
            "SELECT number FROM parts WHERE identity=? AND state='ready' ORDER BY number", (identity,))]

    def sending_parts(self, identity: str) -> list[int]:
        return [row[0] for row in self.db.execute(
            "SELECT number FROM parts WHERE identity=? AND state='sending' ORDER BY number", (identity,))]

    def status(self, identity: str) -> str | None:
        row = self.db.execute("SELECT status FROM deliveries WHERE identity=?", (identity,)).fetchone()
        return row[0] if row else None

    def attachment_issue(self, identity: str) -> str | None:
        row = self.db.execute("SELECT issue FROM attachment_issues WHERE identity=?", (identity,)).fetchone()
        return row[0] if row else None

    def replace_unattempted_plan(self, plan: Plan):
        """A confirmed local upload failure can retain text and hold media.
        Never change a plan with a delivered or uncertain HTTP result.
        """
        def action():
            self._scope()
            row = self.db.execute("SELECT digest,org_id,status FROM deliveries WHERE identity=?", (plan.event.identity,)).fetchone()
            if (not row or row[0] != plan.event.digest or row[1] != plan.org_id
                    or row[2] not in {"held", "planned"} or not plan.attachment_issue
                    or self.db.execute("SELECT count(*) FROM parts WHERE identity=? AND state<>'ready'", (plan.event.identity,)).fetchone()[0]):
                raise ValidationError("cannot_change_attempted_delivery_plan")
            self.db.execute("DELETE FROM parts WHERE identity=?", (plan.event.identity,))
            self.db.execute("UPDATE deliveries SET fingerprint=?,status='planned',part_count=? WHERE identity=?",
                            (plan.fingerprint, len(plan.parts), plan.event.identity))
            for part in plan.parts:
                self.db.execute("INSERT INTO parts VALUES (?,?,'ready',NULL)", (plan.event.identity, part.number))
            self.db.execute("INSERT INTO attachment_issues VALUES (?,?) ON CONFLICT(identity) DO UPDATE SET issue=excluded.issue",
                            (plan.event.identity, plan.attachment_issue))
            self.db.execute("UPDATE entries SET status='planned',reason='attachment_only_held' WHERE identity=? AND status IN ('held','planned')", (plan.event.identity,))
        self._transaction(action)

    def record_attempt(self, plan: Plan, number: int, operation: str, target_id: str):
        if operation not in {"thread", "message"} or not re.fullmatch(r"\d{17,20}", target_id):
            raise ValidationError("invalid_attempt_destination")
        def action():
            self._scope()
            if number not in self.sending_parts(plan.event.identity):
                raise ValidationError("attempt_without_durable_send_intent")
            self.db.execute("INSERT INTO attempts VALUES (?,?,?,?,?) ON CONFLICT(identity,number) DO NOTHING",
                (plan.event.identity, number, operation, target_id, datetime.now(timezone.utc).isoformat()))
        self._transaction(action)

    def rejected(self, plan: Plan, number: int, *, creating_thread: bool, status: int, retry_after=None):
        """Only call after an explicit HTTP rejection, never on unknown result."""
        def action():
            self._scope()
            if number not in self.sending_parts(plan.event.identity):
                raise ValidationError("rejection_without_send_intent")
            if status < 400 or status >= 500 or status in {408, 409}:
                raise ValidationError("uncertain_result_not_a_rejection")
            self.db.execute("UPDATE parts SET state='ready' WHERE identity=? AND number=?", (plan.event.identity, number))
            self.db.execute("DELETE FROM attempts WHERE identity=? AND number=?", (plan.event.identity, number))
            if creating_thread:
                self.db.execute("DELETE FROM threads WHERE org_id=? AND state='creating'", (plan.org_id,))
            if status == 429:
                import time
                if retry_after is None or not 0 < retry_after <= 86400:
                    retry_after_value = 60
                else:
                    retry_after_value = retry_after
                self._set("retry_not_before", str(time.time() + retry_after_value))
            else:
                self.db.execute("UPDATE deliveries SET status='held' WHERE identity=?", (plan.event.identity,))
                self.db.execute("UPDATE entries SET status='held',reason=? WHERE identity=? AND status='planned'",
                                (f"discord_http_{status}", plan.event.identity))
            self._advance()
        self._transaction(action)

    def has_review(self, plan: Plan, forum_id: str) -> bool:
        row = self.db.execute("SELECT event_digest,org_id,fingerprint,forum_id FROM reviews WHERE identity=?",
                              (plan.event.identity,)).fetchone()
        return row == (plan.event.digest, plan.org_id, plan.fingerprint, forum_id)

    def release(self, plan: Plan, approval, *, forum_id: str, approved_reviewers: frozenset[str], now=None):
        """One exact post-baseline held event. Review never includes raw text."""
        from review_controls import validate_review_candidate
        validate_review_candidate(plan)
        now = now or datetime.now(timezone.utc)
        if approval.reviewer_user_id not in approved_reviewers or approval.decision != "reviewed_non_sensitive":
            raise ValidationError("reviewer_or_decision_not_approved")
        try:
            reviewed = datetime.fromisoformat(approval.reviewed_at)
            age = (now - reviewed).total_seconds()
        except (TypeError, ValueError):
            raise ValidationError("invalid_review_time") from None
        if not -300 <= age <= 86400:
            raise ValidationError("review_expired_or_future")
        expected = (plan.event.receive_key, plan.event.identity, plan.event.digest,
                    plan.org_id, plan.fingerprint, forum_id)
        actual = (approval.receive_key, approval.identity, approval.event_digest,
                  approval.org_id, approval.plan_fingerprint, approval.forum_id)
        if actual != expected or plan.disposition != "planned" or not plan.parts or not plan.org_id or plan.attachment_issue:
            raise ValidationError("review_target_or_content_changed")
        def action():
            self._scope()
            if plan.event.receive_key <= self.value("baseline"):
                raise ValidationError("baseline_history_not_releasable")
            activation = self.value("activated_at")
            if activation and plan.event.sent_at < datetime.fromisoformat(activation):
                raise ValidationError("pre_activation_history_not_releasable")
            row = self.db.execute("SELECT digest,status FROM deliveries WHERE identity=?", (plan.event.identity,)).fetchone()
            entry = self.db.execute("SELECT identity,status,reason FROM entries WHERE key=?", (plan.event.receive_key,)).fetchone()
            if (row != (plan.event.digest, "held") or not entry or entry[:2] != (plan.event.identity, "held")
                    or entry[2] == "stable_id_content_conflict"):
                raise ValidationError("held_event_or_digest_not_releasable")
            if self.db.execute("SELECT count(*) FROM parts WHERE identity=? AND state<>'ready'", (plan.event.identity,)).fetchone()[0]:
                raise ValidationError("delivery_already_attempted_requires_reconciliation")
            self.db.execute("DELETE FROM parts WHERE identity=?", (plan.event.identity,))
            self.db.execute("DELETE FROM attachment_issues WHERE identity=?", (plan.event.identity,))
            self.db.execute("UPDATE deliveries SET org_id=?,fingerprint=?,status='planned',part_count=? WHERE identity=?",
                            (plan.org_id, plan.fingerprint, len(plan.parts), plan.event.identity))
            for part in plan.parts:
                self.db.execute("INSERT INTO parts VALUES (?,?,'ready',NULL)", (plan.event.identity, part.number))
            self.db.execute("INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?,?)", (plan.event.identity,
                plan.event.receive_key, plan.event.digest, plan.org_id, plan.fingerprint, forum_id,
                approval.reviewer_user_id, approval.reviewed_at, approval.decision))
            self.db.execute("UPDATE entries SET status='planned',reason='private_review_non_sensitive' WHERE key=?", (plan.event.receive_key,))
            self._advance()
        self._transaction(action)

    def begin_part(self, plan: Plan, number: int):
        self._transaction(lambda: self._begin_part(plan, number))

    def _begin_part(self, plan: Plan, number: int):
        self._scope()
        delivery = self.db.execute("SELECT fingerprint,status FROM deliveries WHERE identity=?", (plan.event.identity,)).fetchone()
        if not delivery or delivery[0] != plan.fingerprint or delivery[1] != "planned":
            raise ValidationError("delivery_not_ready_or_plan_changed")
        row = self.db.execute("SELECT state FROM parts WHERE identity=? AND number=?", (plan.event.identity, number)).fetchone()
        if not row or row[0] != "ready":
            raise ValidationError("part_not_ready_requires_reconciliation")
        earlier = self.db.execute("SELECT count(*) FROM parts WHERE identity=? AND number<? AND state<>'delivered'", (plan.event.identity, number)).fetchone()[0]
        if earlier:
            raise ValidationError("previous_part_unconfirmed")
        self.db.execute("UPDATE parts SET state='sending' WHERE identity=? AND number=?", (plan.event.identity, number))

    def receipt(self, identity: str, number: int, discord_message_id: str):
        self._transaction(lambda: self._receipt(identity, number, discord_message_id))

    def _receipt(self, identity: str, number: int, discord_message_id: str):
        if not re.fullmatch(r"\d{17,20}", discord_message_id):
            raise ValidationError("invalid_discord_receipt")
        self._scope()
        row = self.db.execute("SELECT state,discord_id FROM parts WHERE identity=? AND number=?", (identity, number)).fetchone()
        if not row:
            raise ValidationError("unknown_part")
        if row[0] == "delivered" and row[1] == discord_message_id:
            return
        if row[0] != "sending":
            raise ValidationError("receipt_without_send_or_conflicting_receipt")
        self.db.execute("UPDATE parts SET state='delivered',discord_id=? WHERE identity=? AND number=?", (discord_message_id, identity, number))
        pending = self.db.execute("SELECT count(*) FROM parts WHERE identity=? AND state<>'delivered'", (identity,)).fetchone()[0]
        if pending == 0:
            attachment_issue = self.db.execute("SELECT issue FROM attachment_issues WHERE identity=?", (identity,)).fetchone()
            status = "partial" if attachment_issue else "delivered"
            self.db.execute("UPDATE deliveries SET status=? WHERE identity=?", (status, identity))
            self.db.execute("UPDATE entries SET status=? WHERE identity=? AND status='planned'", (status, identity))
        self._advance()

    def begin_thread(self, plan: Plan, forum: dict, category: dict) -> str | None:
        """Persist creation intent and starter-part sending before a future POST.
        Returns an existing ready thread ID; otherwise the caller may create
        exactly once. Unknown outcomes require reconciliation, never re-create.
        """
        forum_id = validate_destination(forum, category)

        def action():
            self._scope()
            if plan.disposition != "planned" or not plan.org_id:
                raise ValidationError("thread_requires_verified_plan")
            previous = self.db.execute("SELECT forum_id,state,thread_id FROM threads WHERE org_id=?", (plan.org_id,)).fetchone()
            if previous:
                if previous[0] != forum_id:
                    raise ValidationError("organization_forum_changed")
                if previous[1] != "ready":
                    raise ValidationError("thread_creation_requires_reconciliation")
                return previous[2]
            self._begin_part(plan, 1)
            self.db.execute("INSERT INTO threads VALUES (?,?,'creating',NULL)", (plan.org_id, forum_id))
            return None
        return self._transaction(action)

    def thread_receipt(self, plan: Plan, channel: dict, starter_message_id: str):
        def action():
            self._scope()
            row = self.db.execute("SELECT forum_id,state,thread_id FROM threads WHERE org_id=?", (plan.org_id,)).fetchone()
            if (not row or channel.get("guild_id") != GUILD or channel.get("type") != 11
                    or channel.get("parent_id") != row[0]
                    or not re.fullmatch(r"\d{17,20}", str(channel.get("id", "")))):
                raise ValidationError("thread_receipt_wrong_destination")
            if row[1] == "ready" and row[2] != channel["id"]:
                raise ValidationError("thread_receipt_conflict")
            self._receipt(plan.event.identity, 1, starter_message_id)
            self.db.execute("UPDATE threads SET state='ready',thread_id=? WHERE org_id=?", (channel["id"], plan.org_id))
        self._transaction(action)

    def _advance(self):
        cursor = self.value("baseline")
        for key, status in self.db.execute("SELECT key,status FROM entries WHERE key>? ORDER BY key", (cursor,)):
            if status not in TERMINAL:
                break
            cursor = key
        # Recompute from baseline, because a late receive key may sort behind
        # an already-observed key. Actual duplicate prevention uses receipts.
        self._set("delivered_cursor", cursor)


if __name__ == "__main__":
    print("Preparation library only: no sending, credentials, service changes, or live state initialization.")
