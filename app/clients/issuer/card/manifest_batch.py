#!/usr/bin/env python3
"""Windows card issuance from a frozen printed-label manifest. Default is preview.

--run --manual: input the code from the attached label for each card.
--run --sequence: use the manifest's printed order; next code only after PASS.
Never generates a URL independently or retries a write. Nonempty memory is overwritten
only in the forced mode of the Windows app, after a person confirms each card.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlsplit
import uuid

import single_card_trial as trial

FORMAT = "rental-label-issuance-v1"
CODE = re.compile(r"IY-[A-Z0-9][A-Z0-9-]{2,39}\Z")
REGISTRY = trial.BASE / "issuance_registry.jsonl"
LOCK = trial.BASE / "issuance_batch.lock"


@dataclass(frozen=True)
class Item:
    code: str
    name: str
    url: str
    encoded: bytes


@dataclass(frozen=True)
class Manifest:
    source: Path
    pdf: Path
    raw: bytes
    sha256: str
    pdf_sha256: str
    items: tuple[Item, ...]
    ledger_generation: int = 0


def item_url_references(url):
    parts = urlsplit(url)
    query = parse_qs(parts.query, keep_blank_values=True)
    refs = query.get("item", []) + query.get("iy", [])
    match = re.fullmatch(r"/i/([^/]+)/?", parts.path)
    if match:
        refs.append(unquote(match.group(1)))
    return refs


def load_manifest(path):
    source = Path(path).resolve(strict=True)
    if not source.name.endswith(".issuance.json") or source.stat().st_size > 16 * 1024 * 1024:
        raise trial.TrialError("Select the printed PDF's .issuance.json sidecar (maximum 16 MiB).")
    raw = source.read_bytes()
    obj = json.loads(raw.decode("utf-8-sig"))
    if (not isinstance(obj, dict) or obj.get("format") != FORMAT or
            obj.get("label_mm") != [91, 55] or obj.get("page") != "A4"):
        raise trial.TrialError("Unsupported label issuance format; require rental-label-issuance-v1 A4 91x55 mm.")
    entries = obj.get("items")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 10000:
        raise trial.TrialError("Manifest must contain 1..10000 items.")
    pdf_hash = obj.get("pdf_sha256")
    if not isinstance(pdf_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", pdf_hash):
        raise trial.TrialError("Manifest has no valid PDF SHA256.")
    pdf = source.with_name(source.name[:-len(".issuance.json")] + ".pdf")
    if not pdf.is_file() or hashlib.sha256(pdf.read_bytes()).hexdigest() != pdf_hash:
        raise trial.TrialError("The paired printed-label PDF is missing or differs from the manifest hash.")
    items, seen = [], set()
    for entry in entries:
        if not isinstance(entry, dict) or not all(isinstance(entry.get(k), str) for k in ("code", "name", "url")):
            raise trial.TrialError("Every item must have exact string code/name/url fields.")
        code, name, url = entry["code"], entry["name"], entry["url"]
        if not CODE.fullmatch(code) or code in seen:
            raise trial.TrialError(f"Invalid or duplicated code: {code!r}")
        if name != name.strip() or not 1 <= len(name) <= 160 or any(ord(c) < 32 for c in name):
            raise trial.TrialError(f"Invalid item name: {code}")
        trial.validate_url(url)
        if len(url.encode("ascii")) > 180:
            raise trial.TrialError(f"URL exceeds the label format's 180-byte limit: {code}")
        refs = item_url_references(url)
        if not refs or any(ref != code for ref in refs):
            raise trial.TrialError(f"Label code and URL reference disagree: {code}")
        encoded = trial.encode_url(url)
        seen.add(code)
        items.append(Item(code, name, url, encoded))
    generation = obj.get('ledger_generation', 0)
    if type(generation) is not int or generation < 0:
        raise trial.TrialError('Invalid ledger generation in manifest.')
    return Manifest(source, pdf, raw, hashlib.sha256(raw).hexdigest(), pdf_hash, tuple(items), generation)


class Lease:
    """Exclusive batch writer; never delete another owner's lock or a stale lock."""
    def __init__(self):
        self.owner = uuid.uuid4().hex
        self.owned = False

    def __enter__(self):
        try:
            with LOCK.open("x", encoding="utf-8") as out:
                out.write(json.dumps({"owner": self.owner, "pid": os.getpid(), "time": trial.stamp()}))
                out.flush()
                os.fsync(out.fileno())
            self.owned = True
        except FileExistsError as error:
            raise trial.TrialError("Another batch or stale issuance_batch.lock exists. Stop; never auto-remove it.") from error
        return self

    def __exit__(self, *args):
        # Resolve and check the absolute target before removing only our own file.
        if (self.owned and LOCK.resolve().parent == trial.BASE.resolve() and
                json.loads(LOCK.read_text(encoding="utf-8")).get("owner") == self.owner):
            LOCK.unlink()


def registry_indexes(raw):
    """Validate an exact history snapshot using the same guards as live issuance."""
    if len(raw) > 32 * 1024 * 1024:
        raise trial.TrialError("Registry exceeds its reviewed size limit.")
    by_id, by_code = {}, {}
    for line in raw.decode("utf-8").splitlines():
        if not line:
            continue
        entry = json.loads(line)
        if (not isinstance(entry, dict) or not re.fullmatch(r"[0-9A-F]{16}", entry.get("idm", "")) or
                not CODE.fullmatch(entry.get("code", "")) or
                entry.get("status") not in ("reserved", "passed", "released")):
            raise trial.TrialError("Registry has an invalid entry; do not skip it.")
        trial.validate_url(entry["url"])
        idm, code = entry["idm"], entry["code"]
        if entry["status"] == "released":
            # A confirmed forced overwrite ended this card/code binding; later lines may bind them anew.
            for index, key in ((by_id, idm), (by_code, code)):
                current = index.get(key)
                if current and (current["idm"], current["code"], current["url"]) == (idm, code, entry["url"]):
                    del index[key]
            continue
        for previous in (by_id.get(idm), by_code.get(code)):
            if previous and (previous["idm"], previous["code"], previous["url"]) != (idm, code, entry["url"]):
                raise trial.TrialError("Registry bindings conflict; stop before card access.")
        by_id[idm] = by_code[code] = entry
    return by_id, by_code


def load_registry():
    return registry_indexes(REGISTRY.read_bytes() if REGISTRY.exists() else b"")


def registry_event(item, idm, status, manifest, evidence):
    entry = {"time": trial.stamp(), "idm": idm, "code": item.code, "url": item.url,
             "status": status, "manifest_sha256": manifest.sha256,
             "pdf_sha256": manifest.pdf_sha256, "evidence": str(evidence)}
    with REGISTRY.open("a", encoding="utf-8", newline="\n") as out:
        out.write(json.dumps(entry, ensure_ascii=False) + "\n")
        out.flush()
        os.fsync(out.fileno())
    return entry


def registry_release(idm, code, url, reason, evidence):
    """Records that a binding ended (forced overwrite). Older tools reject this status, so
    after the first forced overwrite only this version of the issuer can read the registry."""
    entry = {"time": trial.stamp(), "idm": idm, "code": code, "url": url,
             "status": "released", "reason": reason, "evidence": str(evidence)}
    with REGISTRY.open("a", encoding="utf-8", newline="\n") as out:
        out.write(json.dumps(entry, ensure_ascii=False) + "\n")
        out.flush()
        os.fsync(out.fileno())
    return entry


def card_occupied(snapshot):
    """Same rule as single_card_trial.check_writeable: any NDEF content or residual user data."""
    user = bytes.fromhex(snapshot["user_blocks_hex"])
    attrs = snapshot["ndef_attributes"]
    return bool(attrs["length"] > 0 or any(user[16:])) if attrs else any(user)


def force_plan(item, snapshot, by_id, by_code):
    """Forced mode: what writing this item to this card would replace, for a person to confirm.

    Returns ("verify-existing" | "write-blank" | "force-write", conflicts). Protected, locked or too
    small cards are refused here exactly as in the normal mode; forcing only replaces content.
    """
    idm = snapshot["idm"]
    conflicts = []
    card = by_id.get(idm)
    if card and (card["code"], card["url"]) != (item.code, item.url):
        conflicts.append({"kind": "card_bound", "code": card["code"], "url": card["url"], "status": card["status"]})
    other = by_code.get(item.code)
    if other and (other["idm"], other["url"]) != (idm, item.url):
        conflicts.append({"kind": "code_bound", "idm": other["idm"], "url": other["url"], "status": other["status"]})
    same_binding = card if card and (card["code"], card["url"]) == (item.code, item.url) else None
    same_url = snapshot["ndef_hex"] == item.encoded.hex().upper()
    if same_url and not conflicts:
        trial.verify_snapshot(snapshot, idm, item.encoded, item.url)
        return "verify-existing", []
    trial.check_writeable(snapshot, item.encoded, allow_format=True, allow_overwrite=True)
    if same_binding:
        # Reserved earlier but never verified: the normal mode refuses to repeat that write.
        conflicts.append({"kind": "prior_reservation", "code": item.code, "url": item.url, "status": same_binding["status"]})
    if not conflicts and not card_occupied(snapshot):
        return "write-blank", []
    return "force-write", conflicts


def check_binding(item, snapshot, by_id, by_code):
    idm = snapshot["idm"]
    for previous in (by_id.get(idm), by_code.get(item.code)):
        if previous and (previous["idm"], previous["code"], previous["url"]) != (idm, item.code, item.url):
            raise trial.TrialError(f"Card/code already belongs to a different item: {idm} / {item.code}.")
    same_url = snapshot["ndef_hex"] == item.encoded.hex().upper()
    if same_url:
        trial.verify_snapshot(snapshot, idm, item.encoded, item.url)
        return "verify-existing"
    if idm in by_id or item.code in by_code:
        raise trial.TrialError("This card/code has a prior reservation but no exact verified URL. Never repeat its write automatically.")
    trial.check_writeable(snapshot, item.encoded, allow_format=True, allow_overwrite=False)
    return "write-blank"


def verify_existing(tag, initial, item, audit, reacquire):
    idm = initial["idm"]
    audit.snapshot("before-existing", initial)
    tag = reacquire(tag, idm, "Already has this exact URL. Re-present the SAME card for read-only verification.", True)
    final = trial.take_snapshot(tag, idm)
    audit.snapshot("after-represent", final)
    trial.verify_snapshot(final, idm, item.encoded, item.url)
    trial.check_mc_change(initial, final, False)
    if tag.sys != 0x12FC or final["user_sha256"] != initial["user_sha256"]:
        raise trial.TrialError("Existing-card independent readback or full memory comparison failed.")
    result = {"status": "passed", "mode": "verify-existing", "time": trial.stamp(),
              "idm": idm, "code": item.code, "url": item.url, "same_card": True,
              "bytes_equal": True, "url_equal": True, "ndef_system_12fc": True,
              "device_written": False, "evidence": str(audit.path)}
    audit.save("result.json", result)
    audit.event("existing_card_readback_passed", **result)
    return result


def process_item(tag, item, manifest, batch_audit, index, total, by_id, by_code, timeout, acquire, reader_present, prompt_callback=None,
                 confirm_overwrite=None, reactivate=None):
    """A single item. Failures propagate; no retries and no next-code update.

    confirm_overwrite (forced mode only) receives the card's current content and the bindings a
    write would replace, and returns True only when this card may be overwritten: a person confirmed
    it, or the person chose beforehand not to be asked (the function then has automatic=True).
    """
    initial = trial.take_snapshot(tag)
    if confirm_overwrite is None:
        action, conflicts = check_binding(item, initial, by_id, by_code), []
    else:
        action, conflicts = force_plan(item, initial, by_id, by_code)
    audit = trial.Audit("verify-existing" if action == "verify-existing" else "write", item.url)
    audit.event("label_binding", code=item.code, name=item.name, index=index, total=total,
                manifest_sha256=manifest.sha256, pdf_sha256=manifest.pdf_sha256,
                batch_evidence=str(batch_audit.path), action=action, idm=initial["idm"])
    if action == "force-write":
        details = {"idm": initial["idm"], "code": item.code, "name": item.name, "url": item.url,
                   "existing_urls": list(initial.get("urls") or []), "occupied": card_occupied(initial),
                   "conflicts": conflicts}
        # The replaced content stays in the evidence (full user memory and NDEF of this card).
        audit.snapshot("before-overwrite", initial)
        audit.event("overwrite_requested", **details)
        if not confirm_overwrite(details):
            audit.event("overwrite_declined", device_written=False)
            raise trial.TrialError("上書きを取り消しました。このカードには書き込んでいません。")
        audit.event("overwrite_confirmed", automatic=bool(getattr(confirm_overwrite, "automatic", False)))
    latest = [tag]
    def reacquire(previous, idm, prompt, ndef_only):
        if reactivate is not None:
            # A fresh RF activation still pins the original IDm and 0x12FC.
            # Never replace independent readback with the cached tag object.
            new_tag = reactivate(previous, idm, prompt, ndef_only)
            latest[0] = new_tag
            audit.event("same_card_reactivated", idm=idm, method="rf-field-cycle")
            return new_tag
        if prompt_callback:
            prompt_callback("remove", "カードを完全に離し、次の案内を待ってください。")
        absence = trial.wait_removed(previous, timeout, audit, reader_present)
        audit.event("card_not_detected", idm=idm, **absence)
        if prompt_callback:
            prompt_callback("represent", prompt)
        else:
            print(f"{item.code}: {prompt}", flush=True)
        new_tag = acquire(timeout, idm, ndef_only)
        latest[0] = new_tag
        audit.event("same_card_represented", idm=idm)
        return new_tag
    try:
        if action in ("write-blank", "force-write"):
            if action == "force-write":
                # End the replaced bindings first, so the registry never holds two bindings for one card or code.
                for conflict in conflicts:
                    old_idm = conflict.get("idm", initial["idm"])
                    old_code = conflict.get("code", item.code)
                    registry_release(old_idm, old_code, conflict["url"], f"forced-overwrite:{conflict['kind']}", audit.path)
                    for index_, key in ((by_id, old_idm), (by_code, old_code)):
                        current = index_.get(key)
                        if current and (current["idm"], current["code"]) == (old_idm, old_code):
                            del index_[key]
            # Reserve BEFORE any card write. Even a partial write keeps this reservation.
            entry = registry_event(item, initial["idm"], "reserved", manifest, audit.path)
            by_id[initial["idm"]] = by_code[item.code] = entry
            args = SimpleNamespace(expected_id=initial["idm"], allow_format=True, allow_overwrite=action == "force-write")
            result = trial.write_one(tag, item.encoded, item.url, audit, args, reacquire)
            result["device_written"] = True
            result["code"] = item.code
        else:
            result = verify_existing(tag, initial, item, audit, reacquire)
        if result["status"] != "passed":
            raise trial.TrialError("The item did not pass; sequence was not advanced.")
        audit.save("binding-result.json", dict(result, manifest_sha256=manifest.sha256, pdf_sha256=manifest.pdf_sha256))
        entry = registry_event(item, initial["idm"], "passed", manifest, audit.path)
        by_id[initial["idm"]] = by_code[item.code] = entry
        batch_audit.event("item_passed", code=item.code, idm=initial["idm"], index=index,
                          device_written=result["device_written"], card_evidence=str(audit.path),
                          forced=action == "force-write")
        return result, latest[0]
    except BaseException as error:
        audit.event("failed", error=f"{type(error).__name__}: {error}", sequence_advanced=False)
        audit.save("failure.json", {"status": "failed", "time": trial.stamp(), "code": item.code,
                                   "idm": initial["idm"], "error": str(error),
                                   "automatic_retry": False, "sequence_advanced": False})
        batch_audit.event("item_failed", code=item.code, idm=initial["idm"], index=index,
                          card_evidence=str(audit.path), sequence_advanced=False)
        raise


def select_sequence(items, start_code=None):
    if not start_code:
        return items
    for index, item in enumerate(items):
        if item.code == start_code:
            return items[index:]
    raise trial.TrialError("--start-code is absent from the frozen label manifest.")


def run_items(items, mode, process, acquire, wait_between, batch_audit, input_code=input):
    """Human code entry in manual mode; printed order in sequence mode; advance after PASS."""
    by_code = {item.code: item for item in items}
    completed, previous, current = {}, None, None
    sequence = iter(items)
    try:
        while True:
            if mode == "manual":
                value = input_code("貼り付けたラベルの個体コード（空欄/EXITで終了）: ").strip()
                if not value or value.upper() in ("EXIT", "QUIT"):
                    break
                if value not in by_code:
                    print("未登録のコードです。このラベル一覧にあるコードを入力してください。", flush=True)
                    continue
                if value in completed:
                    print("この回ですでに確認済みです。再書込みはしません。", flush=True)
                    continue
                current = by_code[value]
            else:
                current = next(sequence, None)
                if current is None:
                    break
            print(f"READY {len(completed) + 1}/{len(items)}  {current.code}  {current.name}", flush=True)
            if previous is not None:
                wait_between(previous)
            tag = acquire()
            result, verified_tag = process(tag, current, len(completed) + 1)
            if result.get("status") != "passed":
                raise trial.TrialError("No PASS result. Batch stopped at the current code.")
            completed[current.code] = result["idm"]
            previous = verified_tag
            print(f"PASS  {current.code}  {result['idm']}  {'read-only' if not result['device_written'] else 'written'}", flush=True)
        result = {"status": "passed" if len(completed) == len(items) else "stopped-by-operator",
                  "mode": mode, "time": trial.stamp(), "verified_items": len(completed),
                  "manifest_items": len(items), "completed_codes": completed,
                  "evidence": str(batch_audit.path)}
        batch_audit.save("batch-result.json", result)
        batch_audit.event("batch_complete", **result)
        return result
    except BaseException as error:
        failure = {"status": "failed", "mode": mode, "time": trial.stamp(),
                   "failed_code": current.code if current else None,
                   "verified_items": len(completed), "completed_codes": completed,
                   "sequence_advanced": False, "automatic_retry": False,
                   "error": f"{type(error).__name__}: {error}", "evidence": str(batch_audit.path)}
        batch_audit.save("batch-failure.json", failure)
        batch_audit.event("batch_failed", **failure)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--issuance-json", required=True, help="Paired PDF .issuance.json sidecar")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--manual", action="store_true", help="Input each attached label's code")
    mode.add_argument("--sequence", action="store_true", help="Auto-next in the printed manifest order, only after PASS")
    parser.add_argument("--run", action="store_true", help="Explicitly enable hardware batch operations")
    parser.add_argument("--start-code", help="Sequence only: begin at this existing manifest code")
    parser.add_argument("--timeout", type=float, default=45)
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 60 or (args.manual and args.start_code):
        parser.error("Use timeout 1..60; --start-code is for sequence mode only.")
    audit = None
    try:
        manifest = load_manifest(args.issuance_json)
        items = select_sequence(manifest.items, args.start_code)
        selected_mode = "manual" if args.manual else "sequence"
        audit = trial.Audit("batch-run" if args.run else "batch-preview", f"manifest-sha256:{manifest.sha256}")
        audit.binary("frozen.issuance.json", manifest.raw)
        audit.event("frozen_manifest", source=str(manifest.source), pdf=str(manifest.pdf),
                    manifest_sha256=manifest.sha256, pdf_sha256=manifest.pdf_sha256,
                    items=len(items), mode=selected_mode, start_code=args.start_code)
        if not args.run:
            result = {"status": "preview", "mode": selected_mode, "device_accessed": False,
                      "manifest_items": len(items), "source": str(manifest.source), "pdf": str(manifest.pdf),
                      "manifest_sha256": manifest.sha256, "pdf_sha256": manifest.pdf_sha256,
                      "preview": [{"code": x.code, "name": x.name, "url": x.url,
                                   "ndef_bytes": len(x.encoded)} for x in items[:10]],
                      "preview_omitted": max(0, len(items) - 10), "evidence": str(audit.path)}
            audit.save("preview.json", result)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        print("連続発行を開始します。連番は印刷順に貼付、手入力は貼付済みラベルのコードを入力してください。", flush=True)
        print("RC-S370は1台、読取範囲内のRC-S966は1枚だけにしてください。エラー時は停止し、書込みを自動再試行しません。", flush=True)
        import nfc
        from nfc.clf.transport import USB
        if trial.importlib.metadata.version("nfcpy") != "1.0.4":
            raise trial.TrialError("Refused: use the reviewed nfcpy 1.0.4.")
        with Lease():
            by_id, by_code = load_registry()
            if len(USB.find(trial.READER) or []) != 1:
                raise trial.TrialError("Require exactly one RC-S370-family reader.")
            with nfc.ContactlessFrontend(trial.READER) as clf:
                trial.disable_write_retries(clf)
                audit.event("reader_opened", reader_description=str(clf.device))
                def acquire(timeout=args.timeout, expected_id=None, ndef_only=False):
                    return trial.acquire_one(clf, timeout, expected_id, ndef_only)
                def reader_present():
                    return len(USB.find(trial.READER) or []) == 1
                def between(previous):
                    absence = trial.wait_removed(previous, args.timeout, audit, reader_present)
                    audit.event("previous_card_not_detected", **absence)
                def process(tag, item, index):
                    return process_item(tag, item, manifest, audit, index, len(items),
                                        by_id, by_code, args.timeout, acquire, reader_present)
                result = run_items(items, selected_mode, process, acquire, between, audit)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        if audit:
            audit.event("command_failed", error=f"{type(error).__name__}: {error}", automatic_retry=False)
            print(f"Evidence: {audit.path}", file=sys.stderr)
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
