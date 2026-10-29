"""Local semantic-index generations, content-based refresh and guarded loading.

Uses only existing digest roots and extracted-document ledgers. No network I/O
except the existing loopback Ollama embedding endpoint; no generated summaries.
"""
from __future__ import annotations

import csv
import hashlib
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from pathlib import Path

SCHEMA = 1
MODEL = 'bge-m3'
DIMENSIONS = 1024
EMBED_NUM_THREADS = 2  # Index requests only; persistent Ollama configuration is unchanged.
DIGEST_ROOTS = ['discord/digest', 'mail/digest', 'line/digest',
                '過去アーカイブ運営プレイブック.md', 'カタログ/Google文書目録_*.md',
                'fulltext/summaries/議事録_Sonnet.md']
# knowledge_search.DEFAULT_BLOCKLIST と同じ一般的な語(この部品は単独でも動かすので写しを持つ)
BLOCKED = ['パスワード', 'password', 'ログイン', '認証情報', 'credential', '秘密', 'secret', '.env']
DERIVED = re.compile(r'(__part\d{2}|\.(?:gdoc|gsheet|gslides|gform)__\d{2}_)')
HEADING = re.compile(r'^#{1,4}\s')


class IndexErrorBase(RuntimeError):
    pass


class SourcesChanged(IndexErrorBase):
    pass


class PublicationDurabilityError(IndexErrorBase):
    def __init__(self, report):
        super().__init__('Published generation durability could not be confirmed')
        self.report = report


def digest_sections(text):
    sections = [[]]
    for line in text.splitlines():
        if HEADING.match(line):
            sections.append([line])
        else:
            sections[-1].append(line)
    return [body[:1500] for lines in sections if len(body := '\n'.join(lines).strip()) >= 40]


def raw_body(text):
    lines = text.split('\n')
    i = 0
    while i < len(lines) and (lines[i].startswith('# ') or not lines[i].strip()):
        i += 1
    return '\n'.join(lines[i:]).strip()


def raw_chunks(body, size=1100, overlap=150):
    start, n = 0, len(body)
    while start < n:
        end = min(start + size, n)
        if end < n:
            nl = body.rfind('\n', start + int(size * 0.5), end)
            if nl > 0:
                end = nl
        if chunk := body[start:end].strip():
            yield chunk
        if end >= n:
            break
        start = max(end - overlap, start + 1)


def _safe_path(root, rel, checked=None):
    if Path(rel).is_absolute() or '..' in Path(rel).parts or '\\' in rel:
        raise IndexErrorBase('Invalid relative source path')
    p = root / rel
    current = root
    for part in Path(rel).parts:
        current = current / part
        if checked is None or current not in checked:
            if current.is_symlink():
                raise IndexErrorBase('Symlink sources are not accepted')
            if checked is not None:
                checked.add(current)
    # Every component is validated above. Avoid repeating mount lookups for all
    # ancestors of every ledger entry; absolute/parent/backslash paths are refused.
    if not p.absolute().is_relative_to(root.absolute()):
        raise IndexErrorBase('Source escapes knowledge root')
    return p


def _extracted_path(root, rel, checked=None):
    name = 'fulltext/text/' + rel + '.txt'
    path = _safe_path(root, name, checked)
    if not path.is_file() and '／' in name and '‛' not in name:
        # rclone quotes a literal fullwidth slash as U+201B + U+FF0F.
        # Accept that observed mount spelling only with the exact SOURCE header.
        escaped = _safe_path(root, name.replace('／', '‛／'), checked)
        if escaped.is_file():
            with escaped.open(encoding='utf-8-sig') as f:
                header = f.readline().rstrip('\r\n')
            if header != '# SOURCE: ' + rel:
                raise IndexErrorBase('Escaped extraction source header mismatch')
            return escaped
    return path


def source_paths(root, kind, roots=None, blocked=(), progress=None):
    root = Path(root)
    if not root.is_dir():
        raise IndexErrorBase('Knowledge root missing')
    excludes = tuple(x.casefold() for x in [*BLOCKED, *blocked])
    paths = {}
    checked = set()
    if kind == 'digest':
        for rel in roots if roots is not None else DIGEST_ROOTS:
            p = _safe_path(root, rel, checked)
            if any(c in rel for c in '*?['):
                prefix = []
                for part in Path(rel).parts:
                    if any(c in part for c in '*?['):
                        break
                    prefix.append(part)
                parent = _safe_path(root, Path(*prefix).as_posix() if prefix else '.', checked)
                if not parent.is_dir():
                    raise IndexErrorBase('Required digest glob directory missing')
                found = list(root.glob(rel))
            elif p.is_dir():
                found = list(p.glob('*.md'))
            elif p.is_file():
                found = [p]
            else:
                # Collection directories are required; a missing mount is not a deletion.
                if Path(rel).as_posix().rstrip('/') in ['discord/digest', 'mail/digest', 'line/digest']:
                    raise IndexErrorBase('Required digest directory missing')
                if rel.endswith('/') or not p.suffix:
                    raise IndexErrorBase('Configured digest directory missing')
                if not p.parent.is_dir():
                    raise IndexErrorBase('Digest source parent directory missing')
                found = []
            for f in found:
                name = f.relative_to(root).as_posix()
                if not any(b in name.casefold() for b in excludes):
                    paths[name] = _safe_path(root, name, checked)
    elif kind == 'raw':
        if not (root/'fulltext/text').is_dir():
            raise IndexErrorBase('Extracted-document directory missing')
        relations = raw_relations(root, blocked=blocked)
        for count, rel in enumerate(relations, 1):
            p = _extracted_path(root, rel, checked)
            if not p.is_file():
                # Only ledger removal or a non-ok status confirms removal. A missing
                # file still marked ok may be a failed mount/sync, so do not erase it.
                raise IndexErrorBase('Ledger-listed extraction missing')
            paths[rel] = p
            if progress is not None and (count == 1 or count % 100 == 0):
                progress({'kind':kind,'status':'enumerating','files':count,
                          'total_files':len(relations)})
    else:
        raise ValueError('Unknown index kind')
    return dict(sorted(paths.items()))


def raw_relations(root, *, blocked=(), expected_ledgers=()):
    root = Path(root)
    ledgers = {rel: _safe_path(root, rel) for rel in ['fulltext/manifest.tsv', 'gdocs/_synced.tsv']}
    present = {rel for rel, path in ledgers.items() if path.is_file()}
    if not present or set(expected_ledgers) - present:
        raise IndexErrorBase('Required document ledger missing')
    rels = []
    if 'fulltext/manifest.tsv' in present:
        with ledgers['fulltext/manifest.tsv'].open(encoding='utf-8-sig', newline='') as f:
            reader = csv.DictReader(f, delimiter='\t')
            if not {'rel_path', 'status'}.issubset(reader.fieldnames or []):
                raise IndexErrorBase('Document ledger schema invalid')
            rels.extend(r['rel_path'] for r in reader if r['status'] in ('ok', 'ocr_ok'))
    if 'gdocs/_synced.tsv' in present:
        with ledgers['gdocs/_synced.tsv'].open(encoding='utf-8-sig') as f:
            rels.extend(l.split('\t')[0].strip() for l in f if l.strip())
    excludes = tuple(x.casefold() for x in [*BLOCKED, *blocked])
    return sorted({rel for rel in rels if rel and rel != 'rel_path' and not DERIVED.search(rel)
                   and not any(b in rel.casefold() for b in excludes)})


def _ledger_snapshot(root):
    records = {}
    for rel in ['fulltext/manifest.tsv', 'gdocs/_synced.tsv']:
        path = _safe_path(Path(root), rel)
        if path.is_file():
            before = path.stat()
            data = path.read_bytes()
            after = path.stat()
            if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                raise SourcesChanged('Document ledger changed while reading')
            records[rel] = {'sha256': hashlib.sha256(data).hexdigest(),
                            'mtime_ns': after.st_mtime_ns, 'bytes': after.st_size}
    return records


def _read_source_bytes(item):
    rel, path = item
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise SourcesChanged('Source changed while reading')
    return rel, path, data, after


def _parsed_source_record(root, kind, item):
    rel, path, data, after = _read_source_bytes(item)
    metadata = {'sha256': hashlib.sha256(data).hexdigest(),
                'mtime_ns': after.st_mtime_ns, 'bytes': after.st_size,
                'path': path.relative_to(root).as_posix()}
    text = data.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n')
    if kind == 'digest':
        chunks = digest_sections(text)
    else:
        body = raw_body(text)
        chunks = list(raw_chunks(body)) if len(body) >= 30 else []
    # Original bytes and the unchunked body are released when this worker returns.
    return rel, metadata, chunks


def inventory(root, kind, roots=None, blocked=(), progress=None):
    ledgers = _ledger_snapshot(root) if kind == 'raw' else {}
    paths = source_paths(root, kind, roots, blocked, progress)
    sources, rows, texts = {}, [], []
    # Bound both submitted work and original-body memory, then restore source order.
    workers = 4 if kind == 'raw' else 1
    with ThreadPoolExecutor(max_workers=workers) as pool:
        items = iter(paths.items())
        jobs = {pool.submit(_parsed_source_record, root, kind, item)
                for item in [next(items, None) for _ in range(workers)] if item is not None}
        records = []
        try:
            while jobs:
                completed, jobs = wait(jobs, return_when=FIRST_COMPLETED)
                for job in completed:
                    records.append(job.result())
                    if progress is not None and len(records) % 200 == 0:
                        progress({'kind':kind,'status':'reading','files':len(records),
                                  'total_files':len(paths)})
                    item = next(items, None)
                    if item is not None:
                        jobs.add(pool.submit(_parsed_source_record, root, kind, item))
        except Exception:
            for job in jobs:
                job.cancel()
            raise
    records.sort(key=lambda item:item[0])
    for count, (rel, metadata, chunks) in enumerate(records, 1):
        sources[rel] = metadata
        for i, chunk in enumerate(chunks):
            row = {'src': rel, 'sec' if kind == 'digest' else 'chunk_idx': i,
                   'hash': hashlib.sha256(chunk.encode('utf-8')).hexdigest()}
            if kind == 'digest':
                row['text'] = chunk
            else:
                row.update(chars=len(chunk), snippet=chunk[:80].replace('\t', ' ').replace('\n', ' '),
                           legacy_hash=hashlib.md5(chunk.encode('utf-8')).hexdigest()[:16])
            rows.append(row)
            texts.append(chunk)
        if progress is not None and count % 200 == 0:
            progress({'kind':kind,'status':'scanning','files':count,'rows':len(rows)})
    if kind == 'raw' and _ledger_snapshot(root) != ledgers:
        raise SourcesChanged('Document ledger changed during inventory')
    payload = {'schema': SCHEMA, 'model': MODEL, 'kind': kind, 'ledgers': ledgers,
               'roots': (roots if roots is not None else DIGEST_ROOTS) if kind == 'digest' else 'existing_document_ledgers',
               'blocked': sorted(set([*BLOCKED, *blocked])), 'sources': sources}
    # Timestamps are observations, not content identity. Touching unchanged inputs
    # must not publish another complete generation of identical vectors.
    identity = {**payload,
                'ledgers': {rel: {k:v for k,v in info.items() if k != 'mtime_ns'}
                            for rel,info in ledgers.items()},
                'sources': {rel: {k:v for k,v in info.items() if k != 'mtime_ns'}
                            for rel,info in sources.items()}}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    return {'fingerprint': fingerprint, **payload}, rows, texts


def index_dir(root, kind):
    return Path(root) / 'fulltext' / ('vector' if kind == 'digest' else 'vector_raw')


def pointer_signature(root, kind):
    p = index_dir(root, kind) / 'current.json'
    if not p.is_file():
        return None
    # Digest of the small pointer catches changes even at equal file timestamps.
    return hashlib.sha256(p.read_bytes()).hexdigest()


def read_generation(root, kind):
    import numpy as np
    base = index_dir(root, kind)
    pointer = json.loads((base / 'current.json').read_text(encoding='utf-8'))
    if not isinstance(pointer, dict) or not isinstance(pointer.get('generation'), str):
        raise IndexErrorBase('Invalid generation pointer')
    name = pointer['generation']
    if pointer.get('schema') != SCHEMA or pointer.get('kind') != kind or not re.fullmatch(r'[a-f0-9]{20,80}', name):
        raise IndexErrorBase('Invalid generation pointer')
    gen = base / 'generations' / name
    if not gen.resolve().is_relative_to(base.resolve()):
        raise IndexErrorBase('Generation escapes index root')
    return _read_generation_directory(gen, kind)


def _read_generation_directory(gen, kind):
    import numpy as np
    manifest = json.loads((gen / 'manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or manifest.get('schema') != SCHEMA or manifest.get('kind') != kind or manifest.get('model') != MODEL or manifest.get('dimensions') != DIMENSIONS:
        raise IndexErrorBase('Invalid generation manifest')
    for name in ['vectors.npy', 'rows.jsonl']:
        if hashlib.sha256((gen / name).read_bytes()).hexdigest() != manifest['assets'][name]:
            raise IndexErrorBase('Generation checksum mismatch')
    matrix = np.load(gen / 'vectors.npy', allow_pickle=False)
    with (gen / 'rows.jsonl').open(encoding='utf-8', newline='') as f:
        rows = [json.loads(line) for line in f if line.strip()]
    validate_vectors(matrix, len(rows))
    if manifest['rows'] != len(rows):
        raise IndexErrorBase('Generation row count mismatch')
    return np, matrix, rows, manifest


def validate_vectors(matrix, count):
    import numpy as np
    if matrix.shape != (count, DIMENSIONS) or not np.isfinite(matrix).all():
        raise IndexErrorBase('Embedding dimensions/count/values invalid')
    if count and (np.linalg.norm(matrix, axis=1) < 0.001).any():
        raise IndexErrorBase('Empty embedding vector')


def _legacy_cache(root, kind):
    import numpy as np
    base = index_dir(root, kind)
    if kind == 'digest':
        vp, rp = base/'digest_vectors.npy', base/'digest_sections.jsonl'
        if not vp.is_file() or not rp.is_file():
            return {}
        matrix = np.load(vp, allow_pickle=False)
        with rp.open(encoding='utf-8', newline='') as f:
            rows = [json.loads(line) for line in f if line.strip()]
        validate_vectors(matrix, len(rows))
        return {(r['src'], r['sec'], hashlib.sha256(r['text'].encode('utf-8')).hexdigest()): matrix[i] for i,r in enumerate(rows)}
    vp, rp = base/'vectors.npy', base/'meta.tsv'
    if not vp.is_file() or not rp.is_file():
        return {}
    matrix = np.load(vp, allow_pickle=False)
    with rp.open(encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f, delimiter='\t'))
    validate_vectors(matrix, len(rows))
    return {(r['rel_path'], int(r['chunk_idx']), r['hash']): matrix[int(r['idx'])] for r in rows}


def embed(texts, *, sleep=time.sleep):
    import numpy as np
    last = None
    for attempt in range(3):
        try:
            payload = json.dumps({'model': MODEL, 'input': texts, 'truncate': False,
                                  'options': {'num_thread': EMBED_NUM_THREADS}}).encode('utf-8')
            request = urllib.request.Request('http://localhost:11434/api/embed', data=payload, headers={'Content-Type': 'application/json'})
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    raise IndexErrorBase('Embedding redirects are not accepted')
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=300) as response:
                values = json.loads(response.read())['embeddings']
            matrix = np.asarray(values, dtype=np.float32)
            validate_vectors(matrix, len(texts))
            return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError, KeyError, TypeError, IndexErrorBase) as exc:
            last = exc
            # Bad-input responses are not made cheaper by repeated identical requests.
            if isinstance(exc, urllib.error.HTTPError) and exc.code in (400, 401, 403, 404):
                break
            if attempt < 2:
                sleep(2 ** attempt)
    raise IndexErrorBase('Local embedding failed; previous generation retained') from last


def _write_json(path, obj):
    with path.open('w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())


def _sync_directory(path):
    if os.name == 'nt':
        return
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def build_lock(lock_root):
    lock_root = Path(lock_root)
    lock_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = lock_root/'semantic-index.lock'
    with path.open('a+b') as f:
        if os.name == 'nt':
            import msvcrt
            if path.stat().st_size == 0:
                f.write(b'0'); f.flush()
            f.seek(0)
            try: msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc: raise IndexErrorBase('Refresh already running') from exc
        else:
            import fcntl
            try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc: raise IndexErrorBase('Refresh already running') from exc
        try:
            yield
        finally:
            if os.name == 'nt':
                f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_UN)


def refresh(root, kind, *, roots=None, blocked=(), embedder=embed, batch=1, before_publish=None, cache_dir=None, progress=None):
    import numpy as np
    started = time.time()
    inv, rows, texts = inventory(root, kind, roots, blocked, progress)
    base = index_dir(root, kind)
    old_manifest = None
    if (base/'current.json').is_file():
        try:
            _, old_matrix, old_rows, old_manifest = read_generation(root, kind)
        except (OSError, ValueError, KeyError, TypeError, IndexErrorBase):
            # A corrupt current pointer/generation must not permanently prevent
            # repair. Reuse only a validated legacy baseline, retain all generations.
            old_manifest = None
    if old_manifest is not None:
        if kind == 'digest':
            for rel in inv['roots']:
                normalized = Path(rel).as_posix().rstrip('/')
                was_directory = any(src.startswith(normalized+'/') for src in old_manifest['sources'])
                if was_directory and not _safe_path(Path(root), rel).is_dir():
                    raise IndexErrorBase('Previously indexed digest directory missing')
        if kind == 'raw' and set(old_manifest.get('ledgers', {})) - set(inv['ledgers']):
            raise IndexErrorBase('Previously indexed document ledger missing')
        if old_manifest['fingerprint'] == inv['fingerprint']:
            return {'kind': kind, 'status': 'fresh', 'files': len(inv['sources']), 'rows': len(rows), 'embedded': 0, 'reused': len(rows), 'seconds': round(time.time()-started, 2)}
        prev = {(r['src'], r.get('sec', r.get('chunk_idx')), r['hash']): old_matrix[i] for i,r in enumerate(old_rows)}
        legacy = False
    else:
        try:
            prev = _legacy_cache(root, kind)
        except Exception:
            # Legacy files are only an optional reuse cache; damaged legacy data
            # must not keep a verified fresh generation from being rebuilt.
            prev = {}
        legacy = kind == 'raw'
    matrices, pending = [None]*len(rows), []
    for i,r in enumerate(rows):
        key = (r['src'], r.get('sec', r.get('chunk_idx')), r['legacy_hash'] if legacy else r['hash'])
        if key in prev:
            matrices[i] = prev[key]
        else:
            pending.append(i)
    if cache_dir is not None:
        cache_dir = Path(cache_dir)/MODEL
        cache_dir.mkdir(parents=True, exist_ok=True)
        remaining = []
        for i in pending:
            p = cache_dir/(rows[i]['hash']+'.npy')
            try:
                value = np.load(p, allow_pickle=False)
                if value.shape != (DIMENSIONS,):
                    raise IndexErrorBase('Checkpoint shape invalid')
                validate_vectors(value.reshape(1,-1), 1)
                matrices[i] = value
            except (OSError, ValueError, EOFError, IndexErrorBase):
                remaining.append(i)
        pending = remaining
    for start in range(0, len(pending), batch):
        indices = pending[start:start+batch]
        result = np.asarray(embedder([texts[i] for i in indices]), dtype=np.float32)
        validate_vectors(result, len(indices))
        result = result / np.linalg.norm(result, axis=1, keepdims=True)
        for i,vec in zip(indices,result):
            matrices[i] = vec
            if cache_dir is not None:
                temporary_cache = cache_dir/('.'+uuid.uuid4().hex+'.npy')
                with temporary_cache.open('wb') as f:
                    np.save(f, vec, allow_pickle=False)
                    f.flush(); os.fsync(f.fileno())
                os.replace(temporary_cache, cache_dir/(rows[i]['hash']+'.npy'))
        if progress is not None:
            progress({'kind':kind,'status':'embedding','embedded':min(start+batch,len(pending)),
                      'remaining':max(0,len(pending)-start-batch)})
    matrix = np.asarray(matrices, dtype=np.float32) if rows else np.zeros((0,DIMENSIONS), dtype=np.float32)
    validate_vectors(matrix, len(rows))
    if rows:
        matrix = matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
    # Verify additions, edits, removals and ledger changes again before committing.
    if before_publish: before_publish()
    inv_after, _, _ = inventory(root, kind, roots, blocked, progress)
    if inv_after['fingerprint'] != inv['fingerprint']:
        raise SourcesChanged('Sources changed during embedding; previous generation retained')
    gen_name = inv['fingerprint'][:32] + uuid.uuid4().hex[:12]
    staging = base/'generations'/gen_name
    staging.mkdir(parents=True, exist_ok=False)
    with (staging/'vectors.npy').open('wb') as f:
        np.save(f, matrix, allow_pickle=False)
        f.flush(); os.fsync(f.fileno())
    with (staging/'rows.jsonl').open('w', encoding='utf-8') as f:
        for row in rows: f.write(json.dumps(row, ensure_ascii=False) + '\n')
        f.flush(); os.fsync(f.fileno())
    assets = {name:hashlib.sha256((staging/name).read_bytes()).hexdigest() for name in ['vectors.npy','rows.jsonl']}
    manifest = {**inv, 'dimensions':DIMENSIONS, 'rows':len(rows), 'built_at':time.time(), 'source_max_mtime_ns':max((s['mtime_ns'] for s in inv['sources'].values()), default=0), 'assets':assets}
    _write_json(staging/'manifest.json', manifest)
    # Verify saved files before moving the pointer; older generations remain untouched.
    _read_generation_directory(staging, kind)
    _sync_directory(staging)
    _sync_directory(staging.parent)
    temporary = base/('.current-' + uuid.uuid4().hex + '.json')
    _write_json(temporary, {'schema':SCHEMA,'kind':kind,'generation':gen_name})
    os.replace(temporary, base/'current.json')
    report = {'kind':kind,'status':'updated','files':len(inv['sources']),'rows':len(rows), 'embedded':len(pending),'reused':len(rows)-len(pending),'seconds':round(time.time()-started,2),'built_at':manifest['built_at'],'source_max_mtime_ns':manifest['source_max_mtime_ns'],'generation':gen_name}
    try:
        _sync_directory(base)
    except OSError as exc:
        report.update(status='published_durability_unconfirmed', current_generation_published=True,
                      previous_generation_available=old_manifest is not None or bool(prev), error_type=type(exc).__name__)
        raise PublicationDurabilityError(report) from exc
    return report


def digest_current(root, roots):
    try:
        _, _, _, manifest = read_generation(root, 'digest')
        inv, _, _ = inventory(root, 'digest', roots, manifest['blocked'])
        return inv['fingerprint'] == manifest['fingerprint']
    except (OSError, ValueError, KeyError, TypeError, IndexErrorBase):
        return False


def raw_current_text(root, rel, manifest, eligible=None):
    expected = manifest['sources'].get(rel)
    if expected is None:
        return None
    try:
        if eligible is None:
            eligible = raw_relations(root, blocked=manifest['blocked'], expected_ledgers=manifest.get('ledgers', {}))
        if rel not in eligible:
            return None
        path = _extracted_path(Path(root), rel)
        if path.relative_to(root).as_posix() != expected.get('path', 'fulltext/text/'+rel+'.txt'):
            return None
        data = path.read_bytes()
        return data.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n') if hashlib.sha256(data).hexdigest() == expected['sha256'] else None
    except (OSError, ValueError, KeyError, TypeError, IndexErrorBase):
        return None


def raw_source_current(root, rel, manifest):
    return raw_current_text(root, rel, manifest) is not None
