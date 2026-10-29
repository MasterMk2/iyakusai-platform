'''attachment_receipt_core: stdlib-only attachment receipt checks.

The metadata check alone NEVER confirms attachment bytes; use
verify_attachment_bytes for byte-level proof. This module does no network I/O.
'''
import hashlib
import hmac
import re
import unicodedata
from pathlib import PurePosixPath

MAX_SIZE = 10 * 1024 * 1024
JPEG_SUFFIXES = frozenset({'.jpg', '.jpeg'})
_SAFE_NAME = re.compile(r'[A-Za-z0-9_.()-]{1,256}')
_HEX64 = re.compile(r'[0-9a-f]{64}')
_SEPARATORS = ('/', chr(92), chr(0))

E_EXPECTED_NAME = 'E_EXPECTED_NAME'
E_EXPECTED_SIZE = 'E_EXPECTED_SIZE'
E_EXPECTED_HASH = 'E_EXPECTED_HASH'
E_RECEIVED_TYPE = 'E_RECEIVED_TYPE'
E_RECEIVED_NAME = 'E_RECEIVED_NAME'
E_RECEIVED_TITLE = 'E_RECEIVED_TITLE'
E_RECEIVED_SIZE = 'E_RECEIVED_SIZE'
E_SIZE_MISMATCH = 'E_SIZE_MISMATCH'
E_BYTES_TYPE = 'E_BYTES_TYPE'
E_SOURCE_SIZE = 'E_SOURCE_SIZE'
E_SOURCE_HASH = 'E_SOURCE_HASH'
E_CONTENT_MISMATCH = 'E_CONTENT_MISMATCH'
E_JPEG_NOT_EQUIVALENT = 'E_JPEG_NOT_EQUIVALENT'
E_CALLBACK = 'E_CALLBACK'


def _fail(code):
    # from None: do not chain exceptions that might carry input data
    raise ValueError(code) from None


def _is_size(value):
    return type(value) is int and 1 <= value <= MAX_SIZE


def _has_separator(text):
    forms = (text, unicodedata.normalize('NFKC', text), unicodedata.normalize('NFC', text))
    return any(sep in f for f in forms for sep in _SEPARATORS)


def _is_jpeg_name(name):
    return PurePosixPath(name).suffix.lower() in JPEG_SUFFIXES


def _check_expected_name(expected_name):
    if type(expected_name) is not str or not expected_name:
        _fail(E_EXPECTED_NAME)
    if _has_separator(expected_name) or expected_name in ('.', '..'):
        _fail(E_EXPECTED_NAME)
    if any(unicodedata.category(c).startswith('C') for c in expected_name):
        _fail(E_EXPECTED_NAME)
    if PurePosixPath(expected_name).name != expected_name:
        _fail(E_EXPECTED_NAME)
    if not PurePosixPath(expected_name).stem:
        _fail(E_EXPECTED_NAME)


def validate_attachment_metadata(received, *, expected_name, expected_size):
    '''Validate received metadata. Never confirms attachment bytes.'''
    _check_expected_name(expected_name)
    if not _is_size(expected_size):
        _fail(E_EXPECTED_SIZE)
    if type(received) is not dict:
        _fail(E_RECEIVED_TYPE)
    name = received.get('filename')
    if type(name) is not str or not name:
        _fail(E_RECEIVED_NAME)
    if _has_separator(name) or name in ('.', '..'):
        _fail(E_RECEIVED_NAME)
    if name != expected_name:
        if _SAFE_NAME.fullmatch(name) is None:
            _fail(E_RECEIVED_NAME)
        if PurePosixPath(name).name != name:
            _fail(E_RECEIVED_NAME)
        if PurePosixPath(name).suffix != PurePosixPath(expected_name).suffix:
            _fail(E_RECEIVED_NAME)
        stem = PurePosixPath(expected_name).stem
        title = received.get('title')
        if type(title) is not str or title != stem or _has_separator(title):
            _fail(E_RECEIVED_TITLE)
    size = received.get('size')
    if not _is_size(size):
        _fail(E_RECEIVED_SIZE)
    if not _is_jpeg_name(expected_name) and size != expected_size:
        _fail(E_SIZE_MISMATCH)


def verify_attachment_bytes(source, received, *, expected_name, expected_size,
                            expected_sha256, received_size, jpeg_equivalent):
    '''Verify bytes. Returns proof dict without byte data or URLs.'''
    _check_expected_name(expected_name)
    if not _is_size(expected_size):
        _fail(E_EXPECTED_SIZE)
    if type(expected_sha256) is not str or _HEX64.fullmatch(expected_sha256) is None:
        _fail(E_EXPECTED_HASH)
    if not _is_size(received_size):
        _fail(E_RECEIVED_SIZE)
    if type(source) is not bytes or type(received) is not bytes:
        _fail(E_BYTES_TYPE)
    if len(source) != expected_size:
        _fail(E_SOURCE_SIZE)
    source_sha = hashlib.sha256(source).hexdigest()
    if not hmac.compare_digest(source_sha, expected_sha256):
        _fail(E_SOURCE_HASH)
    if len(received) != received_size or len(received) > MAX_SIZE:
        _fail(E_SIZE_MISMATCH)
    received_sha = hashlib.sha256(received).hexdigest()
    if (len(source) == len(received) and hmac.compare_digest(source_sha, received_sha)
            and source == received):
        method = 'exact_bytes'
    else:
        if not _is_jpeg_name(expected_name):
            _fail(E_CONTENT_MISMATCH)
        if not callable(jpeg_equivalent):
            _fail(E_CALLBACK)
        try:
            verdict = jpeg_equivalent(source, received)
        except Exception:
            verdict = None
        if verdict is None:
            _fail(E_CALLBACK)
        if verdict is not True:
            _fail(E_JPEG_NOT_EQUIVALENT)
        method = 'jpeg_safe_metadata_only'
    return {
        'method': method,
        'source_size': len(source),
        'source_sha256': source_sha,
        'received_size': len(received),
        'received_sha256': received_sha,
    }
