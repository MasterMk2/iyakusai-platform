"""Explicit human-approved IDs; no display-name or email inference/admin grant."""
from .site import SITE

FIXED_GUILD_ID = SITE.guild_id
BOOTSTRAP_USER_ID = SITE.bootstrap_user_id
KNOWN_SHARED_ACCOUNT_IDS = SITE.shared_account_ids


# Candidate starts in the existing one-person phase. Wider registration requires
# first-person validation plus an explicit, verified current-committee authority.
from dataclasses import dataclass
import re
from typing import Optional

@dataclass(frozen=True)
class RegistrationScope:
    mode: str = "single-user-e2e"
    first_person_validation_ref: Optional[str] = None
    active_role_ids: frozenset = frozenset()
    guild_current_membership_ref: Optional[str] = None

    def __post_init__(self):
        if self.mode not in {"single-user-e2e", "current-committee"}:
            raise ValueError("registration scope refused")
        reference = self.first_person_validation_ref
        roles = self.active_role_ids
        guild_reference = self.guild_current_membership_ref
        if (type(roles) is not frozenset or len(roles) > 250
                or any(type(role) is not str or re.fullmatch(r"[1-9][0-9]{16,19}", role) is None
                       or int(role) >= 2**64 or role == FIXED_GUILD_ID for role in roles)):
            raise ValueError("explicit non-default active committee roles required")
        if guild_reference is not None and (type(guild_reference) is not str
                or re.fullmatch(r"[A-Za-z0-9_.:/-]{1,200}", guild_reference) is None):
            raise ValueError("explicit verified guild-current membership policy required")
        if self.mode == "single-user-e2e":
            if reference is not None or roles or guild_reference is not None:
                raise ValueError("unexpected validation reference")
        elif type(reference) is not str or re.fullmatch(r"[A-Za-z0-9_.:/-]{1,200}", reference) is None:
            raise ValueError("explicit first-person validation reference required")
        elif bool(roles) == (guild_reference is not None):
            # Neither authority, or both conflicting authorities, is refused.
            raise ValueError("one verified current-committee authority required")

    def permits(self, user_id):
        if (type(user_id) is not str or re.fullmatch(r"[1-9][0-9]{16,19}", user_id) is None
                or int(user_id) >= 2**64 or user_id in KNOWN_SHARED_ACCOUNT_IDS):
            return False
        return self.mode == "current-committee" or user_id == BOOTSTRAP_USER_ID

    def permits_roles(self, role_ids):
        if (type(role_ids) not in (list, tuple) or len(role_ids) > 250
                or any(type(role) is not str or re.fullmatch(r"[1-9][0-9]{16,19}", role) is None
                       or int(role) >= 2**64 for role in role_ids)
                or len(set(role_ids)) != len(role_ids)):
            return False
        if self.mode == "single-user-e2e" or self.guild_current_membership_ref is not None:
            return True
        # ANY exact, explicitly verified active role matches; no name lookup.
        return bool(self.active_role_ids.intersection(role_ids))

    def permits_snapshot(self, snapshot):
        return (type(snapshot) is dict and self.permits(snapshot.get("userId"))
                and snapshot.get("guildId") == FIXED_GUILD_ID
                and snapshot.get("active") is True and snapshot.get("human") is True
                and snapshot.get("sharedAccount") is False
                and self.permits_roles(snapshot.get("roleIds")))

DEFAULT_REGISTRATION_SCOPE = RegistrationScope()

def checked_registration_scope(value):
    if value is None:
        return DEFAULT_REGISTRATION_SCOPE
    if type(value) is not RegistrationScope:
        raise ValueError("explicit immutable registration scope required")
    return value
