"""Deployment-fixed values (Guild, Bot, roles, channels, store) kept out of the public tree.

Read once at import from ``site.json`` next to this file, in the release
directory. There is no environment lookup and no built-in default: a missing,
linked, malformed or shared-permission file refuses the import, so a release
never starts with another deployment's values. Standard library only, so every
relay module can import it without a cycle. Not named ``site``: the flat
imports here would get the standard library's ``site`` module instead.
"""
import json
import os
import re
import stat
from pathlib import Path

SITE_FILE = Path(__file__).resolve().parent / "site.json"
_SNOWFLAKE = re.compile(r"[1-9][0-9]{16,19}")
_ORGANIZATION = re.compile(r"[a-z0-9_]{1,40}")
_FINGERPRINT = re.compile(r"[0-9a-f]{12}")
_KEYS = frozenset({
    "guildId", "botId", "categoryId", "committeeRoleIds", "mylineForumId",
    "adminBotExceptionId", "approvedForumId", "storeDirectory",
    "legacyOrganizationIds", "internalSourceFingerprints",
})


class SiteRefused(RuntimeError):
    """Sanitized failure, without the file path or any value."""


def _snowflake(value):
    if type(value) is not str or _SNOWFLAKE.fullmatch(value) is None or int(value) >= 2**64:
        raise ValueError
    return value


def _matching(values, pattern, limit):
    if type(values) is not list or not 1 <= len(values) <= limit or len(set(values)) != len(values):
        raise ValueError
    if any(type(item) is not str or pattern.fullmatch(item) is None for item in values):
        raise ValueError
    return frozenset(values)


def parse_site(raw):
    """Validate a decoded site object; raises SiteRefused on any deviation."""
    try:
        if type(raw) is not dict or set(raw) != _KEYS:
            raise ValueError
        store = raw["storeDirectory"]
        if type(store) is not str or not store.startswith("/") or "\x00" in store:
            raise ValueError
        site = {
            "guild": _snowflake(raw["guildId"]),
            "bot": _snowflake(raw["botId"]),
            "category": _snowflake(raw["categoryId"]),
            "committee_roles": frozenset(_snowflake(item) for item in _matching(raw["committeeRoleIds"], _SNOWFLAKE, 64)),
            "myline_forum": _snowflake(raw["mylineForumId"]),
            "admin_bot_exception": _snowflake(raw["adminBotExceptionId"]),
            "approved_forum": _snowflake(raw["approvedForumId"]),
            "store": Path(store),
            "legacy_organizations": _matching(raw["legacyOrganizationIds"], _ORGANIZATION, 64),
            "internal_source_fingerprints": _matching(raw["internalSourceFingerprints"], _FINGERPRINT, 64),
        }
        singles = [site[name] for name in ("guild", "bot", "category", "myline_forum", "admin_bot_exception", "approved_forum")]
        if len(set(singles)) != len(singles) or site["committee_roles"] & set(singles) - {site["guild"]}:
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise SiteRefused("deployment site values refused") from None
    return site


def load_site(path=SITE_FILE):
    try:
        item = path.lstat()
        if (not stat.S_ISREG(item.st_mode) or item.st_size > 8192
                or item.st_uid != os.getuid() or item.st_mode & 0o077):
            raise ValueError
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SiteRefused("deployment site values refused") from None
    return parse_site(raw)


SITE = load_site()
