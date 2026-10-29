"""Reads item cards on this PC's RC-S370 and hands them to the rental screen in the browser.

Loans and returns stay on the rental screen (https://app.iyakusai.com/rental): the borrower, photos,
the condition, unsent registrations and resending all live there. This module only READS cards: it never
writes, formats, protects or authenticates one, and it does not touch the issuance registry.

The browser receives each card through a small HTTP service on this PC:
- bound to 127.0.0.1 only, on port 48731 (the rental screen's Content-Security-Policy allows exactly it);
- answers only requests whose Origin is one of the app origins and whose Host is 127.0.0.1/localhost;
  other web pages, requests without an Origin (images, no-cors) and DNS rebinding get 403;
- one screen at a time: the screen that connected last ("claim") receives the cards, and an earlier one is
  told it was taken over, so a card never opens in two tabs;
- a card is offered only with an item URL of the app (https://app.iyakusai.com/i/<code> or the earlier
  https://rental.iyakusai.com/i/<code>); test and experimental cards are refused here, not in the browser.

GET /v1/status                                   -> {ok, app, version, instance, seq, reader}
GET /v1/reads?client=&after=&wait=[&claim=1]     -> {ok, instance, seq, reader, reads: [{seq, url, code, idm_tail, age_ms}]}
    The next request with after >= seq confirms the screen received those reads; a read nobody confirms
    within a few seconds is reported on this PC ("ブラウザに渡せていません").
    409 {code: taken_over}  another screen connected later; this one stops
    409 {code: not_claimed} reading restarted or stopped; connect again with claim=1
"""
from __future__ import annotations

from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import re
import socket
import socketserver
import sys
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit
import uuid

import single_card_trial as trial

DEFAULT_PORT = 48731
APP_NAME = "iyakusai-rental-reader"
VERSION = 1
MAX_WAIT = 25.0
# A screen that has not asked for this long is shown as not connected.
BROWSER_IDLE = 35.0
# A card not taken by a screen within this time is reported as not handed over.
DELIVERY_CHECK = 3.0
# The same card read again this soon after it left the reader is the field's edge, not a new tap.
SAME_CARD_DEBOUNCE = 1.5
CODE = re.compile(r"[A-Z0-9][A-Z0-9_-]{2,63}")
CLIENT = re.compile(r"[A-Za-z0-9-]{8,64}")


class CardRejected(Exception):
    """A card that is on the reader but is not an issued item card of this app."""


class BridgeError(RuntimeError):
    """Reading cannot start on this PC; the message is for the person at the desk."""


def origin_of(url):
    parts = urlsplit(url)
    if not parts.scheme or not parts.hostname:
        return ""
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme.lower()}://{parts.hostname.lower()}{port}"


def short_number(code):
    """The number printed large on labels: IY-100123 -> 123."""
    match = re.fullmatch(r"IY-1(\d{5})", code)
    return str(int(match.group(1))) if match and int(match.group(1)) else None


def label(code):
    number = short_number(code)
    return f"{code}（No.{number}）" if number else code


def item_code(url, card_origins):
    """Item code of a card URL of this app; anything else is refused with a reason for the desk."""
    if origin_of(url) not in card_origins:
        host = urlsplit(url).hostname or url[:40]
        raise CardRejected(f"この物品画面のカードではありません（{host}）。試験・実験用のカードは使えません。")
    parts = urlsplit(url)
    if (parts.path == "/card" and not parts.query and not parts.username and
            not parts.password and re.fullmatch(r"[A-Za-z0-9_-]{43}", parts.fragment)):
        return "LOGIN-CARD"
    match = re.fullmatch(r"/i/([^/]+)/?", parts.path)
    if match:
        code = unquote(match.group(1))
    else:
        query = parse_qs(parts.query)
        code = (query.get("item") or query.get("iy") or [""])[0]
    code = code.upper()
    if not CODE.fullmatch(code):
        raise CardRejected("カードのURLに物品の個体コードがありません。")
    return code


def read_item_url(tag):
    """The URL on an issued item card (RC-S966, NDEF with one URI record). Read commands only."""
    try:
        idm = trial.guard_tag(tag)
    except trial.TrialError:
        raise CardRejected("物品カード（FeliCa Lite-S）ではありません。") from None
    mc = bytes(tag.read_without_mac(0x88))
    if len(mc) != 16 or not mc[3] & 1:
        raise CardRejected("まだ書き込まれていないカードです。")
    attributes = trial.parse_attribute(bytes(tag.read_without_mac(0)))
    if not attributes or not attributes["length"]:
        raise CardRejected("まだ書き込まれていないカードです。")
    blocks = math.ceil(attributes["length"] / 16)
    data = b"".join(bytes(tag.read_without_mac(block)) for block in range(1, blocks + 1))
    try:
        url = trial.decode_url(data[:attributes["length"]])
    except trial.TrialError:
        raise CardRejected("カードのURLを読み取れません。") from None
    return idm, url


class ReadLog:
    """Cards read during one run, numbered, and which screen receives them. Thread-safe."""

    def __init__(self, limit=200):
        self._condition = threading.Condition()
        self._reads = deque(maxlen=limit)
        self._seq = 0
        self._revision = 0
        self._event_seq = 0
        self._events = deque(maxlen=limit)
        self.instance = uuid.uuid4().hex
        self._client = None
        self._purpose = "rental"
        self._last_poll = 0.0
        self._origin = ""
        self._reader = {"state": "starting", "text": "読取機を準備しています。"}

    def push(self, url, code, idm):
        with self._condition:
            self._seq += 1
            read = {"seq": self._seq, "url": url, "code": code, "idm_tail": idm[-4:],
                    "at": time.monotonic(), "sent_to": None, "delivered": False}
            self._reads.append(read)
            self._condition.notify_all()
            return dict(read)

    def delivered(self, seq):
        with self._condition:
            return any(r["seq"] == seq and r["delivered"] for r in self._reads)

    def set_reader(self, state, text):
        with self._condition:
            value = {"state": state, "text": text}
            if value != self._reader:
                self._reader = value
                self._revision += 1
                self._condition.notify_all()

    def reject(self, text):
        """Nonfatal feedback, independent of successful card numbers and their ACKs."""
        with self._condition:
            self._event_seq += 1
            self._revision += 1
            self._events.append({"seq": self._event_seq, "kind": "rejected", "text": text,
                                 "at": time.monotonic(), "after_read_seq": self._seq})
            self._condition.notify_all()

    def status(self):
        with self._condition:
            return {"ok": True, "app": APP_NAME, "version": VERSION, "instance": self.instance,
                    "login_cards": True,
                    "seq": self._seq, "reader": dict(self._reader),
                    "revision": self._revision, "event_seq": self._event_seq}

    def browser(self):
        """(connected, origin) of the screen that receives the cards."""
        with self._condition:
            connected = self._client is not None and time.monotonic() - self._last_poll < BROWSER_IDLE
            return connected, self._origin

    def release(self):
        """Reading stops: a waiting screen is told to connect again (it will find nothing until restart)."""
        with self._condition:
            self._client = None
            self._condition.notify_all()

    def wait(self, client, after, timeout, claim=False, origin="", revision=None, event_after=None, purpose="rental"):
        """Reads after `after` for the screen `client`, waiting up to `timeout` seconds for one."""
        deadline = time.monotonic() + max(0.0, min(timeout, MAX_WAIT))
        with self._condition:
            # Optional cursors are additive to v1. Old screens still wake on device changes.
            if revision is None or revision > self._revision:
                revision = self._revision
            if claim or after is None or event_after is None or event_after > self._event_seq:
                event_after = self._event_seq
            if claim:
                self._client, self._origin = client, origin
                self._purpose = purpose
                self._condition.notify_all()
            elif after is not None and self._client == client:
                # Asking for what comes after a read confirms the screen got it. An answer alone does not:
                # the screen may have dropped the request (hidden, closed) after it was sent.
                for r in self._reads:
                    if r["seq"] <= after and r["sent_to"] == client:
                        r["delivered"] = True
            if after is None or after > self._seq:
                # First answer, or numbers of an earlier run: start from now, never replay old cards.
                after = self._seq
            while True:
                if self._client is None:
                    return {"ok": False, "code": "not_claimed", "error": "読取りが再開されました。もう一度接続します。"}
                if self._client != client or self._purpose != purpose:
                    return {"ok": False, "code": "taken_over",
                            "error": "別のタブ・ウィンドウでPCの読取機を使い始めました。"}
                self._last_poll = time.monotonic()
                # A login secret never goes to the rental screen, including older clients.
                fresh = [r for r in self._reads if r["seq"] > after and
                         (r["code"] == "LOGIN-CARD") == (purpose == "login")]
                remaining = deadline - time.monotonic()
                events = [e for e in self._events if e["seq"] > event_after]
                if fresh or events or self._revision != revision or remaining <= 0:
                    now = time.monotonic()
                    for r in fresh:
                        r["sent_to"] = client
                    return {"ok": True, "instance": self.instance, "seq": self._seq, "reader": dict(self._reader),
                            "login_cards": True,
                            "reads": [{"seq": r["seq"], "url": r["url"], "code": r["code"], "idm_tail": r["idm_tail"],
                                       "age_ms": int((now - r["at"]) * 1000)} for r in fresh],
                            "revision": self._revision, "event_seq": self._event_seq,
                            "events": [{"seq": e["seq"], "kind": e["kind"], "text": e["text"],
                                        "age_ms": int((now - e["at"]) * 1000), "after_read_seq": e["after_read_seq"]} for e in events]}
                self._condition.wait(remaining)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second program bind the same port; refuse to share it instead.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        # HTTPServer.server_bind would look up this PC's name; nothing here needs it.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "127.0.0.1", self.server_address[1]


def _handler(log, page_origins):
    class Handler(BaseHTTPRequestHandler):
        server_version = "IyakusaiReader/1"

        def log_message(self, *_):
            pass

        def _allowed(self):
            port = self.server.server_address[1]
            origin = self.headers.get("Origin", "")
            if self.headers.get("Host", "") not in (f"127.0.0.1:{port}", f"localhost:{port}") or origin not in page_origins:
                self._send(403, {"ok": False, "code": "forbidden", "error": "この読取りソフトは医薬祭の物品画面からだけ使えます。"}, None)
                return None
            return origin

        def _send(self, status, body, origin, extra=()):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Vary", "Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
            for name, value in extra:
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            origin = self._allowed()
            if origin:
                # Private Network Access preflight of older Chromium; newer ones ask the person instead.
                self._send(204, {}, origin, [("Access-Control-Allow-Methods", "GET"),
                                             ("Access-Control-Allow-Private-Network", "true"),
                                             ("Access-Control-Max-Age", "600")])

        def do_GET(self):
            origin = self._allowed()
            if not origin:
                return
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            if parts.path == "/v1/status":
                self._send(200, log.status(), origin)
                return
            if parts.path != "/v1/reads":
                self._send(404, {"ok": False, "code": "not_found", "error": "ありません。"}, origin)
                return
            client = (query.get("client") or [""])[0]
            purpose = (query.get("purpose") or ["rental"])[0]
            try:
                after = int(query["after"][0]) if "after" in query else None
                wait = float((query.get("wait") or ["0"])[0])
                revision = int(query["revision"][0]) if "revision" in query else None
                event_after = int(query["event_after"][0]) if "event_after" in query else None
                if any(value is not None and value < 0 for value in (revision, event_after)):
                    raise ValueError()
                if (after is not None and after < 0) or not math.isfinite(wait):
                    raise ValueError()
            except ValueError:
                client = ""
            if not CLIENT.fullmatch(client) or purpose not in ("login", "rental"):
                self._send(400, {"ok": False, "code": "validation", "error": "接続の情報が正しくありません。"}, origin)
                return
            body = log.wait(client, after, wait, claim=(query.get("claim") or [""])[0] == "1", origin=origin, revision=revision, event_after=event_after, purpose=purpose)
            self._send(200 if body["ok"] else 409, body, origin)

    return Handler


class CardReader:
    """Reads cards on the one RC-S370 until stopped; reopens the reader after it is unplugged or busy."""

    def __init__(self, on_card, on_rejected, on_state, stop_event, check_url, nfc_frontend=None, count_readers=None):
        self.on_card, self.on_rejected, self.on_state = on_card, on_rejected, on_state
        self.stop_event = stop_event
        self.check_url = check_url
        self._frontend = nfc_frontend
        self._count = count_readers
        self._last = (None, 0.0)

    def _open(self):
        if self._frontend is None:
            import nfc
            from nfc.clf.transport import USB
            if trial.importlib.metadata.version("nfcpy") != "1.0.4":
                raise trial.TrialError("検証済みのnfcpy 1.0.4を使用してください。")
            self._frontend = lambda: nfc.ContactlessFrontend(trial.READER)
            self._count = lambda: len(USB.find(trial.READER) or [])
        return self._frontend, self._count

    def run(self):
        while not self.stop_event.is_set():
            try:
                frontend, count = self._open()
                found = count()
                if found != 1:
                    self.on_state("missing", "RC-S370が見つかりません。USBに1台だけ接続してください。" if not found
                                  else f"RC-S370が{found}台つながっています。1台だけにしてください。")
                    self.stop_event.wait(2.0)
                    continue
                with frontend() as clf:
                    self.on_state("ready", "カードを置いてください。")
                    self._loop(clf)
            except Exception as error:  # USB, driver, or the reader in use by card writing
                if self.stop_event.is_set():
                    break
                self.on_state("error", "読取機を開けません。カード書込みなど別のソフトで使っていないか、WinUSB の設定と USB の抜き差しを確認してください。"
                              + f"（{type(error).__name__}: {error}）")
                self.stop_event.wait(2.0)

    def _connect(self, clf, timeout):
        deadline = time.monotonic() + timeout

        def startup(targets):
            # FeliCa only; any system code, so that a blank or foreign card is told apart, not ignored.
            for target in targets:
                target.sensf_req = bytearray.fromhex("00FFFF0100")
            return targets

        tag = clf.connect(rdwr={"targets": ["212F"], "on-startup": startup, "on-connect": lambda tag: False,
                                "iterations": 1, "interval": 0.1, "beep-on-connect": False},
                          terminate=lambda: self.stop_event.is_set() or time.monotonic() >= deadline)
        return tag or None

    @staticmethod
    def _transport_timeout(error):
        # Windows libusb/RC-S956 reports a card leaving the field as WSAETIMEDOUT (10060).
        return isinstance(error, OSError) and 10060 in (getattr(error, "errno", None), getattr(error, "winerror", None))

    @staticmethod
    def _card_error(error):
        return type(error).__module__.startswith("nfc.")

    def _loop(self, clf):
        while not self.stop_event.is_set():
            tag = self._connect(clf, 0.5)
            if tag is None:
                continue
            try:
                idm, url = read_item_url(tag)
                code = self.check_url(url)
            except CardRejected as reason:
                self.on_rejected(str(reason))
            except Exception as error:
                if not (self._transport_timeout(error) or self._card_error(error)):
                    raise
                self.on_rejected("カードを読み取れませんでした。置き直してください。")
            else:
                previous, left_at = self._last
                if previous != (idm, code) or time.monotonic() - left_at >= SAME_CARD_DEBOUNCE:
                    self.on_card(url, code, idm)
                self._last = ((idm, code), time.monotonic())
            self._wait_removed(tag)
            if self._last[0] is not None:
                self._last = (self._last[0], time.monotonic())

    def _wait_removed(self, tag):
        absent = 0
        while not self.stop_event.is_set():
            try:
                present = tag.is_present
            except Exception as error:
                if not (self._transport_timeout(error) or self._card_error(error)):
                    raise
                present = False
            absent = 0 if present else absent + 1
            if absent >= 2:
                return
            self.stop_event.wait(0.15)


class ReaderBridge:
    """Card reading plus the browser service. emit(dict) is called from worker threads.

    Events: reader_state {state, text}, reader_card {code, number, url, idm_tail, seq},
    reader_rejected {text}, reader_undelivered {code, number}.
    """

    def __init__(self, emit, page_origins, card_origins, port=DEFAULT_PORT, reader_factory=None):
        if not callable(emit):
            raise TypeError("emit must be callable")
        self.emit = emit
        self.page_origins = frozenset(origin_of(o) for o in page_origins) - {""}
        self.card_origins = frozenset(origin_of(o) for o in card_origins) - {""}
        self.port = port
        self.log = None
        self._reader_factory = reader_factory or CardReader
        self._run = None
        self._lock = threading.Lock()

    @property
    def running(self):
        with self._lock:
            return self._run is not None

    def start(self):
        with self._lock:
            if self._run is not None:
                raise BridgeError("読取りはすでに動いています。")
            log, stop = ReadLog(), threading.Event()
            try:
                server = _Server(("127.0.0.1", self.port), _handler(log, self.page_origins))
            except OSError:
                raise BridgeError(f"このPCで別の読取り（発行ソフトのもう1つの画面など）がすでに動いています。そちらを使うか、閉じてから開始してください。（127.0.0.1:{self.port} を使用中）") from None
            self.port = server.server_address[1]

            # Callbacks of a stopped run are dropped, so a late one cannot overwrite the next run.
            def state(value, text):
                if not stop.is_set():
                    log.set_reader(value, text)
                    self._emit("reader_state", text, state=value)

            def rejected(text):
                if not stop.is_set():
                    log.reject(text)
                    self._emit("reader_rejected", text)

            def card(url, code, idm):
                if not stop.is_set():
                    self._card(log, url, code, idm)

            reader = self._reader_factory(card, rejected, state, stop, lambda url: item_code(url, self.card_origins))
            threads = [threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2},
                                        name="reader-bridge-http", daemon=True),
                       threading.Thread(target=reader.run, name="reader-bridge-card", daemon=True)]
            self.log, self._run = log, (server, stop, threads)
            for thread in threads:
                thread.start()

    def stop(self, timeout=3.0):
        with self._lock:
            run, self._run = self._run, None
        if run is None:
            return
        server, stop, threads = run
        stop.set()
        self.log.release()
        server.shutdown()
        server.server_close()
        for thread in threads:
            thread.join(timeout)

    def browser(self):
        return self.log.browser() if self.log else (False, "")

    def _card(self, log, url, code, idm):
        read = log.push(url, code, idm)
        number = short_number(code)
        # Main issuer UI logs reader events: redact the entire credential URL.
        self._emit("reader_card", "委員ログインカード" if code == "LOGIN-CARD" else label(code), code=code, number=number, url="" if code == "LOGIN-CARD" else url,
                   idm_tail=read["idm_tail"], seq=read["seq"])
        timer = threading.Timer(DELIVERY_CHECK, self._check_delivery, args=(log, read["seq"], code))
        timer.daemon = True
        timer.start()

    def _check_delivery(self, log, seq, code):
        if self.log is log and self.running and not log.delivered(seq):
            self._emit("reader_undelivered", f"{label(code)} をブラウザに渡せていません。物品画面を前に出し、「PCの読取機：カードを置いてください。」と出ているのを確かめてから、カードを置き直してください。",
                       code=code, number=short_number(code))

    def _emit(self, kind, text, **fields):
        try:
            self.emit({"kind": kind, "text": text, **fields})
        except Exception:
            pass


def beep(ok=True):
    """A short Windows sound for each card; silent elsewhere."""
    if sys.platform == "win32":
        try:
            import winsound
            winsound.MessageBeep(winsound.MB_OK if ok else winsound.MB_ICONHAND)
        except Exception:
            pass
