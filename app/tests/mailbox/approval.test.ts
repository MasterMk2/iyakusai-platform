import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { parseRawMail } from '../../src/server/mailbox/parse.js';
import { SmtpError, type MailTransport, type SmtpEnvelope } from '../../src/server/mailbox/smtp.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { committeeMailSource } from '../../src/server/rollover/grants.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_PLANNING, setup } from '../discord-auth/helpers.js';
import { COLLECTOR, DOMAIN, ingest, OUTSIDE, rawMail, SPONSOR, testMailboxConfig } from './helpers.js';

// Approval before sending (2026-11-11): a member's mail waits until a reviewer of the From mailbox approves it.
// The HTTP routes with a recording transport, as in send.test.ts. Synthetic addresses only (.example).

const ARCHIVE = `archive@${DOMAIN}`;
const SEND = { smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpUser: COLLECTOR, smtpPasswordFile: '/not/read/in/tests', fromName: '合成 医学薬学祭実行委員会', mailboxes: ['contact', 'sponsorship'] };
const ORIGIN = `http://${TEST_HOST}`;

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let key: Buffer;
const sent: { envelope: SmtpEnvelope; raw: Buffer }[] = [];
let failNext: SmtpError | null = null;

const recording: MailTransport = {
  async send(envelope, raw) {
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    sent.push({ envelope, raw });
  },
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mail-approval-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  sent.length = 0;
  failNext = null;
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
  return { status: res.statusCode, headers: res.headers, json: json as any, body: res.rawPayload };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  const { initialLoginId } = await register(ctx, uid, studentId, roles);
  const login = await call('POST', '/api/auth/login', { body: { loginId: studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return { cookie: cookieOf(login.headers['set-cookie']), id: initialLoginId };
}

type File = { name: string; type: string; content: Buffer };

/** multipart/form-data as the browser's FormData sends it. */
function form(message: unknown, files: File[] = []): { payload: Buffer; contentType: string } {
  const boundary = `----form${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify(message)}\r\n`, 'utf8')];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachments"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`, 'utf8'), f.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
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
const request = (changes: Record<string, unknown> = {}) => ({ ...message(), note: '', ...changes });

const PDF: File = { name: '申込書.pdf', type: 'application/pdf', content: Buffer.from('%PDF-synthetic') };
const grant = (cookie: string, body: Record<string, unknown>) => call('PUT', '/api/mail/admin/access', { cookie, body });
const submit = (cookie: string, changes: Record<string, unknown> = {}, files: File[] = []) => call('POST', '/api/mail/approvals', { cookie, raw: form(request(changes), files) });
const act = (cookie: string, id: string, what: 'approve' | 'return' | 'withdraw', body: Record<string, unknown>) => call('POST', `/api/mail/approvals/${id}/${what}`, { cookie, body });

/** The chair (administrator) reviews 協賛; the member holds no send grant. */
async function people() {
  const chair = await signIn(CHAIR, '21000001');
  const member = await signIn(MEMBER, '21000002');
  expect((await grant(chair.cookie, { userId: chair.id, mailboxId: 'sponsorship', review: true })).status).toBe(200);
  return { chair, member };
}

describe('who writes mail that waits for an approval', () => {
  it('opens the approval only for mailboxes that have a reviewer, and never lets such mail be sent directly', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    // No reviewer anywhere: as before, a member without a send grant writes no mail.
    expect((await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json).toMatchObject({ from: [], approvalMailboxIds: [] });
    expect((await submit(member.cookie)).status).toBe(403);

    // adm@ cannot send; a member cannot grant; review and send are separate ticks.
    expect((await grant(chair.cookie, { userId: chair.id, mailboxId: 'adm', review: true })).status).toBe(422);
    expect((await grant(member.cookie, { userId: member.id, mailboxId: 'sponsorship', review: true })).status).toBe(403);
    expect((await grant(chair.cookie, { userId: chair.id, mailboxId: 'sponsorship', review: true, send: true })).status).toBe(400);
    const granted = await grant(chair.cookie, { userId: chair.id, mailboxId: 'sponsorship', review: true });
    expect(granted.json).toMatchObject({ reviewGrants: [{ userId: chair.id, mailboxId: 'sponsorship' }], approvalRequired: [], sendGrants: [] });

    const options = (await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json;
    expect(options.from).toEqual([{ mailboxId: 'sponsorship', name: '協賛', address: SPONSOR }]);
    expect(options.approvalMailboxIds).toEqual(['sponsorship']);
    const direct = await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message()) });
    expect(direct.status).toBe(403);
    expect(direct.json.error).toBe('approval_needed');
    // The other mailbox has no reviewer: no approval there either.
    expect((await submit(member.cookie, { mailboxId: 'contact' })).status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(mail.audit(10).map((a) => a.action)).toContain('grant_review');
  });

  it('makes a marked person ask for an approval even with a send grant, until the mark is removed', async () => {
    const { chair, member } = await people();
    await grant(chair.cookie, { userId: member.id, mailboxId: 'sponsorship', send: true });
    expect((await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json.approvalMailboxIds).toEqual([]);
    expect((await grant(chair.cookie, { department: '企画部', mailboxId: 'sponsorship', approval: true })).status).toBe(400);
    const marked = await grant(chair.cookie, { userId: member.id, mailboxId: 'sponsorship', approval: true });
    expect(marked.json.approvalRequired).toEqual([{ userId: member.id, mailboxId: 'sponsorship' }]);

    expect((await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json.approvalMailboxIds).toEqual(['sponsorship']);
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message()) })).json.error).toBe('approval_needed');
    expect((await submit(member.cookie)).status).toBe(201);
    expect(sent).toHaveLength(0);

    await grant(chair.cookie, { userId: member.id, mailboxId: 'sponsorship', approval: false });
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message()) })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('gives the review grant to everyone in a department', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    const planner = await signIn(OTHER, '21000003', [ROLE_PLANNING]);
    const res = await grant(chair.cookie, { department: '企画部', mailboxId: 'sponsorship', review: true });
    expect(res.json.departmentGrants).toEqual([{ department: '企画部', mailboxId: 'sponsorship', kind: 'review' }]);
    const id = (await submit(member.cookie)).json.id;
    expect((await call('GET', '/api/mail/status', { cookie: planner.cookie })).json.approvals).toEqual({ toReview: 1, returned: 0 });
    expect((await act(planner.cookie, id, 'approve', { expectedVersion: 1 })).json.state).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

describe('asking, approving and sending', () => {
  it('keeps the mail until a reviewer approves it, then sends it once with the author as the sender of record', async () => {
    const { chair, member } = await people();
    const outsider = await signIn(OTHER, '21000003');
    const m = request({ note: '初めての依頼です。宛名を見てください。' });
    const asked = await call('POST', '/api/mail/approvals', { cookie: member.cookie, raw: form(m, [PDF]) });
    expect(asked.status).toBe(201);
    expect(asked.json).toMatchObject({ state: 'pending', version: 1, mine: true, canReview: false, authorName: '合成 太郎', subject: '協賛のお願い', note: '初めての依頼です。宛名を見てください。', attachments: [{ idx: 0, filename: '申込書.pdf' }], submitted: null, changedFields: [] });
    const id = asked.json.id as string;
    expect(sent).toHaveLength(0);
    // The same form again (its answer was lost): the same request, not a second one.
    expect((await call('POST', '/api/mail/approvals', { cookie: member.cookie, raw: form(m, [PDF]) })).json.id).toBe(id);

    expect((await call('GET', '/api/mail/status', { cookie: chair.cookie })).json.approvals).toEqual({ toReview: 1, returned: 0 });
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json.approvals).toEqual({ toReview: 0, returned: 0 });
    const lists = (await call('GET', '/api/mail/approvals', { cookie: chair.cookie })).json;
    expect(lists.review).toMatchObject([{ id, canReview: true, mine: false }]);
    expect((await call('GET', '/api/mail/approvals', { cookie: member.cookie })).json).toMatchObject({ review: [], mine: [{ id }], done: [] });

    // Only the author and the mailbox's reviewers read it; nobody approves their own mail.
    expect((await call('GET', `/api/mail/approvals/${id}`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await call('GET', `/api/mail/approvals/${id}/attachments/0`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await act(outsider.cookie, id, 'approve', { expectedVersion: 1 })).status).toBe(404);
    expect((await act(member.cookie, id, 'approve', { expectedVersion: 1 })).status).toBe(403);
    const file = await call('GET', `/api/mail/approvals/${id}/attachments/0`, { cookie: chair.cookie });
    expect(file.body.toString()).toBe('%PDF-synthetic');
    expect(file.headers['content-disposition']).toMatch(/^attachment/);

    const approved = await act(chair.cookie, id, 'approve', { expectedVersion: 1 });
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ state: 'sent', decidedByName: '合成 委員長', attachments: [] });
    expect(approved.json.history.map((h: { action: string }) => h.action)).toEqual(['submitted', 'approved', 'sent']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.envelope).toEqual({ from: COLLECTOR, to: [OUTSIDE, ARCHIVE] });
    const p = await parseRawMail(sent[0]!.raw);
    expect(p.from).toEqual({ name: '合成 医学薬学祭実行委員会', address: SPONSOR });
    expect(p.subject).toBe('協賛のお願い');
    expect(p.attachments.map((a) => a.filename)).toEqual(['申込書.pdf']);
    // The send's record names the author; the files are no longer kept with the request.
    expect(mail.db.prepare('SELECT user_id, status FROM outgoing').all()).toEqual([{ user_id: member.id, status: 'sent' }]);
    expect(mail.db.prepare('SELECT count(*) AS n FROM send_request_attachments').get()).toEqual({ n: 0 });
    const thread = (await call('GET', `/api/threads/${approved.json.sentThreadId}`, { cookie: member.cookie })).json;
    expect(thread.receipts).toMatchObject([{ subject: '協賛のお願い', triage: { status: 'done' } }]);

    // Approving again changes nothing and sends nothing.
    expect((await act(chair.cookie, id, 'approve', { expectedVersion: approved.json.version })).status).toBe(409);
    expect(sent).toHaveLength(1);
    expect((await call('GET', '/api/mail/status', { cookie: chair.cookie })).json.approvals).toEqual({ toReview: 0, returned: 0 });
    expect((await call('GET', '/api/mail/approvals', { cookie: member.cookie })).json).toMatchObject({ mine: [], done: [{ id, state: 'sent' }] });
    expect(JSON.stringify(mail.audit(20))).not.toContain(OUTSIDE);
  });

  it('checks the mail when it is asked for, by the rules of a send', async () => {
    const { member } = await people();
    expect((await submit(member.cookie, { to: [] })).status).toBe(422);
    expect((await submit(member.cookie, { to: ['not an address'] })).status).toBe(422);
    expect((await submit(member.cookie, { subject: ' ' })).status).toBe(422);
    expect((await submit(member.cookie, { replyToReceiptId: 'rc_0000000000000000' })).status).toBe(404);
    // A reply deadline needs the mailbox's edit grant, as on a send.
    expect((await submit(member.cookie, { replyDue: '2099-01-01' })).status).toBe(403);
    expect((await submit(member.cookie, { note: 'あ'.repeat(501) })).status).toBe(422);
    expect((await call('GET', '/api/mail/approvals', { cookie: member.cookie })).json.mine).toEqual([]);
  });

  it('answers a reply in its thread and sets the thread to 完了 when the author asked for it', async () => {
    const { chair, member } = await people();
    await ingest(app, key, TEST_HOST, rawMail({ messageId: 'root@partner.example', to: SPONSOR, subject: '協賛の件' }), { now: ctx.clock.now });
    const threadId = (await call('GET', '/api/inbox', { cookie: member.cookie })).json.items[0].threadId;
    const receiptId = (await call('GET', `/api/threads/${threadId}`, { cookie: member.cookie })).json.receipts[0].receiptId;
    const asked = await submit(member.cookie, { subject: 'Re: 協賛の件', replyToReceiptId: receiptId, markThreadDone: true });
    expect(asked.json.replyThread).toEqual({ threadId, subject: '協賛の件' });
    const approved = await act(chair.cookie, asked.json.id, 'approve', { expectedVersion: 1 });
    expect(approved.json).toMatchObject({ state: 'sent', sentThreadId: threadId });
    expect((await parseRawMail(sent[0]!.raw)).inReplyTo).toBe('root@partner.example');
    const thread = (await call('GET', `/api/threads/${threadId}`, { cookie: member.cookie })).json;
    expect(thread.receipts.map((r: { triage: { status: string } }) => r.triage.status)).toEqual(['done', 'done']);
  });
});

describe('returning, changing and withdrawing', () => {
  it('returns the mail with a comment; the author changes it and asks again', async () => {
    const { chair, member } = await people();
    const id = (await submit(member.cookie, {}, [PDF, { name: '古い案内.txt', type: 'text/plain', content: Buffer.from('old') }])).json.id as string;
    expect((await act(chair.cookie, id, 'return', { expectedVersion: 1, comment: '  ' })).status).toBe(422);
    expect((await act(member.cookie, id, 'return', { expectedVersion: 1, comment: '自分で' })).status).toBe(403);
    const returned = await act(chair.cookie, id, 'return', { expectedVersion: 1, comment: '宛名の敬称を「様」にしてください。' });
    expect(returned.json).toMatchObject({ state: 'returned', returnComment: '宛名の敬称を「様」にしてください。', canReview: false });
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json.approvals).toEqual({ toReview: 0, returned: 1 });
    expect((await call('GET', '/api/mail/status', { cookie: chair.cookie })).json.approvals).toEqual({ toReview: 0, returned: 0 });
    // A returned mail cannot be approved as it is.
    expect((await act(chair.cookie, id, 'approve', { expectedVersion: returned.json.version })).status).toBe(409);

    const again = request({ body: '取引先 ご担当者様\n\n直した本文です。', note: '直しました。', expectedVersion: returned.json.version, keepAttachments: [0] });
    const stale = await call('PUT', `/api/mail/approvals/${id}`, { cookie: member.cookie, raw: form({ ...again, expectedVersion: 1 }) });
    expect(stale.status).toBe(409);
    expect((await call('PUT', `/api/mail/approvals/${id}`, { cookie: chair.cookie, raw: form(again) })).status).toBe(403);
    const asked = await call('PUT', `/api/mail/approvals/${id}`, { cookie: member.cookie, raw: form(again, [{ name: '新しい案内.txt', type: 'text/plain', content: Buffer.from('new') }]) });
    expect(asked.status).toBe(200);
    expect(asked.json).toMatchObject({ state: 'pending', returnComment: null, note: '直しました。', attachments: [{ idx: 0, filename: '申込書.pdf' }, { idx: 1, filename: '新しい案内.txt' }] });
    // The same form again answers with the request as it is.
    expect((await call('PUT', `/api/mail/approvals/${id}`, { cookie: member.cookie, raw: form(again) })).json.version).toBe(asked.json.version);

    const approved = await act(chair.cookie, id, 'approve', { expectedVersion: asked.json.version });
    expect(approved.json.state).toBe('sent');
    const p = await parseRawMail(sent[0]!.raw);
    expect(p.text).toContain('直した本文です。');
    expect(p.attachments.map((a) => a.filename)).toEqual(['申込書.pdf', '新しい案内.txt']);
    expect(approved.json.history.map((h: { action: string }) => h.action)).toEqual(['submitted', 'returned', 'resubmitted', 'approved', 'sent']);
  });

  it('lets a reviewer change the mail before approving, and shows the author what was changed', async () => {
    const { chair, member } = await people();
    const asked = (await submit(member.cookie)).json;
    const change = { expectedVersion: 1, to: asked.message.to, cc: [], bcc: [], subject: '【医薬祭】協賛のお願い', body: '取引先 ご担当者様\n\n校閲者が直した本文です。', replyTo: null, replyDue: null };
    expect((await call('PATCH', `/api/mail/approvals/${asked.id}`, { cookie: member.cookie, body: change })).status).toBe(403);
    expect((await call('PATCH', `/api/mail/approvals/${asked.id}`, { cookie: chair.cookie, body: { ...change, to: ['not an address'] } })).status).toBe(422);
    const edited = await call('PATCH', `/api/mail/approvals/${asked.id}`, { cookie: chair.cookie, body: change });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ version: 2, changedFields: ['subject', 'body'], subject: '【医薬祭】協賛のお願い', submitted: { subject: '協賛のお願い' } });
    expect(edited.json.history[1]).toMatchObject({ action: 'edited', actorName: '合成 委員長', detail: '件名・本文' });

    // The version read before the change no longer approves: what is approved is what was seen.
    expect((await act(chair.cookie, asked.id, 'approve', { expectedVersion: 1 })).status).toBe(409);
    expect(sent).toHaveLength(0);
    expect((await act(chair.cookie, asked.id, 'approve', { expectedVersion: 2 })).json.state).toBe('sent');
    const p = await parseRawMail(sent[0]!.raw);
    expect(p.subject).toBe('【医薬祭】協賛のお願い');
    expect(p.text).toContain('校閲者が直した本文です。');
    const mine = (await call('GET', `/api/mail/approvals/${asked.id}`, { cookie: member.cookie })).json;
    expect(mine).toMatchObject({ state: 'sent', changedFields: ['subject', 'body'], submitted: { body: '取引先 ご担当者様\n\n合成の本文です。' } });
  });

  it('lets the author withdraw a waiting mail; it can then no longer be approved', async () => {
    const { chair, member } = await people();
    const id = (await submit(member.cookie, {}, [PDF])).json.id as string;
    expect((await act(chair.cookie, id, 'withdraw', { expectedVersion: 1 })).status).toBe(403);
    const withdrawn = await act(member.cookie, id, 'withdraw', { expectedVersion: 1 });
    expect(withdrawn.json).toMatchObject({ state: 'withdrawn', attachments: [] });
    expect((await act(chair.cookie, id, 'approve', { expectedVersion: 1 })).status).toBe(409);
    expect((await act(chair.cookie, id, 'approve', { expectedVersion: withdrawn.json.version })).status).toBe(409);
    expect(sent).toHaveLength(0);
    expect((await call('GET', '/api/mail/status', { cookie: chair.cookie })).json.approvals).toEqual({ toReview: 0, returned: 0 });
  });
});

describe('when the send fails', () => {
  it('keeps the mail waiting after a refusal, and never sends again after a cut connection', async () => {
    const { chair, member } = await people();
    const id = (await submit(member.cookie)).json.id as string;
    failNext = new SmtpError('recipient', 550, 'no', 'メールサーバーが宛先を受け付けませんでした。');
    const refused = await act(chair.cookie, id, 'approve', { expectedVersion: 1 });
    expect(refused.status).toBe(502);
    expect(refused.json.error).toBe('send_failed');
    const waiting = (await call('GET', `/api/mail/approvals/${id}`, { cookie: chair.cookie })).json;
    expect(waiting).toMatchObject({ state: 'pending', canReview: true, decidedByName: null });
    expect(waiting.history.map((h: { action: string }) => h.action)).toEqual(['submitted', 'approved', 'send_failed']);

    failNext = new SmtpError('data', null, 'unknown', '送信の途中で接続が切れました。');
    const cut = await act(chair.cookie, id, 'approve', { expectedVersion: waiting.version });
    expect(cut.status).toBe(502);
    expect(cut.json.error).toBe('send_unknown');
    const unknown = (await call('GET', `/api/mail/approvals/${id}`, { cookie: member.cookie })).json;
    expect(unknown).toMatchObject({ state: 'unknown' });
    expect((await act(chair.cookie, id, 'approve', { expectedVersion: unknown.version })).status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});

describe('the year rollover', () => {
  it('lists the review grants and the 承認必須 marks, and removes them', async () => {
    const { chair, member } = await people();
    await grant(chair.cookie, { userId: member.id, mailboxId: 'sponsorship', approval: true });
    await signIn(OTHER, '21000003', [ROLE_PLANNING]);
    await grant(chair.cookie, { department: '企画部', mailboxId: 'contact', review: true });
    const source = committeeMailSource(mail, [{ id: 'sponsorship', name: '協賛' }, { id: 'contact', name: '問い合わせ' }]);
    const entries = source.entries();
    expect(entries.map((e) => e.permission)).toEqual(['校閲（承認・差し戻し）', '校閲（承認・差し戻し・部局）', '承認必須（送信の前に校閲者の承認）']);
    for (const e of entries) e.revoke!({ id: chair.id, displayName: '合成 委員長', roleLabel: '委員', email: '', canManageAccess: true }, new Date(ctx.clock.now).toISOString());
    expect(source.entries()).toEqual([]);
    expect((await call('GET', '/api/mail/admin/access', { cookie: chair.cookie })).json).toMatchObject({ reviewGrants: [], approvalRequired: [], departmentGrants: [] });
  });
});
