import json
import unittest
from workflow import ApiClient,WorkflowError
from test_server_management import Opener,ORIGIN
import test_force_reset as forced

class ResetCodeApiTests(unittest.TestCase):
    def test_new_server_negotiates_short_code_and_sends_typed_code(self):
        opener=Opener({'/api/rental/issuer/preview':{'confirmation_code':'573'},'/api/rental/issuer/apply':{'items':[]}})
        client=ApiClient(ORIGIN,opener=opener);client.prefix='/api/rental'
        client.capabilities={'issuer_management_v1','issuer_force_reset_v1','issuer_numbering_reset_v1','issuer_reset_code_v1'}
        for mode in ('force_reset','force_reset_all'):
            self.assertEqual(client.preview_changes(mode)['confirmation_code'],'573')
            self.assertEqual(json.loads(opener.requests[-1].data),{'mode':mode,'confirmation_style':'digits3'})
        client.apply_changes('review','573',all_writers_stopped=True)
        self.assertEqual(json.loads(opener.requests[-1].data),{'token':'review','confirmation':'573','all_writers_stopped':True})

    def test_invalid_or_missing_short_code_does_not_allow_apply(self):
        for code in (None,573,'57','5734','５７３','abc',''):
            opener=Opener({'/api/rental/issuer/preview':{'confirmation_code':code}})
            client=ApiClient(ORIGIN,opener=opener);client.prefix='/api/rental'
            client.capabilities={'issuer_management_v1','issuer_force_reset_v1','issuer_reset_code_v1'}
            with self.assertRaises(WorkflowError):client.preview_changes('force_reset')
            self.assertEqual(len(opener.requests),1)

class ResetCodeGuiTests(unittest.TestCase):
    setUp=forced.ForcedResetGuiTests.setUp
    tearDown=forced.ForcedResetGuiTests.tearDown
    preview=forced.ForcedResetGuiTests.preview
    apply=forced.ForcedResetGuiTests.apply

    def test_short_code_is_required_instead_of_the_legacy_phrase(self):
        p={**self.preview(),'confirmation_code':'573'}
        self.app.show_server_preview({'preview':p,'items':[],'target':None});self.app._preview_dialog.withdraw()
        for value in ('物品台帳を強制リセット','57','572','５７３','573 '):
            self.app._preview_confirmation.set(value)
            self.assertTrue(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_confirmation.set('573');self.assertFalse(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_apply_button.invoke();self.assertEqual(self.applied,[('reviewed-token','573')])

    def test_numbering_reset_still_needs_all_pc_stop_and_uses_the_new_preview_code(self):
        self.app.client.apply_changes=lambda token,confirmation,**kw: self.apply(token,confirmation) if kw.get('all_writers_stopped') else self.fail('PC stop confirmation missing')
        p={**self.preview('force_reset_all'),'confirmation_code':'814'}
        self.app.show_server_preview({'preview':p,'items':[],'target':None});self.app._preview_dialog.withdraw()
        self.app._preview_confirmation.set('814');self.assertTrue(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_ack.set(True);self.assertFalse(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_apply_button.invoke();self.assertEqual(self.applied,[('reviewed-token','814')])

if __name__=='__main__':unittest.main()
