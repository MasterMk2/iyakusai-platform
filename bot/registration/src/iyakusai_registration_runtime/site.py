"""Deployment-fixed values (Guild, people, endpoint, paths) kept out of the public tree.

Read once at import from ``site.json`` in the release directory, the parent of
``src/``. There is no environment lookup and no built-in default: a missing,
linked, malformed or shared-permission file refuses the import, so a
release never starts with another deployment's values.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

SITE_FILE = Path(__file__).resolve().parents[2] / "site.json"
_SNOWFLAKE = re.compile(r"[1-9][0-9]{16,19}")
_RFC1918 = tuple(ipaddress.IPv4Network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_KEYS = frozenset({
    "guildId", "bootstrapUserId", "sharedAccountIds",
    "listenHost", "listenPort", "callerIp",
    "resourceUid", "configDirectory", "ledgerDirectory",
    "serverCertificate", "serverPrivateKey",
})


class SiteRefused(RuntimeError):
    """Sanitized failure, without the file path or any value."""


@dataclass(frozen=True)
class Site:
    guild_id: str
    bootstrap_user_id: str
    shared_account_ids: frozenset
    listen_host: str
    listen_port: int
    caller_ip: str
    resource_uid: int
    config_directory: Path
    ledger_directory: Path
    server_certificate: Path
    server_private_key: Path


def _snowflake(value):
    if type(value) is not str or _SNOWFLAKE.fullmatch(value) is None or int(value) >= 2**64:
        raise ValueError
    return value


def _private_ipv4(value):
    # RFC 1918 only: is_private would also accept 0.0.0.0 and documentation ranges.
    if type(value) is not str or not any(ipaddress.IPv4Address(value) in net for net in _RFC1918):
        raise ValueError
    return value


def _absolute(value):
    if type(value) is not str or not value.startswith("/") or "\x00" in value:
        raise ValueError
    return Path(value)


def parse_site(raw):
    """Validate a decoded site object; raises SiteRefused on any deviation."""
    try:
        if type(raw) is not dict or set(raw) != _KEYS:
            raise ValueError
        shared = raw["sharedAccountIds"]
        port, uid = raw["listenPort"], raw["resourceUid"]
        if (type(shared) is not list or not 1 <= len(shared) <= 16
                or type(port) is not int or not 1024 <= port <= 65535
                or type(uid) is not int or not 1 <= uid < 2**31):
            raise ValueError
        site = Site(
            guild_id=_snowflake(raw["guildId"]),
            bootstrap_user_id=_snowflake(raw["bootstrapUserId"]),
            shared_account_ids=frozenset(_snowflake(item) for item in shared),
            listen_host=_private_ipv4(raw["listenHost"]),
            listen_port=port,
            caller_ip=_private_ipv4(raw["callerIp"]),
            resource_uid=uid,
            config_directory=_absolute(raw["configDirectory"]),
            ledger_directory=_absolute(raw["ledgerDirectory"]),
            server_certificate=_absolute(raw["serverCertificate"]),
            server_private_key=_absolute(raw["serverPrivateKey"]),
        )
        if (len(site.shared_account_ids) != len(shared)
                or site.bootstrap_user_id in site.shared_account_ids
                or site.guild_id in site.shared_account_ids | {site.bootstrap_user_id}):
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise SiteRefused("deployment site values refused") from None
    return site


def load_site(path=SITE_FILE):
    try:
        item = path.lstat()
        if (not stat.S_ISREG(item.st_mode) or item.st_size > 4096
                or item.st_uid != os.getuid() or item.st_mode & 0o077):
            raise ValueError
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SiteRefused("deployment site values refused") from None
    return parse_site(raw)


SITE = load_site()
