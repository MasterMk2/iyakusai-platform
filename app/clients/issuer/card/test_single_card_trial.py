"""Offline safety checks using real nfcpy NDEF/format APIs with fake memory."""
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import single_card_trial as trial
from nfc.tag.tt3_sony import FelicaLiteS
import nfc
import ndef

IDM = "0123456789ABCDEF"


class FakeLiteS(FelicaLiteS):
    def __init__(self, formatted=False):
        self._nfcid = bytearray.fromhex(IDM)
        self.idm = self._nfcid
        self.pmm = bytearray.fromhex("00F1000000000000")
        self.sys = 0x88B4
        self._product = "FeliCa Lite-S (RC-S966)"
        self._authenticated = False
        self._ndef = None
        self.memory = {n: bytearray(16) for n in range(14)}
        self.memory[0x88] = bytearray.fromhex("FFFFFF00FF0000000000000000000000")
        self.writes = []
        self.read_from_ndef_service = self.read_without_mac
        self.write_to_ndef_service = self.write_without_mac
        if formatted:
            self.format()
            self.writes.clear()

    def read_without_mac(self, *blocks):
        return bytearray().join(self.memory[block] for block in blocks)

    def write_without_mac(self, data, block):
        self.writes.append((block, bytes(data)))
        self.memory[block] = bytearray(data)

    def polling(self, system_code=0xFFFF, request_code=0, time_slots=0):
        if system_code == 0x12FC and not self.memory[0x88][3] & 1:
            raise nfc.tag.tt3.Type3TagCommandError(nfc.tag.TIMEOUT_ERROR)
        return self.idm, self.pmm

    def represented(self):
        self._ndef = None
        self.sys = 0x12FC
        return self


class CardTrialTests(unittest.TestCase):
    def test_uri_roundtrip_retains_query_equals_and_code(self):
        raw = trial.encode_url(trial.TEST_URL)
        self.assertEqual(35, len(raw))
        self.assertEqual(trial.TEST_URL, trial.decode_url(raw))
        self.assertEqual("urn:nfc:wkt:U", list(ndef.message_decoder(raw))[0].type)

    def test_long_and_non_https_urls_refused(self):
        for url in ("http://example.com", "https://u:p@example.com", "https://example.com/空白"):
            with self.subTest(url=url), self.assertRaises(trial.TrialError):
                trial.encode_url(url)
        with self.assertRaises(trial.TrialError):
            trial.encode_url("https://example.com/" + "x" * 220)

    def test_model_and_expected_id_guards(self):
        card = FakeLiteS()
        self.assertEqual(IDM, trial.guard_tag(card, IDM))
        with self.assertRaises(trial.TrialError):
            trial.guard_tag(object(), IDM)
        card.pmm[1] = 0xF2  # Link Lite-S is intentionally excluded
        with self.assertRaises(trial.TrialError):
            trial.guard_tag(card)
        card.pmm[1] = 0xF1
        with self.assertRaises(trial.TrialError):
            trial.guard_tag(card, "0000000000000000")

    def test_inspection_does_not_write(self):
        card = FakeLiteS()
        snapshot = trial.take_snapshot(card)
        self.assertEqual([], card.writes)
        self.assertIsNone(snapshot["ndef_attributes"])
        self.assertEqual(224, len(bytes.fromhex(snapshot["user_blocks_hex"])))
        self.assertEqual(16, len(bytes.fromhex(snapshot["mc_hex"])))

    def test_format_requires_explicit_flag(self):
        snapshot = trial.take_snapshot(FakeLiteS())
        with self.assertRaises(trial.TrialError):
            trial.check_writeable(snapshot, trial.encode_url(trial.TEST_URL))
        self.assertTrue(trial.check_writeable(snapshot, trial.encode_url(trial.TEST_URL), True))

    def test_unknown_raw_data_and_zero_length_residual_are_refused(self):
        for formatted in (False, True):
            with self.subTest(formatted=formatted):
                card = FakeLiteS(formatted)
                card.memory[1][0] = 0xAB
                with self.assertRaises(trial.TrialError):
                    trial.check_writeable(trial.take_snapshot(card),
                                          trial.encode_url(trial.TEST_URL), True)
                self.assertEqual([], card.writes)

    def test_readonly_and_auth_restrictions_are_refused(self):
        for byte, value in ((0, 0xFE), (6, 1), (8, 1), (10, 1), (12, 1)):
            with self.subTest(byte=byte):
                card = FakeLiteS()
                card.memory[0x88][byte] = value
                with self.assertRaises(trial.TrialError):
                    trial.check_writeable(trial.take_snapshot(card),
                                          trial.encode_url(trial.TEST_URL), True)
                self.assertEqual([], card.writes)

    def test_malformed_attribute_bounds_before_ndef_read(self):
        card = FakeLiteS(True)
        for byte, value in ((1, 0), (3, 0xFF), (9, 0x0F), (10, 2)):
            corrupted = bytearray(card.memory[0])
            corrupted[byte] = value
            corrupted[14:] = sum(corrupted[:14]).to_bytes(2, "big")
            self.assertIsNone(trial.parse_attribute(corrupted))

    def test_real_nfcpy_format_changes_only_mc_ndef_bit_and_attribute(self):
        card = FakeLiteS()
        before = trial.take_snapshot(card)
        self.assertTrue(card.format(version=0x10, wipe=None))
        after = trial.take_snapshot(card)
        trial.check_mc_change(before, after, True)
        self.assertEqual([0x88, 0], [block for block, _ in card.writes])
        self.assertEqual(208, after["ndef_attributes"]["capacity"])

    def test_real_ndef_write_is_three_payload_blocks_and_two_attr_writes(self):
        card = FakeLiteS(True)
        payload = trial.encode_url(trial.TEST_URL)
        card.ndef.octets = payload
        snapshot = trial.take_snapshot(card, IDM)
        self.assertEqual(trial.TEST_URL,
                         trial.verify_snapshot(snapshot, IDM, payload, trial.TEST_URL))
        self.assertEqual([0, 1, 2, 3, 0], [block for block, _ in card.writes])
        self.assertEqual(0x0F, card.writes[0][1][9])
        self.assertEqual(0, card.writes[-1][1][9])

    def test_readback_must_match_bytes_and_card(self):
        card = FakeLiteS(True)
        payload = trial.encode_url(trial.TEST_URL)
        card.ndef.octets = payload
        snapshot = trial.take_snapshot(card, IDM)
        changed = dict(snapshot, idm="0000000000000000")
        with self.assertRaises(trial.TrialError):
            trial.verify_snapshot(changed, IDM, payload, trial.TEST_URL)
        changed = dict(snapshot, ndef_hex=(payload[:-1] + b"2").hex())
        with self.assertRaises(trial.TrialError):
            trial.verify_snapshot(changed, IDM, payload, trial.TEST_URL)

    def test_malformed_message_is_preserved_and_refused(self):
        card = FakeLiteS(True)
        card.memory[0][11:14] = (1).to_bytes(3, "big")
        card.memory[0][14:] = sum(card.memory[0][:14]).to_bytes(2, "big")
        card.memory[1][0] = 0xFF
        snapshot = trial.take_snapshot(card)
        self.assertEqual("FF", snapshot["ndef_hex"])
        self.assertIsNone(snapshot["urls"])
        with self.assertRaises(trial.TrialError):
            trial.check_writeable(snapshot, trial.encode_url(trial.TEST_URL), True)
        self.assertEqual([], card.writes)
    def test_protocol_write_retry_is_disabled(self):
        class FailFrontend:
            def __init__(self):
                self.calls = 0
            def exchange(self, data, timeout):
                self.calls += 1
                raise nfc.clf.TimeoutError()
        clf = FailFrontend()
        trial.disable_write_retries(clf)
        with self.assertRaises(trial.TrialError):
            clf.exchange(bytearray.fromhex("0A080000000000000000"), 0.2)
        self.assertEqual(1, clf.calls)

    def test_workflow_saves_original_before_format_and_url_write(self):
        card = FakeLiteS()
        class FakeAudit:
            def __init__(self):
                self.path = "offline://fake"
                self.events = []
                self.snapshots = []
            def snapshot(self, name, snap):
                if name == "before":
                    self.assert_no_writes = not card.writes
                self.snapshots.append(name)
            def event(self, event, **fields):
                self.events.append(event)
            def save(self, name, value):
                self.result = value
        audit = FakeAudit()
        args = SimpleNamespace(expected_id=IDM, allow_format=True, allow_overwrite=False)
        represented = []
        def reacquire(previous, idm, prompt, ndef_only):
            represented.append((idm, ndef_only))
            return previous.represented()
        result = trial.write_one(card, trial.encode_url(trial.TEST_URL),
                                 trial.TEST_URL, audit, args, reacquire)
        self.assertTrue(audit.assert_no_writes)
        self.assertEqual("passed", result["status"])
        self.assertEqual([(IDM, True), (IDM, True)], represented)
        self.assertEqual(["before", "after-format", "after-format-represent",
                          "after-write", "after-represent"], audit.snapshots)
        self.assertEqual([0x88, 0, 0, 1, 2, 3, 0], [block for block, _ in card.writes])



class PresenceTag:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = 0

    @property
    def is_present(self):
        self.calls += 1
        value = next(self.responses)
        if isinstance(value, BaseException):
            raise value
        return value


class FakeAudit:
    def __init__(self):
        self.path = "offline://fake"
        self.events = []
        self.snapshots = []
        self.result = None

    def event(self, event, **fields):
        self.events.append((event, fields))

    def snapshot(self, name, value):
        self.snapshots.append((name, value))

    def save(self, name, value):
        self.result = value


class ResumeAndRemovalTests(unittest.TestCase):
    def test_three_windows_timeout_samples_do_not_retransmit_writes(self):
        card = PresenceTag([TimeoutError(10060, "absence")] * 3)
        audit = FakeAudit()
        with patch.object(trial.time, "monotonic", return_value=0), patch.object(trial.time, "sleep"):
            result = trial.wait_removed(card, 1, audit, lambda: True)
        self.assertEqual(3, card.calls)
        self.assertEqual(3, result["no_response_samples"])
        self.assertEqual(3, result["transport_timeout_samples_10060"])
        self.assertFalse(result["physical_removal_confirmed"])
        self.assertEqual(3, len(audit.events))

    def test_present_card_resets_timeout_absence_sequence(self):
        card = PresenceTag([TimeoutError(10060, "absence"), False, True, False, False, False])
        with patch.object(trial.time, "monotonic", return_value=0), patch.object(trial.time, "sleep"):
            result = trial.wait_removed(card, 1, reader_present=lambda: True)
        self.assertEqual(6, card.calls)
        self.assertEqual(3, result["no_response_samples"])
        self.assertEqual(1, result["transport_timeout_samples_10060"])

    def test_reader_disappearing_does_not_mean_card_removed(self):
        card = PresenceTag([TimeoutError(10060, "disconnected")])
        with patch.object(trial.time, "monotonic", return_value=0), self.assertRaises(trial.TrialError):
            trial.wait_removed(card, 1, reader_present=lambda: False)
        self.assertEqual(1, card.calls)

    def test_unknown_io_error_is_not_suppressed(self):
        card = PresenceTag([OSError(5, "access denied")])
        with patch.object(trial.time, "monotonic", return_value=0), self.assertRaises(OSError):
            trial.wait_removed(card, 1, reader_present=lambda: True)
        self.assertEqual(1, card.calls)

    def test_present_card_eventually_times_out(self):
        card = PresenceTag([True, True, True])
        with patch.object(trial.time, "monotonic", side_effect=[0, 0, 0.1, 0.2, 1.1]), \
                patch.object(trial.time, "sleep"), self.assertRaises(trial.TrialError):
            trial.wait_removed(card, 1, reader_present=lambda: True)
        self.assertEqual(3, card.calls)

    def fixture(self):
        before = trial.take_snapshot(FakeLiteS())
        card = FakeLiteS(True)
        encoded = trial.encode_url(trial.TEST_URL)
        card.ndef.octets = encoded
        card.represented()
        after = trial.take_snapshot(card)
        expected = {"source": "offline://original-evidence", "before": before,
                    "after": after, "idm": IDM, "encoded": encoded,
                    "url": trial.TEST_URL, "format_performed": True}
        card.writes.clear()
        return card, expected

    def test_verify_evidence_workflow_is_read_only(self):
        card, expected = self.fixture()
        audit = FakeAudit()
        result = trial.verify_evidence_one(card, expected, audit)
        self.assertEqual([], card.writes)
        self.assertEqual("passed", result["status"])
        self.assertTrue(result["full_user_memory_equal"])
        self.assertTrue(result["memory_configuration_equal"])
        self.assertFalse(result["device_written"])

    def test_read_only_resume_requires_ndef_system(self):
        card, expected = self.fixture()
        card.sys = 0x88B4
        with self.assertRaises(trial.TrialError):
            trial.verify_evidence_one(card, expected, FakeAudit())
        self.assertEqual([], card.writes)

    def test_read_only_resume_detects_memory_outside_ndef_changed(self):
        card, expected = self.fixture()
        card.memory[13][0] ^= 1
        with self.assertRaises(trial.TrialError):
            trial.verify_evidence_one(card, expected, FakeAudit())
        self.assertEqual([], card.writes)

    def test_saved_snapshot_requires_binary_hash_integrity(self):
        card, expected = self.fixture()
        saved = expected["after"]
        user, mc = bytes.fromhex(saved["user_blocks_hex"]), bytes.fromhex(saved["mc_hex"])
        trial.validate_saved_snapshot(saved, user, mc)
        with self.assertRaises(trial.TrialError):
            trial.validate_saved_snapshot(saved, user[:-1] + bytes([user[-1] ^ 1]), mc)

    def test_cli_resume_never_routes_to_writer_or_usb(self):
        import io
        card, expected = self.fixture()
        audit = FakeAudit()
        class FakeFrontend:
            device = "Offline RC-S370"
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def exchange(self, *args):
                raise AssertionError("USB/card access forbidden in offline test")
        with patch.object(trial, "load_write_evidence", return_value=expected), \
                patch.object(trial, "Audit", return_value=audit), \
                patch("nfc.clf.transport.USB.find", return_value=[(trial.VID, trial.PID, 1, 1)]), \
                patch("nfc.ContactlessFrontend", return_value=FakeFrontend()), \
                patch.object(trial, "acquire_one", return_value=card) as acquire, \
                patch.object(trial, "write_one", side_effect=AssertionError("writer called")), \
                patch("sys.stdout", io.StringIO()):
            status = trial.main(["--verify-evidence", "offline-dummy", "--timeout", "1"])
        self.assertEqual(0, status)
        self.assertTrue(acquire.call_args.kwargs["ndef_only"])
        self.assertEqual([], card.writes)
        self.assertFalse(audit.result["device_written"])

    def test_real_saved_write_evidence_loads_without_device_access(self):
        original = trial.BASE / "evidence" / "20261012T010902-95115b15"
        if not original.exists():
            self.skipTest("2026-10-12 physical evidence is not present in this checkout")
        expected = trial.load_write_evidence(original)
        self.assertEqual("012E5CC5D78C68AD", expected["idm"])
        self.assertEqual(35, len(expected["encoded"]))
        independent = trial.BASE / "evidence" / "20261012T011126-766b2fcf"
        saved = json.loads((independent / "after-represent.json").read_text(encoding="utf-8"))
        user = (independent / "after-represent-user-blocks.bin").read_bytes()
        mc = (independent / "after-represent-mc.bin").read_bytes()
        trial.validate_saved_snapshot(saved, user, mc)
        trial.verify_snapshot(saved, expected["idm"], expected["encoded"], expected["url"])
        self.assertEqual(saved["user_sha256"], expected["after"]["user_sha256"])
        self.assertEqual(saved["mc_sha256"], expected["after"]["mc_sha256"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
