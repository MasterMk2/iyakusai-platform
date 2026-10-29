"""Fresh Discord-only qualification through an injected existing Bot client.

No cached member, list operation, additional intent, SDK login or identity-name
read is used. Network methods execute only when an operator calls qualify().
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from datetime import datetime, timedelta, timezone
from .policy import FIXED_GUILD_ID, KNOWN_SHARED_ACCOUNT_IDS, checked_registration_scope


GUILD_ID = FIXED_GUILD_ID
MAX_SAFE_INTEGER = 2**53 - 1
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class MemberUnavailable(Exception):
    """Sanitized refusal; never includes SDK messages, names or identities."""


def _user_id(value: object) -> bool:
    return type(value) is str and re.fullmatch(r"[1-9][0-9]{16,19}", value) is not None and int(value) <= 2**64 - 1


def _sdk_id(value: object) -> str:
    if type(value) is not int or not _user_id(str(value)):
        raise ValueError
    return str(value)


def _sdk_debug_enabled() -> bool:
    names = {
        "discord", "discord.client", "discord.http", "discord.state",
        "discord.gateway", "discord.guild", "discord.member",
    }
    names.update(name for name in logging.Logger.manager.loggerDict if name.startswith("discord."))
    return any(logging.getLogger(name).isEnabledFor(logging.DEBUG) for name in names)


class FreshGuildMemberVerifier:
    def __init__(self, client, sdk, shared_account_ids, *, timeout=2, clock=time.time, registration_scope=None):
        valid_sdk = all(isinstance(getattr(sdk, name, None), type) for name in ("Guild", "Member", "Role", "NotFound"))
        valid_shared = type(shared_account_ids) is frozenset and shared_account_ids.issuperset(KNOWN_SHARED_ACCOUNT_IDS) and all(_user_id(value) for value in shared_account_ids)
        valid_timeout = type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 2
        if not valid_sdk or not issubclass(sdk.NotFound, Exception) or not valid_shared or not valid_timeout or not callable(clock) or not callable(getattr(client, "fetch_guild", None)):
            raise MemberUnavailable("member verifier configuration refused")
        self.registration_scope = checked_registration_scope(registration_scope)
        self.client = client
        self.sdk = sdk
        self.shared_account_ids = shared_account_ids
        self.timeout = timeout
        self._clock = clock

    def _observed(self) -> int:
        now = self._clock()
        if type(now) not in (int, float) or not math.isfinite(now) or now <= 0:
            raise ValueError
        value = int(now * 1000)
        if not 10**12 <= value <= 10**13 - 1:
            raise ValueError
        return value

    @staticmethod
    def _join_version(value, observed: int) -> int:
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() != timedelta(0):
            raise ValueError
        delta = value - _EPOCH
        # Standard UTC epoch milliseconds: floor sub-ms metadata, integer
        # arithmetic only. No timestamp()/float conversion or invented version.
        version = delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000
        if not 0 < version <= MAX_SAFE_INTEGER or version > observed:
            raise ValueError
        return version

    def _roles(self, guild, member) -> list[str]:
        guild_roles, member_roles = guild.roles, member.roles
        sdk_proxy = getattr(getattr(self.sdk, "utils", None), "SequenceProxy", None)
        guild_roles_supported = type(guild_roles) in (list, tuple) or (
            isinstance(sdk_proxy, type) and type(guild_roles) is sdk_proxy
        )
        if not guild_roles_supported or type(member_roles) not in (list, tuple):
            raise ValueError
        current: dict[str, object] = {}
        for role in guild_roles:
            if not isinstance(role, self.sdk.Role) or role.guild is not guild:
                raise ValueError
            identifier = _sdk_id(role.id)
            if identifier in current:
                raise ValueError
            current[identifier] = role
        if GUILD_ID not in current:
            raise ValueError
        matched: set[str] = set()
        for role in member_roles:
            if not isinstance(role, self.sdk.Role) or role.guild is not guild:
                raise ValueError
            identifier = _sdk_id(role.id)
            if identifier not in current or identifier in matched:
                raise ValueError
            matched.add(identifier)
        if GUILD_ID not in matched:
            raise ValueError
        return sorted(matched, key=int)

    async def _fresh(self, user_id: str) -> dict:
        if _sdk_debug_enabled():
            raise ValueError
        guild = await self.client.fetch_guild(int(GUILD_ID), with_counts=False)
        if not isinstance(guild, self.sdk.Guild) or _sdk_id(guild.id) != GUILD_ID or guild.unavailable is not False:
            raise ValueError
        if _sdk_debug_enabled():
            raise ValueError
        absent = False
        try:
            member = await guild.fetch_member(int(user_id))
        except self.sdk.NotFound:
            absent = True
        if absent:
            return {
                "userId": user_id, "guildId": GUILD_ID,
                "active": False, "human": False, "sharedAccount": False,
                "roleIds": [], "observedAt": self._observed(),
                "linkId": None, "linkVersion": None,
            }
        if _sdk_debug_enabled() or not isinstance(member, self.sdk.Member) or member.guild is not guild or _sdk_id(member.id) != user_id:
            raise ValueError
        if any(type(getattr(member, flag)) is not bool for flag in ("bot", "system", "pending")):
            raise ValueError
        observed = self._observed()
        version = self._join_version(member.joined_at, observed)
        role_ids = self._roles(guild, member)
        return {
            "userId": user_id, "guildId": GUILD_ID,
            "active": True,
            "human": not (member.bot or member.system or member.pending),
            "sharedAccount": user_id in self.shared_account_ids,
            "roleIds": role_ids, "observedAt": observed,
            "linkId": f"dcg:{GUILD_ID}:{user_id}", "linkVersion": version,
        }

    async def qualify(self, user_id) -> dict:
        """One fresh guild then one fresh member, bounded by a total timeout."""
        result = None
        if _user_id(user_id):
            try:
                result = await asyncio.wait_for(self._fresh(user_id), timeout=self.timeout)
            except Exception:
                pass
        if result is None:
            # Outside except: no chained SDK message or response body.
            raise MemberUnavailable("member verification unavailable")
        return result

    async def __call__(self, recipient) -> bool:
        """Fresh recheck for each DM; exact real join/link/version only."""
        if type(recipient) is not dict or set(recipient) != {"discordUserId", "linkId", "linkVersion"} or not _user_id(recipient["discordUserId"]) or type(recipient["linkId"]) is not str or type(recipient["linkVersion"]) is not int or not 1 <= recipient["linkVersion"] <= MAX_SAFE_INTEGER:
            return False
        snapshot = await self.qualify(recipient["discordUserId"])
        return bool(
            self.registration_scope.permits_snapshot(snapshot)
            and recipient["linkId"] == snapshot["linkId"]
            and recipient["linkVersion"] == snapshot["linkVersion"]
        )
