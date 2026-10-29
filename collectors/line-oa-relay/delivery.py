"""Durable, sequential delivery and positive reconciliation of uncertain sends."""
import re
import sqlite3
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import PurePosixPath

from oa_relay import GUILD, ValidationError, validate_destination
from operating_policy import BOT, content_gate
from discord_transport import OutcomeUnknown, Rejected
from content_policy import prepare_outgoing
from attachment_receipts import download_verified_attachment, validate_positive_receipt


def validate_message(message, thread_id, part):
    """Legacy metadata-only probe; live delivery uses full positive receipts."""
    if (not isinstance(message, dict) or message.get("author", {}).get("id") != BOT
            or message.get("channel_id") != thread_id
            or message.get("content") != part.content
            or not re.fullmatch(r"\d{17,20}", str(message.get("id", "")))):
        raise ValidationError("receipt_author_destination_or_content_mismatch")
    attachments = message.get("attachments", [])
    if part.attachment:
        if len(attachments) != 1 or not isinstance(attachments[0], dict):
            raise ValidationError("receipt_attachment_mismatch")
        received = attachments[0]
        expected_name = part.attachment.name
        # The live API replaces Japanese filenames with a 16-hex basename,
        # retaining the original stem in the documented attachment.title.
        # Match that observed form exactly; size, author, body and destination
        # remain mandatory, and a missing/wrong title never confirms a send.
        expected_path = PurePosixPath(expected_name)
        normalized_name = (
            received.get("title") == expected_path.stem
            and bool(re.fullmatch(r"[0-9a-f]{16}" + re.escape(expected_path.suffix),
                                  str(received.get("filename", ""))))
        )
        if (received.get("filename") != expected_name and not normalized_name
                or received.get("size") != part.attachment.size):
            raise ValidationError("receipt_attachment_mismatch")
    elif attachments:
        raise ValidationError("receipt_unexpected_attachment")
    return message["id"]


class Delivery:
    def __init__(self, api, journal, forum, category, media_root, *, attachment_reader=download_verified_attachment):
        self.api, self.journal = api, journal
        self.forum, self.category, self.media_root = forum, category, media_root
        self.forum_id = validate_destination(forum, category)
        self.attachment_reader = attachment_reader
        self._receipt_proofs = {}
        self.journal.db.execute("""CREATE TABLE IF NOT EXISTS delivery_attachment_receipts (
            identity TEXT NOT NULL, number INTEGER NOT NULL, discord_id TEXT NOT NULL,
            source_size INTEGER NOT NULL, source_sha256 TEXT NOT NULL,
            received_size INTEGER NOT NULL, received_sha256 TEXT NOT NULL,
            method TEXT NOT NULL, verified_at TEXT NOT NULL,
            PRIMARY KEY(identity,number))""")

    def _positive_receipt(self, message, thread_id, part):
        return validate_positive_receipt(message, thread_id, part,
            media_root=self.media_root, downloader=self.attachment_reader)

    def _record_attachment_proof(self, plan, part, message_id, proof):
        if not part.attachment:
            return
        if (not isinstance(proof, dict) or proof.get("source_size") != part.attachment.size
                or proof.get("source_sha256") != part.attachment.sha256
                or type(proof.get("received_size")) is not int
                or not 0 < proof["received_size"] <= 10 * 1024 * 1024
                or not re.fullmatch(r"[0-9a-f]{64}", str(proof.get("received_sha256", "")))
                or proof.get("method") not in {"exact_bytes", "jpeg_safe_metadata_only"}):
            raise ValidationError("receipt_attachment_proof_invalid")
        self.journal.db.execute("""INSERT INTO delivery_attachment_receipts VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(identity,number) DO UPDATE SET discord_id=excluded.discord_id,
            source_size=excluded.source_size,source_sha256=excluded.source_sha256,
            received_size=excluded.received_size,received_sha256=excluded.received_sha256,
            method=excluded.method,verified_at=excluded.verified_at""",
            (plan.event.identity, part.number, message_id, proof["source_size"], proof["source_sha256"],
             proof["received_size"], proof["received_sha256"], proof["method"],
             datetime.now(timezone.utc).isoformat()))

    def _record_cached_proof(self, plan, part, message_id):
        # _matching_messages validates bytes before returning a unique match.
        # Subclasses with their own positive verifier retain their own ledger.
        if message_id in self._receipt_proofs:
            self._record_attachment_proof(plan, part, message_id, self._receipt_proofs.pop(message_id))

    def _current_plan(self, plan):
        allowed, _ = content_gate(plan)
        if not allowed and not self.journal.has_review(plan, self.forum_id):
            raise ValidationError("delivery_content_not_screened_or_reviewed")
        row = self.journal.db.execute("SELECT fingerprint,status FROM deliveries WHERE identity=?", (plan.event.identity,)).fetchone()
        if not row or row[0] != plan.fingerprint or row[1] not in {"planned", "delivered"}:
            raise ValidationError("delivery_plan_not_current")

    def _valid_thread(self, thread):
        if (thread.get("guild_id") != GUILD or thread.get("type") != 11
                or thread.get("parent_id") != self.forum_id
                or not re.fullmatch(r"\d{17,20}", str(thread.get("id", "")))):
            raise ValidationError("thread_outside_approved_forum")

    def dispatch(self, plan):
        """Returns a status code only. No source body is logged or returned."""
        self._current_plan(plan)
        if self.journal.status(plan.event.identity) == "delivered":
            return "delivered"
        not_before = self.journal.value("retry_not_before")
        if not_before and time.time() < float(not_before):
            return "rate_limited"
        if self.journal.sending_parts(plan.event.identity):
            self.reconcile(plan)
            if self.journal.sending_parts(plan.event.identity):
                return "unknown"
            if self.journal.status(plan.event.identity) == "delivered":
                return "delivered"
        thread_row = self.journal.db.execute("SELECT state FROM threads WHERE org_id=?", (plan.org_id,)).fetchone()
        if thread_row and thread_row[0] == "creating":
            return "organization_thread_unconfirmed"
        thread_id = self.journal.begin_thread(plan, self.forum, self.category)
        if thread_id is None:
            self.journal.record_attempt(plan, 1, "thread", self.forum_id)
            outcome = self._submit(plan, plan.parts[0], creating=True)
            if outcome == "upload_or_request_validation_failed" and plan.parts[0].attachment:
                revised = prepare_outgoing(plan, force_attachment_issue="local_upload_validation_failed")
                self.journal.replace_unattempted_plan(revised)
                return self.dispatch(revised)
            if outcome != "confirmed":
                return outcome
            thread_id = self.journal.db.execute("SELECT thread_id FROM threads WHERE org_id=?", (plan.org_id,)).fetchone()[0]
        thread = self.api.get(f"/channels/{thread_id}")
        self._valid_thread(thread)
        metadata = thread.get("thread_metadata", {})
        if metadata.get("locked"):
            return "thread_locked"
        if metadata.get("archived"):
            thread = self.api.request("PATCH", f"/channels/{thread_id}", payload={"archived": False})
            self._valid_thread(thread)
            if thread.get("thread_metadata", {}).get("archived"):
                return "thread_archived"
        for number in self.journal.ready_parts(plan.event.identity):
            part = plan.parts[number - 1]
            self.journal.begin_part(plan, number)
            self.journal.record_attempt(plan, number, "message", thread_id)
            outcome = self._submit(plan, part, creating=False, thread_id=thread_id)
            if outcome == "upload_or_request_validation_failed" and part.attachment:
                revised = prepare_outgoing(plan, force_attachment_issue="local_upload_validation_failed")
                self.journal.replace_unattempted_plan(revised)
                return self.dispatch(revised)
            if outcome != "confirmed":
                return outcome
        return self.journal.status(plan.event.identity)

    def _submit(self, plan, part, *, creating, thread_id=None):
        try:
            if creating:
                result = self.api.create_forum_thread(self.forum_id, plan, self.media_root)
            else:
                result = self.api.create_message(thread_id, plan, part, self.media_root)
        except Rejected as error:
            self.journal.rejected(plan, part.number, creating_thread=creating,
                                  status=error.status, retry_after=error.retry_after)
            return "rate_limited" if error.status == 429 else "rejected"
        except OutcomeUnknown:
            return "unknown"
        except (ValidationError, OSError):
            # Upload validation failed before HTTP dispatch. The exact bytes
            # inspected in the plan are mandatory; never send changed media.
            self.journal.rejected(plan, part.number, creating_thread=creating, status=400)
            return "upload_or_request_validation_failed"
        try:
            if creating:
                self._valid_thread(result)
                message_id, proof = self._positive_receipt(result.get("message"), result["id"], part)
                self._record_attachment_proof(plan, part, message_id, proof)
                self.journal.thread_receipt(plan, result, message_id)
            else:
                message_id, proof = self._positive_receipt(result, thread_id, part)
                self._record_attachment_proof(plan, part, message_id, proof)
                self.journal.receipt(plan.event.identity, part.number, message_id)
        except (ValidationError, OSError, TypeError, KeyError, sqlite3.Error):
            # The POST may have succeeded. Do not reset the durable intent.
            return "unknown"
        return "confirmed"

    def _messages(self, thread_id):
        before = None
        for _ in range(20):
            path = f"/channels/{thread_id}/messages?limit=100"
            if before:
                path += "&before=" + before
            page = self.api.get(path)
            if not isinstance(page, list):
                raise ValidationError("message_reconciliation_response_invalid")
            for message in page:
                yield message
            if len(page) < 100:
                break
            following = str(page[-1].get("id", ""))
            if not re.fullmatch(r"\d{17,20}", following) or following == before:
                break
            before = following
        # An exhausted or incomplete search never establishes non-delivery.

    def _matching_messages(self, thread_id, part):
        candidates = [m for m in self._messages(thread_id) if isinstance(m, dict)
            and isinstance(m.get("author"), dict) and m["author"].get("id") == BOT
            and m.get("channel_id") == thread_id and m.get("content") == part.content]
        # An invalid attachment on a duplicate body must not hide ambiguity.
        if len(candidates) > 1:
            return candidates
        found = []
        for message in candidates:
            try:
                message_id, proof = self._positive_receipt(message, thread_id, part)
            except (ValidationError, OSError, KeyError, TypeError):
                continue
            self._receipt_proofs[message_id] = proof
            found.append(message)
        return found

    def _candidate_threads(self, plan):
        active = self.api.get(f"/guilds/{GUILD}/threads/active")
        found = {x["id"]: x for x in active.get("threads", [])
                 if x.get("parent_id") == self.forum_id and x.get("name", "").casefold() == plan.thread_name.casefold()}
        before = None
        for _ in range(20):
            path = f"/channels/{self.forum_id}/threads/archived/public?limit=100"
            if before:
                path += "&before=" + urllib.parse.quote(before, safe="")
            page = self.api.get(path)
            threads = page.get("threads", [])
            for thread in threads:
                if thread.get("parent_id") == self.forum_id and thread.get("name", "").casefold() == plan.thread_name.casefold():
                    found[thread["id"]] = thread
            if not page.get("has_more") or not threads:
                break
            following = threads[-1].get("thread_metadata", {}).get("archive_timestamp")
            if not following or following == before:
                break
            before = following
        return list(found.values())

    def reconcile(self, plan):
        """GET only. A missing marker never permits another POST."""
        self._current_plan(plan)
        row = self.journal.db.execute("SELECT state,thread_id FROM threads WHERE org_id=?", (plan.org_id,)).fetchone()
        if row and row[0] == "creating":
            matches = []
            for candidate in self._candidate_threads(plan):
                thread = self.api.get(f"/channels/{candidate['id']}")
                self._valid_thread(thread)
                messages = self._matching_messages(thread["id"], plan.parts[0])
                if len(messages) > 1:
                    return "ambiguous_receipts"
                if messages:
                    matches.append((thread, messages[0]))
            if len(matches) != 1:
                return "unknown" if not matches else "ambiguous_receipts"
            thread, message = matches[0]
            self._record_cached_proof(plan, plan.parts[0], message["id"])
            self.journal.thread_receipt(plan, thread, message["id"])
            row = ("ready", thread["id"])
        if not row or row[0] != "ready":
            return "unknown"
        thread = self.api.get(f"/channels/{row[1]}")
        self._valid_thread(thread)
        for number in self.journal.sending_parts(plan.event.identity):
            found = self._matching_messages(row[1], plan.parts[number - 1])
            if len(found) != 1:
                return "unknown" if not found else "ambiguous_receipts"
            self._record_cached_proof(plan, plan.parts[number - 1], found[0]["id"])
            self.journal.receipt(plan.event.identity, number, found[0]["id"])
        return "reconciled"
