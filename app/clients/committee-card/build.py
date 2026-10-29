"""Build a distinct committee-card executable. Never bundles account state or card credentials."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / '.builddeps'), str(ROOT / 'clients' / 'issuer' / 'card' / '.deps')]
from PyInstaller.__main__ import run
deps = ROOT / 'clients' / 'issuer' / 'card' / '.deps'
run([
    str(Path(__file__).with_name('main.py')), '--name', '委員カード', '--windowed', '--onedir', '--noupx', '--noconfirm',
    '--distpath', str(ROOT / 'windows'), '--workpath', str(ROOT / '.native-build'), '--specpath', str(ROOT / '.native-build'),
    '--paths', str(ROOT / 'clients' / 'committee-card'), '--paths', str(ROOT / 'clients' / 'issuer' / 'card'),
    '--paths', str(ROOT / 'clients' / 'issuer' / 'desktop'), '--paths', str(deps),
    '--collect-submodules', 'nfc', '--collect-submodules', 'ndef', '--collect-submodules', 'serial',
    '--hidden-import', 'usb1', '--hidden-import', 'pyDes', '--copy-metadata', 'nfcpy', '--copy-metadata', 'ndeflib', '--copy-metadata', 'libusb1',
    '--add-binary', str(deps / 'usb1' / 'libusb-1.0.dll') + ':usb1',
    '--exclude-module', 'numpy', '--exclude-module', 'matplotlib', '--exclude-module', 'scipy', '--exclude-module', 'pandas',
    '--exclude-module', 'IPython', '--exclude-module', 'pytest',
])
