"""Persistent self-registration button on the existing Discord client only.

Mount is local: no slash sync, prompt delivery, login or listener activation.
The owner must invoke these functions inside the already-running Bot loop.
"""
import asyncio
from dataclasses import dataclass, field
import re
import logging

from iyakusai_dm_sdk.sdk_transport import _own_private_dm

from .bootstrap import BootstrapRefused, SELF_DIAGNOSTIC_REASONS, resolve_authenticated_self
from .member import FreshGuildMemberVerifier
from .issuer import RegistrationIssuer
from .policy import BOOTSTRAP_USER_ID

CUSTOM_ID = "iyakusai:registration:v1:bootstrap"
_OWNER = object()


def _same_loop(bot):
    if getattr(bot, "loop", None) is not asyncio.get_running_loop():
        raise ValueError("existing Bot event loop required")


def make_registration_view(*, bot, sdk, runtime, member_provider, issuer):
    if (runtime.client is not bot or runtime.member_provider is not member_provider
            or runtime.origin != "https://task.iyakusai.com"
            or type(issuer) is not RegistrationIssuer or issuer.origin != runtime.origin
            or issuer.registration_scope is not runtime.registration_scope):
        raise ValueError("existing client and exact registration issuer required")

    class InitialRegistrationView(sdk.ui.View):
        def __init__(self):
            super().__init__(timeout=None)
            self._registration_closed = False

        def stop(self):
            self._registration_closed = True
            super().stop()

        @sdk.ui.button(label="初回登録", custom_id=CUSTOM_ID)
        async def register(self, interaction, button):
            if self._registration_closed:
                return
            await interaction.response.defer(ephemeral=True, thinking=True)
            text = "初回登録は完了していません。時間をおいて確認してください。"
            failure_stage = "SELF_VERIFICATION"
            try:
                subject = await resolve_authenticated_self(
                    interaction, client=bot, sdk=sdk, member_provider=member_provider,
                    registration_scope=issuer.registration_scope)
                if self._registration_closed:
                    raise ValueError()
                failure_stage = "CODE_ISSUANCE"
                result = await issuer.issue(subject)
                failure_stage = "DELIVERY_REPLY"
                if self._registration_closed:
                    raise ValueError()
                if (type(result) is not dict or set(result) != {"initialLoginId", "deliveryStatus"}
                        or result["deliveryStatus"] != "delivered"
                        or type(result["initialLoginId"]) is not str
                        or re.fullmatch(r"iy-[0-9]{8}", result["initialLoginId"]) is None):
                    raise ValueError()
                text = ("初回登録URL：https://task.iyakusai.com/register\n"
                        + "初回登録用ID：" + result["initialLoginId"]
                        + "\n登録コードは本人宛DMを確認してください。")
            except Exception as error:
                # Fixed stages and reason enums only; never format exception text.
                try:
                    logger = logging.getLogger("iyakusai.registration.callback")
                    logger.warning("registration_callback_failed:%s", failure_stage)
                    if failure_stage == "SELF_VERIFICATION":
                        reason = "SELF_UNKNOWN"
                        if type(error) is BootstrapRefused:
                            candidate_reason = getattr(error, "reason", None)
                            if type(candidate_reason) is str and candidate_reason in SELF_DIAGNOSTIC_REASONS:
                                reason = candidate_reason
                        logger.warning("registration_self_verification_reason:%s", reason)
                except Exception:
                    pass
            await interaction.followup.send(
                text, ephemeral=True, allowed_mentions=sdk.AllowedMentions.none(),
                suppress_embeds=True)

    view = InitialRegistrationView()
    view._registration_owner = _OWNER
    view._registration_bot = bot
    return view


@dataclass
class RegistrationViewMount:
    bot: object = field(repr=False)
    runtime: object = field(repr=False)
    view: object = field(repr=False)
    issuer: object = field(repr=False)
    cog: object = field(default=None, repr=False)
    command_mount: object = field(default=None, repr=False)
    active: bool = False
    closed: bool = False

    async def start(self, *, activate=False):
        _same_loop(self.bot)
        if activate is not True or self.closed:
            raise ValueError("explicit coordinated activation required")
        await self.runtime.start(activate=True)
        self.active = True

    async def stop(self):
        _same_loop(self.bot)
        self.active = False
        self.view.stop()  # Public SDK has no Client.remove_view method.
        self.closed = True
        try:
            await self.issuer.close()
        finally:
            await self.runtime.stop()


async def mount_registration_view(*, bot, sdk, commands_sdk, runtime,
                                  member_provider, issuer):
    _same_loop(bot)
    if bot.user is None:
        raise ValueError("existing ready Bot event loop required")
    if bot.get_cog("InitialRegistrationRuntime") is not None:
        raise ValueError("existing runtime cog retained")
    for existing in bot.persistent_views:
        if any(getattr(item, "custom_id", None) == CUSTOM_ID for item in existing.children):
            raise ValueError("existing persistent registration view retained")
    view = make_registration_view(bot=bot, sdk=sdk, runtime=runtime,
                                  member_provider=member_provider, issuer=issuer)
    handle = RegistrationViewMount(bot, runtime, view, issuer)

    class InitialRegistrationRuntime(commands_sdk.Cog):
        @commands_sdk.Cog.listener("on_ready")
        async def on_ready(self):
            if handle.active and not handle.closed:
                await runtime.start(activate=True)

        async def cog_unload(self):
            await handle.stop()

    handle.cog = InitialRegistrationRuntime()
    await bot.add_cog(handle.cog, override=False)
    try:
        bot.add_view(view)
    except Exception:
        # Ownership is checked before removing our own partially-mounted cog.
        if bot.get_cog("InitialRegistrationRuntime") is handle.cog:
            await bot.remove_cog("InitialRegistrationRuntime")
        raise RuntimeError("registration view mount unavailable") from None
    return handle


async def unmount_registration_view(*, bot, mount):
    _same_loop(bot)
    if type(mount) is not RegistrationViewMount or mount.bot is not bot:
        raise ValueError("owned registration view mount required")
    existing = bot.get_cog("InitialRegistrationRuntime")
    if existing is None:
        await mount.stop()
        return
    if existing is not mount.cog:
        raise ValueError("existing runtime cog retained")
    await bot.remove_cog("InitialRegistrationRuntime")


async def send_initial_prompt(*, bot, sdk, member_provider, mount, approve=False):
    """Explicit later one-user DM action; no code/password and no fallback target."""
    _same_loop(bot)
    if (approve is not True or type(mount) is not RegistrationViewMount
            or mount.bot is not bot or mount.closed or mount.view._registration_owner is not _OWNER
            or type(member_provider) is not FreshGuildMemberVerifier
            or mount.runtime.member_provider is not member_provider
            or member_provider.client is not bot or member_provider.sdk is not sdk):
        raise ValueError("explicit owned first-user prompt required")
    snapshot = await member_provider.qualify(BOOTSTRAP_USER_ID)
    if mount.closed:
        raise ValueError("registration prompt stopped")
    if not (snapshot["active"] and snapshot["human"] and not snapshot["sharedAccount"]):
        raise ValueError("first-user qualification unavailable")
    user = bot.get_user(int(BOOTSTRAP_USER_ID))
    if user is None:
        user = await asyncio.wait_for(bot.fetch_user(int(BOOTSTRAP_USER_ID)), timeout=2)
    if (not isinstance(user, sdk.User) or type(user.id) is not int
            or str(user.id) != BOOTSTRAP_USER_ID or getattr(user, "guild", None) is not None
            or user.bot is not False or user.system is not False):
        raise ValueError("own recipient required")
    channel = await asyncio.wait_for(user.create_dm(), timeout=2)
    if mount.closed:
        raise ValueError("registration prompt stopped")
    if not _own_private_dm(channel, sdk=sdk, recipient_id=int(BOOTSTRAP_USER_ID),
                           bot_id=bot.user.id):
        raise ValueError("own one-to-one DM required")
    # Exactly one send; uncertain delivery is never automatically resent.
    await asyncio.wait_for(channel.send(
        "初回登録を始める場合は、本人確認ボタンを押してください。",
        view=mount.view, allowed_mentions=sdk.AllowedMentions.none(),
        suppress_embeds=True), timeout=5)
