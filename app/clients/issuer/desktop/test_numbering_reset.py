import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import test_card_state as portable
import test_force_reset as forced
import card_state
from server_history import ServerHistory
from workflow import ApiClient, WorkflowError, generate_bundle
import manifest_batch
from test_server_management import Opener, ORIGIN

class NumberingApiTests(unittest.TestCase):
    def test_unsupported_server_has_no_write_and_new_mode_omits_items(self):
        opener=Opener({'/api/rental/issuer/preview':{'mode':'force_reset_all'},'/api/rental/issuer/apply':{'items':[],'ledger_generation':2}})
        client=ApiClient(ORIGIN,opener=opener);client.prefix='/api/rental';client.capabilities={'issuer_management_v1'}
        with self.assertRaises(WorkflowError):client.preview_changes('force_reset_all')
        self.assertEqual(opener.requests,[])
        client.capabilities.add('issuer_numbering_reset_v1');client.ledger_generation=1
        client.preview_changes('force_reset_all',[{'ignore':True}])
        self.assertEqual(json.loads(opener.requests[-1].data),{'mode':'force_reset_all'})
        self.assertEqual(opener.requests[-1].get_header('X-rental-generation'),'1')
        client.apply_changes('review','連番と重複防止を含めて初期化',all_writers_stopped=True)
        self.assertTrue(json.loads(opener.requests[-1].data)['all_writers_stopped'])
        self.assertEqual(client.ledger_generation,2)

class NumberingGuiTests(unittest.TestCase):
    def setUp(self):
        forced.ForcedResetGuiTests.setUp(self)
        self.app.client.apply_changes=lambda token,confirmation,**kwargs:self.apply(token,confirmation,**kwargs)
    tearDown=forced.ForcedResetGuiTests.tearDown
    preview=forced.ForcedResetGuiTests.preview
    def apply(self,token,confirmation,**kwargs):
        self.assertTrue(kwargs.get('all_writers_stopped'))
        return forced.ForcedResetGuiTests.apply(self,token,confirmation)
    def test_nested_mode_defaults_off_and_needs_force_and_capability(self):
        self.assertFalse(self.app.reset_numbering.get())
        self.assertTrue(self.app.reset_numbering_check.instate(['disabled']))
        self.app.client.capabilities.add('issuer_numbering_reset_v1')
        self.app.force_server_reset.set(True);self.app._buttons()
        self.assertFalse(self.app.reset_numbering_check.instate(['disabled']))
        self.app.reset_numbering.set(True);self.app.reset_server()
        self.assertEqual(self.jobs[-1][1]['preview']['mode'],'force_reset_all')
        self.app.force_server_reset.set(False);self.app._buttons()
        self.assertFalse(self.app.reset_numbering.get())
    def test_requires_its_own_confirmation(self):
        self.app.show_server_preview({'preview':self.preview('force_reset_all'),'items':[],'target':None})
        self.app._preview_dialog.withdraw()
        self.app._preview_confirmation.set('物品台帳を強制リセット')
        self.assertTrue(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_confirmation.set('連番と重複防止を含めて初期化')
        self.assertTrue(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_ack.set(True)
        self.assertFalse(self.app._preview_apply_button.instate(['disabled']))
        self.app._preview_apply_button.invoke()
        self.assertEqual(self.applied,[('reviewed-token','連番と重複防止を含めて初期化')])

class NumberingMirrorTests(unittest.TestCase):
    setUp=portable.PortableHistoryTests.setUp
    tearDown=portable.PortableHistoryTests.tearDown
    def client(self,generation,registry=''):
        state={'ledger_generation':generation,'initialized':True,'registry':registry,'sha256':card_state.digest(registry.encode()),'passed':0,'reserved':0,'events':0}
        return SimpleNamespace(origin=ORIGIN,prefix='/api/rental',capabilities={'card_history_v1'},ledger_generation=generation,_request=lambda *args:state)
    def test_archives_pc_history_and_seed_before_mirroring_a_reset(self):
        raw=(self.folder/card_state.REGISTRY).read_bytes();marker=(self.folder/card_state.MARKER).read_bytes()
        client=self.client(1);history=ServerHistory(client,self.folder)
        self.assertEqual((self.folder/card_state.REGISTRY).read_bytes(),b'')
        backups=list((self.folder/'backups').glob('番号初期化前_*.zip'));self.assertEqual(len(backups),1)
        saved=card_state.read_archive(backups[0]);self.assertEqual(saved[card_state.REGISTRY],raw)
        self.assertEqual(next(v for k,v in saved.items() if k.endswith('/history-info.json')),marker)
        self.assertEqual(card_state.resolve_state(self.config,self.home),self.folder)
        self.assertEqual(json.loads((self.folder/'server-generation.json').read_text())['generation'],1)
        history.read();self.assertEqual(len(list((self.folder/'backups').glob('番号初期化前_*.zip'))),1)
    def test_backup_failure_preserves_the_current_history(self):
        raw=(self.folder/card_state.REGISTRY).read_bytes()
        with patch.object(card_state,'save_archive',side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError,'disk full'):ServerHistory(self.client(1),self.folder)
        self.assertEqual((self.folder/card_state.REGISTRY).read_bytes(),raw)
    def test_same_generation_divergence_is_never_treated_as_an_intentional_reset(self):
        raw=(self.folder/card_state.REGISTRY).read_bytes()
        with self.assertRaisesRegex(Exception,'一致しません'):ServerHistory(self.client(0),self.folder)
        self.assertEqual((self.folder/card_state.REGISTRY).read_bytes(),raw)
    def test_interrupted_local_transition_is_recoverable_from_the_same_server_generation(self):
        original=ServerHistory._replace
        def fail(history,path,raw):
            if path.name==card_state.REGISTRY:raise OSError('interrupted')
            return original(history,path,raw)
        with patch.object(ServerHistory,'_replace',fail):
            with self.assertRaisesRegex(OSError,'interrupted'):ServerHistory(self.client(1),self.folder)
        history=ServerHistory(self.client(1),self.folder)
        self.assertEqual(history.state['ledger_generation'],1)
        self.assertEqual((self.folder/card_state.REGISTRY).read_bytes(),b'')
    def test_manifest_binds_to_generation_and_old_manifest_is_refused(self):
        target=self.root/'new.pdf'
        manifest=generate_bundle([{'code':'IY-100001','name':'new item','url':ORIGIN+'/i/IY-100001'}],target,100000,1)
        self.assertEqual(manifest_batch.load_manifest(manifest).ledger_generation,1)
        history=ServerHistory(self.client(2),self.folder)
        old=manifest_batch.load_manifest(manifest)
        with self.assertRaisesRegex(Exception,'初期化前'):
            with history.item(SimpleNamespace(identifier=bytes.fromhex('0123456789ABCDEF')),old.items[0],old):pass

if __name__=='__main__':unittest.main()
