import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile

from content_policy import inspect_attachment
from redaction import redact_text, ORIGINAL_GUIDANCE
from operating_policy import content_gate, plan_for_committee
from oa_relay import Attachment, Registry
from delivery import Delivery
from test_delivery import FakeAPI
from test_oa_relay import StateFixture, FORUM, CATEGORY, event, key, registry, test_directory


class RedactionTests(unittest.TestCase):
    def test_ordinary_text_is_byte_for_byte_preserved(self):
        for text in ["そちらはいかがでしょうか。", "パスワードの設定方法を案内します。", "大学病院前で集合。", "田中です。こちらへ電話してください。", "https://example.test/page"]:
            result = redact_text(text)
            self.assertEqual(result.text, text)
            self.assertEqual(result.spans_redacted, 0)

    def test_actual_value_only_redacted_and_rest_kept(self):
        text = "会場9時です。password=fixture-value,机は2台です。"
        result = redact_text(text)
        self.assertNotIn("fixture-value", result.text)
        self.assertIn("会場9時です。password=", result.text)
        self.assertIn(",机は2台です。", result.text)

    def test_quoted_json_credentials_are_redacted(self):
        result = redact_text('{"password":"fixture-value","place":"会場"}')
        self.assertNotIn("fixture-value", result.text)
        self.assertIn('"place":"会場"', result.text)

    def test_unicode_and_zero_width_values_are_redacted(self):
        for text, secret in [("ｐａｓｓｗｏｒｄ＝ｆｉｘｔｕｒｅ", "ｆｉｘｔｕｒｅ"), ("pa\u200bssword=fi\u200bxture", "fi\u200bxture")]:
            result = redact_text(text)
            self.assertNotIn(secret, result.text)
            self.assertEqual(result.spans_redacted, 1)

    def test_pem_block_and_authorization_scheme_do_not_leave_key_fragments(self):
        text = "前文\n-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXktYnl0ZXM=\n-----END PRIVATE KEY-----\n机2台です"
        result = redact_text(text)
        self.assertNotIn("ZmFrZS1rZXktYnl0ZXM", result.text)
        self.assertIn("前文", result.text)
        self.assertIn("机2台", result.text)
        result = redact_text("Authorization: Bearer abc123\n会場へ行きます")
        self.assertNotIn("abc123", result.text)
        self.assertIn("会場へ行きます", result.text)

    def test_unknown_sender_does_not_publish_even_redacted_text(self):
        plan = plan_for_committee(event(2, text="password=fixture-value 会場9時"), Registry([]), Path("unused"))
        self.assertEqual(plan.disposition, "held")
        self.assertEqual(plan.parts, ())


class AttachmentTests(StateFixture, unittest.TestCase):
    def media_plan(self, data, filename, mime, *, text="添付を送ります。", n=2):
        message_id = str(50000+n)
        (self.root / message_id).write_bytes(data)
        (self.root / (message_id + ".meta.json")).write_text(json.dumps({"content_type": mime}), encoding="utf-8")
        return plan_for_committee(event(n, kind="file", file_name=filename, text=text), registry(), self.root)

    def test_secret_attachment_is_held_but_caption_delivers(self):
        plan = self.media_plan(b'password=fixture-value', "連絡.txt", "text/plain")
        self.assertEqual(plan.disposition, "planned")
        self.assertEqual(plan.attachment_issue, "credential_material")
        self.assertIsNone(plan.parts[0].attachment)
        self.assertIn("添付を送ります。", plan.parts[0].content)
        self.assertIn(ORIGINAL_GUIDANCE, plan.parts[0].content)
        self.assertNotIn("fixture-value", plan.parts[0].content)
        api = FakeAPI()
        self.state.register(plan)
        self.assertEqual(Delivery(api, self.state, FORUM, CATEGORY, self.root).dispatch(plan), "partial")
        self.assertEqual(self.state.value("delivered_cursor"), key(1))

    def test_normal_image_transfers_without_operations_words(self):
        data = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXkAAAAASUVORK5CYII=")
        plan = self.media_plan(data, "写真.png", "image/png", text="こちらです。")
        self.assertIsNone(plan.attachment_issue)
        self.assertIsNotNone(plan.parts[0].attachment)
        self.assertTrue(content_gate(plan)[0])

    def test_normal_pdf_transfers_with_finite_local_coverage(self):
        with patch.dict(sys.modules, {"pypdf": None}):
            plan = self.media_plan(b'%PDF-1.7\n1 0 obj (Meeting note) endobj\n%%EOF\n', "連絡.pdf", "application/pdf")
        self.assertIsNone(plan.attachment_issue)
        self.assertIsNotNone(plan.parts[0].attachment)

    def test_office_xml_secret_is_detected_without_external_model(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/document.xml", "<document><text>password=fixture-value</text></document>")
        plan = self.media_plan(data.getvalue(), "連絡.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertEqual(plan.attachment_issue, "credential_material")
        self.assertIsNone(plan.parts[0].attachment)

    def test_cp932_text_does_not_need_utf8_or_operations_context(self):
        plan = self.media_plan("そちらはいかがでしょうか。".encode("cp932"), "連絡.txt", "text/plain")
        self.assertIsNone(plan.attachment_issue)
        self.assertIsNotNone(plan.parts[0].attachment)

    def test_zip_executable_only_holds_attachment_and_keeps_caption(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr("program.exe", b'MZfixture')
        plan = self.media_plan(data.getvalue(), "連絡.zip", "application/zip")
        self.assertEqual(plan.attachment_issue, "unsafe_attachment_type")
        self.assertIn("添付を送ります。", plan.parts[0].content)

    def test_local_upload_race_sends_text_once_and_holds_file(self):
        plan = self.media_plan("普通の本文です".encode(), "連絡.txt", "text/plain")
        path = plan.parts[0].attachment.path
        class RaceAPI(FakeAPI):
            raced = False
            def create_forum_thread(self, forum_id, candidate, media_root):
                if not self.raced and candidate.parts[0].attachment:
                    self.raced = True
                    path.write_bytes(b'changed bytes after inspection')
                return super().create_forum_thread(forum_id, candidate, media_root)
        api = RaceAPI()
        self.state.register(plan)
        result = Delivery(api, self.state, FORUM, CATEGORY, self.root).dispatch(plan)
        self.assertEqual(result, "partial")
        self.assertEqual(len(api.posts), 1)
        self.assertEqual(api.messages[0]["attachments"], [])
        self.assertIn("添付を送ります。", api.messages[0]["content"])


if __name__ == "__main__":
    unittest.main()
