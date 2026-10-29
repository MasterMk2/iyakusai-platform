import unittest
import hashlib
from pathlib import Path

from oa_relay import GUILD, Registry, Attachment, plan_event
from content_policy import screen_text, inspect_attachment
from test_oa_relay import test_directory
from operating_policy import (ADMIN, ATTACH, BOT, COMMITTEE_ROLES, IN_THREADS,
    READ, SEND, VIEW, content_gate, forum_proposal, visibility_report, plan_for_committee)
from test_oa_relay import event, registry


def roles():
    result = [{"id": GUILD, "permissions": str(VIEW | READ | SEND | IN_THREADS)},
              {"id": "admin", "permissions": str(ADMIN)}]
    result += [{"id": role, "permissions": "0"} for role in COMMITTEE_ROLES]
    return result


class PolicyTests(unittest.TestCase):
    def test_committee_visible_others_not(self):
        people = [{"id": "committee", "roles": [next(iter(COMMITTEE_ROLES))], "bot": False},
                  {"id": "outsider", "roles": [], "bot": False},
                  {"id": BOT, "roles": [], "bot": True},
                  {"id": "other-bot", "roles": [next(iter(COMMITTEE_ROLES))], "bot": True}]
        report = visibility_report(roles(), people, forum_proposal(roles(), people))
        self.assertTrue(report["ready"])
        self.assertTrue(report["everyone_denied"])
        self.assertEqual(report["committee_readers"], 1)

    def test_administrator_bot_cannot_be_hidden_by_channel_deny(self):
        people = [{"id": BOT, "roles": [], "bot": True},
                  {"id": "admin-bot", "roles": ["admin"], "bot": True}]
        proposal = forum_proposal(roles(), people)
        report = visibility_report(roles(), people, proposal)
        self.assertFalse(report["ready"])
        self.assertEqual(report["other_bots_visible"], ["admin-bot"])

    def test_admin_exception_must_be_explicit_and_exact(self):
        people = [{"id": BOT, "roles": [], "bot": True},
                  {"id": "admin-bot", "roles": ["admin"], "bot": True}]
        proposal = forum_proposal(roles(), people)
        self.assertFalse(visibility_report(roles(), people, proposal,
            approved_admin_bots=frozenset({"different-bot"}))["ready"])
        self.assertTrue(visibility_report(roles(), people, proposal,
            approved_admin_bots=frozenset({"admin-bot"}))["ready"])

    def test_roleless_admin_human_is_reported(self):
        people = [{"id": BOT, "roles": [], "bot": True},
                  {"id": "outside-admin", "roles": ["admin"], "bot": False}]
        report = visibility_report(roles(), people, forum_proposal(roles(), people))
        self.assertEqual(report["other_humans_visible"], ["outside-admin"])
        self.assertFalse(report["ready"])

    def test_simple_acknowledgment_allowed_only_for_verified_org(self):
        plan = plan_event(event(1, text="承知しました。\nありがとうございます！"), registry(), Path("unused"))
        self.assertTrue(content_gate(plan)[0])
        unknown = plan_event(event(1, text="承知しました。"), Registry([]), Path("unused"))
        self.assertFalse(content_gate(unknown)[0])

    def test_generic_unsanitized_credentials_cannot_bypass_guard(self):
        examples = ["password=fixture", "パスワードはabc123", "APIキー:fixture-value"]
        for text in examples:
            with self.subTest(text=text):
                self.assertFalse(content_gate(plan_event(event(1, text=text), registry(), Path("unused")))[0])

    def test_safe_phrase_with_extra_secret_not_partially_shared(self):
        plan = plan_event(event(1, text="ありがとうございます。\npassword=fixture-value"), registry(), Path("unused"))
        self.assertFalse(content_gate(plan)[0])

    def test_unavailable_attachment_keeps_message_with_original_guidance(self):
        for kwargs in [{"kind": "file"}, {"kind": "image"}]:
            with self.subTest(kwargs=kwargs):
                plan = plan_for_committee(event(1, **kwargs), registry(), Path("unused"))
                self.assertTrue(content_gate(plan)[0])
                self.assertEqual(plan.attachment_issue, "media_unavailable")
                self.assertIn("公式LINEの管理画面", plan.parts[0].content)
                self.assertIsNone(plan.parts[0].attachment)

    def test_secret_value_is_masked_without_dropping_other_text(self):
        plan = plan_for_committee(event(1, text="会場は9時です。 password=fixture-value\n机は2台です。"), registry(), Path("unused"))
        self.assertEqual(plan.disposition, "planned")
        body = "".join(p.content for p in plan.parts)
        self.assertNotIn("fixture-value", body)
        self.assertIn("会場は9時です。", body)
        self.assertIn("机は2台です。", body)
        self.assertTrue(content_gate(plan)[0])

    def test_approved_template_keeps_delivery_plan(self):
        plan = plan_for_committee(event(1, text="承知しました。"), registry(), Path("unused"))
        self.assertEqual(plan.disposition, "planned")
        self.assertTrue(plan.parts)

    def test_non_sensitive_operations_free_text_is_allowed(self):
        examples = ["準備できましたので9時に会場へ行きます。", "テントは2台、机は6台で申請します。",
                    "土曜日の説明会に参加します。提出は前日までに済ませます。", "搬入時間を10:30に変更できますか？"]
        for text in examples:
            with self.subTest(text=text):
                plan = plan_for_committee(event(1, text=text), registry(), Path("unused"))
                self.assertEqual(plan.disposition, "planned")
                self.assertEqual(len(plan.parts), 1)

    def test_normalization_detects_fullwidth_credentials_without_changing_original(self):
        decision = screen_text("パスワードはａｂｃ１２３です")
        self.assertFalse(decision.allowed)
        self.assertIn("credential_material", decision.codes)

    def test_hidden_obfuscated_text_is_held(self):
        self.assertFalse(screen_text("準備 pa\u200bssword=value").allowed)

    def test_same_original_line_audience_has_no_additional_content_selection(self):
        for text in ["私が治療中です", "診断結果:糖尿病", "当日は発熱で欠席です", "口座番号:1234567"]:
            self.assertTrue(screen_text(text).allowed)
            plan = plan_for_committee(event(1, text=text), registry(), Path("unused"))
            self.assertIn(text, plan.parts[0].content)

    def test_plaintext_attachment_fully_screened(self):
        with test_directory() as folder:
            path = Path(folder) / "file"
            data = "備品,数量\n机,4\n椅子,8".encode()
            path.write_bytes(data)
            item = Attachment(path, "備品.csv", len(data), hashlib.sha256(data).hexdigest(), "text/csv")
            self.assertTrue(inspect_attachment(item).allowed)
            data = "備品,数量\npassword=fixture-value".encode()
            path.write_bytes(data)
            item = Attachment(path, "備品.csv", len(data), hashlib.sha256(data).hexdigest(), "text/csv")
            self.assertFalse(inspect_attachment(item).allowed)

    def test_binary_mime_or_changed_file_never_passes_plaintext_gate(self):
        with test_directory() as folder:
            path = Path(folder) / "file"
            data = "備品\n4台".encode()
            path.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            for name, mime in [("備品.pdf", "application/pdf"), ("備品.txt", "application/pdf"), ("備品.exe", "application/octet-stream")]:
                item = Attachment(path, name, len(data), digest, mime)
                self.assertFalse(inspect_attachment(item).allowed)
            path.write_bytes(b'\x89PNG\0\r\n')
            item = Attachment(path, "備品.txt", len(path.read_bytes()), hashlib.sha256(path.read_bytes()).hexdigest(), "text/plain")
            self.assertFalse(inspect_attachment(item).allowed)
            item = Attachment(path, "備品.txt", len(data), digest, "text/plain")
            self.assertEqual(inspect_attachment(item).codes, ("attachment_changed",))

    def test_free_text_policy_does_not_claim_complete_secret_detection(self):
        # No regex can identify a novel secret labeled only as ordinary prose.
        # This documented limitation is why local manual monitoring is needed.
        self.assertTrue(screen_text("備品コードはamber-river-moonです").allowed)

    def test_no_operational_words_or_standard_phrase_required(self):
        examples = ["意味を確認できない連絡です", "そちらはいかがでしょうか。", "はい！", "添付を送ります。",
                    "承知しました。田中です", "電話は090-1234-5678です", "住所は架空市です", "x@example.test",
                    "https://example.test", "大学病院前で集合します", "パスワードの設定方法を案内します", "発熱時は参加を控えてください"]
        for text in examples:
            with self.subTest(text=text):
                self.assertTrue(screen_text(text).allowed)

    def test_ordinary_emoji_zwj_not_stopped(self):
        self.assertTrue(screen_text("家族の絵文字です 👨‍👩‍👧").allowed)


if __name__ == "__main__":
    unittest.main()
