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
import { SIGN_IN_MAIL_SUBJECT, SIGN_IN_MAIL_TEXT } from '../../src/server/mailbox/restricted.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, setup } from '../discord-auth/helpers.js';
import { ADM, COLLECTOR, CONTACT, ingest, ingestHeaders, ingestPath, OUTSIDE, PERSONAL, rawMail, SPONSOR, testMailboxConfig } from './helpers.js';

// The committee mailbox inside the unified app (Discord login), over HTTP on loopback.

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let key: Buffer;
const ORIGIN = `http://${TEST_HOST}`;
const HOUR = 3_600_000;

async function build(changes: Record<string, unknown> = {}) {
  key = randomBytes(32);
  const config = testMailboxConfig(path.join(dir, 'mail'), changes, key);
  mail = new MailboxStore(config.dataDir, config.restrictedSenderDomains);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mailbox-http-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, options: { body?: unknown; cookie?: string } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
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

const put = (raw: Buffer, o: Parameters<typeof ingest>[4] = {}) => ingest(app, key, TEST_HOST, raw, { now: ctx.clock.now, ...o });

describe('the signed ingest route', () => {
  beforeEach(() => build());

  it('stores signed mail and answers duplicates and skipped past mail', async () => {
    const raw = rawMail({ messageId: 'q1@partner.example', to: SPONSOR, subject: '協賛のお問い合わせ' });
    expect((await put(raw, { id: 'g-1' })).json).toEqual({ status: 'stored', mailboxes: ['sponsorship', 'adm'] });
    expect((await put(raw, { id: 'g-1' })).json).toEqual({ status: 'duplicate', mailboxes: [] });
    expect((await put(raw, { id: 'n-1', source: 'backfill' })).json).toEqual({ status: 'linked', mailboxes: ['sponsorship', 'adm'] });
    expect((await put(rawMail({ to: PERSONAL }), { id: 'n-2', source: 'backfill' })).json).toEqual({ status: 'skipped', mailboxes: [] });
    expect((await put(rawMail({ to: OUTSIDE }), { id: 'g-2' })).json).toEqual({ status: 'stored', mailboxes: ['taro'] });
    expect(mail.ingestSummary().messages).toBe(2);
  });

  it('rejects unsigned, altered, replayed, stale and browser requests alike', async () => {
    const raw = rawMail({ to: CONTACT });
    const at = Date.parse('2026-10-13T01:00:00.000Z');
    const target = ingestPath('collector', 'g-9', at);
    const headers = ingestHeaders(key, target, raw, ctx.clock.now);
    const send = (h: Record<string, string>, body = raw, url = target) => app.inject({ method: 'POST', url, headers: { host: TEST_HOST, ...h }, payload: body });

    expect((await send({ 'content-type': 'message/rfc822' })).statusCode).toBe(401);
    expect((await send(headers, Buffer.concat([raw, Buffer.from('x')]))).statusCode).toBe(401);
    expect((await send(headers, raw, ingestPath('collector', 'g-8', at))).statusCode).toBe(401);
    expect((await send({ ...headers, origin: ORIGIN })).statusCode).toBe(401);
    expect((await send(ingestHeaders(randomBytes(32), target, raw, ctx.clock.now))).statusCode).toBe(401);
    expect((await send(ingestHeaders(key, target, raw, ctx.clock.now - 6 * 60_000))).statusCode).toBe(401);
    expect((await send(headers)).statusCode).toBe(200);
    // The same signed request again (a replay) is refused.
    expect((await send(headers)).statusCode).toBe(401);
    expect(mail.ingestSummary().messages).toBe(1);
  });

  it('accepts a large message over the normal request size limit', async () => {
    const big = rawMail({ to: CONTACT, attachments: [{ filename: 'scan.pdf', contentType: 'application/pdf', content: randomBytes(3 * 1024 * 1024) }] });
    expect((await put(big)).json.status).toBe('stored');
  });
});

describe('reading and handling mail', () => {
  beforeEach(() => build());

  it('lets every signed-in member read every mailbox, one message once with all its mailboxes', async () => {
    const member = await signIn(MEMBER, '21000002');
    await put(rawMail({ messageId: 'a@partner.example', to: SPONSOR, cc: `${ADM}, ${PERSONAL}`, subject: '協賛と大学窓口あて', attachments: [{ filename: '資料.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') }] }));
    await put(rawMail({ messageId: 'b@partner.example', to: CONTACT, subject: '一般の問い合わせ' }));

    // The message in two mailboxes counts once in the total.
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json.unhandledTotal).toBe(2);
    const boxes = await call('GET', '/api/mailboxes', { cookie: member.cookie });
    expect(boxes.status).toBe(200);
    expect(boxes.json.map((m: { id: string; access: string; unhandledCount: number }) => [m.id, m.access, m.unhandledCount])).toEqual([
      ['contact', 'read', 1],
      ['sponsorship', 'read', 1],
      ['adm', 'read', 1],
      ['taro', 'read', 0],
    ]);

    const all = await call('GET', '/api/inbox', { cookie: member.cookie });
    expect(all.json.total).toBe(2);
    const item = all.json.items.find((t: { subject: string }) => t.subject === '協賛と大学窓口あて');
    expect(item.mailboxes.map((m: { id: string }) => m.id)).toEqual(['sponsorship', 'adm']);
    expect((await call('GET', '/api/inbox?mailboxId=adm', { cookie: member.cookie })).json.total).toBe(1);
    expect((await call('GET', `/api/inbox?q=${encodeURIComponent('資料.pdf')}`, { cookie: member.cookie })).json.total).toBe(1);
    // Page sizes the list offers (up to 100), and one row per page
    expect((await call('GET', '/api/inbox?pageSize=100', { cookie: member.cookie })).json).toMatchObject({ total: 2, pageSize: 100 });
    expect((await call('GET', '/api/inbox?pageSize=1&page=2', { cookie: member.cookie })).json.items).toHaveLength(1);
    expect((await call('GET', '/api/inbox?pageSize=101', { cookie: member.cookie })).status).toBe(400);

    const thread = await call('GET', `/api/threads/${item.threadId}`, { cookie: member.cookie });
    expect(thread.status).toBe(200);
    const receipt = thread.json.receipts[0];
    // Addresses are shown as written, including the personal Cc (no hiding).
    expect(receipt.cc.map((a: { address: string }) => a.address)).toEqual([ADM, PERSONAL]);
    expect(receipt.access).toBe('read');
    const file = await call('GET', `/api/receipts/${receipt.receiptId}/attachments/${receipt.attachments[0].id}`, { cookie: member.cookie });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(String(file.headers['content-disposition'])).toContain(encodeURIComponent('資料.pdf'));
    expect(file.body.toString()).toBe('pdf');

    expect((await call('GET', '/api/inbox')).status).toBe(401);
    expect((await call('GET', '/api/threads/th_0000000000000000', { cookie: member.cookie })).status).toBe(404);
  });

  it('requires mailbox grants for notes only; administrators grant edit', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    const other = await signIn(OTHER, '21000003', [ROLE_GENERAL_AFFAIRS]);
    await put(rawMail({ messageId: 'c@partner.example', to: SPONSOR, cc: ADM }));
    const id = (await call('GET', '/api/inbox', { cookie: member.cookie })).json.items[0].threadId;
    const receiptId = (await call('GET', `/api/threads/${id}`, { cookie: member.cookie })).json.receipts[0].receiptId;

    const patch = (cookie: string, body: unknown) => call('PATCH', `/api/receipts/${receiptId}/triage`, { cookie, body });
    expect((await call('POST', `/api/receipts/${receiptId}/notes`, { cookie: member.cookie, body: { body: '権限なし' } })).status).toBe(403);
    expect((await call('PUT', '/api/mail/admin/access', { cookie: member.cookie, body: { userId: member.id, mailboxId: 'adm', edit: true } })).status).toBe(403);

    const matrix = await call('GET', '/api/mail/admin/access', { cookie: other.cookie });
    expect(matrix.status).toBe(200);
    expect(matrix.json.people.map((p: { displayName: string }) => p.displayName).sort()).toEqual(['合成 太郎', '合成 委員長', '合成 花子'].sort());
    const granted = await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'adm', edit: true } });
    expect(granted.json.grants).toEqual([{ userId: member.id, mailboxId: 'adm' }]);

    const ok = await patch(member.cookie, { expectedVersion: 1, status: 'in_progress', assigneeId: member.id, labels: ['見積'] });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ version: 2, status: 'in_progress', assignee: { id: member.id, displayName: '合成 太郎', hasMailboxAccess: true }, labels: ['見積'] });
    expect((await patch(member.cookie, { expectedVersion: 1, status: 'done' })).status).toBe(409);
    // A registered account outside this mailbox's grant list can also be assigned.
    expect((await call('GET', `/api/receipts/${receiptId}/assignees`, { cookie: chair.cookie })).json.map((p: { id: string }) => p.id)).toContain(other.id);
    expect((await call('POST', `/api/receipts/${receiptId}/notes`, { cookie: member.cookie, body: { body: '先方に電話済み' } })).status).toBe(201);
    expect((await call('POST', `/api/receipts/${receiptId}/notes`, { cookie: chair.cookie, body: { body: '権限なし' } })).status).toBe(403);

    // The same handling shows in both mailboxes; the chair (no edit grant) reads it.
    const view = (await call('GET', `/api/receipts/${receiptId}`, { cookie: chair.cookie })).json;
    expect(view).toMatchObject({ access: 'read', triage: { status: 'in_progress', labels: ['見積'] } });
    expect(view.notes.map((n: { body: string; authorName: string }) => [n.authorName, n.body])).toEqual([['合成 太郎', '先方に電話済み']]);
    expect(view.history.map((h: { action: string }) => h.action)).toEqual(['assignee', 'status', 'labels', 'note_added']);
    expect((await call('GET', '/api/inbox?status=in_progress&mailboxId=sponsorship', { cookie: chair.cookie })).json.total).toBe(1);
    expect((await call('GET', '/api/labels', { cookie: chair.cookie })).json).toEqual([{ label: '見積', count: 1 }]);
  });

  it('lets members without any grant assign, reassign, clear, label and set the status of mail with an audit trail', async () => {
    const member = await signIn(MEMBER, '21000002');
    const other = await signIn(OTHER, '21000003');
    await put(rawMail({ to: SPONSOR }));
    const threadId = (await call('GET', '/api/inbox', { cookie: member.cookie })).json.items[0].threadId;
    const receipt = (await call('GET', `/api/threads/${threadId}`, { cookie: member.cookie })).json.receipts[0];
    expect(receipt).toMatchObject({ access: 'read', canEditAssignmentAndLabels: true, canEditStatus: true });
    const url = `/api/receipts/${receipt.receiptId}`;
    expect((await call('GET', `${url}/assignees`, { cookie: member.cookie })).json.map((p: { id: string }) => p.id).sort()).toEqual([member.id, other.id].sort());

    expect((await call('PATCH', `${url}/triage`, { cookie: member.cookie, body: { expectedVersion: 1, assigneeId: other.id, labels: ['  見積  '] } })).json).toMatchObject({ version: 2, status: 'unhandled', assignee: { id: other.id, hasMailboxAccess: true }, labels: ['見積'] });
    expect((await call('PATCH', `${url}/triage`, { cookie: other.cookie, body: { expectedVersion: 2, assigneeId: member.id } })).status).toBe(200);
    expect((await call('PATCH', `${url}/triage`, { cookie: member.cookie, body: { expectedVersion: 2, labels: ['競合'] } })).status).toBe(409);
    expect((await call('PATCH', `${url}/triage`, { cookie: member.cookie, body: { expectedVersion: 3, assigneeId: null, labels: [], status: 'done' } })).status).toBe(200);
    const view = (await call('GET', url, { cookie: other.cookie })).json;
    expect(view.triage).toMatchObject({ version: 4, status: 'done', assignee: null, labels: [] });
    expect(view.history.map((h: { action: string; actorName: string }) => [h.action, h.actorName])).toEqual([
      ['assignee', '合成 太郎'], ['labels', '合成 太郎'], ['assignee', '合成 花子'], ['assignee', '合成 太郎'], ['status', '合成 太郎'], ['labels', '合成 太郎'],
    ]);
    expect(mail.grants()).toEqual([]);
  });

  it('sets the status of a whole thread for any member, with history and without overwriting newer edits', async () => {
    const member = await signIn(MEMBER, '21000002');
    const other = await signIn(OTHER, '21000003');
    await put(rawMail({ messageId: 't1@partner.example', to: SPONSOR, subject: '見積の件' }));
    await put(rawMail({ messageId: 't2@partner.example', to: SPONSOR, subject: 'Re: 見積の件', inReplyTo: 't1@partner.example', references: ['t1@partner.example'] }));
    const list = (await call('GET', '/api/inbox', { cookie: member.cookie })).json;
    expect(list.total).toBe(1);
    const item = list.items[0];
    expect(item).toMatchObject({ receiptCount: 2, statuses: ['unhandled'], canSetStatus: true });
    const url = `/api/threads/${item.threadId}/status`;
    const [first, second] = (await call('GET', `/api/threads/${item.threadId}`, { cookie: member.cookie })).json.receipts;

    // One message is already done: only the other one changes.
    expect((await call('PATCH', `/api/receipts/${second.receiptId}/triage`, { cookie: other.cookie, body: { expectedVersion: 1, status: 'done' } })).status).toBe(200);
    expect((await call('PATCH', url, { cookie: member.cookie, body: { status: 'done' } })).json).toEqual({ threadId: item.threadId, statuses: ['done'], changed: 1 });
    expect((await call('PATCH', url, { cookie: member.cookie, body: { status: 'done' } })).json.changed).toBe(0);
    expect((await call('PATCH', url, { cookie: other.cookie, body: { status: 'in_progress' } })).json).toMatchObject({ statuses: ['in_progress'], changed: 2 });
    // A message form opened before the change is refused on save instead of overwriting it.
    expect((await call('PATCH', `/api/receipts/${first.receiptId}/triage`, { cookie: member.cookie, body: { expectedVersion: 1, labels: ['古い画面'] } })).status).toBe(409);
    const view = (await call('GET', `/api/receipts/${first.receiptId}`, { cookie: member.cookie })).json;
    expect(view.triage).toMatchObject({ version: 3, status: 'in_progress', labels: [] });
    expect(view.history.map((h: { action: string; actorName: string; from: string; to: string }) => [h.action, h.actorName, h.from, h.to])).toEqual([
      ['status', '合成 太郎', '未対応', '完了'], ['status', '合成 花子', '完了', '対応中'],
    ]);
    expect((await call('GET', '/api/inbox?status=in_progress', { cookie: member.cookie })).json.total).toBe(1);
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json.unhandledTotal).toBe(0);

    expect((await call('PATCH', url, { body: { status: 'done' } })).status).toBe(401);
    expect((await call('PATCH', '/api/threads/th_0000000000000000/status', { cookie: member.cookie, body: { status: 'done' } })).status).toBe(404);
    expect((await call('PATCH', url, { cookie: member.cookie, body: { status: 'closed' } })).status).toBe(400);
    expect((await call('PATCH', url, { cookie: member.cookie, body: { status: 'done', labels: [] } })).status).toBe(400);
    expect((await call('GET', `/api/threads/${item.threadId}`, { cookie: member.cookie })).json.receipts.map((r: { triage: { status: string } }) => r.triage.status)).toEqual(['in_progress', 'in_progress']);
    expect(mail.grants()).toEqual([]);
  });

  it('rejects unknown accounts, invalid labels and notes without a grant, without partial changes', async () => {
    const member = await signIn(MEMBER, '21000002');
    await put(rawMail({ to: CONTACT }));
    const threadId = (await call('GET', '/api/inbox', { cookie: member.cookie })).json.items[0].threadId;
    const id = (await call('GET', `/api/threads/${threadId}`, { cookie: member.cookie })).json.receipts[0].receiptId;
    const url = `/api/receipts/${id}`;
    const patch = (body: unknown) => call('PATCH', `${url}/triage`, { cookie: member.cookie, body });
    // The status in a refused request is not saved either.
    expect((await patch({ expectedVersion: 1, assigneeId: 'iy-999999', labels: ['混在'], status: 'done' })).status).toBe(422);
    expect((await patch({ expectedVersion: 1, assigneeId: 'iy-999999', labels: ['混在'] })).status).toBe(422);
    expect((await patch({ expectedVersion: 1, labels: ['あ'.repeat(21)] })).status).toBe(422);
    expect((await call('POST', `${url}/notes`, { cookie: member.cookie, body: { body: '権限なし' } })).status).toBe(403);
    expect((await call('PATCH', `${url}/triage`, { body: { expectedVersion: 1, labels: ['未ログイン'] } })).status).toBe(401);
    expect((await call('GET', `${url}/assignees`)).status).toBe(401);
    const view = (await call('GET', url, { cookie: member.cookie })).json;
    expect(view.triage).toMatchObject({ version: 1, status: 'unhandled', assignee: null, labels: [] });
    expect(view.history).toEqual([]);
    expect(view.notes).toEqual([]);
  });

  it('excludes retired accounts, rejects their sessions and keeps existing assignments during label-only edits', async () => {
    const member = await signIn(MEMBER, '21000002');
    const other = await signIn(OTHER, '21000003');
    await put(rawMail({ to: CONTACT }));
    const threadId = (await call('GET', '/api/inbox', { cookie: member.cookie })).json.items[0].threadId;
    const id = (await call('GET', `/api/threads/${threadId}`, { cookie: member.cookie })).json.receipts[0].receiptId;
    const url = `/api/receipts/${id}`;
    expect((await call('PATCH', `${url}/triage`, { cookie: member.cookie, body: { expectedVersion: 1, assigneeId: other.id } })).status).toBe(200);
    ctx.store.transact((s) => {
      const account = s.accounts[OTHER]!;
      account.status = 'retired'; account.password = null; account.pending = null;
    });
    expect((await call('GET', `${url}/assignees`, { cookie: member.cookie })).json.map((p: { id: string }) => p.id)).toEqual([member.id]);
    expect((await call('PATCH', `${url}/triage`, { cookie: other.cookie, body: { expectedVersion: 2, labels: ['無効'] } })).status).toBe(401);
    expect((await call('PATCH', `${url}/triage`, { cookie: member.cookie, body: { expectedVersion: 2, labels: ['確認中'] } })).json).toMatchObject({ version: 3, assignee: { id: other.id, hasMailboxAccess: false }, labels: ['確認中'] });
    expect((await call('PATCH', `${url}/triage`, { cookie: member.cookie, body: { expectedVersion: 3, assigneeId: null } })).status).toBe(200);
    expect((await call('PATCH', `${url}/triage`, { cookie: member.cookie, body: { expectedVersion: 4, assigneeId: other.id } })).status).toBe(422);
  });
});

describe('the idle limit of the mail screens', () => {
  beforeEach(() => build({ idleHours: 12 }));

  it('asks for the password after 12 hours without mail use, and only for mail', async () => {
    const member = await signIn(MEMBER, '21000002');
    await put(rawMail({ to: CONTACT }));
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json).toEqual({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: 1 });

    // Using mail at 11 hours keeps it open for another 12.
    ctx.clock.now += 11 * HOUR;
    expect((await call('GET', '/api/inbox', { cookie: member.cookie })).status).toBe(200);
    ctx.clock.now += 11 * HOUR;
    expect((await call('GET', '/api/inbox', { cookie: member.cookie })).status).toBe(200);
    // Counts on the home screen are not mail use.
    ctx.clock.now += 11 * HOUR;
    expect((await call('GET', '/api/mailboxes', { cookie: member.cookie })).status).toBe(200);
    ctx.clock.now += 2 * HOUR;
    const locked = await call('GET', '/api/inbox', { cookie: member.cookie });
    expect(locked.status).toBe(401);
    expect(locked.json.error).toBe('reauth_required');
    expect((await call('PATCH', '/api/receipts/rc_0000000000000000/triage', { cookie: member.cookie, body: { expectedVersion: 1, labels: ['再認証待ち'] } })).json.error).toBe('reauth_required');
    expect((await call('GET', '/api/receipts/rc_0000000000000000/assignees', { cookie: member.cookie })).json.error).toBe('reauth_required');
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json).toMatchObject({ reauthRequired: true, unhandledTotal: null });
    // Other screens keep the 14-day sign-in.
    expect((await call('GET', '/api/session', { cookie: member.cookie })).json.user).not.toBeNull();

    expect((await call('POST', '/api/auth/reauth', { cookie: member.cookie, body: { password: 'wrong password 0000' } })).status).toBe(401);
    const again = await call('POST', '/api/auth/reauth', { cookie: member.cookie, body: { password: PASSWORD } });
    expect(again.status).toBe(200);
    const cookie = cookieOf(again.headers['set-cookie']);
    expect(cookie).not.toBe(member.cookie);
    expect((await call('GET', '/api/inbox', { cookie })).status).toBe(200);
    // The old session ended with the re-entry.
    expect((await call('GET', '/api/session', { cookie: member.cookie })).json.user).toBeNull();
  });
});

describe('the trial before opening the mailbox to everyone', () => {
  beforeEach(() => build({ previewDiscordUserIds: [CHAIR] }));

  it('opens only for the listed accounts and hides the mailbox from the others', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await put(rawMail({ to: CONTACT }));
    expect((await call('GET', '/api/mail/status', { cookie: member.cookie })).json).toMatchObject({ enabled: true, canOpen: false });
    expect((await call('GET', '/api/mailboxes', { cookie: member.cookie })).json).toEqual([]);
    expect((await call('GET', '/api/inbox', { cookie: member.cookie })).status).toBe(404);
    expect((await call('PATCH', '/api/receipts/rc_0000000000000000/triage', { cookie: member.cookie, body: { expectedVersion: 1, labels: ['公開対象外'] } })).status).toBe(404);
    expect((await call('GET', '/api/inbox', { cookie: chair.cookie })).json.total).toBe(1);
  });
});

describe('sign-in mail (password resets, codes, sign-in notices)', () => {
  beforeEach(() => build({ restrictedSenderDomains: ['bank.example'] }));

  it('shows its subject, text and attachments to access administrators only, and keeps it out of searches', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    const pdf = [{ filename: '控え.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') }];
    await put(rawMail({ messageId: 'code@partner.example', to: CONTACT, subject: '確認コードのお知らせ', text: '確認コード: 482913 を入力してください。', html: '<p>482913</p>', attachments: pdf }));
    // A code in the text alone, and any message from a listed sender (its subdomains too).
    await put(rawMail({ messageId: 'x@partner.example', to: CONTACT, subject: 'ご登録ありがとうございます', text: 'Your verification code is 771204.' }));
    await put(rawMail({ messageId: 'bank@mail.bank.example', from: `"銀行" <notice@mail.bank.example>`, to: CONTACT, subject: '振込入金がありました' }));
    // Not sign-in mail: a password for an attachment is ordinary business.
    await put(rawMail({ messageId: 'zip@partner.example', to: CONTACT, subject: '見積書の送付', text: '資料のパスワードは別のメールでお送りします。' }));

    const subjects = async (cookie: string, q = '') => (await call('GET', `/api/inbox${q}`, { cookie })).json.items.map((t: { subject: string }) => t.subject).sort();
    expect(await subjects(member.cookie)).toEqual([SIGN_IN_MAIL_SUBJECT, SIGN_IN_MAIL_SUBJECT, SIGN_IN_MAIL_SUBJECT, '見積書の送付'].sort());
    expect(await subjects(chair.cookie)).toEqual(['ご登録ありがとうございます', '振込入金がありました', '確認コードのお知らせ', '見積書の送付'].sort());
    const listed = (await call('GET', '/api/inbox', { cookie: member.cookie })).json.items;
    expect(JSON.stringify(listed)).not.toMatch(/482913|771204|確認コード|振込入金/);

    // A guessed code finds nothing for members.
    expect((await call('GET', '/api/inbox?q=482913', { cookie: member.cookie })).json.total).toBe(0);
    expect((await call('GET', '/api/inbox?q=482913', { cookie: chair.cookie })).json.total).toBe(1);

    const { threadId } = (await call('GET', '/api/inbox', { cookie: chair.cookie })).json.items.find((t: { subject: string }) => t.subject === '確認コードのお知らせ');
    const threadOf = (cookie: string) => call('GET', `/api/threads/${threadId}`, { cookie });
    const hidden = (await threadOf(member.cookie)).json;
    expect(hidden.subject).toBe(SIGN_IN_MAIL_SUBJECT);
    expect(hidden.receipts[0]).toMatchObject({ subject: SIGN_IN_MAIL_SUBJECT, text: SIGN_IN_MAIL_TEXT, hasHtml: false, sanitizedHtml: null, attachments: [] });
    expect(JSON.stringify(hidden)).not.toContain('482913');
    const shown = (await threadOf(chair.cookie)).json;
    expect(shown.receipts[0].text).toContain('482913');
    const receiptId = shown.receipts[0].receiptId;
    const file = `/api/receipts/${receiptId}/attachments/${shown.receipts[0].attachments[0].id}`;
    expect((await call('GET', file, { cookie: member.cookie })).status).toBe(404);
    expect((await call('GET', file, { cookie: chair.cookie })).status).toBe(200);
    expect((await call('GET', `/api/receipts/${receiptId}`, { cookie: member.cookie })).json.text).toBe(SIGN_IN_MAIL_TEXT);

    // Members still handle it (status, labels), so they can pass it on to an administrator.
    expect((await call('PATCH', `/api/receipts/${receiptId}/triage`, { cookie: member.cookie, body: { expectedVersion: 1, status: 'in_progress', labels: ['管理者へ'] } })).status).toBe(200);
  });
});

describe('collector mail with the domain alias', () => {
  beforeEach(() => build());

  it('files mail for the .alias domain and +tag addresses under the committee mailbox', async () => {
    const r = await put(rawMail({ to: `Contact@committee-alias.example`, cc: `adm+managers@committee.example`, deliveredTo: COLLECTOR }));
    expect(r.json).toEqual({ status: 'stored', mailboxes: ['contact', 'adm'] });
  });
});
