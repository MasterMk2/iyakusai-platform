"""No production connection, USB access, or card write. Real Tk widget state and API payloads."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from workflow import ApiClient, WorkflowError
from test_server_management import Opener, ORIGIN


class ForcedResetApiTests(unittest.TestCase):
    def test_old_server_is_not_sent_a_force_request(self):
        opener = Opener({})
        client = ApiClient(ORIGIN, opener=opener)
        client.capabilities = {'issuer_management_v1'}
        with self.assertRaisesRegex(WorkflowError, '強制リセットに未対応'):
            client.preview_changes('force_reset')
        self.assertEqual(opener.requests, [])

    def test_sends_distinct_mode_without_items(self):
        opener = Opener({'/api/rental/issuer/preview': {'mode': 'force_reset'}})
        client = ApiClient(ORIGIN, opener=opener)
        client.prefix = '/api/rental'
        client.capabilities = {'issuer_management_v1', 'issuer_force_reset_v1'}
        client.preview_changes('force_reset', [{'code': 'must-not-be-sent'}])
        self.assertEqual(json.loads(opener.requests[0].data), {'mode': 'force_reset'})


class ForcedResetGuiTests(unittest.TestCase):
    def setUp(self):
        import main
        self.main = main
        # Deliberately no history folder: this screen test cannot start the writer.
        with patch.object(main, 'configuration', return_value={'error': '合成画面試験'}):
            self.app = main.App()
        self.app.withdraw()
        self.jobs = []
        self.applied = []
        self.app.run_job = lambda action, job: self.jobs.append((action, job()))
        self.app.client = SimpleNamespace(
            capabilities={'issuer_management_v1', 'issuer_force_reset_v1'},
            card_history=None,
            preview_changes=lambda mode: self.preview(mode),
            apply_changes=lambda token, confirmation: self.apply(token, confirmation))
        self.app.accept_server_state({'items': [], 'reset_allowed': True, 'reserved_through': 100002})

    def tearDown(self):
        self.app.destroy()

    def preview(self, mode='force_reset', blocked=0):
        return {'mode': mode, 'token': 'reviewed-token', 'changed_count': 2, 'unchanged_count': 0,
                'blocked_count': blocked, 'note': '貸出中も保管。旧No.再利用不可。',
                'reset_counts': {'total': 2, 'loaned': 1, 'review': 1},
                'changes': [{'code': 'IY-100001', 'before': {'name': '合成机', 'status': 'loaned', 'borrower_name': '本部'},
                             'after': None, 'fields': ['台帳・貸出予定を保管'], 'blocked': None}]}

    def apply(self, token, confirmation):
        self.applied.append((token, confirmation))
        return {'items': [], 'reserved_through': 100002, 'reset_allowed': True}

    def test_mode_is_off_by_default_and_requires_capability_and_admin(self):
        self.assertFalse(self.app.force_server_reset.get())
        self.assertFalse(self.app.force_server_reset_check.instate(['disabled']))
        self.app.force_server_reset.set(True)
        self.app.client.capabilities.remove('issuer_force_reset_v1')
        self.app._buttons()
        self.assertTrue(self.app.force_server_reset_check.instate(['disabled']))
        self.assertFalse(self.app.force_server_reset.get())
        self.app.client.capabilities.add('issuer_force_reset_v1')
        self.app.server_snapshot['reset_allowed'] = False
        self.app._buttons()
        self.assertTrue(self.app.server_reset_button.instate(['disabled']))

    def test_selects_distinct_mode_and_does_not_start_when_busy(self):
        self.app.reset_server()
        self.assertEqual(self.jobs[-1][1]['preview']['mode'], 'reset')
        self.app.force_server_reset.set(True)
        self.app.reset_server()
        self.assertEqual(self.jobs[-1][1]['preview']['mode'], 'force_reset')
        self.app.busy = True
        self.app._buttons()
        self.assertTrue(self.app.force_server_reset_check.instate(['disabled']))
        self.app.reset_server()
        self.assertEqual(len(self.jobs), 2)

    def test_confirmation_and_cancel_do_not_apply(self):
        self.app.show_server_preview({'preview': self.preview(), 'items': [], 'target': None})
        self.app._preview_dialog.withdraw()
        self.assertTrue(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_confirmation.set('物品台帳をリセット')
        self.assertTrue(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_confirmation.set('物品台帳を強制リセット')
        self.assertFalse(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_dialog.destroy()
        self.assertEqual(self.applied, [])

    def test_exact_confirmation_dispatches_the_preview_token_only(self):
        self.app.show_server_preview({'preview': self.preview(), 'items': [], 'target': None})
        self.app._preview_dialog.withdraw()
        self.app._preview_confirmation.set('物品台帳を強制リセット')
        self.app._preview_apply_button.invoke()
        self.assertEqual(self.applied, [('reviewed-token', '物品台帳を強制リセット')])
        self.assertEqual(self.jobs[-1][0], 'server_apply')
        self.assertEqual(self.jobs[-1][1]['mode'], 'force_reset')

    def test_blocked_preview_stays_disabled(self):
        self.app.show_server_preview({'preview': self.preview(blocked=1), 'items': [], 'target': None})
        self.app._preview_dialog.withdraw()
        self.app._preview_confirmation.set('物品台帳を強制リセット')
        self.assertTrue(self.app._preview_apply_button.instate(['disabled']))


if __name__ == '__main__':
    unittest.main()
