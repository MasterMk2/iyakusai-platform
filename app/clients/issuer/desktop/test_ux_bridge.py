"""UX contract regressions; only loopback HTTP and fake cards, never USB."""
import http.client
import json
import sys
from pathlib import Path
import threading
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'card'))
import reader_bridge as rb

class UXBridgeTests(unittest.TestCase):
    def setUp(self):
        self.log = rb.ReadLog()
        self.log.set_reader('ready', 'カードを置いてください。')
        self.first = self.log.wait('screen-0001', None, 0, claim=True)

    def poll(self, snapshot=None, timeout=0):
        s = snapshot or self.first
        return self.log.wait('screen-0001', s['seq'], timeout,
                             revision=s['revision'], event_after=s['event_seq'])

    def test_state_change_wakes_a_waiting_legacy_screen(self):
        results=[]
        thread=threading.Thread(target=lambda:results.append(self.log.wait('screen-0001',0,5)))
        thread.start(); time.sleep(.05); start=time.monotonic()
        self.log.set_reader('missing','USBを接続してください。'); thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic()-start,1)
        self.assertEqual(results[0]['reader']['state'],'missing')
        self.assertEqual(results[0]['reads'],[])
        self.assertEqual(results[0]['seq'],0)

    def test_between_polls_state_change_is_not_lost(self):
        self.log.set_reader('missing','USBなし')
        start=time.monotonic(); result=self.poll(timeout=2)
        self.assertLess(time.monotonic()-start,.2)
        self.assertEqual(result['reader']['state'],'missing')

    def test_identical_status_does_not_spin_the_poll(self):
        self.log.set_reader('ready','カードを置いてください。')
        start=time.monotonic(); self.poll(timeout=.09)
        self.assertGreaterEqual(time.monotonic()-start,.075)

    def test_rejections_have_separate_numbers_and_no_card_ack(self):
        self.log.reject('まだ書き込まれていないカードです。')
        self.log.reject('対象外のカードです。')
        result=self.poll()
        self.assertEqual(result['seq'],0); self.assertEqual(result['reads'],[])
        self.assertEqual([e['seq'] for e in result['events']],[1,2])
        self.assertEqual(self.poll(result)['events'],[])
        card=self.log.push('https://app.iyakusai.com/i/IY-100001','IY-100001','0123456789ABCDEF')
        read=self.poll(result); self.assertEqual(read['seq'],1)
        self.assertFalse(self.log.delivered(card['seq']))
        self.poll(read); self.assertTrue(self.log.delivered(card['seq']))

    def test_claim_does_not_replay_old_feedback_or_cards(self):
        self.log.reject('古い失敗'); self.log.push('url','IY-100001','1234')
        snap=self.log.wait('screen-0002',None,0,claim=True,event_after=0,revision=0)
        self.assertEqual(snap['events'],[]); self.assertEqual(snap['reads'],[])
        self.assertEqual(self.poll()['code'],'taken_over')

    def test_rejection_wakes_a_pending_poll(self):
        result=[]
        thread=threading.Thread(target=lambda:result.append(self.poll(timeout=5)))
        thread.start(); time.sleep(.05); self.log.reject('置き直してください。'); thread.join(1)
        self.assertFalse(thread.is_alive()); self.assertEqual(result[0]['events'][0]['kind'],'rejected')

    def test_feedback_has_exact_order_relative_to_valid_cards(self):
        self.log.reject('正常カードより前')
        self.log.push('url','IY-100001','1234')
        self.log.reject('正常カードより後')
        result=self.poll()
        self.assertEqual(result['seq'],1)
        self.assertEqual([e['after_read_seq'] for e in result['events']],[0,1])

    def test_release_wakes_a_pending_poll(self):
        result=[]
        thread=threading.Thread(target=lambda:result.append(self.poll(timeout=5)))
        thread.start(); time.sleep(.05); self.log.release(); thread.join(1)
        self.assertFalse(thread.is_alive()); self.assertEqual(result[0]['code'],'not_claimed')

    def test_http_cursors_and_origin_restrictions(self):
        origin='http://127.0.0.1:17791'
        server=rb._Server(('127.0.0.1',0),rb._handler(self.log,{origin}))
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01},daemon=True)
        thread.start()
        def get(query,headers=None):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
            conn.request('GET','/v1/reads?client=screen-0001&after=0&'+query,headers=headers or {'Origin':origin})
            res=conn.getresponse(); status=res.status; body=json.loads(res.read());conn.close();return status,body
        try:
            for query in ('revision=-1','event_after=-1','revision=x','event_after=NaN'):
                self.assertEqual(get(query)[0],400)
            self.log.reject('読取失敗')
            status,body=get(f"revision={self.first['revision']}&event_after=0")
            self.assertEqual(status,200);self.assertEqual(body['events'][0]['text'],'読取失敗')
            self.assertEqual(get('wait=0',{'Origin':'https://evil.example'})[0],403)
        finally:
            server.shutdown();server.server_close();thread.join(1)

if __name__ == '__main__': unittest.main()
