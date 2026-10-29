#!/usr/bin/env python3
"""Bounded, single RC-S966 NDEF URL trial with an RC-S370-family USB reader.

Default: read only. --dry-run: encode URL without USB access.
Only --write can modify tag memory; explicit IDm pins the one test card.
No driver installation, authentication, keys, protect(), or wipe().
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit
import uuid

BASE = Path(__file__).resolve().parent
DEPS = BASE / ".deps"
if DEPS.is_dir():
    sys.path.insert(0, str(DEPS))

READER = "usb:054c:02e1"  # RC-S330/360/370 share this ID; one confirmed RC-S370.
VID, PID = 0x054C, 0x02E1
TEST_URL = "https://example.com/?iy=IY-TEST-000001"
MAX_NDEF = 13 * 16
JST = timezone(timedelta(hours=9))


class TrialError(RuntimeError):
    pass


def stamp():
    return datetime.now(JST).isoformat(timespec="milliseconds")


class Audit:
    """Fresh evidence directory; durable event-before-write and binary backups."""
    def __init__(self, mode, url):
        name = datetime.now(JST).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
        self.path = BASE / "evidence" / name
        self.path.mkdir(parents=True, exist_ok=False)
        self.event("started", mode=mode, requested_url=url, reader=READER,
                   timezone="Asia/Tokyo", version=1)

    def event(self, event, **fields):
        record = {"time": stamp(), "event": event, **fields}
        with (self.path / "audit.jsonl").open("a", encoding="utf-8", newline="\n") as out:
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            out.flush()
            os.fsync(out.fileno())

    def save(self, name, value):
        data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self.binary(name, data)

    def binary(self, name, data):
        with (self.path / name).open("xb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())

    def snapshot(self, name, snapshot):
        self.binary(name + "-user-blocks.bin", bytes.fromhex(snapshot["user_blocks_hex"]))
        self.binary(name + "-mc.bin", bytes.fromhex(snapshot["mc_hex"]))
        self.save(name + ".json", snapshot)
        self.event("snapshot_saved", name=name,
                   user_sha256=snapshot["user_sha256"], mc_sha256=snapshot["mc_sha256"])


def validate_url(url):
    parts = urlsplit(url)
    if (parts.scheme != "https" or not parts.hostname or
            parts.username is not None or parts.password is not None or
            any(ord(c) < 33 or ord(c) > 126 for c in url)):
        raise TrialError("URL must be an ASCII HTTPS URL without credentials or whitespace.")
    # Exact string equality is checked after decoding. Percent-encode non-ASCII URLs.
    return url


def encode_url(url):
    import ndef
    validate_url(url)
    encoded = b"".join(ndef.message_encoder([ndef.UriRecord(url)]))
    if len(encoded) > MAX_NDEF:
        raise TrialError(f"NDEF needs {len(encoded)} bytes; maximum is {MAX_NDEF}. Use a shorter HTTPS URL.")
    if decode_url(encoded) != url:
        raise TrialError("NDEF encoding changed the URL; use a canonical, percent-encoded URL.")
    return encoded


def decode_url(encoded):
    import ndef
    try:
        records = list(ndef.message_decoder(encoded, errors="strict"))
    except ndef.DecodeError as error:
        raise TrialError("NDEF message is malformed.") from error
    if len(records) != 1 or not isinstance(records[0], ndef.UriRecord):
        raise TrialError("Expected exactly one NDEF URI record.")
    return records[0].iri  # Exact encoded URI; .uri may percent-escape query separators.


def guard_tag(tag, expected_id=None):
    from nfc.tag.tt3_sony import FelicaLiteS
    if not isinstance(tag, FelicaLiteS):
        raise TrialError("Refused: card is not nfcpy FelicaLiteS.")
    if len(tag.pmm) != 8 or tag.pmm[1] != 0xF1:
        raise TrialError("Refused: IC code is not 0xF1 (RC-S966).")
    idm = bytes(tag.identifier).hex().upper()
    if len(idm) != 16:
        raise TrialError("Refused: invalid IDm.")
    if expected_id and idm != expected_id:
        raise TrialError(f"Refused: different card. Expected {expected_id}, saw {idm}.")
    return idm


def parse_attribute(data):
    """Validate bounds before letting nfcpy read a potentially malformed NDEF area."""
    if len(data) != 16 or sum(data[:14]) != int.from_bytes(data[14:16], "big"):
        return None
    capacity = int.from_bytes(data[3:5], "big") * 16
    length = int.from_bytes(data[11:14], "big")
    if (data[0] != 0x10 or not 1 <= data[1] <= 4 or data[2] not in (0, 1) or
            not 16 <= capacity <= MAX_NDEF or data[9] != 0 or
            data[10] not in (0, 1) or length > capacity):
        return None
    return {"capacity": capacity, "length": length,
            "readable": True, "writeable": data[10] == 1 and data[2] == 1}


def take_snapshot(tag, expected_id=None):
    idm = guard_tag(tag, expected_id)
    blocks = []
    # RC-S966 S_PAD0..S_PAD13. Never touch REG (block 14), keys or random challenge.
    for block in range(14):
        data = bytes(tag.read_without_mac(block))
        if len(data) != 16:
            raise TrialError(f"Refused: short read of block {block}.")
        blocks.append(data)
    mc = bytes(tag.read_without_mac(0x88))
    if len(mc) != 16:
        raise TrialError("Refused: short memory configuration read.")
    user = b"".join(blocks)
    attributes = parse_attribute(blocks[0]) if mc[3] & 1 else None
    message = b"".join(blocks[1:])[:attributes["length"]] if attributes else None
    urls = None
    if message:
        try:
            urls = [decode_url(message)]
        except (TrialError, ValueError):
            urls = None
    return {"idm": idm, "pmm_hex": bytes(tag.pmm).hex().upper(),
            "product": tag.product, "mc_hex": mc.hex().upper(),
            "user_blocks_hex": user.hex().upper(),
            "user_sha256": hashlib.sha256(user).hexdigest(),
            "mc_sha256": hashlib.sha256(mc).hexdigest(),
            "ndef_attributes": attributes,
            "ndef_hex": message.hex().upper() if message is not None else None,
            "urls": urls, "time": stamp()}


def check_writeable(snapshot, encoded, allow_format=False, allow_overwrite=False):
    mc = bytes.fromhex(snapshot["mc_hex"])
    user = bytes.fromhex(snapshot["user_blocks_hex"])
    # This trial deliberately accepts only unprotected user memory.
    if int.from_bytes(mc[:2], "little") & 0x3FFF != 0x3FFF:
        raise TrialError("Refused: user memory is partly read-only.")
    if any(mc[6:13]):
        raise TrialError("Refused: authentication/MAC restrictions are configured; trial does not change them.")
    attrs = snapshot["ndef_attributes"]
    if attrs:
        if not attrs["writeable"]:
            raise TrialError("Refused: NDEF management block is read-only.")
        if len(encoded) > attrs["capacity"]:
            raise TrialError("Refused: NDEF exceeds this card's current capacity.")
        # Residual data count as occupied even when the NDEF length is zero.
        occupied = attrs["length"] > 0 or any(user[16:])
    else:
        occupied = any(user)
        if not allow_format:
            raise TrialError("No valid NDEF mapping. --allow-format is required for a blank test card.")
        if not mc[3] & 1 and mc[2] != 0xFF:
            raise TrialError("Refused: NDEF compatibility cannot be enabled on this locked card.")
    if occupied and not allow_overwrite:
        raise TrialError("Refused: card contains existing or residual data. No overwrite was performed.")
    return attrs is None


def check_mc_change(before, after, formatted):
    old = bytes.fromhex(before["mc_hex"])
    actual = bytes.fromhex(after["mc_hex"])
    expected = bytearray(old)
    if formatted:
        expected[3] |= 1
    if actual != bytes(expected):
        raise TrialError("Memory configuration changed outside the NDEF compatibility bit. Stop and retain evidence.")


def verify_snapshot(snapshot, original_id, encoded, url):
    if snapshot["idm"] != original_id:
        raise TrialError("Readback card IDm mismatch.")
    attrs = snapshot["ndef_attributes"]
    if not attrs or snapshot["ndef_hex"] is None:
        raise TrialError("No valid NDEF mapping at readback.")
    actual = bytes.fromhex(snapshot["ndef_hex"])
    if actual != encoded:
        raise TrialError("NDEF bytes differ from the requested encoded URI.")
    actual_url = decode_url(actual)
    if actual_url != url:
        raise TrialError("Decoded readback URL differs from the requested URL.")
    return actual_url


def disable_write_retries(clf):
    """nfcpy retries Type 3 CommunicationError three times; stop write retransmission."""
    import nfc
    exchange = clf.exchange
    def once(data, timeout):
        try:
            return exchange(data, timeout)
        except nfc.clf.CommunicationError as error:
            if len(data) >= 2 and data[1] == 0x08:
                # A non-CommunicationError escapes nfcpy's retry loop immediately.
                raise TrialError("Write response failed; command was not retransmitted. Inspect evidence.") from error
            raise
    clf.exchange = once


def acquire_one(clf, timeout, expected_id=None, ndef_only=False):
    deadline = time.monotonic() + timeout

    def startup(targets):
        # Search FeliCa only. Wildcard supports unformatted 0x88B4 Lite-S;
        # independent verification after write polls ONLY NFC Forum system 0x12FC.
        request = bytes.fromhex("0012FC0100" if ndef_only else "00FFFF0100")
        for target in targets:
            target.sensf_req = bytearray(request)
        return targets

    tag = clf.connect(rdwr={"targets": ["212F"],
                            "on-startup": startup, "on-connect": lambda tag: False,
                            "iterations": 2, "interval": 0.2, "beep-on-connect": False},
                      terminate=lambda: time.monotonic() >= deadline)
    if tag is None or tag is False:
        raise TrialError("Card wait timed out; no card was processed.")
    guard_tag(tag, expected_id)
    if ndef_only and tag.sys != 0x12FC:
        raise TrialError("Refused: readback did not activate NFC Forum system 0x12FC.")
    return tag


def wait_removed(tag, timeout, audit=None, reader_present=None):
    """Wait for three consecutive no-card observations, never for one USB timeout."""
    print("REMOVE this card completely from the reader, then wait for the next prompt.", flush=True)
    deadline = time.monotonic() + timeout
    absent = 0
    timeout_samples = 0
    while time.monotonic() < deadline:
        try:
            present = tag.is_present
        except OSError as error:
            # Windows libusb/RCS956 sometimes leaks WSAETIMEDOUT instead of
            # nfc.tag.TIMEOUT_ERROR while a card is being removed. Do not treat
            # access errors, arbitrary I/O errors or reader removal as card absence.
            if getattr(error, "errno", None) != 10060 and getattr(error, "winerror", None) != 10060:
                raise
            if reader_present is not None and not reader_present():
                raise TrialError("Reader disappeared during removal wait; card absence is unconfirmed.") from error
            present = False
            timeout_samples += 1
            if audit:
                audit.event("presence_timeout_10060", candidate_absence=True,
                            sample=timeout_samples, physical_removal_confirmed=False)
        if present:
            absent = 0
        else:
            absent += 1
        if absent >= 3:
            # This means no NFC response, not proof of physical movement.
            # A fresh acquisition still pins IDm and NDEF system before any next write.
            return {"no_response_samples": absent,
                    "transport_timeout_samples_10060": timeout_samples,
                    "physical_removal_confirmed": False}
        time.sleep(0.2)
    raise TrialError("Removal wait timed out; card was not reprocessed.")


def write_one(tag, encoded, url, audit, args, reacquire):
    before = take_snapshot(tag, args.expected_id)
    audit.snapshot("before", before)
    needs_format = check_writeable(before, encoded, args.allow_format, args.allow_overwrite)
    idm = before["idm"]
    # All safety checks and durable original data exist BEFORE any tag write.
    audit.event("write_plan", idm=idm, ndef_bytes=len(encoded),
                ndef_sha256=hashlib.sha256(encoded).hexdigest(),
                format_required=needs_format, overwrite_enabled=args.allow_overwrite)
    if needs_format:
        audit.event("format_started", blocks=[0, "0x88 (NDEF bit only)"], wipe=False)
        if tag.format(version=0x10, wipe=None) is not True:
            raise TrialError("NDEF formatting failed. Retain the original backup; no automatic retry.")
        formatted = take_snapshot(tag, idm)
        audit.snapshot("after-format", formatted)
        check_mc_change(before, formatted, True)
        # MC changes are activated after power-up. Remove and re-present before NDEF use.
        tag = reacquire(tag, idm, "Format complete. Re-present the SAME card to write its URL.", True)
        ready = take_snapshot(tag, idm)
        audit.snapshot("after-format-represent", ready)
        check_mc_change(before, ready, True)
        check_writeable(ready, encoded, False, args.allow_overwrite)
    elif not before["ndef_attributes"]["readable"]:
        raise TrialError("Refused: NDEF is not readable.")

    ndef_area = tag.ndef
    if ndef_area is None or not ndef_area.is_writeable or len(encoded) > ndef_area.capacity:
        raise TrialError("Refused: nfcpy cannot confirm a writable NDEF area.")
    # Write once. No loop, retries, protect(), authenticate(), or key operations.
    audit.event("url_write_started", idm=idm)
    ndef_area.octets = encoded
    immediate = take_snapshot(tag, idm)
    audit.snapshot("after-write", immediate)
    check_mc_change(before, immediate, needs_format)
    verify_snapshot(immediate, idm, encoded, url)
    audit.event("immediate_readback_passed", idm=idm)

    tag = reacquire(tag, idm, "URL written. Re-present the SAME card for independent readback.", True)
    final = take_snapshot(tag, idm)
    audit.snapshot("after-represent", final)
    check_mc_change(before, final, needs_format)
    decoded = verify_snapshot(final, idm, encoded, url)
    result = {"status": "passed", "time": stamp(), "idm": idm,
              "url": decoded, "ndef_bytes": len(encoded), "same_card": True,
              "bytes_equal": True, "url_equal": True, "ndef_system_12fc": True,
              "format_performed": needs_format, "one_card_only": True,
              "evidence": str(audit.path)}
    audit.save("result.json", result)
    audit.event("trial_passed", **result)
    return result


def validate_saved_snapshot(snapshot, user_binary, mc_binary):
    """Confirm JSON and durable binary backup agree, without touching any device."""
    if len(user_binary) != 224 or len(mc_binary) != 16:
        raise TrialError("Evidence backup lengths are invalid.")
    if (snapshot.get("user_blocks_hex") != user_binary.hex().upper() or
            snapshot.get("mc_hex") != mc_binary.hex().upper() or
            snapshot.get("user_sha256") != hashlib.sha256(user_binary).hexdigest() or
            snapshot.get("mc_sha256") != hashlib.sha256(mc_binary).hexdigest()):
        raise TrialError("Evidence backup hash or bytes do not match its snapshot.")
    if not re.fullmatch(r"[0-9A-F]{16}", snapshot.get("idm", "")):
        raise TrialError("Evidence has an invalid card IDm.")
    try:
        pmm = bytes.fromhex(snapshot["pmm_hex"])
    except (KeyError, ValueError, TypeError) as error:
        raise TrialError("Evidence has invalid PMm.") from error
    if len(pmm) != 8 or pmm[1] != 0xF1:
        raise TrialError("Evidence does not identify an RC-S966.")
    mc = bytes(mc_binary)
    attributes = parse_attribute(user_binary[:16]) if mc[3] & 1 else None
    message = user_binary[16:][:attributes["length"]] if attributes else None
    message_hex = message.hex().upper() if message is not None else None
    if snapshot.get("ndef_attributes") != attributes or snapshot.get("ndef_hex") != message_hex:
        raise TrialError("Evidence NDEF metadata disagrees with its raw memory.")
    return snapshot


def load_write_evidence(value):
    """Only resume independent readback after a recorded immediate write verification."""
    source = Path(value).resolve(strict=True)
    evidence_root = (BASE / "evidence").resolve()
    try:
        source.relative_to(evidence_root)
    except ValueError as error:
        raise TrialError("--verify-evidence must point to a directory under card/evidence.") from error
    if not source.is_dir():
        raise TrialError("--verify-evidence must be an evidence directory.")

    audit_file = source / "audit.jsonl"
    if audit_file.stat().st_size > 1024 * 1024:
        raise TrialError("Evidence audit is unexpectedly large.")
    events = [json.loads(line) for line in audit_file.read_text(encoding="utf-8").splitlines() if line]
    starts = [event for event in events if event.get("event") == "started"]
    plans = [event for event in events if event.get("event") == "write_plan"]
    immediate = [event for event in events if event.get("event") == "immediate_readback_passed"]
    writes = [event for event in events if event.get("event") == "url_write_started"]
    if (len(starts) != 1 or len(plans) != 1 or len(immediate) != 1 or len(writes) != 1 or
            starts[0].get("mode") != "write" or starts[0].get("reader") != READER):
        raise TrialError("Evidence does not record one completed URL write with immediate readback.")
    url = validate_url(starts[0]["requested_url"])
    encoded = encode_url(url)
    def snapshot(name):
        file = source / (name + ".json")
        if file.stat().st_size > 16 * 1024:
            raise TrialError("Evidence snapshot is unexpectedly large.")
        saved = json.loads(file.read_text(encoding="utf-8"))
        return validate_saved_snapshot(saved, (source / (name + "-user-blocks.bin")).read_bytes(),
                                       (source / (name + "-mc.bin")).read_bytes())
    before, after = snapshot("before"), snapshot("after-write")
    idm = before["idm"]
    plan = plans[0]
    if (after["idm"] != idm or plan.get("idm") != idm or
            immediate[0].get("idm") != idm or writes[0].get("idm") != idm or
            plan.get("ndef_bytes") != len(encoded) or
            plan.get("ndef_sha256") != hashlib.sha256(encoded).hexdigest() or
            type(plan.get("format_required")) is not bool or
            type(plan.get("overwrite_enabled")) is not bool):
        raise TrialError("Evidence card IDm, write plan or URL encoding is inconsistent.")
    required = check_writeable(before, encoded, True, plan["overwrite_enabled"])
    if required != plan["format_required"]:
        raise TrialError("Evidence format plan disagrees with the original memory.")
    check_mc_change(before, after, plan["format_required"])
    verify_snapshot(after, idm, encoded, url)
    return {"source": str(source), "before": before, "after": after,
            "idm": idm, "encoded": encoded, "url": url,
            "format_performed": plan["format_required"]}


def verify_evidence_one(tag, expected, audit):
    """Read-only completion: never call format(), NDEF setters or write_one()."""
    if tag.sys != 0x12FC:
        raise TrialError("Read-only verification requires NFC Forum system 0x12FC.")
    snapshot = take_snapshot(tag, expected["idm"])
    audit.snapshot("after-represent", snapshot)
    verify_snapshot(snapshot, expected["idm"], expected["encoded"], expected["url"])
    check_mc_change(expected["before"], snapshot, expected["format_performed"])
    if snapshot["user_sha256"] != expected["after"]["user_sha256"]:
        raise TrialError("Full user memory changed since the immediately verified write.")
    if snapshot["mc_sha256"] != expected["after"]["mc_sha256"]:
        raise TrialError("Memory configuration changed since the immediately verified write.")
    result = {"status": "passed", "mode": "verify-evidence", "time": stamp(),
              "idm": expected["idm"], "url": expected["url"],
              "ndef_bytes": len(expected["encoded"]), "same_card": True,
              "bytes_equal": True, "url_equal": True, "ndef_system_12fc": True,
              "full_user_memory_equal": True, "memory_configuration_equal": True,
              "device_written": False, "linked_write_evidence": expected["source"],
              "evidence": str(audit.path)}
    audit.save("result.json", result)
    audit.event("independent_readback_passed", **result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Encode URL only; no USB/card access")
    mode.add_argument("--write", action="store_true", help="Write to one explicitly identified test card")
    mode.add_argument("--verify-evidence", metavar="DIR", help="Read-only completion against a previous completed-write evidence directory")
    parser.add_argument("--url", default=TEST_URL)
    parser.add_argument("--expected-id", help="16 hex IDm from the prior read-only inspection; required for write")
    parser.add_argument("--allow-format", action="store_true", help="Allow blank card NDEF mapping (MC NDEF bit + block 0)")
    parser.add_argument("--allow-overwrite", action="store_true", help="Separately authorized replacement of nonempty card")
    parser.add_argument("--timeout", type=float, default=45.0, help="Seconds per presentation/removal wait (max 60)")
    args = parser.parse_args(argv)
    if args.expected_id:
        args.expected_id = args.expected_id.upper()
        if not re.fullmatch(r"[0-9A-F]{16}", args.expected_id):
            parser.error("--expected-id must contain 16 hexadecimal characters")
    if args.write and not args.expected_id:
        parser.error("--write requires --expected-id from a prior read-only inspection")
    if (args.allow_format or args.allow_overwrite) and not args.write:
        parser.error("--allow-format/--allow-overwrite require --write")
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout must be between 1 and 60 seconds")
    mode_name = "verify-evidence" if args.verify_evidence else "dry-run" if args.dry_run else "write" if args.write else "inspect"
    audit = None
    try:
        expected = load_write_evidence(args.verify_evidence) if args.verify_evidence else None
        if expected:
            if args.expected_id and args.expected_id != expected["idm"]:
                raise TrialError("--expected-id conflicts with the prior write evidence.")
            if any(x == "--url" or x.startswith("--url=") for x in (argv if argv is not None else sys.argv[1:])) and args.url != expected["url"]:
                raise TrialError("--url conflicts with the prior write evidence.")
            args.expected_id, args.url = expected["idm"], expected["url"]
        encoded = encode_url(args.url)
        audit = Audit(mode_name, args.url)
        if expected:
            audit.event("linked_write_evidence", path=expected["source"], device_written=False)
        versions = {name: importlib.metadata.version(name)
                    for name in ("nfcpy", "ndeflib", "libusb1")}
        audit.event("runtime", python=sys.version, packages=versions)
        if versions["nfcpy"] != "1.0.4":
            raise TrialError("Refused: nfcpy must be the reviewed version 1.0.4.")
        if args.dry_run:
            result = {"status": "dry-run", "url": args.url, "ndef_bytes": len(encoded),
                      "ndef_hex": encoded.hex().upper(), "payload_blocks": math.ceil(len(encoded) / 16),
                      "maximum_ndef_bytes": MAX_NDEF, "device_accessed": False,
                      "evidence": str(audit.path)}
            audit.save("result.json", result)
            audit.event("dry_run_passed", **result)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        import nfc
        from nfc.clf.transport import USB
        readers = USB.find(READER) or []
        audit.event("usb_match_count", count=len(readers), devices=readers)
        if len(readers) != 1:
            raise TrialError(f"Refused: require exactly one RC-S370-family USB device, found {len(readers)}.")
        # Filter has identified one exact VID/PID; no broad USB/serial search.
        with nfc.ContactlessFrontend(READER) as clf:
            disable_write_retries(clf)
            audit.event("reader_opened", reader_description=str(clf.device))
            print(f"Present ONLY the one RC-S966 test card ({mode_name}).", flush=True)
            tag = acquire_one(clf, args.timeout, args.expected_id, ndef_only=bool(expected))
            if args.write:
                def reacquire(previous, idm, prompt, ndef_only):
                    absence = wait_removed(previous, args.timeout, audit,
                                           lambda: len(USB.find(READER) or []) == 1)
                    audit.event("card_not_detected", idm=idm, **absence)
                    print(prompt, flush=True)
                    next_tag = acquire_one(clf, args.timeout, idm, ndef_only)
                    audit.event("same_card_represented", idm=idm)
                    return next_tag
                result = write_one(tag, encoded, args.url, audit, args, reacquire)
            elif expected:
                result = verify_evidence_one(tag, expected, audit)
            else:
                snapshot = take_snapshot(tag, args.expected_id)
                audit.snapshot("inspect", snapshot)
                try:
                    formatting_needed = check_writeable(snapshot, encoded, True, False)
                    writable = True
                    reason = None
                except TrialError as error:
                    writable, formatting_needed, reason = False, None, str(error)
                result = {"status": "inspected", "idm": snapshot["idm"],
                          "product": snapshot["product"], "pmm_hex": snapshot["pmm_hex"],
                          "existing_urls": snapshot["urls"],
                          "blank_test_eligible": writable,
                          "format_required": formatting_needed,
                          "refusal_reason": reason,
                          "device_written": False, "evidence": str(audit.path)}
                audit.save("result.json", result)
                audit.event("inspect_complete", **result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except KeyboardInterrupt:
        error = "Interrupted. No automatic retry; inspect saved evidence before continuing."
    except Exception as caught:
        error = f"{type(caught).__name__}: {caught}"
    if audit:
        audit.event("failed", error=error)
        audit.save("failure.json", {"status": "failed", "time": stamp(),
                                   "error": error, "evidence": str(audit.path),
                                   "retry_performed": False})
        print(f"Evidence: {audit.path}", file=sys.stderr)
    print(error, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
