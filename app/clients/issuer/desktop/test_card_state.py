import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'card'))
import card_state as state
import single_card_trial as trial


def line(code='IY-100001', idm='0123456789ABCDEF', status='passed'):
    return (json.dumps({'code': code, 'idm': idm, 'status': status, 'url': 'https://example.invalid/i/' + code}) + '\n').encode()


class PortableHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old = self.root / 'old'
        (self.old / 'evidence/old').mkdir(parents=True)
        (self.old / state.REGISTRY).write_bytes(line())
        (self.old / 'evidence/old/before.bin').write_bytes(bytes(range(256)))
        self.home = self.root / 'PC-A'
        self.home.mkdir()
        self.folder = self.home / '発行履歴'
        state.seed_history(self.old, self.folder)
        self.config = {'card_state_dir': '発行履歴', 'card_state_format': state.FORMAT}

    def tearDown(self):
        self.tmp.cleanup()

    def test_executable_relative_storage_and_byte_exact_seed(self):
        self.assertEqual(self.folder, state.resolve_state(self.config, self.home))
        self.assertEqual(state.snapshot(self.old), state.snapshot(self.folder))

    def test_moving_entire_folder_preserves_history_without_original_pc_path(self):
        import shutil
        relocated = self.root / '別PC'
        shutil.copytree(self.home, relocated)
        self.assertEqual(relocated / '発行履歴', state.resolve_state(self.config, relocated))
        self.assertEqual((self.old / state.REGISTRY).read_bytes(), (relocated / '発行履歴' / state.REGISTRY).read_bytes())

    def test_missing_history_never_initializes_an_empty_replacement(self):
        (self.folder / state.REGISTRY).unlink()
        with self.assertRaises(FileNotFoundError):
            state.resolve_state(self.config, self.home)
        self.assertFalse((self.folder / state.REGISTRY).exists())

    def test_seed_tamper_is_detected(self):
        (self.folder / state.REGISTRY).write_bytes(b'')
        with self.assertRaises(trial.TrialError):
            state.resolve_state(self.config, self.home)

    def test_backup_roundtrip_preserves_binary_evidence(self):
        path = self.root / 'backup.zip'
        state.export_history(self.folder, path)
        self.assertEqual(state.snapshot(self.old), state.read_archive(path))
        with self.assertRaises(FileExistsError):
            state.export_history(self.folder, path)

    def test_import_continuation_preserves_every_prior_byte_and_backup(self):
        before = (self.folder / state.REGISTRY).read_bytes()
        (self.old / state.REGISTRY).write_bytes(before + line('IY-100002', '0123456789ABCDEE', 'reserved'))
        result = state.import_history(self.folder, self.old)
        self.assertTrue(result['updated'])
        self.assertEqual(before, state.read_archive(result['backup'])[state.REGISTRY])
        self.assertTrue((self.folder / state.REGISTRY).read_bytes().startswith(before))

    def test_older_history_does_not_remove_later_events(self):
        before = (self.folder / state.REGISTRY).read_bytes() + line('IY-100002', '0123456789ABCDEE')
        (self.folder / state.REGISTRY).write_bytes(before)
        self.assertFalse(state.import_history(self.folder, self.old)['updated'])
        self.assertEqual(before, (self.folder / state.REGISTRY).read_bytes())

    def test_divergent_history_is_not_automatically_combined(self):
        prefix = (self.folder / state.REGISTRY).read_bytes()
        (self.folder / state.REGISTRY).write_bytes(prefix + line('IY-100002', '0123456789ABCDEE'))
        (self.old / state.REGISTRY).write_bytes(prefix + line('IY-100003', '0123456789ABCDED'))
        with self.assertRaisesRegex(trial.TrialError, '分かれ'):
            state.import_history(self.folder, self.old)

    def test_lock_blocks_backup_import_and_seed_snapshot(self):
        (self.folder / 'issuance_batch.lock').write_text('another writer')
        with self.assertRaises(trial.TrialError):
            state.export_history(self.folder, self.root / 'blocked.zip')
        with self.assertRaises(trial.TrialError):
            state.import_history(self.folder, self.old)
        self.assertEqual('another writer', (self.folder / 'issuance_batch.lock').read_text())

    def test_failed_commit_keeps_old_registry_and_durable_backup(self):
        before = (self.folder / state.REGISTRY).read_bytes()
        (self.old / state.REGISTRY).write_bytes(before + line('IY-100002', '0123456789ABCDEE'))
        with patch.object(state.os, 'replace', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):
                state.import_history(self.folder, self.old)
        self.assertEqual(before, (self.folder / state.REGISTRY).read_bytes())
        self.assertEqual(1, len(list((self.folder / 'backups').glob('*.zip'))))

    def test_changed_evidence_never_overwrites_original(self):
        target = self.folder / 'evidence/old/before.bin'
        before = target.read_bytes()
        (self.old / 'evidence/old/before.bin').write_bytes(b'changed')
        with self.assertRaisesRegex(trial.TrialError, '同名'):
            state.import_history(self.folder, self.old)
        self.assertEqual(before, target.read_bytes())


if __name__ == '__main__':
    unittest.main()
