"""Synthetic server, exact PDF/card URLs and request recovery; never opens USB."""
import json
from pathlib import Path
import tempfile
import unittest

import workflow
import writer_worker
import manifest_batch
from test_workflow import FakeOpener, ORIGIN


def item():
    return {'code':'IY-IR-000001','name':'イレギュラーカード','url':ORIGIN+'/i/IY-IR-000001','card_kind':'irregular'}


class IrregularCardsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name)

    def client(self, replies):
        c=workflow.ApiClient(ORIGIN,opener=FakeOpener(replies))
        c.capabilities={'irregular_cards_v1','issuer_management_v1'}
        c.server_state=lambda:{'revision':'latest','reserved_through':100010,'items':[]}
        return c

    def test_pdf_manifest_and_card_encoding_preserve_exact_url_and_kind(self):
        path=workflow.generate_bundle([item()],self.folder/'labels.pdf',ledger_generation=2)
        self.assertEqual(workflow.load_bundle(path),[item()])
        manifest=manifest_batch.load_manifest(path)
        self.assertEqual(manifest.items[0].url,item()['url'])
        self.assertEqual(writer_worker.resolve_manual_input('IR-000001',manifest).code,item()['code'])
        self.assertEqual(manifest.ledger_generation,2)

    def test_catalog_preserves_irregular_kind_without_a_planned_group(self):
        self.assertEqual(workflow.catalog_label_items({'items':[item()]}),[item()])

    def test_rejects_irregular_code_that_lost_its_kind(self):
        broken=item();del broken['card_kind']
        with self.assertRaises(ValueError): workflow._label_module().normalize_items([broken])

    def test_request_id_survives_a_network_failure_and_is_reused(self):
        import urllib.error
        pending=self.folder/'pending.json'
        c=self.client([urllib.error.URLError('synthetic offline'),{'items':[item()],'ledger_generation':0}])
        with self.assertRaises(workflow.WorkflowError): c.create_irregular_bundle(1,self.folder/'first.pdf',pending)
        saved=json.loads(pending.read_text())
        path,items=c.create_irregular_bundle(1,self.folder/'retry.pdf',pending)
        bodies=[json.loads(r.data) for r in c.opener.requests]
        self.assertEqual(bodies[0]['request_id'],saved['request_id'])
        self.assertEqual(bodies[0],bodies[1])
        self.assertFalse(pending.exists())
        self.assertTrue(Path(path).is_file())
        self.assertEqual(items,[item()])

    def test_different_count_cannot_replace_a_pending_request(self):
        pending=self.folder/'pending.json'
        pending.write_text(json.dumps({'origin':ORIGIN,'count':2,'request_id':'existing'}))
        c=self.client([])
        with self.assertRaises(workflow.WorkflowError): c.create_irregular_bundle(1,self.folder/'x.pdf',pending)
        self.assertEqual(c.opener.requests,[])

    def test_older_server_is_refused_before_a_write(self):
        c=self.client([]);c.capabilities=set()
        with self.assertRaises(workflow.WorkflowError): c.create_irregular_bundle(1,self.folder/'x.pdf',self.folder/'pending.json')
        self.assertEqual(c.opener.requests,[])

    def test_existing_output_is_not_overwritten_or_registered(self):
        target=self.folder/'existing.pdf';target.write_bytes(b'original')
        c=self.client([])
        with self.assertRaises(workflow.WorkflowError): c.create_irregular_bundle(1,target,self.folder/'pending.json')
        self.assertEqual(target.read_bytes(),b'original')
        self.assertEqual(c.opener.requests,[])
