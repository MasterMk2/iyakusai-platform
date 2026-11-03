import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import type { MailTransport, SmtpEnvelope } from '../../src/server/mailbox/smtp.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, setup } from '../discord-auth/helpers.js';
import { CONTACT, DOMAIN, ingest, OUTSIDE, PERSONAL, rawMail, SPONSOR, testMailboxConfig } from './helpers.js';

// Deadlines in the committee mail over HTTP (2026-11-03): a reply deadline on a sent mail, the response due of a
// received one, the reply that clears a wait, the lists for the home screen. Synthetic addresses (.example) only.

const ARCHIVE = `archive@${DOMAIN}`;
const SEND = { smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpUser: `taro@${DOMAIN}`, smtpPasswordFile: '/not/read/in/tests', fromName: '合成 医学薬学祭実行委員会', mailboxes: ['contact', 'sponsorship'] };
/** 2026-11-03 10:00 in Japan (the test clock). */
const T0 = Date.parse('2026-11-03T01:00:00.000Z');
const ORIGIN = `http://${TEST_HOST}`;
// Each test signs several accounts in (password hashing), which takes seconds on a busy machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let key: Buffer;
const sent: { envelope: SmtpEnvelope; raw: Buffer }[] = [];
const recording: MailTransport = {
  async send(envelope, raw) {
    sent.push({ envelope, raw });
  },
};

async function build() {
  key = randomBytes(32);
  const config = testMailboxConfig(path.join(dir, 'mail'), { draftBccAddress: ARCHIVE, send: SEND }, key, 'abcdabcdabcdabcd');
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases), transport: recording },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mail-due-http-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  ctx.clock.now = T0;
  sent.length = 0;
  await build();
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, options: { body?: unknown; cookie?: string; raw?: { payload: Buffer; contentType: string } } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.raw ? { 'content-type': options.raw.contentType } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : options.raw ? { payload: options.raw.payload } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, headers: res.headers, json: json as any };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

interface Member {
  cookie: string;
  id: string;
  studentId: string;
}

async function signIn(uid: string, studentId: string, roles: string[] = []): Promise<Member> {
  const { initialLoginId } = await register(ctx, uid, studentId, roles);
  const login = await call('POST', '/api/auth/login', { body: { loginId: studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return { cookie: cookieOf(login.headers['set-cookie']), id: initialLoginId, studentId };
}

/** A fresh sign-in on the (moved) test clock: the mail screens ask for the password again after 12 idle hours. */
async function again(m: Member): Promise<Member> {
  const login = await call('POST', '/api/auth/login', { body: { loginId: m.studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return { ...m, cookie: cookieOf(login.headers['set-cookie']) };
}

/** multipart/form-data as the browser's FormData sends it. */
function form(message: unknown): { payload: Buffer; contentType: string } {
  const boundary = `----form${randomBytes(8).toString('hex')}`;
  const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify(message)}\r\n--${boundary}--\r\n`, 'utf8');
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

const message = (changes: Record<string, unknown> = {}) => ({
  clientToken: randomBytes(12).toString('base64url'),
  mailboxId: 'sponsorship',
  to: [`取引先 ご担当者様 <${OUTSIDE}>`],
  cc: [],
  bcc: [],
  subject: '協賛のお願い',
  body: '取引先 ご担当者様\n\n合成の本文です。',
  replyToReceiptId: null,
  markThreadDone: false,
  ...changes,
});

const put = (raw: Buffer, o: Parameters<typeof ingest>[4] = {}) => ingest(app, key, TEST_HOST, raw, { now: ctx.clock.now, ...o });

/** The Message-ID of the nth sent message (as the server wrote it). */
function sentMessageId(n = 0): string {
  const match = /^Message-ID:\s*<([^>]+)>/im.exec(sent[n]!.raw.toString('utf8'));
  if (!match) throw new Error('Message-ID が見つかりません');
  return match[1]!;
}

async function firstThread(m: Member, query = '') {
  const list = await call('GET', `/api/threads${query}`, { cookie: m.cookie });
  return list.json.items as { threadId: string; due: { replyWait: { dueOn: string; overdue: boolean } | null; responseDue: string | null } }[];
}

async function receiptOf(m: Member, threadId: string): Promise<string> {
  return (await call('GET', `/api/threads/${threadId}`, { cookie: m.cookie })).json.receipts[0].receiptId as string;
}

describe('a reply deadline on a sent mail', () => {
  it('makes the thread wait; a reply from outside clears the wait, a member or an older mail does not', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    expect((await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } })).status).toBe(200);
    expect((await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', edit: true } })).status).toBe(200);
    expect((await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json.dueMailboxIds).toEqual(['sponsorship']);

    const sentRes = await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message({ replyDue: '2026-11-10' })) });
    expect(sentRes.status).toBe(200);
    expect(sentRes.json).toMatchObject({ status: 'sent', replyWait: 'set' });
    expect(sent).toHaveLength(1);

    const threads = await firstThread(member, '?due=awaiting');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.due.replyWait).toMatchObject({ dueOn: '2026-11-10', overdue: false });
    const threadId = threads[0]!.threadId;
    const receipt = await receiptOf(member, threadId);
    expect((await call('GET', `/api/receipts/${receipt}`, { cookie: member.cookie })).json.due).toMatchObject({ canEdit: true, replyWaitAllowed: true, replyWait: { dueOn: '2026-11-10' } });

    const id = sentMessageId();
    // A member's own address answering does not count as the partner's reply.
    expect((await put(rawMail({ messageId: 'in-1@committee.example', from: PERSONAL, to: SPONSOR, inReplyTo: id, subject: 'Re: 協賛のお願い' }), { id: 'g-own', at: T0 + 3_600_000 })).json.status).toBe('stored');
    expect((await firstThread(member, '?due=awaiting')).length).toBe(1);
    // A reply from outside that arrived before the wait began (an older copy) does not clear it.
    expect((await put(rawMail({ messageId: 'old-1@partner.example', from: OUTSIDE, to: SPONSOR, inReplyTo: id, subject: 'Re: 協賛のお願い' }), { id: 'n-old', source: 'backfill', at: T0 - 86_400_000 })).json.status).toBe('stored');
    expect((await firstThread(member, '?due=awaiting')).length).toBe(1);

    // The partner's reply clears the wait, and the history says it was cleared automatically.
    expect((await put(rawMail({ messageId: 'in-2@partner.example', from: OUTSIDE, to: SPONSOR, inReplyTo: id, subject: 'Re: 協賛のお願い' }), { id: 'g-reply', at: T0 + 7_200_000 })).json.status).toBe('stored');
    expect((await firstThread(member, '?due=awaiting'))).toHaveLength(0);
    const detail = (await call('GET', `/api/receipts/${receipt}`, { cookie: member.cookie })).json;
    expect(detail.due.replyWait).toBeNull();
    const cleared = detail.history.filter((h: { action: string }) => h.action === 'reply_wait').at(-1);
    expect(cleared).toMatchObject({ actorName: '自動（返信の受信）', from: '11月10日（火）まで', to: null });
  });

  it('needs the mailbox edit grant, a real day from today; a refused send sends nothing', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } });

    // Only the send grant: the deadline is refused before anything is sent.
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message({ replyDue: '2026-11-10' })) })).status).toBe(403);
    expect(sent).toHaveLength(0);
    // With the edit grant, a past day and an impossible day are refused.
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', edit: true } });
    // A refused date is a validation answer (422, as the other fields); the message is not sent.
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message({ replyDue: '2026-11-02' })) })).status).toBe(422);
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message({ replyDue: '2026-02-30' })) })).status).toBe(422);
    expect(sent).toHaveLength(0);
    // Without a deadline, the send is as before (an older screen sends nothing of it).
    const plain = await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message()) });
    expect(plain.json).toMatchObject({ status: 'sent', replyWait: 'none' });
  });

  it('changes the reply deadline of a sent mail by PATCH; a day already past is refused', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } });
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', edit: true } });
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message()) })).json).toMatchObject({ status: 'sent', replyWait: 'none' });
    const receipt = await receiptOf(member, (await firstThread(member))[0]!.threadId);
    const patch = (expectedVersion: number, replyDue: string) => call('PATCH', `/api/receipts/${receipt}/due`, { cookie: member.cookie, body: { expectedVersion, replyDue } });

    const before = (await call('GET', `/api/receipts/${receipt}`, { cookie: member.cookie })).json.due;
    expect(before).toMatchObject({ replyWaitAllowed: true, replyWait: null });
    const set = await patch(before.version, '2026-11-10');
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ replyWaitAllowed: true, replyWait: { dueOn: '2026-11-10', overdue: false } });
    expect(await firstThread(member, '?due=awaiting')).toHaveLength(1);
    // A changed reply deadline must be today or later (the test clock is 2026-11-03 in Japan).
    const past = await patch(set.json.version, '2026-11-02');
    expect(past.status).toBe(422);
    expect(past.json).toMatchObject({ message: '回答期限は今日以降の日付にしてください。', details: { field: 'replyDue' } });
  });

  it('answers a send sent again with the same token: the wait is named, and nothing goes out twice', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } });
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', edit: true } });
    const body = message({ replyDue: '2026-11-10' });
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(body) })).json).toMatchObject({ status: 'sent', replyWait: 'set' });
    const again = await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(body) });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: 'sent', replyWait: 'set' });
    expect(sent).toHaveLength(1);
  });
});

describe('a response due on a received mail', () => {
  it('is changed by a person with the edit grant, with the version and the history', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await put(rawMail({ messageId: 'q1@partner.example', from: OUTSIDE, to: CONTACT, subject: '問い合わせ' }), { id: 'g-q1' });
    const threadId = (await firstThread(member))[0]!.threadId;
    const receipt = await receiptOf(member, threadId);
    const patch = (cookie: string, body: unknown) => call('PATCH', `/api/receipts/${receipt}/due`, { cookie, body });

    expect((await patch(member.cookie, { expectedVersion: 1, responseDue: '2026-11-06' })).status).toBe(403);
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'contact', edit: true } });

    const ok = await patch(member.cookie, { expectedVersion: 1, responseDue: '2026-11-06' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ version: 2, responseDue: '2026-11-06', responseOverdue: false, canEdit: true });
    // The same version again is a conflict, and the answer carries the newer state.
    const stale = await patch(member.cookie, { expectedVersion: 1, responseDue: '2026-11-20' });
    expect(stale.status).toBe(409);
    expect(stale.json.current).toMatchObject({ responseDue: '2026-11-06' });
    expect((await patch(member.cookie, { expectedVersion: 2, responseDue: '2026-02-30' })).status).toBe(422);
    // A body with nothing to change is a request error.
    expect((await patch(member.cookie, { expectedVersion: 2 })).status).toBe(400);

    const detail = (await call('GET', `/api/receipts/${receipt}`, { cookie: member.cookie })).json;
    expect(detail.history.filter((h: { action: string }) => h.action === 'due')).toEqual([expect.objectContaining({ actorName: '合成 太郎', from: null, to: '11月6日（金）' })]);
    // Removing it is a change too.
    const removed = await patch(member.cookie, { expectedVersion: 2, responseDue: null });
    expect(removed.json).toMatchObject({ version: 3, responseDue: null });
  });
});

describe('a reply deadline on a mail the committee did not send', () => {
  it('is refused with the reason and changes nothing; a response due and removing a wait are still allowed', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await put(rawMail({ messageId: 'q3@partner.example', from: OUTSIDE, to: CONTACT, subject: '問い合わせ' }), { id: 'g-q3' });
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'contact', edit: true } });
    const receipt = await receiptOf(member, (await firstThread(member))[0]!.threadId);
    const patch = (body: unknown) => call('PATCH', `/api/receipts/${receipt}/due`, { cookie: member.cookie, body });

    const view = (await call('GET', `/api/receipts/${receipt}`, { cookie: member.cookie })).json.due;
    expect(view).toMatchObject({ canEdit: true, replyWaitAllowed: false, replyWait: null });
    const refused = await patch({ expectedVersion: view.version, replyDue: '2026-11-10' });
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ error: 'validation', message: '回答期限は、委員会が送ったメールに付けます。受信したメールには付けられません。', details: { field: 'replyDue' } });
    expect((await call('GET', `/api/receipts/${receipt}`, { cookie: member.cookie })).json.due).toMatchObject({ version: view.version, replyWait: null });
    expect(await firstThread(member, '?due=awaiting')).toHaveLength(0);
    // Removing a wait is not refused on any mail (here there is none, so nothing is written).
    expect((await patch({ expectedVersion: view.version, replyDue: null })).status).toBe(200);
    // A response due is still allowed on a received mail.
    expect((await patch({ expectedVersion: view.version, responseDue: '2026-11-06' })).json).toMatchObject({ version: view.version + 1, responseDue: '2026-11-06' });
  });
});

describe('the home screen and the lists', () => {
  it('lists the reply waits passed and the responses near, mail only; the lists sort by the nearest deadline', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } });
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', edit: true } });
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'contact', edit: true } });
    await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message({ replyDue: '2026-11-05' })) });
    await put(rawMail({ messageId: 'q2@partner.example', from: OUTSIDE, to: CONTACT, subject: '別件' }), { id: 'g-q2' });
    const contactThread = (await firstThread(member, '?mailboxId=contact'))[0]!.threadId;
    const contactReceipt = await receiptOf(member, contactThread);
    expect((await call('PATCH', `/api/receipts/${contactReceipt}/due`, { cookie: member.cookie, body: { expectedVersion: 1, responseDue: '2026-11-06' } })).status).toBe(200);

    // Two days later (2026-11-05 10:00 JST is the reply deadline; the response due is 11-06).
    ctx.clock.now = Date.parse('2026-11-06T01:00:00.000Z');
    const later = await again(member);

    const home = (await call('GET', '/api/mail/due', { cookie: later.cookie })).json;
    expect(home).toMatchObject({ today: '2026-11-06', counts: { replyOverdue: 1, responseDue: 1 } });
    expect(home.replyOverdue[0]).toMatchObject({ kind: 'reply', dueOn: '2026-11-05', overdue: true, mailboxName: '協賛' });
    expect(home.responseDue[0]).toMatchObject({ kind: 'response', dueOn: '2026-11-06', overdue: false, mailboxName: '問い合わせ' });

    // Sorted by the nearest deadline (the overdue reply wait first), and the overdue filter keeps the reply wait.
    const byDue = await firstThread(later, '?sort=due');
    expect(byDue.map((t) => t.due.replyWait?.dueOn ?? t.due.responseDue)).toEqual(['2026-11-05', '2026-11-06']);
    expect((await firstThread(later, '?due=overdue')).map((t) => t.due.replyWait?.dueOn)).toEqual(['2026-11-05']);
  });

  it('answers the lists without a deadline with nothing, and refuses an unknown filter', async () => {
    const member = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/mail/due', { cookie: member.cookie })).json).toMatchObject({ counts: { replyOverdue: 0, responseDue: 0 } });
    expect((await call('GET', '/api/threads?due=later', { cookie: member.cookie })).status).toBe(400);
  });
});
