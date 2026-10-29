"""Offline GUI-worker contract tests with real batch guards and fake card memory."""
from contextlib import contextmanager, ExitStack
from pathlib import Path
import queue
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "card"))
import writer_worker as worker
from test_manifest_batch import item, FakeAudit
from test_single_card_trial import FakeLiteS


class Events:
    def __init__(self):
        self.values = []
        self.condition = threading.Condition()

    def __call__(self, value):
        with self.condition:
            self.values.append(dict(value))
            self.condition.notify_all()

    def wait(self, kind, predicate=lambda value: True, timeout=3):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                for value in self.values:
                    if value["kind"] == kind and predicate(value):
                        return value
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"No {kind} event: {self.values}")
                self.condition.wait(remaining)


class Harness:
    def __init__(self, entries=None, cards=None):
        self.entries = entries or (item(),)
        self.cards = list(cards or [FakeLiteS(True)])
        self.manifest = SimpleNamespace(items=self.entries, raw=b"offline-manifest",
                                        source=Path("offline.issuance.json"), pdf=Path("offline.pdf"),
                                        sha256="a" * 64, pdf_sha256="b" * 64)
        self.events = Events()
        self.controller = worker.WriterController("offline.issuance.json", self.events)
        self.stack = ExitStack()
        self.reservations = []
        self.acquisitions = []
        self.audits = []
        self.last = None
        self.acquire_override = None
        self.on_reservation = None
        self.presence_prompts = []

    def audit(self, *args):
        audit = FakeAudit()
        self.audits.append(audit)
        return audit

    def registry(self, selected, idm, status, *args):
        self.reservations.append((selected.code, idm, status))
        if self.on_reservation:
            self.on_reservation(status)
        return {"idm": idm, "code": selected.code, "url": selected.url, "status": status}

    @contextmanager
    def reader(self, audit):
        self.controller._clf = object()
        try:
            yield self.controller._clf
        finally:
            self.controller._clf = None

    def acquire(self, clf, timeout, expected_id=None, ndef_only=False):
        self.acquisitions.append((timeout, expected_id, ndef_only))
        if self.acquire_override:
            return self.acquire_override(clf, timeout, expected_id, ndef_only)
        if expected_id:
            card = self.last.represented()
            worker.trial.guard_tag(card, expected_id)
            if ndef_only and card.sys != 0x12FC:
                raise AssertionError("Missing independent NDEF activation")
            return card
        self.last = self.cards.pop(0)
        return self.last

    def wait_removed(self, *args):
        prompts = [x for x in self.events.values if x["kind"] == "prompt"]
        self.presence_prompts.append(prompts[-1]["stage"])
        self.assert_prompt = prompts[-1]["stage"] in ("remove", "remove-previous")
        if not self.assert_prompt:
            raise AssertionError("GUI removal prompt was not emitted before polling")
        return {"no_response_samples": 3, "transport_timeout_samples_10060": 0,
                "physical_removal_confirmed": False}

    def __enter__(self):
        replacements = [
            patch.object(worker.batch, "load_manifest", return_value=self.manifest),
            patch.object(worker.batch, "Lease"),
            patch.object(worker.batch, "load_registry", return_value=({}, {})),
            patch.object(worker.batch, "registry_event", side_effect=self.registry),
            patch.object(worker.trial, "Audit", side_effect=self.audit),
            patch.object(self.controller, "_open_reader", side_effect=self.reader),
            patch.object(self.controller, "_reader_present", return_value=True),
            patch.object(worker.trial, "acquire_one", side_effect=self.acquire),
            patch.object(worker.trial, "wait_removed", side_effect=self.wait_removed),
            patch("nfc.ContactlessFrontend", side_effect=AssertionError("Real USB forbidden")),
            patch("nfc.clf.transport.USB.find", side_effect=AssertionError("Real USB enumeration forbidden")),
        ]
        for replacement in replacements:
            self.stack.enter_context(replacement)
        return self

    def __exit__(self, *args):
        self.controller.stop()
        if self.controller._thread:
            self.controller._thread.join(timeout=3)
            if self.controller._thread.is_alive():
                raise AssertionError("Worker did not finish safely")
        self.stack.close()


class InputTests(unittest.TestCase):
    def test_manual_code_and_exact_qr_url_resolve_same_saved_item(self):
        selected = item()
        manifest = SimpleNamespace(items=(selected,))
        self.assertIs(selected, worker.resolve_manual_input(selected.code.lower(), manifest))
        self.assertIs(selected, worker.resolve_manual_input(selected.url, manifest))
        for value in (selected.url + "&x=1", "https://evil.example/?iy=" + selected.code,
                      "IY-UNKNOWN-999", "", {"code": selected.code}):
            with self.subTest(value=value), self.assertRaises(worker.trial.TrialError):
                worker.resolve_manual_input(value, manifest)

    def test_short_number_selects_the_listed_item(self):
        manifest = SimpleNamespace(items=[item("IY-100123"), item("IY-100124")])
        for value in ("123", "No.123", "no 123", "100123", "IY-100123"):
            self.assertEqual("IY-100123", worker.resolve_manual_input(value, manifest).code)
        for value in ("0", "125", "999999"):
            with self.assertRaises(worker.trial.TrialError):
                worker.resolve_manual_input(value, manifest)

    def test_constructor_and_idle_stop_do_not_open_any_reader(self):
        with patch("nfc.ContactlessFrontend", side_effect=AssertionError("Real USB forbidden")), \
                patch("nfc.clf.transport.USB.find", side_effect=AssertionError("USB enumerated")):
            controller = worker.WriterController("offline", lambda event: None)
            self.assertFalse(controller.running)
            self.assertFalse(controller.submit_code("IY-000123"))
            controller.stop()


class WorkerTests(unittest.TestCase):
    def test_sequence_uses_real_batch_write_and_independent_readback(self):
        with Harness() as harness:
            harness.controller.start("sequence")
            result = harness.events.wait("finished")
            self.assertEqual("passed", result["status"])
            self.assertEqual(1, result["verified_items"])
            self.assertFalse(harness.controller.running)
            passed = harness.events.wait("passed")
            self.assertTrue(passed["device_written"])
            self.assertEqual(["reserved", "passed"], [x[2] for x in harness.reservations])
            self.assertEqual([(1.0, None, False), (45.0, "0123456789ABCDEF", True)], harness.acquisitions)
            self.assertEqual(["remove"], harness.presence_prompts)
            # Fake memory receives the real nfcpy payload writes; no USB is opened.
            self.assertEqual([0, 1, 2, 3, 0], [block for block, _ in harness.last.writes])
            self.assertEqual(["before", "after-write", "after-represent"],
                             [x[0] for x in harness.audits[1].snapshots])

    def test_unformatted_card_announces_both_representations_before_polling(self):
        with Harness(cards=[FakeLiteS()]) as harness:
            harness.controller.start("sequence")
            self.assertEqual("passed", harness.events.wait("finished")["status"])
            self.assertEqual(["remove", "remove"], harness.presence_prompts)
            representations = [x for x in harness.events.values if x.get("stage") == "represent"]
            self.assertEqual(2, len(representations))
            self.assertIn("初期化", representations[0]["text"])
            self.assertTrue(all(expected_id and ndef_only for _, expected_id, ndef_only in harness.acquisitions[1:]))

    def test_stop_during_manual_input_never_acquires_or_writes(self):
        with Harness() as harness:
            harness.controller.start("manual")
            harness.events.wait("prompt", lambda x: x.get("stage") == "input")
            harness.controller.stop()
            result = harness.events.wait("finished")
            self.assertEqual("stopped", result["status"])
            self.assertEqual([], harness.acquisitions)
            self.assertEqual([], harness.reservations)
            self.assertFalse(harness.controller.submit_code(item().code))

    def test_stop_during_initial_acquisition_never_starts_write(self):
        with Harness() as harness:
            def stop_before_card(*args):
                harness.controller.stop()
                raise worker.trial.TrialError("Card wait timed out; no card was processed.")
            harness.acquire_override = stop_before_card
            harness.controller.start("sequence")
            self.assertEqual("stopped", harness.events.wait("finished")["status"])
            self.assertEqual([], harness.reservations)
            self.assertEqual([], harness.cards[0].writes)
            self.assertEqual(1, len(harness.acquisitions))

    def test_stop_after_write_reserved_finishes_current_but_never_next(self):
        entries = (item(), item("IY-TEST-000002"))
        with Harness(entries=entries, cards=[FakeLiteS(True)]) as harness:
            harness.on_reservation = lambda status: harness.controller.stop() if status == "reserved" else None
            harness.controller.start("sequence")
            result = harness.events.wait("finished")
            self.assertEqual("stopped", result["status"])
            self.assertEqual(1, result["verified_items"])
            self.assertEqual([entries[0].code], [x["code"] for x in harness.events.values if x["kind"] == "ready"])
            self.assertEqual(["reserved", "passed"], [x[2] for x in harness.reservations])
            self.assertTrue(harness.events.wait("passed")["device_written"])

    def test_failure_retains_reservation_stops_and_never_retries(self):
        with Harness(entries=(item(), item("IY-TEST-000002"))) as harness, \
                patch.object(worker.trial, "write_one", side_effect=worker.trial.TrialError("failed write")) as writer:
            harness.controller.start("sequence")
            self.assertEqual("failed", harness.events.wait("finished")["status"])
            self.assertEqual(1, writer.call_count)
            self.assertEqual(["reserved"], [x[2] for x in harness.reservations])
            self.assertEqual(1, len([x for x in harness.events.values if x["kind"] == "ready"]))
            self.assertFalse(harness.audits[1].saved["failure.json"]["automatic_retry"])
            self.assertTrue(harness.events.wait("error")["fatal"])

    def test_occupied_other_url_refused_without_any_write(self):
        other = item("IY-TEST-000002")
        card = FakeLiteS(True)
        card.ndef.octets = other.encoded
        card.writes.clear()
        with Harness(cards=[card]) as harness:
            harness.controller.start("sequence")
            self.assertEqual("failed", harness.events.wait("finished")["status"])
            self.assertEqual([], card.writes)
            self.assertEqual([], harness.reservations)

    def test_existing_exact_url_is_read_only_and_only_passes_after_represent(self):
        selected, card = item(), FakeLiteS(True)
        card.ndef.octets = selected.encoded
        card.writes.clear()
        with Harness(cards=[card]) as harness, \
                patch.object(worker.trial, "write_one", side_effect=AssertionError("Writer called")):
            harness.controller.start("sequence")
            self.assertEqual("passed", harness.events.wait("finished")["status"])
            self.assertFalse(harness.events.wait("passed")["device_written"])
            self.assertEqual([], card.writes)
            self.assertEqual(["passed"], [x[2] for x in harness.reservations])
            self.assertEqual(2, len(harness.acquisitions))

    def test_manual_unknown_input_then_qr_selection_uses_saved_code(self):
        with Harness() as harness:
            harness.controller.start("manual")
            harness.events.wait("prompt", lambda x: x.get("stage") == "input")
            self.assertTrue(harness.controller.submit_code("IY-UNKNOWN-999"))
            harness.events.wait("error", lambda x: x.get("fatal") is False)
            # Wait for the second input prompt instead of feeding scan-ahead.
            deadline = time.monotonic() + 3
            with harness.events.condition:
                while len([x for x in harness.events.values if x.get("stage") == "input"]) < 2:
                    harness.events.condition.wait(max(0.001, deadline - time.monotonic()))
                    if time.monotonic() >= deadline:
                        self.fail("No repeated manual input prompt")
            self.assertTrue(harness.controller.submit_code(item().url))
            self.assertEqual("passed", harness.events.wait("finished")["status"])
            self.assertEqual(item().code, harness.events.wait("ready")["code"])

    def test_duplicate_start_and_scan_ahead_refused(self):
        with Harness() as harness:
            harness.controller.start("manual")
            harness.events.wait("prompt", lambda x: x.get("stage") == "input")
            with self.assertRaises(RuntimeError):
                harness.controller.start("sequence")
            harness.controller.stop()
            self.assertFalse(harness.controller.submit_code(item().code))
            harness.events.wait("finished")

    def test_two_sequence_cards_advance_only_after_first_pass(self):
        entries = (item(), item("IY-TEST-000002"))
        cards = [FakeLiteS(True), FakeLiteS(True)]
        cards[1]._nfcid = cards[1].idm = bytearray.fromhex("1111111111111111")
        with Harness(entries=entries, cards=cards) as harness:
            harness.controller.start("sequence")
            result = harness.events.wait("finished")
            self.assertEqual("passed", result["status"])
            self.assertEqual(2, result["verified_items"])
            milestones = [(x["kind"], x["code"]) for x in harness.events.values
                          if x["kind"] in ("ready", "passed")]
            self.assertEqual([("ready", entries[0].code), ("passed", entries[0].code),
                              ("ready", entries[1].code), ("passed", entries[1].code)], milestones)
            self.assertEqual(["reserved", "passed", "reserved", "passed"],
                             [x[2] for x in harness.reservations])
            self.assertEqual(["remove", "remove-previous", "remove"], harness.presence_prompts)

    def test_bad_manifest_fails_before_reader_registry_or_card_access(self):
        with Harness() as harness, \
                patch.object(worker.batch, "load_manifest", side_effect=worker.trial.TrialError("PDF mismatch")), \
                patch.object(worker.batch, "load_registry", side_effect=AssertionError("Registry loaded")):
            harness.controller.start("sequence")
            self.assertEqual("failed", harness.events.wait("finished")["status"])
            self.assertEqual([], harness.acquisitions)
            self.assertEqual([], harness.reservations)
            self.assertTrue(harness.events.wait("error")["fatal"])

    def test_audit_storage_failure_still_reports_error_and_finished_to_gui(self):
        with Harness() as harness:
            harness.controller.start("manual")
            harness.events.wait("prompt", lambda x: x.get("stage") == "input")
            with patch.object(harness.audits[0], "save", side_effect=OSError("disk full")), \
                    patch.object(worker.trial, "write_one", side_effect=worker.trial.TrialError("write failed")):
                self.assertTrue(harness.controller.submit_code(item().code))
                result = harness.events.wait("finished")
            self.assertEqual("failed", result["status"])
            error = harness.events.wait("error")
            self.assertTrue(error["fatal"])
            self.assertIn("失敗証跡も保存できませんでした", error["text"])
            self.assertEqual(["reserved"], [x[2] for x in harness.reservations])
    def test_wrong_id_on_readback_stops_and_does_not_advance(self):
        with Harness(entries=(item(), item("IY-TEST-000002"))) as harness:
            def acquire(clf, timeout, expected_id=None, ndef_only=False):
                if expected_id:
                    raise worker.trial.TrialError("Refused: different card")
                return harness.cards[0]
            harness.acquire_override = acquire
            harness.controller.start("sequence")
            self.assertEqual("failed", harness.events.wait("finished")["status"])
            self.assertEqual(["reserved"], [x[2] for x in harness.reservations])
            self.assertFalse(any(x["kind"] == "passed" for x in harness.events.values))


if __name__ == "__main__":
    unittest.main(verbosity=2)

class ForcedOverwriteConfirmationTests(unittest.TestCase):
    """The worker asks the screen about each nonempty card and waits for the person's answer."""

    DETAILS = {"idm": "0123456789ABCDEF", "code": "IY-100001", "name": "机", "url": "https://rental.example.test/i/IY-100001",
               "existing_urls": ["https://example.com/?iy=IY-TEST-000001"], "occupied": True,
               "conflicts": [{"kind": "card_bound", "code": "IY-TEST-000001", "url": "https://example.com/?iy=IY-TEST-000001", "status": "passed"}]}

    def ask(self, answer=None, stop=False):
        events, results = [], []
        controller = worker.WriterController("unused.issuance.json", events.append, force_overwrite=True)
        thread = threading.Thread(target=lambda: results.append(controller._confirm_overwrite(self.DETAILS)))
        thread.start()
        for _ in range(100):
            if events:
                break
            time.sleep(0.01)
        self.assertEqual("confirm", events[0]["kind"])
        if stop:
            controller.stop()
        else:
            self.assertTrue(controller.answer_overwrite(answer))
        thread.join(2)
        self.assertFalse(controller.answer_overwrite(True), "no question is open any more")
        return events[0], results[0]

    def test_question_shows_current_url_binding_and_new_item(self):
        event, result = self.ask(True)
        self.assertTrue(result)
        for text in ("IY-TEST-000001", "IY-100001", "https://rental.example.test/i/IY-100001", "末尾 CDEF"):
            self.assertIn(text, event["text"])

    def test_no_and_stop_mean_do_not_overwrite(self):
        self.assertFalse(self.ask(False)[1])
        self.assertFalse(self.ask(stop=True)[1])

    def test_answers_without_a_question_are_ignored(self):
        controller = worker.WriterController("unused.issuance.json", lambda event: None, force_overwrite=True)
        self.assertFalse(controller.answer_overwrite(True))


class NoConfirmationOptionTests(unittest.TestCase):
    """With the "no confirmation" option, nonempty cards are overwritten without a question but announced."""

    DETAILS = ForcedOverwriteConfirmationTests.DETAILS

    def test_overwrites_without_a_question_and_logs_what_was_replaced(self):
        events = []
        controller = worker.WriterController("unused.issuance.json", events.append, force_overwrite=True, confirm_each=False)
        approver = controller._overwrite_approver()
        self.assertTrue(getattr(approver, "automatic", False))
        self.assertTrue(approver(self.DETAILS))
        self.assertEqual(["status"], [e["kind"] for e in events])
        for text in ("確認なし", "IY-TEST-000001", "IY-100001", "末尾 CDEF"):
            self.assertIn(text, events[0]["text"])
        self.assertFalse(controller.answer_overwrite(True), "no question was opened")

    def test_code_bound_card_asks_to_collect_the_other_card(self):
        details = dict(self.DETAILS, conflicts=[{"kind": "code_bound", "idm": "FEDCBA9876543210", "code": "IY-100001",
                                                 "url": "https://rental.example.test/i/IY-100001", "status": "passed"}])
        self.assertIn("回収", worker.overwrite_summary(details))

    def test_stop_still_means_do_not_overwrite(self):
        controller = worker.WriterController("unused.issuance.json", lambda event: None, force_overwrite=True, confirm_each=False)
        controller.stop()
        self.assertFalse(controller._overwrite_approver()(self.DETAILS))

    def test_option_has_no_effect_outside_forced_mode_and_default_still_asks(self):
        plain = worker.WriterController("unused.issuance.json", lambda event: None, confirm_each=False)
        self.assertIsNone(plain._overwrite_approver())
        self.assertTrue(plain.confirm_each)
        asking = worker.WriterController("unused.issuance.json", lambda event: None, force_overwrite=True)
        self.assertEqual(asking._confirm_overwrite, asking._overwrite_approver())
