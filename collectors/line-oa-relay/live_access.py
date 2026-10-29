"""Readback and exact-scope checks for the approved committee audience."""
from collections import Counter
from oa_relay import GUILD, ValidationError, validate_destination
from operating_policy import ADMIN, BOT, CATEGORY, COMMITTEE_ROLES, forum_proposal, visibility_report
from relay_site import SITE

ADMIN_BOT_EXCEPTION = SITE["admin_bot_exception"]


def normalized_overwrites(items):
    return sorted((str(x["id"]), int(x["type"]), int(x["allow"]), int(x["deny"])) for x in items)


def inspect_access(api, known_member_ids, *, forum_id=None, approved_admin_bots=frozenset()):
    me = api.get("/users/@me")
    if me.get("id") != BOT:
        raise ValidationError("wrong_bot_identity")
    roles = api.get(f"/guilds/{GUILD}/roles")
    guild = api.get(f"/guilds/{GUILD}")
    if guild.get("id") != GUILD:
        raise ValidationError("guild_readback_mismatch")
    if guild.get("owner_id") not in set(known_member_ids):
        raise ValidationError("guild_owner_not_in_verified_member_scope")
    counts = api.get(f"/guilds/{GUILD}/roles/member-counts")
    category = api.get(f"/channels/{CATEGORY}")
    if category.get("guild_id") != GUILD or category.get("type") != 4:
        raise ValidationError("parent_category_changed")
    members = []
    for member_id in sorted(set(known_member_ids) | {BOT, ADMIN_BOT_EXCEPTION}):
        member = api.get(f"/guilds/{GUILD}/members/{member_id}")
        if member.get("user", {}).get("id") != member_id:
            raise ValidationError("member_readback_mismatch")
        members.append({"id": member_id, "roles": member["roles"], "bot": member["user"].get("bot", False),
                        "owner": member_id == guild.get("owner_id")})
    observed = Counter(r for m in members for r in m["roles"])
    watched = COMMITTEE_ROLES | {r["id"] for r in roles if int(r["permissions"]) & ADMIN}
    if any(observed[r] != counts.get(r, 0) for r in watched):
        raise ValidationError("committee_or_administrator_membership_changed")
    proposal = forum_proposal(roles, members)
    forum = api.get(f"/channels/{forum_id}") if forum_id else None
    if forum:
        validate_destination(forum, category)
        if forum.get("name", "").casefold() != proposal["name"].casefold() or normalized_overwrites(forum.get("permission_overwrites", [])) != normalized_overwrites(proposal["permission_overwrites"]):
            raise ValidationError("forum_permissions_or_name_changed")
    report = visibility_report(roles, members, forum or proposal,
                               approved_admin_bots=approved_admin_bots)
    report.update(verified_member_ids=len(members), all_committee_and_admin_members_accounted=True,
                  approved_admin_bot_exceptions=sorted(approved_admin_bots))
    if not report["ready"]:
        raise ValidationError("audience_readback_not_approved")
    return proposal, forum, category, report
