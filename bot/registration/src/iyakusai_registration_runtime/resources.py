"""Explicit fixed resources for a separately approved existing-Bot process start.

No discovery, environment defaults, key generation, SDK client/login or listener
activation. Creating the factory does no resource I/O. Calling it requires the
fixed process UID, protected approved files, and returns an inactive composition.
"""

from __future__ import annotations

import os
import asyncio
import ssl
import stat

from .policy import RegistrationScope, checked_registration_scope
from .composition import compose_existing_client
from .key_reader import read_purpose_keys
from .site import SITE


RESOURCE_UID = SITE.resource_uid
CONFIG_DIRECTORY = SITE.config_directory
LEDGER_DIRECTORY = SITE.ledger_directory
SERVER_CERTIFICATE = SITE.server_certificate
SERVER_PRIVATE_KEY = SITE.server_private_key
KEY_ENCODING = "hex-lf-v1"


class ResourcesRefused(RuntimeError):
    """Sanitized failure, without paths, credential contents or chained errors."""


def _private_tls_file(path):
    # Metadata only. OpenSSL itself reads the fixed certificate/private key later.
    for ancestor in path.parents:
        item = ancestor.lstat()
        if not stat.S_ISDIR(item.st_mode):
            raise ValueError
    parent = path.parent.lstat()
    item = path.lstat()
    if (parent.st_uid != RESOURCE_UID or stat.S_IMODE(parent.st_mode) != 0o700
            or not stat.S_ISREG(item.st_mode) or item.st_uid != RESOURCE_UID
            or stat.S_IMODE(item.st_mode) != 0o600 or item.st_nlink != 1):
        raise ValueError
    return (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid,
            item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)


def _fixed_server_tls(*, certfile, keyfile):
    if certfile != SERVER_CERTIFICATE or keyfile != SERVER_PRIVATE_KEY:
        raise ValueError
    before = (_private_tls_file(certfile), _private_tls_file(keyfile))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certfile=str(certfile), keyfile=str(keyfile))
    if before != (_private_tls_file(certfile), _private_tls_file(keyfile)):
        raise ValueError
    return context


def _fixed_issuer_tls():
    # Existing system trust only; no additional CA or global trust-store changes.
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def make_fixed_factory(*, sdk, aiohttp_module, approved=False,
                       injectedreader=None, injectedservertls=None,
                       injectedissuertls=None, registration_scope="single-user-e2e", first_person_validation_ref=None,
                       active_role_ids=frozenset(), guild_current_membership_ref=None):
    """Return async factory(bot)->PreparedRegistration; explicit approval required.

    Injected loaders are for anonymous fixtures/owner-controlled composition only.
    They receive the same fixed paths and UID; no caller-controlled path is used.
    A factory is single-use and never automatically activates its returned runtime.
    """
    if (approved is not True or sdk is None or aiohttp_module is None
            or any(loader is not None and not callable(loader)
                   for loader in (injectedreader, injectedservertls, injectedissuertls))):
        raise ResourcesRefused("registration resources refused")
    scope = RegistrationScope(registration_scope, first_person_validation_ref, active_role_ids, guild_current_membership_ref)
    reader = read_purpose_keys if injectedreader is None else injectedreader
    server_tls = _fixed_server_tls if injectedservertls is None else injectedservertls
    issuer_tls = _fixed_issuer_tls if injectedissuertls is None else injectedissuertls
    called = False

    async def factory(bot):
        nonlocal called
        prepared = None
        try:
            if called or bot is None or os.geteuid() != RESOURCE_UID or getattr(bot, "loop", None) is not asyncio.get_running_loop():
                raise ValueError
            called = True
            pair = reader(CONFIG_DIRECTORY, encoding=KEY_ENCODING, expected_uid=RESOURCE_UID)
            server_context = server_tls(certfile=SERVER_CERTIFICATE, keyfile=SERVER_PRIVATE_KEY)
            issuer_context = issuer_tls()
            prepared = compose_existing_client(
                client=bot, sdk=sdk, aiohttp_module=aiohttp_module, key_pair=pair,
                server_tls_context=server_context, issuer_tls_context=issuer_context,
                ledger_directory=LEDGER_DIRECTORY, registration_scope=scope)
        except Exception:
            pass
        if prepared is None:
            raise ResourcesRefused("registration resources refused")
        return prepared

    return factory

