import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateBankConfig } from '../../src/server/bank/config.js';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import type { MailboxConfig } from '../../src/server/mailbox/config.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { CHAIR, MEMBER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from '../mailbox/helpers.js';

// 銀行の連携 over HTTP: who sees and does what, the return from the bank through the /bank/callback screen, and that
// no answer carries a token. The bank is a fake in this process; synthetic ids, tokens and amounts only.

const ROLE_STAFF = '1000000000000002099';
const ACCOUNTANT = '1000000000000001040';
const STAFF = '1000000000000001050';
const ORIGIN = `http://${TEST_HOST}`;
const REDIRECT = 'https://app.example.invalid/bank/callback';
vi.setConfig({ testTimeout: 90_000 });

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let bankCalls: { url: string; body: string }[];

const bankFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  bankCalls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
  if (url.endsWith('/ganb/api/auth/v1/token')) return new Response(JSON.stringify({ access_token: 'synthetic-access-token-0001', expires_in: 2_592_000, refresh_token: 'synthetic-refresh-token-0001', scope: 'private:account private:virtual-account' }), { status: 200 });
  if (url.endsWith('/corporation/v1/accounts')) return new Response(JSON.stringify({ accounts: [{ accountId: '101011234567', branchName: '合成支店', accountTypeName: '普通預金', accountNumber: '7654321' }] }), { status: 200 });
  if (url.endsWith('/corporation/v1/accounts/balances')) return new Response(JSON.stringify({ balances: [{ accountId: '101011234567', balance: '2000' }] }), { status: 200 });
  if (url.includes('/corporation/v1/accounts/transactions?')) {
    // Two pages, as the bank sends them: hasNext / nextItemKey (the second page as strings, as sunabar does).
    const q = new URL(url).searchParams;
    if (q.get('accountId') !== '101011234567') return new Response('{}', { status: 400 });
    if (!q.get('nextItemKey')) {
      return new Response(JSON.stringify({ hasNext: true, nextItemKey: '20261102000000000001', transactions: [
        { transactionDate: '2026-11-01', transactionType: '1', amount: '30000', remarks: '振込 ゴウセイ（カ', balance: '30000', itemKey: '1' },
        { transactionDate: '2026-11-02', transactionType: '2', amount: '1000', remarks: '振込手数料', balance: '29000', itemKey: '2' },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ hasNext: 'false', transactions: [
      { transactionDate: '2026-11-03', transactionType: '1', amount: '50000', remarks: '振込 ゴウセイイリョウホウジン', balance: '79000', itemKey: '3' },
    ] }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

async function build(withBank = true) {
  const mailDir = path.join(dir, 'mail');
  let config: MailboxConfig = testMailboxConfig(mailDir, {}, randomBytes(32));
  if (withBank) config = { ...config, bank: validateBankConfig({ version: 1, environment: 'sunabar', clientId: 'synthetic-client-0001', redirectUri: REDIRECT }, mailDir, 'synthetic-secret-0001', randomBytes(32)) };
  mail = new MailboxStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases), bankFetch },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-bank-http-'));
  bankCalls = [];
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>synthetic</title>');
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [ACCOUNTANT]: '合成 会計' } }));
  ctx = setup({ config: testConfig({ departmentRoleIds: { [ROLE_STAFF]: '臨時スタッフ', [ROLE_GENERAL_AFFAIRS]: '総務部' } }) });
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any; body: string; headers: Record<string, unknown> };

async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
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

async function grantView(chairCookie: string, userId: string) {
  const { revision } = (await call('GET', '/api/payments/admin/access', { cookie: chairCookie })).json as { revision: number };
  expect((await call('PUT', '/api/payments/admin/access', { cookie: chairCookie, body: { expectedRevision: revision, userId, permission: 'accounting.view', on: true } })).status).toBe(200);
}

describe('bank: who sees and does what', () => {
  it('shows the state to 権限管理者 and 会計を見る only; connecting is for 権限管理者', async () => {
    await build();
    const chair = await signIn(CHAIR, '21000001');
    const member = await signIn(MEMBER, '21000002');
    const accountant = await signIn(ACCOUNTANT, '21000004');
    const staff = await signIn(STAFF, '21000005', [ROLE_STAFF]);
    await grantView(chair.cookie, accountant.id);

    expect((await call('GET', '/api/bank/status')).status).toBe(401);
    expect((await call('GET', '/api/bank/status', { cookie: member.cookie })).status).toBe(403);
    expect((await call('GET', '/api/bank/status', { cookie: staff.cookie })).status).toBe(403);
    expect((await call('POST', '/api/bank/oauth/start', { cookie: staff.cookie, body: {} })).status).toBe(403);

    const asChair = await call('GET', '/api/bank/status', { cookie: chair.cookie });
    expect(asChair.json).toMatchObject({ configured: true, environment: 'sunabar', state: 'disconnected', canConnect: true, canCheck: false, redirectUri: REDIRECT });
    const asAccountant = await call('GET', '/api/bank/status', { cookie: accountant.cookie });
    expect(asAccountant.json).toMatchObject({ configured: true, canConnect: false, canCheck: true, redirectUri: null });
    expect((await call('POST', '/api/bank/oauth/start', { cookie: accountant.cookie, body: {} })).status).toBe(403);
    expect((await call('POST', '/api/bank/disconnect', { cookie: accountant.cookie, body: {} })).status).toBe(403);
    expect((await call('POST', '/api/bank/check', { cookie: chair.cookie, body: {} })).status).toBe(403);
    expect((await call('POST', '/api/bank/check', { cookie: member.cookie, body: {} })).status).toBe(403);
  });

  it('says "not configured" without bank.json', async () => {
    await build(false);
    const chair = await signIn(CHAIR, '21000001');
    expect((await call('GET', '/api/bank/status', { cookie: chair.cookie })).json).toMatchObject({ configured: false, canConnect: true });
    expect((await call('POST', '/api/bank/oauth/start', { cookie: chair.cookie, body: {} })).json).toMatchObject({ error: 'bank_not_configured' });
  });
});

describe('bank: connecting through the return screen', () => {
  it('connects, checks and disconnects without any token in an answer', async () => {
    await build();
    const chair = await signIn(CHAIR, '21000001');
    const accountant = await signIn(ACCOUNTANT, '21000004');
    await grantView(chair.cookie, accountant.id);

    const started = await call('POST', '/api/bank/oauth/start', { cookie: chair.cookie, body: {} });
    expect(started.status).toBe(200);
    const authorize = new URL(started.json.authorizeUrl as string);
    expect(authorize.origin + authorize.pathname).toBe('https://api.sunabar.gmo-aozora.com/ganb/api/auth/v1/authorization');
    expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT);
    const state = authorize.searchParams.get('state')!;

    // The bank sends the browser back across sites, without the Strict cookie: the screen loads, an API would not.
    const back = await call('GET', `/bank/callback?code=synthetic-code&state=${state}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(back.status).toBe(200);
    expect(back.headers['cache-control']).toBe('no-store');
    expect(back.headers['referrer-policy']).toBe('no-referrer');
    expect((await call('GET', '/api/bank/status', { cookie: chair.cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);

    // The screen posts the code as a same-origin request.
    expect((await call('POST', '/api/bank/oauth/complete', { cookie: accountant.cookie, body: { state, code: 'synthetic-code' } })).status).toBe(403);
    const done = await call('POST', '/api/bank/oauth/complete', { cookie: chair.cookie, body: { state, code: 'synthetic-code' } });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ state: 'connected', connectedBy: '合成 委員長', refreshable: true, scopes: ['private:account', 'private:virtual-account'] });
    expect(new URLSearchParams(bankCalls[0]!.body).get('code')).toBe('synthetic-code');
    // Used once.
    expect((await call('POST', '/api/bank/oauth/complete', { cookie: chair.cookie, body: { state, code: 'synthetic-code' } })).json).toMatchObject({ error: 'bank_state' });

    const checked = await call('POST', '/api/bank/check', { cookie: accountant.cookie, body: {} });
    expect(checked.status).toBe(200);
    expect(checked.json.accounts).toEqual([{ branchName: '合成支店', accountTypeName: '普通預金', accountNumberLast4: '4321', balanceYen: 2000 }]);

    const status = await call('GET', '/api/bank/status', { cookie: accountant.cookie });
    for (const res of [done, checked, status]) {
      expect(res.body).not.toContain('synthetic-access-token');
      expect(res.body).not.toContain('synthetic-refresh-token');
      expect(res.body).not.toContain('synthetic-secret');
      expect(res.body).not.toContain('7654321');
    }
    // Nothing in the mail folder holds a token in the clear.
    const mailDir = path.join(dir, 'mail');
    for (const name of readdirSync(mailDir).filter((n) => n.startsWith('bank'))) {
      expect(readFileSync(path.join(mailDir, name), 'utf8')).not.toContain('synthetic-access-token');
    }

    const off = await call('POST', '/api/bank/disconnect', { cookie: chair.cookie, body: {} });
    expect(off.json).toMatchObject({ state: 'disconnected' });
    expect((await call('POST', '/api/bank/check', { cookie: accountant.cookie, body: {} })).json).toMatchObject({ error: 'bank_not_connected' });
  });

  it('records a refusal at the bank and keeps nothing', async () => {
    await build();
    const chair = await signIn(CHAIR, '21000001');
    const started = await call('POST', '/api/bank/oauth/start', { cookie: chair.cookie, body: {} });
    const state = new URL(started.json.authorizeUrl as string).searchParams.get('state')!;
    const refused = await call('POST', '/api/bank/oauth/complete', { cookie: chair.cookie, body: { state, error: 'access_denied' } });
    expect(refused.status).toBe(502);
    expect(refused.json.message).toMatch(/許可されませんでした/);
    expect(bankCalls).toHaveLength(0);
    expect((await call('POST', '/api/bank/oauth/complete', { cookie: chair.cookie, body: { state, code: 'x', error: 'y' } })).status).toBe(400);
    expect((await call('GET', '/api/bank/status', { cookie: chair.cookie })).json.state).toBe('disconnected');
  });
});

describe('bank: the statement into 入金確認', () => {
  async function connected() {
    await build();
    const chair = await signIn(CHAIR, '21000001');
    const accountant = await signIn(ACCOUNTANT, '21000004');
    const member = await signIn(MEMBER, '21000002');
    const { revision } = (await call('GET', '/api/payments/admin/access', { cookie: chair.cookie })).json as { revision: number };
    expect((await call('PUT', '/api/payments/admin/access', { cookie: chair.cookie, body: { expectedRevision: revision, userId: accountant.id, permission: 'accounting.confirm', on: true } })).status).toBe(200);
    return { chair, accountant, member };
  }

  it('reads every page, keeps the deposits only, imports them once and refuses others', async () => {
    const { chair, accountant, member } = await connected();
    expect((await call('GET', '/api/payments/statements/bank', { cookie: accountant.cookie })).json).toMatchObject({ available: false });
    const started = await call('POST', '/api/bank/oauth/start', { cookie: chair.cookie, body: {} });
    const state = new URL(started.json.authorizeUrl as string).searchParams.get('state')!;
    expect((await call('POST', '/api/bank/oauth/complete', { cookie: chair.cookie, body: { state, code: 'synthetic-code' } })).status).toBe(200);
    expect((await call('GET', '/api/payments/statements/bank', { cookie: accountant.cookie })).json).toMatchObject({ available: true, message: null });
    expect((await call('GET', '/api/payments/statements/bank', { cookie: member.cookie })).status).toBe(403);
    expect((await call('POST', '/api/payments/statements/bank', { cookie: chair.cookie, body: { dryRun: true, dateFrom: '2026-11-01', dateTo: '2026-11-05' } })).status).toBe(403);

    const day = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    const period = { dateFrom: day(ctx.clock.now - 30 * 86_400_000), dateTo: day(ctx.clock.now) };
    const preview = await call('POST', '/api/payments/statements/bank', { cookie: accountant.cookie, body: { dryRun: true, ...period } });
    expect(preview.status).toBe(200);
    expect(preview.json.counts).toEqual({ new: 2, duplicate: 0, withdrawal: 1, unreadable: 0 });
    expect(preview.json.account).toEqual({ branchName: '合成支店', accountTypeName: '普通預金', accountNumberLast4: '4321' });
    expect(preview.body).not.toContain('7654321');
    const reads = bankCalls.filter((c) => c.url.includes('/accounts/transactions?'));
    expect(reads.map((c) => new URL(c.url).searchParams.get('nextItemKey'))).toEqual([null, '20261102000000000001']);
    expect(new URL(reads[0]!.url).searchParams.get('dateFrom')).toBe(period.dateFrom);
    expect((await call('POST', '/api/payments/statements/bank', { cookie: accountant.cookie, body: { dryRun: true, dateFrom: period.dateFrom, dateTo: day(ctx.clock.now + 2 * 86_400_000) } })).status).toBe(422);

    expect((await call('POST', '/api/payments/statements/bank', { cookie: accountant.cookie, body: { dryRun: false, ...period, planToken: '0'.repeat(64) } })).status).toBe(409);
    const done = await call('POST', '/api/payments/statements/bank', { cookie: accountant.cookie, body: { dryRun: false, ...period, planToken: preview.json.planToken } });
    expect(done.status).toBe(200);
    expect(done.json.counts.new).toBe(2);
    const again = await call('POST', '/api/payments/statements/bank', { cookie: accountant.cookie, body: { dryRun: true, ...period } });
    expect(again.json.counts).toEqual({ new: 0, duplicate: 2, withdrawal: 1, unreadable: 0 });
    const overview = await call('GET', '/api/payments/overview', { cookie: accountant.cookie });
    expect(overview.body).toContain('ゴウセイイリョウホウジン');
    expect(overview.body).not.toContain('振込手数料');
  });

  it('checks the period and says why the bank cannot be read', async () => {
    const { accountant } = await connected();
    expect((await call('POST', '/api/payments/statements/bank', { cookie: accountant.cookie, body: { dryRun: true, dateFrom: '2026-11-01', dateTo: '2026-11-05' } })).json).toMatchObject({ error: 'bank_unavailable' });
    expect((await call('POST', '/api/payments/statements/bank', { cookie: accountant.cookie, body: { dryRun: true, dateFrom: '2026-11-05', dateTo: '2026-11-01' } })).status).toBe(409);
  });
});
