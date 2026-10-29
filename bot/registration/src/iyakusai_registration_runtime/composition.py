"""No-I/O construction from explicitly supplied existing-client resources."""
from dataclasses import dataclass, field
from pathlib import Path

from iyakusai_dm_sdk.controller import PurposeKey
from iyakusai_dm_sdk.delivery import Ledger
from .issuer import AiohttpIssuerTransport, RegistrationIssuer
from .key_reader import PurposeKeyPair
from .member import FreshGuildMemberVerifier
from .policy import RegistrationScope, checked_registration_scope
from .policy import BOOTSTRAP_USER_ID, KNOWN_SHARED_ACCOUNT_IDS
from .runtime import BotDMRuntime


@dataclass(frozen=True)
class PreparedRegistration:
    runtime: object = field(repr=False)
    member_provider: object = field(repr=False)
    issuer: object = field(repr=False)


def compose_existing_client(*, client, sdk, aiohttp_module, key_pair,
                            server_tls_context, issuer_tls_context,
                            ledger_directory, server_factory=None,
                            issuer_session_factory=None, registration_scope=None):
    scope = checked_registration_scope(registration_scope)
    if type(key_pair) is not PurposeKeyPair:
        raise ValueError("explicit protected purpose keys required")
    directory = Path(ledger_directory)
    if not directory.is_absolute():
        raise ValueError("explicit absolute dedicated ledger directory required")
    # No path exists/read/write check here: the dedicated Ledger enforces owner,
    # mode and symlink policy only when Root explicitly starts this runtime.
    signing = PurposeKey("smm-auth", key_pair.signing)
    fingerprint = PurposeKey("dm-fingerprint", key_pair.fingerprint)
    provider = FreshGuildMemberVerifier(client, sdk, KNOWN_SHARED_ACCOUNT_IDS, registration_scope=scope)
    transport = AiohttpIssuerTransport(
        aiohttp_module=aiohttp_module, ssl_context=issuer_tls_context,
        session_factory=issuer_session_factory)
    issuer = RegistrationIssuer(signing_key=signing, transport=transport, registration_scope=scope)
    runtime = BotDMRuntime(
        client=client, sdk=sdk, ledger_factory=lambda: Ledger(directory),
        signing_key=signing, fingerprint_key=fingerprint,
        origin="https://task.iyakusai.com", service_label="医薬祭",
        member_provider=provider, bootstrap_user_id=BOOTSTRAP_USER_ID,
        tls_context=server_tls_context, server_factory=server_factory, registration_scope=scope)
    return PreparedRegistration(runtime, provider, issuer)

