import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CalendarEventInput } from '../../shared/calendar.js';

// Committee calendar: one SQLite file (calendar.sqlite3) next to mail.sqlite3. The mail folder's own backup carries it,
// and so does the app's backup (ops/backup.ts, which copies it through SQLite's online backup, like mail and minutes).
// An event keeps its date and time as text in separate columns (the yearly copy reads the date), its
// departments, memo and reminder days as one JSON document. Every create, change and delete keeps a history row,
// and an update or delete keeps the event as it was before (before_json), so a mistaken edit can be put back by hand.
// The iCal subscriptions keep only the hash of each secret URL, never the URL itself. A create sent with a request ID
// is remembered for a day (event_requests), so a repeated send of the same request returns the same event.

export const CALENDAR_FILE = 'calendar.sqlite3';
const SCHEMA_VERSION = '1';
/** How long a create's request ID is remembered (a resend happens within minutes; a day is generous). */
const REQUEST_KEEP_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT,
  kind TEXT NOT NULL,
  yearly INTEGER NOT NULL,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  copied_from TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events(date, time, id);
CREATE INDEX IF NOT EXISTS events_yearly ON events(yearly, substr(date, 6, 5));
CREATE TABLE IF NOT EXISTS event_history(id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, changed_json TEXT NOT NULL, before_json TEXT);
CREATE INDEX IF NOT EXISTS event_history_event ON event_history(event_id, id);
CREATE TABLE IF NOT EXISTS ical_subscriptions(user_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, rotated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_requests(user_id TEXT NOT NULL, request_id TEXT NOT NULL, event_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(user_id, request_id));
`;

export interface CalendarEventRow {
  id: string;
  data: CalendarEventInput;
  version: number;
  copiedFrom: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

interface RawEvent {
  id: string;
  date: string;
  time: string | null;
  kind: string;
  yearly: number;
  title: string;
  data_json: string;
  copied_from: string | null;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface CalendarHistoryRow {
  at: string;
  actorId: string;
  action: 'created' | 'updated' | 'deleted';
  changed: (keyof CalendarEventInput)[];
}

export interface SubscriptionRow {
  createdAt: string;
  rotatedAt: string;
}

const FIELDS: (keyof CalendarEventInput)[] = ['title', 'kind', 'date', 'time', 'departments', 'memo', 'yearly', 'remindDays'];

/** The fields that differ between two versions of an event. */
export function changedFields(before: CalendarEventInput, after: CalendarEventInput): (keyof CalendarEventInput)[] {
  return FIELDS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

export class CalendarStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, CALENDAR_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('calendar schema version');
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private static row(raw: RawEvent): CalendarEventRow {
    return {
      id: raw.id,
      data: JSON.parse(raw.data_json) as CalendarEventInput,
      version: Number(raw.version),
      copiedFrom: raw.copied_from,
      createdAt: raw.created_at,
      createdBy: raw.created_by,
      updatedAt: raw.updated_at,
      updatedBy: raw.updated_by,
    };
  }

  /** Events on or between two dates (inclusive), in date and time order. */
  range(from: string, to: string): CalendarEventRow[] {
    return (this.db.prepare('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, time, id').all(from, to) as unknown as RawEvent[]).map(CalendarStore.row);
  }

  /** The yearly schedule: every event marked 毎年, in month and day order (the year is not part of the order). */
  yearly(): CalendarEventRow[] {
    return (this.db.prepare('SELECT * FROM events WHERE yearly = 1 ORDER BY substr(date, 6, 5), time, id').all() as unknown as RawEvent[]).map(CalendarStore.row);
  }

  /** One event by its ID, or null. */
  get(id: string): CalendarEventRow | null {
    const raw = this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as unknown as RawEvent | undefined;
    return raw ? CalendarStore.row(raw) : null;
  }

  history(id: string, limit = 50): CalendarHistoryRow[] {
    const rows = this.db.prepare('SELECT at, actor_id, action, changed_json FROM event_history WHERE event_id=? ORDER BY id DESC LIMIT ?').all(id, limit) as { at: string; actor_id: string; action: string; changed_json: string }[];
    return rows.map((r) => ({ at: r.at, actorId: r.actor_id, action: r.action as CalendarHistoryRow['action'], changed: JSON.parse(r.changed_json) as (keyof CalendarEventInput)[] }));
  }

  /** Every department name that an event carries, sorted (the choices of the filter and the form). */
  departmentNames(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT j.value AS name FROM events, json_each(events.data_json, \'$.departments\') j ORDER BY j.value').all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n);
  }

  create(data: CalendarEventInput, actorId: string, now: string, copiedFrom: string | null = null): CalendarEventRow {
    return this.tx(() => this.insert(data, actorId, now, copiedFrom));
  }

  /** Inserts an event and its creation history row. The caller holds the transaction. */
  private insert(data: CalendarEventInput, actorId: string, now: string, copiedFrom: string | null): CalendarEventRow {
    const id = `ev_${randomBytes(8).toString('hex')}`;
    this.db
      .prepare('INSERT INTO events(id,date,time,kind,yearly,title,data_json,copied_from,version,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)')
      .run(id, data.date, data.time, data.kind, data.yearly ? 1 : 0, data.title, JSON.stringify(data), copiedFrom, now, actorId, now, actorId);
    this.db.prepare("INSERT INTO event_history(event_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,'created','[]',NULL)").run(id, now, actorId);
    return this.get(id)!;
  }

  /**
   * A create sent with a request ID (the screen's one ID per form, kept for a resend). The first send inserts the event;
   * a repeat of the same ID for the same person returns that event instead of a second one. `gone` when the event
   * of an earlier send has been deleted since (it is not made again).
   */
  createOnce(requestId: string, userId: string, data: CalendarEventInput, now: string): { kind: 'created' | 'replayed'; row: CalendarEventRow } | { kind: 'gone' } {
    return this.tx(() => {
      const cutoff = new Date(Date.parse(now) - REQUEST_KEEP_MS).toISOString();
      this.db.prepare('DELETE FROM event_requests WHERE at < ?').run(cutoff);
      const seen = this.db.prepare('SELECT event_id FROM event_requests WHERE user_id=? AND request_id=?').get(userId, requestId) as { event_id: string } | undefined;
      if (seen) {
        const row = this.get(seen.event_id);
        return row ? { kind: 'replayed' as const, row } : { kind: 'gone' as const };
      }
      const row = this.insert(data, userId, now, null);
      this.db.prepare('INSERT INTO event_requests(user_id,request_id,event_id,at) VALUES(?,?,?,?)').run(userId, requestId, row.id, now);
      return { kind: 'created' as const, row };
    });
  }

  /**
   * Null when the event is gone; 'conflict' when someone saved it first. A save that changes nothing keeps the version.
   * A repeat of a save that already went through (its answer was lost) sends the version it was made from, but the
   * event already holds the same content: that is the saved version, not a conflict.
   */
  update(id: string, expectedVersion: number, data: CalendarEventInput, actorId: string, now: string): CalendarEventRow | 'conflict' | null {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) return null;
      const changed = changedFields(before.data, data);
      if (changed.length === 0) return before;
      if (before.version !== expectedVersion) return 'conflict';
      this.db
        .prepare('UPDATE events SET date=?, time=?, kind=?, yearly=?, title=?, data_json=?, version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?')
        .run(data.date, data.time, data.kind, data.yearly ? 1 : 0, data.title, JSON.stringify(data), now, actorId, id, expectedVersion);
      this.db.prepare("INSERT INTO event_history(event_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,'updated',?,?)").run(id, now, actorId, JSON.stringify(changed), JSON.stringify(before.data));
      return this.get(id)!;
    });
  }

  delete(id: string, expectedVersion: number, actorId: string, now: string): 'deleted' | 'conflict' | null {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      this.db.prepare('DELETE FROM events WHERE id=?').run(id);
      this.db.prepare("INSERT INTO event_history(event_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,'deleted','[]',?)").run(id, now, actorId, JSON.stringify(before.data));
      return 'deleted';
    });
  }

  // ---- iCal subscriptions (one per person; only the hash of the secret URL is kept)

  subscription(userId: string): SubscriptionRow | null {
    const row = this.db.prepare('SELECT created_at, rotated_at FROM ical_subscriptions WHERE user_id=?').get(userId) as { created_at: string; rotated_at: string } | undefined;
    return row ? { createdAt: row.created_at, rotatedAt: row.rotated_at } : null;
  }

  /** The person a secret URL belongs to, by the hash of its token; null when no one has it. */
  subscriptionUser(tokenHash: string): string | null {
    const row = this.db.prepare('SELECT user_id FROM ical_subscriptions WHERE token_hash=?').get(tokenHash) as { user_id: string } | undefined;
    return row ? row.user_id : null;
  }

  /** Makes a new secret URL for a person (the old one stops at once). The first creation date is kept. */
  putSubscription(userId: string, tokenHash: string, now: string): void {
    this.db
      .prepare('INSERT INTO ical_subscriptions(user_id,token_hash,created_at,rotated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, rotated_at=excluded.rotated_at')
      .run(userId, tokenHash, now, now);
  }

  removeSubscription(userId: string): boolean {
    return Number(this.db.prepare('DELETE FROM ical_subscriptions WHERE user_id=?').run(userId).changes) > 0;
  }
}
