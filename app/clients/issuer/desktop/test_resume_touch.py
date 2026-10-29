"""Real nfcpy memory guards with synthetic RF cycles; no hardware or production API."""
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import writer_worker as worker
from test_writer_worker import Harness, item, FakeLiteS


def cards(count):
    result = [FakeLiteS(True) for _ in range(count)]
    for index, card in enumerate(result):
        card.idm[-1] = 0xA0 + index
    return result


class ResumeTests(unittest.TestCase):
    def test_failure_at_second_card_persists_second_code_and_first_pass(self):
        entries = (item(), item("IY-TEST-000002"), item("IY-TEST-000003"))
        with tempfile.TemporaryDirectory() as folder, Harness(entries=entries, cards=[FakeLiteS(True)]) as h:
            h.controller.progress_folder = folder
            h.controller.start("sequence")
            self.assertEqual("failed", h.events.wait("finished")["status"])
            self.assertEqual(entries[1].code, h.events.wait("finished")["resume_code"])
            saved = worker.SequenceProgress(folder, h.manifest).read()
            self.assertEqual(entries[1].code, saved["next_code"])
            self.assertEqual([entries[0].code], saved["passed_codes"])
            # New controller, same exact printed manifest, starts at the saved code.
            with Harness(entries=entries, cards=cards(2)) as resumed:
                resumed.controller.progress_folder = folder
                resumed.controller.start("sequence", saved["next_code"])
                self.assertEqual("passed", resumed.events.wait("finished")["status"])
                self.assertEqual([x.code for x in entries[1:]], [e["code"] for e in resumed.events.values if e["kind"] == "ready"])
                final = worker.SequenceProgress(folder, resumed.manifest).read()
                self.assertIsNone(final["next_code"])
                self.assertEqual(sorted(x.code for x in entries), final["passed_codes"])

    def test_stop_after_success_keeps_next_code_before_ready_event(self):
        entries = (item(), item("IY-TEST-000002"))
        with tempfile.TemporaryDirectory() as folder, Harness(entries=entries) as h:
            h.controller.progress_folder = folder
            h.on_reservation = lambda status: h.controller.stop() if status == "reserved" else None
            h.controller.start("sequence")
            event = h.events.wait("finished")
            self.assertEqual("stopped", event["status"])
            self.assertEqual(entries[1].code, event["resume_code"])
            self.assertEqual(entries[1].code, worker.SequenceProgress(folder, h.manifest).read()["next_code"])

    def test_corrupt_or_different_progress_stops_before_device_access(self):
        with tempfile.TemporaryDirectory() as folder, Harness() as h:
            progress = worker.SequenceProgress(folder, h.manifest)
            progress.save(item().code, [])
            for data in ("broken-json", json.dumps({**progress.identity, "next_code": "UNLISTED", "passed_codes": []}),
                         json.dumps({**progress.identity, "pdf_sha256": "wrong", "passed_codes": []})):
                progress.path.write_text(data, encoding="utf-8")
                with self.assertRaises(worker.trial.TrialError):
                    progress.read()
            h.controller.progress_folder = folder
            h.controller.start("sequence")
            self.assertEqual("failed", h.events.wait("finished")["status"])
            self.assertEqual([], h.acquisitions)

    def test_failed_checkpoint_save_stops_before_card_write(self):
        with tempfile.TemporaryDirectory() as folder, Harness() as h, patch.object(worker.SequenceProgress, "save", side_effect=OSError("disk full")):
            h.controller.progress_folder = folder
            h.controller.start("sequence")
            self.assertEqual("failed", h.events.wait("finished")["status"])
            self.assertEqual([], h.acquisitions)
            self.assertEqual([], h.reservations)


class SingleTouchTests(unittest.TestCase):
    def setup_touch(self, harness):
        harness.controller.single_touch = True
        device = SimpleNamespace(mute=Mock())
        @contextmanager
        def reader(audit):
            harness.controller._clf = SimpleNamespace(device=device)
            yield harness.controller._clf
        harness.stack.enter_context(patch.object(harness.controller, "_open_reader", side_effect=reader))
        harness.stack.enter_context(patch.object(worker.time, "sleep"))
        return device

    def test_formatted_and_unformatted_cards_need_one_physical_presentation(self):
        for formatted, cycles in ((True, 1), (False, 2)):
            with self.subTest(formatted=formatted), Harness(cards=[FakeLiteS(formatted)]) as h:
                device = self.setup_touch(h)
                h.controller.start("sequence")
                self.assertEqual("passed", h.events.wait("finished")["status"])
                self.assertEqual(cycles, device.mute.call_count)
                self.assertEqual([], h.presence_prompts)
                self.assertEqual(1 + cycles, len(h.acquisitions))
                self.assertTrue(all(idm == "0123456789ABCDEF" and ndef for _, idm, ndef in h.acquisitions[1:]))
                self.assertTrue(h.events.wait("passed")["device_written"])

    def test_existing_exact_url_uses_fresh_readback_without_writes(self):
        card = FakeLiteS(True)
        card.ndef.octets = item().encoded
        card.writes.clear()
        with Harness(cards=[card]) as h:
            device = self.setup_touch(h)
            h.controller.start("sequence")
            self.assertEqual("passed", h.events.wait("finished")["status"])
            self.assertEqual(1, device.mute.call_count)
            self.assertEqual([], card.writes)
            self.assertFalse(h.events.wait("passed")["device_written"])

    def test_wrong_card_during_rf_cycle_stops_without_advancing(self):
        with Harness(entries=(item(), item("IY-TEST-000002"))) as h:
            self.setup_touch(h)
            def wrong_card(clf, timeout, expected_id=None, ndef_only=False):
                if expected_id:
                    wrong = FakeLiteS(True).represented()
                    wrong.idm[0] ^= 1
                    worker.trial.guard_tag(wrong, expected_id)
                h.last = h.cards.pop(0)
                return h.last
            h.acquire_override = wrong_card
            h.controller.start("sequence")
            self.assertEqual("failed", h.events.wait("finished")["status"])
            self.assertEqual(item().code, h.events.wait("finished")["resume_code"])
            self.assertEqual(["reserved"], [r[2] for r in h.reservations])
            self.assertEqual(1, len([e for e in h.events.values if e["kind"] == "ready"]))

    def test_rf_failure_does_not_retry_write_or_advance(self):
        with Harness() as h:
            device = self.setup_touch(h)
            device.mute.side_effect = OSError("reader disconnected")
            h.controller.start("sequence")
            self.assertEqual("failed", h.events.wait("finished")["status"])
            self.assertEqual(1, device.mute.call_count)
            self.assertEqual(5, len(h.last.writes))
            self.assertEqual(["reserved"], [r[2] for r in h.reservations])

    def test_next_card_still_requires_previous_card_removal(self):
        with Harness(entries=(item(), item("IY-TEST-000002")), cards=cards(2)) as h:
            self.setup_touch(h)
            h.controller.start("sequence")
            self.assertEqual("passed", h.events.wait("finished")["status"])
            self.assertEqual(["remove-previous"], h.presence_prompts)

    def test_corrupted_readback_never_passes(self):
        with Harness() as h:
            self.setup_touch(h)
            def corrupt(clf, timeout, expected_id=None, ndef_only=False):
                if expected_id:
                    h.last.memory[1][3] ^= 1
                    return h.last.represented()
                h.last = h.cards.pop(0)
                return h.last
            h.acquire_override = corrupt
            h.controller.start("sequence")
            self.assertEqual("failed", h.events.wait("finished")["status"])
            self.assertEqual([], [e for e in h.events.values if e["kind"] == "passed"])


if __name__ == "__main__":
    unittest.main()
