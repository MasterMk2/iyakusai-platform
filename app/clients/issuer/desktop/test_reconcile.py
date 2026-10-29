import unittest
import tempfile
from pathlib import Path
from reconcile import reconcile_rows
from workflow import expand_rows, generate_bundle, load_bundle, bundle_reserved_through


class ReconcileTests(unittest.TestCase):
    def test_reordering_and_insertion_do_not_shift_issued_codes_or_urls(self):
        old = expand_rows([{"borrower_name": "A", "name": "机", "quantity": 2}], "https://rental.iyakusai.com", 100001)
        result = reconcile_rows([{"borrower_name": "B", "name": "椅子", "quantity": 1}, {"borrower_name": "A", "name": "机", "quantity": 2, "item_scope": "学内"}], old, "https://app.iyakusai.com")
        self.assertEqual(result["added_codes"], ["IY-100003"])
        self.assertEqual(result["items"][1]["url"], old[0]["url"])
        self.assertEqual(result["kept_codes"], ["IY-100001", "IY-100002"])
        self.assertEqual(result["items"][1]["item_scope"], "学内")

    def test_reduced_and_renamed_allocations_are_reported_without_recycling(self):
        old = expand_rows([{"borrower_name": "A", "name": "机", "quantity": 3}], "https://app.iyakusai.com", 100001)
        result = reconcile_rows([{"borrower_name": "A", "name": "机", "quantity": 1}, {"borrower_name": "B", "name": "机", "quantity": 1}], old, "https://app.iyakusai.com")
        self.assertEqual([i["code"] for i in result["removed_candidates"]], ["IY-100002", "IY-100003"])
        self.assertEqual(result["added_codes"], ["IY-100004"])

    def test_removed_high_codes_stay_reserved_across_updates(self):
        old = expand_rows([{"borrower_name":"A","name":"机","quantity":3}],"https://app.iyakusai.com",100001)
        first = reconcile_rows([{"borrower_name":"A","name":"机","quantity":1}],old,"https://app.iyakusai.com")
        with tempfile.TemporaryDirectory() as folder:
            manifest = generate_bundle(first["items"], Path(folder)/"reduced.pdf", reserved_through=first["reserved_through"])
            second = reconcile_rows([{"borrower_name":"A","name":"机","quantity":2}],load_bundle(manifest),"https://app.iyakusai.com",bundle_reserved_through(manifest))
        self.assertEqual(second["added_codes"],["IY-100004"])

    def test_supplier_and_id_are_preserved(self):
        old = [{**expand_rows([{"borrower_name": "A", "name": "コンロ", "quantity": 1}], "https://app.iyakusai.com", 100001)[0], "borrower_id": "B-1"}]
        result = reconcile_rows([{"borrower_name": "A", "name": "コンロ", "quantity": 1, "item_scope": "学外", "item_owner": "サンプル燃料店"}], old, "https://app.iyakusai.com")
        self.assertEqual(result["items"][0]["borrower_id"], "B-1")
        self.assertEqual(result["items"][0]["item_owner"], "サンプル燃料店")


if __name__ == "__main__":
    unittest.main()
