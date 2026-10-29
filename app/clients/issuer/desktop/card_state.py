"""Portable card history. No USB, network, or automatic history reset.

Transfers only an append-only continuation of the current registry. Divergent
histories are rejected even when their current card bindings happen to agree.
"""
from __future__ import annotations
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import uuid
import zipfile

import manifest_batch as batch
import single_card_trial as trial

FORMAT = 'iyakusai-card-history-v1'
REGISTRY = 'issuance_registry.jsonl'
MARKER = 'history-info.json'
MAX_BYTES = 128 * 1024 * 1024
MAX_FILES = 100000


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def resolve_state(config, home, frozen=True):
    """Resolve relative to the EXE, never to the process working directory."""
    if config.get('error'):
        raise trial.TrialError(config['error'])
    value = config.get('card_state_dir')
    if not isinstance(value, str) or not value.strip():
        if not frozen:
            return trial.BASE
        raise trial.TrialError('発行履歴の設定がありません。ZIPを展開し、配布フォルダー全体を使ってください。')
    target = Path(value)
    portable = config.get('card_state_format') == FORMAT
    if not target.is_absolute():
        target = Path(home) / target
    target = target.resolve()
    if portable:
        if not Path(value).is_absolute():
            try:
                target.relative_to(Path(home).resolve())
            except ValueError as error:
                raise trial.TrialError('発行履歴の相対保存先が配布フォルダーの外を指しています。') from error
        info = json.loads((target / MARKER).read_text(encoding='utf-8'))
        if info.get('format') != FORMAT:
            raise trial.TrialError('発行履歴の形式を確認できません。元のフォルダーから引き継いでください。')
        raw = (target / REGISTRY).read_bytes()
        seed_length = info.get('seed_bytes')
        if type(seed_length) is not int or seed_length < 0 or digest(raw[:seed_length]) != info.get('seed_sha256') or len(raw) < seed_length:
            raise trial.TrialError('引き継いだ発行履歴の先頭が変更されています。バックアップを確認してください。')
        batch.registry_indexes(raw)
    elif not Path(value).is_absolute() or not all((target / f).is_file() for f in ('single_card_trial.py', 'manifest_batch.py')):
        raise trial.TrialError('旧版の発行履歴の保存先を開けません。新しい配布フォルダー全体を使ってください。')
    # Detect read-only folders before showing an enabled Start button.
    with tempfile.TemporaryFile(dir=target):
        pass
    return target


def activate(target):
    trial.BASE = Path(target).resolve()
    batch.REGISTRY = trial.BASE / REGISTRY
    batch.LOCK = trial.BASE / 'issuance_batch.lock'


def summary(folder):
    raw = (Path(folder) / REGISTRY).read_bytes()
    _, codes = batch.registry_indexes(raw)
    return {'events': len([line for line in raw.splitlines() if line]),
            'passed': sum(e['status'] == 'passed' for e in codes.values()),
            'reserved': sum(e['status'] == 'reserved' for e in codes.values()),
            'sha256': digest(raw)}


def snapshot(folder):
    """Read an existing history; never initializes or changes the source."""
    folder = Path(folder).resolve(strict=True)
    lock = folder / 'issuance_batch.lock'
    if lock.exists():
        raise trial.TrialError('発行処理中、または停止時のロックが残っています。発行を安全に停止してから引き継いでください。')
    registry = folder / REGISTRY
    raw = registry.read_bytes()
    batch.registry_indexes(raw)
    files = {REGISTRY: raw}
    evidence = folder / 'evidence'
    evidence_root = evidence.resolve()
    paths = sorted(p for p in evidence.rglob('*') if p.is_file()) if evidence.exists() else []
    for path in paths:
        if path.is_symlink() or not path.resolve().is_relative_to(evidence_root):
            raise trial.TrialError('証跡にフォルダー外へのリンクがあります。引継ぎを中止しました。')
        files[path.relative_to(folder).as_posix()] = path.read_bytes()
        if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_BYTES:
            raise trial.TrialError('発行履歴の容量が引継ぎの上限を超えています。')
    if registry.read_bytes() != raw or lock.exists():
        raise trial.TrialError('引継ぎ中に発行履歴が更新されました。発行を停止してからやり直してください。')
    after = sorted(p for p in evidence.rglob('*') if p.is_file()) if evidence.exists() else []
    if paths != after or any(path.read_bytes() != files[path.relative_to(folder).as_posix()] for path in paths):
        raise trial.TrialError('引継ぎ中に証跡が更新されました。発行を停止してからやり直してください。')
    return files


def save_archive(files, destination):
    destination = Path(destination)
    meta = {'format': FORMAT, 'created_at': datetime.now().astimezone().isoformat(),
            'files': {name: digest(raw) for name, raw in files.items()}}
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('history-manifest.json', json.dumps(meta, ensure_ascii=False, indent=2))
        for name, raw in files.items():
            archive.writestr(name, raw)
    return destination


def read_archive(source):
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(names) != len(set(names)) or len(names) > MAX_FILES + 1 or sum(i.file_size for i in infos) > MAX_BYTES + 1024 * 1024:
            raise trial.TrialError('履歴ZIPの件数・容量・重複を確認できません。')
        if 'history-manifest.json' not in names:
            raise trial.TrialError('「発行履歴をバックアップ」で保存したZIPを選んでください。')
        meta = json.loads(archive.read('history-manifest.json'))
        if meta.get('format') != FORMAT or not isinstance(meta.get('files'), dict) or set(meta['files']) != set(names) - {'history-manifest.json'}:
            raise trial.TrialError('履歴ZIPの形式またはファイル一覧が一致しません。')
        files = {}
        folded = set()
        for name, expected in meta['files'].items():
            path = PurePosixPath(name)
            if (name != REGISTRY and (not path.parts or path.parts[0] != 'evidence')) or path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name or name != path.as_posix() or name.casefold() in folded:
                raise trial.TrialError('履歴ZIPに不正な保存先があります。')
            folded.add(name.casefold())
            raw = archive.read(name)
            if digest(raw) != expected:
                raise trial.TrialError('履歴ZIPの内容が保存時のハッシュと一致しません。')
            files[name] = raw
    if REGISTRY not in files:
        raise trial.TrialError('履歴ZIPに発行台帳がありません。')
    batch.registry_indexes(files[REGISTRY])
    return files


@contextmanager
def history_lease(folder):
    """Uses the writer's very same lock file, without changing module globals."""
    folder = Path(folder).resolve()
    lock = folder / 'issuance_batch.lock'
    owner = uuid.uuid4().hex
    try:
        with lock.open('x', encoding='utf-8') as out:
            json.dump({'owner': owner, 'pid': os.getpid(), 'operation': 'history-transfer'}, out)
            out.flush()
            os.fsync(out.fileno())
    except FileExistsError as error:
        raise trial.TrialError('発行処理中、または停止時のロックが残っています。安全に停止してから操作してください。') from error
    try:
        yield
    finally:
        if lock.resolve().parent == folder and json.loads(lock.read_text(encoding='utf-8')).get('owner') == owner:
            lock.unlink()


def _owned_snapshot(folder):
    # Under our exclusive lease, exclude only our own lock from the snapshot check.
    registry = Path(folder) / REGISTRY
    files = {REGISTRY: registry.read_bytes()}
    batch.registry_indexes(files[REGISTRY])
    evidence = Path(folder) / 'evidence'
    evidence_root = evidence.resolve()
    for path in sorted(evidence.rglob('*')):
        if path.is_file():
            if path.is_symlink() or not path.resolve().is_relative_to(evidence_root):
                raise trial.TrialError('証跡にフォルダー外へのリンクがあります。')
            files[path.relative_to(folder).as_posix()] = path.read_bytes()
            if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_BYTES:
                raise trial.TrialError('発行履歴の容量が上限を超えています。')
    return files


def export_history(folder, destination):
    with history_lease(folder):
        return save_archive(_owned_snapshot(folder), destination)


def import_history(folder, source):
    source = Path(source)
    incoming = snapshot(source) if source.is_dir() else read_archive(source)
    folder = Path(folder).resolve()
    with history_lease(folder):
        current = _owned_snapshot(folder)
        old, new = current[REGISTRY], incoming[REGISTRY]
        if not new.startswith(old) and not old.startswith(new):
            raise trial.TrialError('このPCと取り込み元の発行履歴が分かれています。自動では統合できません。両方の履歴を保存し、担当者に確認してください。')
        for name, raw in incoming.items():
            if name == REGISTRY:
                continue
            target = (folder / name).resolve()
            if not target.is_relative_to(folder):
                raise trial.TrialError('証跡の保存先が履歴フォルダーの外を指しています。')
            if target.exists() and (not target.is_file() or target.read_bytes() != raw):
                raise trial.TrialError('同名の証跡の内容が異なります。現在の履歴は変更していません。')
        backup_dir = folder / 'backups'
        backup_dir.mkdir(exist_ok=True)
        backup = backup_dir / ('取り込み前_' + datetime.now().strftime('%Y%m%d_%H%M%S_') + uuid.uuid4().hex[:8] + '.zip')
        save_archive(current, backup)
        for name, raw in incoming.items():
            if name != REGISTRY and not (folder / name).exists():
                target = folder / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as out:
                    out.write(raw)
                    out.flush()
                    os.fsync(out.fileno())
        if len(new) > len(old):
            # Preserve every existing byte, with a complete backup and atomic commit.
            temporary = folder / ('.registry-' + uuid.uuid4().hex)
            try:
                with temporary.open('xb') as out:
                    out.write(new)
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temporary, folder / REGISTRY)
            finally:
                if temporary.exists():
                    temporary.unlink()
        return {'updated': len(new) > len(old), 'backup': str(backup), **summary(folder)}


def seed_history(source, destination):
    files = snapshot(source)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    for name, raw in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    info = {'format': FORMAT, 'created_at': datetime.now().astimezone().isoformat(),
            'seed_bytes': len(files[REGISTRY]), 'seed_sha256': digest(files[REGISTRY]),
            'note': '既存履歴を保持した配布時点のコピー。サーバーへの初回取り込みとPC内の証跡保存に使用。'}
    (destination / MARKER).write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'files': len(files), **summary(destination)}
