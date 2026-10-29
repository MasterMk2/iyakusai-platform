"""Single-event private review. Approval is bound to exact content and target.

This module does not send. It never releases baseline history, unverified
organizations, credential material, incomplete media, or executable content.
"""
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import hashlib
import re

from oa_relay import ValidationError, plan_event
from content_policy import HARD_REVIEW_BLOCKS, screen_plan, suspicion_codes
from operating_policy import INTERNAL_SOURCE_FINGERPRINTS


@dataclass(frozen=True)
class ReviewApproval:
    receive_key: str
    identity: str
    event_digest: str
    org_id: str
    plan_fingerprint: str
    forum_id: str
    reviewer_user_id: str
    reviewed_at: str
    decision: str

    def metadata(self):
        return asdict(self)


def validate_review_candidate(plan):
    event = plan.event
    if hashlib.sha256(event.source_id.encode()).hexdigest()[:12] in INTERNAL_SOURCE_FINGERPRINTS:
        raise ValidationError("internal_person_excluded")
    if event.event_type != "message" or event.kind not in {"text", "file", "image", "video", "audio"}:
        raise ValidationError("review_event_type_not_supported")
    if plan.disposition != "planned" or not plan.org_id or not plan.parts:
        raise ValidationError("review_requires_verified_organization")
    if plan.attachment_issue:
        raise ValidationError("review_requires_complete_attachment")
    # A false-positive prose cue or a PDF/photo can be checked privately by a
    # human. Recognizable key/token bytes and executable files remain blocked.
    codes = set(suspicion_codes(event.text))
    for part in plan.parts:
        if part.attachment:
            codes.update(suspicion_codes(part.attachment.name))
    codes.update(screen_plan(plan).codes)
    if codes & HARD_REVIEW_BLOCKS:
        raise ValidationError("credential_or_unsafe_material_not_releasable")
    return plan


def review_candidate(event, registry, media_root, **kwargs):
    return validate_review_candidate(plan_event(event, registry, media_root, **kwargs))


def make_approval(plan, forum_id: str, reviewer_user_id: str, *, reviewed_non_sensitive: bool, now=None):
    validate_review_candidate(plan)
    if reviewed_non_sensitive is not True:
        raise ValidationError("explicit_non_sensitive_review_missing")
    if not re.fullmatch(r"\d{17,20}", forum_id) or not re.fullmatch(r"\d{17,20}", reviewer_user_id):
        raise ValidationError("invalid_review_target_or_reviewer")
    if plan.disposition != "planned" or not plan.org_id:
        raise ValidationError("review_requires_candidate_plan")
    now = now or datetime.now(timezone.utc)
    return ReviewApproval(plan.event.receive_key, plan.event.identity, plan.event.digest,
        plan.org_id, plan.fingerprint, forum_id, reviewer_user_id, now.isoformat(), "reviewed_non_sensitive")
