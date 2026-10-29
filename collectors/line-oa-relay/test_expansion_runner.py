"""Synthetic evidence, authorization and per-organization enrollment checks."""
import dataclasses
from datetime import timedelta
import hashlib
import unittest

from oa_relay import ValidationError
from runner import LEGACY_ORGANIZATIONS, approved_scope, load_registry, process_cycle
from delivery import Delivery
from test_delivery import FakeAPI
from test_oa_relay import StateFixture, FORUM, CATEGORY, event, registry

LEGACY_ORG = sorted(LEGACY_ORGANIZATIONS)[0]


def candidate(item, org_id="org_test", org_name="架空団体"):
    return {"org_id": org_id, "org_name": org_name,
        "source_full_sha256": hashlib.sha256(item.source_id.encode()).hexdigest(),
        "evidence_method": "own_document_submission", "reviewed_by": "synthetic-human-review",
        "references": [{"key": item.receive_key, "digest": item.digest}]}


class ExpansionRegistryTests(unittest.TestCase):
    def test_reviewed_document_submission_resolves_without_self_declaration_regex(self):
        item = event(1, kind="file", text="", file_name="架空名簿.xlsx")
        result = load_registry([item], [candidate(item)], {}, approved_org_ids={"org_test"})
        self.assertEqual(result.resolve(item).org_name, "架空団体")

    def test_candidate_without_explicit_organization_approval_is_rejected(self):
        item = event(1)
        with self.assertRaisesRegex(ValidationError, "E_NOT_APPROVED"):
            load_registry([item], [candidate(item)], {})

    def test_internal_contact_cannot_be_added_by_review_attestation(self):
        item = event(1)
        with self.assertRaisesRegex(ValidationError, "internal_person"):
            load_registry([item], [candidate(item)], {item.source_id: {}}, approved_org_ids={"org_test"})

    def test_changed_reference_body_is_rejected(self):
        item = event(1)
        altered = event(1, text="変更された架空本文")
        with self.assertRaisesRegex(ValidationError, "E_DIGEST_MISMATCH"):
            load_registry([altered], [candidate(item)], {}, approved_org_ids={"org_test"})

    def test_legacy_and_new_spec_cannot_bind_same_source_twice(self):
        item = event(1, text="架空団体の担当です")
        old = {"org_id": LEGACY_ORG, "org_name": "架空団体", "evidence_key": item.receive_key,
            "source_fingerprint": hashlib.sha256(item.source_id.encode()).hexdigest()[:12]}
        with self.assertRaisesRegex(ValidationError, "ambiguous_source"):
            load_registry([item], [old, candidate(item)], {}, approved_org_ids={LEGACY_ORG, "org_test"})

    def test_legacy_evidence_still_uses_exact_self_declaration(self):
        item = event(1, text="架空団体の担当です")
        spec = {"org_id": LEGACY_ORG, "org_name": "架空団体", "evidence_key": item.receive_key,
            "source_fingerprint": hashlib.sha256(item.source_id.encode()).hexdigest()[:12]}
        self.assertEqual(load_registry([item], [spec], {}).resolve(item).org_id, LEGACY_ORG)
        with self.assertRaisesRegex(ValidationError, "evidence_scope"):
            load_registry([event(1, text="別団体の代理です")], [spec], {})

    def test_extra_scope_requires_aware_activation_time_and_revision(self):
        config = {"approved_organization_ids": sorted(LEGACY_ORGANIZATIONS | {"org_test"})}
        with self.assertRaisesRegex(ValidationError, "activation_scope"):
            approved_scope(config)
        config["organization_activation_times"] = {"org_test": "2026-10-11T00:00:00"}
        with self.assertRaisesRegex(ValidationError, "activation_time"):
            approved_scope(config)
        config["organization_activation_times"]["org_test"] += "+00:00"
        with self.assertRaisesRegex(ValidationError, "revision_missing"):
            approved_scope(config)
        config["mapping_approval_revision"] = "synthetic-consent"
        self.assertIn("org_test", approved_scope(config)[0])

    def test_original_config_retains_four_group_scope(self):
        self.assertEqual(approved_scope({}), (LEGACY_ORGANIZATIONS, {}))


class EnrollmentCutoffTests(StateFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.state._set("activated_at", (event(1).sent_at-timedelta(seconds=100)).isoformat())
        self.api = FakeAPI()
        self.delivery = Delivery(self.api, self.state, FORUM, CATEGORY, self.root)

    def test_post_global_baseline_but_pre_enrollment_event_is_not_forwarded(self):
        item = event(2, text="架空の申請")
        cutoff = item.sent_at+timedelta(seconds=1)
        result = process_cycle([item], registry(), {}, self.root, self.state, self.delivery,
            organization_activation_times={"org_test": cutoff})
        self.assertEqual(result, {"held": 1})
        self.assertEqual(self.api.posts, [])
        self.assertEqual(self.state.db.execute("SELECT reason FROM entries WHERE key=?", (item.receive_key,)).fetchone()[0],
            "pre_organization_activation_history")

    def test_enrollment_boundary_is_inclusive_and_new_event_delivers(self):
        item = event(2, text="架空の新着")
        result = process_cycle([item], registry(), {}, self.root, self.state, self.delivery,
            organization_activation_times={"org_test": item.sent_at})
        self.assertEqual(result, {"delivered": 1})

    def test_existing_group_has_no_new_cutoff(self):
        item = event(2, text="既存の架空新着")
        result = process_cycle([item], registry(), {}, self.root, self.state, self.delivery,
            organization_activation_times={"other_group": item.sent_at+timedelta(days=1)})
        self.assertEqual(result, {"delivered": 1})

    def test_cutoff_change_never_releases_pre_enrollment_hold(self):
        item = event(2, text="架空の古い申請")
        process_cycle([item], registry(), {}, self.root, self.state, self.delivery,
            organization_activation_times={"org_test": item.sent_at+timedelta(seconds=1)})
        result = process_cycle([item], registry(), {}, self.root, self.state, self.delivery,
            organization_activation_times={"org_test": item.sent_at-timedelta(seconds=1)})
        self.assertEqual(result, {"held": 1})
        self.assertEqual(self.api.posts, [])


if __name__ == "__main__":
    unittest.main()
