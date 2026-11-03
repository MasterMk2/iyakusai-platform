import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import type { MailTransport } from '../../src/server/mailbox/smtp.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { openDemoBooks } from '../../src/server/payments/demo.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState, T0, TEST_HOST, TEST_PORT } from '../helpers.js';
import { DOMAIN, testMailboxConfig } from '../mailbox/helpers.js';

// 入金確認 (会計) over HTTP: the permissions, invoices from the organizations, the statement import, confirming a
// payment and its mark on the organization, the CSV. Synthetic names, amounts and reserved .example addresses only.

const SEND = { smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpUser: `taro@${DOMAIN}`, smtpPasswordFile: '/not/read/in/tests', fromName: '合成 医学薬学祭実行委員会', mailboxes: ['contact', 'sponsorship'] };
const ROLE_STAFF = '1000000000000002099';
const ROLE_ACCOUNTING = '1000000000000002050';
const ACCOUNTANT = '1000000000000001040';
const STAFF = '1000000000000001050';
const ORIGIN = `http://${TEST_HOST}`;
// Every sign-in hashes the password (slow on purpose), and the tests sign in several people.
vi.setConfig({ testTimeout: 90_000 });

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
const recording: MailTransport = { async send() {} };

async function build() {
  const config = testMailboxConfig(path.join(dir, 'mail'), { draftBccAddress: `archive@${DOMAIN}`, send: SEND }, randomBytes(32), 'abcdabcdabcdabcd');
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
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-payments-http-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子', [ACCOUNTANT]: '合成 会計' } }));
  ctx = setup({ config: testConfig({ departmentRoleIds: { [ROLE_STAFF]: '臨時スタッフ', [ROLE_GENERAL_AFFAIRS]: '総務部', [ROLE_ACCOUNTING]: '会計課' } }) });
  await build();
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; json: any; body: string; headers: Record<string, unknown> }> {
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
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  const { initialLoginId } = await register(ctx, uid, studentId, roles);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ loginId: studentId, password: PASSWORD }),
  });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res.headers['set-cookie']), id: initialLoginId };
}

/** The chair (権限管理者) turns one accounting permission on for a member or a department. */
async function grant(chairCookie: string, target: { userId: string } | { department: string }, permission: 'accounting.view' | 'accounting.confirm') {
  const { revision } = (await call('GET', '/api/payments/admin/access', { cookie: chairCookie })).json as { revision: number };
  const res = await call('PUT', '/api/payments/admin/access', { cookie: chairCookie, body: { expectedRevision: revision, ...target, permission, on: true } });
  expect(res.status).toBe(200);
  return res.json;
}

const organization = (changes: Record<string, unknown> = {}) => ({
  kind: 'sponsor',
  fiscalYear: 2026,
  name: '合成商事株式会社',
  department: '渉外課',
  ownerId: null,
  contactId: null,
  status: '請求済み',
  amountYen: 300_000,
  content: '広告（大）',
  nextAction: '',
  nextDue: null,
  notes: '',
  ...changes,
});

async function orgId(cookie: string, changes: Record<string, unknown> = {}): Promise<string> {
  const res = await call('POST', '/api/organizations', { cookie, body: organization(changes) });
  expect(res.status).toBe(201);
  return res.json.org.id as string;
}

const invoiceBody = (org: string, changes: Record<string, unknown> = {}) => ({
  clientToken: randomBytes(12).toString('base64url'),
  invoice: { orgId: org, number: '', amountYen: 300_000, issuedOn: '2026-10-20', dueOn: '2026-11-15', payerKana: 'ゴウセイシヨウジ', memo: '', ...changes },
});

async function invoice(cookie: string, org: string, changes: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/payments/invoices', { cookie, body: invoiceBody(org, changes) });
  expect(res.status).toBe(201);
  return res.json.invoice as { id: string; number: string; version: number };
}

const row = (line: number, date: string, description: string, deposit: string, withdrawal: string, balance: string) => ({ line, date, description, deposit, withdrawal, balance });
const STATEMENT = [
  row(2, '2026/11/02', 'ﾌﾘｺﾐ ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ', '300,000', '', '1,300,000'),
  row(3, '2026/11/03', 'ﾃｽｳﾘﾖｳ', '', '440', '1,299,560'),
  row(4, 'あした', 'ｺﾞｳｾｲ', '1,000', '', ''),
  row(5, '2026/11/04', 'ｺﾞｳｾｲｻ-ｸﾙ', '2,500', '', '1,302,060'),
];

async function importStatement(cookie: string, rows = STATEMENT) {
  const dry = await call('POST', '/api/payments/statements/import', { cookie, body: { dryRun: true, rows } });
  expect(dry.status).toBe(200);
  const done = await call('POST', '/api/payments/statements/import', { cookie, body: { dryRun: false, label: '合成の明細', rows, planToken: dry.json.planToken } });
  expect(done.status).toBe(200);
  return { dry: dry.json, done: done.json };
}

describe('payments: who sees and does what', () => {
  it('gives a member without a grant no accounting, and the organization only 入金済み or not', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    const other = await signIn(OTHER, '21000003');
    expect((await call('GET', '/api/payments/me', { cookie: chair.cookie })).json).toEqual({ canView: false, canConfirm: false, canAdminister: true });
    await grant(chair.cookie, { userId: member.id }, 'accounting.confirm');
    const org = await orgId(member.cookie);
    await invoice(member.cookie, org);

    expect((await call('GET', '/api/payments/me', { cookie: other.cookie })).json).toEqual({ canView: false, canConfirm: false, canAdminister: false });
    for (const url of ['/api/payments/overview?fiscalYear=2026', '/api/payments/export.csv?fiscalYear=2026', '/api/payments/admin/access']) {
      expect((await call('GET', url, { cookie: other.cookie })).status, url).toBe(403);
    }
    const status = await call('GET', `/api/payments/organizations/${org}`, { cookie: other.cookie });
    expect(status.json).toEqual({ state: 'unpaid', detail: null, canView: false, canConfirm: false });
    expect(status.body).not.toMatch(/300000|2026-001|ゴウセイ/);
    // The member with the grant sees the invoice there.
    const own = await call('GET', `/api/payments/organizations/${org}`, { cookie: member.cookie });
    expect(own.json).toMatchObject({ state: 'unpaid', canView: true, canConfirm: true, detail: { invoices: [{ number: '2026-001', amountYen: 300_000, state: 'open' }] } });
    expect((await call('GET', '/api/payments/me')).status).toBe(401);
  });

  it('lets a viewer read the lists and the CSV, and refuses every write', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await grant(chair.cookie, { userId: member.id }, 'accounting.view');
    const org = await orgId(member.cookie);
    expect((await call('GET', '/api/payments/me', { cookie: member.cookie })).json).toEqual({ canView: true, canConfirm: false, canAdminister: false });
    expect((await call('GET', '/api/payments/overview?fiscalYear=2026', { cookie: member.cookie })).status).toBe(200);
    expect((await call('GET', '/api/payments/export.csv?fiscalYear=2026', { cookie: member.cookie })).status).toBe(200);
    expect((await call('POST', '/api/payments/invoices', { cookie: member.cookie, body: invoiceBody(org) })).status).toBe(403);
    expect((await call('POST', '/api/payments/statements/import', { cookie: member.cookie, body: { dryRun: true, rows: STATEMENT } })).status).toBe(403);
    expect((await call('PUT', '/api/payments/admin/access', { cookie: member.cookie, body: { expectedRevision: 1, userId: member.id, permission: 'accounting.confirm', on: true } })).status).toBe(403);
    // Nothing was written by the refused requests.
    expect((await call('GET', '/api/payments/overview?fiscalYear=2026', { cookie: member.cookie })).json).toMatchObject({ unpaid: [], unmatched: [], imports: [] });
  });

  it('gives a grant to 会計課 to everyone with the role; temporary staff stay out even with the role', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const accountant = await signIn(ACCOUNTANT, '21000040', [ROLE_ACCOUNTING]);
    const staff = await signIn(STAFF, '21000050', [ROLE_STAFF, ROLE_ACCOUNTING]);
    const before = await call('GET', '/api/payments/admin/access', { cookie: chair.cookie });
    expect(before.json.departments).toContain('会計課');
    expect(before.json.departments).not.toContain('臨時スタッフ');
    expect(before.json.people.map((p: { id: string }) => p.id)).not.toContain(staff.id);
    const after = await grant(chair.cookie, { department: '会計課' }, 'accounting.confirm');
    expect(after.departmentGrants).toEqual([{ department: '会計課', permission: 'accounting.confirm' }]);
    expect(after.history[0].text).toBe('部局「会計課」の「請求と入金の確定」を付けました');
    expect((await call('GET', '/api/payments/me', { cookie: accountant.cookie })).json).toEqual({ canView: true, canConfirm: true, canAdminister: false });

    expect((await call('GET', '/api/payments/me', { cookie: staff.cookie })).status).toBe(403);
    expect((await call('GET', '/api/payments/overview', { cookie: staff.cookie })).status).toBe(403);
    expect((await call('POST', '/api/payments/statements/import', { cookie: staff.cookie, body: { dryRun: true, rows: STATEMENT } })).status).toBe(403);
    // A grant to the staff account itself is refused, and a change from an older screen too.
    expect((await call('PUT', '/api/payments/admin/access', { cookie: chair.cookie, body: { expectedRevision: 1, userId: staff.id, permission: 'accounting.view', on: true } })).status).toBe(422);
    expect((await call('PUT', '/api/payments/admin/access', { cookie: chair.cookie, body: { expectedRevision: 0, userId: accountant.id, permission: 'accounting.view', on: true } })).status).toBe(409);
  });
});

describe('payments: invoices, the statement, confirming', () => {
  it('makes one invoice for an organization (a second only when asked), and lists the overdue ones first', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await grant(chair.cookie, { userId: chair.id }, 'accounting.confirm');
    const a = await orgId(chair.cookie);
    const b = await orgId(chair.cookie, { name: '合成食品工業', amountYen: 100_000 });
    const body = invoiceBody(a);
    const first = await call('POST', '/api/payments/invoices', { cookie: chair.cookie, body });
    expect(first.status).toBe(201);
    expect(first.json.invoice).toMatchObject({ number: '2026-001', orgName: '合成商事株式会社', amountYen: 300_000, state: 'open', version: 1 });
    // The same click sent again makes nothing new.
    expect((await call('POST', '/api/payments/invoices', { cookie: chair.cookie, body })).json.invoice.id).toBe(first.json.invoice.id);
    const second = await call('POST', '/api/payments/invoices', { cookie: chair.cookie, body: invoiceBody(a) });
    expect(second.status).toBe(409);
    expect(second.json.message).toContain('2026-001');
    expect((await call('POST', '/api/payments/invoices', { cookie: chair.cookie, body: { ...invoiceBody(a, { amountYen: 50_000 }), allowAnother: true } })).status).toBe(201);
    expect((await call('POST', '/api/payments/invoices', { cookie: chair.cookie, body: invoiceBody(b, { amountYen: 0 }) })).json).toMatchObject({ error: 'validation', details: { field: 'amountYen' } });
    // Past its due date (the test clock is in 2025-10).
    await invoice(chair.cookie, b, { amountYen: 100_000, issuedOn: '2025-09-01', dueOn: '2025-09-30', payerKana: '' });

    const overview = (await call('GET', '/api/payments/overview?fiscalYear=2026', { cookie: chair.cookie })).json;
    expect(overview.unpaid.map((i: { orgName: string; overdue: boolean }) => [i.orgName, i.overdue])).toEqual([
      ['合成食品工業', true],
      ['合成商事株式会社', false],
      ['合成商事株式会社', false],
    ]);
    expect(overview.invoiceable).toEqual([]);
  });

  it('imports a statement after a preview: new, duplicate, withdrawal and unreadable rows; only deposits are kept', async () => {
    const accountant = await signIn(ACCOUNTANT, '21000040', [ROLE_ACCOUNTING]);
    const chair = await signIn(CHAIR, '21000001');
    await grant(chair.cookie, { department: '会計課' }, 'accounting.confirm');
    const { dry, done } = await importStatement(accountant.cookie);
    expect(dry).toMatchObject({ dryRun: true, counts: { new: 2, duplicate: 0, withdrawal: 1, unreadable: 1 } });
    expect(dry.rows.map((r: { line: number; action: string }) => [r.line, r.action])).toEqual([
      [2, 'new'],
      [3, 'withdrawal'],
      [4, 'unreadable'],
      [5, 'new'],
    ]);
    expect(dry.rows[2].reason).toContain('日付');
    expect(done.counts.new).toBe(2);
    const overview = (await call('GET', '/api/payments/overview', { cookie: accountant.cookie })).json;
    expect(overview.unmatched.map((d: { amountYen: number }) => d.amountYen).sort()).toEqual([2_500, 300_000]);
    expect(overview.imports).toEqual([expect.objectContaining({ label: '合成の明細', added: 2, actorName: '合成 会計', matched: 0, removed: false })]);

    // The same file again: the deposits are found as duplicates, and the earlier plan no longer matches.
    const again = await call('POST', '/api/payments/statements/import', { cookie: accountant.cookie, body: { dryRun: true, rows: STATEMENT } });
    expect(again.json.counts).toEqual({ new: 0, duplicate: 2, withdrawal: 1, unreadable: 1 });
    const stale = await call('POST', '/api/payments/statements/import', { cookie: accountant.cookie, body: { dryRun: false, rows: STATEMENT, planToken: dry.planToken } });
    expect(stale.status).toBe(409);
    expect((await call('GET', '/api/payments/overview', { cookie: accountant.cookie })).json.unmatched).toHaveLength(2);

    // Taking the import back removes its deposits.
    expect((await call('POST', `/api/payments/imports/${overview.imports[0].id}/remove`, { cookie: accountant.cookie, body: {} })).status).toBe(200);
    expect((await call('GET', '/api/payments/overview', { cookie: accountant.cookie })).json.unmatched).toEqual([]);
  });

  it('confirms a deposit: the invoice is paid, the organization moves to 入金済み with a history line; taking it back puts the stage back', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await grant(chair.cookie, { userId: member.id }, 'accounting.confirm');
    const org = await orgId(member.cookie);
    const inv = await invoice(member.cookie, org);
    await importStatement(member.cookie);

    const detail = (await call('GET', `/api/payments/invoices/${inv.id}`, { cookie: member.cookie })).json;
    expect(detail.candidates[0]).toMatchObject({ amountFit: 'exact', deposit: { amountYen: 300_000, bookedOn: '2026-11-02' } });
    expect(detail.candidates[0].reasons).toEqual(expect.arrayContaining(['金額が一致']));
    const depositId = detail.candidates[0].deposit.id as string;

    const confirmed = await call('POST', `/api/payments/invoices/${inv.id}/confirm`, { cookie: member.cookie, body: { expectedVersion: 1, depositIds: [depositId] } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.org).toBe('advanced');
    expect(confirmed.json.invoice.invoice).toMatchObject({ state: 'paid', paidYen: 300_000, differenceYen: 0, version: 2, lastPaidOn: '2026-11-02' });
    expect(confirmed.json.invoice.allocations).toEqual([expect.objectContaining({ transactionId: depositId, amountYen: 300_000, confirmedByName: '合成 太郎' })]);

    // The chair has no accounting permission: the line says the stage moved, without the amount, the day or the number.
    const orgDetail = (await call('GET', `/api/organizations/${org}`, { cookie: chair.cookie })).json;
    expect(orgDetail.org.status).toBe('入金済み');
    expect(orgDetail.history[0]).toMatchObject({ action: 'payment_confirmed', actorName: '合成 太郎', changed: ['状態'], payment: null });
    expect(JSON.stringify(orgDetail.history)).not.toMatch(/300000|300,000|2026-11-02|2026-001/);
    // The member who may see the accounting reads them there.
    const accounting = (await call('GET', `/api/organizations/${org}`, { cookie: member.cookie })).json;
    expect(accounting.history[0].payment).toEqual({ amountYen: 300_000, date: '2026-11-02', invoiceNumber: '2026-001', text: '300,000円・2026-11-02・請求 2026-001' });
    // The payer's name from the statement never goes into the organization's history.
    expect(JSON.stringify(accounting.history)).not.toMatch(/ゴウセイ|フリコミ/);
    expect((await call('GET', `/api/payments/organizations/${org}`, { cookie: chair.cookie })).json).toEqual({ state: 'paid', detail: null, canView: false, canConfirm: false });

    // A second click from the same screen, and the same deposit for another invoice, are refused.
    expect((await call('POST', `/api/payments/invoices/${inv.id}/confirm`, { cookie: member.cookie, body: { expectedVersion: 1, depositIds: [depositId] } })).status).toBe(409);
    const circle = await orgId(member.cookie, { kind: 'exhibitor', name: '合成サークル', status: '請求済み', amountYen: 5_000, department: '企画部' });
    const fee = await invoice(member.cookie, circle, { amountYen: 5_000, payerKana: 'ゴウセイサークル' });
    expect((await call('POST', `/api/payments/invoices/${fee.id}/confirm`, { cookie: member.cookie, body: { expectedVersion: 1, depositIds: [depositId] } })).status).toBe(409);

    const back = await call('POST', `/api/payments/invoices/${inv.id}/unconfirm`, { cookie: member.cookie, body: { expectedVersion: 2, depositIds: [depositId] } });
    expect(back.status).toBe(200);
    expect(back.json.org).toBe('reverted');
    expect(back.json.invoice.invoice).toMatchObject({ state: 'open', paidYen: 0, version: 3 });
    expect(back.json.invoice.history.map((h: { action: string }) => h.action)).toEqual(['unconfirmed', 'confirmed', 'invoice_created']);
    const reverted = (await call('GET', `/api/organizations/${org}`, { cookie: chair.cookie })).json;
    expect(reverted.org.status).toBe('請求済み');
    expect(reverted.history[0]).toMatchObject({ action: 'payment_unconfirmed', changed: ['状態'], payment: null });
    expect((await call('GET', `/api/organizations/${org}`, { cookie: member.cookie })).json.history[0].payment.text).toBe('300,000円・請求 2026-001');
  });

  it('shows a part payment, and closes a shortfall only with a reason; the 過不足 list keeps it', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await grant(chair.cookie, { userId: chair.id }, 'accounting.confirm');
    const circle = await orgId(chair.cookie, { kind: 'exhibitor', name: '合成サークル', status: '請求済み', amountYen: 5_000, department: '企画部' });
    const fee = await invoice(chair.cookie, circle, { amountYen: 5_000, payerKana: 'ゴウセイサークル' });
    await importStatement(chair.cookie);
    const detail = (await call('GET', `/api/payments/invoices/${fee.id}`, { cookie: chair.cookie })).json;
    const part = detail.candidates.find((c: { deposit: { amountYen: number } }) => c.deposit.amountYen === 2_500);
    expect(part).toMatchObject({ amountFit: 'part' });

    const first = await call('POST', `/api/payments/invoices/${fee.id}/confirm`, { cookie: chair.cookie, body: { expectedVersion: 1, depositIds: [part.deposit.id] } });
    expect(first.json).toMatchObject({ org: 'unchanged', invoice: { invoice: { state: 'partial', paidYen: 2_500, differenceYen: -2_500 } } });
    expect((await call('GET', `/api/organizations/${circle}`, { cookie: chair.cookie })).json.org.status).toBe('請求済み');
    expect((await call('POST', `/api/payments/invoices/${fee.id}/confirm`, { cookie: chair.cookie, body: { expectedVersion: 2, depositIds: [], acceptShort: { note: '' } } })).status).toBe(422);
    const settled = await call('POST', `/api/payments/invoices/${fee.id}/confirm`, { cookie: chair.cookie, body: { expectedVersion: 2, depositIds: [], acceptShort: { note: '残りは当日に現金で受け取る' } } });
    expect(settled.json).toMatchObject({ org: 'advanced', invoice: { invoice: { state: 'paid', shortAccepted: true, differenceYen: -2_500 } } });
    const overview = (await call('GET', '/api/payments/overview?fiscalYear=2026', { cookie: chair.cookie })).json;
    expect(overview.discrepancies.map((i: { id: string }) => i.id)).toEqual([fee.id]);
    expect(overview.paid.map((i: { id: string }) => i.id)).toEqual([fee.id]);
    const circleDetail = (await call('GET', `/api/organizations/${circle}`, { cookie: chair.cookie })).json;
    expect(circleDetail.org.status).toBe('入金済み');
    // Accepting the shortfall records what came in before it, not a payment of 0 yen.
    expect(circleDetail.history.slice(0, 2).map((h: { action: string; changed: string[]; payment: { text: string } }) => [h.action, h.changed, h.payment.text])).toEqual([
      ['payment_confirmed', ['状態'], '不足を認めて入金済み（入金 2,500円・最後の入金 2026-11-04）・請求 2026-001'],
      ['payment_confirmed', [], '2,500円・2026-11-04・請求 2026-001'],
    ]);
    // A member without the accounting sees the line that moved the stage only, without its amounts.
    const other = await signIn(OTHER, '21000003');
    const plain = (await call('GET', `/api/organizations/${circle}`, { cookie: other.cookie })).json;
    expect(plain.history.filter((h: { action: string }) => h.action.startsWith('payment_'))).toEqual([expect.objectContaining({ action: 'payment_confirmed', changed: ['状態'], payment: null })]);
    expect(JSON.stringify(plain.history)).not.toMatch(/2,500|2500|2026-11-04|2026-001/);

    // Taking the acceptance back puts the invoice and the organization back, with the same kind of line.
    const back = await call('POST', `/api/payments/invoices/${fee.id}/unconfirm`, { cookie: chair.cookie, body: { expectedVersion: 3, depositIds: [] } });
    expect(back.json).toMatchObject({ org: 'reverted', invoice: { invoice: { state: 'partial', shortAccepted: false } } });
    const reverted = (await call('GET', `/api/organizations/${circle}`, { cookie: chair.cookie })).json;
    expect(reverted.org.status).toBe('請求済み');
    expect(reverted.history[0]).toMatchObject({ action: 'payment_unconfirmed', changed: ['状態'], payment: { amountYen: 0, text: '不足の承認を取り消し（入金 2,500円）・請求 2026-001' } });
  });

  it('sets interest aside from the unmatched list, and suggests the day a mail went to the organization without setting it', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    await grant(chair.cookie, { userId: member.id }, 'accounting.confirm');
    expect((await call('PUT', '/api/mail/admin/access', { cookie: chair.cookie, body: { userId: member.id, mailboxId: 'sponsorship', send: true } })).status).toBe(200);
    const contact = await call('POST', '/api/contacts', {
      cookie: member.cookie,
      body: { category: 'external', organization: '合成商事株式会社', section: '', name: '合成 一郎', nameKana: '', emails: [{ label: '', address: 'ichiro@partner.example' }], phones: [], postalCode: '', address: '', tags: [], notes: '' },
    });
    const org = await orgId(member.cookie, { contactId: contact.json.contact.id });
    const draft = await call('POST', '/api/organizations/mail/batches', {
      cookie: member.cookie,
      body: { clientToken: randomBytes(12).toString('base64url'), mailboxId: 'sponsorship', templateId: null, subject: '請求書のご案内（{団体名}）', body: '{担当者名} 様\n請求書をお送りします。', organizationIds: [org] },
    });
    expect(draft.status).toBe(201);
    expect((await call('POST', `/api/organizations/mail/batches/${draft.json.id}/send`, { cookie: member.cookie, body: { includeFailed: false } })).json.batch.status).toBe('done');

    const overview = (await call('GET', '/api/payments/overview?fiscalYear=2026', { cookie: member.cookie })).json;
    const sentOn = new Date(ctx.clock.now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    expect(overview.invoiceable).toEqual([expect.objectContaining({ orgId: org, amountYen: 300_000, issuedOnHints: [{ date: sentOn, subject: '請求書のご案内（合成商事株式会社）' }] })]);
    const inv = await invoice(member.cookie, org, { issuedOn: '' });
    const detail = (await call('GET', `/api/payments/invoices/${inv.id}`, { cookie: member.cookie })).json;
    expect(detail.invoice.issuedOn).toBeNull();
    expect(detail.issuedOnHints[0].date).toBe(sentOn);

    await importStatement(member.cookie, [row(2, '2026/09/30', 'ﾘｿｸ', '12', '', '897,940')]);
    const interest = (await call('GET', '/api/payments/overview', { cookie: member.cookie })).json.unmatched[0];
    const set = await call('POST', `/api/payments/deposits/${interest.id}/exclude`, { cookie: member.cookie, body: { excluded: true, note: '利息' } });
    expect(set.json.deposit).toMatchObject({ excluded: true, excludedNote: '利息' });
    const after = (await call('GET', '/api/payments/overview', { cookie: member.cookie })).json;
    expect(after.unmatched).toEqual([]);
    expect(after.excluded.map((d: { id: string }) => d.id)).toEqual([interest.id]);
  });

  it('writes the CSV for the accounting only: a BOM, plain numbers, the over and short columns, formulas made harmless', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await grant(chair.cookie, { userId: chair.id }, 'accounting.confirm');
    const org = await orgId(chair.cookie, { name: '=合成商事' });
    await invoice(chair.cookie, org, { memo: '分割の相談あり' });
    const res = await call('GET', '/api/payments/export.csv?fiscalYear=2026', { cookie: chair.cookie });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.split('\r\n');
    expect(lines[0]!.startsWith('\uFEFF')).toBe(true);
    expect(lines[0]).toContain('"請求番号","団体名","請求額"');
    // A name that a spreadsheet would run as a formula starts with an apostrophe.
    expect(lines[1]).toContain(`"2026-001","'=合成商事",300000,`);
    expect(lines[1]).toContain('"分割の相談あり"');
    const deposits = await call('GET', '/api/payments/export.csv?what=deposits', { cookie: chair.cookie });
    expect(deposits.body.split('\r\n')[0]).toContain('"日付","摘要","入金額"');
  });
});

describe('payments: the organization follows every change of its invoices', () => {
  const orgOf = async (cookie: string, org: string) => (await call('GET', `/api/organizations/${org}`, { cookie })).json;
  const paidState = async (cookie: string, org: string) => (await call('GET', `/api/payments/organizations/${org}`, { cookie })).json.state as string;
  const depositOf = async (cookie: string, invoiceId: string, amountYen: number) =>
    ((await call('GET', `/api/payments/invoices/${invoiceId}`, { cookie })).json.candidates as { deposit: { id: string; amountYen: number } }[]).find((c) => c.deposit.amountYen === amountYen)!.deposit.id;
  type Fields = { orgId: string; number: string; amountYen: number; issuedOn: string | null; dueOn: string | null; payerKana: string; memo: string };
  const invoiceOf = (inv: Fields, changes: Partial<Fields>): Fields => ({
    orgId: inv.orgId,
    number: inv.number,
    amountYen: inv.amountYen,
    issuedOn: inv.issuedOn,
    dueOn: inv.dueOn,
    payerKana: inv.payerKana,
    memo: inv.memo,
    ...changes,
  });

  it('puts the stage back when the amount of a paid invoice is raised, and forward again when it is set back; a memo moves nothing', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await grant(chair.cookie, { userId: chair.id }, 'accounting.confirm');
    const org = await orgId(chair.cookie);
    const inv = await invoice(chair.cookie, org);
    await importStatement(chair.cookie);
    const deposit = await depositOf(chair.cookie, inv.id, 300_000);
    const confirmed = await call('POST', `/api/payments/invoices/${inv.id}/confirm`, { cookie: chair.cookie, body: { expectedVersion: 1, depositIds: [deposit] } });
    expect(confirmed.json.org).toBe('advanced');

    const raised = await call('PUT', `/api/payments/invoices/${inv.id}`, { cookie: chair.cookie, body: { expectedVersion: 2, invoice: invoiceOf(confirmed.json.invoice.invoice, { amountYen: 350_000 }) } });
    expect(raised.status).toBe(200);
    expect(raised.json).toMatchObject({ org: 'reverted', invoice: { state: 'partial', paidYen: 300_000 } });
    const afterRaise = await orgOf(chair.cookie, org);
    expect(afterRaise.org.status).toBe('請求済み');
    expect(afterRaise.history[0]).toMatchObject({ action: 'payment_rechecked', changed: ['状態'], payment: { text: '請求 2026-001 を変えたため、入金済みでない請求があります' } });
    expect(await paidState(chair.cookie, org)).toBe('unpaid');

    // A change that does not touch the payment leaves the organization and its history as they are.
    const lines = afterRaise.history.length;
    const memo = await call('PUT', `/api/payments/invoices/${inv.id}`, { cookie: chair.cookie, body: { expectedVersion: 3, invoice: invoiceOf(raised.json.invoice, { memo: '差額は相談中' }) } });
    expect(memo.json.org).toBe('unchanged');
    expect((await orgOf(chair.cookie, org)).history).toHaveLength(lines);

    const lowered = await call('PUT', `/api/payments/invoices/${inv.id}`, { cookie: chair.cookie, body: { expectedVersion: 4, invoice: invoiceOf(memo.json.invoice, { amountYen: 300_000 }) } });
    expect(lowered.json).toMatchObject({ org: 'advanced', invoice: { state: 'paid' } });
    expect((await orgOf(chair.cookie, org)).org.status).toBe('入金済み');
    expect(await paidState(chair.cookie, org)).toBe('paid');
  });

  it('moves the stage forward when the other, unpaid invoice is withdrawn, back when it is restored, and back for a new invoice', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await grant(chair.cookie, { userId: chair.id }, 'accounting.confirm');
    const org = await orgId(chair.cookie);
    const first = await invoice(chair.cookie, org);
    const second = await call('POST', '/api/payments/invoices', { cookie: chair.cookie, body: { ...invoiceBody(org, { amountYen: 50_000 }), allowAnother: true } });
    expect(second.json.org).toBe('unchanged');
    await importStatement(chair.cookie);
    const confirmed = await call('POST', `/api/payments/invoices/${first.id}/confirm`, { cookie: chair.cookie, body: { expectedVersion: 1, depositIds: [await depositOf(chair.cookie, first.id, 300_000)] } });
    // The second invoice is still open: the organization has not paid everything.
    expect(confirmed.json.org).toBe('unchanged');
    expect((await orgOf(chair.cookie, org)).org.status).toBe('請求済み');

    const voided = await call('POST', `/api/payments/invoices/${second.json.invoice.id}/void`, { cookie: chair.cookie, body: { expectedVersion: 1, note: '二重に作った' } });
    expect(voided.json).toMatchObject({ org: 'advanced', invoice: { state: 'void' } });
    const afterVoid = await orgOf(chair.cookie, org);
    expect(afterVoid.org.status).toBe('入金済み');
    expect(afterVoid.history[0]).toMatchObject({ action: 'payment_rechecked', changed: ['状態'], payment: { text: '請求 2026-002 を取り消したため、すべての請求が入金済みになりました' } });
    expect(await paidState(chair.cookie, org)).toBe('paid');

    const restored = await call('POST', `/api/payments/invoices/${second.json.invoice.id}/restore`, { cookie: chair.cookie, body: { expectedVersion: 2 } });
    expect(restored.json.org).toBe('reverted');
    expect((await orgOf(chair.cookie, org)).org.status).toBe('請求済み');
    const voidAgain = await call('POST', `/api/payments/invoices/${second.json.invoice.id}/void`, { cookie: chair.cookie, body: { expectedVersion: 3, note: '二重に作った' } });
    expect(voidAgain.json.org).toBe('advanced');

    // A further invoice for the paid organization: it is not paid any more.
    const third = await call('POST', '/api/payments/invoices', { cookie: chair.cookie, body: { ...invoiceBody(org, { amountYen: 20_000 }), allowAnother: true } });
    expect(third.status).toBe(201);
    expect(third.json.org).toBe('reverted');
    const afterNew = await orgOf(chair.cookie, org);
    expect(afterNew.org.status).toBe('請求済み');
    expect(afterNew.history[0].payment.text).toBe('請求 2026-003 を追加したため、入金済みでない請求があります');
    expect(await paidState(chair.cookie, org)).toBe('unpaid');
  });

  it('refuses a deposit set aside since the screen was read with a conflict (the screen reloads)', async () => {
    const chair = await signIn(CHAIR, '21000001');
    await grant(chair.cookie, { userId: chair.id }, 'accounting.confirm');
    const org = await orgId(chair.cookie);
    const inv = await invoice(chair.cookie, org);
    await importStatement(chair.cookie);
    const detail = (await call('GET', `/api/payments/invoices/${inv.id}`, { cookie: chair.cookie })).json;
    expect(detail.candidatesTotal).toBe(2);
    expect(detail.candidates).toHaveLength(2);
    const deposit = detail.candidates[0].deposit.id as string;
    expect((await call('POST', `/api/payments/deposits/${deposit}/exclude`, { cookie: chair.cookie, body: { excluded: true, note: '利息' } })).status).toBe(200);
    const refused = await call('POST', `/api/payments/invoices/${inv.id}/confirm`, { cookie: chair.cookie, body: { expectedVersion: 1, depositIds: [deposit] } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('conflict');
    const latest = (await call('GET', `/api/payments/invoices/${inv.id}`, { cookie: chair.cookie })).json;
    expect(latest.candidates.map((c: { deposit: { id: string } }) => c.deposit.id)).not.toContain(deposit);
    expect(latest.invoice).toMatchObject({ version: 1, state: 'open' });
  });
});

describe('payments: every write is refused without the permission to confirm', () => {
  it('answers 403 to a viewer, a member without a grant and temporary staff, 401 without a sign-in, and writes nothing', async () => {
    const chair = await signIn(CHAIR, '21000001');
    const viewer = await signIn(MEMBER, '21000002');
    const none = await signIn(OTHER, '21000003');
    const staff = await signIn(STAFF, '21000050', [ROLE_STAFF, ROLE_ACCOUNTING]);
    // A member of 会計課, so the department can be given the permission.
    await signIn(ACCOUNTANT, '21000040', [ROLE_ACCOUNTING]);
    await grant(chair.cookie, { userId: chair.id }, 'accounting.confirm');
    await grant(chair.cookie, { userId: viewer.id }, 'accounting.view');
    // 会計課 may confirm: the temporary staff member has that role too, and still may not.
    await grant(chair.cookie, { department: '会計課' }, 'accounting.confirm');
    const org = await orgId(chair.cookie);
    const inv = await invoice(chair.cookie, org);
    await importStatement(chair.cookie);
    const overview = (await call('GET', '/api/payments/overview?fiscalYear=2026', { cookie: chair.cookie })).json;
    const [first, second] = overview.unmatched as { id: string }[];
    expect((await call('POST', `/api/payments/invoices/${inv.id}/confirm`, { cookie: chair.cookie, body: { expectedVersion: 1, depositIds: [first!.id] } })).status).toBe(200);
    const access = (await call('GET', '/api/payments/admin/access', { cookie: chair.cookie })).json;
    const extra = [row(9, '2026/11/05', 'ｺﾞｳｾｲﾎｳﾓﾝ', '700', '', '1,302,760')];
    const plan = (await call('POST', '/api/payments/statements/import', { cookie: chair.cookie, body: { dryRun: true, rows: extra } })).json;
    expect(plan.planToken).toMatch(/^[0-9a-f]{64}$/);
    const snapshot = async () => {
      const o = (await call('GET', '/api/payments/overview?fiscalYear=2026', { cookie: chair.cookie })).json;
      const d = (await call('GET', `/api/payments/invoices/${inv.id}`, { cookie: chair.cookie })).json;
      const a = (await call('GET', '/api/payments/admin/access', { cookie: chair.cookie })).json;
      const g = (await call('GET', `/api/organizations/${org}`, { cookie: chair.cookie })).json;
      return JSON.stringify([o.unpaid, o.paid, o.unmatched, o.excluded, o.voided, o.imports, d.invoice, d.allocations, d.history, a.revision, a.people, a.departmentGrants, g.org, g.history]);
    };
    const before = await snapshot();

    const changed = { orgId: org, number: '', amountYen: 1, issuedOn: null, dueOn: null, payerKana: '', memo: '' };
    const writes: [string, 'POST' | 'PUT', string, unknown][] = [
      ['請求の作成', 'POST', '/api/payments/invoices', { ...invoiceBody(org), allowAnother: true }],
      ['請求の変更', 'PUT', `/api/payments/invoices/${inv.id}`, { expectedVersion: 2, invoice: changed }],
      ['請求の取り消し', 'POST', `/api/payments/invoices/${inv.id}/void`, { expectedVersion: 2, note: '' }],
      ['取り消しを戻す', 'POST', `/api/payments/invoices/${inv.id}/restore`, { expectedVersion: 2 }],
      ['入金の確定', 'POST', `/api/payments/invoices/${inv.id}/confirm`, { expectedVersion: 2, depositIds: [second!.id] }],
      ['確定を外す', 'POST', `/api/payments/invoices/${inv.id}/unconfirm`, { expectedVersion: 2, depositIds: [first!.id] }],
      ['照合の対象外', 'POST', `/api/payments/deposits/${second!.id}/exclude`, { excluded: true, note: '利息' }],
      ['取り込みの取り消し', 'POST', `/api/payments/imports/${overview.imports[0].id}/remove`, {}],
      ['明細の取り込み', 'POST', '/api/payments/statements/import', { dryRun: false, rows: extra, planToken: plan.planToken }],
      ['権限の変更', 'PUT', '/api/payments/admin/access', { expectedRevision: access.revision, userId: viewer.id, permission: 'accounting.confirm', on: true }],
    ];
    const who: [string, string | undefined, number][] = [
      ['閲覧だけ', viewer.cookie, 403],
      ['権限なし', none.cookie, 403],
      ['臨時スタッフ', staff.cookie, 403],
      ['ログインなし', undefined, 401],
    ];
    for (const [person, cookie, status] of who) {
      for (const [name, method, url, body] of writes) {
        const res = await call(method, url, { body, ...(cookie ? { cookie } : {}) });
        expect(res.status, `${person}・${name}`).toBe(status);
      }
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('payments: the demo', () => {
  it('opens synthetic books in the demo: the confirming persona confirms, a persona without a grant is refused', async () => {
    const seed = await seedState();
    const books = openDemoBooks(dir, seed.users, T0);
    expect(books).not.toBeNull();
    let tick = 0;
    const demo = await buildApp({ store: new StateStore(seed, null), listenPort: TEST_PORT, clock: () => new Date(Date.parse(T0) + ++tick * 1000).toISOString(), demoBooks: books });
    const as = (persona: string) => ({ host: TEST_HOST, cookie: `${SESSION_COOKIE}=${persona}` });
    try {
      const me = await demo.inject({ method: 'GET', url: '/api/payments/me', headers: as('u-editor-c') });
      expect(me.json()).toEqual({ canView: true, canConfirm: true, canAdminister: false });
      const overview = (await demo.inject({ method: 'GET', url: '/api/payments/overview', headers: as('u-editor-c') })).json();
      expect(overview.unpaid).toHaveLength(2);
      expect(overview.unmatched).toHaveLength(4);
      const target = overview.unpaid.find((i: { amountYen: number }) => i.amountYen === 300_000);
      const detail = (await demo.inject({ method: 'GET', url: `/api/payments/invoices/${target.id}`, headers: as('u-editor-c') })).json();
      expect(detail.candidates[0].deposit.amountYen).toBe(300_000);
      const confirm = await demo.inject({
        method: 'POST',
        url: `/api/payments/invoices/${target.id}/confirm`,
        headers: { ...as('u-editor-c'), 'content-type': 'application/json' },
        payload: JSON.stringify({ expectedVersion: target.version, depositIds: [detail.candidates[0].deposit.id] }),
      });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json().org).toBe('advanced');
      expect((await demo.inject({ method: 'GET', url: '/api/payments/overview', headers: as('u-viewer-b') })).statusCode).toBe(200);
      expect((await demo.inject({ method: 'GET', url: '/api/payments/overview', headers: as('u-noaccess-d') })).statusCode).toBe(403);
      expect((await demo.inject({ method: 'GET', url: '/api/organizations', headers: as('u-noaccess-d') })).json().total).toBe(4);
      // The organization's history: the amount for the viewing persona, only the moved stage for the one without a grant.
      const line = async (persona: string) => (await demo.inject({ method: 'GET', url: `/api/organizations/${target.orgId}`, headers: as(persona) })).json().history[0];
      expect((await line('u-viewer-b')).payment.text).toBe(`300,000円・${detail.candidates[0].deposit.bookedOn}・請求 ${target.number}`);
      expect(await line('u-noaccess-d')).toMatchObject({ action: 'payment_confirmed', changed: ['状態'], payment: null });
    } finally {
      await demo.close();
    }
  });
});
