"""Discord thread to LINE source map for the integrated app (contract B).

At the end of every relay cycle the runner writes, when ``site.json`` names a
``threadMapFile``, which ready organization thread in the approved forum
belongs to which verified LINE source. The app only reads the file, to answer
a reply typed in that Discord thread. Nothing here reaches the network.

Only verified bindings whose organization thread is ``ready`` are written. An
organization with more than one verified source is left out (a reply from its
thread could not name one recipient). The file is replaced atomically (a
temporary file in the same directory, then rename) with mode 0600. A failure
never stops the relay: ``publish_thread_map`` returns a status with a short
code, without paths, IDs or names.
"""
from collections import Counter
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sqlite3

from oa_relay import JST, ValidationError

VERSION = 1
_THREAD_ID = re.compile(r"[1-9][0-9]{16,19}")
_MAX_BYTES = 4 * 1024 * 1024


def build_thread_map(registry, journal, forum_id, *, now=None):
    """Return (document, skipped counts) from verified bindings and ready threads."""
    by_org = {}
    for binding in registry.bindings.values():
        if binding.verified is True:
            by_org.setdefault(binding.org_id, []).append(binding)
    rows = journal.db.execute(
        "SELECT org_id,thread_id FROM threads WHERE state='ready' AND forum_id=? ORDER BY org_id",
        (forum_id,)).fetchall()
    skipped = Counter()
    seen_threads = Counter(str(thread_id) for _, thread_id in rows)
    threads = {}
    for org_id, thread_id in rows:
        thread_id = str(thread_id)
        bindings = by_org.get(org_id, [])
        if not _THREAD_ID.fullmatch(thread_id) or seen_threads[thread_id] != 1:
            skipped["invalid_thread"] += 1
        elif not bindings:
            skipped["no_verified_binding"] += 1
        elif len(bindings) != 1:
            skipped["ambiguous_organization_source"] += 1
        else:
            binding = bindings[0]
            threads[thread_id] = {"sourceType": binding.source_type, "sourceId": binding.source_id,
                                  "orgId": binding.org_id, "orgName": binding.org_name}
    stamp = (now or datetime.now(JST)).astimezone(JST).replace(microsecond=0).isoformat()
    return {"version": VERSION, "generatedAt": stamp, "threads": threads}, dict(skipped)


def write_atomic(path, document):
    """Write JSON to ``path`` through a 0600 temporary file and rename."""
    path = Path(path)
    data = (json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    if len(data) > _MAX_BYTES:
        raise ValidationError("thread_map_too_large")
    directory = path.parent
    if not directory.is_dir() or directory.is_symlink():
        raise ValidationError("thread_map_directory_missing")
    temporary = directory / f".{path.name}.{os.getpid()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        temporary.unlink()          # a stale file from an interrupted run of this same process ID
    except FileNotFoundError:
        pass
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            if hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    if hasattr(os, "O_DIRECTORY"):
        directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)


def publish_thread_map(path, registry, journal, forum_id, *, now=None):
    """Build and write the map. Never raises for an ordinary failure; returns a status."""
    if path is None:
        return {"written": False, "reason": "not_configured"}
    try:
        document, skipped = build_thread_map(registry, journal, forum_id, now=now)
        write_atomic(path, document)
    except ValidationError as error:
        return {"written": False, "reason": str(error)}
    except (OSError, ValueError, TypeError, sqlite3.Error) as error:
        return {"written": False, "reason": type(error).__name__}
    return {"written": True, "threads": len(document["threads"]), "skipped": skipped}
