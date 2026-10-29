import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileDurable, type DurableFileOps } from '../durable-file.js';
import type { LoginAuditEvent, LoginAuditSink, LoginPersistence } from './types.js';

// Durable single-process storage for the account composition.
//  - Login state (credentials, sessions, challenges, setup grants): one JSON document with an
//    HMAC integrity tag keyed by the injected pepper, written durably (fsync'ed unique temp file,
//    rename, parent directory fsync on POSIX).
//    A missing file is a first start; ANY unreadable, malformed or unauthenticated content is
//    refused (LoginStoreIntegrityError) - it is never replaced by an empty or sample state.
//  - Audit: append-only JSON lines of the already pseudonymous audit events, size-rotated once.
// Only hashes are stored: no code, password, token, email or DM text.

export class LoginStoreIntegrityError extends Error {}

const DOC_KIND = 'smm-login-store';

export class FileLoginPersistence implements LoginPersistence {
  readonly kind = 'durable' as const;

  constructor(
    private readonly file: string,
    private readonly pepper: Buffer,
    /** Test-only failure injection; production uses the real file system. */
    private readonly ops?: DurableFileOps,
  ) {}

  private mac(data: string): string {
    return createHmac('sha256', this.pepper).update(`${DOC_KIND}\u0000v1\u0000${data}`, 'utf8').digest('hex');
  }

  load(): unknown {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new LoginStoreIntegrityError('login store unreadable');
    }
    let doc: { kind?: unknown; version?: unknown; data?: unknown; mac?: unknown };
    try {
      doc = JSON.parse(text) as typeof doc;
    } catch {
      throw new LoginStoreIntegrityError('login store malformed');
    }
    if (!doc || doc.kind !== DOC_KIND || doc.version !== 1 || typeof doc.data !== 'string' || typeof doc.mac !== 'string' || !/^[0-9a-f]{64}$/.test(doc.mac)) {
      throw new LoginStoreIntegrityError('login store malformed');
    }
    const expected = Buffer.from(this.mac(doc.data), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(doc.mac, 'hex'))) throw new LoginStoreIntegrityError('login store integrity check failed');
    try {
      return JSON.parse(doc.data);
    } catch {
      throw new LoginStoreIntegrityError('login store malformed');
    }
  }

  /** Unique exclusive 0600 temp file, fsync, rename, directory fsync where supported (durable-file.ts). */
  save(snapshot: unknown): void {
    const data = JSON.stringify(snapshot);
    writeFileDurable(this.file, JSON.stringify({ kind: DOC_KIND, version: 1, data, mac: this.mac(data) }), this.ops);
  }
}

const AUDIT_FIELDS = ['type', 'at', 'subjectRef', 'challengeRef', 'reason'] as const;

/** Appends audit events as JSON lines (allowlisted fields only). Rotates to `<file>.1` past maxBytes. */
export function fileAuditSink(file: string, maxBytes = 5 * 1024 * 1024): LoginAuditSink {
  mkdirSync(dirname(file), { recursive: true });
  return (event: LoginAuditEvent) => {
    const line = JSON.stringify(Object.fromEntries(AUDIT_FIELDS.filter((k) => event[k] !== undefined).map((k) => [k, event[k]])));
    try {
      if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    } catch {
      // Missing file: first write creates it.
    }
    appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  };
}

/** Bounded in-memory audit ring for the mock composition and tests. */
export function memoryAuditSink(limit = 500): { sink: LoginAuditSink; events: LoginAuditEvent[] } {
  const events: LoginAuditEvent[] = [];
  return {
    events,
    sink: (event) => {
      events.push({ ...event });
      if (events.length > limit) events.splice(0, events.length - limit);
    },
  };
}
