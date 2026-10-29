"""Committee-only ACL proposal and conservative non-sensitive content gate.

These are pure functions. No Discord changes, files, or credentials are written.
"""
import re
import dataclasses
import hashlib

from oa_relay import GUILD, Plan, ValidationError, plan_event
from content_policy import screen_plan, prepare_outgoing
from relay_site import SITE


BOT = SITE["bot"]
CATEGORY = SITE["category"]
COMMITTEE_ROLES = SITE["committee_roles"]
VIEW = 1 << 10
READ = 1 << 16
SEND = 1 << 11
IN_THREADS = 1 << 38
ATTACH = 1 << 15
ADMIN = 1 << 3
INTERNAL_SOURCE_FINGERPRINTS = SITE["internal_source_fingerprints"]
READ_FLAGS = VIEW | READ
WRITE_FLAGS = SEND | IN_THREADS


def forum_proposal(roles: list[dict], members: list[dict]) -> dict:
    present = {role["id"] for role in roles}
    if not COMMITTEE_ROLES.issubset(present):
        raise ValidationError("committee_role_set_changed")
    overwrites = [{"id": GUILD, "type": 0, "allow": "0", "deny": str(VIEW | WRITE_FLAGS)}]
    overwrites += [{"id": role, "type": 0, "allow": str(READ_FLAGS), "deny": "0"}
                   for role in sorted(COMMITTEE_ROLES)]
    overwrites += [{"id": member["id"], "type": 1, "allow": "0", "deny": str(VIEW)}
                   for member in members if member["bot"] and member["id"] != BOT]
    overwrites.append({"id": BOT, "type": 1,
                       "allow": str(READ_FLAGS | WRITE_FLAGS | ATTACH), "deny": "0"})
    return {"name": "公式LINE転送", "type": 15, "parent_id": CATEGORY,
            "topic": "公式LINEの新着本文・通常添付を内容選別せず共有します。検出した認証情報は該当部分を伏せ、安全に処理できない添付だけ保留して原文確認を案内します。団体未確定は保持。過去履歴は一括投稿しません。",
            "permission_overwrites": overwrites,
            "default_auto_archive_duration": 10080}


def effective_permissions(member: dict, roles: list[dict], overwrites: list[dict]) -> int:
    role_permissions = {role["id"]: int(role["permissions"]) for role in roles}
    permissions = role_permissions[GUILD]
    for role_id in member["roles"]:
        permissions |= role_permissions.get(role_id, 0)
    if member.get("owner") or permissions & ADMIN:
        return (1 << 64) - 1
    everyone = next((item for item in overwrites if item["type"] == 0 and item["id"] == GUILD), None)
    if everyone:
        permissions = (permissions & ~int(everyone["deny"])) | int(everyone["allow"])
    allow = deny = 0
    for item in overwrites:
        if item["type"] == 0 and item["id"] in member["roles"]:
            allow |= int(item["allow"])
            deny |= int(item["deny"])
    permissions = (permissions & ~deny) | allow
    personal = next((item for item in overwrites if item["type"] == 1 and item["id"] == member["id"]), None)
    if personal:
        permissions = (permissions & ~int(personal["deny"])) | int(personal["allow"])
    return permissions


def visibility_report(roles: list[dict], members: list[dict], proposal: dict,
                      *, approved_admin_bots: frozenset[str] = frozenset()) -> dict:
    report = {"committee_readers": 0, "committee_blocked": [], "other_humans_visible": [],
              "other_bots_visible": [], "bot_can_post": False, "committee_administrative_writers": 0}
    for member in members:
        permissions = effective_permissions(member, roles, proposal["permission_overwrites"])
        visible = bool(permissions & VIEW)
        if member["id"] == BOT:
            report["bot_can_post"] = all(permissions & flag for flag in [VIEW, READ, SEND, IN_THREADS, ATTACH])
        elif member["bot"]:
            if visible and member["id"] not in approved_admin_bots:
                report["other_bots_visible"].append(member["id"])
        elif COMMITTEE_ROLES.intersection(member["roles"]):
            if visible:
                report["committee_readers"] += 1
                if permissions & WRITE_FLAGS:
                    report["committee_administrative_writers"] += 1
            else:
                report["committee_blocked"].append(member["id"])
        elif visible:
            report["other_humans_visible"].append(member["id"])
    # A synthetic new non-committee account verifies @everyone itself is denied.
    outsider = {"id": "9999999999999999999", "roles": [], "bot": False}
    report["everyone_denied"] = not bool(effective_permissions(outsider, roles, proposal["permission_overwrites"]) & VIEW)
    report["ready"] = (report["everyone_denied"] and report["bot_can_post"]
        and not report["committee_blocked"] and not report["other_humans_visible"]
        and not report["other_bots_visible"])
    return report


def content_gate(plan: Plan) -> tuple[bool, str]:
    decision = screen_plan(plan)
    return decision.allowed, ",".join(decision.codes)


def plan_for_committee(event, registry, media_root, *, force_attachment_issue=None, **kwargs) -> Plan:
    """The future live runner must use this entry point, before Journal.register.
    Unsafe text never produces queued parts or a thread-creation intent.
    """
    fingerprint = hashlib.sha256(event.source_id.encode()).hexdigest()[:12]
    if fingerprint in INTERNAL_SOURCE_FINGERPRINTS:
        return Plan(event, "held", "internal_person_excluded", None, None, ())
    try:
        plan = plan_event(event, registry, media_root, **kwargs)
    except (ValueError, OSError) as error:
        if event.kind not in {"image", "file", "video", "audio"} or registry.resolve(event) is None or str(error) == "invalid_attachment_limit":
            raise
        # A malformed or inaccessible attachment must not suppress the ordinary
        # caption. No unsafe path is opened in this fallback.
        fallback = dataclasses.replace(event, media_error=True)
        plan = dataclasses.replace(plan_event(fallback, registry, media_root, **kwargs),
                                   event=event, attachment_issue="source_media_validation_failed")
    plan = prepare_outgoing(plan, force_attachment_issue=force_attachment_issue)
    allowed, reason = content_gate(plan)
    if allowed:
        return plan
    if plan.disposition == "policy_skipped":
        return plan
    return dataclasses.replace(plan, disposition="held", reason=reason,
                               thread_name=None, parts=())
