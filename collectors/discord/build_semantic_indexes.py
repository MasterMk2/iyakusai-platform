"""Refresh only existing semantic-index sources with the installed local model.

Run by the Bot's collector (python -I, environment IYAKUSAI_KNOWLEDGE_DIR, IYAKUSAI_BOT_SRC, IYAKUSAI_CONFIG) or by hand:
    python build_semantic_indexes.py --check-only
The Bot's package (iyakusai_bot.semantic_index) is imported from IYAKUSAI_BOT_SRC, else from the repository layout
(../../bot/src next to this file). Nothing is read from the shared drive except the knowledge data itself.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
import tomllib
import uuid

_BOT_SRC = os.environ.get("IYAKUSAI_BOT_SRC") or str(Path(__file__).resolve().parents[2] / "bot" / "src")
sys.path.insert(0, _BOT_SRC)
from iyakusai_bot.semantic_index import (build_lock, refresh, inventory, read_generation,  # noqa: E402
                                        IndexErrorBase, PublicationDurabilityError)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--kind', choices=['both', 'digest', 'raw'], default='both')
    ap.add_argument('--check-only', action='store_true')
    ap.add_argument('--batch', type=int, default=1)
    args = ap.parse_args(argv)
    if not 1 <= args.batch <= 32:
        ap.error('batch must be 1..32')
    config_path = Path(os.environ.get('IYAKUSAI_CONFIG') or (Path.home() / '.iyakusai/config.toml')).expanduser()
    cfg = tomllib.loads(config_path.read_text(encoding='utf-8'))
    root = Path(os.environ.get('IYAKUSAI_KNOWLEDGE_DIR') or cfg['paths']['knowledge_dir']).expanduser()
    roots = cfg.get('knowledge', {}).get('digest_roots') or None
    blocked = cfg.get('knowledge', {}).get('blocklist') or []
    state = Path.home() / 'iyakusai/maintenance/semantic-index-refresh'
    kinds = ['digest', 'raw'] if args.kind == 'both' else [args.kind]
    reports = []
    if args.check_only:
        for kind in kinds:
            inv, rows, _ = inventory(root, kind, roots, blocked)
            try:
                _, _, _, current = read_generation(root, kind)
                built = current['built_at']
                fresh = current['fingerprint'] == inv['fingerprint']
            except (OSError, ValueError, KeyError, TypeError, IndexErrorBase):
                built, fresh = None, False
            report = {'kind': kind, 'status': 'fresh' if fresh else 'stale', 'files': len(inv['sources']), 'rows': len(rows), 'built_at': built,
                      'source_max_mtime_ns': max((s['mtime_ns'] for s in inv['sources'].values()), default=0)}
            print(json.dumps(report, sort_keys=True), flush=True)
        return 0
    try:
        with build_lock(state):
            for kind in kinds:
                try:
                    report = refresh(root, kind, roots=roots, blocked=blocked, batch=args.batch, cache_dir=state / 'embedding-cache',
                                     progress=lambda report: print(json.dumps(report, sort_keys=True), flush=True))
                except PublicationDurabilityError as exc:
                    report = exc.report
                except Exception as exc:
                    report = {'kind': kind, 'status': 'failed', 'error_type': type(exc).__name__, 'previous_generation_retained': True}
                reports.append(report)
                print(json.dumps(report, sort_keys=True), flush=True)
            state.mkdir(parents=True, exist_ok=True)
            temporary = state / ('.status-' + uuid.uuid4().hex + '.json')
            temporary.write_text(json.dumps({'last_attempt': time.time(), 'indexes': reports}, sort_keys=True), encoding='utf-8')
            os.replace(temporary, state / 'last_status.json')
    except IndexErrorBase as exc:
        print(json.dumps({'status': 'deferred', 'error_type': type(exc).__name__, 'previous_generation_retained': True}), flush=True)
        return 2
    return 1 if any(r['status'] not in ('fresh', 'updated') for r in reports) else 0


if __name__ == '__main__':
    raise SystemExit(main())
