import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTO_ACTOR, answerReplyWaits, loadDue, NO_DUE, startReplyWait, writeDue } from '../../src/server/mailbox/due.js';
import { parseRawMail, type ParsedMail } from '../../src/server/mailbox/parse.js';
import { messageIdFor, MailboxStore, threadIdFor, type ListFilter } from '../../src/server/mailbox/store.js';
import { OUTSIDE, rawMail } from './helpers.js';

// Deadlines in the mail store (2026-11-03): the migration of an existing mail.sqlite3, the thread filter and order,
// the reply wait that a reply from outside clears. Synthetic mail and dates only.

let dir: string;
let store: MailboxStore;

const ALL: ListFilter['mailboxIds'] = ['contact', 'sponsorship', 'adm'];
const NOW = '2026-11-03T01:00:00.000Z';

async function parsed(o: Parameters<typeof rawMail>[0]): Promise<ParsedMail> {
  return parseRawMail(rawMail(o));
}

/** Stores one message the way the collector does (source collector, one mailbox). */
async function storeMail(id: string, o: Parameters<typeof rawMail>[0], receivedAt: string, status?: 'unhandled' | 'done') {
  const p = await parsed(o);
  const out = store.store({ source: 'collector', providerId: id, receivedAt, parsed: p, mailboxIds: ['contact'], now: receivedAt, ...(status ? { status } : {}) });
  return out.id;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mail-due-store-'));
  store = new MailboxStore(path.join(dir, 'mail'));
});
afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('opening a mail file from before the deadlines', () => {
  it('adds the deadline table without touching the messages, and opens again each time', async () => {
    const id = await storeMail('m-1', { messageId: 'old-1@partner.example', from: OUTSIDE, to: 'contact@committee.example', subject: '既存のメール' }, NOW);
    store.close();
    // A file made before the deadlines: the same tables without message_due.
    const raw = new DatabaseSync(path.join(dir, 'mail', 'mail.sqlite3'));
    raw.exec('DROP INDEX message_due_reply; DROP TABLE message_due;');
    raw.close();

    store = new MailboxStore(path.join(dir, 'mail'));
    expect(store.message(id)?.subject).toBe('既存のメール');
    expect(store.ingestSummary().messages).toBe(1);
    expect(store.sourceMessage('collector', 'm-1')).toBe(id);
    expect((store.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string }).value).toBe('1');
    expect(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='message_due'").get()).toEqual({ n: 1 });

    // Opening it again (the next start) changes nothing.
    store.close();
    store = new MailboxStore(path.join(dir, 'mail'));
    expect(store.message(id)?.subject).toBe('既存のメール');
    expect(store.ingestSummary().messages).toBe(1);
  });
});

describe('thread filter and order by deadline', () => {
  it('lists threads awaiting a reply, and threads past a deadline, nearest deadline first', async () => {
    // Thread A: a received message with a response due on 11-12 (open).
    const a = await storeMail('a', { messageId: 'a1@partner.example', from: OUTSIDE, to: 'contact@committee.example', subject: 'A' }, '2026-11-01T01:00:00.000Z');
    expect(writeDue(store, a, 1, { responseDue: '2026-11-12', replyDue: null, replySince: null }, [{ action: 'due', from: null, to: '11月12日（木）' }], 'u1', NOW)).toBe(true);
    // Thread B: a sent message that waits for a reply until 11-05.
    const b = await storeMail('b', { messageId: 'b1@partner.example', from: 'committee@committee.example', to: OUTSIDE, subject: 'B' }, '2026-11-02T01:00:00.000Z', 'done');
    startReplyWait(store, messageIdFor('b1@partner.example'), '2026-11-05', '2026-11-02T01:00:00.000Z', 'u1');
    // Thread C: nothing.
    await storeMail('c', { messageId: 'c1@partner.example', from: OUTSIDE, to: 'contact@committee.example', subject: 'C' }, '2026-11-02T03:00:00.000Z');
    const threadA = threadIdFor('a1@partner.example');
    const threadB = threadIdFor('b1@partner.example');
    const threadC = threadIdFor('c1@partner.example');
    expect(b).toBeTruthy();

    const ids = (f: Partial<ListFilter>, sort?: 'latest' | 'due') => store.threadPage({ mailboxIds: ALL, terms: [], ...f, ...(sort ? { sort } : {}) }, 10, 0).threads.map((t) => t.thread_id);

    expect(ids({ due: { kind: 'awaiting', today: '2026-11-03' } })).toEqual([threadB]);
    // On 11-06 the reply wait of B has passed; A's response is not yet.
    expect(ids({ due: { kind: 'overdue', today: '2026-11-06' } })).toEqual([threadB]);
    // On 11-13 A's response has passed too (A is not 完了); both are overdue.
    expect(new Set(ids({ due: { kind: 'overdue', today: '2026-11-13' } }))).toEqual(new Set([threadA, threadB]));
    // Nearest deadline first: B (11-05), A (11-12), then the thread without a deadline.
    expect(ids({}, 'due')).toEqual([threadB, threadA, threadC]);
    expect(ids({})).toHaveLength(3);
  });

  it('does not count a response due of a message that is 完了', async () => {
    const d = await storeMail('d', { messageId: 'd1@partner.example', from: OUTSIDE, to: 'contact@committee.example', subject: 'D' }, '2026-11-01T01:00:00.000Z', 'done');
    writeDue(store, d, 1, { responseDue: '2026-11-02', replyDue: null, replySince: null }, [], 'u1', NOW);
    const overdue = store.threadPage({ mailboxIds: ALL, terms: [], due: { kind: 'overdue', today: '2026-11-10' } }, 10, 0);
    expect(overdue.total).toBe(0);
  });
});

describe('a reply from outside clears the reply waits sent before it', () => {
  it('clears only the waits sent before the reply arrived, and says so in the history', async () => {
    const sent = await storeMail('s', { messageId: 's1@committee.example', from: 'committee@committee.example', to: OUTSIDE, subject: '送った' }, '2026-11-02T01:00:00.000Z', 'done');
    startReplyWait(store, sent, '2026-11-05', '2026-11-02T01:00:00.000Z', 'u1');
    const thread = store.message(sent)!.thread_id;

    // A reply that arrived before the wait started does not clear it.
    expect(answerReplyWaits(store, thread, '2026-11-02T00:00:00.000Z', NOW)).toBe(0);
    expect(loadDue(store, [sent]).get(sent)?.replySince).toBe('2026-11-02T01:00:00.000Z');

    expect(answerReplyWaits(store, thread, '2026-11-03T02:00:00.000Z', NOW)).toBe(1);
    expect(loadDue(store, [sent]).get(sent) ?? NO_DUE).toEqual(NO_DUE);
    const last = store.history(sent).at(-1)!;
    expect(last).toMatchObject({ actor_id: AUTO_ACTOR, action: 'reply_wait', from_value: '11月5日（木）まで', to_value: null });
    expect(store.message(sent)!.version).toBe(3);
  });

  it('keeps a response due when the reply clears the wait of the same message', async () => {
    const sent = await storeMail('s2', { messageId: 's2@committee.example', from: 'committee@committee.example', to: OUTSIDE, subject: '送った2' }, '2026-11-02T01:00:00.000Z', 'done');
    startReplyWait(store, sent, '2026-11-05', '2026-11-02T01:00:00.000Z', 'u1');
    writeDue(store, sent, 2, { responseDue: '2026-11-09', replyDue: '2026-11-05', replySince: '2026-11-02T01:00:00.000Z' }, [], 'u1', NOW);
    expect(answerReplyWaits(store, store.message(sent)!.thread_id, '2026-11-03T02:00:00.000Z', NOW)).toBe(1);
    expect(loadDue(store, [sent]).get(sent)).toEqual({ responseDue: '2026-11-09', replyDue: null, replySince: null });
  });

  it('keeps the deadlines when a version has moved on (the write is refused, nothing changes)', async () => {
    const id = await storeMail('v', { messageId: 'v1@partner.example', from: OUTSIDE, to: 'contact@committee.example', subject: 'V' }, '2026-11-01T01:00:00.000Z');
    expect(writeDue(store, id, 1, { responseDue: '2026-11-12', replyDue: null, replySince: null }, [], 'u1', NOW)).toBe(true);
    expect(writeDue(store, id, 1, { responseDue: '2026-11-20', replyDue: null, replySince: null }, [], 'u2', NOW)).toBe(false);
    expect(loadDue(store, [id]).get(id)?.responseDue).toBe('2026-11-12');
  });
});
