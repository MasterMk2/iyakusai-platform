"""Windows one-folder build of the issuer (labels and FeliCa cards). Never includes staff secrets.

Run with a Python 3.12 that has ReportLab, openpyxl and Pillow:
    python build_desktop.py --pyinstaller-deps <folder with PyInstaller 6.22>
        --card-state-dir <existing history snapshot> --out <empty folder>

card/.deps (nfcpy 1.0.4, ndeflib, libusb1 with libusb-1.0.dll) is copied from the shared drive's
card/.deps and is not in Git. The existing history is copied into the EXE's
relative history folder. Shared server reservations are required for issuance.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ORIGINS = ['https://app.iyakusai.com', 'https://rental.iyakusai.com']


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pyinstaller-deps', type=Path, required=True)
    parser.add_argument('--card-state-dir', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--origin', default='https://app.iyakusai.com', choices=ORIGINS, help='Default server shown at start')
    args = parser.parse_args()
    state = args.card_state_dir.resolve()
    if not (state / 'issuance_registry.jsonl').is_file():
        parser.error('--card-state-dir must contain the existing issuance_registry.jsonl; never use an empty replacement history.')
    deps = ROOT / 'card' / '.deps'
    if not (deps / 'usb1' / 'libusb-1.0.dll').is_file():
        parser.error('card/.deps is missing: copy it from the shared drive card/.deps.')
    out = args.out.resolve()
    if out.exists() and any(out.iterdir()):
        parser.error('--out must be a new or empty folder.')
    work = out / 'work'
    source = work / 'source'
    source.mkdir(parents=True)
    for module in ('main.py', 'workflow.py', 'writer_worker.py', 'reader_bridge.py', 'reconcile.py', 'card_state.py', 'server_history.py'):
        shutil.copyfile(ROOT / 'desktop' / module, source / module)
    # The Excel import of the committee's own item master is not in the public tree; build it in when present.
    if (ROOT / 'desktop' / 'excel_import.py').is_file():
        shutil.copyfile(ROOT / 'desktop' / 'excel_import.py', source / 'excel_import.py')
    # A regular package, so no other folder named labels can shadow the label generator.
    (source / 'labels').mkdir()
    (source / 'labels' / '__init__.py').write_text('', encoding='utf-8')
    shutil.copyfile(ROOT / 'labels' / 'generate_labels.py', source / 'labels' / 'generate_labels.py')
    shutil.copyfile(ROOT / 'labels' / 'loan_sheet.py', source / 'labels' / 'loan_sheet.py')
    hooks = work / 'hooks'
    hooks.mkdir()
    (hooks / 'hook-workflow.py').write_text("# Our local workflow is not the unrelated PyPI workflow distribution.\ndatas=[]\nhiddenimports=['labels.generate_labels', 'labels.loan_sheet']\n", encoding='utf-8')

    sys.path.insert(0, str(args.pyinstaller_deps.resolve()))
    sys.path.insert(0, str(deps))
    from PyInstaller.__main__ import run

    run([
        str(source / 'main.py'), '--name', '物品発行', '--windowed', '--onedir', '--noupx', '--noconfirm',
        '--distpath', str(out / 'dist'), '--workpath', str(work / 'pyinstaller'), '--specpath', str(work),
        '--additional-hooks-dir', str(hooks),
        '--paths', str(source), '--paths', str(ROOT / 'card'), '--paths', str(deps),
        '--collect-submodules', 'nfc', '--collect-submodules', 'ndef', '--collect-submodules', 'serial',
        '--collect-submodules', 'reportlab.graphics.barcode',
        '--hidden-import', 'usb1', '--hidden-import', 'pyDes',
        '--add-binary', str(deps / 'usb1' / 'libusb-1.0.dll') + ':usb1',
        '--copy-metadata', 'nfcpy', '--copy-metadata', 'ndeflib', '--copy-metadata', 'libusb1',
        '--exclude-module', 'matplotlib', '--exclude-module', 'numpy', '--exclude-module', 'scipy',
        '--exclude-module', 'pandas', '--exclude-module', 'IPython', '--exclude-module', 'pytest',
    ])
    app = out / 'dist' / '物品発行'
    # The same program under the name the reading desk double-clicks: it opens only "貸出・返却の読取り".
    shutil.copyfile(app / '物品発行.exe', app / '物品読取.exe')
    (app / 'app-config.json').write_text(json.dumps({
        'origin': args.origin,
        'known_origins': ORIGINS,
        'card_state_dir': '発行履歴',
        'card_state_format': 'iyakusai-card-history-v1',
        'server_history_required': True,
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    sys.path[:0] = [str(ROOT / 'desktop'), str(ROOT / 'card')]
    import card_state
    card_state.seed_history(state, app / '発行履歴')
    print('APP_BUILT', app / '物品発行.exe', app / '物品読取.exe')


if __name__ == '__main__':
    main()
