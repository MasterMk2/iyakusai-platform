"""Offline manifest/batch safety tests. No reader or tag hardware is opened."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import manifest_batch as batch
import single_card_trial as trial
from test_single_card_trial import FakeLiteS, IDM


class FakeAudit:
    def __init__(self, *args):
        self.path = "offline://batch-test"
        self.events = []
        self.snapshots = []
        self.saved = {}
        self.binaries = {}

    def event(self, event, **fields):
        self.events.append((event, fields))

    def snapshot(self, name, value):
        self.snapshots.append((name, value))

    def save(self, name, value):
        if name in self.saved:
            raise AssertionError("Immutable evidence filename reused")
        self.saved[name] = dict(value)

    def binary(self, name, value):
        self.binaries[name] = bytes(value)


def item(code="IY-TEST-000001"):
    url = "https://example.com/?iy=" + code
    return batch.Item(code, "Test card " + code, url, trial.encode_url(url))


def written_card(selected):
    card = FakeLiteS(True)
    card.ndef.octets = selected.encoded
    card.represented()
    card.writes.clear()
    return card


class ManifestTests(unittest.TestCase):
    def setUp(self):
        # Native tempfile cleanup uses one Python process end-to-end. Check the
        # final absolute root is inside the owned card directory before cleanup.
        self.temporary = tempfile.TemporaryDirectory(prefix="offline-batch-", dir=trial.BASE)
        self.root = Path(self.temporary.name).resolve()
        self.root.relative_to(trial.BASE.resolve())
        self.pdf = self.root / "printed.pdf"
        self.pdf.write_bytes(b"offline fixture PDF bytes; not a real printed label")
        self.path = self.root / "printed.issuance.json"
        self.obj = {"format": batch.FORMAT, "label_mm": [91, 55], "page": "A4",
                    "pdf_sha256": hashlib.sha256(self.pdf.read_bytes()).hexdigest(),
                    "items": [{"code": item().code, "name": item().name, "url": item().url}]}
        self.save()

    def tearDown(self):
        self.root.relative_to(trial.BASE.resolve())
        self.temporary.cleanup()

    def save(self):
        self.path.write_text(json.dumps(self.obj), encoding="utf-8")

    def test_manifest_locks_exact_source_pdf_hash_and_item_url(self):
        result = batch.load_manifest(self.path)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), result.sha256)
        self.assertEqual(self.obj["pdf_sha256"], result.pdf_sha256)
        self.assertEqual((item(),), result.items)
        self.assertEqual(35, len(result.items[0].encoded))
        with self.assertRaises(Exception):
            result.items[0].url = "https://example.com/?iy=other"

    def test_manifest_size_allows_9_and_16_mib_but_refuses_above_16_mib(self):
        original_stat = Path.stat
        for size, allowed in ((9 * 1024 * 1024, True), (16 * 1024 * 1024, True),
                              (16 * 1024 * 1024 + 1, False)):
            def sized_stat(path, *args, **kwargs):
                current = original_stat(path, *args, **kwargs)
                if path == self.path:
                    # Preserve mode/time fields used by other Path operations.
                    values = list(current)
                    values[6] = size
                    return type(current)(values)
                return current
            with self.subTest(size=size), patch.object(Path, "stat", new=sized_stat):
                if allowed:
                    self.assertEqual((item(),), batch.load_manifest(self.path).items)
                else:
                    with self.assertRaisesRegex(trial.TrialError, "maximum 16 MiB"):
                        batch.load_manifest(self.path)
    def test_pdf_mismatch_refused_before_card_access(self):
        self.pdf.write_bytes(b"changed PDF")
        with self.assertRaises(trial.TrialError):
            batch.load_manifest(self.path)

    def test_duplicate_code_and_conflicting_url_reference_refused(self):
        for entries in ([self.obj["items"][0]] * 2,
                        [{"code": item().code, "name": item().name,
                          "url": item().url + "&item=IY-OTHER-001"}]):
            with self.subTest(entries=entries):
                self.obj["items"] = entries
                self.save()
                with self.assertRaises(trial.TrialError):
                    batch.load_manifest(self.path)

    def test_preview_default_never_opens_usb_lease_or_registry(self):
        audit = FakeAudit()
        with patch.object(trial, "Audit", return_value=audit), \
                patch("nfc.ContactlessFrontend", side_effect=AssertionError("USB opened")), \
                patch("nfc.clf.transport.USB.find", side_effect=AssertionError("USB enumerated")), \
                patch.object(batch, "Lease", side_effect=AssertionError("writer lock taken")), \
                patch.object(batch, "load_registry", side_effect=AssertionError("registry accessed")), \
                contextlib.redirect_stdout(io.StringIO()):
            status = batch.main(["--issuance-json", str(self.path), "--manual"])
        self.assertEqual(0, status)
        self.assertEqual("manual", audit.saved["preview.json"]["mode"])
        self.assertFalse(audit.saved["preview.json"]["device_accessed"])
        self.assertEqual(self.path.read_bytes(), audit.binaries["frozen.issuance.json"])


class BindingTests(unittest.TestCase):
    def test_blank_card_allowed_without_preexisting_binding(self):
        card = FakeLiteS()
        self.assertEqual("write-blank", batch.check_binding(item(), trial.take_snapshot(card), {}, {}))
        self.assertEqual([], card.writes)

    def test_known_exact_url_is_read_only_even_if_card_is_locked(self):
        selected = item()
        card = written_card(selected)
        card.memory[0x88][0] = 0x00  # Existing content is readable; no writable requirement.
        snapshot = trial.take_snapshot(card)
        self.assertEqual("verify-existing", batch.check_binding(selected, snapshot, {}, {}))
        audit = FakeAudit()
        result = batch.verify_existing(card, snapshot, selected, audit,
                                       lambda previous, *args: previous.represented())
        self.assertEqual("passed", result["status"])
        self.assertFalse(result["device_written"])
        self.assertEqual([], card.writes)

    def test_other_url_or_existing_reservation_refused_without_writes(self):
        selected = item()
        other = item("IY-TEST-000002")
        other_card = written_card(other)
        with self.assertRaises(trial.TrialError):
            batch.check_binding(selected, trial.take_snapshot(other_card), {}, {})
        pending = {"idm": IDM, "code": selected.code, "url": selected.url, "status": "reserved"}
        blank = FakeLiteS()
        with self.assertRaises(trial.TrialError):
            batch.check_binding(selected, trial.take_snapshot(blank), {IDM: pending}, {selected.code: pending})
        self.assertEqual([], other_card.writes)
        self.assertEqual([], blank.writes)

    def test_reused_card_or_code_for_different_binding_refused(self):
        selected = item()
        other = item("IY-TEST-000002")
        saved = {"idm": IDM, "code": other.code, "url": other.url, "status": "passed"}
        card = written_card(selected)
        with self.assertRaises(trial.TrialError):
            batch.check_binding(selected, trial.take_snapshot(card), {IDM: saved}, {})
        saved = {"idm": "1111111111111111", "code": selected.code, "url": selected.url, "status": "passed"}
        with self.assertRaises(trial.TrialError):
            batch.check_binding(selected, trial.take_snapshot(card), {}, {selected.code: saved})
        self.assertEqual([], card.writes)

    def test_existing_verification_rejects_tail_memory_changed(self):
        selected = item()
        card = written_card(selected)
        initial = trial.take_snapshot(card)
        def changed(previous, *args):
            previous.memory[13][0] ^= 1
            return previous.represented()
        with self.assertRaises(trial.TrialError):
            batch.verify_existing(card, initial, selected, FakeAudit(), changed)
        self.assertEqual([], card.writes)


class ProcessTests(unittest.TestCase):
    def manifest(self):
        return SimpleNamespace(sha256="1" * 64, pdf_sha256="2" * 64)

    def test_blank_write_reserves_before_writer_and_records_only_verified_pass(self):
        selected, card, card_audit, batch_audit = item(), FakeLiteS(), FakeAudit(), FakeAudit()
        order, by_id, by_code = [], {}, {}
        def registry(selected, idm, status, *args):
            order.append(status)
            return {"idm": idm, "code": selected.code, "url": selected.url, "status": status}
        def write(*args):
            self.assertEqual(["reserved"], order)
            self.assertEqual("reserved", by_id[IDM]["status"])
            order.append("write")
            return {"status": "passed", "idm": IDM}
        with patch.object(trial, "Audit", return_value=card_audit), \
                patch.object(batch, "registry_event", side_effect=registry), \
                patch.object(trial, "write_one", side_effect=write):
            result, last = batch.process_item(card, selected, self.manifest(), batch_audit, 1, 1,
                                             by_id, by_code, 1, lambda *args: card, lambda: True)
        self.assertEqual(["reserved", "write", "passed"], order)
        self.assertEqual("passed", by_id[IDM]["status"])
        self.assertTrue(result["device_written"])
        self.assertEqual(selected.code, result["code"])
        self.assertIs(card, last)

    def test_failed_write_keeps_reservation_and_never_records_pass(self):
        selected, card, card_audit, batch_audit = item(), FakeLiteS(), FakeAudit(), FakeAudit()
        statuses, by_id, by_code = [], {}, {}
        def registry(selected, idm, status, *args):
            statuses.append(status)
            return {"idm": idm, "code": selected.code, "url": selected.url, "status": status}
        with patch.object(trial, "Audit", return_value=card_audit), \
                patch.object(batch, "registry_event", side_effect=registry), \
                patch.object(trial, "write_one", side_effect=trial.TrialError("interrupted")) as writer, \
                self.assertRaises(trial.TrialError):
            batch.process_item(card, selected, self.manifest(), batch_audit, 1, 1,
                               by_id, by_code, 1, lambda *args: card, lambda: True)
        self.assertEqual(["reserved"], statuses)
        self.assertEqual(1, writer.call_count)
        self.assertEqual("reserved", by_code[selected.code]["status"])
        self.assertFalse(card_audit.saved["failure.json"]["automatic_retry"])

    def test_known_url_path_never_calls_writer_or_formatter(self):
        selected, card_audit, batch_audit = item(), FakeAudit(), FakeAudit()
        card = written_card(selected)
        with patch.object(trial, "Audit", return_value=card_audit), \
                patch.object(batch, "registry_event", return_value={"status": "passed"}), \
                patch.object(trial, "wait_removed", return_value={"physical_removal_confirmed": False}), \
                patch.object(trial, "write_one", side_effect=AssertionError("writer called")), \
                patch.object(card, "format", side_effect=AssertionError("format called")), \
                contextlib.redirect_stdout(io.StringIO()):
            result, last = batch.process_item(card, selected, self.manifest(), batch_audit, 1, 1,
                                             {}, {}, 1, lambda *args: card.represented(), lambda: True)
        self.assertFalse(result["device_written"])
        self.assertIs(card, last)
        self.assertEqual([], card.writes)


class ForceTests(unittest.TestCase):
    """Forced overwrite mode: a person confirms each nonempty card; nothing else is relaxed."""

    def manifest(self):
        return SimpleNamespace(sha256="1" * 64, pdf_sha256="2" * 64)

    def run_item(self, card, selected, by_id, by_code, confirm, writer=None):
        statuses, releases, card_audit = [], [], FakeAudit()
        def registry(selected, idm, status, *args):
            statuses.append(status)
            return {"idm": idm, "code": selected.code, "url": selected.url, "status": status}
        def release(idm, code, url, reason, evidence):
            releases.append((idm, code, url, reason))
            return {}
        writer = writer or (lambda *args: {"status": "passed", "idm": IDM})
        with patch.object(trial, "Audit", return_value=card_audit), \
                patch.object(batch, "registry_event", side_effect=registry), \
                patch.object(batch, "registry_release", side_effect=release), \
                patch.object(trial, "write_one", side_effect=writer) as write_one:
            result = batch.process_item(card, selected, self.manifest(), FakeAudit(), 1, 1, by_id, by_code, 1,
                                        lambda *args: card, lambda: True, confirm_overwrite=confirm)
        return result, statuses, releases, write_one, card_audit

    def test_card_with_other_url_is_overwritten_only_after_confirmation(self):
        old, new = item("IY-TEST-000001"), item("IY-100001")
        seen = []
        def confirm(details):
            seen.append(details)
            return True
        (result, _), statuses, releases, write_one, audit = self.run_item(written_card(old), new, {}, {}, confirm)
        self.assertEqual([old.url], seen[0]["existing_urls"])
        self.assertTrue(seen[0]["occupied"])
        self.assertEqual(["reserved", "passed"], statuses)
        self.assertTrue(write_one.call_args.args[4].allow_overwrite)
        self.assertEqual("before-overwrite", audit.snapshots[0][0])
        self.assertTrue(result["device_written"])

    def test_declined_card_is_not_written_or_recorded(self):
        old, new = item("IY-TEST-000001"), item("IY-100001")
        with self.assertRaises(trial.TrialError):
            self.run_item(written_card(old), new, {}, {}, lambda details: False,
                          writer=lambda *args: self.fail("writer called"))

    def test_registry_bindings_are_released_before_the_new_reservation(self):
        old, new = item("IY-TEST-000001"), item("IY-100001")
        card_binding = {"idm": IDM, "code": old.code, "url": old.url, "status": "passed"}
        code_binding = {"idm": "FEDCBA9876543210", "code": new.code, "url": new.url, "status": "passed"}
        by_id, by_code = {IDM: card_binding}, {old.code: card_binding, new.code: code_binding}
        (_, _), statuses, releases, _, _ = self.run_item(written_card(old), new, by_id, by_code, lambda details: True)
        self.assertEqual({(IDM, old.code), ("FEDCBA9876543210", new.code)}, {(r[0], r[1]) for r in releases})
        self.assertEqual(["reserved", "passed"], statuses)
        self.assertEqual(new.code, by_id[IDM]["code"])
        self.assertNotIn(old.code, by_code)

    def test_blank_and_identical_cards_need_no_confirmation(self):
        selected = item("IY-100001")
        no_question = lambda details: self.fail("asked to confirm")
        (_, _), _, _, write_one, _ = self.run_item(FakeLiteS(), selected, {}, {}, no_question)
        self.assertFalse(write_one.call_args.args[4].allow_overwrite)
        card = written_card(selected)
        with patch.object(trial, "wait_removed", return_value={"physical_removal_confirmed": False}), \
                contextlib.redirect_stdout(io.StringIO()):
            (result, _), _, _, _, _ = self.run_item(card, selected, {}, {}, no_question,
                                                    writer=lambda *args: self.fail("writer called"))
        self.assertFalse(result["device_written"])

    def test_protected_card_is_refused_even_when_forced(self):
        card = written_card(item("IY-TEST-000001"))
        card.memory[0x88][0] = 0x00  # part of the user memory is read-only
        with self.assertRaises(trial.TrialError):
            self.run_item(card, item("IY-100001"), {}, {}, lambda details: True,
                          writer=lambda *args: self.fail("writer called"))

    def test_no_confirmation_option_is_recorded_and_still_refuses_protected_cards(self):
        old, new = item("IY-TEST-000001"), item("IY-100001")
        def automatic(details):
            return True
        automatic.automatic = True
        (_, _), statuses, _, _, audit = self.run_item(written_card(old), new, {}, {}, automatic)
        self.assertEqual(["reserved", "passed"], statuses)
        self.assertIn(("overwrite_confirmed", {"automatic": True}), audit.events)
        (_, _), _, _, _, audit = self.run_item(written_card(old), new, {}, {}, lambda details: True)
        self.assertIn(("overwrite_confirmed", {"automatic": False}), audit.events)
        card = written_card(old)
        card.memory[0x88][0] = 0x00
        with self.assertRaises(trial.TrialError):
            self.run_item(card, new, {}, {}, automatic, writer=lambda *args: self.fail("writer called"))

    def test_registry_released_lines_end_old_bindings(self):
        old, new = item("IY-TEST-000001"), item("IY-100001")
        lines = [
            {"time": "t", "idm": IDM, "code": old.code, "url": old.url, "status": "passed"},
            {"time": "t", "idm": IDM, "code": old.code, "url": old.url, "status": "released", "reason": "forced-overwrite:card_bound"},
            {"time": "t", "idm": IDM, "code": new.code, "url": new.url, "status": "passed"},
        ]
        with tempfile.TemporaryDirectory(prefix="offline-registry-", dir=trial.BASE) as folder:
            path = Path(folder) / "issuance_registry.jsonl"
            path.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")
            with patch.object(batch, "REGISTRY", path):
                by_id, by_code = batch.load_registry()
        self.assertEqual(new.code, by_id[IDM]["code"])
        self.assertNotIn(old.code, by_code)


class SequenceTests(unittest.TestCase):
    def test_sequence_advances_only_after_pass_in_manifest_order(self):
        entries = (item(), item("IY-TEST-000002"))
        calls, last_tag, audit = [], object(), FakeAudit()
        def acquire():
            calls.append("acquire")
            return last_tag
        def process(tag, selected, index):
            calls.append(selected.code)
            return {"status": "passed", "idm": f"{index:016X}", "device_written": True}, tag
        with contextlib.redirect_stdout(io.StringIO()):
            result = batch.run_items(entries, "sequence", process, acquire,
                                     lambda previous: calls.append("previous-removed"), audit)
        self.assertEqual(["acquire", entries[0].code, "previous-removed", "acquire", entries[1].code], calls)
        self.assertEqual("passed", result["status"])
        self.assertEqual(2, result["verified_items"])

    def test_first_failure_stops_without_next_card_or_next_code(self):
        entries, audit, calls = (item(), item("IY-TEST-000002")), FakeAudit(), []
        def acquire():
            calls.append("acquire")
            return object()
        def process(tag, selected, index):
            calls.append(selected.code)
            raise trial.TrialError("failed readback")
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(trial.TrialError):
            batch.run_items(entries, "sequence", process, acquire,
                            lambda previous: self.fail("next-card wait called"), audit)
        self.assertEqual(["acquire", entries[0].code], calls)
        self.assertEqual(entries[0].code, audit.saved["batch-failure.json"]["failed_code"])
        self.assertEqual(0, audit.saved["batch-failure.json"]["verified_items"])
        self.assertFalse(audit.saved["batch-failure.json"]["sequence_advanced"])

    def test_manual_input_selects_attached_code_and_skips_unknown_or_completed(self):
        entries, calls, audit = (item(), item("IY-TEST-000002")), [], FakeAudit()
        inputs = iter(["IY-UNKNOWN-999", entries[1].code, entries[1].code, entries[0].code, ""])
        def process(tag, selected, index):
            calls.append(selected.code)
            return {"status": "passed", "idm": f"{index:016X}", "device_written": False}, tag
        with contextlib.redirect_stdout(io.StringIO()):
            result = batch.run_items(entries, "manual", process, lambda: object(),
                                     lambda previous: None, audit, lambda prompt: next(inputs))
        self.assertEqual([entries[1].code, entries[0].code], calls)
        self.assertEqual(2, result["verified_items"])
        self.assertEqual("manual", result["mode"])

    def test_manual_blank_stops_before_card_access(self):
        audit = FakeAudit()
        result = batch.run_items((item(),), "manual", lambda *args: self.fail("process called"),
                                 lambda: self.fail("card acquire called"), lambda *args: None,
                                 audit, lambda prompt: "")
        self.assertEqual("stopped-by-operator", result["status"])
        self.assertEqual(0, result["verified_items"])

    def test_sequence_start_is_exact_saved_code_and_never_invented(self):
        entries = (item(), item("IY-TEST-000002"))
        self.assertEqual((entries[1],), batch.select_sequence(entries, entries[1].code))
        with self.assertRaises(trial.TrialError):
            batch.select_sequence(entries, "IY-TEST-999999")


if __name__ == "__main__":
    unittest.main(verbosity=2)