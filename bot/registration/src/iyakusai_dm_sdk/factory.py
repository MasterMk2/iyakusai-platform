"""Pure existing-client injection. Never registers a cog or reads/configures secrets."""
import hmac

from . import delivery
from .controller import PurposeKey, SignedDMController
from .sdk_transport import compose_dm_core


def make_signed_dm_controller(*, client, sdk, ledger, signing_key, fingerprint_key,
                              origin, service_label, verify_recipient,
                              verify_transport, replay_guard, timeout=5):
    if (not isinstance(signing_key, PurposeKey) or signing_key.purpose != "smm-auth"
            or not isinstance(fingerprint_key, PurposeKey)
            or fingerprint_key.purpose != "dm-fingerprint"
            or hmac.compare_digest(signing_key.material, fingerprint_key.material)):
        raise ValueError("purpose keys must be separate")
    core = compose_dm_core(core_module=delivery, ledger=ledger,
                           fingerprint_key=fingerprint_key.material,
                           client=client, sdk=sdk, origin=origin,
                           service_label=service_label, verify_recipient=verify_recipient,
                           timeout=timeout)
    return SignedDMController(core=core, signing_key=signing_key,
                              verify_transport=verify_transport, replay_guard=replay_guard)
