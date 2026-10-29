import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Address, HandlingStatus } from '../../shared/api.js';
import type { ParsedMail } from './parse.js';
import { isSignInMail } from './restricted.js';

// The committee mailbox: one SQLite file (mail.sqlite3) and the attachment files, stored once per
// content (attachments/<2 hex>/<sha256>). One message is stored once, keyed by its Message-ID, and
// linked to every committee mailbox it belongs to; handling (status, assignee, labels, notes) belongs
// to the message, so it is the same in every mailbox that shows it.

/** `sent`: mail sent from the app, stored when the mail server accepted it (its Gmail copy links to it later). */
export type MailSource = 'collector' | 'backfill' | 'sent';

export interface MessageRow {
  id: string;
  internet_message_id: string;
  thread_key: string;
  thread_id: string;
  subject: string;
  from_name: string | null;
  from_address: string;
  to_json: string;
  cc_json: string;
  sent_at: string;
  received_at: string;
  text: string;
  html: string | null;
  references_json: string;
  status: HandlingStatus;
  assignee_id: string | null;
  labels_json: string;
  version: number;
}

export interface AttachmentRow {
  message_id: string;
  idx: number;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
}

export interface NoteRow {
  id: string;
  message_id: string;
  author_id: string;
  created_at: string;
  body: string;
}

export interface HistoryRow {
  id: number;
  message_id: string;
  at: string;
  actor_id: string;
  action: 'assignee' | 'status' | 'labels' | 'note_added';
  from_value: string | null;
  to_value: string | null;
}

/** Handling state of one message without its addresses, body or attachment names (the Bot's data source). */
export interface HandlingRow {
  id: string;
  thread_id: string;
  subject: string;
  from_name: string | null;
  sent_at: string;
  received_at: string;
  status: HandlingStatus;
  assignee_id: string | null;
  labels_json: string;
  attachments: number;
  /** 1 for sign-in mail (restricted.ts): its subject is not shown outside the mailbox's administrators. */
  sign_in: number;
}

export interface HandlingNote {
  author_id: string;
  created_at: string;
  body: string;
}

export interface ListFilter {
  /** Messages linked to any of these mailboxes. */
  mailboxIds: string[];
  terms: string[];
  status?: HandlingStatus;
  label?: string;
  /** A user ID, or 'none' for no assignee. */
  assignee?: string;
  /** Search terms do not look into sign-in mail (for readers who are not access administrators). */
  termsSkipSignIn?: boolean;
}

export interface StoreInput {
  source: MailSource;
  providerId: string;
  receivedAt: string;
  parsed: ParsedMail;
  mailboxIds: string[];
  now: string;
  /** Handling status of a newly stored message (default 未対応; the committee's own sent mail is 完了). */
  status?: HandlingStatus;
}

/** One send from the app. Addresses and text are in the stored message; only BCC (not kept there) is here. */
export interface OutgoingRow {
  id: string;
  client_token: string;
  user_id: string;
  mailbox_id: string;
  internet_message_id: string;
  reply_to_id: string | null;
  recipients: number;
  bcc_json: string;
  size: number;
  /** sending → sent, failed (not taken by the server: may be sent again) or unknown (may have been sent). */
  status: 'sending' | 'sent' | 'failed' | 'unknown';
  error: string | null;
  message_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export type StoreOutcome = { status: 'stored' | 'linked' | 'duplicate'; id: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  internet_message_id TEXT NOT NULL UNIQUE,
  thread_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  from_name TEXT,
  from_address TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  text TEXT NOT NULL,
  html TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unhandled',
  assignee_id TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  stored_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS messages_thread_key ON messages(thread_key);
CREATE INDEX IF NOT EXISTS messages_received ON messages(received_at);
CREATE TABLE IF NOT EXISTS message_mailboxes(message_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, PRIMARY KEY(message_id, mailbox_id));
CREATE INDEX IF NOT EXISTS message_mailboxes_mailbox ON message_mailboxes(mailbox_id, message_id);
CREATE TABLE IF NOT EXISTS sources(source TEXT NOT NULL, provider_id TEXT NOT NULL, message_id TEXT NOT NULL, received_at TEXT NOT NULL, stored_at TEXT NOT NULL, PRIMARY KEY(source, provider_id));
CREATE TABLE IF NOT EXISTS attachments(message_id TEXT NOT NULL, idx INTEGER NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, disposition TEXT, content_id TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(message_id, idx));
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notes_message ON notes(message_id, created_at);
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, from_value TEXT, to_value TEXT);
CREATE INDEX IF NOT EXISTS history_message ON history(message_id, id);
CREATE TABLE IF NOT EXISTS grants(user_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(user_id, mailbox_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ingest_nonces(digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mail_use(session_key TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS send_grants(user_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(user_id, mailbox_id));
CREATE TABLE IF NOT EXISTS outgoing(id TEXT PRIMARY KEY, client_token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, internet_message_id TEXT NOT NULL, reply_to_id TEXT, recipients INTEGER NOT NULL, bcc_json TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, message_id TEXT, created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS outgoing_user ON outgoing(user_id, created_at);
CREATE TABLE IF NOT EXISTS department_grants(department TEXT NOT NULL, mailbox_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('edit','send')), granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(department, mailbox_id, kind));
`;
// Sending and department grants (2026-10-26) only added tables: an older version of the app still opens the file (schema 1).

const SCHEMA_VERSION = '1';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export const messageIdFor = (internetMessageId: string) => `rc_${sha256(`message|${internetMessageId}`).slice(0, 16)}`;
export const threadIdFor = (threadKey: string) => `th_${sha256(`thread|${threadKey}`).slice(0, 16)}`;

export function normalizeForSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function searchText(p: ParsedMail): string {
  const people = (list: Address[]) => list.flatMap((a) => [a.name ?? '', a.address]);
  return normalizeForSearch([p.subject, ...people([p.from]), ...people(p.to), ...people(p.cc), p.text, ...p.attachments.map((a) => a.filename)].join('\n'));
}

export class MailboxStore {
  readonly db: DatabaseSync;
  readonly attachmentDir: string;

  constructor(
    readonly root: string,
    /** Senders whose every message is sign-in mail (restrictedSenderDomains of the configuration). */
    private readonly signInSenders: readonly string[] = [],
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.attachmentDir = path.join(root, 'attachments');
    mkdirSync(this.attachmentDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, 'mail.sqlite3'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    // Decided when read, not stored: a changed rule or sender list applies to the mail already kept.
    this.db.function('sign_in_mail', { deterministic: true }, (subject, from, text) => (isSignInMail(String(subject), String(from), String(text), this.signInSenders) ? 1 : 0));
    this.db.exec(SCHEMA);
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
    if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
    else if (version.value !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error('mail.sqlite3 の形式がこのアプリと合いません。');
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in one write transaction; any error rolls everything back. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- attachments on disk (written before the rows that name them; an unreferenced file is harmless)

  private attachmentPath(hash: string): string {
    return path.join(this.attachmentDir, hash.slice(0, 2), hash);
  }

  private writeAttachment(content: Buffer): string {
    const hash = sha256(content);
    const target = this.attachmentPath(hash);
    if (existsSync(target) && statSync(target).size === content.length) return hash;
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${randomBytes(8).toString('hex')}`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, target);
    } catch (err) {
      unlinkSync(tmp);
      throw err;
    }
    return hash;
  }

  readAttachment(row: AttachmentRow): Buffer {
    const content = readFileSync(this.attachmentPath(row.sha256));
    if (content.length !== row.size || sha256(content) !== row.sha256) throw new Error('添付ファイルの内容が記録と一致しません。');
    return content;
  }

  /** Attachment files the database refers to (for backups). */
  attachmentFiles(): { relative: string; sha256: string; size: number }[] {
    return (this.db.prepare('SELECT DISTINCT sha256, size FROM attachments ORDER BY sha256').all() as { sha256: string; size: number }[]).map((r) => ({
      relative: path.posix.join('attachments', r.sha256.slice(0, 2), r.sha256),
      sha256: r.sha256,
      size: r.size,
    }));
  }

  // ---- ingest

  sourceMessage(source: MailSource, providerId: string): string | null {
    const row = this.db.prepare('SELECT message_id FROM sources WHERE source=? AND provider_id=?').get(source, providerId) as { message_id: string } | undefined;
    return row?.message_id ?? null;
  }

  /**
   * Stores one message (or links an already stored copy of it to more mailboxes). Idempotent on the
   * source's own message ID and on the Message-ID: the first copy's content is kept, and its
   * handling, notes and history are never touched by a later copy.
   */
  store(input: StoreInput): StoreOutcome {
    const known = this.sourceMessage(input.source, input.providerId);
    if (known) return { status: 'duplicate', id: known };
    const p = input.parsed;
    const internetId = p.messageId ?? `noid:${input.source}:${input.providerId}`;
    const id = messageIdFor(internetId);
    const exists = !!this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(id);
    // Files first: the transaction below only names files that are already on disk.
    const hashes = exists ? [] : p.attachments.map((a) => this.writeAttachment(a.content));
    return this.tx(() => {
      let status: StoreOutcome['status'] = 'linked';
      if (!this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(id)) {
        status = 'stored';
        // Thread: the root named by References (else In-Reply-To, else itself); a root already stored
        // under another thread brings this message into that thread.
        const candidate = p.references[0] ?? p.inReplyTo ?? internetId;
        const root = this.db.prepare('SELECT thread_key FROM messages WHERE internet_message_id=?').get(candidate) as { thread_key: string } | undefined;
        const threadKey = root?.thread_key ?? candidate;
        const threadId = threadIdFor(threadKey);
        this.db
          .prepare(
            `INSERT INTO messages(id,internet_message_id,thread_key,thread_id,subject,from_name,from_address,to_json,cc_json,sent_at,received_at,text,html,in_reply_to,references_json,search_text,status,stored_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(id, internetId, threadKey, threadId, p.subject, p.from.name, p.from.address, JSON.stringify(p.to), JSON.stringify(p.cc), p.date ?? input.receivedAt, input.receivedAt, p.text, p.html, p.inReplyTo, JSON.stringify(p.references), searchText(p), input.status ?? 'unhandled', input.now);
        // Replies that arrived first and were filed under this message join its thread.
        if (threadKey !== internetId) this.db.prepare('UPDATE messages SET thread_key=?, thread_id=? WHERE thread_key=?').run(threadKey, threadId, internetId);
        const insert = this.db.prepare('INSERT INTO attachments(message_id,idx,filename,content_type,disposition,content_id,size,sha256) VALUES(?,?,?,?,?,?,?,?)');
        p.attachments.forEach((a, i) => insert.run(id, i + 1, a.filename, a.contentType, a.disposition, a.contentId, a.content.length, hashes[i]!));
      }
      const link = this.db.prepare('INSERT OR IGNORE INTO message_mailboxes(message_id,mailbox_id) VALUES(?,?)');
      for (const mailboxId of input.mailboxIds) link.run(id, mailboxId);
      this.db.prepare('INSERT INTO sources(source,provider_id,message_id,received_at,stored_at) VALUES(?,?,?,?,?)').run(input.source, input.providerId, id, input.receivedAt, input.now);
      return { status, id };
    });
  }

  /** A signed request's nonce is accepted once. Expired nonces are forgotten. */
  acceptNonce(digest: string, expiresAt: number, now: number): boolean {
    return this.tx(() => {
      this.db.prepare('DELETE FROM ingest_nonces WHERE expires_at <= ?').run(now);
      if (this.db.prepare('SELECT 1 FROM ingest_nonces WHERE digest=?').get(digest)) return false;
      this.db.prepare('INSERT INTO ingest_nonces(digest,expires_at) VALUES(?,?)').run(digest, expiresAt);
      return true;
    });
  }

  ingestSummary(): { messages: number; latestStoredAt: string | null; sources: Record<string, number> } {
    const messages = Number((this.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n);
    const latest = this.db.prepare('SELECT max(stored_at) AS at FROM sources').get() as { at: string | null };
    const sources = Object.fromEntries((this.db.prepare('SELECT source, count(*) AS n FROM sources GROUP BY source').all() as { source: string; n: number }[]).map((r) => [r.source, Number(r.n)]));
    return { messages, latestStoredAt: latest.at, sources };
  }

  // ---- mail use per signed-in session (the idle limit of the mail screens)

  lastUse(sessionKey: string): number | null {
    const row = this.db.prepare('SELECT last_used_at FROM mail_use WHERE session_key=?').get(sessionKey) as { last_used_at: number } | undefined;
    return row ? Number(row.last_used_at) : null;
  }

  recordUse(sessionKey: string, at: number, forgetBefore: number): void {
    this.db.prepare('INSERT INTO mail_use(session_key,last_used_at) VALUES(?,?) ON CONFLICT(session_key) DO UPDATE SET last_used_at=excluded.last_used_at').run(sessionKey, at);
    this.db.prepare('DELETE FROM mail_use WHERE last_used_at < ?').run(forgetBefore);
  }

  // ---- reads

  private scope(alias: string, f: ListFilter, withMatch: boolean): { sql: string; params: (string | number)[] } {
    const parts = [`EXISTS (SELECT 1 FROM message_mailboxes mm WHERE mm.message_id = ${alias}.id AND mm.mailbox_id IN (${f.mailboxIds.map(() => '?').join(',') || "''"}))`];
    const params: (string | number)[] = [...f.mailboxIds];
    if (withMatch) {
      if (f.status) {
        parts.push(`${alias}.status = ?`);
        params.push(f.status);
      }
      if (f.label) {
        parts.push(`EXISTS (SELECT 1 FROM json_each(${alias}.labels_json) j WHERE j.value = ?)`);
        params.push(f.label);
      }
      if (f.assignee === 'none') parts.push(`${alias}.assignee_id IS NULL`);
      else if (f.assignee) {
        parts.push(`${alias}.assignee_id = ?`);
        params.push(f.assignee);
      }
      for (const t of f.terms) {
        parts.push(`instr(${alias}.search_text, ?) > 0`);
        params.push(t);
      }
      // Otherwise a search for a guessed code would tell whether a hidden message holds it.
      if (f.terms.length > 0 && f.termsSkipSignIn) parts.push(`sign_in_mail(${alias}.subject, ${alias}.from_address, ${alias}.text) = 0`);
    }
    return { sql: parts.join(' AND '), params };
  }

  /** Threads with a matching message, newest activity first. */
  threadPage(f: ListFilter, limit: number, offset: number): { total: number; threads: { thread_id: string; latest: string }[] } {
    const all = this.scope('m', f, false);
    const match = this.scope('m2', f, true);
    const counted = this.scope('m', f, true);
    const total = Number((this.db.prepare(`SELECT count(DISTINCT m.thread_id) AS n FROM messages m WHERE ${counted.sql}`).get(...counted.params) as { n: number }).n);
    const threads = this.db
      .prepare(
        `SELECT m.thread_id AS thread_id, max(m.received_at) AS latest FROM messages m
         WHERE ${all.sql} AND m.thread_id IN (SELECT m2.thread_id FROM messages m2 WHERE ${match.sql})
         GROUP BY m.thread_id ORDER BY latest DESC, m.thread_id LIMIT ? OFFSET ?`,
      )
      .all(...all.params, ...match.params, limit, offset) as { thread_id: string; latest: string }[];
    return { total, threads };
  }

  /** Messages of these threads within the filter's mailboxes; `matching` narrows to the filter. */
  threadMessages(f: ListFilter, threadIds: string[], matching: boolean): MessageRow[] {
    if (threadIds.length === 0) return [];
    const where = this.scope('m', f, matching);
    return this.db
      .prepare(`SELECT m.* FROM messages m WHERE ${where.sql} AND m.thread_id IN (${threadIds.map(() => '?').join(',')}) ORDER BY m.received_at, m.id`)
      .all(...where.params, ...threadIds) as unknown as MessageRow[];
  }

  message(id: string): MessageRow | null {
    return (this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as MessageRow | undefined) ?? null;
  }

  isSignInMail(row: Pick<MessageRow, 'subject' | 'from_address' | 'text'>): boolean {
    return isSignInMail(row.subject, row.from_address, row.text, this.signInSenders);
  }

  /** Mailbox links of these messages. */
  links(messageIds: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (messageIds.length === 0) return out;
    const rows = this.db.prepare(`SELECT message_id, mailbox_id FROM message_mailboxes WHERE message_id IN (${messageIds.map(() => '?').join(',')})`).all(...messageIds) as { message_id: string; mailbox_id: string }[];
    for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), r.mailbox_id]);
    return out;
  }

  attachments(messageId: string): AttachmentRow[] {
    return this.db.prepare('SELECT message_id, idx, filename, content_type, size, sha256 FROM attachments WHERE message_id=? ORDER BY idx').all(messageId) as unknown as AttachmentRow[];
  }

  notes(messageId: string): NoteRow[] {
    return this.db.prepare('SELECT * FROM notes WHERE message_id=? ORDER BY created_at, id').all(messageId) as unknown as NoteRow[];
  }

  history(messageId: string): HistoryRow[] {
    return this.db.prepare('SELECT * FROM history WHERE message_id=? ORDER BY id').all(messageId) as unknown as HistoryRow[];
  }

  mailboxCounts(): Map<string, { threads: number; unhandled: number }> {
    const rows = this.db
      .prepare(
        `SELECT mm.mailbox_id AS mailbox_id, count(DISTINCT m.thread_id) AS threads, sum(CASE WHEN m.status='unhandled' THEN 1 ELSE 0 END) AS unhandled
         FROM message_mailboxes mm JOIN messages m ON m.id = mm.message_id GROUP BY mm.mailbox_id`,
      )
      .all() as { mailbox_id: string; threads: number; unhandled: number }[];
    return new Map(rows.map((r) => [r.mailbox_id, { threads: Number(r.threads), unhandled: Number(r.unhandled ?? 0) }]));
  }

  /**
   * Read-only: the newest `limit` messages in these mailboxes (received, newest first) with their handling
   * state, notes and mailbox links. Only the columns above are selected, so addresses and bodies cannot leak.
   */
  handlingOverview(mailboxIds: string[], limit: number): { messages: HandlingRow[]; notes: Map<string, HandlingNote[]>; links: Map<string, string[]> } {
    const where = this.scope('m', { mailboxIds, terms: [] }, false);
    const order = 'ORDER BY m.received_at DESC, m.id';
    const newest = `SELECT m.id FROM messages m WHERE ${where.sql} ${order} LIMIT ?`;
    const params = [...where.params, limit];
    const messages = this.db
      .prepare(
        `SELECT m.id, m.thread_id, m.subject, m.from_name, m.sent_at, m.received_at, m.status, m.assignee_id, m.labels_json,
                (SELECT count(*) FROM attachments a WHERE a.message_id = m.id) AS attachments,
                sign_in_mail(m.subject, m.from_address, m.text) AS sign_in
         FROM messages m WHERE ${where.sql} ${order} LIMIT ?`,
      )
      .all(...params) as unknown as HandlingRow[];
    const notes = new Map<string, HandlingNote[]>();
    const noteRows = this.db
      .prepare(`SELECT message_id, author_id, created_at, body FROM notes WHERE message_id IN (${newest}) ORDER BY created_at, id`)
      .all(...params) as { message_id: string; author_id: string; created_at: string; body: string }[];
    for (const r of noteRows) notes.set(r.message_id, [...(notes.get(r.message_id) ?? []), { author_id: r.author_id, created_at: r.created_at, body: r.body }]);
    const links = new Map<string, string[]>();
    const linkRows = this.db.prepare(`SELECT message_id, mailbox_id FROM message_mailboxes WHERE message_id IN (${newest})`).all(...params) as { message_id: string; mailbox_id: string }[];
    for (const r of linkRows) links.set(r.message_id, [...(links.get(r.message_id) ?? []), r.mailbox_id]);
    return { messages: messages.map((m) => ({ ...m, attachments: Number(m.attachments), sign_in: Number(m.sign_in) })), notes, links };
  }

  unhandledMessages(mailboxIds: string[]): number {
    const where = this.scope('m', { mailboxIds, terms: [], status: 'unhandled' }, true);
    return Number((this.db.prepare(`SELECT count(*) AS n FROM messages m WHERE ${where.sql}`).get(...where.params) as { n: number }).n);
  }

  labelCounts(mailboxIds: string[]): { label: string; count: number }[] {
    const where = this.scope('m', { mailboxIds, terms: [] }, false);
    return (this.db
      .prepare(`SELECT j.value AS label, count(*) AS n FROM messages m, json_each(m.labels_json) j WHERE ${where.sql} GROUP BY j.value`)
      .all(...where.params) as { label: string; n: number }[]).map((r) => ({ label: r.label, count: Number(r.n) }));
  }

  // ---- handling

  updateTriage(id: string, expectedVersion: number, next: { status: HandlingStatus; assigneeId: string | null; labels: string[] }, history: { action: HistoryRow['action']; from: string | null; to: string | null }[], actorId: string, now: string): boolean {
    return this.tx(() => {
      const changed = this.db
        .prepare('UPDATE messages SET status=?, assignee_id=?, labels_json=?, version=version+1 WHERE id=? AND version=?')
        .run(next.status, next.assigneeId, JSON.stringify(next.labels), id, expectedVersion);
      if (Number(changed.changes) !== 1) return false;
      const insert = this.db.prepare('INSERT INTO history(message_id,at,actor_id,action,from_value,to_value) VALUES(?,?,?,?,?,?)');
      for (const h of history) insert.run(id, now, actorId, h.action, h.from, h.to);
      return true;
    });
  }

  /**
   * Sets the status of every message of a thread within the filter's mailboxes, with a history row per
   * changed message. Read and written in one transaction. The number changed, or null for no such thread.
   */
  setThreadStatus(f: ListFilter, threadId: string, status: HandlingStatus, labelOf: (s: HandlingStatus) => string, actorId: string, now: string): number | null {
    return this.tx(() => {
      const messages = this.threadMessages(f, [threadId], false);
      if (messages.length === 0) return null;
      const update = this.db.prepare('UPDATE messages SET status=?, version=version+1 WHERE id=?');
      const insert = this.db.prepare("INSERT INTO history(message_id,at,actor_id,action,from_value,to_value) VALUES(?,?,?,'status',?,?)");
      const changing = messages.filter((m) => m.status !== status);
      for (const m of changing) {
        update.run(status, m.id);
        insert.run(m.id, now, actorId, labelOf(m.status), labelOf(status));
      }
      return changing.length;
    });
  }

  addNote(messageId: string, authorId: string, body: string, now: string): NoteRow {
    return this.tx(() => {
      const note: NoteRow = { id: `note_${randomBytes(8).toString('hex')}`, message_id: messageId, author_id: authorId, created_at: now, body };
      this.db.prepare('INSERT INTO notes(id,message_id,author_id,created_at,body) VALUES(?,?,?,?,?)').run(note.id, messageId, authorId, now, body);
      this.db.prepare("INSERT INTO history(message_id,at,actor_id,action,from_value,to_value) VALUES(?,?,?,'note_added',NULL,NULL)").run(messageId, now, authorId);
      return note;
    });
  }

  // ---- edit grants (per mailbox)

  grants(): { user_id: string; mailbox_id: string }[] {
    return this.db.prepare('SELECT user_id, mailbox_id FROM grants ORDER BY user_id, mailbox_id').all() as { user_id: string; mailbox_id: string }[];
  }

  editMailboxesOf(userId: string): Set<string> {
    return new Set((this.db.prepare('SELECT mailbox_id FROM grants WHERE user_id=?').all(userId) as { mailbox_id: string }[]).map((r) => r.mailbox_id));
  }

  editorsOf(mailboxIds: string[]): Set<string> {
    if (mailboxIds.length === 0) return new Set();
    return new Set((this.db.prepare(`SELECT DISTINCT user_id FROM grants WHERE mailbox_id IN (${mailboxIds.map(() => '?').join(',')})`).all(...mailboxIds) as { user_id: string }[]).map((r) => r.user_id));
  }

  setGrant(userId: string, mailboxId: string, edit: boolean, actorId: string, now: string): void {
    this.tx(() => {
      if (edit) this.db.prepare('INSERT OR IGNORE INTO grants(user_id,mailbox_id,granted_by,granted_at) VALUES(?,?,?,?)').run(userId, mailboxId, actorId, now);
      else this.db.prepare('DELETE FROM grants WHERE user_id=? AND mailbox_id=?').run(userId, mailboxId);
      this.db.prepare('INSERT INTO audit(at,actor_id,action,detail) VALUES(?,?,?,?)').run(now, actorId, edit ? 'grant_edit' : 'revoke_edit', `${userId} / ${mailboxId}`);
    });
  }

  // ---- send grants (per mailbox): who may send with that mailbox's address as From

  sendGrants(): { user_id: string; mailbox_id: string }[] {
    return this.db.prepare('SELECT user_id, mailbox_id FROM send_grants ORDER BY user_id, mailbox_id').all() as { user_id: string; mailbox_id: string }[];
  }

  sendMailboxesOf(userId: string): Set<string> {
    return new Set((this.db.prepare('SELECT mailbox_id FROM send_grants WHERE user_id=?').all(userId) as { mailbox_id: string }[]).map((r) => r.mailbox_id));
  }

  setSendGrant(userId: string, mailboxId: string, send: boolean, actorId: string, now: string): void {
    this.tx(() => {
      if (send) this.db.prepare('INSERT OR IGNORE INTO send_grants(user_id,mailbox_id,granted_by,granted_at) VALUES(?,?,?,?)').run(userId, mailboxId, actorId, now);
      else this.db.prepare('DELETE FROM send_grants WHERE user_id=? AND mailbox_id=?').run(userId, mailboxId);
      this.db.prepare('INSERT INTO audit(at,actor_id,action,detail) VALUES(?,?,?,?)').run(now, actorId, send ? 'grant_send' : 'revoke_send', `${userId} / ${mailboxId}`);
    });
  }

  // ---- department grants: everyone in the department (by the Discord roles of the moment) has them

  departmentGrants(): { department: string; mailbox_id: string; kind: 'edit' | 'send' }[] {
    return this.db.prepare('SELECT department, mailbox_id, kind FROM department_grants ORDER BY department, mailbox_id, kind').all() as { department: string; mailbox_id: string; kind: 'edit' | 'send' }[];
  }

  /** Mailboxes granted (for this kind) to any of these departments. */
  departmentMailboxes(departments: string[], kind: 'edit' | 'send'): Set<string> {
    if (departments.length === 0) return new Set();
    const rows = this.db.prepare(`SELECT DISTINCT mailbox_id FROM department_grants WHERE kind=? AND department IN (${departments.map(() => '?').join(',')})`).all(kind, ...departments) as { mailbox_id: string }[];
    return new Set(rows.map((r) => r.mailbox_id));
  }

  setDepartmentGrant(department: string, mailboxId: string, kind: 'edit' | 'send', on: boolean, actorId: string, now: string): void {
    this.tx(() => {
      if (on) this.db.prepare('INSERT OR IGNORE INTO department_grants(department,mailbox_id,kind,granted_by,granted_at) VALUES(?,?,?,?,?)').run(department, mailboxId, kind, actorId, now);
      else this.db.prepare('DELETE FROM department_grants WHERE department=? AND mailbox_id=? AND kind=?').run(department, mailboxId, kind);
      this.db.prepare('INSERT INTO audit(at,actor_id,action,detail) VALUES(?,?,?,?)').run(now, actorId, `${on ? 'grant' : 'revoke'}_department_${kind}`, `${department} / ${mailboxId}`);
    });
  }

  // ---- sending

  outgoingByToken(token: string): OutgoingRow | null {
    return (this.db.prepare('SELECT * FROM outgoing WHERE client_token=?').get(token) as unknown as OutgoingRow | undefined) ?? null;
  }

  /** Sends by this person since `since` (a limit against a runaway script). */
  sendsSince(userId: string, since: string): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM outgoing WHERE user_id=? AND created_at>=? AND status<>'failed'").get(userId, since) as { n: number }).n);
  }

  /**
   * Claims a send for the browser's token: a new row, or a failed one again (the server never took it).
   * Null when the token is already sending, sent or unknown (the caller answers from the row).
   */
  claimOutgoing(row: Omit<OutgoingRow, 'status' | 'error' | 'message_id' | 'finished_at'>): OutgoingRow | null {
    return this.tx(() => {
      const known = this.outgoingByToken(row.client_token);
      if (known && known.status !== 'failed') return null;
      if (known) {
        this.db
          .prepare("UPDATE outgoing SET user_id=?, mailbox_id=?, internet_message_id=?, reply_to_id=?, recipients=?, bcc_json=?, size=?, status='sending', error=NULL, created_at=? WHERE id=?")
          .run(row.user_id, row.mailbox_id, row.internet_message_id, row.reply_to_id, row.recipients, row.bcc_json, row.size, row.created_at, known.id);
        return { ...known, ...row, id: known.id, status: 'sending', error: null, message_id: null, finished_at: null };
      }
      this.db
        .prepare("INSERT INTO outgoing(id,client_token,user_id,mailbox_id,internet_message_id,reply_to_id,recipients,bcc_json,size,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'sending',?)")
        .run(row.id, row.client_token, row.user_id, row.mailbox_id, row.internet_message_id, row.reply_to_id, row.recipients, row.bcc_json, row.size, row.created_at);
      return { ...row, status: 'sending', error: null, message_id: null, finished_at: null };
    });
  }

  finishOutgoing(id: string, outcome: { status: 'sent' | 'failed' | 'unknown'; error?: string | null; messageId?: string | null }, actorId: string, now: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE outgoing SET status=?, error=?, message_id=?, finished_at=? WHERE id=?').run(outcome.status, outcome.error ?? null, outcome.messageId ?? null, now, id);
      const row = this.db.prepare('SELECT mailbox_id, recipients FROM outgoing WHERE id=?').get(id) as { mailbox_id: string; recipients: number };
      this.db.prepare('INSERT INTO audit(at,actor_id,action,detail) VALUES(?,?,?,?)').run(now, actorId, `send_${outcome.status}`, `${id} / ${row.mailbox_id} / 宛先 ${row.recipients} 件`);
    });
  }

  audit(limit = 100): { id: number; at: string; actor_id: string; action: string; detail: string }[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as { id: number; at: string; actor_id: string; action: string; detail: string }[];
  }
}
