"""Asynchronous, exclusive FeliCa writer for the native Windows GUI.

Only start() enables device access. emit(dict) runs on the worker thread and must
queue GUI updates. Non-daemon workers finish an active write/readback before exit.
All card mutation and guards remain in the reviewed card/manifest_batch module.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from pathlib import Path
import json
import os
import queue
import re
import sys
import threading
import time
import tempfile

CARD_DIR = Path(__file__).resolve().parents[1] / "card"
if str(CARD_DIR) not in sys.path:
    sys.path.insert(0, str(CARD_DIR))
import manifest_batch as batch
import single_card_trial as trial


def overwrite_text(details):
    """What a forced overwrite would replace, in words for the person at the reader."""
    lines = [f"このカード（IDm 末尾 {details['idm'][-4:]}）は空ではないか、別の物品に割り当て済みです。"]
    urls = details.get("existing_urls") or []
    if urls:
        lines += ["今カードに入っているURL:"] + [f"  {url}" for url in urls]
    elif details.get("occupied"):
        lines.append("今カードには URL 以外のデータ（消し残り）が入っています。")
    for conflict in details.get("conflicts", []):
        if conflict["kind"] == "card_bound":
            lines.append(f"発行台帳ではこのカードは {conflict['code']} に割り当て済みです。上書きすると、その割り当てを外します。")
        elif conflict["kind"] == "code_bound":
            lines.append(f"{details['code']} は別のカード（IDm 末尾 {conflict['idm'][-4:]}）に書込み済みです。上書きすると、そのカードの割り当てを外します（そのカードは回収してください）。")
        elif conflict["kind"] == "prior_reservation":
            lines.append("前回この組み合わせで書き込んだとき、読み戻しを確認できていません。書込みをやり直します。")
    lines += ["", f"書き込む内容: {details['code']} {details.get('name', '')}", f"  {details['url']}", "",
              "上書きしますか？ 上書き前の中身は証跡に残ります。"]
    return "\n".join(lines)


def overwrite_summary(details):
    """One log line for an overwrite made without asking (the "no confirmation" option)."""
    urls = details.get("existing_urls") or []
    before = "、".join(urls) if urls else ("URL 以外のデータ（消し残り）" if details.get("occupied") else "割り当てのみ")
    line = f"確認なしで上書き: IDm 末尾 {details['idm'][-4:]} の {before} → {details['code']} {details.get('name', '')}".rstrip()
    for conflict in details.get("conflicts", []):
        if conflict["kind"] == "card_bound":
            line += f"／{conflict['code']} への割り当てを外しました"
        elif conflict["kind"] == "code_bound":
            line += f"／別のカード（IDm 末尾 {conflict['idm'][-4:]}）の割り当てを外しました。そのカードは回収してください"
    return line


class _Stopped(Exception):
    """Operator stopped while no item write/readback was active."""


class SequenceProgress:
    """Local resume hint, never an issuance registry or permission to overwrite."""
    def __init__(self, folder, manifest):
        self.manifest = manifest
        self.path = Path(folder) / (manifest.sha256 + ".json")
        self.identity = {"format": "iyakusai-issuer-progress-v1", "manifest_sha256": manifest.sha256,
                         "pdf_sha256": manifest.pdf_sha256,
                         "ledger_generation": getattr(manifest, "ledger_generation", 0)}

    def read(self):
        if not self.path.exists():
            return {"next_code": None, "passed_codes": []}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            codes = {item.code for item in self.manifest.items}
            if (any(data.get(key) != value for key, value in self.identity.items()) or
                    not isinstance(data.get("passed_codes"), list) or
                    any(not isinstance(code, str) or code not in codes for code in data["passed_codes"]) or
                    (data.get("next_code") is not None and data["next_code"] not in codes)):
                raise ValueError("progress does not match the label manifest")
            return data
        except (ValueError, TypeError, AttributeError) as error:
            raise trial.TrialError("保存した再開位置を確認できません。発行履歴内の書込み進捗を確認してください。") from error

    def save(self, next_code, passed_codes):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = dict(self.identity, next_code=next_code, passed_codes=sorted(passed_codes))
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                             prefix=".progress-", delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()


class _InterruptiblePresence:
    def __init__(self, tag, check_stop):
        self.tag, self.check_stop = tag, check_stop

    @property
    def is_present(self):
        self.check_stop()
        result = self.tag.is_present
        self.check_stop()
        return result


def resolve_manual_input(value, manifest):
    """Accept a listed code, its short number (123 for IY-100123) or the EXACT listed QR URL; never synthesize a URL."""
    if not isinstance(value, str):
        raise trial.TrialError("個体コードまたはQRのURLを入力してください。")
    value = value.strip()
    if re.fullmatch(r"IR-[0-9]{6}", value, re.IGNORECASE):
        value = "IY-" + value.upper()
    if not value or len(value) > 2048 or any(ord(c) < 32 for c in value):
        raise trial.TrialError("個体コードまたはQRのURLを入力してください。")
    short = re.fullmatch(r"(?:NO\.?\s*)?(\d{1,5})", value, re.IGNORECASE)
    if short and int(short.group(1)):
        value = f"IY-{100000 + int(short.group(1))}"
    elif re.fullmatch(r"1\d{5}", value):
        value = f"IY-{value}"
    if value.startswith("https://"):
        matches = [item for item in manifest.items if item.url == value]
    else:
        matches = [item for item in manifest.items if item.code == value.upper()]
    if len(matches) != 1:
        raise trial.TrialError("この印刷済みラベル一覧にないコード・QRです。入力を確認してください。")
    return matches[0]


class WriterController:
    """GUI API: start, submit_code, stop, running. No Tk dependency.

    Events always have kind/text. Optional fields include code/name/index/total,
    stage, fatal, status, idm, device_written, evidence, verified_items.
    start returns immediately; a running controller refuses a second start.
    submit_code returns whether accepted. Input is accepted only while the
    manual prompt is waiting, so scan-ahead cannot select the wrong next card.
    With force_overwrite, a nonempty or already bound card raises a "confirm" event
    (details: idm, existing_urls, conflicts) and waits for answer_overwrite(True/False).
    With confirm_each=False as well, such a card is overwritten without asking; each one is
    still announced as a "status" event and recorded in the evidence as an automatic approval.
    """
    def __init__(self, manifest_path, emit, force_overwrite=False, confirm_each=True, server_history=None,
                 progress_folder=None, single_touch=False):
        if not callable(emit):
            raise TypeError("emit must be callable")
        self.server_history = server_history
        self.progress_folder = progress_folder
        self.single_touch = bool(single_touch)
        self._resume_code = None
        self.manifest_path = Path(manifest_path)
        self.force_overwrite = bool(force_overwrite)
        self.confirm_each = bool(confirm_each) or not self.force_overwrite
        self._answers = queue.Queue(maxsize=1)
        self._awaiting_answer = False
        self._emit_callback = emit
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._queue = queue.Queue(maxsize=1)
        self._running = False
        self._accepting_code = False
        self._in_item = False
        self._thread = None
        self._mode = None
        self._clf = None
        self._usb = None
        self._current = None
        self._index = 0
        self._total = 0
        self._timeout = 45.0

    @property
    def running(self):
        with self._lock:
            return self._running

    def _emit(self, kind, text, **fields):
        event = {"kind": kind, "text": text, **fields}
        # A UI callback failure must not interrupt a write or erase its evidence.
        try:
            self._emit_callback(event)
        except Exception:
            self._stop_event.set()

    def start(self, mode="manual", start_code=None):
        if mode not in ("manual", "sequence") or (mode == "manual" and start_code is not None):
            raise ValueError("mode must be manual/sequence; start_code is sequence-only")
        with self._lock:
            if self._running:
                raise RuntimeError("カード発行はすでに実行中です。")
            self._running = True
            self._accepting_code = False
            self._in_item = False
            self._mode = mode
            self._current = None
            self._index = self._total = 0
            self._stop_event.clear()
            while not self._queue.empty():
                self._queue.get_nowait()
            self._thread = threading.Thread(target=self._run, args=(mode, start_code),
                                            name="FeliCa-issuance", daemon=False)
            self._thread.start()

    def submit_code(self, value):
        with self._lock:
            if (not self._running or self._mode != "manual" or
                    not self._accepting_code or self._stop_event.is_set()):
                return False
            try:
                self._queue.put_nowait(value)
            except queue.Full:
                return False
            self._accepting_code = False
            return True

    def answer_overwrite(self, accepted):
        """The person's decision for the card shown in the last "confirm" event."""
        with self._lock:
            if not self._awaiting_answer:
                return False
            self._awaiting_answer = False
        try:
            self._answers.put_nowait(bool(accepted))
        except queue.Full:
            return False
        return True

    def _confirm_overwrite(self, details):
        while not self._answers.empty():
            self._answers.get_nowait()
        with self._lock:
            self._awaiting_answer = True
        self._emit("confirm", overwrite_text(details), stage="confirm-overwrite", details=details, **self._fields())
        try:
            while True:
                # Stopping while the question is open means "do not overwrite".
                if self._stop_event.is_set():
                    return False
                try:
                    return self._answers.get(timeout=0.1)
                except queue.Empty:
                    continue
        finally:
            with self._lock:
                self._awaiting_answer = False

    def _auto_overwrite(self, details):
        # Stopping still means "do not overwrite" for the card on the reader.
        if self._stop_event.is_set():
            return False
        self._emit("status", overwrite_summary(details), stage="auto-overwrite", details=details, **self._fields())
        return True

    _auto_overwrite.automatic = True

    def stop(self):
        self._stop_event.set()
        with self._lock:
            active = self._running
            writing = self._in_item
            self._accepting_code = False
        if active:
            self._emit("status", "現在のカードの検証後に停止します。次の物品には進みません。" if writing
                       else "停止しています。カードへの書込みは開始しません。", stopping=True)

    def _check_stop(self):
        if self._stop_event.is_set():
            raise _Stopped()

    def _overwrite_approver(self):
        if not self.force_overwrite:
            return None
        return self._confirm_overwrite if self.confirm_each else self._auto_overwrite

    def _fields(self):
        fields = {"index": self._index, "total": self._total}
        if self._current:
            fields.update(code=self._current.code, name=self._current.name)
        return fields

    def _manual_next(self, manifest, completed):
        while True:
            self._check_stop()
            with self._lock:
                self._accepting_code = True
            self._emit("prompt", "貼り付けたラベルのコードを入力し、Enterを押してください。QRスキャナのURLも使えます。",
                       stage="input", index=len(completed) + 1, total=self._total)
            while True:
                self._check_stop()
                try:
                    value = self._queue.get(timeout=0.1)
                    break
                except queue.Empty:
                    continue
            try:
                item = resolve_manual_input(value, manifest)
                if item.code in completed:
                    self._emit("status", "この回では確認済みです。次のラベルを入力してください。", code=item.code)
                    continue
                return item
            except trial.TrialError as error:
                self._emit("error", str(error), fatal=False, stage="input")

    def _prompt(self, stage, source_text):
        if stage == "remove":
            text = "同じカードを読取機から完全に離し、次の案内を待ってください。"
        elif source_text.startswith("Format complete."):
            text = "初期化できました。今離した同じカードを置いてください。URLを書き込みます。"
        elif source_text.startswith("Already has this exact URL."):
            text = "同じURLが入っています。今離した同じカードを置いてください。読取専用で確認します。"
        else:
            text = "URLを書き込みました。今離した同じカードを置いてください。読み戻しを確認します。"
        self._emit("prompt", text, stage=stage, **self._fields())

    @contextmanager
    def _open_reader(self, audit):
        import nfc
        from nfc.clf.transport import USB
        if trial.importlib.metadata.version("nfcpy") != "1.0.4":
            raise trial.TrialError("検証済みのnfcpy 1.0.4を使用してください。")
        if len(USB.find(trial.READER) or []) != 1:
            raise trial.TrialError("RC-S370を1台だけ接続してください。0台・複数台では発行できません。")
        with nfc.ContactlessFrontend(trial.READER) as clf:
            self._clf, self._usb = clf, USB
            trial.disable_write_retries(clf)
            audit.event("reader_opened", reader_description=str(clf.device), interface="native-gui")
            self._emit("status", "RC-S370に接続しました。読取範囲内のカードは1枚だけにしてください。")
            try:
                yield clf
            finally:
                self._clf = self._usb = None

    def _reader_present(self):
        # Before an item starts, cancellation may interrupt a removal wait.
        if not self._in_item:
            self._check_stop()
        return len(self._usb.find(trial.READER) or []) == 1

    def _acquire(self, timeout=None, expected_id=None, ndef_only=False):
        timeout = self._timeout if timeout is None else timeout
        if self._in_item:
            # Never cancel a partial write/re-presentation/verification midway.
            return trial.acquire_one(self._clf, timeout, expected_id, ndef_only)
        deadline = time.monotonic() + timeout
        while True:
            self._check_stop()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise trial.TrialError("カード待ちが時間切れになりました。次の個体コードには進んでいません。")
            try:
                tag = trial.acquire_one(self._clf, min(1.0, remaining), expected_id, ndef_only)
            except trial.TrialError as error:
                # Only a no-card read-only polling timeout may be retried here.
                # Wrong model/IDm/system and other errors immediately stop.
                if str(error) != "Card wait timed out; no card was processed.":
                    raise
                self._check_stop()
                continue
            self._check_stop()
            return tag

    def _wait_previous(self, tag, audit):
        self._emit("prompt", "確認済みのカードを完全に離してください。次のカードは次の案内で置いてください。",
                   stage="remove-previous", **self._fields())
        absence = trial.wait_removed(_InterruptiblePresence(tag, self._check_stop), self._timeout,
                                     audit, self._reader_present)
        audit.event("previous_card_not_detected", **absence)
        self._check_stop()

    def _reactivate(self, previous, idm, prompt, ndef_only):
        self._emit("prompt", "カードを動かさず、そのままお待ちください。再接続して内容を確認しています。",
                   stage="keep-still", **self._fields())
        # nfcpy 1.0.4's RC-S370/PN53x driver mute() disables its RF field.
        # Reconnect creates a fresh tag/NDEF cache and activates 0x12FC.
        # A failure propagates: no format or write command is retransmitted.
        self._clf.device.mute()
        time.sleep(0.25)
        return self._acquire(self._timeout, idm, ndef_only)

    def _run(self, mode, start_code):
        audit = None
        completed = {}
        progress = None
        saved_passed = set()
        self._resume_code = start_code
        status, error_text = "stopped", None
        try:
            self._emit("status", "印刷済みPDFとラベル一覧の一致を確認しています。")
            manifest = batch.load_manifest(self.manifest_path)
            if self.server_history and getattr(manifest, 'ledger_generation', 0) != getattr(getattr(self.server_history, 'client', None), "ledger_generation", 0):
                raise trial.TrialError("番号を含む初期化前の書込み用データです。サーバーから読み直し、新しいラベルとデータを作成してください。")
            items = batch.select_sequence(manifest.items, start_code) if mode == "sequence" else manifest.items
            if mode == "sequence" and self.progress_folder is not None:
                progress = SequenceProgress(self.progress_folder, manifest)
                saved_passed = set(progress.read()["passed_codes"])
            self._total = len(items)
            self._check_stop()
            audit = trial.Audit("desktop-batch", f"manifest-sha256:{manifest.sha256}")
            audit.binary("frozen.issuance.json", manifest.raw)
            audit.event("frozen_manifest", source=str(manifest.source), pdf=str(manifest.pdf),
                        manifest_sha256=manifest.sha256, pdf_sha256=manifest.pdf_sha256,
                        items=self._total, mode=mode, start_code=start_code, interface="native-gui",
                        force_overwrite=self.force_overwrite, confirm_each=self.confirm_each)
            self._check_stop()
            with batch.Lease():
                by_id, by_code = batch.load_registry()
                self._check_stop()
                with self._open_reader(audit):
                    previous = None
                    sequence = iter(items)
                    while True:
                        self._check_stop()
                        if len(completed) == len(items):
                            status = "passed"
                            break
                        item = self._manual_next(manifest, completed) if mode == "manual" else next(sequence)
                        self._current, self._index = item, len(completed) + 1
                        self._resume_code = item.code
                        if progress:
                            progress.save(item.code, saved_passed)
                        self._emit("ready", "表示された個体コードのラベルを貼ってください。", **self._fields())
                        if previous is not None:
                            self._wait_previous(previous, audit)
                        self._emit("prompt", "このラベルを貼ったカードを1枚置いてください。", stage="place", **self._fields())
                        tag = self._acquire()
                        # Stop and entering an item are serialized. Once active,
                        # stop waits for completion/failure and prevents NEXT.
                        with self._lock:
                            self._check_stop()
                            self._in_item = True
                        try:
                            coordination = (self.server_history.item(tag, item, manifest, self.force_overwrite)
                                            if self.server_history else nullcontext((by_id, by_code)))
                            with coordination as (by_id, by_code):
                                result, verified_tag = batch.process_item(
                                    tag, item, manifest, audit, self._index, self._total,
                                    by_id, by_code, self._timeout, self._acquire,
                                    self._reader_present, prompt_callback=self._prompt,
                                    confirm_overwrite=self._overwrite_approver(),
                                    reactivate=self._reactivate if self.single_touch else None)
                        finally:
                            with self._lock:
                                self._in_item = False
                        if result.get("status") != "passed":
                            raise trial.TrialError("読み戻しのPASSを確認できませんでした。次のコードには進みません。")
                        completed[item.code] = result["idm"]
                        if mode == "sequence":
                            self._resume_code = items[len(completed)].code if len(completed) < len(items) else None
                            saved_passed.add(item.code)
                            if progress:
                                progress.save(self._resume_code, saved_passed)
                        previous = verified_tag
                        self._emit("passed", "書込みと読み戻しを確認しました。" if result["device_written"]
                                   else "既存の同じURLを読取専用で確認しました。",
                                   idm=result["idm"], device_written=result["device_written"],
                                   evidence=result.get("evidence"), **self._fields())
            # The reader and lease are closed before the finished event.
        except _Stopped:
            status = "stopped"
        except BaseException as error:
            status = "failed"
            error_text = f"{type(error).__name__}: {error}"
            if audit:
                try:
                    audit.save("batch-failure.json", {"status": status, "mode": mode, "time": trial.stamp(),
                               "failed_code": self._current.code if self._current else None,
                               "verified_items": len(completed), "completed_codes": completed,
                               "sequence_advanced": False, "automatic_retry": False,
                               "error": error_text, "evidence": str(audit.path)})
                    audit.event("batch_failed", error=error_text, automatic_retry=False, sequence_advanced=False)
                except Exception as audit_error:
                    error_text += "\n失敗証跡も保存できませんでした: " + str(audit_error)
            self._emit("error", "発行を停止しました。次の個体コードには進みません。\n" + error_text,
                       fatal=True, evidence=str(audit.path) if audit else None, **self._fields())
        finally:
            try:
                if audit and status != "failed":
                    result = {"status": status, "mode": mode, "time": trial.stamp(),
                              "verified_items": len(completed), "manifest_items": self._total,
                              "completed_codes": completed, "evidence": str(audit.path)}
                    audit.save("batch-result.json", result)
                    audit.event("batch_complete", **result)
            except Exception as error:
                status = "failed"
                self._emit("error", "終了証跡を保存できませんでした。\n" + str(error), fatal=True)
            with self._lock:
                self._running = False
                self._accepting_code = False
                self._in_item = False
            self._emit("finished", "一覧の発行が完了しました。" if status == "passed" else
                       "発行を停止しました。" if status == "stopped" else "エラーで停止しました。",
                       status=status, verified_items=len(completed), total=self._total,
                       resume_code=self._resume_code if mode == "sequence" else None,
                       evidence=str(audit.path) if audit else None)
