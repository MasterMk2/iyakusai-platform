import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { buildRawMail, ComposeError } from '../../src/server/mailbox/compose.js';
import { parseRawMail } from '../../src/server/mailbox/parse.js';
import { dotStuff, smtpTransport, SmtpError, type MailTransport, type SmtpEnvelope, type SmtpSettings } from '../../src/server/mailbox/smtp.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { parseRecipient, splitRecipients } from '../../src/shared/mailbox.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, ROLE_PLANNING, setup } from '../discord-auth/helpers.js';
import { ADM, COLLECTOR, DOMAIN, ingest, OUTSIDE, rawMail, SPONSOR, testMailboxConfig } from './helpers.js';

// Sending from the committee mailbox (2026-10-26): the message builder, the SMTP client against a local
// fake server, and the HTTP routes with a recording transport. Synthetic addresses only (.example).

const ARCHIVE = `archive@${DOMAIN}`;
const SMTP_USER = COLLECTOR;
const SEND = { smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpUser: SMTP_USER, smtpPasswordFile: '/not/read/in/tests', fromName: '合成 医学薬学祭実行委員会', mailboxes: ['contact', 'sponsorship'] };

describe('the "send" settings', () => {
  const config = (send: unknown, password: string | null = 'abcdabcdabcdabcd') => testMailboxConfig('/tmp/unused', { send, draftBccAddress: `archive@${DOMAIN}` }, randomBytes(32), password);

  it('reads the SMTP account, the From mailboxes and the limits, with defaults', () => {
    expect(config(SEND).send).toEqual({
      smtp: { host: 'smtp.example.invalid', port: 465, security: 'tls', user: SMTP_USER, password: 'abcdabcdabcdabcd' },
      fromName: '合成 医学薬学祭実行委員会',
      mailboxIds: ['contact', 'sponsorship'],
      maxAttachmentBytes: 15 * 1024 * 1024,
      maxRecipients: 30,
    });
    expect(config({ ...SEND, smtpPort: 587 }).send?.smtp.security).toBe('starttls');
    expect(testMailboxConfig('/tmp/unused').send).toBeNull();
  });

  it('refuses unknown keys, unknown mailboxes, other ports, limits beyond the proxy and a missing password', () => {
    expect(() => config({ ...SEND, password: 'x' })).toThrow(/不明な項目/);
    expect(() => config({ ...SEND, mailboxes: ['nowhere'] })).toThrow(/send.mailboxes/);
    expect(() => config({ ...SEND, mailboxes: [] })).toThrow(/send.mailboxes/);
    expect(() => config({ ...SEND, smtpPort: 25 })).toThrow(/smtpPort/);
    expect(() => config({ ...SEND, maxAttachmentMB: 16 })).toThrow(/maxAttachmentMB/);
    expect(() => config({ ...SEND, maxRecipients: 100 })).toThrow(/maxRecipients/);
    // Sending needs the archive every message goes to as BCC.
    expect(() => testMailboxConfig('/tmp/unused', { send: SEND }, randomBytes(32), 'abcdabcdabcdabcd')).toThrow(/draftBccAddress/);
    expect(() => config({ ...SEND, fromName: '名前\n改行' })).toThrow(/fromName/);
    expect(() => config({ ...SEND, smtpUser: 'Not An Address' })).toThrow(/smtpUser/);
    expect(() => config(SEND, null)).toThrow(/smtpPasswordFile/);
  });

  it('reads the password file without its spaces and refuses a file others can read', async () => {
    const { parseMailboxConfig } = await import('../../src/server/mailbox/config.js');
    const d = mkdtempSync(path.join(tmpdir(), 'iyakusai-mail-send-config-'));
    try {
      const keyFile = path.join(d, 'mail-ingest.key');
      const pwFile = path.join(d, 'mail-smtp.password');
      writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      writeFileSync(pwFile, 'abcd efgh ijkl mnop\n', { mode: 0o600 });
      const file = path.join(d, 'mailbox.json');
      const base = { version: 1, mailboxes: [{ id: 'taro', name: '共用', address: COLLECTOR, catchAll: true }], ingestKeyFile: keyFile, draftBccAddress: `archive@${DOMAIN}` };
      writeFileSync(file, JSON.stringify({ ...base, send: { ...SEND, mailboxes: ['taro'], smtpPasswordFile: pwFile } }));
      const c = parseMailboxConfig({ SMM_MAIL_DIR: path.join(d, 'data'), SMM_MAIL_CONFIG: file }, true);
      expect(c?.send?.smtp.password).toBe('abcdefghijklmnop');
      if (process.platform !== 'win32') {
        writeFileSync(pwFile, 'abcdefghijklmnop', { mode: 0o644 });
        expect(() => parseMailboxConfig({ SMM_MAIL_DIR: path.join(d, 'data'), SMM_MAIL_CONFIG: file }, true)).toThrow(/600/);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('the message builder', () => {
  const base = {
    from: { name: '合成 医学薬学祭実行委員会', address: SPONSOR },
    to: [{ name: '取引先 株式会社 ご担当者様', address: OUTSIDE }],
    cc: [{ name: null, address: ADM }],
    subject: 'Re: 協賛のお願い（ご確認ください）とても長い件名がここに続きます。全角文字で四十五バイトを超えるように書いておきます。',
    text: '株式会社 ご担当者様\n\nいつもお世話になっております。\n.行頭のドット\n\n— 署名',
    messageId: 'abc.123@committee.example',
    inReplyTo: 'q1@partner.example',
    references: ['root@partner.example', 'q1@partner.example'],
    date: new Date('2026-10-26T05:00:00.000Z'),
    attachments: [{ filename: '協賛申込書（2026年度）.pdf', contentType: 'application/pdf', content: randomBytes(5000) }],
  };

  it('writes 7-bit mail with short lines that reads back the same', async () => {
    const raw = buildRawMail(base);
    expect([...raw].every((b) => b < 128)).toBe(true);
    expect(raw.toString('ascii').split('\r\n').every((l) => l.length <= 78)).toBe(true);
    expect(raw.toString('ascii')).not.toMatch(/\r?\nBcc:/i);
    expect(raw.toString('ascii')).toContain('Date: Mon, 26 Oct 2026 14:00:00 +0900');
    const p = await parseRawMail(raw);
    expect(p.messageId).toBe('abc.123@committee.example');
    expect(p.subject).toBe(base.subject);
    expect(p.from).toEqual({ name: '合成 医学薬学祭実行委員会', address: SPONSOR });
    expect(p.to).toEqual([{ name: '取引先 株式会社 ご担当者様', address: OUTSIDE }]);
    expect(p.cc).toEqual([{ name: null, address: ADM }]);
    expect(p.inReplyTo).toBe('q1@partner.example');
    expect(p.references).toEqual(['root@partner.example', 'q1@partner.example']);
    expect(p.text.replace(/\r\n/g, '\n').trimEnd()).toBe(base.text);
    expect(p.attachments.map((a) => [a.filename, a.contentType, a.content.equals(base.attachments[0]!.content)])).toEqual([['協賛申込書（2026年度）.pdf', 'application/pdf', true]]);
  });

  it('writes a plain text message without attachments as one part', async () => {
    const raw = buildRawMail({ ...base, attachments: [], inReplyTo: null, references: [], subject: 'Plain ASCII subject' });
    expect(raw.toString('ascii')).toContain('Subject: Plain ASCII subject\r\n');
    expect(raw.toString('ascii')).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw.toString('ascii')).not.toContain('In-Reply-To');
    expect((await parseRawMail(raw)).attachments).toEqual([]);
  });

  it('refuses line breaks that would add headers, and bad addresses', () => {
    expect(() => buildRawMail({ ...base, subject: '件名\r\nBcc: x@partner.example' })).toThrow(ComposeError);
    expect(() => buildRawMail({ ...base, to: [{ name: '名前\nBcc: x', address: OUTSIDE }] })).toThrow(ComposeError);
    expect(() => buildRawMail({ ...base, to: [{ name: null, address: 'not an address' }] })).toThrow(ComposeError);
    expect(() => buildRawMail({ ...base, attachments: [{ filename: 'a\r\nb.pdf', contentType: 'application/pdf', content: Buffer.from('x') }] })).toThrow(ComposeError);
    expect(() => buildRawMail({ ...base, to: [], cc: [] })).toThrow(ComposeError);
  });

  it('writes Reply-To only when answers should go elsewhere, and refuses a line break in it', () => {
    expect(buildRawMail(base).toString('ascii')).not.toMatch(/^Reply-To:/im);
    const raw = buildRawMail({ ...base, replyTo: { name: '合成 窓口（問い合わせ）', address: `contact@${DOMAIN}` } }).toString('ascii');
    const headers = raw.slice(0, raw.indexOf('\r\n\r\n'));
    // After From, before To; the name in encoded words and the address on its own folded line.
    expect(headers).toMatch(/\r\nFrom: [\s\S]*\r\nReply-To: =\?UTF-8\?B\?[\s\S]*\r\n <contact@committee\.example>\r\nTo: /);
    expect(raw.split('\r\n').every((l) => l.length <= 78)).toBe(true);
    expect(() => buildRawMail({ ...base, replyTo: { name: '名前\r\nBcc: x', address: OUTSIDE } })).toThrow(ComposeError);
    expect(() => buildRawMail({ ...base, replyTo: { name: null, address: 'not an address' } })).toThrow(ComposeError);
  });

  it('reads typed recipients', () => {
    expect(splitRecipients('a@partner.example, "山田, 太郎" <b@partner.example>；c@partner.example\n')).toEqual(['a@partner.example', '"山田, 太郎" <b@partner.example>', 'c@partner.example']);
    expect(parseRecipient('"山田, 太郎" <b@partner.example>')).toEqual({ name: '山田, 太郎', address: 'b@partner.example' });
    expect(parseRecipient('<c@partner.example>')).toEqual({ name: null, address: 'c@partner.example' });
    expect(parseRecipient('山田 様 c@partner.example')).toBeNull();
    expect(parseRecipient('x@y')).toBeNull();
  });

  it('doubles a leading dot for SMTP', () => {
    expect(dotStuff(Buffer.from('a\r\n.b\r\n..c')).toString()).toBe('a\r\n..b\r\n...c\r\n.\r\n');
  });
});

// ---- SMTP against a local fake server (plain TCP; the TLS step is replaced by the tests)

interface FakeOptions {
  /** Plain-text replies sent together with the STARTTLS go-ahead (an injection by someone on the path). */
  inject?: boolean;
  rejectRecipient?: string;
  dropAfterData?: boolean;
  noAuthPlain?: boolean;
  starttls?: boolean;
  badPassword?: boolean;
}

function fakeSmtp(o: FakeOptions = {}) {
  const seen: { commands: string[]; data: string | null; auth: string | null } = { commands: [], data: null, auth: null };
  const server: Server = createServer((socket: Socket) => {
    let buffer = '';
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          seen.data = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          inData = false;
          if (o.dropAfterData) {
            socket.destroy();
            return;
          }
          socket.write('250 2.0.0 OK queued\r\n');
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const verb = line.split(' ')[0]!.toUpperCase();
        seen.commands.push(verb === 'AUTH' ? 'AUTH PLAIN ***' : line);
        if (verb === 'EHLO') socket.write(`250-fake\r\n${o.starttls ? '250-STARTTLS\r\n' : ''}${o.noAuthPlain ? '250 AUTH LOGIN\r\n' : '250 AUTH LOGIN PLAIN\r\n'}`);
        else if (verb === 'STARTTLS') socket.write(o.inject ? '220 go ahead\r\n250-injected\r\n250 AUTH PLAIN\r\n235 ok\r\n' : '220 go ahead\r\n');
        else if (verb === 'AUTH') {
          seen.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          socket.write(o.badPassword ? '535 5.7.8 bad credentials\r\n' : '235 2.7.0 Accepted\r\n');
        } else if (verb === 'MAIL') socket.write('250 OK\r\n');
        else if (verb === 'RCPT') socket.write(o.rejectRecipient && line.includes(o.rejectRecipient) ? '550 5.1.1 no such user\r\n' : '250 OK\r\n');
        else if (verb === 'DATA') {
          socket.write('354 go ahead\r\n');
          inData = true;
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else socket.write('502 unknown\r\n');
      }
    });
  });
  return {
    seen,
    async start(): Promise<{ settings: SmtpSettings; transport: MailTransport }> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const settings: SmtpSettings = { host: 'smtp.example.invalid', port, security: o.starttls ? 'starttls' : 'tls', user: SMTP_USER, password: 'abcdabcdabcdabcd' };
      const plain = () => new Promise<Socket>((resolve, reject) => {
        const s = connect({ host: '127.0.0.1', port }, () => resolve(s));
        s.once('error', reject);
      });
      return { settings, transport: smtpTransport(settings, plain, async (socket) => socket) };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('the SMTP client', () => {
  const raw = Buffer.from('Subject: x\r\n\r\nline\r\n.dot line\r\n');
  const envelope: SmtpEnvelope = { from: SMTP_USER, to: [OUTSIDE, ARCHIVE] };
  let fake: ReturnType<typeof fakeSmtp>;
  afterEach(() => fake.close());

  it('logs in with the app password and hands over the message once', async () => {
    fake = fakeSmtp();
    const { transport } = await fake.start();
    await transport.send(envelope, raw);
    expect(fake.seen.auth).toBe(`\u0000${SMTP_USER}\u0000abcdabcdabcdabcd`);
    // QUIT follows without waiting for the answer.
    expect(fake.seen.commands.slice(0, 6)).toEqual(['EHLO app.iyakusai.com', 'AUTH PLAIN ***', `MAIL FROM:<${SMTP_USER}>`, `RCPT TO:<${OUTSIDE}>`, `RCPT TO:<${ARCHIVE}>`, 'DATA']);
    expect(fake.seen.data).toBe('Subject: x\r\n\r\nline\r\n..dot line\r\n');
  });

  it('upgrades with STARTTLS on 587 before logging in', async () => {
    fake = fakeSmtp({ starttls: true });
    const { transport } = await fake.start();
    await transport.send(envelope, raw);
    expect(fake.seen.commands.slice(0, 4)).toEqual(['EHLO app.iyakusai.com', 'STARTTLS', 'EHLO app.iyakusai.com', 'AUTH PLAIN ***']);
  });

  it('refuses replies injected in plain text with the STARTTLS go-ahead, before logging in', async () => {
    fake = fakeSmtp({ starttls: true, inject: true });
    const { transport } = await fake.start();
    await expect(transport.send(envelope, raw)).rejects.toMatchObject({ step: 'starttls', delivered: 'no' });
    expect(fake.seen.auth).toBeNull();
    expect(fake.seen.data).toBeNull();
  });

  it('says a refused recipient or password was not sent, and a cut-off after DATA may have been', async () => {
    fake = fakeSmtp({ rejectRecipient: ARCHIVE });
    let t = await fake.start();
    await expect(t.transport.send(envelope, raw)).rejects.toMatchObject({ step: 'recipient', code: 550, delivered: 'no' });
    expect(fake.seen.data).toBeNull();
    await fake.close();

    fake = fakeSmtp({ badPassword: true });
    t = await fake.start();
    const err = await t.transport.send(envelope, raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err).toMatchObject({ step: 'auth', code: 535, delivered: 'no' });
    expect(String((err as Error).message)).not.toContain('abcd');
    await fake.close();

    fake = fakeSmtp({ dropAfterData: true });
    t = await fake.start();
    await expect(t.transport.send(envelope, raw)).rejects.toMatchObject({ step: 'data', delivered: 'unknown' });
    await fake.close();

    fake = fakeSmtp({ noAuthPlain: true });
    t = await fake.start();
    await expect(t.transport.send(envelope, raw)).rejects.toMatchObject({ step: 'auth', delivered: 'no' });
  });
});

// ---- HTTP: the routes with a recording transport

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let key: Buffer;
const ORIGIN = `http://${TEST_HOST}`;
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

async function build(changes: Record<string, unknown> = {}) {
  key = randomBytes(32);
  const config = testMailboxConfig(path.join(dir, 'mail'), { draftBccAddress: ARCHIVE, send: SEND, ...changes }, key, 'abcdabcdabcdabcd');
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

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mail-send-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  sent.length = 0;
  failNext = null;
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

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  const { initialLoginId } = await register(ctx, uid, studentId, roles);
  const login = await call('POST', '/api/auth/login', { body: { loginId: studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return { cookie: cookieOf(login.headers['set-cookie']), id: initialLoginId };
}

/** multipart/form-data as the browser's FormData sends it. */
function form(message: unknown, files: { name: string; type: string; content: Buffer }[] = []): { payload: Buffer; contentType: string } {
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

const put = (raw: Buffer, o: Parameters<typeof ingest>[4] = {}) => ingest(app, key, TEST_HOST, raw, { now: ctx.clock.now, ...o });

describe('sending from the mailbox', () => {
  beforeEach(() => build());

  it('needs a send grant on the From mailbox; administrators grant it only for sendable mailboxes', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json).toMatchObject({ enabled: true, from: [], bcc: ARCHIVE, senderName: '合成 太郎' });
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message()) })).status).toBe(403);
    expect(sent).toHaveLength(0);

    // adm@ is not in send.mailboxes: no grant can be given for it.
    expect((await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'adm', send: true } })).status).toBe(422);
    expect((await call('PUT', '/api/mail/admin/access', { cookie: member.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } })).status).toBe(403);
    expect((await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true, edit: true } })).status).toBe(400);
    const granted = await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } });
    expect(granted.json).toMatchObject({ sendGrants: [{ userId: member.id, mailboxId: 'sponsorship' }], sendable: ['contact', 'sponsorship'], grants: [] });
    expect((await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json.from).toEqual([{ mailboxId: 'sponsorship', name: '協賛', address: SPONSOR }]);
    // A grant for one mailbox does not open another.
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message({ mailboxId: 'contact' })) })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('sends new mail with the archive BCC, stores it as 完了, and never sends one message twice', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'sponsorship', send: true } });
    const m = message({ cc: [ADM], bcc: [`<bcc@partner.example>`, OUTSIDE] });
    const res = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(m, [{ name: '申込書.pdf', type: 'application/pdf', content: Buffer.from('%PDF-synthetic') }]) });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'sent', threadDone: false });
    expect(sent).toHaveLength(1);
    // The SMTP account is the envelope sender; the archive and BCC go as recipients only (the duplicate To is sent once).
    expect(sent[0]!.envelope).toEqual({ from: SMTP_USER, to: [OUTSIDE, ADM, 'bcc@partner.example', ARCHIVE] });
    const text = sent[0]!.raw.toString('ascii');
    expect(text).not.toMatch(/bcc@partner|archive@/i);
    const p = await parseRawMail(sent[0]!.raw);
    expect(p.from).toEqual({ name: '合成 医学薬学祭実行委員会', address: SPONSOR });
    expect(p.attachments.map((a) => a.filename)).toEqual(['申込書.pdf']);

    const thread = (await call('GET', `/api/threads/${res.json.threadId}`, { cookie: chair.cookie })).json;
    expect(thread.receipts).toHaveLength(1);
    expect(thread.receipts[0]).toMatchObject({ receiptId: res.json.receiptId, subject: '協賛のお願い', triage: { status: 'done' }, mailboxes: [{ id: 'sponsorship' }, { id: 'adm' }] });
    expect((await call('GET', '/api/mail/status', { cookie: chair.cookie })).json.unhandledTotal).toBe(0);

    // The same message again (a retry after a lost answer): the first result, nothing sent.
    const again = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(m) });
    expect(again.json).toMatchObject({ status: 'sent', receiptId: res.json.receiptId });
    expect(sent).toHaveLength(1);

    // The account's own copy, collected later, links to the stored message instead of a second one.
    expect((await put(sent[0]!.raw, { id: 'gmail-sent-1' })).json.status).toBe('linked');
    expect((await call('GET', `/api/threads/${res.json.threadId}`, { cookie: chair.cookie })).json.receipts).toHaveLength(1);
    expect(mail.audit(5).map((a) => a.action)).toContain('send_sent');
    expect(JSON.stringify(mail.audit(5))).not.toContain(OUTSIDE);
  });

  it('replies in the thread with In-Reply-To and References, and can set the thread to 完了', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'sponsorship', send: true } });
    await put(rawMail({ messageId: 'root@partner.example', to: SPONSOR, subject: '協賛の件' }), { at: Date.parse('2026-10-13T01:00:00.000Z') });
    await put(rawMail({ messageId: 'q2@partner.example', to: SPONSOR, subject: 'Re: 協賛の件', inReplyTo: 'root@partner.example', references: ['root@partner.example'] }), { at: Date.parse('2026-10-13T02:00:00.000Z') });
    const threadId = (await call('GET', '/api/inbox', { cookie: chair.cookie })).json.items[0].threadId;
    const receipts = (await call('GET', `/api/threads/${threadId}`, { cookie: chair.cookie })).json.receipts;
    const latest = receipts[receipts.length - 1].receiptId;

    const res = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ subject: 'Re: 協賛の件', replyToReceiptId: latest, markThreadDone: true })) });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ threadId, threadDone: true });
    const p = await parseRawMail(sent[0]!.raw);
    expect(p.inReplyTo).toBe('q2@partner.example');
    expect(p.references).toEqual(['root@partner.example', 'q2@partner.example']);
    const thread = (await call('GET', `/api/threads/${threadId}`, { cookie: chair.cookie })).json;
    expect(thread.receipts.map((r: { triage: { status: string } }) => r.triage.status)).toEqual(['done', 'done', 'done']);
    expect((await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ replyToReceiptId: 'rc_0000000000000000' })) })).status).toBe(404);
  });

  it('leaves out stored Message-IDs that cannot be written back, so such a thread can still be answered', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'sponsorship', send: true } });
    const long = `${'a'.repeat(280)}@partner.example`;
    await put(rawMail({ messageId: long, to: SPONSOR, subject: '長い ID' }), { at: Date.parse('2026-10-13T01:00:00.000Z') });
    await put(rawMail({ messageId: 'q3@partner.example', to: SPONSOR, subject: 'Re: 長い ID', inReplyTo: long, references: [long] }), { at: Date.parse('2026-10-13T02:00:00.000Z') });
    const threadId = (await call('GET', '/api/inbox', { cookie: chair.cookie })).json.items[0].threadId;
    const receipts = (await call('GET', `/api/threads/${threadId}`, { cookie: chair.cookie })).json.receipts;
    const res = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ replyToReceiptId: receipts[receipts.length - 1].receiptId })) });
    expect(res.status).toBe(200);
    const p = await parseRawMail(sent[0]!.raw);
    expect(p.inReplyTo).toBe('q3@partner.example');
    expect(p.references).toEqual(['q3@partner.example']);
  });

  it('answers the same message again with its result before any other check (here: the grant was taken away)', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'contact', send: true } });
    const m = message({ mailboxId: 'contact' });
    const first = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(m) });
    expect(first.status).toBe(200);
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'contact', send: false } });
    const again = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(m) });
    expect(again.status).toBe(200);
    expect(again.json.receiptId).toBe(first.json.receiptId);
    // A new message is refused without the grant.
    expect((await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ mailboxId: 'contact' })) })).status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  it('tells a refused send (send again) from one that may have gone out (do not)', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'contact', send: true } });
    const m = message({ mailboxId: 'contact' });
    failNext = new SmtpError('recipient', 550, 'no', 'メールサーバーが受け付けませんでした（550）。');
    const refused = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(m) });
    expect(refused.status).toBe(502);
    expect(refused.json.error).toBe('send_failed');
    // The same message can be sent again after a refusal.
    expect((await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(m) })).status).toBe(200);
    expect(sent).toHaveLength(1);

    const n = message({ mailboxId: 'contact' });
    failNext = new SmtpError('data', null, 'unknown', 'メールサーバーとの通信が途中で切れました。');
    const unknown = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(n) });
    expect(unknown.status).toBe(502);
    expect(unknown.json.error).toBe('send_unknown');
    const retry = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(n) });
    expect(retry.status).toBe(409);
    expect(retry.json.error).toBe('send_unknown');
    expect(sent).toHaveLength(1);
  });

  it('checks recipients, subject, body and attachment limits before sending', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'contact', send: true } });
    const bad = async (changes: Record<string, unknown>, files: { name: string; type: string; content: Buffer }[] = []) => {
      const r = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ mailboxId: 'contact', ...changes }), files) });
      return [r.status, r.json?.details?.field ?? r.json?.error];
    };
    expect(await bad({ to: [] })).toEqual([422, 'to']);
    expect(await bad({ to: ['山田 様'] })).toEqual([422, 'to']);
    expect(await bad({ cc: ['x@y'] })).toEqual([422, 'cc']);
    expect(await bad({ to: Array.from({ length: 31 }, (_, i) => `p${i}@partner.example`) })).toEqual([422, 'to']);
    expect(await bad({ subject: '  ' })).toEqual([422, 'subject']);
    expect(await bad({ subject: '件名\nBcc: x@partner.example' })).toEqual([422, 'subject']);
    expect(await bad({ body: '' })).toEqual([422, 'body']);
    expect(await bad({}, [{ name: 'big.bin', type: 'application/octet-stream', content: Buffer.alloc(15 * 1024 * 1024 + 1000) }])).toEqual([422, 'attachments']);
    expect(await bad({}, Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', content: Buffer.from('x') })))).toEqual([422, 'attachments']);
    expect(sent).toHaveLength(0);
  });

  it('writes the reply-to address given, none for From itself, and refuses two or one it cannot read', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'sponsorship', send: true } });
    const ok = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ replyTo: `問い合わせ窓口 <contact@${DOMAIN}>` })) });
    expect(ok.status).toBe(200);
    const headers = (raw: Buffer) => raw.toString('ascii').slice(0, raw.toString('ascii').indexOf('\r\n\r\n'));
    expect(headers(sent[0]!.raw)).toMatch(/\r\nReply-To: [\s\S]*<contact@committee\.example>\r\nTo: /);
    // The envelope and the From stay as they were.
    expect(sent[0]!.envelope).toEqual({ from: SMTP_USER, to: [OUTSIDE, ARCHIVE] });
    expect((await parseRawMail(sent[0]!.raw)).from).toEqual({ name: '合成 医学薬学祭実行委員会', address: SPONSOR });
    // From itself, an empty field and a request without the field (a screen opened earlier): no Reply-To.
    for (const replyTo of [SPONSOR.toUpperCase(), '  ', undefined]) {
      const r = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message(replyTo === undefined ? {} : { replyTo })) });
      expect(r.status).toBe(200);
      expect(headers(sent.at(-1)!.raw)).not.toMatch(/Reply-To:/i);
    }
    const bad = async (replyTo: string) => {
      const r = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ replyTo })) });
      return [r.status, r.json?.details?.field];
    };
    expect(await bad(`contact@${DOMAIN}, ${ADM}`)).toEqual([422, 'replyTo']);
    expect(await bad('x@y')).toEqual([422, 'replyTo']);
    expect(await bad(`窓口\r\nBcc: ${OUTSIDE} <contact@${DOMAIN}>`)).toEqual([422, 'replyTo']);
    expect(sent).toHaveLength(4);
  });

  it('follows the idle limit of the mail screens', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: chair.id, mailboxId: 'contact', send: true } });
    ctx.clock.now += 13 * 3_600_000;
    const locked = await call('POST', '/api/mail/send', { cookie: chair.cookie, raw: form(message({ mailboxId: 'contact' })) });
    expect(locked.status).toBe(401);
    expect(locked.json.error).toBe('reauth_required');
    expect(sent).toHaveLength(0);
  });
});

describe('grants to a department', () => {
  beforeEach(() => build());

  it('gives everyone in the department, by their Discord roles, the send and edit grants; taking it away removes them', async () => {
    const chair = await signIn(CHAIR, '21000001', [ROLE_GENERAL_AFFAIRS]);
    const planner = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    const outsider = await signIn(OTHER, '21000003');
    const grant = (body: Record<string, unknown>) => call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body });

    const matrix = (await call('GET', '/api/mail/admin/access', { cookie: chair.cookie })).json;
    expect(matrix.departments).toEqual(['企画部', '総務部']);
    expect(matrix.departmentGrants).toEqual([]);

    const res = await grant({ department: '企画部', mailboxId: 'sponsorship', send: true });
    expect(res.status).toBe(200);
    expect(res.json.departmentGrants).toEqual([{ department: '企画部', mailboxId: 'sponsorship', kind: 'send' }]);
    expect((await grant({ department: '企画部', mailboxId: 'contact', edit: true })).status).toBe(200);
    // Personal grants are untouched: the department is a grant of its own.
    expect(res.json.sendGrants).toEqual([]);

    expect((await call('GET', '/api/mail/send/options', { cookie: planner.cookie })).json.from.map((f: { mailboxId: string }) => f.mailboxId)).toEqual(['sponsorship']);
    expect((await call('GET', '/api/mail/send/options', { cookie: outsider.cookie })).json.from).toEqual([]);
    expect((await call('POST', '/api/mail/send', { cookie: planner.cookie, raw: form(message()) })).status).toBe(200);
    expect((await call('POST', '/api/mail/send', { cookie: outsider.cookie, raw: form(message()) })).status).toBe(403);

    // The edit grant: notes in contact@, and the mailbox shows as editable.
    await put(rawMail({ messageId: 'd1@partner.example', to: `contact@${DOMAIN}` }));
    const thread = (await call('GET', '/api/inbox?mailboxId=contact', { cookie: planner.cookie })).json.items[0].threadId;
    const receiptId = (await call('GET', `/api/threads/${thread}`, { cookie: planner.cookie })).json.receipts[0].receiptId;
    expect((await call('POST', `/api/receipts/${receiptId}/notes`, { cookie: planner.cookie, body: { body: '部局の権限で書いたメモ' } })).status).toBe(201);
    expect((await call('POST', `/api/receipts/${receiptId}/notes`, { cookie: outsider.cookie, body: { body: '権限なし' } })).status).toBe(403);
    expect((await call('GET', '/api/mailboxes', { cookie: planner.cookie })).json.find((m: { id: string }) => m.id === 'contact').access).toBe('edit');

    expect((await grant({ department: '企画部', mailboxId: 'sponsorship', send: false })).json.departmentGrants).toEqual([{ department: '企画部', mailboxId: 'contact', kind: 'edit' }]);
    expect((await call('POST', '/api/mail/send', { cookie: planner.cookie, raw: form(message()) })).status).toBe(403);
    expect(mail.audit(10).map((a) => a.action)).toEqual(expect.arrayContaining(['grant_department_send', 'grant_department_edit', 'revoke_department_send']));
  });

  it('refuses a department nobody is in, temporary staff, a mailbox it cannot send from, and non-administrators', async () => {
    const chair = await signIn(CHAIR, '21000001', [ROLE_GENERAL_AFFAIRS]);
    const planner = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    const grant = (cookie: string, body: Record<string, unknown>) => call('PUT', '/api/mail/admin/access', { cookie, body });
    expect((await grant(chair.cookie, { department: '存在しない部', mailboxId: 'contact', edit: true })).status).toBe(422);
    expect((await grant(chair.cookie, { department: '臨時スタッフ', mailboxId: 'contact', edit: true })).status).toBe(422);
    expect((await grant(chair.cookie, { department: '企画部', mailboxId: 'adm', send: true })).status).toBe(422);
    expect((await grant(chair.cookie, { department: '企画部', userId: planner.id, mailboxId: 'contact', edit: true })).status).toBe(400);
    expect((await grant(chair.cookie, { department: '企画部・総務部', mailboxId: 'contact', edit: true })).status).toBe(400);
    expect((await grant(planner.cookie, { department: '企画部', mailboxId: 'contact', edit: true })).status).toBe(403);
    // Removing is allowed even for a department nobody is in any more.
    expect((await grant(chair.cookie, { department: '存在しない部', mailboxId: 'contact', edit: false })).status).toBe(200);
  });
});

describe('without "send" in the configuration', () => {
  beforeEach(() => build({ send: undefined }));

  it('has no send route and says sending is off', async () => {
    const member = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/mail/send/options', { cookie: member.cookie })).json).toMatchObject({ enabled: false, from: [] });
    // No route: the request is refused before any mail code runs.
    expect((await call('POST', '/api/mail/send', { cookie: member.cookie, raw: form(message()) })).status).toBeGreaterThanOrEqual(404);
    expect(sent).toHaveLength(0);
    expect((await call('GET', '/api/mail/admin/access', { cookie: (await signIn(CHAIR, '21000001')).cookie })).json.sendable).toBeNull();
  });
});
