"""candidate_proofs.py

人間が個別確認・具体承認した追加団体候補について、原文参照(reference)と
送信者(sender)の対応を検証する純粋関数。

- stdlib のみ。ファイル / ネットワーク / 外部 API は使用しない。
- 所属の推測・転送は行わない。検証のみ。
- 例外は CandidateProofError(ValueError) で、メッセージは固定コードのみ。
  団体名・UID・本文・参照キーは例外に含めない。
- 全検証が通るまで結果を返さない（部分結果なし）。入力は変更しない。
"""

import hashlib
import hmac
import re
import unicodedata
from collections.abc import Mapping

__all__ = [
    "ALLOWED_METHODS",
    "EVIDENCE_SEPARATOR",
    "CandidateProofError",
    "validate_candidates",
]

ALLOWED_METHODS = frozenset(
    {
        "explicit_self_declaration",
        "own_document_submission",
        "verified_first_party_correspondence",
        "parent_direct_review",
    }
)

EVIDENCE_SEPARATOR = "|"

_ORG_ID_RE = re.compile(r"[a-z0-9_]{1,64}")
_HEX64_RE = re.compile(r"[0-9a-f]{64}")
# 区切り文字 "|" を含まない安全な参照キーのみ許可
_REF_KEY_RE = re.compile(r"[A-Za-z0-9_.:\-]{1,128}")

_SPEC_FIELDS = frozenset(
    {
        "org_id",
        "org_name",
        "source_full_sha256",
        "evidence_method",
        "reviewed_by",
        "references",
    }
)
_REF_FIELDS = frozenset({"key", "digest"})
_MAX_REFERENCES = 50
_MISSING = object()

# 固定エラーコード
E_SPECS_TYPE = "E_SPECS_TYPE"
E_EVENTS_TYPE = "E_EVENTS_TYPE"
E_APPROVED_TYPE = "E_APPROVED_TYPE"
E_SPEC_TYPE = "E_SPEC_TYPE"
E_SPEC_FIELDS = "E_SPEC_FIELDS"
E_ORG_ID = "E_ORG_ID"
E_ORG_NAME = "E_ORG_NAME"
E_FULL_SHA = "E_FULL_SHA"
E_METHOD = "E_METHOD"
E_REVIEWER = "E_REVIEWER"
E_REFERENCES = "E_REFERENCES"
E_REF_FIELDS = "E_REF_FIELDS"
E_REF_KEY = "E_REF_KEY"
E_REF_DIGEST = "E_REF_DIGEST"
E_REF_DUPLICATE = "E_REF_DUPLICATE"
E_NOT_APPROVED = "E_NOT_APPROVED"
E_EVENT_MISSING = "E_EVENT_MISSING"
E_EVENT_SHAPE = "E_EVENT_SHAPE"
E_EVENT_TYPE = "E_EVENT_TYPE"
E_KEY_MISMATCH = "E_KEY_MISMATCH"
E_DIGEST_MISMATCH = "E_DIGEST_MISMATCH"
E_SENDER_MISMATCH = "E_SENDER_MISMATCH"
E_HASH_MISMATCH = "E_HASH_MISMATCH"
E_ORG_NAME_CONFLICT = "E_ORG_NAME_CONFLICT"
E_SOURCE_ORG_CONFLICT = "E_SOURCE_ORG_CONFLICT"
E_DUPLICATE_CANDIDATE = "E_DUPLICATE_CANDIDATE"


class CandidateProofError(ValueError):
    """固定コードのみを持つ検証エラー。"""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _fail(code):
    raise CandidateProofError(code) from None


def _clean_text(value, code, max_len):
    if not isinstance(value, str):
        _fail(code)
    value = value.strip()
    if not value or len(value) > max_len:
        _fail(code)
    for ch in value:
        # 制御文字・書式文字(双方向制御など)・サロゲートを拒否
        if unicodedata.category(ch)[0] == "C":
            _fail(code)
    return value


def _is_hex64(value):
    return isinstance(value, str) and _HEX64_RE.fullmatch(value) is not None


def _approved_set(approved_org_ids):
    if isinstance(approved_org_ids, (str, bytes, bytearray, Mapping)):
        _fail(E_APPROVED_TYPE)
    if not isinstance(approved_org_ids, (set, frozenset, list, tuple)):
        _fail(E_APPROVED_TYPE)
    for item in approved_org_ids:
        if not isinstance(item, str):
            _fail(E_APPROVED_TYPE)
    return frozenset(approved_org_ids)


def _check_references(references):
    if not isinstance(references, (list, tuple)):
        _fail(E_REFERENCES)
    if not references or len(references) > _MAX_REFERENCES:
        _fail(E_REFERENCES)
    checked = []
    seen_keys = set()
    for ref in references:
        if not isinstance(ref, Mapping) or set(ref.keys()) != _REF_FIELDS:
            _fail(E_REF_FIELDS)
        key = ref["key"]
        digest = ref["digest"]
        if not isinstance(key, str) or _REF_KEY_RE.fullmatch(key) is None:
            _fail(E_REF_KEY)
        if not _is_hex64(digest):
            _fail(E_REF_DIGEST)
        if key in seen_keys:
            _fail(E_REF_DUPLICATE)
        seen_keys.add(key)
        checked.append((key, digest))
    return checked


def _check_spec(spec):
    if not isinstance(spec, Mapping):
        _fail(E_SPEC_TYPE)
    if set(spec.keys()) != _SPEC_FIELDS:
        _fail(E_SPEC_FIELDS)

    org_id = spec["org_id"]
    if not isinstance(org_id, str) or _ORG_ID_RE.fullmatch(org_id) is None:
        _fail(E_ORG_ID)
    org_name = _clean_text(spec["org_name"], E_ORG_NAME, 200)

    full_sha = spec["source_full_sha256"]
    if not _is_hex64(full_sha):
        _fail(E_FULL_SHA)

    method = spec["evidence_method"]
    if not isinstance(method, str) or method not in ALLOWED_METHODS:
        _fail(E_METHOD)

    reviewer = _clean_text(spec["reviewed_by"], E_REVIEWER, 128)
    refs = _check_references(spec["references"])
    return org_id, org_name, full_sha, method, reviewer, refs


def _read_event(event):
    values = {}
    for name in ("source_type", "source_id", "event_type", "receive_key", "digest"):
        value = getattr(event, name, _MISSING)
        if not isinstance(value, str):
            _fail(E_EVENT_SHAPE)
        values[name] = value
    if not values["source_id"]:
        _fail(E_EVENT_SHAPE)
    if not _is_hex64(values["digest"]):
        _fail(E_EVENT_SHAPE)
    return values


def _resolve_sender(refs, events_by_key):
    sender = None
    for key, digest in refs:
        event = events_by_key.get(key, None)
        if event is None:
            _fail(E_EVENT_MISSING)
        ev = _read_event(event)
        if ev["source_type"] != "user" or ev["event_type"] != "message":
            _fail(E_EVENT_TYPE)
        if ev["receive_key"] != key:
            _fail(E_KEY_MISMATCH)
        if not hmac.compare_digest(ev["digest"], digest):
            _fail(E_DIGEST_MISMATCH)
        if sender is None:
            sender = ev["source_id"]
        elif ev["source_id"] != sender:
            _fail(E_SENDER_MISMATCH)
    return sender


def _sha256_hex(text):
    try:
        encoded = text.encode("utf-8")
    except UnicodeEncodeError:
        encoded = None
    if encoded is None:
        _fail(E_EVENT_SHAPE)
    return hashlib.sha256(encoded).hexdigest()


def validate_candidates(specs, events_by_key, approved_org_ids):
    """承認済み候補を検証し、転送前の dict リストを返す。

    1件でも不正なら CandidateProofError(ValueError) を送出し、何も返さない。
    """
    if not isinstance(specs, (list, tuple)):
        _fail(E_SPECS_TYPE)
    if not isinstance(events_by_key, Mapping):
        _fail(E_EVENTS_TYPE)
    approved = _approved_set(approved_org_ids)

    org_names = {}
    source_orgs = {}
    seen_pairs = set()
    pending = []

    for spec in specs:
        org_id, org_name, full_sha, method, reviewer, refs = _check_spec(spec)
        if org_id not in approved:
            _fail(E_NOT_APPROVED)

        source_id = _resolve_sender(refs, events_by_key)
        if not hmac.compare_digest(_sha256_hex(source_id), full_sha):
            _fail(E_HASH_MISMATCH)

        known_name = org_names.get(org_id)
        if known_name is not None and known_name != org_name:
            _fail(E_ORG_NAME_CONFLICT)
        prior_org = source_orgs.get(source_id)
        if prior_org is not None and prior_org != org_id:
            _fail(E_SOURCE_ORG_CONFLICT)
        if (source_id, org_id) in seen_pairs:
            _fail(E_DUPLICATE_CANDIDATE)

        org_names[org_id] = org_name
        source_orgs[source_id] = org_id
        seen_pairs.add((source_id, org_id))
        pending.append(
            {
                "source_type": "user",
                "source_id": source_id,
                "org_id": org_id,
                "org_name": org_name,
                "evidence": EVIDENCE_SEPARATOR.join(key for key, _ in refs),
                "reviewed_by": reviewer,
            }
        )

    return pending
