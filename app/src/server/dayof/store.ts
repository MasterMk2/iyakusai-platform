import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DayOfPostInput, DayOfPostStatus, DayOfPriority } from '../../shared/dayof.js';
import { DomainError } from '../domain/types.js';

// Festival-day board (2026-11-03): one SQLite file (dayof.sqlite3) next to mail.sqlite3, so the backups of the mail
// folder carry it. It holds the period and the decision rules (one settings row with a version), who may post besides
// the access administrators (per person and per department), and the notices. Nothing is deleted: a notice is open,
// resolved or withdrawn, and every change keeps a history row with the record as it was before (before_json), so a
// mistake can be put back. Every write counts the board's revision up (the screens read it to see that something moved).

export const DAYOF_FILE = 'dayof.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(
  id INTEGER PRIMARY KEY CHECK(id = 1),
  start_date TEXT,
  end_date TEXT,
  rules TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS poster_grants(
  kind TEXT NOT NULL CHECK(kind IN ('user','department')),
  target TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY(kind, target)
);
CREATE TABLE IF NOT EXISTS admin_history(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS posts(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('open','resolved','withdrawn')),
  priority TEXT NOT NULL CHECK(priority IN ('urgent','important','normal')),
  body TEXT NOT NULL,
  place TEXT NOT NULL,
  departments_json TEXT NOT NULL,
  staff_visible INTEGER NOT NULL,
  client_token TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_token ON posts(client_token);
CREATE INDEX IF NOT EXISTS posts_status ON posts(status, created_at);
CREATE TABLE IF NOT EXISTS post_history(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, changed_json TEXT NOT NULL, before_json TEXT);
CREATE INDEX IF NOT EXISTS post_history_post ON post_history(post_id, id);
`;

export interface DayOfSettingsRow {
  startDate: string | null;
  endDate: string | null;
  rules: string;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface DayOfPostRow {
  id: string;
  status: DayOfPostStatus;
  input: DayOfPostInput;
  edited: boolean;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

interface RawPost {
  id: string;
  status: string;
  priority: string;
  body: string;
  place: string;
  departments_json: string;
  staff_visible: number;
  edited: number;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export type PostAction = 'created' | 'edited' | 'resolved' | 'reopened' | 'withdrawn' | 'restored';
export type StatusChange = 'resolve' | 'reopen' | 'withdraw' | 'restore';

/** A write's answer: the row, or why it was refused (null: not found). */
export type PostOutcome = DayOfPostRow | 'conflict' | 'not_allowed' | null;

export interface AdminHistoryRow {
  at: string;
  actorId: string;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
}

/** A retried post with the same token but other content: the first one is stored, so the second is refused. */
const SAME_TOKEN_OTHER_CONTENT = '同じ送信がすでに保存されていて、内容が違うため保存できませんでした。連絡板で保存された内容を確かめてください。';

const newId = () => `dp_${randomBytes(8).toString('hex')}`;

const INPUT_KEYS = ['body', 'priority', 'place', 'departments', 'staffVisible'] as const;

export function changedPostFields(before: DayOfPostInput, after: DayOfPostInput): string[] {
  return INPUT_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/** Which status a change moves a notice from, and to (a restore goes back to resolved when it had been resolved). */
const TRANSITIONS: Record<StatusChange, { from: DayOfPostStatus[]; action: PostAction }> = {
  resolve: { from: ['open'], action: 'resolved' },
  reopen: { from: ['resolved'], action: 'reopened' },
  withdraw: { from: ['open', 'resolved'], action: 'withdrawn' },
  restore: { from: ['withdrawn'], action: 'restored' },
};

export class DayOfStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, DAYOF_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('dayof schema version');
      this.db.prepare("INSERT OR IGNORE INTO settings(id,start_date,end_date,rules,version,updated_at,updated_by) VALUES(1,NULL,NULL,'',1,NULL,NULL)").run();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
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

  /** Counts up with every write; read by the screens to tell that the board moved. */
  revision(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='revision'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private bump(): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
  }

  // ---- settings: the period and the decision rules

  settings(): DayOfSettingsRow {
    const r = this.db.prepare('SELECT start_date, end_date, rules, version, updated_at, updated_by FROM settings WHERE id=1').get() as {
      start_date: string | null;
      end_date: string | null;
      rules: string;
      version: number;
      updated_at: string | null;
      updated_by: string | null;
    };
    return { startDate: r.start_date, endDate: r.end_date, rules: r.rules, version: Number(r.version), updatedAt: r.updated_at, updatedBy: r.updated_by };
  }

  /** Replaces the period and the rules. An old version is refused; nothing changed leaves the version alone. */
  saveSettings(next: { startDate: string | null; endDate: string | null; rules: string }, expectedVersion: number, actorId: string, now: string): DayOfSettingsRow | 'conflict' {
    return this.tx(() => {
      const before = this.settings();
      if (before.version !== expectedVersion) return 'conflict';
      if (before.startDate === next.startDate && before.endDate === next.endDate && before.rules === next.rules) return before;
      this.db.prepare('UPDATE settings SET start_date=?, end_date=?, rules=?, version=version+1, updated_at=?, updated_by=? WHERE id=1').run(next.startDate, next.endDate, next.rules, now, actorId);
      const was = { startDate: before.startDate, endDate: before.endDate, rules: before.rules };
      this.addAdminHistory(now, actorId, 'settings', '', was, next);
      this.bump();
      return this.settings();
    });
  }

  // ---- posters besides the access administrators

  posterGrants(): { users: string[]; departments: string[] } {
    const rows = this.db.prepare('SELECT kind, target FROM poster_grants ORDER BY kind, target').all() as { kind: 'user' | 'department'; target: string }[];
    return { users: rows.filter((r) => r.kind === 'user').map((r) => r.target), departments: rows.filter((r) => r.kind === 'department').map((r) => r.target) };
  }

  /** Grants or takes away; a change keeps a history row, a repeat changes nothing. */
  setPosterGrant(kind: 'user' | 'department', target: string, on: boolean, actorId: string, now: string): void {
    this.tx(() => {
      const had = this.db.prepare('SELECT 1 AS x FROM poster_grants WHERE kind=? AND target=?').get(kind, target) !== undefined;
      if (had === on) return;
      if (on) this.db.prepare('INSERT INTO poster_grants(kind,target,granted_by,granted_at) VALUES(?,?,?,?)').run(kind, target, actorId, now);
      else this.db.prepare('DELETE FROM poster_grants WHERE kind=? AND target=?').run(kind, target);
      this.addAdminHistory(now, actorId, `${on ? 'grant' : 'revoke'}_${kind}`, target, had, on);
      this.bump();
    });
  }

  private addAdminHistory(at: string, actorId: string, action: string, target: string, before: unknown, after: unknown): void {
    this.db.prepare('INSERT INTO admin_history(at,actor_id,action,target,before_json,after_json) VALUES(?,?,?,?,?,?)').run(at, actorId, action, target, JSON.stringify(before), JSON.stringify(after));
  }

  adminHistory(limit = 30): AdminHistoryRow[] {
    const rows = this.db.prepare('SELECT at, actor_id, action, target, before_json, after_json FROM admin_history ORDER BY id DESC LIMIT ?').all(limit) as {
      at: string;
      actor_id: string;
      action: string;
      target: string;
      before_json: string;
      after_json: string;
    }[];
    return rows.map((r) => ({ at: r.at, actorId: r.actor_id, action: r.action, target: r.target, before: JSON.parse(r.before_json) as unknown, after: JSON.parse(r.after_json) as unknown }));
  }

  // ---- notices

  private static row(raw: RawPost): DayOfPostRow {
    return {
      id: raw.id,
      status: raw.status as DayOfPostStatus,
      input: {
        body: raw.body,
        priority: raw.priority as DayOfPriority,
        place: raw.place,
        departments: JSON.parse(raw.departments_json) as string[],
        staffVisible: Number(raw.staff_visible) === 1,
      },
      edited: Number(raw.edited) === 1,
      version: Number(raw.version),
      createdAt: raw.created_at,
      createdBy: raw.created_by,
      updatedAt: raw.updated_at,
      updatedBy: raw.updated_by,
      resolvedAt: raw.resolved_at,
      resolvedBy: raw.resolved_by,
    };
  }

  /** The record as it stood, for before_json. */
  private static snapshot(r: DayOfPostRow): string {
    return JSON.stringify({ status: r.status, input: r.input, resolvedAt: r.resolvedAt, resolvedBy: r.resolvedBy });
  }

  get(id: string): DayOfPostRow | null {
    const raw = this.db.prepare('SELECT * FROM posts WHERE id=?').get(id) as unknown as RawPost | undefined;
    return raw ? DayOfStore.row(raw) : null;
  }

  private byToken(token: string): DayOfPostRow | null {
    const raw = this.db.prepare('SELECT * FROM posts WHERE client_token=?').get(token) as unknown as RawPost | undefined;
    return raw ? DayOfStore.row(raw) : null;
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM posts').get() as { n: number }).n);
  }

  /**
   * The notices of the board, among those written since `periodStart` (a notice of an earlier period, a trial run or
   * last year's festival, stays in the file but is not carried into this one): the open ones, the ones resolved since
   * `dayStart`, and, for the posters, the ones withdrawn since then (they can be put back).
   */
  board(range: { dayStart: string; periodStart: string }, limit: number): { posts: DayOfPostRow[]; withdrawn: DayOfPostRow[] } {
    const { dayStart, periodStart } = range;
    const open = this.db.prepare("SELECT * FROM posts WHERE status='open' AND created_at >= ? ORDER BY created_at DESC, id DESC").all(periodStart) as unknown as RawPost[];
    const resolved = this.db.prepare("SELECT * FROM posts WHERE status='resolved' AND resolved_at >= ? AND created_at >= ? ORDER BY resolved_at DESC, id DESC LIMIT ?").all(dayStart, periodStart, limit) as unknown as RawPost[];
    const withdrawn = this.db.prepare("SELECT * FROM posts WHERE status='withdrawn' AND updated_at >= ? AND created_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(dayStart, periodStart, limit) as unknown as RawPost[];
    return { posts: [...open, ...resolved].map(DayOfStore.row), withdrawn: withdrawn.map(DayOfStore.row) };
  }

  history(id: string, limit = 50): { at: string; actorId: string; action: PostAction; changed: string[] }[] {
    const rows = this.db.prepare('SELECT at, actor_id, action, changed_json FROM post_history WHERE post_id=? ORDER BY id DESC LIMIT ?').all(id, limit) as { at: string; actor_id: string; action: string; changed_json: string }[];
    return rows.map((r) => ({ at: r.at, actorId: r.actor_id, action: r.action as PostAction, changed: JSON.parse(r.changed_json) as string[] }));
  }

  private addHistory(id: string, at: string, actorId: string, action: PostAction, changed: string[], before: string | null): void {
    this.db.prepare('INSERT INTO post_history(post_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,?,?,?)').run(id, at, actorId, action, JSON.stringify(changed), before);
  }

  /**
   * A new open notice. A token an earlier post used answers that post (`replayed`) when the content is the same,
   * and is refused (409) when it differs, so a retry after a lost answer never posts twice.
   */
  create(input: DayOfPostInput, actorId: string, now: string, token: string | null): { row: DayOfPostRow; replayed: boolean } {
    return this.tx(() => {
      if (token !== null) {
        const same = this.byToken(token);
        if (same) {
          if (changedPostFields(same.input, input).length === 0) return { row: same, replayed: true };
          throw new DomainError('conflict', SAME_TOKEN_OTHER_CONTENT);
        }
      }
      const id = newId();
      this.db
        .prepare(
          "INSERT INTO posts(id,status,priority,body,place,departments_json,staff_visible,client_token,edited,version,created_at,created_by,updated_at,updated_by,resolved_at,resolved_by) VALUES(?,'open',?,?,?,?,?,?,0,1,?,?,?,?,NULL,NULL)",
        )
        .run(id, input.priority, input.body, input.place, JSON.stringify(input.departments), input.staffVisible ? 1 : 0, token, now, actorId, now, actorId);
      this.addHistory(id, now, actorId, 'created', [], null);
      this.bump();
      return { row: this.get(id)!, replayed: false };
    });
  }

  /** Corrects an open notice. A resolved or withdrawn one is not edited (reopen or restore it first). */
  update(id: string, expectedVersion: number, input: DayOfPostInput, actorId: string, now: string): PostOutcome {
    return this.tx((): PostOutcome => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      if (before.status !== 'open') return 'not_allowed';
      const changed = changedPostFields(before.input, input);
      if (changed.length === 0) return before;
      this.db
        .prepare('UPDATE posts SET priority=?, body=?, place=?, departments_json=?, staff_visible=?, edited=1, version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?')
        .run(input.priority, input.body, input.place, JSON.stringify(input.departments), input.staffVisible ? 1 : 0, now, actorId, id, expectedVersion);
      this.addHistory(id, now, actorId, 'edited', changed, DayOfStore.snapshot(before));
      this.bump();
      return this.get(id)!;
    });
  }

  /** Resolves, reopens, withdraws or restores a notice. A restore returns it to where it was (open or resolved). */
  changeStatus(id: string, change: StatusChange, expectedVersion: number, actorId: string, now: string): PostOutcome {
    return this.tx((): PostOutcome => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      const rule = TRANSITIONS[change];
      if (!rule.from.includes(before.status)) return 'not_allowed';
      let next: DayOfPostStatus;
      let resolvedAt = before.resolvedAt;
      let resolvedBy = before.resolvedBy;
      if (change === 'resolve') {
        next = 'resolved';
        resolvedAt = now;
        resolvedBy = actorId;
      } else if (change === 'reopen') {
        next = 'open';
        resolvedAt = null;
        resolvedBy = null;
      } else if (change === 'withdraw') {
        next = 'withdrawn';
      } else {
        next = before.resolvedAt ? 'resolved' : 'open';
      }
      this.db.prepare('UPDATE posts SET status=?, resolved_at=?, resolved_by=?, version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?').run(next, resolvedAt, resolvedBy, now, actorId, id, expectedVersion);
      this.addHistory(id, now, actorId, rule.action, ['status'], DayOfStore.snapshot(before));
      this.bump();
      return this.get(id)!;
    });
  }
}
