"""Offline workflow tests: no network service, no physical NFC reader."""
import copy
import hashlib
import http.cookiejar
import json
import tempfile
import unittest
import urllib.request
from pathlib import Path

from workflow import ApiClient, WorkflowError, _OriginRedirect, expand_rows, generate_bundle, generate_loan_sheet, load_bundle, parse_plan_tsv

ORIGIN = "https://rental.example.test"


class Response:
    def __init__(self, value):
        self.payload = json.dumps(value, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        return self.payload[:limit]


class FakeOpener:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return Response(reply)


def http_error(url, status, body):
    import io
    import urllib.error
    return urllib.error.HTTPError(url, status, "error", {}, io.BytesIO(json.dumps(body, ensure_ascii=False).encode("utf-8")))


class PlanTests(unittest.TestCase):
    def test_excel_japanese_heading_and_order(self):
        rows = parse_plan_tsv("数量\t物品名\t貸出先団体\r\n３\t延長コード\t総務部\r\n2\t机\t模擬店A\r\n")
        self.assertEqual(rows, [{"borrower_name": "総務部", "name": "延長コード", "quantity": 3}, {"borrower_name": "模擬店A", "name": "机", "quantity": 2}])

    def test_without_heading_and_blank_rows(self):
        self.assertEqual(parse_plan_tsv("\ufeff総務部\t延長コード\t2\n\t\t\n"), [{"borrower_name": "総務部", "name": "延長コード", "quantity": 2}])

    def test_missing_and_extra_columns_stop(self):
        for text in ("団体\t物品", "団体\t物品\t2\t余分", "貸出先\t物品名\t数量\n"):
            with self.subTest(text=text), self.assertRaises(WorkflowError):
                parse_plan_tsv(text)

    def test_invalid_quantities_and_control_characters(self):
        for quantity in (True, 0, -1, 10001, "3.0", "1e2", "999999999999999999"):
            with self.subTest(quantity=quantity), self.assertRaises(WorkflowError):
                expand_rows([{"borrower_name": "A", "name": "机", "quantity": quantity}], ORIGIN)
        with self.assertRaises(WorkflowError):
            parse_plan_tsv('"団体\n変更"\t机\t2')

    def test_total_bound_and_number_bound(self):
        self.assertEqual(len(expand_rows([{"borrower_name": "A", "name": "机", "quantity": 10000}], ORIGIN)), 10000)
        with self.assertRaises(WorkflowError):
            expand_rows([{"borrower_name": "A", "name": "机", "quantity": 10000}, {"borrower_name": "B", "name": "机", "quantity": 1}], ORIGIN)
        with self.assertRaises(WorkflowError):
            expand_rows([{"borrower_name": "A", "name": "机", "quantity": 2}], ORIGIN, 999999)

    def test_individual_codes_exact_urls_and_input_unchanged(self):
        rows = [{"borrower_name": "総務部", "name": "延長コード", "quantity": 2}, {"borrower_name": "模擬店A", "name": "机", "quantity": 1}]
        original = copy.deepcopy(rows)
        items = expand_rows(rows, ORIGIN + "/", 42)
        self.assertEqual([item["code"] for item in items], ["IY-000042", "IY-000043", "IY-000044"])
        self.assertEqual(items[1]["url"], ORIGIN + "/i/IY-000043")
        self.assertEqual(items[-1]["borrower_name"], "模擬店A")
        self.assertEqual(rows, original)
        items[0]["name"] = "変更"
        self.assertEqual(items[1]["name"], "延長コード")

    def test_bad_origins_and_overlong_card_url(self):
        rows = [{"borrower_name": "A", "name": "机", "quantity": 1}]
        for origin in ("http://outside.test", "https://user:password@unit.test", "https://unit.test/path", "https://unit.test/?q=1", "https://unit.test/#fragment", "https://unit.test:99999"):
            with self.subTest(origin=origin), self.assertRaises(WorkflowError):
                expand_rows(rows, origin)
        with self.assertRaises(WorkflowError):
            expand_rows(rows, "https://" + "x" * 170 + ".test")


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rental-workflow-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.items = expand_rows([{"borrower_name": "総務部", "name": "延長コード", "quantity": 2}], ORIGIN)
        for item in self.items:
            item["borrower_id"] = "B-1234abcd"

    def test_pdf_sidecar_hash_and_association_roundtrip(self):
        from pypdf import PdfReader
        pdf = self.root / "labels.pdf"
        manifest = generate_bundle(self.items, pdf)
        data = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(data["pdf_sha256"], hashlib.sha256(pdf.read_bytes()).hexdigest())
        self.assertEqual(data["label_mm"], [91, 55])
        self.assertEqual(load_bundle(manifest), self.items)
        text = PdfReader(pdf).pages[0].extract_text()
        self.assertIn("予定団体：総務部", text)
        self.assertIn("IY-000001", text)
        self.assertIn("延長コード", text)

    def test_label_shows_the_short_number_and_the_loan_sheet_lists_it_per_group(self):
        from pypdf import PdfReader
        from labels.generate_labels import short_number
        self.assertEqual("123", short_number("IY-100123"))
        self.assertEqual("1234", short_number("IY-101234"))
        self.assertIsNone(short_number("IY-000123"))
        self.assertIsNone(short_number("IY-100000"))
        self.assertIsNone(short_number("IY-TEST-000001"))
        items = expand_rows([{"borrower_name": "総務部", "name": "延長コード", "quantity": 2},
                             {"borrower_name": "企画部", "name": "長机", "quantity": 1}], ORIGIN, 100122)
        manifest = generate_bundle(items, self.root / "labels.pdf")
        label = PdfReader(self.root / "labels.pdf").pages[0].extract_text()
        self.assertIn("No.122", label)
        self.assertIn("IY-100122", label)
        sheet = generate_loan_sheet(manifest)
        self.assertEqual("labels_手書き貸出表.pdf", sheet.name)
        pages = [page.extract_text() for page in PdfReader(sheet).pages]
        self.assertEqual(2, len(pages), "one page per planned group")
        self.assertIn("予定団体：総務部", pages[0])
        self.assertIn("122", pages[0])
        self.assertIn("延長コード", pages[0])
        for text in ("返却時の状態", "異常なし", "整備", "破損", "傷・不足など"):
            self.assertIn(text, pages[0])
        self.assertIn("124", pages[1])
        self.assertNotIn("IY-100124", pages[1])
        first = sheet.read_bytes()
        self.assertEqual(sheet, generate_loan_sheet(manifest), "an existing sheet is reused, not replaced")
        self.assertEqual(first, sheet.read_bytes())

    def test_existing_pdf_and_manifest_are_not_overwritten(self):
        pdf = self.root / "labels.pdf"
        pdf.write_bytes(b"original PDF")
        with self.assertRaises(WorkflowError):
            generate_bundle(self.items, pdf)
        self.assertEqual(pdf.read_bytes(), b"original PDF")
        another = self.root / "another.pdf"
        sidecar = another.with_suffix(".issuance.json")
        sidecar.write_text("original manifest", encoding="utf-8")
        with self.assertRaises(WorkflowError):
            generate_bundle(self.items, another)
        self.assertFalse(another.exists())
        self.assertEqual(sidecar.read_text(encoding="utf-8"), "original manifest")

    def test_changed_pdf_and_wrong_manifest_fail(self):
        pdf = self.root / "labels.pdf"
        manifest = generate_bundle(self.items, pdf)
        with pdf.open("ab") as file:
            file.write(b"tampered")
        with self.assertRaisesRegex(WorkflowError, "一致"):
            load_bundle(manifest)
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["page"] = "Letter"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(WorkflowError):
            load_bundle(manifest)

    def test_duplicate_code_and_mismatched_url_fail_before_output(self):
        for items in ([self.items[0], self.items[0]], [{**self.items[0], "url": ORIGIN + "/i/IY-000999"}]):
            with self.subTest(items=items), self.assertRaises(ValueError):
                generate_bundle(items, self.root / "invalid.pdf")
            self.assertFalse((self.root / "invalid.pdf").exists())


class ApiTests(unittest.TestCase):
    def test_large_batch_response_survives_eight_mib_boundary(self):
        payload = {"batch": "x" * (9 * 1024 * 1024)}
        client = ApiClient(ORIGIN, opener=FakeOpener([payload]))
        self.assertEqual(len(client._request("/api/preassignments")["batch"]), 9 * 1024 * 1024)

    def test_login_is_post_origin_and_no_secret_in_client_state(self):
        opener = FakeOpener([{"staff": {"id": "staff-a", "name": "A"}, "mode": "mounted_drive"}])
        client = ApiClient(ORIGIN, opener=opener)
        result = client.login("test-private-code")
        request = opener.requests[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Origin"), ORIGIN)
        self.assertEqual(json.loads(request.data), {"staff_code": "test-private-code"})
        self.assertEqual(result["staff"]["id"], "staff-a")
        self.assertNotIn("test-private-code", repr(client.__dict__))

    def test_borrowers_returns_groups_not_names(self):
        client = ApiClient(ORIGIN, opener=FakeOpener([{"borrowers": ["A"], "groups": [{"id": "B-a", "name": "A"}]}]))
        self.assertEqual(client.borrowers(), [{"id": "B-a", "name": "A"}])

    def test_register_creates_each_group_once_then_one_atomic_request(self):
        items = expand_rows([{"borrower_name": "A", "name": "机", "quantity": 2}, {"borrower_name": "B", "name": "椅子", "quantity": 1}], ORIGIN)
        expected = [{**item, "borrower_id": "B-a" if item["borrower_name"] == "A" else "B-b"} for item in items]
        opener = FakeOpener([{"borrower": {"id": "B-a", "name": "A"}, "created": True}, {"borrower": {"id": "B-b", "name": "B"}, "created": False}, {"items": [{**item, "planned_state": "pending", "version": 0, "created": True} for item in expected], "registered_count": 3, "updated_count": 3, "reused_count": 0}])
        result = ApiClient(ORIGIN, opener=opener).register(items)
        self.assertEqual([request.full_url.removeprefix(ORIGIN) for request in opener.requests], ["/api/borrowers", "/api/borrowers", "/api/preassignments"])
        self.assertEqual(json.loads(opener.requests[-1].data), {"items": expected})
        self.assertEqual(result["items"], expected)
        self.assertTrue(all(request.get_header("Origin") == ORIGIN for request in opener.requests))
        self.assertFalse(any("borrower_id" in item for item in items))

    def test_registration_different_origin_fails_before_any_request(self):
        opener = FakeOpener([])
        items = expand_rows([{"borrower_name": "A", "name": "机", "quantity": 1}], "https://other.test")
        with self.assertRaises(WorkflowError):
            ApiClient(ORIGIN, opener=opener).register(items)
        self.assertEqual(opener.requests, [])

    def test_existing_assignment_id_is_not_silently_changed(self):
        items = expand_rows([{"borrower_name": "A", "name": "机", "quantity": 1}], ORIGIN)
        items[0]["borrower_id"] = "B-old"
        opener = FakeOpener([{"borrower": {"id": "B-new", "name": "A"}, "created": True}])
        with self.assertRaisesRegex(WorkflowError, "IDと名前"):
            ApiClient(ORIGIN, opener=opener).register(items)
        self.assertEqual(len(opener.requests), 1)

    def test_redirect_refuses_different_origin(self):
        handler = _OriginRedirect(ORIGIN)
        request = urllib.request.Request(ORIGIN + "/api/login", data=b"private", method="POST")
        with self.assertRaises(WorkflowError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://outside.test/")

    def test_secure_cookie_is_not_sent_over_http(self):
        cookie = http.cookiejar.Cookie(0, "rental_session", "test-session", None, False, "rental.example.test", False, False, "/", True, True, None, True, None, None, {"HttpOnly": None}, False)
        jar = http.cookiejar.CookieJar()
        jar.set_cookie(cookie)
        http_request = urllib.request.Request("http://rental.example.test/api/me")
        jar.add_cookie_header(http_request)
        self.assertIsNone(http_request.get_header("Cookie"))
        https_request = urllib.request.Request(ORIGIN + "/api/me")
        jar.add_cookie_header(https_request)
        self.assertEqual(https_request.get_header("Cookie"), "rental_session=test-session")


if __name__ == "__main__":
    unittest.main()


APP = "https://app.example.test"
ITEMS = "https://rental.example.test"


class AccountLoginTests(unittest.TestCase):
    """The unified app: student ID and password, rental API under /api/rental, item URLs on the item origin."""

    def account_client(self, extra_replies=()):
        me = {"staff": {"id": "iy-00000001", "name": "合成 太郎"}, "permissions": ["rental.issue", "rental.loan"], "mode": "local", "item_origin": ITEMS}
        opener = FakeOpener([{"ok": True}, me, *extra_replies])
        client = ApiClient(APP, opener=opener)
        client.login_account("21123456", "合成パスワード-0001")
        return client, opener

    def test_detects_the_unified_app_and_the_earlier_server(self):
        self.assertEqual("account", ApiClient(APP, opener=FakeOpener([{"authMode": "discord", "user": None}])).detect())
        earlier = FakeOpener([http_error(ITEMS + "/api/session", 404, {"error": "API が見つかりません。", "code": "not_found"})])
        self.assertEqual("staff", ApiClient(ITEMS, opener=earlier).detect())

    def test_login_posts_student_id_with_csrf_header_and_keeps_no_password(self):
        client, opener = self.account_client()
        login, me = opener.requests
        self.assertEqual(APP + "/api/auth/login", login.full_url)
        self.assertEqual({"loginId": "21123456", "password": "合成パスワード-0001"}, json.loads(login.data))
        self.assertEqual(APP, login.get_header("Origin"))
        self.assertEqual("1", login.get_header("X-smm-csrf"))
        self.assertEqual(APP + "/api/rental/me", me.full_url)
        self.assertEqual(("account", "/api/rental", ITEMS, "合成 太郎"), (client.mode, client.prefix, client.item_origin, client.user_name))
        self.assertNotIn("合成パスワード-0001", json.dumps({k: str(v) for k, v in vars(client).items()}, ensure_ascii=False))

    def test_issuing_needs_the_rental_issue_permission(self):
        me = {"staff": {"id": "iy-00000002", "name": "B"}, "permissions": ["rental.loan"], "item_origin": ITEMS}
        with self.assertRaises(WorkflowError) as caught:
            ApiClient(APP, opener=FakeOpener([{"ok": True}, me])).login_account("21123456", "合成パスワード-0001")
        self.assertIn("rental.issue", str(caught.exception))

    def test_unified_app_error_messages_are_shown(self):
        failure = http_error(APP + "/api/auth/login", 401, {"error": "unauthenticated", "message": "ログインID（学籍番号）・パスワードが正しくありません。"})
        with self.assertRaises(WorkflowError) as caught:
            ApiClient(APP, opener=FakeOpener([failure])).login_account("21123456", "wrong")
        self.assertIn("学籍番号", str(caught.exception))

    def test_register_uses_rental_paths_and_the_item_origin(self):
        items = expand_rows([{"borrower_name": "A", "name": "机", "quantity": 1}], ITEMS, 1)
        expected = [{**items[0], "borrower_id": "B-a"}]
        client, opener = self.account_client([
            {"borrower": {"id": "B-a", "name": "A"}, "created": True},
            {"items": [{**item, "planned_state": "pending", "version": 1, "created": True} for item in expected], "registered_count": 1, "updated_count": 1, "reused_count": 0},
        ])
        client.register(items)
        self.assertEqual(["/api/rental/borrowers", "/api/rental/preassignments"], [r.full_url.removeprefix(APP) for r in opener.requests[2:]])
        with self.assertRaises(WorkflowError):
            client.register(expand_rows([{"borrower_name": "A", "name": "机", "quantity": 1}], APP, 2))
