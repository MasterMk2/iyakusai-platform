"""Explicit discord.py extension for an existing in-process hotloader.

The owner first supplies bot.iyakusai_registration_factory(existing_bot), returning
PreparedRegistration from protected approved resources. No default factory or
credential discovery exists. Loading mounts locally but never activates or DMs.
"""
import inspect

from .composition import PreparedRegistration
from .cog import make_registration_cog, mount_registration_cog, unmount_registration_cog
from .view import mount_registration_view, unmount_registration_view

_FACTORY = "iyakusai_registration_factory"
_MOUNT = "_iyakusai_owned_registration_mount"


async def setup(bot):
    if getattr(bot, _MOUNT, None) is not None:
        raise ValueError("existing registration mount retained")
    factory = getattr(bot, _FACTORY, None)
    if not callable(factory):
        raise ValueError("explicit existing-client registration factory required")
    prepared = factory(bot)
    if inspect.isawaitable(prepared):
        prepared = await prepared
    if type(prepared) is not PreparedRegistration or prepared.runtime.client is not bot:
        raise ValueError("owned existing-client registration composition required")
    # Installed SDK only, imported only when an authorized owner loads this module.
    import discord
    from discord.ext import commands
    if prepared.runtime.sdk is not discord:
        raise ValueError("existing installed Discord SDK required")
    mount = await mount_registration_view(
        bot=bot, sdk=discord, commands_sdk=commands, runtime=prepared.runtime,
        member_provider=prepared.member_provider, issuer=prepared.issuer)
    if prepared.issuer.registration_scope.mode == "current-committee":
        try:
            command = make_registration_cog(bot=bot, sdk=discord, commands_sdk=commands,
                runtime=prepared.runtime, member_provider=prepared.member_provider,
                origin=prepared.runtime.origin, issuer=prepared.issuer, activate=False)
            mount.command_mount = await mount_registration_cog(bot=bot, sdk=discord, cog=command)
        except BaseException:
            await unmount_registration_view(bot=bot, mount=mount)
            raise
    # This is local command mounting only. No tree.sync or Discord command writes.
    setattr(bot, _MOUNT, mount)


async def teardown(bot):
    mount = getattr(bot, _MOUNT, None)
    if mount is None:
        return
    if mount.command_mount is not None:
        import discord
        await unmount_registration_cog(bot=bot, sdk=discord, mount=mount.command_mount)
    await unmount_registration_view(bot=bot, mount=mount)
    if getattr(bot, _MOUNT, None) is mount:
        delattr(bot, _MOUNT)


async def activate(bot, *, approved=False):
    if approved is not True:
        raise ValueError("Root coordinated activation required")
    mount = getattr(bot, _MOUNT, None)
    if mount is None:
        raise ValueError("owned registration extension not mounted")
    await mount.start(activate=True)
