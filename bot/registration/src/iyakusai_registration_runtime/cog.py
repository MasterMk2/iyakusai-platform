"""Optional local registration Cog construction; never syncs Discord commands.

Mounting, syncing and listener activation are separate action-time approvals.
The self-command returns only the exact registration URL and initial user ID.
The one-use registration code is sent only by the signed DM controller.
"""
from dataclasses import dataclass, field

from .bootstrap import BootstrapRefused, resolve_authenticated_self
from .policy import FIXED_GUILD_ID
from .issuer import RegistrationIssuer
from .registration import _registration_url
from .runtime import RuntimeFailure

_OWNER_MARKER = object()


@dataclass(frozen=True)
class RegistrationMount:
    bot: object = field(repr=False)
    cog: object = field(repr=False)


def make_registration_cog(*, bot, sdk, commands_sdk, runtime, member_provider,
                          origin, issuer, activate=False):
    url = _registration_url(origin)
    if (runtime.client is not bot or runtime.member_provider is not member_provider
            or origin != runtime.origin or type(issuer) is not RegistrationIssuer
            or issuer.origin != origin or type(activate) is not bool
            or issuer.registration_scope is not runtime.registration_scope):
        raise ValueError("existing client registration composition required")

    class InitialRegistration(commands_sdk.Cog):
        _closing = False
        @commands_sdk.Cog.listener("on_ready")
        async def on_ready(self):
            if activate and not self._closing:
                try:
                    await runtime.start(activate=True)
                except RuntimeFailure:
                    pass  # Fail closed without touching other Bot features/loggers.

        @sdk.app_commands.command(name="register", description="初回登録の本人確認")
        @sdk.app_commands.guilds(sdk.Object(id=int(FIXED_GUILD_ID)))
        async def register(self, interaction):
            if self._closing:
                return
            await interaction.response.defer(ephemeral=True, thinking=True)
            try:
                subject = await resolve_authenticated_self(
                    interaction, client=bot, sdk=sdk, member_provider=member_provider,
                    registration_scope=issuer.registration_scope)
                if self._closing:
                    raise BootstrapRefused()
                result = await issuer.issue(subject)
            except BootstrapRefused:
                text = "初回登録の本人確認を完了できません。"
            except Exception:
                text = "初回登録は完了していません。時間をおいて確認してください。"
            else:
                text = f"初回登録URL：{url}\n初回登録用ID：{result['initialLoginId']}\n登録コードは本人宛DMを確認してください。"
            await interaction.followup.send(
                text, ephemeral=True, allowed_mentions=sdk.AllowedMentions.none(),
                suppress_embeds=True)

        async def cog_unload(self):
            self._closing = True
            try:
                await issuer.close()
            finally:
                await runtime.stop()

    cog = InitialRegistration()
    cog._registration_owner_bot = bot
    cog._registration_owner_marker = _OWNER_MARKER
    return cog


async def mount_registration_cog(*, bot, sdk, cog):
    """Local add only; no tree.sync, override, registry writes or listener start."""
    guild = sdk.Object(id=int(FIXED_GUILD_ID))
    if (getattr(cog, "_registration_owner_bot", None) is not bot
            or getattr(cog, "_registration_owner_marker", None) is not _OWNER_MARKER
            or bot.get_cog("InitialRegistration") is not None
            or bot.tree.get_command("register", guild=guild) is not None
            or bot.tree.get_command("register") is not None):
        raise ValueError("existing registration command or cog retained")
    await bot.add_cog(cog, override=False, guild=guild)
    return RegistrationMount(bot, cog)


async def unmount_registration_cog(*, bot, sdk, mount):
    # The existing framework awaits cog_unload, which stops only this runtime.
    if type(mount) is not RegistrationMount or mount.bot is not bot:
        raise ValueError("owned registration mount required")
    current = bot.get_cog("InitialRegistration")
    if current is None:
        return None
    if current is not mount.cog:
        raise ValueError("existing registration cog retained")
    return await bot.remove_cog("InitialRegistration", guild=sdk.Object(id=int(FIXED_GUILD_ID)))
