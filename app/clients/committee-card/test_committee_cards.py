from pathlib import Path
import json
import http.client
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'issuer' / 'card'), str(ROOT / 'issuer' / 'desktop')]
import single_card_trial as trial
import reader_bridge as rb
from test_single_card_trial import FakeLiteS
from card_writer import ORIGIN, validate_login_url, write_blank_card, verify_card
import test_reader_bridge as reader_tests

URL = ORIGIN + '/card#' + 'a' * 43


class CommitteeCards(unittest.TestCase):
    def test_standard_ndef_url_roundtrip_fits_card(self):
        encoded = validate_login_url(URL)
        self.assertEqual(URL, trial.decode_url(encoded))
        self.assertLess(len(encoded), 208)
        self.assertEqual('LOGIN-CARD', rb.item_code(URL, {ORIGIN}))

    def test_foreign_or_item_urls_and_bad_tokens_refused(self):
        for url in [URL.replace('app.', 'rental.'), URL.replace('https:', 'http:'), ORIGIN + '/i/IY-100001', URL + 'x', URL.replace('/card#', '/card?token='), URL.replace('/card#', '/card/#')]:
            with self.subTest(url=url), self.assertRaises(Exception): validate_login_url(url)

    def test_blank_card_write_and_independent_readback_no_credentials_in_result(self):
        card = FakeLiteS()
        count = []
        def reacquire(tag, expected, text):
            self.assertEqual(expected, trial.guard_tag(tag))
            count.append(text)
            return tag.represented()
        result = write_blank_card(card, URL, reacquire)
        self.assertEqual('passed', result['status'])
        self.assertEqual(2, len(count))
        self.assertNotIn('a' * 43, json.dumps(result))
        self.assertEqual(URL, trial.decode_url(bytes.fromhex(trial.take_snapshot(card)['ndef_hex'])))
        card.writes.clear()
        self.assertEqual('passed', verify_card(card, URL)['status'])
        self.assertEqual([], card.writes)

    def test_occupied_card_is_refused_before_any_write(self):
        card = FakeLiteS()
        card.memory[5][0] = 1
        with self.assertRaises(trial.TrialError): write_blank_card(card, URL, lambda *args: card)
        self.assertEqual([], card.writes)

    def test_formatted_blank_card_needs_only_the_readback_retap(self):
        card = FakeLiteS(True)
        calls = []
        result = write_blank_card(card, URL, lambda tag, *args: (calls.append(1), tag.represented())[1])
        self.assertEqual('passed', result['status'])
        self.assertEqual(1, len(calls))

    def test_different_card_at_readback_is_refused(self):
        card = FakeLiteS(True)
        other = FakeLiteS(True)
        other._nfcid = other.idm = bytearray.fromhex('FFFFFFFFFFFFFFFF')
        with self.assertRaises(trial.TrialError): write_blank_card(card, URL, lambda *args: other)

    def test_verification_failure_does_not_log_the_secret_or_overwrite(self):
        card = FakeLiteS(True)
        with self.assertRaises(trial.TrialError): verify_card(card, URL)
        self.assertEqual([], card.writes)

    def test_rental_poll_cannot_receive_login_credentials(self):
        log = rb.ReadLog()
        log.wait('rental-user', None, 0, claim=True, origin=ORIGIN)
        log.push(URL, 'LOGIN-CARD', '0123456789ABCDEF')
        reply = log.wait('rental-user', 0, 0, origin=ORIGIN)
        self.assertEqual([], reply['reads'])
        self.assertNotIn('a' * 43, json.dumps(reply))
        log.wait('login-user', None, 0, claim=True, origin=ORIGIN, purpose='login')
        log.push(URL, 'LOGIN-CARD', '0123456789ABCDEF')
        reply = log.wait('login-user', 1, 0, origin=ORIGIN, purpose='login')
        self.assertEqual(URL, reply['reads'][0]['url'])

    def test_login_poll_does_not_receive_item_cards_and_stale_reads_are_not_replayed(self):
        log = rb.ReadLog()
        log.push(URL, 'LOGIN-CARD', '0123456789ABCDEF')
        self.assertEqual([], log.wait('login-user', None, 0, claim=True, purpose='login')['reads'])
        log.push(ORIGIN + '/i/IY-100001', 'IY-100001', '0123456789ABCDEF')
        self.assertEqual([], log.wait('login-user', 1, 0, purpose='login')['reads'])
        self.assertFalse(log.wait('login-user', 1, 0, purpose='rental')['ok'])

    def test_login_credentials_are_redacted_from_issuer_log_events(self):
        events = []
        bridge = rb.ReaderBridge(events.append, [ORIGIN], [ORIGIN])
        with patch.object(rb.threading.Timer, 'start'):
            bridge._card(rb.ReadLog(), URL, 'LOGIN-CARD', '0123456789ABCDEF')
        self.assertNotIn('a' * 43, json.dumps(events))
        self.assertEqual('', events[0]['url'])


class LoginHttpTests(unittest.TestCase):
    def setUp(self):
        self.bridge = rb.ReaderBridge(lambda _: None, [ORIGIN], [ORIGIN], port=0, reader_factory=reader_tests.StandInReader)
        self.bridge.start()
        self.addCleanup(self.bridge.stop)

    def get(self, path):
        connection = http.client.HTTPConnection('127.0.0.1', self.bridge.port, timeout=5)
        connection.request('GET', path, headers={'Origin': ORIGIN})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_purpose_login_http_delivery_and_rental_secrecy(self):
        self.get('/v1/reads?client=rental-user&claim=1&wait=0')
        self.bridge.log.push(URL, 'LOGIN-CARD', '0123456789ABCDEF')
        status, body = self.get('/v1/reads?client=rental-user&after=0&wait=0')
        self.assertEqual(200, status)
        self.assertNotIn('a' * 43, json.dumps(body))
        self.get('/v1/reads?client=login-user&claim=1&purpose=login&wait=0')
        self.bridge.log.push(URL, 'LOGIN-CARD', '0123456789ABCDEF')
        status, body = self.get('/v1/reads?client=login-user&after=1&purpose=login&wait=0')
        self.assertEqual(200, status)
        self.assertTrue(body['login_cards'])
        self.assertEqual(URL, body['reads'][0]['url'])

    def test_invalid_purpose_refused(self):
        self.assertEqual(400, self.get('/v1/reads?client=login-user&claim=1&purpose=other&wait=0')[0])


if __name__ == '__main__': unittest.main()
