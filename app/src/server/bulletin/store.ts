import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BULLETIN_FIELD_KEYS, type BulletinInput, type BulletinList, type BulletinStatus } from '../../shared/bulletin.js';
import { DomainError } from '../domain/types.js';

// Notice board (2026-11-11): one SQLite file (bulletin.sqlite3) next to mail.sqlite3, so the backups of the mail
// folder carry it. A notice is never deleted: it is open or withdrawn, and the days it is on the board are part of
// the notice. Every correction, withdrawal and return keeps the notice as it was before (before_json). Who has
// opened a notice is kept per person (reads); a notice is new for a person until they open it, and again after a
// correction that is announced (announced_at moves past their read).

export const BULLETIN_FILE = 'bulletin.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS posts(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  important INTEGER NOT NULL,
  departments_json TEXT NOT NULL,
  starts_on TEXT,
  ends_on TEXT,
  announced_at TEXT NOT NULL,
  client_token TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_token ON posts(client_token);
CREATE INDEX IF NOT EXISTS posts_days ON posts(status, ends_on, starts_on);
CREATE TABLE IF NOT EXISTS reads(post_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY(post_id, user_id));
CREATE INDEX IF NOT EXISTS reads_user ON reads(user_id);
CREATE TABLE IF NOT EXISTS post_history(id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, changed_json TEXT NOT NULL, before_json TEXT);
CREATE INDEX IF NOT EXISTS post_history_post ON post_history(post_id, id);
`;

/** The most notices one list reads from the file (the routes page what the person may see). */
const LIST_CAP = 2000;

export type BulletinAction = 'created' | 'updated' | 'withdrawn' | 'restored';

export interface BulletinRow {
  id: string;
  status: BulletinStatus;
  input: BulletinInput;
  announcedAt: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

interface RawRow {
  id: string;
  status: string;
  title: string;
  body: string;
  important: number;
  departments_json: string;
  starts_on: string | null;
  ends_on: string | null;
  announced_at: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** A write's answer: the row, or a reason it was refused (null: not found). */
export type BulletinOutcome = BulletinRow | 'conflict' | 'not_open' | 'not_withdrawn' | null;

const SAME_TOKEN_OTHER_CONTENT = '同じ送信がすでに保存されていて、内容が違うため保存できませんでした。一覧で保存された内容を確かめてください。内容を変えるときは、そのお知らせの「直す」を使ってください。';

export function changedBulletinFields(before: BulletinInput, after: BulletinInput): string[] {
  return BULLETIN_FIELD_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

const newId = () => `bb_${randomBytes(8).toString('hex')}`;

export class BulletinStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, BULLETIN_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('bulletin schema version');
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

  private static row(raw: RawRow): BulletinRow {
    return {
      id: raw.id,
      status: raw.status as BulletinStatus,
      input: {
        title: raw.title,
        body: raw.body,
        important: Number(raw.important) === 1,
        departments: JSON.parse(raw.departments_json) as string[],
        startsOn: raw.starts_on,
        endsOn: raw.ends_on,
      },
      announcedAt: raw.announced_at,
      version: Number(raw.version),
      createdAt: raw.created_at,
      createdBy: raw.created_by,
      updatedAt: raw.updated_at,
      updatedBy: raw.updated_by,
    };
  }

  private static snapshot(r: BulletinRow): string {
    return JSON.stringify({ status: r.status, input: r.input, announcedAt: r.announcedAt });
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM posts').get() as { n: number }).n);
  }

  get(id: string): BulletinRow | null {
    const raw = this.db.prepare('SELECT * FROM posts WHERE id=?').get(id) as unknown as RawRow | undefined;
    return raw ? BulletinStore.row(raw) : null;
  }

  private byToken(token: string): BulletinRow | null {
    const raw = this.db.prepare('SELECT * FROM posts WHERE client_token=?').get(token) as unknown as RawRow | undefined;
    return raw ? BulletinStore.row(raw) : null;
  }

  /**
   * The notices of one list on `today` (Japan date), whoever they are for; the caller keeps those the person may see.
   * current: 重要 first, then the newest announcement. scheduled: the nearest first day first. ended: the latest to
   * leave the board first (the last day of an ended one, the change of a withdrawn one).
   */
  list(list: BulletinList, today: string): BulletinRow[] {
    const sql =
      list === 'current'
        ? "SELECT * FROM posts WHERE status='open' AND (starts_on IS NULL OR starts_on <= $today) AND (ends_on IS NULL OR ends_on >= $today) ORDER BY important DESC, announced_at DESC, id DESC LIMIT $cap"
        : list === 'scheduled'
          ? "SELECT * FROM posts WHERE status='open' AND starts_on IS NOT NULL AND starts_on > $today ORDER BY starts_on, announced_at DESC, id DESC LIMIT $cap"
          : "SELECT * FROM posts WHERE status='withdrawn' OR (ends_on IS NOT NULL AND ends_on < $today) ORDER BY CASE WHEN status='withdrawn' THEN substr(updated_at, 1, 10) ELSE ends_on END DESC, updated_at DESC, id DESC LIMIT $cap";
    return (this.db.prepare(sql).all({ $today: today, $cap: LIST_CAP }) as unknown as RawRow[]).map(BulletinStore.row);
  }

  /** When this person last opened each notice (post id → UTC time). */
  readsOf(userId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT post_id, read_at FROM reads WHERE user_id=?').all(userId) as { post_id: string; read_at: string }[];
    return new Map(rows.map((r) => [r.post_id, r.read_at]));
  }

  /** The people who opened the notice at or after `since` (its last announcement). */
  readersSince(postId: string, since: string): string[] {
    return (this.db.prepare('SELECT user_id FROM reads WHERE post_id=? AND read_at >= ? ORDER BY user_id').all(postId, since) as { user_id: string }[]).map((r) => r.user_id);
  }

  /** Records that the person has opened these notices now. An earlier read is moved forward, never back. */
  markRead(postIds: string[], userId: string, now: string): void {
    if (postIds.length === 0) return;
    this.tx(() => {
      const stmt = this.db.prepare('INSERT INTO reads(post_id,user_id,read_at) VALUES(?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET read_at=excluded.read_at WHERE excluded.read_at > reads.read_at');
      for (const id of postIds) stmt.run(id, userId, now);
    });
  }

  history(id: string, limit = 50): { at: string; actorId: string; action: BulletinAction; changed: string[] }[] {
    const rows = this.db.prepare('SELECT at, actor_id, action, changed_json FROM post_history WHERE post_id=? ORDER BY id DESC LIMIT ?').all(id, limit) as { at: string; actor_id: string; action: string; changed_json: string }[];
    return rows.map((r) => ({ at: r.at, actorId: r.actor_id, action: r.action as BulletinAction, changed: JSON.parse(r.changed_json) as string[] }));
  }

  private addHistory(id: string, at: string, actorId: string, action: BulletinAction, changed: string[], before: string | null): void {
    this.db.prepare('INSERT INTO post_history(post_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,?,?,?)').run(id, at, actorId, action, JSON.stringify(changed), before);
  }

  private setRead(postId: string, userId: string, now: string): void {
    this.db.prepare('INSERT INTO reads(post_id,user_id,read_at) VALUES(?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET read_at=excluded.read_at').run(postId, userId, now);
  }

  /**
   * A new notice. The writer has read it. A token an earlier save used answers that notice (`replayed`) when the
   * content is the same, and is refused (409) when it differs, so a retry never makes a second notice.
   */
  create(input: BulletinInput, actorId: string, now: string, token: string | null): { row: BulletinRow; replayed: boolean } {
    return this.tx(() => {
      if (token !== null) {
        const same = this.byToken(token);
        if (same) {
          if (changedBulletinFields(same.input, input).length === 0) return { row: same, replayed: true };
          throw new DomainError('conflict', SAME_TOKEN_OTHER_CONTENT);
        }
      }
      const id = newId();
      this.db
        .prepare("INSERT INTO posts(id,status,title,body,important,departments_json,starts_on,ends_on,announced_at,client_token,version,created_at,created_by,updated_at,updated_by) VALUES(?,'open',?,?,?,?,?,?,?,?,1,?,?,?,?)")
        .run(id, input.title, input.body, input.important ? 1 : 0, JSON.stringify(input.departments), input.startsOn, input.endsOn, now, token, now, actorId, now, actorId);
      this.addHistory(id, now, actorId, 'created', [], null);
      this.setRead(id, actorId, now);
      return { row: this.get(id)!, replayed: false };
    });
  }

  /**
   * Corrects an open notice. With `announce` it is new again for everyone but the person who corrected it. Nothing
   * changed and no announcement leaves the version alone.
   */
  update(id: string, expectedVersion: number, input: BulletinInput, announce: boolean, actorId: string, now: string): BulletinOutcome {
    return this.tx((): BulletinOutcome => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      if (before.status !== 'open') return 'not_open';
      const changed = changedBulletinFields(before.input, input);
      if (changed.length === 0 && !announce) return before;
      this.db
        .prepare('UPDATE posts SET title=?,body=?,important=?,departments_json=?,starts_on=?,ends_on=?,announced_at=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?')
        .run(input.title, input.body, input.important ? 1 : 0, JSON.stringify(input.departments), input.startsOn, input.endsOn, announce ? now : before.announcedAt, now, actorId, id, expectedVersion);
      this.addHistory(id, now, actorId, 'updated', announce ? [...changed, 'announced'] : changed, BulletinStore.snapshot(before));
      if (announce) this.setRead(id, actorId, now);
      return this.get(id)!;
    });
  }

  /** Takes an open notice off the board (it stays in the file and can be put back). */
  withdraw(id: string, expectedVersion: number, actorId: string, now: string): BulletinOutcome {
    return this.tx((): BulletinOutcome => {
      const cur = this.get(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      if (cur.status !== 'open') return 'not_open';
      this.db.prepare("UPDATE posts SET status='withdrawn', version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?").run(now, actorId, id, expectedVersion);
      this.addHistory(id, now, actorId, 'withdrawn', ['status'], BulletinStore.snapshot(cur));
      return this.get(id)!;
    });
  }

  /** Puts a withdrawn notice back, with the days it had. Who had read it stays read. */
  restore(id: string, expectedVersion: number, actorId: string, now: string): BulletinOutcome {
    return this.tx((): BulletinOutcome => {
      const cur = this.get(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      if (cur.status !== 'withdrawn') return 'not_withdrawn';
      this.db.prepare("UPDATE posts SET status='open', version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?").run(now, actorId, id, expectedVersion);
      this.addHistory(id, now, actorId, 'restored', ['status'], BulletinStore.snapshot(cur));
      return this.get(id)!;
    });
  }
}
