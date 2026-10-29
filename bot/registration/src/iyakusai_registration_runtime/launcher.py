"""Optional controlled NEW-process launcher; never attaches to a running PID.

The original zero-argument main creates its one original Bot and handles its own
config/token/intents. Only that class's lifecycle methods are composed, locally
and temporarily, before main runs. No credentials are discovered by this file.
"""
import argparse
import asyncio
from contextlib import contextmanager
from dataclasses import dataclass, field
import inspect
import sys

from .composition import PreparedRegistration
from . import extension
from .view import send_initial_prompt


@dataclass
class _State:
    prepared: object = field(default=None, repr=False)
    original_setup_done: bool = False
    mount_done: bool = False
    active: bool = False
    activation_failed: bool = False
    prompt_claimed: bool = False
    closing: bool = False
    lock: object = field(default=None, repr=False)
    bound_factory: object = field(default=None, repr=False)
    owned_mount: object = field(default=None, repr=False)


@contextmanager
def install_lifecycle(bot_class, *, factory, activate=False, send_prompt=False):
    """New-launch scope only; does not create, login, close or signal any Bot."""
    if (not isinstance(bot_class, type) or not callable(factory)
            or type(activate) is not bool or type(send_prompt) is not bool
            or send_prompt and not activate):
        raise ValueError("explicit controlled launcher composition required")
    names = ("setup_hook", "on_ready", "close")
    originals = {name: getattr(bot_class, name) for name in names}
    if not all(inspect.iscoroutinefunction(fn) for fn in originals.values()):
        raise ValueError("verified original asynchronous Bot lifecycle required")
    own_attributes = {name: bot_class.__dict__.get(name) for name in names}
    present = {name: name in bot_class.__dict__ for name in names}
    states = {}

    async def teardown_owned(bot, state):
        if state.owned_mount is None:
            return
        if getattr(bot, extension._MOUNT, None) is not state.owned_mount:
            raise RuntimeError("existing registration mount retained")
        await extension.teardown(bot)
        state.owned_mount = None
        state.mount_done = False

    async def setup_hook(bot, *args, **kwargs):
        state = states.setdefault(bot, _State(lock=asyncio.Lock()))
        async with state.lock:
            if state.closing or state.mount_done or state.activation_failed:
                return
            if not state.original_setup_done:
                await originals["setup_hook"](bot, *args, **kwargs)
                state.original_setup_done = True
            if state.closing:
                return
            if (hasattr(bot, "iyakusai_registration_factory")
                    or getattr(bot, extension._MOUNT, None) is not None):
                state.activation_failed = True
                return  # Retain the original Bot's pre-existing attribute.

            async def bound_factory(existing_bot):
                if existing_bot is not bot or state.closing or state.prepared is not None:
                    raise ValueError("owned single existing-client factory required")
                prepared = factory(existing_bot)
                if inspect.isawaitable(prepared):
                    prepared = await prepared
                if (type(prepared) is not PreparedRegistration
                        or prepared.runtime.client is not bot):
                    raise ValueError("actual existing-client registration factory required")
                state.prepared = prepared
                if state.closing:
                    raise ValueError("registration setup stopped")
                return prepared

            state.bound_factory = bound_factory
            bot.iyakusai_registration_factory = bound_factory
            try:
                await extension.setup(bot)
                state.owned_mount = getattr(bot, extension._MOUNT)
                state.mount_done = True
                if state.closing:
                    await teardown_owned(bot, state)
            except Exception:
                # Optional AUTH dependencies cannot disable the original Bot.
                # Original setup errors occur above and still propagate normally.
                state.activation_failed = True
                try:
                    await teardown_owned(bot, state)
                except Exception:
                    pass  # Retain any owned mount for the close-time retry.
                if state.prepared is not None:
                    try:
                        await state.prepared.issuer.close()
                    except Exception:
                        pass
                if getattr(bot, "iyakusai_registration_factory", None) is bound_factory:
                    delattr(bot, "iyakusai_registration_factory")
                return
            except BaseException:
                if state.prepared is not None:
                    try:
                        await state.prepared.issuer.close()
                    except Exception:
                        pass
                if getattr(bot, "iyakusai_registration_factory", None) is bound_factory:
                    delattr(bot, "iyakusai_registration_factory")
                raise

    async def on_ready(bot, *args, **kwargs):
        await originals["on_ready"](bot, *args, **kwargs)
        state = states.get(bot)
        if state is None:
            return
        async with state.lock:
            if state.closing or not state.mount_done or not activate or state.activation_failed:
                return
            if getattr(bot, extension._MOUNT, None) is not state.owned_mount:
                state.activation_failed = True
                return  # Never activate a replacement owner's handle.
            if not state.active:
                try:
                    await extension.activate(bot, approved=True)
                except Exception:
                    state.activation_failed = True
                    return  # Fail closed; preserve original Bot behavior and logs.
                state.active = True
            if getattr(bot, extension._MOUNT, None) is not state.owned_mount:
                state.activation_failed = True
                return  # Activation awaited; recheck before any prompt.
            if send_prompt and not state.prompt_claimed and not state.closing:
                # Claim before await: uncertain prompt delivery is never resent.
                state.prompt_claimed = True
                try:
                    await send_initial_prompt(
                        bot=bot, sdk=state.prepared.runtime.sdk,
                        member_provider=state.prepared.member_provider,
                        mount=state.owned_mount, approve=True)
                except Exception:
                    pass

    async def close(bot, *args, **kwargs):
        state = states.get(bot)
        if state is not None:
            state.closing, state.active = True, False
        try:
            if state is not None:
                async with state.lock:
                    try:
                        await teardown_owned(bot, state)
                    finally:
                        if state.prepared is not None:
                            await state.prepared.issuer.close()
        finally:
            try:
                await originals["close"](bot, *args, **kwargs)
            finally:
                if (state is not None and state.bound_factory is not None
                        and getattr(bot, "iyakusai_registration_factory", None)
                        is state.bound_factory):
                    delattr(bot, "iyakusai_registration_factory")

    try:
        bot_class.setup_hook, bot_class.on_ready, bot_class.close = setup_hook, on_ready, close
        yield
    finally:
        for name in names:
            if present[name]:
                setattr(bot_class, name, own_attributes[name])
            else:
                delattr(bot_class, name)


def run_original_main(*, main, bot_class, factory=None, activate=False, send_prompt=False):
    """Invoke verified synchronous main once; preserve original sys.exit(main())."""
    if (not callable(main) or inspect.iscoroutinefunction(main)
            or len(inspect.signature(main).parameters) != 0
            or type(activate) is not bool or type(send_prompt) is not bool
            or factory is None and (activate or send_prompt)):
        raise ValueError("verified zero-argument original main required")

    def invoke():
        return main()

    if factory is None:
        return invoke()  # Default OFF: original lifecycle is untouched.
    with install_lifecycle(bot_class, factory=factory, activate=activate, send_prompt=send_prompt):
        return invoke()


def cli(argv=None):
    parser = argparse.ArgumentParser(description="Optional controlled IyakusaiBot launcher")
    parser.add_argument("--auth-enable", action="store_true")
    parser.add_argument("--send-bootstrap-prompt", action="store_true")
    parser.add_argument("--registration-scope", choices=("single-user-e2e", "current-committee"), default="single-user-e2e")
    parser.add_argument("--first-person-validation-ref")
    parser.add_argument("--active-committee-role-id", action="append", default=[])
    parser.add_argument("--guild-current-membership-ref")
    options = parser.parse_args(argv)
    if options.send_bootstrap_prompt and not options.auth_enable:
        parser.error("bootstrap prompt requires explicitly enabled AUTH")
    if options.registration_scope == "current-committee" and (not options.auth_enable or options.send_bootstrap_prompt or not options.first_person_validation_ref):
        parser.error("committee phase requires first-person validation and never resends the bootstrap prompt")
    if options.registration_scope == "single-user-e2e" and options.first_person_validation_ref is not None:
        parser.error("validation reference belongs only to the committee phase")
    from .policy import RegistrationScope
    try:
        if len(options.active_committee_role_id) != len(set(options.active_committee_role_id)):
            raise ValueError("duplicate active role")
        RegistrationScope(options.registration_scope, options.first_person_validation_ref,
                          frozenset(options.active_committee_role_id), options.guild_current_membership_ref)
    except ValueError:
        parser.error("one explicitly verified current-committee authority required")
    # These imports execute only in the later owner-authorized new Bot process.
    from iyakusai_bot.bot import IyakusaiBot
    from iyakusai_bot import __main__ as original_entry
    factory = None
    if options.auth_enable:
        import discord
        import aiohttp
        from .resources import make_fixed_factory
        factory = make_fixed_factory(sdk=discord, aiohttp_module=aiohttp, approved=True,
                                     registration_scope=options.registration_scope,
                                     first_person_validation_ref=options.first_person_validation_ref,
                                     active_role_ids=frozenset(options.active_committee_role_id),
                                     guild_current_membership_ref=options.guild_current_membership_ref)
    original_argv = sys.argv
    try:
        # The original production command has no extra arguments. Consume only
        # this wrapper's flags; retain normal original-main parser semantics.
        sys.argv = [original_entry.__file__]
        return run_original_main(main=original_entry.main, bot_class=IyakusaiBot,
                                 factory=factory, activate=options.auth_enable,
                                 send_prompt=options.send_bootstrap_prompt)
    finally:
        sys.argv = original_argv


if __name__ == "__main__":
    try:
        result = cli()
        raise SystemExit(result)
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        print("Controlled launcher unavailable; original service was not modified.", file=sys.stderr)
        raise SystemExit(1) from None
