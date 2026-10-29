"""Authenticated-self metadata only. No account, registration code or DM creation."""
import asyncio
from dataclasses import dataclass

from iyakusai_dm_sdk.sdk_transport import _own_private_dm, _snowflake

from .member import FreshGuildMemberVerifier
from .policy import checked_registration_scope
from .policy import BOOTSTRAP_USER_ID, FIXED_GUILD_ID, KNOWN_SHARED_ACCOUNT_IDS


SELF_DIAGNOSTIC_REASONS = frozenset({
    "SELF_UNKNOWN", "PROVIDER_BINDING", "INTERACTION_CONTEXT", "SUBJECT_IDENTITY",
    "PROMPT_METADATA", "DM_FULL_SHAPE", "DM_EMPTY_SHAPE", "DM_PARTIAL_SHAPE",
    "DM_CHANNEL_KIND", "DM_FETCH_TIMEOUT", "DM_FETCH_REFUSED", "DM_FETCH_SHAPE",
    "GUILD_CONTEXT", "MEMBER_QUALIFY_FAILED", "MEMBER_SNAPSHOT", "SELF_REFERENCE",
})


class BootstrapRefused(Exception):
    pass


@dataclass(frozen=True)
class AuthenticatedSelfReference:
    user_id: str
    guild_id: str
    link_id: str
    link_version: int
    observed_at: int
    interaction_id: str
    role_ids: tuple = ()


def _caller_perspective_dm(channel, *, sdk, bot_id, channel_id):
    """Only qualify a known-Bot partial payload for same-channel canonical fetch."""
    try:
        recipients = getattr(channel, "recipients", None)
        recipient = getattr(channel, "recipient", None)
        me = getattr(channel, "me", None)
        return (isinstance(channel, sdk.DMChannel)
                and not isinstance(channel, sdk.GroupChannel)
                and channel.type is sdk.ChannelType.private
                and getattr(channel, "guild", None) is None
                and _snowflake(channel.id) and _snowflake(channel_id)
                and channel.id == channel_id and _snowflake(bot_id)
                and isinstance(me, sdk.ClientUser) and _snowflake(me.id) and me.id == bot_id
                and me.bot is True and me.system is False
                and type(recipients) is list and len(recipients) == 1
                and recipients[0] is recipient
                and isinstance(recipient, (sdk.User, sdk.ClientUser))
                and _snowflake(recipient.id) and recipient.id == bot_id
                and recipient.bot is True and recipient.system is False
                and getattr(recipient, "guild", None) is None
                and (not isinstance(recipient, sdk.ClientUser) or recipient is me))
    except Exception:
        return False


async def resolve_authenticated_self(interaction, *, client, sdk, member_provider, registration_scope=None):
    """Called only from the existing SDK's authenticated interaction dispatch."""
    reference = None
    reason = "SELF_UNKNOWN"
    try:
        scope = checked_registration_scope(registration_scope)
        reason = "PROVIDER_BINDING"
        if (type(member_provider) is not FreshGuildMemberVerifier
                or member_provider.client is not client or member_provider.sdk is not sdk
                or not KNOWN_SHARED_ACCOUNT_IDS <= member_provider.shared_account_ids):
            raise ValueError()
        reason = "INTERACTION_CONTEXT"
        if (not isinstance(interaction, sdk.Interaction)
                or interaction.client is not client
                or interaction.type not in {sdk.InteractionType.application_command,
                                            sdk.InteractionType.component}
                or type(interaction.id) is not int
                or not 10**16 <= interaction.id < 2**64):
            raise ValueError()
        reason = "SUBJECT_IDENTITY"
        if (not isinstance(interaction.user, (sdk.Member, sdk.User))
                or type(interaction.user.id) is not int
                or not scope.permits(str(interaction.user.id))
                or interaction.user.bot is not False or interaction.user.system is not False):
            raise ValueError()
        subject_id = str(interaction.user.id)
        if interaction.type is sdk.InteractionType.component and interaction.guild_id is None:
            reason = "PROMPT_METADATA"
            channel = interaction.channel
            message = interaction.message
            channel_id = interaction.channel_id
            bot_id = getattr(getattr(client, "user", None), "id", None)
            if (not _snowflake(channel_id) or not _snowflake(bot_id)
                    or not isinstance(message, sdk.Message)
                    or message.channel.id != channel_id
                    or message.author.id != bot_id
                    or type(interaction.data) is not dict
                    or interaction.data.get("custom_id") != "iyakusai:registration:v1:bootstrap"):
                raise ValueError()
            if not _own_private_dm(channel, sdk=sdk, recipient_id=int(subject_id),
                                   bot_id=bot_id, channel_id=channel_id):
                # Missing recipient is a documented Interaction DM shape. A genuine
                # private PartialMessageable can likewise be resolved, never retargeted.
                reason = "DM_EMPTY_SHAPE"
                empty_dm = (isinstance(channel, sdk.DMChannel)
                            and not isinstance(channel, sdk.GroupChannel)
                            and channel.type is sdk.ChannelType.private
                            and channel.id == channel_id
                            and getattr(channel, "guild", None) is None
                            and isinstance(getattr(channel, "me", None), sdk.ClientUser)
                            and channel.me.id == bot_id
                            and type(getattr(channel, "recipients", None)) is list
                            and len(channel.recipients) == 0 and channel.recipient is None)
                reason = "DM_PARTIAL_SHAPE"
                partial_dm = (isinstance(channel, sdk.PartialMessageable)
                              and channel.type is sdk.ChannelType.private
                              and channel.id == channel_id
                              and channel.guild_id is None
                              and getattr(channel, "guild", None) is None)
                caller_dm = False
                if not (empty_dm or partial_dm):
                    caller_dm = _caller_perspective_dm(
                        channel, sdk=sdk, bot_id=bot_id, channel_id=channel_id)
                if not (empty_dm or partial_dm or caller_dm):
                    # Classify only after the unchanged eligibility gate has denied.
                    # A classification error remains a refusal, never a fallback.
                    reason = "DM_CHANNEL_KIND"
                    if isinstance(channel, sdk.DMChannel):
                        reason = "DM_EMPTY_SHAPE" if channel.recipient is None else "DM_FULL_SHAPE"
                    elif isinstance(channel, sdk.PartialMessageable):
                        reason = "DM_PARTIAL_SHAPE"
                    raise ValueError()
                reason = "DM_FETCH_REFUSED"
                try:
                    channel = await asyncio.wait_for(client.fetch_channel(channel_id), timeout=2)
                except (asyncio.TimeoutError, TimeoutError):
                    reason = "DM_FETCH_TIMEOUT"
                    raise
                reason = "DM_FETCH_SHAPE"
                if not _own_private_dm(channel, sdk=sdk, recipient_id=int(subject_id),
                                       bot_id=bot_id, channel_id=channel_id):
                    raise ValueError()
        else:
            reason = "GUILD_CONTEXT"
            if (type(interaction.guild_id) is not int
                    or str(interaction.guild_id) != FIXED_GUILD_ID
                    or not isinstance(interaction.user, sdk.Member)):
                raise ValueError()
        reason = "MEMBER_QUALIFY_FAILED"
        snapshot = await member_provider.qualify(subject_id)
        reason = "MEMBER_SNAPSHOT"
        if (snapshot["userId"] != subject_id or snapshot["guildId"] != FIXED_GUILD_ID
                or snapshot["active"] is not True or snapshot["human"] is not True
                or snapshot["sharedAccount"] is not False or not scope.permits_snapshot(snapshot)):
            raise ValueError()
        reason = "SELF_REFERENCE"
        reference = AuthenticatedSelfReference(
            snapshot["userId"], snapshot["guildId"], snapshot["linkId"],
            snapshot["linkVersion"], snapshot["observedAt"], str(interaction.id), tuple(snapshot["roleIds"]))
    except Exception:
        pass
    if reference is None:
        refusal = BootstrapRefused("authenticated self verification refused")
        refusal.reason = reason if reason in SELF_DIAGNOSTIC_REASONS else "SELF_UNKNOWN"
        raise refusal
    return reference
