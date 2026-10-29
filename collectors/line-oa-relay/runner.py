"""Official OA only. New events after a durable activation baseline.

Default config disables writes. The live process reads the existing Bot token,
checks the approved audience, and logs metadata counts without source text.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import dataclasses
import hashlib
import json
from pathlib import Path
import re
import time

from oa_relay import ACCOUNT, Binding, GUILD, Journal, Plan, Registry, ValidationError, read_store_events
from content_policy import POLICY_VERSION
from operating_policy import BOT, CATEGORY, plan_for_committee
from live_access import ADMIN_BOT_EXCEPTION, inspect_access
from credentials import existing_token
from discord_transport import DiscordAPI, OutcomeUnknown, Rejected
from delivery import Delivery
from review_controls import ReviewApproval, review_candidate, make_approval
from candidate_proofs import CandidateProofError, validate_candidates
from relay_site import SITE

STORE = SITE["store"]
MEDIA = STORE.parent / "media"
ROOT = Path.home() / "iyakusai/official-line-relay"
APPROVED_FORUM = SITE["approved_forum"]
LEGACY_ORGANIZATIONS = SITE["legacy_organizations"]


def read_contacts():
    path = Path.home() / "iyakusai/drive/line/raw/_oa_contacts.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("contacts", data)


def approved_scope(config):
    ids = config.get("approved_organization_ids", sorted(LEGACY_ORGANIZATIONS))
    if (not isinstance(ids, list) or any(not isinstance(x, str) or not re.fullmatch(r"[a-z0-9_]{1,40}", x) for x in ids)
            or len(ids) != len(set(ids)) or not LEGACY_ORGANIZATIONS.issubset(ids)):
        raise ValidationError("organization_approval_scope_invalid")
    cutoffs = config.get("organization_activation_times", {})
    if not isinstance(cutoffs, dict) or set(cutoffs) != set(ids) - LEGACY_ORGANIZATIONS:
        raise ValidationError("organization_activation_scope_invalid")
    parsed = {}
    for org_id, stamp in cutoffs.items():
        try:
            value = datetime.fromisoformat(stamp)
        except (TypeError, ValueError):
            raise ValidationError("organization_activation_time_invalid") from None
        if value.tzinfo is None:
            raise ValidationError("organization_activation_time_invalid")
        parsed[org_id] = value
    if cutoffs and not config.get("mapping_approval_revision"):
        raise ValidationError("organization_approval_revision_missing")
    return frozenset(ids), parsed


def load_registry(events, specs, contacts, *, approved_org_ids=None):
    approved = LEGACY_ORGANIZATIONS if approved_org_ids is None else frozenset(approved_org_ids)
    if not isinstance(specs, list) or any(not isinstance(spec, dict) for spec in specs):
        raise ValidationError("organization_specs_invalid")
    indexed = {event.receive_key: event for event in events}
    bindings = []
    legacy = [spec for spec in specs if "evidence_key" in spec]
    additional = [spec for spec in specs if "evidence_key" not in spec]
    for spec in legacy:
        if (set(spec) != {"org_id", "org_name", "source_fingerprint", "evidence_key"}
                or spec["org_id"] not in LEGACY_ORGANIZATIONS or spec["org_id"] not in approved):
            raise ValidationError("legacy_organization_not_approved")
        evidence = indexed.get(spec["evidence_key"])
        if (evidence is None or evidence.source_type != "user"
                or evidence.event_type != "message"
                or hashlib.sha256(evidence.source_id.encode()).hexdigest()[:12] != spec["source_fingerprint"]
                or evidence.source_id in contacts
                or not re.search(re.escape(spec["org_name"]) + r"の[^。\n]{1,40}(?:です|と申します|といいます)", evidence.text)):
            raise ValidationError("organization_evidence_scope_changed")
        bindings.append(Binding(evidence.source_type, evidence.source_id, spec["org_id"], spec["org_name"],
            True, "oa-store:" + evidence.receive_key, "source-reviewed"))
    try:
        checked = validate_candidates(additional, indexed, approved)
    except CandidateProofError as error:
        raise ValidationError("candidate_proof_" + error.code) from None
    for item in checked:
        if item["source_id"] in contacts:
            raise ValidationError("candidate_internal_person_excluded")
        bindings.append(Binding(item["source_type"], item["source_id"], item["org_id"], item["org_name"],
            True, "oa-store:" + item["evidence"], item["reviewed_by"]))
    return Registry(bindings)


def validate_config(config):
    if (config.get("mode") != "live" or config.get("official_account") != ACCOUNT
            or config.get("guild_id") != GUILD or config.get("bot_user_id") != BOT
            or config.get("parent_category_id") != CATEGORY
            or config.get("access_policy_approved") is not True
            or config.get("mapping_approved") is not True
            or config.get("sensitive_content_policy") != POLICY_VERSION
            or config.get("approved_admin_bot_exceptions") != [ADMIN_BOT_EXCEPTION]
            or config.get("destination_forum_id") != APPROVED_FORUM
            or config.get("max_attachment_bytes") != 10485760):
        raise ValidationError("live_config_not_explicitly_approved")
    approved_scope(config)
    return config["destination_forum_id"]


def process_cycle(events, registry, contacts, media_root, journal, delivery, *, max_seconds=45,
                  organization_activation_times=None):
    deadline = time.monotonic() + max_seconds
    outcomes = Counter()
    activation = datetime.fromisoformat(journal.value("activated_at"))
    cutoffs = organization_activation_times or {}
    for event in sorted(events, key=lambda e: e.receive_key):
        # Ignore observed history. A re-delivery's stable ID is seeded too.
        if event.receive_key <= journal.value("baseline"):
            outcomes["baseline_ignored"] += 1
            continue
        if event.source_id in contacts:
            plan = Plan(event, "held", "internal_person_excluded", None, None, ())
        elif event.sent_at < activation:
            plan = Plan(event, "held", "pre_activation_history", None, None, ())
        else:
            binding = registry.resolve(event)
            if binding and binding.org_id in cutoffs and event.sent_at < cutoffs[binding.org_id]:
                plan = Plan(event, "held", "pre_organization_activation_history", binding.org_id, None, ())
            else:
                plan = plan_for_committee(event, registry, media_root,
                    force_attachment_issue=journal.attachment_issue(event.identity))
        status = journal.register(plan)
        if status != "planned":
            outcomes[status] += 1
            continue
        # A single exact reviewed item may have a plan that differs from the
        # automated held plan. Always re-read/re-hash that event and its media.
        if plan.disposition != "planned":
            plan = review_candidate(event, registry, media_root)
            if not journal.has_review(plan, delivery.forum_id):
                raise ValidationError("reviewed_queue_changed_or_wrong_target")
        if time.monotonic() >= deadline:
            outcomes["queued_for_next_cycle"] += 1
            continue
        try:
            result = delivery.dispatch(plan)
        except Rejected:
            result = "readback_rate_limit_or_rejection"
        except OutcomeUnknown:
            result = "readback_unavailable"
        outcomes[result] += 1
    return dict(outcomes)


def summary(journal):
    return {"activated_at": journal.value("activated_at"), "baseline": journal.value("baseline"),
            "scan_cursor": journal.value("scan_cursor"), "delivered_cursor": journal.value("delivered_cursor"),
            "events_by_status": dict(journal.db.execute("SELECT status,count(*) FROM entries GROUP BY status")),
            "confirmed_parts": journal.db.execute("SELECT count(*) FROM parts WHERE state='delivered'").fetchone()[0],
            "unconfirmed_parts": journal.db.execute("SELECT count(*) FROM parts WHERE state='sending'").fetchone()[0],
            "organization_threads": journal.db.execute("SELECT count(*) FROM threads WHERE state='ready'").fetchone()[0]}


def run_once(config, specs, *, activate=False):
    forum_id = validate_config(config)
    api = DiscordAPI(existing_token(), writes_enabled=True)
    _, forum, category, access = inspect_access(api, config["known_member_ids"], forum_id=forum_id,
        approved_admin_bots=frozenset(config["approved_admin_bot_exceptions"]))
    events = list(read_store_events(STORE))
    contacts = read_contacts()
    approved, cutoffs = approved_scope(config)
    registry = load_registry(events, specs, contacts, approved_org_ids=approved)
    journal = Journal(ROOT / "relay.sqlite")
    try:
        if journal.value("account") is None:
            if activate is not True:
                raise ValidationError("explicit_baseline_activation_required")
            journal.initialize(events, activated_at=datetime.now(timezone.utc))
        elif activate:
            raise ValidationError("already_activated_baseline_must_not_reset")
        delivery = Delivery(api, journal, forum, category, MEDIA)
        outcomes = process_cycle(events, registry, contacts, MEDIA, journal, delivery,
            organization_activation_times=cutoffs)
        return {"check": "official_line_cycle", "observed_at": datetime.now(timezone.utc).isoformat(),
                "forum_id": forum_id, "policy_version": POLICY_VERSION,
                "verified_organization_count": len({b.org_id for b in registry.bindings.values()}),
                "mapping_approval_revision": config.get("mapping_approval_revision", "original-four"),
                "audience": access, "outcomes": outcomes, "state": summary(journal)}
    finally:
        journal.close()


def release_one(config, specs, receive_key, reviewer_user_id):
    forum_id = validate_config(config)
    if reviewer_user_id not in config.get("reviewer_user_ids", []):
        raise ValidationError("private_reviewer_not_designated")
    events = list(read_store_events(STORE))
    contacts = read_contacts()
    approved, cutoffs = approved_scope(config)
    registry = load_registry(events, specs, contacts, approved_org_ids=approved)
    event = next((e for e in events if e.receive_key == receive_key), None)
    if not event or event.source_id in contacts:
        raise ValidationError("review_event_missing_or_internal")
    binding = registry.resolve(event)
    if binding and binding.org_id in cutoffs and event.sent_at < cutoffs[binding.org_id]:
        raise ValidationError("pre_organization_activation_history")
    plan = review_candidate(event, registry, MEDIA)
    approval = make_approval(plan, forum_id, reviewer_user_id, reviewed_non_sensitive=True)
    journal = Journal(ROOT / "relay.sqlite")
    try:
        journal.release(plan, approval, forum_id=forum_id, approved_reviewers=frozenset(config["reviewer_user_ids"]))
        return {"check": "single_review_release", "receive_key": receive_key,
                "org_id": plan.org_id, "forum_id": forum_id, "result": "queued_after_private_review", "messages_sent": 0}
    finally:
        journal.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--activate", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--hold-list", action="store_true")
    parser.add_argument("--release-key")
    parser.add_argument("--reviewer-user-id")
    parser.add_argument("--confirm-reviewed-non-sensitive", action="store_true")
    args = parser.parse_args()
    import fcntl
    with (ROOT / "runner.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        specs = json.loads((ROOT / "verified-org-specs.json").read_text(encoding="utf-8"))
        if args.status or args.hold_list:
            path = ROOT / "relay.sqlite"
            if not path.exists():
                raise ValidationError("not_activated")
            journal = Journal(path)
            try:
                if args.status:
                    result = summary(journal)
                else:
                    result = [{"receive_key": key, "org_id": org, "reason": reason}
                        for key, org, reason in journal.db.execute("SELECT e.key,d.org_id,coalesce(a.issue,e.reason) FROM entries e JOIN deliveries d ON e.identity=d.identity LEFT JOIN attachment_issues a ON e.identity=a.identity WHERE e.status IN ('held','partial') ORDER BY e.key")]
            finally:
                journal.close()
        elif args.release_key:
            if not args.confirm_reviewed_non_sensitive or not args.reviewer_user_id or args.activate:
                raise ValidationError("explicit_private_review_confirmation_required")
            result = release_one(config, specs, args.release_key, args.reviewer_user_id)
        else:
            result = run_once(config, specs, activate=args.activate)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValidationError, Rejected, OutcomeUnknown, OSError, ValueError, BlockingIOError) as error:
        # Errors contain codes only, never source data or credential values.
        code = str(error) if isinstance(error, (ValidationError, Rejected, OutcomeUnknown)) else type(error).__name__
        print(json.dumps({"check": "official_line_cycle", "stopped": True, "reason": code}))
        raise SystemExit(1)
