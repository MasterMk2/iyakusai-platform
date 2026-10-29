"""Shared server authority; local files retain an exact history mirror and evidence.

A reservation is acknowledged by the server before the existing card-writing
code runs. Network failure never triggers an automatic physical write retry.
"""
from contextlib import contextmanager
import base64
import json
import os
from pathlib import Path
import socket
import uuid

import card_state
import manifest_batch as batch
import single_card_trial as trial


class ServerHistory:
    def __init__(self, client, folder):
        if 'card_history_v1' not in client.capabilities:
            raise trial.TrialError('サーバーを共通発行履歴対応版へ更新してから書き込んでください。')
        self.client, self.folder = client, Path(folder)
        self.state = self.read()

    def request(self, suffix='', body=None):
        return self.client._request(self.client.prefix + '/card-history' + suffix, body)

    def sync(self, state):
        raw = state['registry'].encode('utf-8')
        if card_state.digest(raw) != state['sha256']:
            raise trial.TrialError('サーバー発行履歴のハッシュが一致しません。')
        batch.registry_indexes(raw)
        generation = state.get('ledger_generation', 0)
        if type(generation) is not int or generation < 0:
            raise trial.TrialError('サーバー台帳の初期化番号が不正です。')
        marker = self.folder / 'server-generation.json'
        previous = json.loads(marker.read_text(encoding='utf-8')) if marker.exists() else {'generation': 0, 'origin': getattr(self.client, 'origin', '')}
        if previous.get('origin') != getattr(self.client, 'origin', '') or generation < previous.get('generation', 0):
            raise trial.TrialError('接続先または台帳の版が一致しません。旧履歴を保持して接続先を確認してください。')
        if generation > previous.get('generation', 0):
            with card_state.history_lease(self.folder):
                files = card_state._owned_snapshot(self.folder)
                stamp = uuid.uuid4().hex
                for name in (card_state.MARKER, 'server-generation.json'):
                    p = self.folder / name
                    if p.exists():
                        files['evidence/reset-' + stamp + '/' + name] = p.read_bytes()
                backups = self.folder / 'backups'
                backups.mkdir(exist_ok=True)
                card_state.save_archive(files, backups / ('番号初期化前_' + stamp + '.zip'))
                info_path = self.folder / card_state.MARKER
                if info_path.exists():
                    info = json.loads(info_path.read_text(encoding='utf-8'))
                    info.update(seed_bytes=0, seed_sha256=card_state.digest(b''))
                    self._replace(info_path, json.dumps(info, ensure_ascii=False, indent=2).encode('utf-8'))
                self._replace(self.folder / card_state.REGISTRY, raw)
                self._replace(marker, json.dumps({'origin': getattr(self.client, 'origin', ''), 'generation': generation}).encode('utf-8'))
        current = (self.folder / card_state.REGISTRY).read_bytes()
        if not raw.startswith(current):
            raise trial.TrialError('PCの履歴とサーバー履歴が一致しません。両方を保存して、既存履歴の取り込みを確認してください。')
        if raw != current:
            temporary = self.folder / ('.server-history-' + uuid.uuid4().hex)
            try:
                with temporary.open('xb') as out:
                    out.write(raw)
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temporary, self.folder / card_state.REGISTRY)
            finally:
                if temporary.exists():
                    temporary.unlink()
        if not marker.exists():
            self._replace(marker, json.dumps({'origin': getattr(self.client, 'origin', ''), 'generation': generation}).encode('utf-8'))
        self.client.ledger_generation = generation
        self.state = state
        return batch.registry_indexes(raw)

    def _replace(self, path, raw):
        temporary = path.parent / ('.history-reset-' + uuid.uuid4().hex)
        try:
            with temporary.open('xb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def read(self):
        state = self.request()
        if state['initialized']:
            self.sync(state)
        self.state = state
        return state

    def import_files(self, files):
        raw = files[card_state.REGISTRY]
        state = self.request('/import', {'registry': raw.decode('utf-8'), 'sha256': card_state.digest(raw),
            'evidence': {name: base64.b64encode(data).decode('ascii') for name, data in files.items() if name.startswith('evidence/')}})
        self.sync(state)
        return state

    def backup(self, destination):
        state = self.request('/backup')
        self.sync(state)
        files = {card_state.REGISTRY: state['registry'].encode('utf-8')}
        expected = {r['name']: r['sha256'] for r in state['evidence']}
        pending = list(expected)
        while pending:
            page = self.request('/backup-files', {'names': pending[:100]})['evidence']
            if not page or not set(page).issubset(set(pending[:100])):
                raise trial.TrialError('サーバー証跡の取得が進みません。バックアップを中止しました。')
            for name, entry in page.items():
                raw = base64.b64decode(entry['data'], validate=True)
                if card_state.digest(raw) != expected[name] or entry['sha256'] != expected[name]:
                    raise trial.TrialError('サーバー証跡のハッシュが一致しません。')
                files[name] = raw
                pending.remove(name)
        return card_state.save_archive(files, destination)

    def recover(self, operation):
        state = self.request('/recover', {'operation': operation, 'confirmation': '未完了の発行を引き継ぐ'})
        self.sync(state)
        return state

    @contextmanager
    def item(self, tag, item, manifest, force=False):
        if manifest.ledger_generation != getattr(self.client, 'ledger_generation', 0):
            raise trial.TrialError('初期化前の書込み用データです。新しいラベルとデータを作成してください。')
        idm = bytes(tag.identifier).hex().upper()
        claimed = self.request('/claim', {'code': item.code, 'idm': idm, 'url': item.url,
            'client': socket.gethostname()[:80], 'manifest_sha256': manifest.sha256,
            'pdf_sha256': manifest.pdf_sha256, 'force': bool(force)})
        indexes = self.sync(claimed)
        operation = claimed['operation']
        releases = []
        evidence_dir = None
        original_event, original_release = batch.registry_event, batch.registry_release

        def artifacts(phase):
            if evidence_dir is None:
                return {}
            root = Path(evidence_dir).resolve()
            return {'evidence/' + operation + '_' + phase + '/' + p.name: base64.b64encode(p.read_bytes()).decode('ascii')
                    for p in sorted(root.iterdir()) if p.is_file() and not p.is_symlink()}

        def release(card, code, url, reason, evidence):
            nonlocal evidence_dir
            evidence_dir = evidence
            e = {'time': trial.stamp(), 'idm': card, 'code': code, 'url': url, 'status': 'released', 'reason': reason, 'evidence': str(evidence)}
            releases.append(e)
            return e

        def record(selected, card, status, selected_manifest, evidence):
            nonlocal evidence_dir
            evidence_dir = evidence
            e = {'time': trial.stamp(), 'idm': card, 'code': selected.code, 'url': selected.url,
                 'status': status, 'manifest_sha256': selected_manifest.sha256,
                 'pdf_sha256': selected_manifest.pdf_sha256, 'evidence': str(evidence)}
            if status == 'passed':
                result = json.loads((Path(evidence) / 'binding-result.json').read_text(encoding='utf-8'))
                if result['status'] != 'passed' or result['idm'] != card:
                    raise trial.TrialError('読み戻し証跡のカードが一致しません。')
                e['verified_readback'] = True
                e['device_written'] = result['device_written']
            phase = 'reserve' if status == 'reserved' else 'pass'
            response = self.request('/transition', {'operation': operation, 'phase': phase,
                'entries': releases + [e] if phase == 'reserve' else [e], 'evidence': artifacts(phase)})
            self.sync(response)
            releases.clear()
            return response['entries'][-1]

        batch.registry_event, batch.registry_release = record, release
        try:
            yield indexes
        finally:
            batch.registry_event, batch.registry_release = original_event, original_release
            try:
                # Only unwritten claims may be released. A possibly written card
                # remains reserved, with failure evidence, until manual recovery.
                self.request('/cancel', {'operation': operation, 'evidence': artifacts('closed')})
            except Exception:
                # Never hide a write/readback failure with a cleanup error.
                pass
