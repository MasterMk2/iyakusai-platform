"""One approved forum creation; no messages, role changes, or new credentials."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path

from oa_relay import GUILD, ValidationError
from discord_transport import DiscordAPI
from credentials import existing_token
from live_access import ADMIN_BOT_EXCEPTION, inspect_access


def durable_json(path: Path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write("\n")
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)
    if os.name == "posix":
        descriptor = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def provision(api, known_ids, state_path, *, approved_exception: bool):
    if approved_exception is not True:
        raise ValidationError("explicit_admin_bot_exception_missing")
    exceptions = frozenset({ADMIN_BOT_EXCEPTION})
    proposal, _, _, _ = inspect_access(api, known_ids, approved_admin_bots=exceptions)
    channels = api.get(f"/guilds/{GUILD}/channels")
    found = [channel for channel in channels if channel.get("name", "").casefold() == proposal["name"].casefold()]
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    if len(found) > 1:
        raise ValidationError("duplicate_forum_name_requires_review")
    created = False
    if found:
        forum_id = found[0]["id"]
        if state.get("forum_id") and state["forum_id"] != forum_id:
            raise ValidationError("forum_creation_receipt_conflict")
    else:
        if state:
            raise ValidationError("forum_creation_outcome_requires_reconciliation")
        durable_json(state_path, {"state": "creating", "intent_at": datetime.now(timezone.utc).isoformat()})
        # There is deliberately no POST retry in this method.
        forum = api.request("POST", f"/guilds/{GUILD}/channels", payload=proposal)
        forum_id = forum["id"]
        created = True
        durable_json(state_path, {"state": "created_needs_readback", "forum_id": forum_id,
                                 "created_at": datetime.now(timezone.utc).isoformat()})
    _, forum, _, report = inspect_access(api, known_ids, forum_id=forum_id, approved_admin_bots=exceptions)
    result = {"state": "readback_verified", "forum_id": forum_id, "created_this_run": created,
              "verified_at": datetime.now(timezone.utc).isoformat(), "audience": report,
              "forum": {k: forum[k] for k in ["id", "name", "guild_id", "type", "parent_id", "permission_overwrites"]},
              "messages_sent": 0, "credentials_written": 0, "existing_roles_changed": 0}
    result["created_at"] = state.get("created_at") or datetime.now(timezone.utc).isoformat()
    durable_json(state_path, result)
    return result


def main(known_ids):
    import fcntl
    root = Path.home() / "iyakusai/official-line-relay"
    root.mkdir(mode=0o700, exist_ok=True)
    with (root / "provision.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        api = DiscordAPI(existing_token(), writes_enabled=True)
        result = provision(api, known_ids, root / "forum-receipt.json", approved_exception=True)
        print(json.dumps(result, ensure_ascii=False))
