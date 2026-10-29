"""No semantic selection of ordinary LINE messages or normal attachments.

Only concrete credential evidence and technical failures
hold a verified sender's new message. Local screening has finite coverage;
images, speech and unsupported encodings cannot be proven sensitive-data-free.
No external LLM receives source bodies or files.
"""
from dataclasses import dataclass, replace
import hashlib
import io
from pathlib import Path
import re
import struct
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

from oa_relay import Plan, render_parts

POLICY_VERSION = "ordinary_content_v3_redacted"
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ARCHIVE_INSPECTION_BYTES = 40 * 1024 * 1024
DANGEROUS_EXTENSIONS = frozenset({".exe", ".dll", ".bat", ".cmd", ".ps1", ".js", ".html", ".htm", ".svg", ".scr", ".com", ".jar", ".docm", ".xlsm", ".pptm"})

# Generic words such as login, password, hospital, health, address or a name
# are not enough. We look for actual credential values.
PATTERNS = (
    ("credential_material", r"-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE)|"
        r"(?i:\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{15,}|AKIA[A-Z0-9]{16})\b)|"
        r"(?i:\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|authorization)[\"']?\s*[:=]\s*[\"']?[^\s\"'<>&]{1,})|"
        r"(?i:\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{12,})|"
        r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b|"
        r"(?:パスワード|暗証番号|認証コード|ワンタイムコード|APIキー)(?:\s*(?:[:=：]|は)\s*)[A-Za-z0-9_+/=!@#$%*-]{3,}|"
        r"(?i:https?://)[^\s/@:]+:[^\s/@]{3,}@"),

)
COMPILED = tuple((code, re.compile(pattern)) for code, pattern in PATTERNS)
HARD_REVIEW_BLOCKS = frozenset({"credential_material",
    "unsafe_attachment_type", "attachment_changed"})


@dataclass(frozen=True)
class Decision:
    allowed: bool
    codes: tuple[str, ...]
    coverage: str = "available_text_only"


def inspection_text(text: str) -> str:
    # Inspect through common zero-width obfuscation without discarding ordinary
    # emoji/ZWJ sequences from the actual forwarded message.
    normal = unicodedata.normalize("NFKC", text)
    return "".join(c for c in normal if unicodedata.category(c) != "Cf")


def suspicion_codes(text: str) -> tuple[str, ...]:
    normal = inspection_text(text)
    codes = []
    if any(unicodedata.category(c) == "Cs" or
           (unicodedata.category(c) == "Cc" and c not in "\t\r\n") for c in text):
        codes.append("invalid_body_characters")
    codes += [code for code, expression in COMPILED if expression.search(normal)]
    return tuple(codes)


def screen_text(text: str, *, require_operations: bool = False, context: str = "") -> Decision:
    # Backwards-compatible keyword is deliberately ignored: no operations
    # context/length/phrase requirement remains in this policy.
    if not isinstance(text, str) or not text.strip():
        return Decision(False, ("empty_content",))
    codes = suspicion_codes(text)
    return Decision(not codes, codes or ("ordinary_text_no_content_selection",))


def _archive_text(data: bytes, suffix: str):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            items = archive.infolist()
            if len(items) > 2000 or sum(x.file_size for x in items) > MAX_ARCHIVE_INSPECTION_BYTES:
                return None, "archive_over_inspection_limit"
            texts = []
            for item in items:
                name = item.filename.replace("\\", "/")
                if name.startswith("/") or ".." in name.split("/") or item.flag_bits & 1:
                    return None, "archive_path_or_encryption_invalid"
                if Path(name).suffix.lower() in DANGEROUS_EXTENSIONS or "vbaProject.bin" in name or "/activeX/" in name:
                    return None, "unsafe_attachment_type"
                if item.is_dir():
                    continue
                member = archive.read(item)
                if name.endswith((".txt", ".csv", ".json", ".md", ".xml", ".rels")):
                    try:
                        value = member.decode("utf-8-sig")
                    except UnicodeDecodeError:
                        continue
                    if name.endswith((".xml", ".rels")):
                        try:
                            tree = ET.fromstring(value)
                            value = "".join(tree.itertext()) + "\n" + "\n".join(v for node in tree.iter() for v in node.attrib.values())
                        except ET.ParseError:
                            return None, "archive_document_xml_invalid"
                    texts.append(value)
            if suffix in {".docx", ".xlsx", ".pptx"}:
                needed = {".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml"}[suffix]
                if needed not in archive.namelist() or "[Content_Types].xml" not in archive.namelist():
                    return None, "office_container_invalid"
            return "\n".join(texts), None
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError):
        return None, "archive_invalid"


def _ordinary_format(data: bytes, attachment):
    """Returns available local text and coverage, or a technical error code."""
    suffix = Path(attachment.name).suffix.lower()
    mime = getattr(attachment, "content_type", "application/octet-stream").split(";", 1)[0].lower()
    if suffix in DANGEROUS_EXTENSIONS or data.startswith((b"MZ", b"\x7fELF")):
        return None, None, "unsafe_attachment_type"
    text_suffix = suffix in {".txt", ".csv", ".md", ".json", ".log"}
    if mime.startswith("text/") or text_suffix:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                text = data.decode("cp932")
            except UnicodeDecodeError:
                return None, None, "text_encoding_unrecognized"
        if "\x00" in text:
            return None, None, "text_attachment_contains_binary"
        if text_suffix and mime not in {"text/plain", "text/csv", "text/markdown", "text/x-log", "application/json", "application/csv", "application/octet-stream"}:
            return None, None, "attachment_mime_mismatch"
        return text, "complete_text_bytes", None
    if data.startswith(b"PK\x03\x04"):
        if not mime.startswith("application/"):
            return None, None, "attachment_mime_mismatch"
        text, issue = _archive_text(data, suffix)
        return text, "archive_available_text", issue
    if suffix in {".zip", ".docx", ".xlsx", ".pptx"}:
        return None, None, "archive_magic_mismatch"
    actual = None
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(data) < 45 or data[12:16] != b"IHDR" or not data.endswith(b"IEND\xaeB`\x82"):
            return None, None, "image_structure_invalid"
        width, height = struct.unpack(">II", data[16:24])
        if not 0 < width * height <= 100000000:
            return None, None, "image_dimensions_invalid"
        actual = "image/png"
    elif data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
        actual = "image/jpeg"
    elif data.startswith((b"GIF87a", b"GIF89a")) and len(data) >= 14 and data.endswith(b";"):
        actual = "image/gif"
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        actual = "image/webp"
    elif data.startswith(b"BM") and len(data) >= 54:
        actual = "image/bmp"
    elif data.startswith((b"II*\x00", b"MM\x00*")) and len(data) >= 8:
        actual = "image/tiff"
    elif data.startswith(b"%PDF-") and b"%%EOF" in data[-1024:]:
        if mime not in {"application/pdf", "application/octet-stream"}:
            return None, None, "attachment_mime_mismatch"
        if b"/Encrypt" in data:
            return None, None, "encrypted_pdf_requires_private_review"
        # Existing optional local parser only; no installs/network/LLM route.
        try:
            from pypdf import PdfReader
        except ImportError:
            return data.decode("utf-8", errors="ignore"), "pdf_binary_strings_only_no_ocr", None
        try:
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted or len(reader.pages) > 300:
                return None, None, "pdf_encrypted_or_over_page_limit"
            return "\n".join(page.extract_text() or "" for page in reader.pages), "pdf_extractable_text_only_no_ocr", None
        except Exception:
            return None, None, "pdf_parser_rejected"
    elif len(data) > 12 and data[4:8] == b"ftyp":
        actual = "audio/mp4" if mime.startswith("audio/") else "video/mp4"
    elif data.startswith(b"ID3") or data[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
        actual = "audio/mpeg"
    elif data.startswith(b"OggS"):
        actual = "audio/ogg"
    elif data.startswith(b"fLaC"):
        actual = "audio/flac"
    elif data[:2] in {b"\xff\xf1", b"\xff\xf9"}:
        actual = "audio/aac"
    elif data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        actual = "audio/wav"
    elif data.startswith(b"\x1aE\xdf\xa3"):
        actual = "video/webm"
    if actual:
        if mime != "application/octet-stream" and mime.split("/", 1)[0] != actual.split("/", 1)[0]:
            return None, None, "attachment_mime_mismatch"
        return data.decode("utf-8", errors="ignore"), "binary_strings_only_no_ocr_or_speech", None
    # Plain files sent with octet-stream are still ordinary text when complete
    # decoding succeeds. Arbitrary unknown binary is a technical exception.
    if mime == "application/octet-stream":
        try:
            text = data.decode("utf-8-sig")
            if "\x00" not in text:
                return text, "complete_text_bytes", None
        except UnicodeDecodeError:
            pass
    return None, None, "unrecognized_binary_format"


def inspect_attachment(attachment, *, context: str = "") -> Decision:
    codes = suspicion_codes(attachment.name + "\n" + context)
    if codes:
        return Decision(False, codes)
    if not 0 < attachment.size <= MAX_ATTACHMENT_BYTES:
        return Decision(False, ("attachment_size_invalid",))
    try:
        data = attachment.path.read_bytes()
    except OSError:
        return Decision(False, ("attachment_unavailable",))
    if len(data) != attachment.size or hashlib.sha256(data).hexdigest() != attachment.sha256:
        return Decision(False, ("attachment_changed",))
    text, coverage, issue = _ordinary_format(data, attachment)
    if issue:
        return Decision(False, (issue,))
    # Binary Unicode controls are not meaningful prose. Inspect available
    # decoded strings for sensitive evidence, not their binary control bytes.
    codes = suspicion_codes(text) if coverage == "complete_text_bytes" else tuple(
        code for code in suspicion_codes(text or "") if code != "invalid_body_characters")
    if codes:
        return Decision(False, codes, coverage)
    return Decision(True, ("ordinary_attachment_no_content_selection",), coverage)


def screen_plan(plan: Plan) -> Decision:
    if plan.disposition != "planned":
        return Decision(False, (plan.reason or "not_ready",))
    if not plan.parts:
        return Decision(False, ("no_forwardable_parts",))
    for part in plan.parts:
        decision = screen_text(part.content)
        if not decision.allowed:
            return decision
        if part.attachment:
            decision = inspect_attachment(part.attachment)
            if not decision.allowed:
                return decision
    return Decision(True, ("outgoing_content_guard_checked",))


def prepare_outgoing(plan: Plan, *, force_attachment_issue=None) -> Plan:
    """Preserve ordinary text. Redact protected spans; hold only unsafe media."""
    if plan.disposition != "planned":
        return plan
    from redaction import redact_text, ORIGINAL_GUIDANCE
    event = plan.event
    redaction = redact_text(event.text)
    attachment = next((p.attachment for p in plan.parts if p.attachment), None)
    issue = force_attachment_issue or plan.attachment_issue
    if attachment and not issue:
        decision = inspect_attachment(attachment)
        if not decision.allowed:
            issue = ",".join(decision.codes)
    if issue:
        attachment = None
    if event.event_type == "unsend":
        body = "[LINEで送信取消。元の投稿は自動削除しません。]"
    elif event.kind == "text":
        body = redaction.text or "[空のテキスト]"
    elif event.kind == "sticker":
        body = "[スタンプ]"
    elif event.kind == "location":
        body = "[位置情報]\n" + redaction.text
        if event.extra.get("latitude") is not None and event.extra.get("longitude") is not None:
            import math
            lat, lon = event.extra["latitude"], event.extra["longitude"]
            if type(lat) in {int, float} and type(lon) in {int, float} and math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
                body += f"\n緯度: {lat} / 経度: {lon}"
            else:
                body += "\n[位置の値は形式確認待ちです]\n" + ORIGINAL_GUIDANCE
    else:
        body = "[" + (event.kind or "添付") + "]"
        if redaction.text:
            body += "\n" + redaction.text
    if issue:
        body += "\n[添付1件を保留しました。確認できる担当者は原文をご覧ください。]"
    if redaction.spans_redacted or issue:
        body += "\n" + ORIGINAL_GUIDANCE
    reason = "redacted:" + ",".join(redaction.codes) if redaction.spans_redacted else None
    return replace(plan, reason=reason, parts=render_parts(event, body, attachment), attachment_issue=issue)
