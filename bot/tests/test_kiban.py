# -*- coding: utf-8 -*-
"""基盤システムの写し(kiban.py)の試験。合成データのみ・discord 不要。

    py -3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import hashlib
import hmac
import http.server
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from iyakusai_bot import kiban as K  # noqa: E402
from iyakusai_bot import task_domain as D  # noqa: E402
from iyakusai_bot import task_store as S  # noqa: E402

G = 9001
ALICE, BOB, STRANGER = 100000000000000001, 100000000000000002, 100000000000000003
NAMES = {str(ALICE): "医薬 花子", str(BOB): "薬学 太郎"}
NOW = datetime(2026, 10, 17, 1, 0, tzinfo=timezone.utc)      # 10:00 JST
KEY = bytes(range(1, 33))
LONG_ID = re.compile(r"(?<!\d)\d{17,20}(?!\d)")


def tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="kiban-test-"))


def snapshot(rental=True, mailbox=True) -> dict:
    return {
        "version": 1,
        "generatedAt": "2026-10-17T00:59:30.000Z",
        "rental": None if not rental else {
            "summary": {"total": 3, "counts": {"ready": 1, "loaned": 1, "review": 1}, "planned": 0,
                        "loanedByGroup": [{"borrower": "軽音楽部", "loaned": 1, "since": "2026-10-17T00:10:00Z"}],
                        "review": [{"code": "IY-TENT-02", "name": "テント"}]},
            "items": [
                {"code": "IY-TENT-01", "name": "テント", "status": "loaned", "phase": "loaned",
                 "group": {"id": "g1", "name": "軽音楽部"}, "lent_at": "2026-10-17T00:10:00Z",
                 "lent_condition": "normal", "lent_note": "支柱は2本で貸出", "lent_photo_skip": True,
                 "returned_at": None, "return_condition": None, "return_note": ""},
                {"code": "IY-TENT-02", "name": "テント", "status": "review", "phase": "review",
                 "group": {"id": "g2", "name": "茶道部"}, "lent_at": "2026-10-16T23:00:00Z",
                 "lent_condition": "normal", "lent_note": "", "lent_photo_skip": False,
                 "returned_at": "2026-10-17T00:40:00Z", "return_condition": "damage",
                 "return_note": "天幕に穴。連絡先 090-1234-5678"},
                {"code": "IY-CHAIR-01", "name": "椅子", "status": "ready", "phase": "unassigned",
                 "group": None, "lent_at": None, "lent_condition": None, "lent_note": "",
                 "lent_photo_skip": False, "returned_at": None, "return_condition": None, "return_note": ""},
            ],
        },
        "mailbox": None if not mailbox else {
            "mailboxes": [{"id": "shogai", "name": "渉外課", "threads": 2, "unhandled": 1}],
            "messages": [
                {"id": "rc_0000000000000001", "threadId": "th_0000000000000001", "mailboxIds": ["shogai"],
                 "subject": "協賛のご案内について", "fromName": "株式会社サンプル 担当", "sentAt": "2026-10-16T05:00:00Z",
                 "receivedAt": "2026-10-16T05:01:00Z", "status": "in_progress", "assignee": "医薬 花子",
                 "labels": ["協賛"], "attachments": 1,
                 "notes": [{"author": "薬学 太郎", "at": "2026-10-16T06:00:00Z",
                            "body": "請求書は来週送付。先方 someone@example.co.jp"}],
                 "taskIds": ["task-1"]},
                {"id": "rc_0000000000000002", "threadId": "th_0000000000000002", "mailboxIds": ["shogai"],
                 "subject": "見積書の送付", "fromName": None, "sentAt": "2026-10-15T05:00:00Z",
                 "receivedAt": "2026-10-15T05:01:00Z", "status": "unhandled", "assignee": None,
                 "labels": [], "attachments": 0, "notes": [], "taskIds": []},
            ],
        },
    }


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir()
        self.key = self.dir / "k.key"
        self.key.write_text(KEY.hex(), encoding="ascii")
        os.chmod(self.key, 0o600)        # umask に左右されない(Pi の既定 022 だと 644 になり load_key が拒否する)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def ok(self, **kw):
        raw = {"enabled": True, "app_url": "https://app.example.invalid", "key_file": str(self.key), **kw}
        return K.KibanSettings.from_mapping(raw)

    def test_defaults_and_valid(self):
        self.assertFalse(K.KibanSettings.from_mapping(None).enabled)
        self.assertFalse(K.KibanSettings.from_mapping({"enabled": False, "whatever": 1}).enabled)
        s = self.ok(sources=["mailbox", "rental"])
        self.assertEqual(s.sources, ("rental", "mailbox"))
        self.assertEqual(s.app_url, "https://app.example.invalid")
        only_tasks = K.KibanSettings.from_mapping({"enabled": True})
        self.assertTrue(only_tasks.tasks)
        self.assertEqual(only_tasks.sources, ())

    def test_rejects_unsafe_or_wrong(self):
        bad = [
            {"unknown": 1},
            {"app_url": "http://app.example.invalid"},            # 平文はループバックだけ
            {"app_url": "https://app.example.invalid/path"},
            {"key_file": ""},
            {"key_file": "relative/key"},
            {"sources": ["rental", "rental"]},
            {"sources": ["tasks"]},
            {"sources": []},
            {"interval_sec": 59},
            {"timeout_sec": 0},
            {"enabled": "yes"},
        ]
        for kw in bad:
            with self.subTest(kw=kw), self.assertRaises(K.KibanConfigError):
                self.ok(**kw)
        with self.assertRaises(K.KibanConfigError):
            K.KibanSettings.from_mapping({"enabled": True, "tasks": False})
        with self.assertRaises(K.KibanConfigError):
            K.KibanSettings.from_mapping({"enabled": True, "app_url": "https://a.example.invalid",
                                          "key_file": str(self.key)}, shared_roots=(self.dir,))
        self.assertEqual(self.ok(app_url="http://127.0.0.1:8080").app_url, "http://127.0.0.1:8080")

    def test_key_material(self):
        self.assertEqual(K.parse_key_material(KEY.hex()), KEY)
        self.assertEqual(K.parse_key_material(K.base64.urlsafe_b64encode(KEY).decode()), KEY)
        self.assertIsNone(K.parse_key_material("00" * 31))
        self.assertIsNone(K.parse_key_material("11" * 40))
        self.assertIsNone(K.parse_key_material("not a key!"))
        self.assertEqual(K.load_key(self.key), KEY)
        if os.name != "nt":
            os.chmod(self.key, 0o644)
            with self.assertRaises(K.KibanConfigError):
                K.load_key(self.key)


class SigningTests(unittest.TestCase):
    def test_canonical_string_matches_contract(self):
        body = b'{"sources":["rental","mailbox"]}'
        h = K.signed_headers(KEY, body, now_ms=1760000000000, nonce="n" * 24)
        canonical = "\n".join(["svc-auth/v1", "iyakusai-bot-datasource", "POST", "/v1/bot/datasource",
                               "1760000000000", "n" * 24, "", hashlib.sha256(body).hexdigest()])
        self.assertEqual(h["X-Svc-Signature"], hmac.new(KEY, canonical.encode(), hashlib.sha256).hexdigest())
        self.assertEqual(h["X-Svc-Client"], "iyakusai-bot-datasource")
        self.assertNotIn("X-Svc-Actor", h)
        self.assertRegex(K.signed_headers(KEY, body)["X-Svc-Nonce"], r"^[-_A-Za-z0-9]{24,128}$")


class TaskRenderTests(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir()
        self.store = S.TaskStore.open(self.dir, clock=lambda: NOW)
        seq = iter(range(1, 100))

        def create(title, tags, **kw):
            return self.store.create(D.Actor(ALICE, f"op-{next(seq):08d}", "discord"), D.Scope(G, 1),
                                     title=title, tags=tags, **kw)

        create("協賛の請求書を送る", ["shogai"], assignee_id=ALICE, deadline="2026-10-10",
               description="10社分。\n住所は名簿を参照")
        create("テントの配置図", ["kaijo", "system"], assignee_id=STRANGER, deadline="2026-10-17")
        create("パンフ入稿", ["koho"])
        done = create("会場予約", ["naimu"], assignee_id=BOB)
        self.store.update(D.Actor(BOB, "op-done-0001", "discord"), D.Scope(G, 1), done.view.task.number,
                          done.view.task.version, {"status": "done"}, confirmed=True)

    def tearDown(self):
        self.store = None
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_render(self):
        views = self.store.list_tasks(D.Scope(G))
        text = K.render_tasks(views, NAMES, NOW, 5)
        # 載るべきもの
        for must in ("#1 協賛の請求書を送る", "担当: 医薬 花子", "部局: 渉外課", "2026-10-10(生成時点で期限超過)",
                     "2026-10-17(今日が期限)", "部局: システム課・会場課", "期限: なし", "## 完了",
                     "会場予約", "(薬学 太郎)", "未完了 3 件", "住所は名簿を参照", "生成: 2026-10-17 10:00 JST"):
            self.assertIn(must, text)
        # 名前を引けない人は ID を出さずに「未登録」
        self.assertIn(f"担当: {K.UNKNOWN_PERSON}", text)
        self.assertIsNone(LONG_ID.search(text))
        # 部の件数にはその部の課も入る(内務部 = 会場課のテント 1 件。会場予約は完了なので数えない)
        self.assertIn("| 内務部 | 1 | 0 |", text)
        self.assertIn("| 外務部 | 2 | 1 |", text)
        self.assertIn("| 総務部 | 1 | 0 |", text)


class AppRenderTests(unittest.TestCase):
    def test_rental(self):
        text = K._scrub(K.render_rental(snapshot()["rental"], "2026-10-17T00:59:30.000Z", NOW, 5))
        for must in ("IY-TENT-01: 貸出中 → 軽音楽部", "写真省略", "メモ: 支柱は2本で貸出", "要確認(返却時に問題あり)",
                     "損傷あり", "天幕に穴", "| 軽音楽部 | 1 | 2026-10-17 09:10 |", "IY-CHAIR-01: 未割当",
                     "| テント | 2 |", "全 3 個体"):
            self.assertIn(must, text)
        self.assertNotIn("090-1234-5678", text)
        # 実際の個体コードの形(6桁)は無害化で崩れない
        self.assertEqual(K._scrub("IY-100123 IY-000124 IY-TEST-000001"), "IY-100123 IY-000124 IY-TEST-000001")

    def test_mailbox(self):
        text = K._scrub(K.render_mailbox(snapshot()["mailbox"], "2026-10-17T00:59:30.000Z", NOW, 5,
                                         {1: "協賛の請求書を送る(進行中)"}))
        for must in ("「協賛のご案内について」", "状態: 対応中", "担当: 医薬 花子", "ラベル: 協賛", "添付 1 件",
                     "紐づくタスク: #1 協賛の請求書を送る(進行中)", "薬学 太郎: 請求書は来週送付",
                     "| 渉外課 | 2 | 1 |", "「見積書の送付」", "(名前なし)", "mail/raw/"):
            self.assertIn(must, text)
        self.assertNotIn("someone@example.co.jp", text)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir()
        self.settings = K.KibanSettings(enabled=True, tasks=True, app_url="https://app.example.invalid",
                                        key_file=Path("/unused"), sources=K.APP_SOURCES)
        self.snap = snapshot()
        self.fail = None

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def fetch(self, settings, key):
        self.assertEqual(key, KEY)
        if self.fail:
            raise K.KibanFetchError(self.fail)
        return self.snap

    def sync(self, list_tasks=lambda: []):
        return K.KibanSync(self.settings, self.dir, list_tasks=list_tasks, names=lambda: NAMES,
                           key=KEY, fetch=self.fetch)

    def read(self, name):
        return (self.dir / "kiban" / name).read_text(encoding="utf-8")

    def test_success_failure_and_removal(self):
        s = self.sync()
        self.assertEqual(s.run_once(NOW), {"tasks": "成功", "rental": "成功", "mailbox": "成功"})
        for f in ("tasks.md", "rental.md", "mailbox.md", "_status.md"):
            self.assertTrue((self.dir / "kiban" / f).is_file(), f)
        before = self.read("rental.md")

        # 取得失敗: 前回の写しを残し、状態に理由を書く
        self.fail = "接続できない(URLError)"
        self.assertEqual(s.run_once(NOW)["rental"], "失敗")
        self.assertEqual(self.read("rental.md"), before)
        status = self.read("_status.md")
        self.assertIn("| 物品貸出 | `kiban/rental.md` | 失敗 |", status)
        self.assertIn("接続できない(URLError)。前回の写しのまま", status)

        # アプリ側で未設定になったソースは写しを消す
        self.fail = None
        self.snap = snapshot(mailbox=False)
        self.assertEqual(s.run_once(NOW)["mailbox"], "未設定")
        self.assertFalse((self.dir / "kiban" / "mailbox.md").exists())

        # タスク DB が読めない: 写しは残して失敗
        def broken():
            raise S.TaskStoreUnavailable("x")
        s.list_tasks = broken
        self.assertEqual(s.run_once(NOW)["tasks"], "失敗")
        self.assertTrue((self.dir / "kiban" / "tasks.md").exists())

        self.assertTrue(K.remove_kiban(self.dir))
        self.assertFalse((self.dir / "kiban").exists())

    def test_tasks_only(self):
        settings = K.KibanSettings(enabled=True, tasks=True)
        s = K.KibanSync(settings, self.dir, list_tasks=lambda: [], names=lambda: {}, key=None, fetch=self.fetch)
        self.assertEqual(s.run_once(NOW), {"tasks": "成功", "rental": "未設定", "mailbox": "未設定"})


class _Handler(http.server.BaseHTTPRequestHandler):
    """アプリ役。署名をこちらで独立に検算する(kiban の関数は使わない)。"""
    seen: list = []
    redirect = False

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.redirect:
            self.send_response(308)
            self.send_header("Location", "http://127.0.0.1:1/elsewhere")
            self.end_headers()
            return
        h = {k.lower(): v for k, v in self.headers.items()}
        canonical = "\n".join(["svc-auth/v1", h.get("x-svc-client", ""), "POST", self.path, h.get("x-svc-timestamp", ""),
                               h.get("x-svc-nonce", ""), "", hashlib.sha256(body).hexdigest()])
        good = hmac.compare_digest(hmac.new(KEY, canonical.encode(), hashlib.sha256).hexdigest(),
                                   h.get("x-svc-signature", ""))
        self.seen.append((self.path, json.loads(body), good, h.get("content-type"), "origin" in h))
        if not good:
            self.send_response(401)
            self.end_headers()
            return
        out = json.dumps(snapshot()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


class FetchTests(unittest.TestCase):
    def setUp(self):
        _Handler.seen, _Handler.redirect = [], False
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        port = self.server.server_address[1]
        self.settings = K.KibanSettings(enabled=True, app_url=f"http://127.0.0.1:{port}",
                                        key_file=Path("/unused"), sources=("rental", "mailbox"), timeout_sec=5)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_signed_fetch(self):
        data = K.fetch_app(self.settings, KEY)
        self.assertEqual(data["version"], 1)
        path, body, good, ctype, origin = _Handler.seen[0]
        self.assertEqual((path, body, good, ctype, origin),
                         ("/v1/bot/datasource", {"sources": ["rental", "mailbox"]}, True, "application/json", False))

    def test_wrong_key_and_redirect(self):
        with self.assertRaisesRegex(K.KibanFetchError, "署名が拒否"):
            K.fetch_app(self.settings, bytes(range(2, 34)))
        _Handler.redirect = True
        with self.assertRaises(K.KibanFetchError):
            K.fetch_app(self.settings, KEY)

    def test_contract_shape(self):
        for bad in ({}, {"version": 2, "generatedAt": "x"}, {"version": 1, "generatedAt": "x", "rental": []},
                    {"version": 1, "generatedAt": "x", "mailbox": {"mailboxes": []}}):
            with self.subTest(bad=bad), self.assertRaises(K.KibanFetchError):
                K.check_snapshot(bad)


if __name__ == "__main__":
    unittest.main()
