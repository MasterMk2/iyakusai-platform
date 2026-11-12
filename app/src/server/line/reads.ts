import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Where each person last read each official LINE conversation (2026-11-13), so a conversation opens just below that
// place on every device (the screen's "ここから未読"). One SQLite file beside line-state.json (the mail folder in
// production, so its backup carries it), apart from the LINE state so opening a conversation never rewrites that file.
// A place is the time of the newest row the person had on the screen; it only moves forward. Nothing goes to LINE:
// the person who wrote sees no 既読. Only the person themself reads their own places.
// "since" (2026-11-13) is when this file began to be used for unread counts: a conversation a person has no place in
// counts as read up to then, so the lists do not light up with every old conversation, and a new person's first
// message still counts. It is written once (a file from before it gets the time of the first start that reads it).

export const LINE_READS_FILE = 'line-reads.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reads(user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, read_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, conversation_id));
`;

export class LineReadStore {
  readonly db: DatabaseSync;

  #since: string;

  constructor(
    readonly root: string,
    now: string,
  ) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, LINE_READS_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('line reads schema version');
      this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('since',?)").run(new Date(Date.parse(now)).toISOString());
      this.#since = (this.db.prepare("SELECT value FROM meta WHERE key='since'").get() as { value: string }).value;
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Rows up to this time count as read for a conversation a person has no place in (an ISO time in UTC). */
  get since(): string {
    return this.#since;
  }

  /** The person's place, or `since` when they have none: what the unread count and the screen's line start from. */
  placeOf(userId: string, conversationId: string): string {
    return this.get(userId, conversationId) ?? this.#since;
  }

  /** The person's place in the conversation (an ISO time in UTC), or null when they have none. */
  get(userId: string, conversationId: string): string | null {
    const row = this.db.prepare('SELECT read_at FROM reads WHERE user_id=? AND conversation_id=?').get(userId, conversationId) as { read_at: string } | undefined;
    return row?.read_at ?? null;
  }

  /** Every place the person has, by conversation (one query for a list). */
  placesOf(userId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT conversation_id, read_at FROM reads WHERE user_id=?').all(userId) as { conversation_id: string; read_at: string }[];
    return new Map(rows.map((r) => [r.conversation_id, r.read_at]));
  }

  /** Moves the place forward to `at` (never back) and returns the place kept. Times are ISO strings in UTC. */
  advance(userId: string, conversationId: string, at: string, now: string): string {
    this.db
      .prepare(
        `INSERT INTO reads(user_id, conversation_id, read_at, updated_at) VALUES(?,?,?,?)
         ON CONFLICT(user_id, conversation_id) DO UPDATE SET read_at=excluded.read_at, updated_at=excluded.updated_at WHERE excluded.read_at > reads.read_at`,
      )
      .run(userId, conversationId, at, now);
    return this.get(userId, conversationId)!;
  }

  /** Forgets every place and starts counting from `now` (the demo's sample reset). */
  clear(now: string): void {
    this.db.exec('DELETE FROM reads');
    this.db.prepare("UPDATE meta SET value=? WHERE key='since'").run(new Date(Date.parse(now)).toISOString());
    this.#since = new Date(Date.parse(now)).toISOString();
  }
}

/** Opens the places beside the LINE state; a file that cannot be opened only turns the sharing off (each device keeps its own). */
export function openLineReads(root: string, now: string): LineReadStore | null {
  try {
    return new LineReadStore(root, now);
  } catch {
    console.error('公式LINE の既読の位置の保存ファイル（line-reads.sqlite3）を開けないか、形式が正しくないため、端末をまたいだ既読の位置だけを止めました。ファイルは変更していません。ほかの機能は動きます。');
    return null;
  }
}
