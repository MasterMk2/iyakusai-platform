"""Approved organizational threads with a clearly labeled safe setup notice.

No historical LINE body is used. A durable intent and verified setup marker
prevent duplicate thread creation after uncertain HTTP outcomes.
"""
from datetime import datetime, timezone
import time

from oa_relay import GUILD, Part, ValidationError, canonical_hash, safe_name, validate_destination
from operating_policy import BOT
from discord_transport import OutcomeUnknown, Rejected
from delivery import validate_message


def setup_values(binding, forum_id):
    if binding.verified is not True or not binding.evidence or not binding.verified_by:
        raise ValidationError("bootstrap_requires_verified_organization")
    name = f"{binding.org_id}｜{safe_name(binding.org_name.replace('@', '＠'))}"[:100]
    marker = "oa-setup:" + canonical_hash([GUILD, forum_id, binding.org_id, "v1"])[:24]
    content = ("公式LINE転送の開始案内（LINEの受信原文ではありません）。\n"
               + binding.org_name + "の新着本文・添付を、このスレッドへ転送します。\n"
               "過去のLINE履歴は投稿しません。認証情報の値は伏せ、必要な添付確認は原文で案内します。\n"
               f"[{marker}]")
    return name, Part(1, content, marker, None)


def check_channel(channel, forum_id, name):
    if (channel.get("guild_id") != GUILD or channel.get("parent_id") != forum_id
            or channel.get("type") != 11 or channel.get("name", "").casefold() != name.casefold()):
        raise ValidationError("bootstrap_thread_wrong_destination")


def candidates(api, forum_id, name):
    active = api.get(f"/guilds/{GUILD}/threads/active")
    found = {x["id"]: x for x in active.get("threads", []) if x.get("parent_id") == forum_id and x.get("name", "").casefold() == name.casefold()}
    before = None
    from urllib.parse import quote
    for _ in range(20):
        path = f"/channels/{forum_id}/threads/archived/public?limit=100"
        if before:
            path += "&before=" + quote(before, safe="")
        page = api.get(path)
        threads = page.get("threads", [])
        for thread in threads:
            if thread.get("parent_id") == forum_id and thread.get("name", "").casefold() == name.casefold():
                found[thread["id"]] = thread
        if not page.get("has_more") or not threads:
            break
        following = threads[-1].get("thread_metadata", {}).get("archive_timestamp")
        if not following or following == before:
            break
        before = following
    return list(found.values())


def ensure_thread(api, journal, binding, forum, category):
    forum_id = validate_destination(forum, category)
    name, part = setup_values(binding, forum_id)
    journal.db.execute("""CREATE TABLE IF NOT EXISTS thread_bootstrap (
        org_id TEXT PRIMARY KEY, forum_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        state TEXT NOT NULL, thread_id TEXT, starter_id TEXT, started_at TEXT NOT NULL)""")
    row = journal.db.execute("SELECT forum_id,content_hash,state,thread_id,starter_id FROM thread_bootstrap WHERE org_id=?", (binding.org_id,)).fetchone()
    expected_hash = canonical_hash(part.content)
    if row and row[:2] != (forum_id, expected_hash):
        raise ValidationError("bootstrap_configuration_changed")
    if row and row[2] == "ready":
        channel = api.get(f"/channels/{row[3]}")
        check_channel(channel, forum_id, name)
        message = api.get(f"/channels/{row[3]}/messages/{row[4]}")
        validate_message(message, channel["id"], part)
        return {"org_id": binding.org_id, "org_name": binding.org_name, "thread_id": row[3], "starter_id": row[4], "created_this_run": False}

    def confirm(channel, message, created):
        check_channel(channel, forum_id, name)
        message_id = validate_message(message, channel["id"], part)
        def action():
            journal._scope()
            journal.db.execute("UPDATE thread_bootstrap SET state='ready',thread_id=?,starter_id=? WHERE org_id=?", (channel["id"], message_id, binding.org_id))
            journal.db.execute("INSERT INTO threads VALUES (?,?,'ready',?) ON CONFLICT(org_id) DO UPDATE SET state='ready',thread_id=excluded.thread_id",
                               (binding.org_id, forum_id, channel["id"]))
        journal._transaction(action)
        return {"org_id": binding.org_id, "org_name": binding.org_name, "thread_id": channel["id"], "starter_id": message_id, "created_this_run": created}

    existing = candidates(api, forum_id, name)
    if row and row[2] == "sending":
        matches = []
        for candidate in existing:
            channel = api.get(f"/channels/{candidate['id']}")
            check_channel(channel, forum_id, name)
            messages = api.get(f"/channels/{channel['id']}/messages?limit=100")
            for message in messages:
                if message.get("content") == part.content:
                    try:
                        validate_message(message, channel["id"], part)
                    except ValidationError:
                        continue
                    matches.append((channel, message))
        if len(matches) == 1:
            return confirm(*matches[0], False)
        raise OutcomeUnknown()
    if existing:
        raise ValidationError("bootstrap_existing_thread_requires_reconciliation")
    if row and row[2] not in {"rate_limited"}:
        raise ValidationError("bootstrap_previous_rejection_requires_review")
    retry = journal.value("bootstrap_retry_not_before")
    if retry and time.time() < float(retry):
        raise Rejected(429, float(retry)-time.time())

    def begin():
        journal._scope()
        if journal.db.execute("SELECT org_id FROM threads WHERE org_id=?", (binding.org_id,)).fetchone():
            raise ValidationError("bootstrap_org_thread_already_registered")
        journal.db.execute("INSERT INTO thread_bootstrap VALUES (?,?,?,'sending',NULL,NULL,?) ON CONFLICT(org_id) DO UPDATE SET state='sending'",
            (binding.org_id, forum_id, expected_hash, datetime.now(timezone.utc).isoformat()))
        journal.db.execute("INSERT INTO threads VALUES (?,?,'creating',NULL)", (binding.org_id, forum_id))
    journal._transaction(begin)
    payload = {"name": name, "auto_archive_duration": 10080, "message": part.discord_payload()}
    try:
        channel = api.request("POST", f"/channels/{forum_id}/threads", payload=payload)
    except Rejected as error:
        def reject():
            journal.db.execute("UPDATE thread_bootstrap SET state=? WHERE org_id=?", ("rate_limited" if error.status == 429 else "blocked", binding.org_id))
            journal.db.execute("DELETE FROM threads WHERE org_id=? AND state='creating'", (binding.org_id,))
            if error.status == 429:
                journal._set("bootstrap_retry_not_before", str(time.time() + (error.retry_after or 60)))
        journal._transaction(reject)
        raise
    # Invalid response or unknown result retains sending; never repeat POST.
    result = confirm(channel, channel.get("message"), True)
    validate_message(api.get(f"/channels/{result['thread_id']}/messages/{result['starter_id']}"), result['thread_id'], part)
    return result
