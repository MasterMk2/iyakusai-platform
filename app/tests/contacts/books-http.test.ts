import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeShiftJis } from '../../src/server/books/yayoi.js';
import { PROTECTION_NOTE, TAB_MARK } from '../../src/server/books/sheets.js';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import type { MailboxConfig } from '../../src/server/mailbox/config.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { openDemoBooks } from '../../src/server/payments/demo.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState, T0, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from '../mailbox/helpers.js';

// 会計の帳簿 over HTTP: who sees and does what, entries, reimbursement claims with receipts, 弥生 out and in, the
// deposits the payments screen confirmed, and the master spreadsheet (protected, never over somebody else's tab).
// Synthetic names, amounts and reserved .example / .invalid addresses only.

const ROLE_STAFF = '1000000000000002099';
const ROLE_ACCOUNTING = '1000000000000002050';
const ACCOUNTANT = '1000000000000001040';
const STAFF = '1000000000000001050';
const ORIGIN = `http://${TEST_HOST}`;
const SERVICE_ACCOUNT = 'books-writer@synthetic-project.iam.gserviceaccount.com';
vi.setConfig({ testTimeout: 90_000 });

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let sheetCalls: Recorded[];
let sheetTabs: { title: string; mark: boolean; protectedByUs: boolean }[];

const sheetsFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? (url.includes('oauth2') ? init.body : JSON.parse(init.body)) : null;
  sheetCalls.push({ method, url, body });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: `ya29.${'a'.repeat(40)}`, expires_in: 3600 }), { status: 200 });
  if (method === 'GET') {
    return new Response(
      JSON.stringify({
        sheets: sheetTabs.map((t, i) => ({
          properties: { sheetId: i, title: t.title },
          ...(t.mark ? { developerMetadata: [{ metadataKey: TAB_MARK }] } : {}),
          ...(t.protectedByUs ? { protectedRanges: [{ description: PROTECTION_NOTE }] } : {}),
        })),
      }),
      { status: 200 },
    );
  }
  return new Response('{}', { status: 200 });
}) as typeof fetch;

async function build(withSheets = false) {
  let config: MailboxConfig = testMailboxConfig(path.join(dir, 'mail'), {}, randomBytes(32));
  if (withSheets) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config = { ...config, booksSheets: { spreadsheetId: 'synthetic_spreadsheet_id_0000000000', clientEmail: SERVICE_ACCOUNT, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), tabPrefix: '', debounceSeconds: 3600 } };
  }
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases), sheetsFetch },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-books-http-'));
  sheetCalls = [];
  sheetTabs = [{ title: 'シート1', mark: false, protectedByUs: false }];
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子', [ACCOUNTANT]: '合成 会計' } }));
  ctx = setup({ config: testConfig({ departmentRoleIds: { [ROLE_STAFF]: '臨時スタッフ', [ROLE_GENERAL_AFFAIRS]: '総務部', [ROLE_ACCOUNTING]: '会計課' } }) });
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any; body: string; raw: Buffer; headers: Record<string, unknown> };

async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { body?: unknown; cookie?: string } = {}): Promise<Res> {
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
  return { status: res.statusCode, json, body: res.body, raw: res.rawPayload, headers: res.headers };
}

async function upload(url: string, cookie: string, filename: string, data: Buffer): Promise<Res> {
  const boundary = `----synthetic${randomBytes(8).toString('hex')}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({ method: 'POST', url, headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  return { status: res.statusCode, json, body: res.body, raw: res.rawPayload, headers: res.headers };
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

async function grant(chairCookie: string, target: { userId: string } | { department: string }, permission: 'accounting.view' | 'accounting.confirm') {
  const { revision } = (await call('GET', '/api/payments/admin/access', { cookie: chairCookie })).json as { revision: number };
  expect((await call('PUT', '/api/payments/admin/access', { cookie: chairCookie, body: { expectedRevision: revision, ...target, permission, on: true } })).status).toBe(200);
}

const token = () => randomBytes(12).toString('base64url');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);

/** The accounting member, with 弥生's usual accounts and the claim account set. Returns the ids by name. */
async function setUpBooks() {
  const chair = await signIn(CHAIR, '21000001');
  const accountant = await signIn(ACCOUNTANT, '21000004');
  await grant(chair.cookie, { userId: accountant.id }, 'accounting.confirm');
  const defaults = await call('POST', '/api/books/accounts/defaults', { cookie: accountant.cookie });
  expect(defaults.status).toBe(200);
  const ids = new Map<string, string>((defaults.json.accounts as { name: string; id: string }[]).map((a) => [a.name, a.id]));
  const settings = (await call('GET', '/api/books/settings', { cookie: accountant.cookie })).json.settings;
  const saved = await call('PUT', '/api/books/settings', {
    cookie: accountant.cookie,
    body: { expectedVersion: settings.version, settings: { fiscalStartMonth: 1, claimAccountId: ids.get('立替金'), depositMoneyAccountId: ids.get('普通預金'), depositAccountByKind: { sponsor: ids.get('協賛金') } } },
  });
  expect(saved.status).toBe(200);
  return { chair, accountant, ids, id: (name: string) => ids.get(name)! };
}

const entry = (changes: Record<string, unknown>) => ({ form: 'expense', date: '2026-07-01', amountYen: 3_300, moneyAccountId: null, accountId: null, toMoneyAccountId: null, debitAccountId: null, creditAccountId: null, counterparty: '', memo: '', department: '', ...changes });

describe('books: who sees and does what', () => {
  it('lets every member file a claim; the books need 会計を見る; temporary staff and strangers get nothing', async () => {
    await build();
    const member = await signIn(MEMBER, '21000002');
    const staff = await signIn(STAFF, '21000005', [ROLE_STAFF]);
    const me = await call('GET', '/api/books/me', { cookie: member.cookie });
    expect(me.json).toMatchObject({ canClaim: true, canView: false, canEdit: false, sheetsConfigured: false });
    expect((await call('GET', '/api/books/journals?fiscalYear=2026', { cookie: member.cookie })).status).toBe(403);
    expect((await call('GET', '/api/books/summary?fiscalYear=2026', { cookie: member.cookie })).status).toBe(403);
    expect((await call('POST', '/api/books/accounts/defaults', { cookie: member.cookie })).status).toBe(403);
    expect((await call('GET', '/api/books/claims?fiscalYear=2026', { cookie: member.cookie })).json).toMatchObject({ mine: [], submitted: null, owed: null, moneyAccounts: null });
    expect((await call('GET', '/api/books/me', { cookie: staff.cookie })).status).toBe(403);
    expect((await call('GET', '/api/books/me')).status).toBe(401);
  });

  it('books a plain expense, shows it in the balances, takes it back with a reason', async () => {
    await build();
    const { accountant, id } = await setUpBooks();
    const created = await call('POST', '/api/books/journals', { cookie: accountant.cookie, body: { clientToken: token(), entry: entry({ moneyAccountId: id('現金'), accountId: id('消耗品費'), counterparty: '合成ホームセンター', memo: '養生テープ' }) } });
    expect(created.status).toBe(201);
    const j = created.json.journal;
    expect(j).toMatchObject({ number: 'J-000001', direction: 'out', amountYen: 3_300, moneyAccountTitle: '現金', accountTitle: '消耗品費', source: 'manual' });
    expect(j.lines).toEqual([expect.objectContaining({ side: 'debit', accountTitle: '消耗品費' }), expect.objectContaining({ side: 'credit', accountTitle: '現金' })]);
    const summary = (await call('GET', '/api/books/summary?fiscalYear=2026', { cookie: accountant.cookie })).json;
    expect(summary.balances.find((b: { title: string }) => b.title === '現金')).toMatchObject({ outYen: 3_300, balanceYen: -3_300 });
    expect(summary.expenseYen).toBe(3_300);
    expect((await call('POST', `/api/books/journals/${j.id}/void`, { cookie: accountant.cookie, body: { expectedVersion: j.version, note: '二重に入力' } })).status).toBe(200);
    expect((await call('GET', '/api/books/summary?fiscalYear=2026', { cookie: accountant.cookie })).json.expenseYen).toBe(0);
    expect((await call('GET', '/api/books/journals?fiscalYear=2026', { cookie: accountant.cookie })).json.journals).toHaveLength(0);
    const detail = (await call('GET', `/api/books/journals/${j.id}`, { cookie: accountant.cookie })).json;
    expect(detail.history.map((h: { text: string }) => h.text)).toEqual(['取り消しました（二重に入力）', '記帳しました（3,300円）']);
    // A stale version is refused.
    expect((await call('POST', `/api/books/journals/${j.id}/restore`, { cookie: accountant.cookie, body: { expectedVersion: j.version } })).status).toBe(409);
  });

  it('reads one account as its own book (出納帳): the opening, each entry’s change and the balance after it', async () => {
    await build();
    const { accountant, id } = await setUpBooks();
    expect((await call('PUT', '/api/books/openings', { cookie: accountant.cookie, body: { fiscalYear: 2026, rows: [{ accountId: id('現金'), amountYen: 20_000 }, { accountId: id('繰越利益'), amountYen: -20_000 }] } })).status).toBe(200);
    const book = async (body: Record<string, unknown>) => {
      const res = await call('POST', '/api/books/journals', { cookie: accountant.cookie, body: { clientToken: token(), entry: entry(body) } });
      expect(res.status).toBe(201);
      return res.json.journal as { id: string; version: number };
    };
    const tape = await book({ date: '2026-07-01', moneyAccountId: id('現金'), accountId: id('消耗品費'), memo: '養生テープ' });
    const refill = await book({ form: 'transfer', date: '2026-07-15', amountYen: 50_000, moneyAccountId: id('普通預金'), toMoneyAccountId: id('現金'), memo: '小口現金の補充' });
    const stamps = await book({ date: '2026-08-01', amountYen: 1_000, moneyAccountId: id('現金'), accountId: id('通信費'), memo: '切手' });
    const twice = await book({ date: '2026-08-02', amountYen: 500, moneyAccountId: id('現金'), accountId: id('雑費'), memo: '二重' });
    expect((await call('POST', `/api/books/journals/${twice.id}/void`, { cookie: accountant.cookie, body: { expectedVersion: twice.version, note: '二重' } })).status).toBe(200);

    const cash = (await call('GET', `/api/books/journals?fiscalYear=2026&accountId=${id('現金')}&voided=1`, { cookie: accountant.cookie })).json;
    expect(cash.account).toMatchObject({ title: '現金', money: true, openingYen: 20_000, closingYen: 65_700 });
    expect(cash.account.byJournal).toEqual({
      [tape.id]: { changeYen: -3_300, balanceYen: 16_700 },
      [refill.id]: { changeYen: 50_000, balanceYen: 66_700 },
      [stamps.id]: { changeYen: -1_000, balanceYen: 65_700 },
    });
    // The closing balance is the one the summary shows; the words narrow the list, not the balances.
    const summary = (await call('GET', '/api/books/summary?fiscalYear=2026', { cookie: accountant.cookie })).json;
    expect(summary.balances.find((b: { title: string }) => b.title === '現金').balanceYen).toBe(65_700);
    const narrowed = (await call('GET', `/api/books/journals?fiscalYear=2026&accountId=${id('現金')}&q=${encodeURIComponent('切手')}`, { cookie: accountant.cookie })).json;
    expect(narrowed.journals.map((j: { id: string }) => j.id)).toEqual([stamps.id]);
    expect(narrowed.account.byJournal[stamps.id].balanceYen).toBe(65_700);
    // An account on the credit side (繰越利益) counts its credits up; no account chosen, no book.
    expect((await call('GET', `/api/books/journals?fiscalYear=2026&accountId=${id('繰越利益')}`, { cookie: accountant.cookie })).json.account).toMatchObject({ openingYen: 20_000, closingYen: 20_000, money: false });
    expect((await call('GET', '/api/books/journals?fiscalYear=2026', { cookie: accountant.cookie })).json.account).toBeUndefined();
  });
});

describe('books: reimbursement claims (立替精算)', () => {
  it('goes from a member’s claim with a receipt to the accounting’s approval and payment, with the journals', async () => {
    await build();
    const { accountant, id } = await setUpBooks();
    const member = await signIn(MEMBER, '21000002');
    const other = await signIn(OTHER, '21000003');
    const filed = await call('POST', '/api/books/claims', { cookie: member.cookie, body: { clientToken: token(), claim: { spentOn: '2026-08-20', amountYen: 1_980, payee: '合成文具店', purpose: '受付用のペン', department: '', accountId: id('事務用品費'), preapproval: '' } } });
    expect(filed.status).toBe(201);
    const claim = filed.json.claim;
    expect(claim).toMatchObject({ number: 'TK-2026-001', state: 'submitted', mine: true, claimantName: '合成 太郎' });

    const added = await upload(`/api/books/claims/${claim.id}/receipts`, member.cookie, 'receipt.png', PNG);
    expect(added.status).toBe(201);
    expect(added.json.receipt).toMatchObject({ type: 'image/png', bytes: PNG.length });
    expect((await upload(`/api/books/claims/${claim.id}/receipts`, member.cookie, 'note.txt', Buffer.from('not an image'))).status).toBe(422);
    // Another member does not learn that the claim exists.
    expect((await call('GET', `/api/books/claims/${claim.id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await call('GET', `/api/books/receipts/${added.json.receipt.id}`, { cookie: other.cookie })).status).toBe(404);
    const file = await call('GET', `/api/books/receipts/${added.json.receipt.id}`, { cookie: member.cookie });
    expect(file.status).toBe(200);
    expect(file.raw.equals(PNG)).toBe(true);
    expect(file.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff' });
    expect(String(file.headers['cache-control'])).toContain('no-store');
    expect(String(file.headers['content-security-policy'])).toContain('sandbox');

    const listed = (await call('GET', '/api/books/claims?fiscalYear=2026', { cookie: accountant.cookie })).json;
    expect(listed.submitted).toHaveLength(1);
    const approved = await call('POST', `/api/books/claims/${claim.id}/approve`, { cookie: accountant.cookie, body: { expectedVersion: claim.version, accountId: id('事務用品費') } });
    expect(approved.status).toBe(200);
    expect(approved.json.claim.state).toBe('approved');
    // The member can no longer change the receipts of an approved claim.
    expect((await upload(`/api/books/claims/${claim.id}/receipts`, member.cookie, 'receipt.png', PNG)).status).toBe(403);
    const owed = (await call('GET', '/api/books/claims?fiscalYear=2026', { cookie: accountant.cookie })).json;
    expect(owed.owed).toEqual([{ claimantId: member.id, claimantName: '合成 太郎', count: 1, amountYen: 1_980 }]);

    const paid = await call('POST', '/api/books/claims/pay', { cookie: accountant.cookie, body: { paidOn: '2026-08-25', moneyAccountId: id('普通預金'), claims: [{ id: claim.id, expectedVersion: approved.json.claim.version }] } });
    expect(paid.status).toBe(200);
    expect(paid.json).toMatchObject({ totalYen: 1_980, claims: [expect.objectContaining({ state: 'paid', paidOn: '2026-08-25', paidFromTitle: '普通預金' })] });

    const journals = (await call('GET', '/api/books/journals?fiscalYear=2026', { cookie: accountant.cookie })).json.journals as { source: string; lines: { side: string; accountTitle: string; amountYen: number }[]; memo: string }[];
    expect(journals.map((j) => j.lines.map((l) => `${l.side}:${l.accountTitle}`))).toEqual([
      ['debit:立替金', 'credit:普通預金'],
      ['debit:事務用品費', 'credit:立替金'],
    ]);
    expect(journals.every((j) => j.source === 'claim')).toBe(true);
    expect(journals[1]!.memo).toContain('TK-2026-001');
  });

  it('refuses to approve before the claim account is set, and a rejection needs a reason the member sees', async () => {
    await build();
    const chair = await signIn(CHAIR, '21000001');
    const accountant = await signIn(ACCOUNTANT, '21000004');
    await grant(chair.cookie, { userId: accountant.id }, 'accounting.confirm');
    const accounts = (await call('POST', '/api/books/accounts/defaults', { cookie: accountant.cookie })).json.accounts as { name: string; id: string }[];
    const supplies = accounts.find((a) => a.name === '消耗品費')!.id;
    const member = await signIn(MEMBER, '21000002');
    const claim = (await call('POST', '/api/books/claims', { cookie: member.cookie, body: { clientToken: token(), claim: { spentOn: '2026-08-20', amountYen: 500, payee: '合成商店', purpose: '電池', department: '', accountId: null, preapproval: '' } } })).json.claim;
    const refused = await call('POST', `/api/books/claims/${claim.id}/approve`, { cookie: accountant.cookie, body: { expectedVersion: claim.version, accountId: supplies } });
    expect(refused.status).toBe(422);
    expect(refused.json.message).toContain('立替精算で使う科目');
    expect((await call('POST', `/api/books/claims/${claim.id}/reject`, { cookie: accountant.cookie, body: { expectedVersion: claim.version, note: '' } })).status).toBe(422);
    const rejected = await call('POST', `/api/books/claims/${claim.id}/reject`, { cookie: accountant.cookie, body: { expectedVersion: claim.version, note: 'レシートの写真を付けてください' } });
    expect(rejected.status).toBe(200);
    const mine = (await call('GET', `/api/books/claims/${claim.id}`, { cookie: member.cookie })).json;
    expect(mine.claim).toMatchObject({ state: 'rejected', note: 'レシートの写真を付けてください' });
    // Fixed and sent again.
    const again = await call('PUT', `/api/books/claims/${claim.id}`, { cookie: member.cookie, body: { expectedVersion: mine.claim.version, claim: { spentOn: '2026-08-20', amountYen: 500, payee: '合成商店', purpose: '電池（単3）', department: '', accountId: null, preapproval: '' } } });
    expect(again.status).toBe(200);
    expect(again.json.claim).toMatchObject({ state: 'submitted', note: '' });
  });
});

/** One 弥生 journal row (27 columns), as 弥生会計 Next writes it. */
const yayoiRow = (no: string, date: string, debit: string, credit: string, amount: number, memo: string, partner = '') =>
  ['2000', no, '', date, debit, '', '', '対象外', String(amount), '0', credit, '', '', '対象外', String(amount), '0', memo, '', '', '0', '', '', '', '', 'no', '', partner].map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

async function importYayoi(cookie: string, kind: 'journals' | 'openings', text: string) {
  const data = Buffer.from(encodeShiftJis(text));
  const dry = await upload(`/api/books/yayoi/import?kind=${kind}&dryRun=1`, cookie, 'yayoi.csv', data);
  expect(dry.status).toBe(200);
  const done = await upload(`/api/books/yayoi/import?kind=${kind}&dryRun=0&planToken=${dry.json.planToken}`, cookie, 'yayoi.csv', data);
  return { dry: dry.json, done };
}

describe('books: 弥生', () => {
  it('writes the journals made here as 弥生’s Shift_JIS file once, and reads 弥生’s file back without doubling them', async () => {
    await build();
    const { accountant, id } = await setUpBooks();
    const made = await call('POST', '/api/books/journals', { cookie: accountant.cookie, body: { clientToken: token(), entry: entry({ moneyAccountId: id('現金'), accountId: id('消耗品費'), counterparty: '合成ホームセンター', memo: '養生テープ' }) } });
    expect(made.status).toBe(201);

    const plan = (await call('GET', '/api/books/yayoi/plan?fiscalYear=2026', { cookie: accountant.cookie })).json;
    expect(plan).toMatchObject({ count: 1, rows: 1, unencodable: [] });
    const exported = await call('POST', '/api/books/yayoi/export', { cookie: accountant.cookie, body: { fiscalYear: 2026, expectedCount: 1 } });
    expect(exported.status).toBe(200);
    const file = await call('GET', `/api/books/yayoi/exports/${exported.json.exportId}`, { cookie: accountant.cookie });
    expect(file.headers['content-type']).toBe('text/csv; charset=shift_jis');
    const text = new TextDecoder('shift_jis').decode(file.raw);
    const cells = text.replace(/\r\n$/, '').split(',');
    expect(cells).toHaveLength(27);
    expect(cells.slice(0, 9)).toEqual(['2000', '', '', '2026/07/01', '消耗品費', '', '', '対象外', '3300']);
    expect(cells[16]).toContain('[KB J-000001]');
    expect((await call('GET', '/api/books/yayoi/plan?fiscalYear=2026', { cookie: accountant.cookie })).json.count).toBe(0);

    // 弥生 writes it back with its own number, next to a journal entered in 弥生 only.
    const back = [yayoiRow('7', '2026/07/01', '消耗品費', '現金', 3300, `養生テープ 合成ホームセンター [KB J-000001]`), yayoiRow('8', '2026/07/02', '普通預金', '学内寄付金', 30000, '寄付', '合成後援会')].join('\r\n') + '\r\n';
    const first = await importYayoi(accountant.cookie, 'journals', back);
    expect(first.dry.counts).toEqual({ new: 1, duplicate: 0, ours: 1, unreadable: 0 });
    expect(first.done.status).toBe(200);
    const journals = (await call('GET', '/api/books/journals?fiscalYear=2026', { cookie: accountant.cookie })).json.journals as { number: string; source: string; yayoiNo: string; amountYen: number }[];
    expect(journals.map((j) => [j.number, j.source, j.yayoiNo, j.amountYen])).toEqual([
      ['J-000002', 'yayoi', '8', 30_000],
      ['J-000001', 'manual', '7', 3_300],
    ]);
    // The same file again adds nothing.
    const second = await importYayoi(accountant.cookie, 'journals', back);
    expect(second.dry.counts).toMatchObject({ new: 0, duplicate: 1, ours: 1 });
    expect((await call('GET', '/api/books/journals?fiscalYear=2026', { cookie: accountant.cookie })).json.journals).toHaveLength(2);
  });

  it('reads 弥生’s opening balances only when the sides agree, and refuses a stale preview', async () => {
    await build();
    const { accountant } = await setUpBooks();
    const unbalanced = await importYayoi(accountant.cookie, 'openings', '2026/01/01,普通預金,借方,,,800000\r\n2026/01/01,繰越利益,貸方,,,700000\r\n');
    expect(unbalanced.done.status).toBe(422);
    const good = await importYayoi(accountant.cookie, 'openings', '2026/01/01,普通預金,借方,,,800000\r\n2026/01/01,現金,借方,,,20000\r\n2026/01/01,繰越利益,貸方,,,820000\r\n');
    expect(good.done.status).toBe(200);
    const openings = (await call('GET', '/api/books/openings?fiscalYear=2026', { cookie: accountant.cookie })).json.rows as { accountId: string; title: string; amountYen: number }[];
    expect(Object.fromEntries(openings.map((o) => [o.title, o.amountYen]))).toEqual({ 普通預金: 800_000, 現金: 20_000, 繰越利益: -820_000 });
    // Entered by hand, too, the two sides have to agree.
    const ids = Object.fromEntries(openings.map((o) => [o.title, o.accountId]));
    const handBad = await call('PUT', '/api/books/openings', { cookie: accountant.cookie, body: { fiscalYear: 2026, rows: [{ accountId: ids['現金'], amountYen: 30_000 }, { accountId: ids['繰越利益'], amountYen: -20_000 }] } });
    expect(handBad.status).toBe(422);
    expect(handBad.json.message).toContain('合いません');
    const handGood = await call('PUT', '/api/books/openings', { cookie: accountant.cookie, body: { fiscalYear: 2026, rows: [{ accountId: ids['現金'], amountYen: 30_000 }, { accountId: ids['繰越利益'], amountYen: -30_000 }] } });
    expect(handGood.status).toBe(200);
    const stale = await upload('/api/books/yayoi/import?kind=openings&dryRun=0&planToken=' + '0'.repeat(64), accountant.cookie, 'yayoi.csv', Buffer.from(encodeShiftJis('2026/01/01,現金,借方,,,1\r\n2026/01/01,繰越利益,貸方,,,1\r\n')));
    expect(stale.status).toBe(409);
  });
});

describe('books: the deposits confirmed on the payments screen', () => {
  it('books a confirmed deposit once, as income of the organization’s kind, or marks it as booked elsewhere', async () => {
    await build();
    const { accountant, id } = await setUpBooks();
    const org = (await call('POST', '/api/organizations', { cookie: accountant.cookie, body: { kind: 'sponsor', fiscalYear: 2026, name: '合成商事株式会社', department: '渉外課', ownerId: null, contactId: null, status: '請求済み', amountYen: 300_000, content: '', nextAction: '', nextDue: null, notes: '' } })).json.org.id as string;
    const inv = (await call('POST', '/api/payments/invoices', { cookie: accountant.cookie, body: { clientToken: token(), invoice: { orgId: org, number: '', amountYen: 300_000, issuedOn: '2026-10-20', dueOn: '2026-11-15', payerKana: 'ゴウセイシヨウジ', memo: '' } } })).json.invoice;
    const rows = [{ line: 2, date: '2026/11/02', description: 'ﾌﾘｺﾐ ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ', deposit: '300,000', withdrawal: '', balance: '1,300,000' }];
    const dry = (await call('POST', '/api/payments/statements/import', { cookie: accountant.cookie, body: { dryRun: true, rows } })).json;
    expect((await call('POST', '/api/payments/statements/import', { cookie: accountant.cookie, body: { dryRun: false, label: '合成の明細', rows, planToken: dry.planToken } })).status).toBe(200);
    const detail = (await call('GET', `/api/payments/invoices/${inv.id}`, { cookie: accountant.cookie })).json;
    const depositId = detail.candidates[0].deposit.id as string;
    expect((await call('POST', `/api/payments/invoices/${inv.id}/confirm`, { cookie: accountant.cookie, body: { expectedVersion: 1, depositIds: [depositId] } })).status).toBe(200);

    const deposits = (await call('GET', '/api/books/deposits', { cookie: accountant.cookie })).json;
    expect(deposits.toBook).toEqual([expect.objectContaining({ depositId, amountYen: 300_000, orgName: '合成商事株式会社', orgKind: 'sponsor', suggestedAccountId: id('協賛金') })]);
    const booked = await call('POST', '/api/books/deposits/book', { cookie: accountant.cookie, body: { items: [{ depositId, moneyAccountId: id('普通預金'), accountId: id('協賛金') }] } });
    expect(booked.json).toEqual({ booked: 1 });
    expect((await call('POST', '/api/books/deposits/book', { cookie: accountant.cookie, body: { items: [{ depositId, moneyAccountId: id('普通預金'), accountId: id('協賛金') }] } })).status).toBe(409);
    const after = (await call('GET', '/api/books/deposits', { cookie: accountant.cookie })).json;
    expect(after.toBook).toHaveLength(0);
    expect(after.booked).toEqual([expect.objectContaining({ depositId, journalNumber: 'J-000001' })]);
    const summary = (await call('GET', '/api/books/summary?fiscalYear=2026', { cookie: accountant.cookie })).json;
    expect(summary.incomeYen).toBe(300_000);
  });
});

describe('books: the budget', () => {
  it('compares the budget with the actual figures per account', async () => {
    await build();
    const { accountant, id } = await setUpBooks();
    await call('POST', '/api/books/journals', { cookie: accountant.cookie, body: { clientToken: token(), entry: entry({ amountYen: 55_000, moneyAccountId: id('普通預金'), accountId: id('広告宣伝費') }) } });
    expect((await call('PUT', '/api/books/budget', { cookie: accountant.cookie, body: { fiscalYear: 2026, lines: [{ accountName: '広告宣伝費', amountYen: 200_000 }] } })).status).toBe(200);
    expect((await call('PUT', '/api/books/budget', { cookie: accountant.cookie, body: { fiscalYear: 2026, lines: [{ accountName: '存在しない科目', amountYen: 1 }] } })).status).toBe(422);
    const rows = (await call('GET', '/api/books/budget?fiscalYear=2026', { cookie: accountant.cookie })).json.rows;
    expect(rows).toEqual([expect.objectContaining({ accountName: '広告宣伝費', budgetYen: 200_000, actualYen: 55_000, differenceYen: -145_000, rate: 27.5 })]);
  });
});

describe('books: the master spreadsheet', () => {
  it('writes the tabs as the app’s own, protected for the service account only, with dates and amounts as numbers', async () => {
    await build(true);
    const { accountant, id } = await setUpBooks();
    expect((await call('GET', '/api/books/me', { cookie: accountant.cookie })).json.sheetsConfigured).toBe(true);
    await call('POST', '/api/books/journals', { cookie: accountant.cookie, body: { clientToken: token(), entry: entry({ moneyAccountId: id('現金'), accountId: id('消耗品費'), memo: '=HYPERLINK("x")' }) } });
    const status = await call('POST', '/api/books/sheets/sync', { cookie: accountant.cookie });
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ configured: true, lastError: null });
    expect(status.json.lastOkAt).not.toBeNull();

    type SheetRequest = { addSheet?: { properties: { title: string } }; createDeveloperMetadata?: unknown; setBasicFilter?: unknown; addProtectedRange?: { protectedRange: { warningOnly: boolean; description: string; editors: unknown } } };
    const posts = sheetCalls.filter((c) => c.method === 'POST' && c.url.startsWith('https://sheets.googleapis.com'));
    const create = posts.find((c) => c.url.endsWith(':batchUpdate'))!.body as { requests: SheetRequest[] };
    const titles = create.requests.flatMap((r) => (r.addSheet ? [r.addSheet.properties.title] : []));
    expect(titles).toEqual(['案内', '収支一覧', '口座残高', '予算と実績', '立替精算', '仕訳帳', '残高試算表', '期首残高', '科目', '取り消した仕訳']);
    expect(create.requests.filter((r) => r.createDeveloperMetadata)).toHaveLength(titles.length);
    const values = posts.find((c) => c.url.endsWith('/values:batchUpdate'))!.body as { valueInputOption: string; data: { range: string; values: unknown[][] }[] };
    expect(values.valueInputOption).toBe('RAW');
    const list = values.data.find((d) => d.range.startsWith("'収支一覧'"))!.values;
    expect(list[0]!.slice(0, 3)).toEqual(['日付', '番号', '年度']);
    // 2026-07-01 as the spreadsheet's day number; the amount as a number; a formula stays text.
    expect(list[1]!.slice(0, 2)).toEqual([46204, 'J-000001']);
    expect(list[1]![7]).toBe(3_300);
    expect(list[1]![10]).toBe('=HYPERLINK("x")');
    const look = posts.filter((c) => c.url.endsWith(':batchUpdate')).at(-1)!.body as { requests: SheetRequest[] };
    const protections = look.requests.flatMap((r) => (r.addProtectedRange ? [r.addProtectedRange.protectedRange] : []));
    expect(protections).toHaveLength(titles.length);
    expect(protections.every((p) => p.warningOnly === false && p.description === PROTECTION_NOTE && JSON.stringify(p.editors) === JSON.stringify({ users: [SERVICE_ACCOUNT] }))).toBe(true);
    expect(look.requests.some((r) => r.setBasicFilter)).toBe(true);
    // Nothing secret in what was sent to Google beyond the signed assertion.
    expect(JSON.stringify(sheetCalls)).not.toContain('PRIVATE KEY');
  });

  it('stops at a tab of the same name it did not make, and says why', async () => {
    await build(true);
    sheetTabs.push({ title: '収支一覧', mark: false, protectedByUs: false });
    const { accountant } = await setUpBooks();
    const status = (await call('POST', '/api/books/sheets/sync', { cookie: accountant.cookie })).json;
    expect(status.lastError).toContain('基盤が作っていないタブ');
    expect(sheetCalls.some((c) => c.url.includes('values:batchClear'))).toBe(false);
  });
});

describe('books: the demo', () => {
  it('opens synthetic books in the demo: the confirming persona sees the books, a persona without a grant files claims only', async () => {
    await build();
    const seed = await seedState();
    const books = openDemoBooks(path.join(dir, 'demo'), seed.users, T0);
    expect(books).not.toBeNull();
    let tick = 0;
    const demo = await buildApp({ store: new StateStore(seed, null), listenPort: TEST_PORT, clock: () => new Date(Date.parse(T0) + ++tick * 1000).toISOString(), demoBooks: books });
    const as = (persona: string) => ({ host: TEST_HOST, cookie: `${SESSION_COOKIE}=${persona}` });
    try {
      const summary = await demo.inject({ method: 'GET', url: '/api/books/summary?fiscalYear=2026', headers: as('u-editor-c') });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().balances.length).toBeGreaterThan(0);
      expect((await demo.inject({ method: 'GET', url: '/api/books/journals?fiscalYear=2026', headers: as('u-editor-c') })).json().journals).toHaveLength(4);
      expect((await demo.inject({ method: 'GET', url: '/api/books/summary?fiscalYear=2026', headers: as('u-noaccess-d') })).statusCode).toBe(403);
      expect((await demo.inject({ method: 'GET', url: '/api/books/claims?fiscalYear=2026', headers: as('u-noaccess-d') })).statusCode).toBe(200);
    } finally {
      await demo.close();
    }
  });
});
