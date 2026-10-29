"""Exercise the actual Tk start button and error/reopen state without USB or HTTP."""
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import main


class ResumeGuiTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.folder = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        seed = self.folder / 'seed'
        seed.mkdir()
        (seed / 'issuance_registry.jsonl').write_bytes(b'')
        self.state = self.folder / 'history'
        main.card_state.seed_history(seed, self.state)
        config = {'card_state_dir': str(self.state), 'card_state_format': main.card_state.FORMAT}
        self.stack.enter_context(patch.object(main, 'configuration', return_value=config))
        self.stack.enter_context(patch('nfc.ContactlessFrontend', side_effect=AssertionError('USB forbidden')))
        self.stack.enter_context(patch('nfc.clf.transport.USB.find', side_effect=AssertionError('USB enumeration forbidden')))
        self.previous_state = main.trial.BASE
        self.app = main.App()
        self.app.withdraw()
        self.addCleanup(self.cleanup_app)
        self.items = [{'code':f'IY-{100101+n}', 'name':f'合成テスト{n}', 'url':main.DEFAULT_ORIGIN+f'/i/IY-{100101+n}'} for n in range(3)]
        self.manifest = main.workflow.generate_bundle(self.items, self.folder/'labels.pdf')
        self.assertTrue(self.app.load_manifest(self.manifest))

    def cleanup_app(self):
        self.app.destroy()
        main.card_state.activate(self.previous_state)

    def test_error_keeps_number_through_button_refresh_and_real_start(self):
        code = self.items[1]['code']
        self.app._writer_event({'kind':'ready', 'code':code})
        self.app._writer_event({'kind':'error', 'fatal':True, 'text':'合成エラー'})
        self.app._writer_event({'kind':'finished', 'status':'failed', 'resume_code':code})
        self.app._buttons()
        self.assertEqual(code, self.app.start_code.get())
        self.assertEqual('No.102', self.app.current_code.get())
        self.assertEqual('続きから再開', self.app.start_button.cget('text'))
        controller = Mock(running=False)
        with patch.object(main.writer_worker, 'WriterController', return_value=controller) as factory:
            self.app.start_writer()
            controller.start.assert_called_once_with(mode='sequence', start_code=code)
            self.assertFalse(factory.call_args.kwargs['single_touch'])

    def test_irregular_button_calls_the_dedicated_flow_without_starting_a_writer(self):
        client = Mock(origin=self.app.origin.get(), capabilities={'irregular_cards_v1'})
        target = self.folder / 'irregular.pdf'
        client.create_irregular_bundle.return_value = ('manifest', [])
        self.app.client = client
        self.app.run_job = Mock()
        with patch.object(main.simpledialog, 'askinteger', return_value=4), patch.object(main.filedialog, 'asksaveasfilename', return_value=str(target)):
            self.app.irregular_button.invoke()
        action, job = self.app.run_job.call_args.args
        self.assertEqual(action, 'irregular_issue')
        job()
        client.create_irregular_bundle.assert_called_once_with(4, str(target), self.state / 'irregular-pending.json')
        self.assertIsNone(self.app.controller)

    def test_reopen_restores_number_and_confirmed_count(self):
        main.writer_worker.SequenceProgress(self.state/'書込み進捗', self.app._start_manifest).save(self.items[1]['code'], [self.items[0]['code']])
        self.app.start_code.set('')
        self.assertTrue(self.app.load_manifest(self.manifest))
        self.assertEqual('No.102', self.app.current_code.get())
        self.assertEqual({self.items[0]['code']}, self.app.passed_codes)
        self.assertIn('1 / 3', self.app.progress_text.get())
        self.assertFalse(self.app.single_touch.get())
        self.app.single_touch_check.invoke()
        self.assertTrue(self.app.single_touch.get())
        controller = Mock(running=False)
        with patch.object(main.writer_worker, 'WriterController', return_value=controller) as factory:
            self.app.start_writer()
            self.assertTrue(factory.call_args.kwargs['single_touch'])

    def test_user_can_explicitly_change_the_resume_number(self):
        self.app._writer_event({'kind':'finished', 'status':'stopped', 'resume_code':self.items[1]['code']})
        self.app.start_code.set('103')
        self.app._buttons()
        self.assertEqual('No.103', self.app.current_code.get())
        controller = Mock(running=False)
        with patch.object(main.writer_worker, 'WriterController', return_value=controller):
            self.app.start_writer()
            controller.start.assert_called_once_with(mode='sequence', start_code=self.items[2]['code'])


if __name__ == '__main__':
    unittest.main()
