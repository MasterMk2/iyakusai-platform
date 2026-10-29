"""Offline tests of the reading desk: card URL rules, the browser service and the read loop (no USB)."""
from contextlib import contextmanager
import http.client
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "card"))
import reader_bridge as rb
import single_card_trial as trial
from test_single_card_trial import FakeLiteS

APP = "https://app.iyakusai.com"
LEGACY = "https://rental.iyakusai.com"
ORIGINS = [APP, LEGACY]


class PresenceCard(FakeLiteS):
    """A card that leaves the field after `stays` presence checks of each placement."""
    stays = 1

    @property
    def is_present(self):
        self.stays -= 1
        return self.stays >= 0


def issued_card(url, idm="0123456789ABCDEF"):
    """A formatted RC-S966 stand-in holding url as the one NDEF URI record."""
    card = PresenceCard(True)
    card._nfcid = card.idm = bytearray.fromhex(idm)
    encoded = trial.encode_url(url)
    attribute = card.memory[0]
    attribute[11:14] = len(encoded).to_bytes(3, "big")
    attribute[14:16] = sum(attribute[:14]).to_bytes(2, "big")
    padded = encoded + bytes(-len(encoded) % 16)
    for index in range(len(padded) // 16):
        card.memory[1 + index] = bytearray(padded[index * 16:(index + 1) * 16])
    return card


class CardRulesTests(unittest.TestCase):
    def test_item_url_of_the_app_gives_its_code(self):
        self.assertEqual("IY-100123", rb.item_code(APP + "/i/IY-100123", frozenset(ORIGINS)))
        self.assertEqual("IY-100123", rb.item_code("https://APP.iyakusai.com/i/iy-100123/", frozenset(ORIGINS)))
        self.assertEqual("IY-000123", rb.item_code(LEGACY + "/i/IY-000123", frozenset(ORIGINS)))
        self.assertEqual("IY-100007", rb.item_code(APP + "/rental?item=IY-100007", frozenset(ORIGINS)))

    def test_test_and_experimental_cards_are_refused(self):
        for url in ("https://example.com/?iy=IY-TEST-000001", "https://old-reader.example.net/i/IY-100001",
                    "http://app.iyakusai.com/i/IY-100001", APP + "/rental", APP + "/i/%3Cscript%3E"):
            with self.subTest(url=url), self.assertRaises(rb.CardRejected):
                rb.item_code(url, frozenset(ORIGINS))

    def test_short_number_matches_the_label(self):
        self.assertEqual("123", rb.short_number("IY-100123"))
        self.assertIsNone(rb.short_number("IY-100000"))
        self.assertIsNone(rb.short_number("IY-TEST-000001"))
        self.assertEqual("IY-100005（No.5）", rb.label("IY-100005"))

    def test_reads_the_url_of_an_issued_card_without_writing(self):
        card = issued_card(APP + "/i/IY-100123")
        self.assertEqual(("0123456789ABCDEF", APP + "/i/IY-100123"), rb.read_item_url(card))
        self.assertEqual([], card.writes)

    def test_blank_and_foreign_cards_are_told_apart(self):
        with self.assertRaisesRegex(rb.CardRejected, "まだ書き込まれていない"):
            rb.read_item_url(FakeLiteS(False))
        with self.assertRaisesRegex(rb.CardRejected, "FeliCa Lite-S"):
            rb.read_item_url(object())


class StandInReader:
    """Reader thread replacement: the test places cards with place()."""
    instances = []

    def __init__(self, card, rejected, state, stop, check_url):
        self.card, self.rejected, self.state, self.stop, self.check_url = card, rejected, state, stop, check_url
        StandInReader.instances.append(self)

    def run(self):
        self.state("ready", "カードを置いてください。")
        self.stop.wait()

    def place(self, url, idm="0123456789ABCDEF"):
        try:
            self.card(url, self.check_url(url), idm)
        except rb.CardRejected as reason:
            self.rejected(str(reason))


class Events:
    def __init__(self):
        self.values, self.condition = [], threading.Condition()

    def __call__(self, value):
        with self.condition:
            self.values.append(value)
            self.condition.notify_all()

    def wait(self, kind, timeout=3):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                found = [v for v in self.values if v["kind"] == kind]
                if found:
                    return found[-1]
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"No {kind}: {self.values}")
                self.condition.wait(remaining)


class BridgeServiceTests(unittest.TestCase):
    def setUp(self):
        StandInReader.instances.clear()
        self.events = Events()
        self.bridge = rb.ReaderBridge(self.events, ORIGINS + ["http://127.0.0.1:5173"], ORIGINS, port=0, reader_factory=StandInReader)
        self.bridge.start()
        self.addCleanup(self.bridge.stop)

    def request(self, path, origin=APP, method="GET", host=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.bridge.port, timeout=30)
        headers = {"Origin": origin} if origin else {}
        if host:
            connection.putrequest(method, path, skip_host=True)
            connection.putheader("Host", host)
            for name, value in headers.items():
                connection.putheader(name, value)
            connection.endheaders()
        else:
            connection.request(method, path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, response, json.loads(body) if body else {}

    def reader(self):
        deadline = time.monotonic() + 3
        while not StandInReader.instances:
            if time.monotonic() > deadline:
                raise AssertionError("reader did not start")
            time.sleep(0.01)
        return StandInReader.instances[-1]

    def test_only_the_rental_screen_may_ask(self):
        self.assertEqual(403, self.request("/v1/status", origin=None)[0])
        self.assertEqual(403, self.request("/v1/status", origin="https://example.com")[0])
        self.assertEqual(403, self.request("/v1/status", host=f"rebind.example:{self.bridge.port}")[0])
        status, response, body = self.request("/v1/status")
        self.assertEqual(200, status)
        self.assertEqual(APP, response.getheader("Access-Control-Allow-Origin"))
        self.assertEqual("iyakusai-rental-reader", body["app"])
        self.assertEqual(200, self.request("/v1/status", host=f"localhost:{self.bridge.port}")[0])

    def test_preflight_allows_the_private_network_request(self):
        status, response, _ = self.request("/v1/reads", method="OPTIONS")
        self.assertEqual(204, status)
        self.assertEqual("true", response.getheader("Access-Control-Allow-Private-Network"))
        self.assertEqual(APP, response.getheader("Access-Control-Allow-Origin"))

    def test_a_card_reaches_the_screen_that_connected(self):
        self.reader().place(APP + "/i/IY-100001")  # before any screen: never replayed
        status, _, first = self.request("/v1/reads?client=screen-0001&claim=1&wait=0")
        self.assertEqual((200, []), (status, first["reads"]))
        threading.Timer(0.3, lambda: self.reader().place(APP + "/i/IY-100123")).start()
        started = time.monotonic()
        status, _, body = self.request(f"/v1/reads?client=screen-0001&after={first['seq']}&wait=10")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(200, status)
        self.assertEqual(["IY-100123"], [r["code"] for r in body["reads"]])
        self.assertEqual(APP + "/i/IY-100123", body["reads"][0]["url"])
        self.assertEqual("CDEF", body["reads"][0]["idm_tail"])
        self.assertLess(body["reads"][0]["age_ms"], 3000)
        self.assertEqual(first["instance"], body["instance"])
        card = self.events.wait("reader_card")
        self.assertEqual(("IY-100123", "123"), (card["code"], card["number"]))
        connected, origin = self.bridge.browser()
        self.assertEqual((True, APP), (connected, origin))
        # Received only once the screen asks for what comes next.
        self.assertFalse(self.bridge.log.delivered(card["seq"]))
        self.request(f"/v1/reads?client=screen-0001&after={body['seq']}&wait=0")
        self.assertTrue(self.bridge.log.delivered(card["seq"]))

    def test_a_card_sent_to_a_screen_that_went_away_is_reported(self):
        self.request("/v1/reads?client=screen-0001&claim=1&wait=0")
        with patch.object(rb, "DELIVERY_CHECK", 0.3):
            self.reader().place(APP + "/i/IY-100010")
            status, _, body = self.request("/v1/reads?client=screen-0001&after=0&wait=5")
            self.assertEqual(["IY-100010"], [r["code"] for r in body["reads"]])
            # The screen was hidden when the answer came: it connects again instead of confirming.
            self.request("/v1/reads?client=screen-0001&claim=1&wait=0")
            event = self.events.wait("reader_undelivered")
        self.assertIn("No.10", event["text"])

    def test_the_last_screen_takes_over(self):
        self.request("/v1/reads?client=screen-0001&claim=1&wait=0")
        waiting = {}
        thread = threading.Thread(target=lambda: waiting.update(result=self.request("/v1/reads?client=screen-0001&after=0&wait=20")))
        thread.start()
        time.sleep(0.3)
        status, _, _ = self.request("/v1/reads?client=screen-0002&claim=1&wait=0", origin="http://127.0.0.1:5173")
        self.assertEqual(200, status)
        thread.join(5)
        self.assertEqual(409, waiting["result"][0])
        self.assertEqual("taken_over", waiting["result"][2]["code"])
        self.reader().place(APP + "/i/IY-100002")
        status, _, body = self.request("/v1/reads?client=screen-0002&after=0&wait=0", origin="http://127.0.0.1:5173")
        self.assertEqual(["IY-100002"], [r["code"] for r in body["reads"]])

    def test_restarted_reading_asks_the_screen_to_connect_again(self):
        self.request("/v1/reads?client=screen-0001&claim=1&wait=0")
        self.bridge.stop()
        self.bridge.port = self.bridge.port  # same port again
        self.bridge.start()
        status, _, body = self.request("/v1/reads?client=screen-0001&after=0&wait=0")
        self.assertEqual((409, "not_claimed"), (status, body["code"]))

    def test_bad_requests_are_refused(self):
        for path in ("/v1/reads?client=x&claim=1", "/v1/reads?client=screen-0001&after=-1", "/v1/reads?client=screen-0001&wait=nan"):
            with self.subTest(path=path):
                self.assertEqual(400, self.request(path)[0])
        self.assertEqual(404, self.request("/v1/other")[0])

    def test_a_card_nobody_takes_is_reported(self):
        with patch.object(rb, "DELIVERY_CHECK", 0.1):
            self.reader().place(APP + "/i/IY-100009")
            event = self.events.wait("reader_undelivered")
        self.assertIn("No.9", event["text"])

    def test_a_card_of_another_server_is_refused_before_the_browser(self):
        self.request("/v1/reads?client=screen-0001&claim=1&wait=0")
        self.reader().place("https://example.com/?iy=IY-TEST-000001")
        self.assertIn("example.com", self.events.wait("reader_rejected")["text"])
        self.assertEqual([], self.request("/v1/reads?client=screen-0001&after=0&wait=0")[2]["reads"])

    def test_one_reading_desk_per_pc(self):
        other = rb.ReaderBridge(lambda e: None, ORIGINS, ORIGINS, port=self.bridge.port, reader_factory=StandInReader)
        with self.assertRaisesRegex(rb.BridgeError, "すでに動いています"):
            other.start()
        self.assertFalse(other.running)


class FakeClf:
    def __init__(self, cards):
        self.cards = list(cards)

    def connect(self, rdwr, terminate):
        if self.cards:
            card = self.cards.pop(0)
            card.stays = 1
            return card
        while not terminate():
            time.sleep(0.01)
        return None


class ReadLoopTests(unittest.TestCase):
    def run_reader(self, cards, readers=1, until=lambda calls: False, timeout=3):
        calls = {"card": [], "rejected": [], "state": []}
        stop = threading.Event()

        @contextmanager
        def frontend():
            yield FakeClf(cards)

        reader = rb.CardReader(lambda url, code, idm: calls["card"].append(code),
                               lambda text: calls["rejected"].append(text),
                               lambda state, text: calls["state"].append(state), stop,
                               lambda url: rb.item_code(url, frozenset(ORIGINS)),
                               nfc_frontend=frontend, count_readers=lambda: readers)
        thread = threading.Thread(target=reader.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + timeout
        while not until(calls) and time.monotonic() < deadline:
            time.sleep(0.02)
        stop.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        return calls

    def test_each_card_once_per_placement(self):
        first = issued_card(APP + "/i/IY-100001")
        cards = [first, first, issued_card(APP + "/i/IY-100002", "00000000000000AA")]
        calls = self.run_reader(cards, until=lambda c: len(c["card"]) >= 2)
        # The same card back at once is the edge of the field, not a second tap.
        self.assertEqual(["IY-100001", "IY-100002"], calls["card"])
        self.assertEqual("ready", calls["state"][0])

    def test_same_card_again_after_a_pause_counts(self):
        card = issued_card(APP + "/i/IY-100001")
        with patch.object(rb, "SAME_CARD_DEBOUNCE", 0.0):
            calls = self.run_reader([card, card], until=lambda c: len(c["card"]) >= 2)
        self.assertEqual(["IY-100001", "IY-100001"], calls["card"])

    def test_refused_cards_and_lost_reads_are_explained(self):
        lost = issued_card(APP + "/i/IY-100003")
        lost.read_without_mac = lambda *blocks: (_ for _ in ()).throw(OSError(10060, "timed out"))
        blank = PresenceCard(False)
        cards = [blank, issued_card("https://example.com/?iy=IY-TEST-000001"), lost]
        calls = self.run_reader(cards, until=lambda c: len(c["rejected"]) >= 3)
        self.assertEqual([], calls["card"])
        self.assertIn("まだ書き込まれていない", calls["rejected"][0])
        self.assertIn("example.com", calls["rejected"][1])
        self.assertIn("置き直して", calls["rejected"][2])

    def test_no_reader_or_two_readers_are_reported(self):
        self.assertIn("missing", self.run_reader([], readers=0, until=lambda c: c["state"])["state"])
        self.assertIn("missing", self.run_reader([], readers=2, until=lambda c: c["state"])["state"])

    def test_an_unplugged_reader_is_reopened(self):
        opened = []

        @contextmanager
        def frontend():
            opened.append(1)
            if len(opened) == 1:
                raise OSError(19, "No such device")
            yield FakeClf([issued_card(APP + "/i/IY-100004")])

        calls = {"card": [], "state": []}
        stop = threading.Event()
        reader = rb.CardReader(lambda url, code, idm: calls["card"].append(code), lambda text: None,
                               lambda state, text: calls["state"].append(state), stop,
                               lambda url: rb.item_code(url, frozenset(ORIGINS)),
                               nfc_frontend=frontend, count_readers=lambda: 1)
        with patch.object(stop, "wait", side_effect=lambda timeout=None: time.sleep(min(timeout or 0, 0.05)) or stop.is_set()):
            thread = threading.Thread(target=reader.run, daemon=True)
            thread.start()
            deadline = time.monotonic() + 3
            while not calls["card"] and time.monotonic() < deadline:
                time.sleep(0.02)
            stop.set()
            thread.join(3)
        self.assertEqual(["error", "ready"], calls["state"][:2])
        self.assertEqual(["IY-100004"], calls["card"])


if __name__ == "__main__":
    unittest.main()
