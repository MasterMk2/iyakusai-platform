import { addDays, DUE_SOON_DAYS, japaneseDay, jstDay, type MailDueEntry, type MessageDueView, type ThreadDueView } from '../../shared/mailDue.js';
import type { MailboxStore } from './store.js';

// Deadlines of committee mail (2026-11-03), kept in mail.sqlite3 next to the messages:
//   - message_due: one row per message that has a deadline. The key is the message (not the thread), so a
//     reply that moves a message to another thread (store.ts) does not leave a deadline behind.
//     response_due: 対応期限 of a received message. reply_due and reply_since: 返事待ち of a sent message, from
//     the send (reply_since) until the reply deadline (reply_due); both are NULL when it is not waiting.
//   - history rows (action 'due' or 'reply_wait') keep every change with its before and after values.
// Every change is written in one transaction with the message's version counter (messages.version), the same
// counter the triage uses, so a stale screen gets a conflict instead of overwriting a newer deadline.
// The table is only added (CREATE TABLE IF NOT EXISTS): an older version of the app opens the same file.

export const DUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_due(
  message_id TEXT PRIMARY KEY,
  response_due TEXT,
  reply_due TEXT,
  reply_since TEXT
);
CREATE INDEX IF NOT EXISTS message_due_reply ON message_due(reply_since);
`;

/** The history actor of a reply wait cleared by an arriving reply (no person did it). */
export const AUTO_ACTOR = 'auto-reply';
export const AUTO_ACTOR_NAME = '自動（返信の受信）';

/** The deadlines of one message, as stored. */
export interface DueState {
  responseDue: string | null;
  replyDue: string | null;
  replySince: string | null;
}

export const NO_DUE: DueState = { responseDue: null, replyDue: null, replySince: null };

export interface DueHistoryInput {
  action: 'due' | 'reply_wait';
  from: string | null;
  to: string | null;
}

/** The deadlines of these messages (messages without a row have none). */
export function loadDue(store: MailboxStore, messageIds: string[]): Map<string, DueState> {
  const out = new Map<string, DueState>();
  if (messageIds.length === 0) return out;
  const rows = store.db
    .prepare(`SELECT message_id, response_due, reply_due, reply_since FROM message_due WHERE message_id IN (${messageIds.map(() => '?').join(',')})`)
    .all(...messageIds) as { message_id: string; response_due: string | null; reply_due: string | null; reply_since: string | null }[];
  for (const r of rows) out.set(r.message_id, { responseDue: r.response_due, replyDue: r.reply_due, replySince: r.reply_since });
  return out;
}

/**
 * The view of one message's deadlines. `today` is the Japan calendar day. `replyWaitAllowed` says whether the
 * message was sent from a committee address: only such a message can wait for a reply (updateDue refuses others).
 */
export function messageDueView(due: DueState, status: string, today: string, version: number, canEdit: boolean, replyWaitAllowed: boolean): MessageDueView {
  return {
    version,
    responseDue: due.responseDue,
    responseOverdue: due.responseDue !== null && status !== 'done' && due.responseDue < today,
    replyWait: due.replySince !== null && due.replyDue !== null ? { dueOn: due.replyDue, since: due.replySince, overdue: due.replyDue < today } : null,
    canEdit,
    replyWaitAllowed,
  };
}

/** The deadlines of a thread from its messages (status and deadlines of each). */
export function threadDueView(rows: { status: string; due: DueState }[], today: string): ThreadDueView {
  let responseDue: string | null = null;
  let wait: { dueOn: string; since: string } | null = null;
  for (const { status, due } of rows) {
    if (due.responseDue !== null && status !== 'done' && (responseDue === null || due.responseDue < responseDue)) responseDue = due.responseDue;
    if (due.replySince !== null && due.replyDue !== null && (wait === null || due.replyDue < wait.dueOn)) wait = { dueOn: due.replyDue, since: due.replySince };
  }
  return {
    responseDue,
    responseOverdue: responseDue !== null && responseDue < today,
    replyWait: wait ? { ...wait, overdue: wait.dueOn < today } : null,
  };
}

/**
 * SQL condition for a thread filter, on the messages of alias `alias`: the thread awaits a reply
 * ('awaiting'), or a reply deadline or a response due has passed ('overdue'; a response due counts only while
 * a message of the thread is not 完了).
 */
export function dueFilterSql(alias: string, kind: 'awaiting' | 'overdue', today: string): { sql: string; params: string[] } {
  const inThread = `EXISTS (SELECT 1 FROM message_due d JOIN messages x ON x.id = d.message_id WHERE x.thread_id = ${alias}.thread_id AND `;
  if (kind === 'awaiting') return { sql: `${inThread}d.reply_since IS NOT NULL)`, params: [] };
  return {
    sql: `${inThread}((d.reply_since IS NOT NULL AND d.reply_due < ?) OR (d.response_due IS NOT NULL AND d.response_due < ? AND x.status <> 'done')))`,
    params: [today, today],
  };
}

/** SQL for the nearest deadline of the thread of alias `alias` (for ordering): a reply wait, or a response due not 完了. */
export function nearestDueSql(alias: string): string {
  return `(SELECT min(v) FROM (
    SELECT d.reply_due AS v FROM message_due d JOIN messages x ON x.id = d.message_id WHERE x.thread_id = ${alias}.thread_id AND d.reply_since IS NOT NULL
    UNION ALL
    SELECT d.response_due AS v FROM message_due d JOIN messages x ON x.id = d.message_id WHERE x.thread_id = ${alias}.thread_id AND x.status <> 'done' AND d.response_due IS NOT NULL))`;
}

function insertHistory(store: MailboxStore, messageId: string, at: string, actorId: string, rows: DueHistoryInput[]): void {
  const insert = store.db.prepare('INSERT INTO history(message_id,at,actor_id,action,from_value,to_value) VALUES(?,?,?,?,?,?)');
  for (const h of rows) insert.run(messageId, at, actorId, h.action, h.from, h.to);
}

/**
 * Writes one message's deadlines with their history, in one transaction. False when the message's version is
 * not `expectedVersion` any more (nothing is written; the caller answers with a conflict).
 */
export function writeDue(store: MailboxStore, messageId: string, expectedVersion: number, next: DueState, history: DueHistoryInput[], actorId: string, now: string): boolean {
  return store.tx(() => {
    const changed = store.db.prepare('UPDATE messages SET version=version+1 WHERE id=? AND version=?').run(messageId, expectedVersion);
    if (Number(changed.changes) !== 1) return false;
    if (next.responseDue === null && next.replyDue === null) {
      store.db.prepare('DELETE FROM message_due WHERE message_id=?').run(messageId);
    } else {
      store.db
        .prepare(
          `INSERT INTO message_due(message_id,response_due,reply_due,reply_since) VALUES(?,?,?,?)
           ON CONFLICT(message_id) DO UPDATE SET response_due=excluded.response_due, reply_due=excluded.reply_due, reply_since=excluded.reply_since`,
        )
        .run(messageId, next.responseDue, next.replyDue, next.replySince);
    }
    insertHistory(store, messageId, now, actorId, history);
    return true;
  });
}

/**
 * Sets the reply deadline of a message just sent (after the mail server accepted it). The message row may not
 * exist yet (the account's copy is stored later under the same Message-ID); the deadline is kept for it either way.
 */
export function startReplyWait(store: MailboxStore, messageId: string, replyDue: string, since: string, actorId: string): void {
  store.tx(() => {
    const today = jstDay(since);
    store.db.prepare('UPDATE messages SET version=version+1 WHERE id=?').run(messageId);
    store.db
      .prepare(
        `INSERT INTO message_due(message_id,response_due,reply_due,reply_since) VALUES(?,NULL,?,?)
         ON CONFLICT(message_id) DO UPDATE SET reply_due=excluded.reply_due, reply_since=excluded.reply_since`,
      )
      .run(messageId, replyDue, since);
    insertHistory(store, messageId, since, actorId, [{ action: 'reply_wait', from: null, to: `${japaneseDay(replyDue, today)}まで` }]);
  });
}

/**
 * A reply from outside the committee arrived in a thread: the reply waits of the thread's messages that were
 * sent before it arrived are cleared (history: 自動). Returns how many were cleared. Own transaction.
 */
export function answerReplyWaits(store: MailboxStore, threadId: string, arrivedAt: string, now: string): number {
  return store.tx(() => {
    const rows = store.db
      .prepare(
        `SELECT d.message_id AS id, d.reply_due AS due FROM message_due d JOIN messages m ON m.id = d.message_id
         WHERE m.thread_id = ? AND d.reply_since IS NOT NULL AND d.reply_since <= ?`,
      )
      .all(threadId, arrivedAt) as { id: string; due: string }[];
    const today = jstDay(now);
    for (const r of rows) {
      store.db.prepare('UPDATE messages SET version=version+1 WHERE id=?').run(r.id);
      const kept = loadDue(store, [r.id]).get(r.id) ?? NO_DUE;
      if (kept.responseDue === null) store.db.prepare('DELETE FROM message_due WHERE message_id=?').run(r.id);
      else store.db.prepare('UPDATE message_due SET reply_due=NULL, reply_since=NULL WHERE message_id=?').run(r.id);
      insertHistory(store, r.id, now, AUTO_ACTOR, [{ action: 'reply_wait', from: `${japaneseDay(r.due, today)}まで`, to: null }]);
    }
    return rows.length;
  });
}

export interface OpenDueRow {
  message_id: string;
  thread_id: string;
  subject: string;
  from_address: string;
  text: string;
  status: string;
  response_due: string | null;
  reply_due: string | null;
  reply_since: string | null;
}

/** Messages with a reply wait, or an open response due, in these mailboxes (for the home screen). */
export function openDueRows(store: MailboxStore, mailboxIds: string[]): OpenDueRow[] {
  if (mailboxIds.length === 0) return [];
  return store.db
    .prepare(
      `SELECT m.id AS message_id, m.thread_id, m.subject, m.from_address, m.text, m.status, d.response_due, d.reply_due, d.reply_since
       FROM message_due d JOIN messages m ON m.id = d.message_id
       WHERE (d.reply_since IS NOT NULL OR (d.response_due IS NOT NULL AND m.status <> 'done'))
         AND EXISTS (SELECT 1 FROM message_mailboxes mm WHERE mm.message_id = m.id AND mm.mailbox_id IN (${mailboxIds.map(() => '?').join(',')}))
       ORDER BY m.received_at, m.id`,
    )
    .all(...mailboxIds) as unknown as OpenDueRow[];
}

/**
 * The home screen's lists: threads with a reply deadline passed, and threads whose response due is near or
 * passed (not 完了). One line per thread (its earliest deadline); the lists are cut to `limit`, the counts are not.
 */
export function dueEntries(rows: { row: OpenDueRow; mailboxName: string; subject: string }[], today: string, limit: number) {
  const soon = addDays(today, DUE_SOON_DAYS);
  const replies = new Map<string, MailDueEntry>();
  const responses = new Map<string, MailDueEntry>();
  for (const { row, mailboxName, subject } of rows) {
    const entry = (kind: 'reply' | 'response', dueOn: string): MailDueEntry => ({ threadId: row.thread_id, subject, mailboxName, kind, dueOn, overdue: dueOn < today });
    if (row.reply_since !== null && row.reply_due !== null && row.reply_due < today) {
      const cur = replies.get(row.thread_id);
      if (!cur || row.reply_due < cur.dueOn) replies.set(row.thread_id, entry('reply', row.reply_due));
    }
    if (row.response_due !== null && row.status !== 'done' && row.response_due <= soon) {
      const cur = responses.get(row.thread_id);
      if (!cur || row.response_due < cur.dueOn) responses.set(row.thread_id, entry('response', row.response_due));
    }
  }
  const byDue = (a: MailDueEntry, b: MailDueEntry) => a.dueOn.localeCompare(b.dueOn) || a.threadId.localeCompare(b.threadId);
  const replyList = [...replies.values()].sort(byDue);
  const responseList = [...responses.values()].sort(byDue);
  return { counts: { replyOverdue: replyList.length, responseDue: responseList.length }, replyOverdue: replyList.slice(0, limit), responseDue: responseList.slice(0, limit) };
}
