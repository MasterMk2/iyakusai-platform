"""Offline candidate: inject an existing client, SDK, canonical verifier and Mail core.

No endpoint, login, token access, logging, ledger creation or automatic registration.
Production composition must authenticate the controller before calling DeliveryCore.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import inspect
import json
import logging
import re
import time
import unicodedata
from urllib.parse import urlsplit


def _safe_label(value):
    return (isinstance(value, str) and 1 <= len(value) <= 254
            and all(unicodedata.category(c)[0] in {"L", "N"}
                    or c in " _-.()（）・" for c in value)
            and bool(value.strip()))


def _snowflake(value):
    return (type(value) is int and 0 < value < 2**64
            and re.fullmatch(r"[0-9]{17,20}", str(value)) is not None)


def _own_private_dm(channel, *, sdk, recipient_id, bot_id, channel_id=None):
    """SDK 2.7.1 uses recipients:list even for genuine one-to-one DMChannel."""
    try:
        recipient = getattr(channel, "recipient", None)
        recipients = getattr(channel, "recipients", None)
        me = getattr(channel, "me", None)
        return (isinstance(channel, sdk.DMChannel)
                and not isinstance(channel, sdk.GroupChannel)
                and channel.type is sdk.ChannelType.private
                and getattr(channel, "guild", None) is None
                and _snowflake(channel.id)
                and (channel_id is None or (_snowflake(channel_id) and channel.id == channel_id))
                and _snowflake(bot_id) and _snowflake(recipient_id) and bot_id != recipient_id
                and isinstance(me, sdk.ClientUser) and _snowflake(me.id) and me.id == bot_id
                and type(recipients) is list and len(recipients) == 1
                and recipients[0] is recipient and isinstance(recipient, sdk.User)
                and _snowflake(recipient.id) and recipient.id == recipient_id
                and recipient.bot is False and recipient.system is False
                and getattr(recipient, "guild", None) is None)
    except Exception:
        return False


class DiscordSDKTransport:
    """One SDK send invocation after fresh canonical-link and private-channel checks.

    `core_module` is the strict two-purpose candidate Core. Both templates require
    explicit purpose/audience. Legacy envelopes missing fields remain unsupported.
    """

    def __init__(self, *, client, sdk, core_module, origin, service_label,
                 verify_recipient, clock=time.time):
        parsed = urlsplit(origin) if isinstance(origin, str) else None
        if (parsed is None or parsed.scheme != "https" or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment
                or not _safe_label(service_label) or not callable(verify_recipient)):
            raise ValueError("invalid transport configuration")
        required = {"content", "nonce", "allowed_mentions", "suppress_embeds"}
        if not required <= set(inspect.signature(sdk.DMChannel.send).parameters):
            raise ValueError("unsupported SDK send signature")
        self.client, self.sdk, self.core = client, sdk, core_module
        self.origin, self.service_label = origin, service_label
        self.verify_recipient, self.clock = verify_recipient, clock

    def _failure(self, reason):
        return self.core.DeliveryFailure(reason)

    def _snapshot(self, envelope):
        # Preserve the actual purpose/template in validation and ledger identity.
        if type(envelope) is not dict:
            raise ValueError("invalid envelope")
        encoded = self.core.validate(envelope, self.origin, self.clock())
        result = json.loads(encoded)
        if (result["context"]["serviceLabel"] != self.service_label
                or not _safe_label(result["context"]["serviceLabel"])):
            raise ValueError("invalid context")
        return result

    def _check_sdk_logging(self):
        # SDK DEBUG handlers can emit request/response payloads. Never change
        # the existing Bot's logger configuration: deny this candidate call.
        for name in ("discord", "discord.http", "discord.state", "discord.gateway"):
            if logging.getLogger(name).isEnabledFor(logging.DEBUG):
                raise self._failure("unavailable")

    def _check_user(self, user, recipient_id):
        if (not isinstance(user, self.sdk.User) or not _snowflake(user.id)
                or user.id != recipient_id or user.bot is not False
                or user.system is not False or getattr(user, "guild", None) is not None):
            raise self._failure("recipient_mismatch")

    def _check_channel(self, channel, recipient_id, bot_id):
        if not _own_private_dm(channel, sdk=self.sdk, recipient_id=recipient_id, bot_id=bot_id):
            raise self._failure("recipient_mismatch")

    def _check_expiry(self, envelope):
        expires = dt.datetime.fromisoformat(envelope["expiresAt"].replace("Z", "+00:00"))
        if self.clock() >= expires.timestamp():
            raise self._failure("timeout")

    def _render(self, envelope):
        action = "初回パスワード設定" if envelope["purpose"] == "password_setup" else "ログイン"
        requested = dt.datetime.fromisoformat(envelope["context"]["requestedAt"].replace("Z", "+00:00"))
        expires = dt.datetime.fromisoformat(envelope["expiresAt"].replace("Z", "+00:00"))
        return (f"{self.service_label} の{action}コード：{envelope['code']}\n"
                f"要求日時：{requested.astimezone(dt.timezone.utc).isoformat()}\n"
                f"有効期限：{expires.astimezone(dt.timezone.utc).isoformat()}（1 回限り）\n"
                "ご自身で要求した場合だけ入力してください。コードを他の人へ共有しないでください。\n"
                "心当たりがない場合は入力せず、管理者に連絡してください。")

    def _reason(self, error):
        if isinstance(error, self.core.DeliveryFailure):
            return error.reason
        if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
            return "timeout"
        if isinstance(error, self.sdk.RateLimited):
            return "rate_limited"
        if isinstance(error, self.sdk.Forbidden):
            return "dm_closed" if error.code == 50007 else "blocked"
        if isinstance(error, self.sdk.HTTPException) and error.status == 429:
            return "rate_limited"
        return "unavailable"

    async def send(self, envelope):
        try:
            return await self._send(envelope)
        except asyncio.CancelledError:
            raise  # DeliveryCore.wait_for records timeout; this adapter never retries.
        except Exception as error:
            reason = self._reason(error)
        # Leave the SDK exception scope before raising; its potentially sensitive
        # message is neither chained, formatted, logged nor returned to the caller.
        raise self._failure(reason) from None

    async def _send(self, envelope):
        value = self._snapshot(envelope)
        self._check_sdk_logging()
        recipient = value["recipient"]
        recipient_id = int(recipient["discordUserId"])
        if not _snowflake(recipient_id) or str(recipient_id) != recipient["discordUserId"]:
            raise self._failure("recipient_mismatch")
        bot_id = getattr(getattr(self.client, "user", None), "id", None)
        if not _snowflake(bot_id) or bot_id == recipient_id:
            raise self._failure("recipient_mismatch")
        if await self.verify_recipient(dict(recipient)) is not True:
            raise self._failure("recipient_mismatch")
        user = self.client.get_user(recipient_id)
        if user is None:
            user = await self.client.fetch_user(recipient_id)
        # A mismatched cached or fetched object never falls back to another ID.
        self._check_user(user, recipient_id)
        channel = await user.create_dm()
        self._check_channel(channel, recipient_id, bot_id)
        if await self.verify_recipient(dict(recipient)) is not True:
            raise self._failure("recipient_mismatch")
        self._check_expiry(value)
        self._snapshot(value)  # Revalidate time/context after the awaited lookups.
        self._check_user(user, recipient_id)
        self._check_channel(channel, recipient_id, bot_id)
        self._check_sdk_logging()
        mentions = self.sdk.AllowedMentions.none()
        mention_wire = mentions.to_dict()
        if (not isinstance(mentions, self.sdk.AllowedMentions)
                or mentions.replied_user is not False
                or mention_wire.get("parse") != [] or mention_wire.get("users")
                or mention_wire.get("roles") or mention_wire.get("replied_user", False) is not False):
            raise self._failure("unavailable")
        content = self._render(value)
        # <=25 characters; stable across restart. This supplements, never replaces,
        # the existing durable core reservation/fingerprint and terminal-result rules.
        nonce = hashlib.sha256(value["deliveryId"].encode("ascii")).hexdigest()[:24]
        message = await channel.send(content, nonce=nonce, allowed_mentions=mentions,
                                     suppress_embeds=True)
        if (not isinstance(message, self.sdk.Message) or not _snowflake(message.id)
                or getattr(getattr(message, "channel", None), "id", None) != channel.id
                or getattr(getattr(message, "author", None), "id", None) != bot_id):
            raise self._failure("unavailable")
        return True  # Only DeliveryCore persists completion and emits same-ID ACK.


def compose_dm_core(*, core_module, ledger, fingerprint_key, client,
                    sdk, origin, service_label, verify_recipient, timeout=5):
    """Wire strict Core; ledger/key/verifier/client are supplied by the trusted owner."""
    transport = DiscordSDKTransport(client=client, sdk=sdk, core_module=core_module,
                                   origin=origin, service_label=service_label,
                                   verify_recipient=verify_recipient)
    return core_module.DeliveryCore(ledger, fingerprint_key, origin, verify_recipient,
                                   transport.send, timeout=timeout)


# Keep the previously exported composition name for existing password-setup callers.
compose_password_setup_core = compose_dm_core
