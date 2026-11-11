import type { MailApprovalAction, MailApprovalState } from '../../shared/mailbox.js';
import type { MailboxStore } from './store.js';

// Approval before sending (2026-11-11), kept in mail.sqlite3 next to the messages:
//   - review_grants / department_review_grants: who may approve, change and return the waiting mail of a mailbox.
//   - approval_required: people whose mail from a mailbox always waits for an approval, even with a send grant.
//   - send_requests: one row per mail that was asked to be sent. message_json is what would be sent now;
//     submitted_json is what the author asked for (they differ once a reviewer changed the mail).
//     send_token is the token of the one send this request can ever make (MailSender never sends a token twice).
//   - send_request_attachments: the files, in the database (the backup copies mail.sqlite3 whole; the files in
//     attachments/ are copied only when a stored message names them). Deleted once the request is finished.
//   - send_request_history: every step, with who took it.
// Every change of a request is one transaction that checks the version the screen read, so two reviewers (or a
// reviewer and the author) never overwrite each other.
// The tables are only added (CREATE TABLE IF NOT EXISTS): an older version of the app opens the same file.

export const APPROVAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_grants(user_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(user_id, mailbox_id));
CREATE TABLE IF NOT EXISTS department_review_grants(department TEXT NOT NULL, mailbox_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(department, mailbox_id));
CREATE TABLE IF NOT EXISTS approval_required(user_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(user_id, mailbox_id));
CREATE TABLE IF NOT EXISTS send_requests(
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  author_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  message_json TEXT NOT NULL,
  submitted_json TEXT NOT NULL,
  note TEXT NOT NULL,
  submit_token TEXT NOT NULL UNIQUE,
  send_token TEXT NOT NULL UNIQUE,
  return_comment TEXT,
  decided_by TEXT,
  decided_at TEXT,
  sent_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS send_requests_state ON send_requests(state, mailbox_id);
CREATE INDEX IF NOT EXISTS send_requests_author ON send_requests(author_id, updated_at);
CREATE TABLE IF NOT EXISTS send_request_attachments(request_id TEXT NOT NULL, idx INTEGER NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY(request_id, idx));
CREATE TABLE IF NOT EXISTS send_request_history(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS send_request_history_request ON send_request_history(request_id, id);
`;

export interface SendRequestRow {
  id: string;
  version: number;
  state: MailApprovalState;
  author_id: string;
  mailbox_id: string;
  message_json: string;
  submitted_json: string;
  note: string;
  submit_token: string;
  send_token: string;
  return_comment: string | null;
  decided_by: string | null;
  decided_at: string | null;
  sent_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestAttachmentMeta {
  idx: number;
  filename: string;
  content_type: string;
  size: number;
}

export interface RequestAttachment extends RequestAttachmentMeta {
  content: Buffer;
}

export interface RequestHistoryRow {
  at: string;
  actor_id: string;
  action: MailApprovalAction;
  detail: string | null;
}

type Pair = { user_id: string; mailbox_id: string };
const marks = (values: unknown[]) => values.map(() => '?').join(',');

function audit(store: MailboxStore, now: string, actorId: string, action: string, detail: string): void {
  store.db.prepare('INSERT INTO audit(at,actor_id,action,detail) VALUES(?,?,?,?)').run(now, actorId, action, detail);
}

// ---- review grants (per mailbox, to a person or a department) and the "always needs an approval" mark

export function reviewGrants(store: MailboxStore): Pair[] {
  return store.db.prepare('SELECT user_id, mailbox_id FROM review_grants ORDER BY user_id, mailbox_id').all() as unknown as Pair[];
}

export function reviewMailboxesOf(store: MailboxStore, userId: string): Set<string> {
  return new Set((store.db.prepare('SELECT mailbox_id FROM review_grants WHERE user_id=?').all(userId) as { mailbox_id: string }[]).map((r) => r.mailbox_id));
}

export function setReviewGrant(store: MailboxStore, userId: string, mailboxId: string, on: boolean, actorId: string, now: string): void {
  store.tx(() => {
    if (on) store.db.prepare('INSERT OR IGNORE INTO review_grants(user_id,mailbox_id,granted_by,granted_at) VALUES(?,?,?,?)').run(userId, mailboxId, actorId, now);
    else store.db.prepare('DELETE FROM review_grants WHERE user_id=? AND mailbox_id=?').run(userId, mailboxId);
    audit(store, now, actorId, on ? 'grant_review' : 'revoke_review', `${userId} / ${mailboxId}`);
  });
}

export function departmentReviewGrants(store: MailboxStore): { department: string; mailbox_id: string }[] {
  return store.db.prepare('SELECT department, mailbox_id FROM department_review_grants ORDER BY department, mailbox_id').all() as { department: string; mailbox_id: string }[];
}

export function departmentReviewMailboxes(store: MailboxStore, departments: string[]): Set<string> {
  if (departments.length === 0) return new Set();
  const rows = store.db.prepare(`SELECT DISTINCT mailbox_id FROM department_review_grants WHERE department IN (${marks(departments)})`).all(...departments) as { mailbox_id: string }[];
  return new Set(rows.map((r) => r.mailbox_id));
}

export function setDepartmentReviewGrant(store: MailboxStore, department: string, mailboxId: string, on: boolean, actorId: string, now: string): void {
  store.tx(() => {
    if (on) store.db.prepare('INSERT OR IGNORE INTO department_review_grants(department,mailbox_id,granted_by,granted_at) VALUES(?,?,?,?)').run(department, mailboxId, actorId, now);
    else store.db.prepare('DELETE FROM department_review_grants WHERE department=? AND mailbox_id=?').run(department, mailboxId);
    audit(store, now, actorId, `${on ? 'grant' : 'revoke'}_department_review`, `${department} / ${mailboxId}`);
  });
}

/** Mailboxes that have a reviewer at all (a person's grant or a department's). */
export function reviewedMailboxes(store: MailboxStore): Set<string> {
  const rows = store.db.prepare('SELECT mailbox_id FROM review_grants UNION SELECT mailbox_id FROM department_review_grants').all() as { mailbox_id: string }[];
  return new Set(rows.map((r) => r.mailbox_id));
}

export function approvalRequired(store: MailboxStore): Pair[] {
  return store.db.prepare('SELECT user_id, mailbox_id FROM approval_required ORDER BY user_id, mailbox_id').all() as unknown as Pair[];
}

export function approvalRequiredMailboxesOf(store: MailboxStore, userId: string): Set<string> {
  return new Set((store.db.prepare('SELECT mailbox_id FROM approval_required WHERE user_id=?').all(userId) as { mailbox_id: string }[]).map((r) => r.mailbox_id));
}

export function setApprovalRequired(store: MailboxStore, userId: string, mailboxId: string, on: boolean, actorId: string, now: string): void {
  store.tx(() => {
    if (on) store.db.prepare('INSERT OR IGNORE INTO approval_required(user_id,mailbox_id,granted_by,granted_at) VALUES(?,?,?,?)').run(userId, mailboxId, actorId, now);
    else store.db.prepare('DELETE FROM approval_required WHERE user_id=? AND mailbox_id=?').run(userId, mailboxId);
    audit(store, now, actorId, on ? 'require_approval' : 'unrequire_approval', `${userId} / ${mailboxId}`);
  });
}

// ---- requests

const row = (value: unknown): SendRequestRow | null => (value as SendRequestRow | undefined) ?? null;

export function requestById(store: MailboxStore, id: string): SendRequestRow | null {
  return row(store.db.prepare('SELECT * FROM send_requests WHERE id=?').get(id));
}

export function requestBySubmitToken(store: MailboxStore, token: string): SendRequestRow | null {
  return row(store.db.prepare('SELECT * FROM send_requests WHERE submit_token=?').get(token));
}

function addHistory(store: MailboxStore, requestId: string, at: string, actorId: string, action: MailApprovalAction, detail: string | null): void {
  store.db.prepare('INSERT INTO send_request_history(request_id,at,actor_id,action,detail) VALUES(?,?,?,?,?)').run(requestId, at, actorId, action, detail);
}

function writeAttachments(store: MailboxStore, requestId: string, attachments: Omit<RequestAttachment, 'idx'>[]): void {
  store.db.prepare('DELETE FROM send_request_attachments WHERE request_id=?').run(requestId);
  const insert = store.db.prepare('INSERT INTO send_request_attachments(request_id,idx,filename,content_type,size,content) VALUES(?,?,?,?,?,?)');
  attachments.forEach((a, idx) => insert.run(requestId, idx, a.filename, a.content_type, a.size, a.content));
}

/** A new request (pending). The audit row has no address, subject or text, as for a send. */
export function insertRequest(
  store: MailboxStore,
  request: Pick<SendRequestRow, 'id' | 'author_id' | 'mailbox_id' | 'message_json' | 'note' | 'submit_token' | 'send_token'>,
  attachments: Omit<RequestAttachment, 'idx'>[],
  now: string,
): void {
  store.tx(() => {
    store.db
      .prepare("INSERT INTO send_requests(id,version,state,author_id,mailbox_id,message_json,submitted_json,note,submit_token,send_token,created_at,updated_at) VALUES(?,1,'pending',?,?,?,?,?,?,?,?,?)")
      .run(request.id, request.author_id, request.mailbox_id, request.message_json, request.message_json, request.note, request.submit_token, request.send_token, now, now);
    writeAttachments(store, request.id, attachments);
    addHistory(store, request.id, now, request.author_id, 'submitted', null);
    audit(store, now, request.author_id, 'approval_submitted', `${request.id} / ${request.mailbox_id}`);
  });
}

export interface RequestChange {
  state?: MailApprovalState;
  message_json?: string;
  submitted_json?: string;
  note?: string;
  submit_token?: string;
  return_comment?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  sent_thread_id?: string | null;
  /** Replaces the files (the author's new version). */
  attachments?: Omit<RequestAttachment, 'idx'>[];
  /** Deletes the files (a finished request keeps none). */
  dropAttachments?: boolean;
}

/**
 * One step of a request, in one transaction: only when it is still in one of `from` and at `expectedVersion`
 * (null: any version, for the steps the server takes after an approval). False when it was changed meanwhile.
 */
export function changeRequest(
  store: MailboxStore,
  id: string,
  expectedVersion: number | null,
  from: MailApprovalState[],
  change: RequestChange,
  history: { actorId: string; action: MailApprovalAction; detail?: string | null },
  now: string,
): boolean {
  return store.tx(() => {
    const current = requestById(store, id);
    if (!current || !from.includes(current.state) || (expectedVersion !== null && current.version !== expectedVersion)) return false;
    const { attachments, dropAttachments, ...columns } = change;
    const names = Object.keys(columns) as (keyof typeof columns)[];
    const sets = [...names.map((n) => `${n}=?`), 'version=version+1', 'updated_at=?'];
    store.db.prepare(`UPDATE send_requests SET ${sets.join(', ')} WHERE id=?`).run(...names.map((n) => columns[n] ?? null), now, id);
    if (attachments) writeAttachments(store, id, attachments);
    if (dropAttachments) store.db.prepare('DELETE FROM send_request_attachments WHERE request_id=?').run(id);
    addHistory(store, id, now, history.actorId, history.action, history.detail ?? null);
    audit(store, now, history.actorId, `approval_${history.action}`, `${id} / ${current.mailbox_id}`);
    return true;
  });
}

export function requestAttachments(store: MailboxStore, requestId: string): RequestAttachmentMeta[] {
  return store.db.prepare('SELECT idx, filename, content_type, size FROM send_request_attachments WHERE request_id=? ORDER BY idx').all(requestId) as unknown as RequestAttachmentMeta[];
}

export function requestAttachmentFiles(store: MailboxStore, requestId: string): RequestAttachment[] {
  const rows = store.db.prepare('SELECT idx, filename, content_type, size, content FROM send_request_attachments WHERE request_id=? ORDER BY idx').all(requestId) as unknown as (RequestAttachmentMeta & { content: Uint8Array })[];
  return rows.map((r) => ({ ...r, content: Buffer.from(r.content) }));
}

export function requestHistory(store: MailboxStore, requestId: string): RequestHistoryRow[] {
  return store.db.prepare('SELECT at, actor_id, action, detail FROM send_request_history WHERE request_id=? ORDER BY id').all(requestId) as unknown as RequestHistoryRow[];
}

/** Waiting mail of these mailboxes that someone else wrote, oldest first. */
export function pendingForReview(store: MailboxStore, mailboxIds: string[], reviewerId: string): SendRequestRow[] {
  if (mailboxIds.length === 0) return [];
  return store.db.prepare(`SELECT * FROM send_requests WHERE state='pending' AND author_id<>? AND mailbox_id IN (${marks(mailboxIds)}) ORDER BY updated_at, id`).all(reviewerId, ...mailboxIds) as unknown as SendRequestRow[];
}

const OPEN: MailApprovalState[] = ['pending', 'returned', 'sending'];

/** The author's requests that are not finished, newest first. */
export function openRequestsOf(store: MailboxStore, authorId: string): SendRequestRow[] {
  return store.db.prepare(`SELECT * FROM send_requests WHERE author_id=? AND state IN (${marks(OPEN)}) ORDER BY updated_at DESC, id`).all(authorId, ...OPEN) as unknown as SendRequestRow[];
}

/** Finished requests this person wrote or decided, newest first. */
export function finishedRequestsOf(store: MailboxStore, userId: string, limit: number): SendRequestRow[] {
  return store.db
    .prepare(`SELECT * FROM send_requests WHERE (author_id=? OR decided_by=?) AND state NOT IN (${marks(OPEN)}) ORDER BY updated_at DESC, id LIMIT ?`)
    .all(userId, userId, ...OPEN, limit) as unknown as SendRequestRow[];
}

export function returnedCountOf(store: MailboxStore, authorId: string): number {
  return Number((store.db.prepare("SELECT count(*) AS n FROM send_requests WHERE author_id=? AND state='returned'").get(authorId) as { n: number }).n);
}

export function waitingCountOf(store: MailboxStore, authorId: string): number {
  return Number((store.db.prepare("SELECT count(*) AS n FROM send_requests WHERE author_id=? AND state IN ('pending','returned')").get(authorId) as { n: number }).n);
}
