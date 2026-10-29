"""test_candidate_proofs.py — 架空団体・fake UID・SimpleNamespace のみの合成テスト。"""

import copy
import hashlib
import unittest
from types import SimpleNamespace

from candidate_proofs import (
    ALLOWED_METHODS,
    CandidateProofError,
    validate_candidates,
)


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


UID_A = "Ufake00000000000000000000000000a1"
UID_B = "Ufake00000000000000000000000000b2"
UID_C = "Ufake00000000000000000000000000c3"
NAME_CHOIR = "架空合唱団"
NAME_GARDEN = "架空園芸クラブ"


def event(key, uid, digest, source_type="user", event_type="message"):
    return SimpleNamespace(
        source_type=source_type,
        source_id=uid,
        event_type=event_type,
        receive_key=key,
        digest=digest,
    )


def ref(key, digest):
    return {"key": key, "digest": digest}


def spec(org_id, org_name, uid, refs, method="explicit_self_declaration",
         reviewed_by="reviewer_fake", full_sha=None):
    return {
        "org_id": org_id,
        "org_name": org_name,
        "source_full_sha256": sha(uid) if full_sha is None else full_sha,
        "evidence_method": method,
        "reviewed_by": reviewed_by,
        "references": refs,
    }


class CandidateProofTests(unittest.TestCase):
    def setUp(self):
        self.d1 = sha("synthetic-body-1")
        self.d2 = sha("synthetic-body-2")
        self.d3 = sha("synthetic-body-3")
        self.d4 = sha("synthetic-body-4")
        self.d5 = sha("synthetic-body-5")
        self.events = {
            "rk_001": event("rk_001", UID_A, self.d1),
            "rk_002": event("rk_002", UID_B, self.d2),
            "rk_003": event("rk_003", UID_A, self.d3),
            "rk_004": event("rk_004", UID_C, self.d4, source_type="group"),
            "rk_005": event("rk_005", UID_C, self.d5, event_type="postback"),
        }
        self.approved = frozenset({"fake_choir", "fake_garden_club"})

    def spec_a(self):
        return spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)])

    def spec_b(self):
        return spec("fake_garden_club", NAME_GARDEN, UID_B, [ref("rk_002", self.d2)])

    def assertCode(self, code, specs, events=None, approved=None):
        with self.assertRaises(CandidateProofError) as ctx:
            validate_candidates(
                specs,
                self.events if events is None else events,
                self.approved if approved is None else approved,
            )
        exc = ctx.exception
        self.assertIsInstance(exc, ValueError)
        self.assertEqual(exc.code, code)
        self.assertEqual(str(exc), code)
        return exc

    def test_two_valid_candidates(self):
        result = validate_candidates([self.spec_a(), self.spec_b()], self.events, self.approved)
        self.assertEqual(
            result,
            [
                {"source_type": "user", "source_id": UID_A, "org_id": "fake_choir",
                 "org_name": NAME_CHOIR, "evidence": "rk_001", "reviewed_by": "reviewer_fake"},
                {"source_type": "user", "source_id": UID_B, "org_id": "fake_garden_club",
                 "org_name": NAME_GARDEN, "evidence": "rk_002", "reviewed_by": "reviewer_fake"},
            ],
        )

    def test_unapproved_org_rejected(self):
        self.assertCode("E_NOT_APPROVED", [self.spec_a()], approved=frozenset({"fake_garden_club"}))

    def test_full_sha_mismatch_rejected(self):
        s = spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)], full_sha=sha(UID_B))
        self.assertCode("E_HASH_MISMATCH", [s])

    def test_full_sha_format_rejected(self):
        s = spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)], full_sha=sha(UID_A).upper())
        self.assertCode("E_FULL_SHA", [s])

    def test_reference_digest_mismatch_rejected(self):
        s = spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d2)])
        self.assertCode("E_DIGEST_MISMATCH", [s])

    def test_missing_reference_rejected(self):
        s = spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_999", self.d1)])
        self.assertCode("E_EVENT_MISSING", [s])

    def test_receive_key_mismatch_rejected(self):
        events = {"rk_001": event("rk_other", UID_A, self.d1)}
        self.assertCode("E_KEY_MISMATCH", [self.spec_a()], events=events)

    def test_non_user_or_non_message_rejected(self):
        for key, digest in (("rk_004", self.d4), ("rk_005", self.d5)):
            with self.subTest(key=key):
                s = spec("fake_choir", NAME_CHOIR, UID_C, [ref(key, digest)])
                self.assertCode("E_EVENT_TYPE", [s])

    def test_references_from_different_senders_rejected(self):
        s = spec("fake_choir", NAME_CHOIR, UID_A,
                 [ref("rk_001", self.d1), ref("rk_002", self.d2)])
        self.assertCode("E_SENDER_MISMATCH", [s])

    def test_same_sender_different_org_rejected(self):
        other = spec("fake_garden_club", NAME_GARDEN, UID_A, [ref("rk_003", self.d3)])
        self.assertCode("E_SOURCE_ORG_CONFLICT", [self.spec_a(), other])

    def test_same_org_id_different_name_rejected(self):
        other = spec("fake_choir", "別名合唱団", UID_B, [ref("rk_002", self.d2)])
        self.assertCode("E_ORG_NAME_CONFLICT", [self.spec_a(), other])

    def test_same_org_two_senders_allowed(self):
        other = spec("fake_choir", NAME_CHOIR, UID_B, [ref("rk_002", self.d2)])
        result = validate_candidates([self.spec_a(), other], self.events, self.approved)
        self.assertEqual([r["source_id"] for r in result], [UID_A, UID_B])

    def test_multiple_refs_same_sender_same_org_ok(self):
        s = spec("fake_choir", NAME_CHOIR, UID_A,
                 [ref("rk_001", self.d1), ref("rk_003", self.d3)],
                 method="own_document_submission")
        result = validate_candidates([s], self.events, self.approved)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["evidence"], "rk_001|rk_003")
        self.assertEqual(result[0]["org_id"], "fake_choir")

    def test_duplicate_candidate_rejected(self):
        again = spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_003", self.d3)])
        self.assertCode("E_DUPLICATE_CANDIDATE", [self.spec_a(), again])

    def test_no_partial_result_and_inputs_unchanged(self):
        specs = [self.spec_a(), self.spec_b(),
                 spec("fake_unapproved", "架空未承認会", UID_C, [ref("rk_004", self.d4)])]
        snapshot = copy.deepcopy(specs)
        result = None
        with self.assertRaises(CandidateProofError):
            result = validate_candidates(specs, self.events, self.approved)
        self.assertIsNone(result)
        self.assertEqual(specs, snapshot)

    def test_weak_profile_only_methods_rejected(self):
        for method in ("profile_only", "display_name_match", "profile_name_match", "", None):
            with self.subTest(method=method):
                s = spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)], method=method)
                self.assertCode("E_METHOD", [s])

    def test_all_allowed_methods_accepted(self):
        for method in sorted(ALLOWED_METHODS):
            with self.subTest(method=method):
                s = spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)], method=method)
                self.assertEqual(len(validate_candidates([s], self.events, self.approved)), 1)

    def test_field_format_rejections(self):
        cases = [
            ("E_ORG_ID", spec("Fake-Choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)])),
            ("E_ORG_NAME", spec("fake_choir", "   ", UID_A, [ref("rk_001", self.d1)])),
            ("E_REVIEWER", spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)], reviewed_by="")),
            ("E_REFERENCES", spec("fake_choir", NAME_CHOIR, UID_A, [])),
            ("E_REF_KEY", spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk|001", self.d1)])),
            ("E_REF_DIGEST", spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", "abc")])),
            ("E_REF_DUPLICATE", spec("fake_choir", NAME_CHOIR, UID_A,
                                     [ref("rk_001", self.d1), ref("rk_001", self.d1)])),
        ]
        for code, s in cases:
            with self.subTest(code=code):
                self.assertCode(code, [s])

    def test_errors_do_not_leak_sensitive_values(self):
        failing = [
            [spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_001", self.d1)], full_sha=sha(UID_B))],
            [self.spec_a(), spec("fake_garden_club", NAME_GARDEN, UID_A, [ref("rk_003", self.d3)])],
            [self.spec_a(), spec("fake_choir", "別名合唱団", UID_B, [ref("rk_002", self.d2)])],
            [spec("fake_choir", NAME_CHOIR, UID_A, [ref("rk_999", self.d1)])],
        ]
        secrets = (UID_A, UID_B, NAME_CHOIR, NAME_GARDEN, "別名合唱団", "rk_", "synthetic-body")
        for specs in failing:
            with self.assertRaises(CandidateProofError) as ctx:
                validate_candidates(specs, self.events, self.approved)
            exc = ctx.exception
            text = str(exc) + repr(exc) + repr(exc.args)
            for secret in secrets:
                self.assertNotIn(secret, text)
            self.assertIsNone(exc.__cause__)


if __name__ == "__main__":
    unittest.main()
