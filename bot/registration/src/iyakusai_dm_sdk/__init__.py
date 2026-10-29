"""Portable, inactive DM candidate; every live dependency is injected explicitly."""
from . import delivery
from .delivery import DeliveryCore, DeliveryFailure, Ledger, validate
from .sdk_transport import DiscordSDKTransport, compose_dm_core, compose_password_setup_core
from .controller import PurposeKey, SignedDMController, ReplayGuard, LedgerReplayGuard, canonical_bytes
from .factory import make_signed_dm_controller
from .asgi import DMASGIApplication

__all__ = [
    "delivery", "DeliveryCore", "DeliveryFailure", "Ledger", "validate",
    "DiscordSDKTransport", "compose_password_setup_core",
    "compose_dm_core", "PurposeKey", "SignedDMController", "ReplayGuard", "LedgerReplayGuard",
    "canonical_bytes", "make_signed_dm_controller", "DMASGIApplication",
]
