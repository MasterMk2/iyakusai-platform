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
import { SmtpError, type MailTransport } from '../../src/server/mailbox/smtp.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import type { MailSentItem } from '../../src/shared/mailbox.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, setup } from '../discord-auth/helpers.js';
import { ADM, ALIAS_DOMAIN, COLLECTOR, CONTACT, DOMAIN, ingest, OUTSIDE, PERSONAL, rawMail, SPONSOR, testMailboxConfig } from './helpers.js';

// 送信箱 (2026-11-23): mail the committee sent, from this app, from the account's Gmail directly or from a member's own
// address, and the sends from this app that did not go out (or may not have). Synthetic addresses only (.example).

const ARCHIVE = `archive@${DOMAIN}`;
const SEND = { smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpUser: COLLECTOR, smtpPasswordFile: '/not/read/in/tests', fromName: '合成 医学薬学祭実行委員会', mailboxes: ['contact', 'sponsorship'] };
const ORIGIN = `http://${TEST_HOST}`;

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let key: Buffer;
let failNext: SmtpError | null = null;
const sent: Buffer[] = [];

const recording: MailTransport = {
  async send(_envelope, raw) {
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    sent.push(raw);
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
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mail-sent-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  sent.length = 0;
  failNext = null;
  await build();
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { body?: unknown; cookie?: string; raw?: { payload: Buffer; contentType: string } } = {}) {
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
  return { status: res.statusCode, json: json as any };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string) {
  const { initialLoginId } = await register(ctx, uid, studentId, []);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ loginId: studentId, password: PASSWORD }) });
  expect(login.statusCode).toBe(200);
  return { cookie: cookieOf(login.headers['set-cookie']), id: initialLoginId };
}

function form(message: unknown): { payload: Buffer; contentType: string } {
  const boundary = `----form${randomBytes(8).toString('hex')}`;
  return { payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify(message)}\r\n--${boundary}--\r\n`, 'utf8'), contentType: `multipart/form-data; boundary=${boundary}` };
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

const put = (raw: Buffer, at: number) => ingest(app, key, TEST_HOST, raw, { now: ctx.clock.now, at });
/** A time this many minutes before the test clock (moving the clock far would end the sign-in). */
const ago = (minutes: number) => ctx.clock.now - minutes * 60_000;

async function grantSend(chair: { cookie: string }, userId: string, mailboxId: string) {
  expect((await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId, mailboxId, send: true } })).status).toBe(200);
}

const list = async (cookie: string, query = '') => (await call('GET', `/api/mail/sent${query ? `?${query}` : ''}`, { cookie })).json as { items: MailSentItem[]; total: number };

describe('送信箱', () => {
  it('lists mail sent from the app, from Gmail and from members own addresses, newest first, and leaves out mail a group delivered for someone else', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json.sentBox).toBe(true);

    // Sent from Gmail directly with a mailbox's address (on the alias domain too, with a +tag).
    await put(rawMail({ messageId: 'gmail-1@committee.example', from: `"問い合わせ" <${CONTACT}>`, to: `"取引先" <${OUTSIDE}>`, cc: ADM, subject: 'Gmail から送った案内' }), ago(500));
    await put(rawMail({ messageId: 'gmail-2@committee.example', from: `contact+news@${ALIAS_DOMAIN}`, to: OUTSIDE, subject: '別ドメインから送った案内' }), ago(400));
    // Not the committee's: a post a group delivered with its own address as From, and outside mail.
    await put(rawMail({ messageId: 'via-1@partner.example', from: `"'取引先 担当' via 協賛" <${SPONSOR}>`, to: SPONSOR, subject: 'グループに届いた問い合わせ' }), ago(300));
    // A member's own address counts, to a committee group too (decided 2026-11-23).
    await put(rawMail({ messageId: 'own-1@committee.example', from: PERSONAL, to: CONTACT, subject: '委員の個人アドレスから' }), ago(200));
    await put(rawMail({ messageId: 'out-1@partner.example', to: CONTACT, subject: '外からの問い合わせ' }), ago(100));

    // Sent from the app by the chair (BCC counted, never shown).
    await grantSend(chair, chair.id, 'sponsorship');
    const res = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ cc: [CONTACT], bcc: ['hidden@partner.example'] })) });
    expect(res.status).toBe(200);

    // Without a signature naming the address, the row has the address (the mail gives no name).
    expect((await list(member.cookie)).items[1]).toMatchObject({ subject: '委員の個人アドレスから', via: 'personal', mailbox: null, senderName: PERSONAL });
    expect((await call('PUT', '/api/signature', { cookie: chair.cookie, body: { title: '', personalEmail: PERSONAL } })).status).toBe(200);

    const all = await list(member.cookie);
    expect(all.total).toBe(4);
    expect(all.items.map((i) => i.subject)).toEqual(['協賛のお願い', '委員の個人アドレスから', '別ドメインから送った案内', 'Gmail から送った案内']);
    expect(all.items[1]).toMatchObject({ via: 'personal', mailbox: null, senderName: '合成 委員長', to: ['contact@committee.example'], recipients: 1 });
    expect(all.items[0]).toMatchObject({ id: res.json.receiptId, threadId: res.json.threadId, state: 'sent', via: 'app', senderName: '合成 委員長', mailbox: { id: 'sponsorship', name: '協賛' }, to: ['取引先 ご担当者様'], recipients: 3, attachments: 0, reason: null });
    expect(all.items[3]).toMatchObject({ state: 'sent', via: 'gmail', senderName: null, mailbox: { id: 'contact' }, to: ['取引先'], recipients: 2 });
    expect(JSON.stringify(all)).not.toContain('hidden@partner.example');

    // The account's own copy of the app's mail, collected later, is the same row.
    expect((await put(sent[0]!, ctx.clock.now)).json.status).toBe('linked');
    expect((await list(member.cookie)).total).toBe(4);

    expect((await list(member.cookie, 'mailboxId=contact')).items.map((i) => i.subject)).toEqual(['別ドメインから送った案内', 'Gmail から送った案内']);
    expect((await list(chair.cookie, 'mine=1')).items.map((i) => i.subject)).toEqual(['協賛のお願い', '委員の個人アドレスから']);
    expect((await list(member.cookie, 'personal=1')).items.map((i) => i.subject)).toEqual(['委員の個人アドレスから']);
    expect((await call('GET', '/api/mail/sent?personal=1&mailboxId=contact', { cookie: member.cookie })).status).toBe(400);
    expect((await list(member.cookie, 'mine=1')).total).toBe(0);
    expect((await list(member.cookie, `q=${encodeURIComponent('gmail 案内')}`)).items.map((i) => i.subject)).toEqual(['Gmail から送った案内']);
    expect((await list(member.cookie, 'pageSize=1&page=3')).items.map((i) => i.subject)).toEqual(['別ドメインから送った案内']);
    expect((await call('GET', '/api/mail/sent?mailboxId=nowhere', { cookie: member.cookie })).status).toBe(404);
    expect((await call('GET', '/api/mail/sent?state=sent', { cookie: member.cookie })).status).toBe(400);
    expect((await call('GET', '/api/mail/sent')).status).toBe(401);
  });

  it('shows everyone the sends that were refused or may have gone out, until a copy shows they went', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await grantSend(chair, chair.id, 'contact');
    await put(rawMail({ messageId: 'root@partner.example', to: CONTACT, subject: '出展の問い合わせ' }), ago(500));
    const threadId = (await call('GET', '/api/inbox', { cookie: chair.cookie })).json.items[0].threadId;
    const receiptId = (await call('GET', `/api/threads/${threadId}`, { cookie: chair.cookie })).json.receipts[0].receiptId;

    failNext = new SmtpError('recipient', 550, 'no', 'メールサーバーが受け付けませんでした（550）。');
    expect((await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ mailboxId: 'contact', subject: 'Re: 出展の問い合わせ', replyToReceiptId: receiptId })) })).status).toBe(502);
    ctx.clock.now += 60_000;
    failNext = new SmtpError('data', null, 'unknown', 'メールサーバーとの通信が途中で切れました。');
    expect((await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ mailboxId: 'contact', to: [OUTSIDE, `second@partner.example`] })) })).status).toBe(502);
    expect(sent).toHaveLength(0);

    const shown = await list(member.cookie);
    expect(shown.items.map((i) => [i.state, i.via, i.senderName, i.subject, i.recipients])).toEqual([
      ['unknown', 'app', '合成 委員長', null, 2],
      ['failed', 'app', '合成 委員長', null, 1],
    ]);
    expect(shown.items[1]).toMatchObject({ mailbox: { id: 'contact' }, threadId: null, attachments: null, replyTo: { threadId, subject: '出展の問い合わせ' }, reason: '宛先が受け付けられませんでした（550）' });
    expect(shown.items[0]).toMatchObject({ replyTo: null, reason: null });
    expect((await list(member.cookie, 'state=problem')).total).toBe(2);
    // A send from this app always has a mailbox's address: none is from an own address.
    expect((await list(member.cookie, 'personal=1')).total).toBe(0);
    // A search looks in subjects and text, which these sends do not have.
    expect((await list(member.cookie, 'q=%E5%87%BA%E5%B1%95')).items.map((i) => i.state)).toEqual([]);

    // The account's copy of the cut-off send arrives: it did go out, as the chair's mail.
    const internetId = (mail.db.prepare("SELECT internet_message_id AS id FROM outgoing WHERE status='unknown'").get() as { id: string }).id;
    await put(rawMail({ messageId: internetId, from: `"合成 医学薬学祭実行委員会" <${CONTACT}>`, to: OUTSIDE, subject: '届いていた案内' }), ctx.clock.now + 5_000);
    const after = await list(member.cookie);
    expect(after.items.map((i) => [i.state, i.via, i.senderName, i.subject])).toEqual([
      ['sent', 'app', '合成 委員長', '届いていた案内'],
      ['failed', 'app', '合成 委員長', null],
    ]);
    expect((await list(member.cookie, 'state=problem')).items.map((i) => i.state)).toEqual(['failed']);
  });

  it('reads a send left "sending" for over ten minutes as one that may have gone out', async () => {
    const member = await signIn(MEMBER, '21000002');
    mail.claimOutgoing({ id: 'og_0000000000000001', client_token: 'token-token-token-1', user_id: member.id, mailbox_id: 'sponsorship', internet_message_id: 'cut@committee.example', reply_to_id: null, recipients: 1, bcc_json: '[]', size: 10, created_at: new Date(ctx.clock.now).toISOString() });
    expect((await list(member.cookie)).items.map((i) => i.state)).toEqual(['sending']);
    ctx.clock.now += 11 * 60_000;
    expect((await list(member.cookie)).items.map((i) => [i.state, i.senderName])).toEqual([['unknown', '合成 太郎']]);
  });
});
