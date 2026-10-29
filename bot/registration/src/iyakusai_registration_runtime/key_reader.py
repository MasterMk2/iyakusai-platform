"""Explicit, protected key reads; no discovery, environment lookup or key creation.

The shared hex-lf-v1 codec requires exactly 65 ASCII bytes: 64 lowercase hex
digits and one LF, decoded to 32 bytes. Mail's public parseKeyMaterial trims
then hex-decodes this same canonical representation. Nothing else is accepted.
Only operator-injected paths are read.
"""

from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path


class KeyReaderError(Exception):
    """A sanitized failure: no paths or key material in text or exception chains."""


@dataclass(frozen=True, repr=False)
class PurposeKeyPair:
    signing: bytes = field(repr=False)
    fingerprint: bytes = field(repr=False)


@dataclass(frozen=True)
class _ReadResult:
    material: bytes = field(repr=False)
    device: int
    inode: int


def _metadata(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev, value.st_ino, value.st_mode, value.st_uid,
        value.st_gid, value.st_nlink, value.st_size,
        value.st_mtime_ns, value.st_ctime_ns,
    )


def _owner(value: os.stat_result, uid: int, gid: int | None) -> bool:
    return value.st_uid == uid and (gid is None or value.st_gid == gid)


def _decode(raw: bytes, encoding: str) -> bytes:
    if encoding != "hex-lf-v1" or len(raw) != 65 or re.fullmatch(rb"[0-9a-f]{64}\n", raw) is None:
        raise ValueError
    decoded = bytes.fromhex(raw[:64].decode("ascii"))
    if len(decoded) != 32 or len(set(decoded)) == 1:
        raise ValueError
    return decoded


def _open_directory(path: Path, uid: int, gid: int | None) -> int:
    """Traverse via directory descriptors, rejecting every symlink component."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(path.anchor, flags)
    try:
        for part in path.parts[1:]:
            before = os.stat(part, dir_fd=descriptor, follow_symlinks=False)
            candidate = os.open(part, flags, dir_fd=descriptor)
            after = os.fstat(candidate)
            if not stat.S_ISDIR(before.st_mode) or _metadata(before) != _metadata(after):
                os.close(candidate)
                raise ValueError
            os.close(descriptor)
            descriptor = candidate
        current = os.fstat(descriptor)
        if not stat.S_ISDIR(current.st_mode) or stat.S_IMODE(current.st_mode) != 0o700 or not _owner(current, uid, gid):
            raise ValueError
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _read(path: Path, *, encoding: str, uid: int, gid: int | None, limit: int) -> _ReadResult:
    directory = _open_directory(path.parent, uid, gid)
    descriptor: int | None = None
    try:
        before = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o600 or not _owner(before, uid, gid) or before.st_nlink != 1 or not 1 <= before.st_size <= limit:
            raise ValueError
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory)
        opened = os.fstat(descriptor)
        if _metadata(before) != _metadata(opened):
            raise ValueError
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        final = os.fstat(descriptor)
        named = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        if len(raw) != before.st_size or len(raw) > limit or _metadata(before) != _metadata(final) or _metadata(before) != _metadata(named):
            raise ValueError
        return _ReadResult(_decode(raw, encoding), before.st_dev, before.st_ino)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory)


def _request(path: os.PathLike[str] | str, uid: int, gid: int | None, limit: int) -> Path:
    if type(uid) is not int or uid < 0 or (gid is not None and (type(gid) is not int or gid < 0)) or type(limit) is not int or not 64 <= limit <= 4096:
        raise ValueError
    raw_path = os.fspath(path)
    if type(raw_path) is not str or "\0" in raw_path:
        raise ValueError
    parsed = Path(raw_path)
    if not parsed.is_absolute() or ".." in parsed.parts or not parsed.name:
        raise ValueError
    return parsed


def read_key_file(path: os.PathLike[str] | str, *, encoding: str, expected_uid: int, expected_gid: int | None = None, max_file_bytes: int = 4096) -> bytes:
    """Read one explicitly supplied 0600 key inside an owner-private 0700 dir."""
    result: _ReadResult | None = None
    try:
        requested = _request(path, expected_uid, expected_gid, max_file_bytes)
        result = _read(requested, encoding=encoding, uid=expected_uid, gid=expected_gid, limit=max_file_bytes)
    except (OSError, ValueError, TypeError, UnicodeError):
        pass
    if result is None:
        # Outside the exception handler: no source exception/path/material chain.
        raise KeyReaderError("key read refused")
    return result.material


def read_purpose_keys(directory: os.PathLike[str] | str, *, encoding: str, expected_uid: int, expected_gid: int | None = None, signing_filename: str = "smm-auth.key", fingerprint_filename: str = "fingerprint.key") -> PurposeKeyPair:
    """Read two dedicated keys, rejecting same path/inode/material across purposes.

    The caller wraps these bytes as PurposeKey('smm-auth', pair.signing) and
    PurposeKey('dm-fingerprint', pair.fingerprint); no Task key is discovered.
    """
    pair: PurposeKeyPair | None = None
    try:
        if any(type(name) is not str or not name or name in (".", "..") or "/" in name or "\0" in name for name in (signing_filename, fingerprint_filename)) or signing_filename == fingerprint_filename:
            raise ValueError
        base = Path(directory)
        signing_path = _request(base / signing_filename, expected_uid, expected_gid, 4096)
        fingerprint_path = _request(base / fingerprint_filename, expected_uid, expected_gid, 4096)
        signing = _read(signing_path, encoding=encoding, uid=expected_uid, gid=expected_gid, limit=4096)
        fingerprint = _read(fingerprint_path, encoding=encoding, uid=expected_uid, gid=expected_gid, limit=4096)
        if (signing.device, signing.inode) == (fingerprint.device, fingerprint.inode) or signing.material == fingerprint.material:
            raise ValueError
        pair = PurposeKeyPair(signing.material, fingerprint.material)
    except (OSError, ValueError, TypeError, UnicodeError):
        pass
    if pair is None:
        raise KeyReaderError("key pair read refused")
    return pair
