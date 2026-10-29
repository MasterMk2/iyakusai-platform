import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';

// Sign-in log of the Discord login: one JSON line per sign-in, registration or code event, appended to
// a file next to the account file (login-events.jsonl). Access administrators read it to look into
// failed sign-ins. It never holds passwords, codes or tokens: only the time, the kind, the login ID
// that was typed (when it has the shape of a login ID), the account and the client address.

export type LoginEventKind =
  | 'login_ok'
  | 'login_failed'
  | 'login_blocked'
  | 'password_failed'
  | 'register_ok'
  | 'register_failed'
  | 'register_blocked'
  | 'code_issued'
  | 'code_bulk_issued';

export type LoginEventReason = 'unknown_id' | 'wrong_password' | 'not_active' | 'account_limit' | 'client_limit' | 'wrong_code' | 'no_code' | 'student_id';

export interface LoginEvent {
  at: number;
  kind: LoginEventKind;
  /** The typed login ID, only when it looks like a student ID or iy- ID (never free text). */
  loginId: string | null;
  /** iy- ID of the account concerned, when known. */
  account: string | null;
  client: string | null;
  reason?: LoginEventReason;
}

const KINDS = new Set<string>(['login_ok', 'login_failed', 'login_blocked', 'password_failed', 'register_ok', 'register_failed', 'register_blocked', 'code_issued', 'code_bulk_issued']);
/** The newest part of the file that is read back (older lines stay in the file). */
const READ_TAIL_BYTES = 4 * 1024 * 1024;

/** A typed login ID worth keeping: the shape of a student ID or iy- ID, else nothing. */
export function loggableLoginId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.normalize('NFKC').trim();
  if (/^iy-\d{8}$/i.test(v)) return v.toLowerCase();
  const upper = v.toUpperCase();
  return /^[0-9A-Z]{5,12}$/.test(upper) ? upper : null;
}

export class LoginAudit {
  private readonly memory: LoginEvent[] = [];

  /** `file` null keeps the events in memory (tests). */
  constructor(private readonly file: string | null) {}

  record(event: LoginEvent): void {
    if (!this.file) {
      this.memory.push(event);
      return;
    }
    // Losing a log line must never stop a sign-in.
    try {
      const fd = openSync(this.file, 'a', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(event)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // ignored
    }
  }

  /** Events at or after `since`, newest first, at most `limit`. */
  recent(since: number, limit: number): LoginEvent[] {
    const all = this.file ? this.readFile() : this.memory;
    return all
      .filter((e) => e.at >= since)
      .sort((x, y) => y.at - x.at)
      .slice(0, limit);
  }

  private readFile(): LoginEvent[] {
    if (!this.file || !existsSync(this.file)) return [];
    const fd = openSync(this.file, 'r');
    let text: string;
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - READ_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
    const events: LoginEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LoginEvent;
        if (Number.isSafeInteger(e.at) && KINDS.has(e.kind)) events.push(e);
      } catch {
        // a torn line is skipped
      }
    }
    return events;
  }
}
