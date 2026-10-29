import json
import unittest
from workflow import ApiClient, WorkflowError, catalog_label_items

ORIGIN='https://app.example.test'
ROW={'code':'IY-100001','name':'机','url':ORIGIN+'/i/IY-100001','borrower_name':'模擬店A','borrower_id':'B-test','item_scope':'学外','item_owner':'試験会社','status':'ready','version':1}

class Response:
    def __init__(self,value): self.value=value
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def read(self,limit): return json.dumps(self.value,ensure_ascii=False).encode()
class Opener:
    def __init__(self,values): self.values=values; self.requests=[]
    def open(self,request,timeout):
        self.requests.append(request)
        return Response(self.values[request.full_url.removeprefix(ORIGIN)])

class ServerManagementTests(unittest.TestCase):
    def test_reads_bulk_server_snapshot_without_writing(self):
        expected={'items':[ROW],'revision':'abc','reserved_through':100001,'archived_count':0,'reset_allowed':True}
        opener=Opener({'/api/rental/issuer/state':expected})
        client=ApiClient(ORIGIN,opener=opener); client.prefix='/api/rental'; client.capabilities={'issuer_management_v1'}
        self.assertEqual(client.server_state(),expected)
        self.assertTrue(all(r.get_method()=='GET' for r in opener.requests))
    def test_older_server_can_be_read_using_its_exact_item_url(self):
        legacy={**ROW,'url':'https://legacy.example.test/i/IY-100001','planned_borrower_id':'B-test','planned_borrower_name':'模擬店A'}
        opener=Opener({'/api/rental/overview':{'items':[{'code':'IY-100001'}]},'/api/rental/items/IY-100001':legacy})
        client=ApiClient(ORIGIN,opener=opener); client.prefix='/api/rental'
        state=client.server_state()
        self.assertEqual(catalog_label_items(state)[0]['url'],legacy['url'])
        self.assertFalse(state['reset_allowed'])
        self.assertIsNone(state['revision'])
        self.assertTrue(all(r.get_method()=='GET' for r in opener.requests))
    def test_empty_ledger_is_readable(self):
        self.assertEqual(catalog_label_items({'items':[]}),[])
    def test_snapshot_removes_null_group_fields_but_retains_metadata(self):
        cleaned=catalog_label_items({'items':[{**ROW,'borrower_name':None,'borrower_id':None}]})[0]
        self.assertNotIn('borrower_name',cleaned)
        self.assertNotIn('status',cleaned)
        self.assertEqual(cleaned['item_owner'],'試験会社')
    def test_invalid_code_url_pair_is_refused(self):
        with self.assertRaises(WorkflowError): catalog_label_items({'items':[{**ROW,'url':ORIGIN+'/i/IY-100002'}]})
    def test_old_server_cannot_be_used_for_overwrite_or_reset(self):
        client=ApiClient(ORIGIN,opener=Opener({}))
        with self.assertRaisesRegex(WorkflowError,'サーバー側の更新'): client.preview_changes('reset')
        with self.assertRaises(WorkflowError): client.apply_changes('x','上書きを実行')
    def test_apply_sends_only_token_and_explicit_confirmation(self):
        opener=Opener({'/api/rental/issuer/apply':{'items':[]}})
        client=ApiClient(ORIGIN,opener=opener); client.prefix='/api/rental'; client.capabilities={'issuer_management_v1'}
        client.apply_changes('preview-1','物品台帳をリセット')
        self.assertEqual(json.loads(opener.requests[0].data),{'token':'preview-1','confirmation':'物品台帳をリセット'})
        self.assertEqual(opener.requests[0].get_header('X-smm-csrf'),'1')

if __name__=='__main__': unittest.main()
