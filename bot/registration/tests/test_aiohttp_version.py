"""The one aiohttp release the registration runtime accepts must be the one the Bot installs.

aiohttp_server.start() and AiohttpIssuerTransport refuse any other installed aiohttp, silently.
On the Bot host that leaves the login member check (and registration DMs) unavailable, so a
version raised in one place only must fail here, not in production (2026-11-13).
"""

import ast
import importlib.util
import re
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "src" / "iyakusai_registration_runtime"
SERVER = RUNTIME / "aiohttp_server.py"
ISSUER = RUNTIME / "issuer.py"
REQUIREMENTS = ROOT.parent / "src" / "requirements.txt"
VERSION_LITERAL = re.compile(r"^\d+\.\d+\.\d+$")


def supported_version():
    for node in ast.parse(SERVER.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "SUPPORTED_AIOHTTP_VERSION" for t in node.targets):
            return node.value.value
    raise AssertionError("SUPPORTED_AIOHTTP_VERSION is not defined in aiohttp_server.py")


def load_server_module():
    """aiohttp_server.py has no package imports, so it loads on its own without site.json."""
    spec = importlib.util.spec_from_file_location("aiohttp_server_under_test", SERVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(spec.name, None)
    return module


class AiohttpVersionTest(unittest.TestCase):
    def test_requirements_pin_the_supported_version(self):
        pins = [line.split("#")[0].strip() for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines()
                if line.strip().lower().startswith("aiohttp")]
        self.assertEqual(pins, [f"aiohttp=={supported_version()}"])

    def test_issuer_uses_the_shared_constant(self):
        tree = ast.parse(ISSUER.read_text(encoding="utf-8"))
        literals = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
                    and VERSION_LITERAL.match(n.value)]
        self.assertEqual(literals, [], "issuer.py must not hard-code an aiohttp version")
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        self.assertIn("SUPPORTED_AIOHTTP_VERSION", names)

    def test_installed_aiohttp_is_the_supported_version(self):
        try:
            import aiohttp
        except ImportError:
            self.skipTest("aiohttp is not installed here")
        self.assertEqual(aiohttp.__version__, supported_version())

    def test_server_refuses_any_other_installed_version(self):
        module = load_server_module()
        fake_web = types.SimpleNamespace()

        def fake_import(installed_version):
            def import_module(name):
                return types.SimpleNamespace(__version__=installed_version) if name == "aiohttp" else fake_web
            return import_module

        server = module.AiohttpServer.__new__(module.AiohttpServer)
        server._web = None
        original = module.importlib.import_module
        try:
            module.importlib.import_module = fake_import("0.0.0")
            with self.assertRaises(module.ServerLifecycleError):
                server._load_web()
            module.importlib.import_module = fake_import(module.SUPPORTED_AIOHTTP_VERSION)
            self.assertIs(server._load_web(), fake_web)
        finally:
            module.importlib.import_module = original


if __name__ == "__main__":
    unittest.main()
