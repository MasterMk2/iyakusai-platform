import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AvailabilityAudience, AvailabilityDetail } from '../../shared/availability.js';

// Free/busy connections (2026-11-20): one SQLite file (availability.sqlite3) next to mail.sqlite3, so the backups of
// the mail folder carry it. It keeps each member's own choices only: which Google calendar, who may see it, how
// coarse. The busy periods themselves are never written here (the service keeps them in memory), so a backup holds
// no one's schedule. One calendar belongs to one member: the calendar's ID is unique.

export const AVAILABILITY_FILE = 'availability.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections(
  user_id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL UNIQUE,
  audience_json TEXT NOT NULL,
  detail TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges(
  user_id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface ConnectionRow {
  userId: string;
  calendarId: string;
  audience: AvailabilityAudience;
  detail: AvailabilityDetail;
  connectedAt: string;
  updatedAt: string;
}

/** A pending check that the calendar is the member's: an event the member puts in [slotStart, slotEnd). */
export interface ChallengeRow {
  userId: string;
  calendarId: string;
  slotStart: string;
  slotEnd: string;
  audience: AvailabilityAudience;
  detail: AvailabilityDetail;
  createdAt: string;
}

interface RawConnection {
  user_id: string;
  calendar_id: string;
  audience_json: string;
  detail: string;
  connected_at: string;
  updated_at: string;
}

interface RawChallenge {
  user_id: string;
  calendar_id: string;
  slot_start: string;
  slot_end: string;
  audience_json: string;
  detail: string;
  created_at: string;
}

const audienceOf = (json: string): AvailabilityAudience => {
  const o = JSON.parse(json) as Partial<AvailabilityAudience>;
  return { everyone: o.everyone === true, departments: Array.isArray(o.departments) ? o.departments.filter((d) => typeof d === 'string') : [], people: Array.isArray(o.people) ? o.people.filter((p) => typeof p === 'string') : [] };
};
const detailOf = (value: string): AvailabilityDetail => (value === 'blocks' ? 'blocks' : 'parts');

const connection = (r: RawConnection): ConnectionRow => ({ userId: r.user_id, calendarId: r.calendar_id, audience: audienceOf(r.audience_json), detail: detailOf(r.detail), connectedAt: r.connected_at, updatedAt: r.updated_at });
const challenge = (r: RawChallenge): ChallengeRow => ({ userId: r.user_id, calendarId: r.calendar_id, slotStart: r.slot_start, slotEnd: r.slot_end, audience: audienceOf(r.audience_json), detail: detailOf(r.detail), createdAt: r.created_at });

export class AvailabilityStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, AVAILABILITY_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('availability schema version');
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  connection(userId: string): ConnectionRow | null {
    const r = this.db.prepare('SELECT * FROM connections WHERE user_id=?').get(userId) as RawConnection | undefined;
    return r ? connection(r) : null;
  }

  connections(): ConnectionRow[] {
    return (this.db.prepare('SELECT * FROM connections ORDER BY connected_at, user_id').all() as unknown as RawConnection[]).map(connection);
  }

  /** The member who has connected this calendar, or null. */
  ownerOfCalendar(calendarId: string): string | null {
    const r = this.db.prepare('SELECT user_id FROM connections WHERE calendar_id=?').get(calendarId) as { user_id: string } | undefined;
    return r?.user_id ?? null;
  }

  challenge(userId: string): ChallengeRow | null {
    const r = this.db.prepare('SELECT * FROM challenges WHERE user_id=?').get(userId) as RawChallenge | undefined;
    return r ? challenge(r) : null;
  }

  putChallenge(row: ChallengeRow): void {
    this.db
      .prepare('INSERT INTO challenges(user_id,calendar_id,slot_start,slot_end,audience_json,detail,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET calendar_id=excluded.calendar_id, slot_start=excluded.slot_start, slot_end=excluded.slot_end, audience_json=excluded.audience_json, detail=excluded.detail, created_at=excluded.created_at')
      .run(row.userId, row.calendarId, row.slotStart, row.slotEnd, JSON.stringify(row.audience), row.detail, row.createdAt);
  }

  removeChallenge(userId: string): void {
    this.db.prepare('DELETE FROM challenges WHERE user_id=?').run(userId);
  }

  /**
   * Connects the calendar the challenge named and drops the challenge, in one transaction. 'taken': another member
   * connected the same calendar first (nothing changes).
   */
  connect(ch: ChallengeRow, now: string): ConnectionRow | 'taken' {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.ownerOfCalendar(ch.calendarId);
      if (owner !== null && owner !== ch.userId) {
        this.db.exec('ROLLBACK');
        return 'taken';
      }
      const before = this.connection(ch.userId);
      this.db.prepare('DELETE FROM connections WHERE user_id=?').run(ch.userId);
      this.db
        .prepare('INSERT INTO connections(user_id,calendar_id,audience_json,detail,connected_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(ch.userId, ch.calendarId, JSON.stringify(ch.audience), ch.detail, before && before.calendarId === ch.calendarId ? before.connectedAt : now, now);
      this.db.prepare('DELETE FROM challenges WHERE user_id=?').run(ch.userId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.connection(ch.userId)!;
  }

  /** Changes who may see and how coarse; null when the member has no connection. */
  updateSettings(userId: string, audience: AvailabilityAudience, detail: AvailabilityDetail, now: string): ConnectionRow | null {
    const res = this.db.prepare('UPDATE connections SET audience_json=?, detail=?, updated_at=? WHERE user_id=?').run(JSON.stringify(audience), detail, now, userId);
    return Number(res.changes) > 0 ? this.connection(userId) : null;
  }

  /** Removes the member's connection and any pending challenge. */
  disconnect(userId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM connections WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM challenges WHERE user_id=?').run(userId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
