import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { signedHeaders } from '../../src/server/tasks/signing.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, GUILD, MEMBER, PASSWORD, register, setup } from './helpers.js';

// The Discord login inside the common app, over HTTP on loopback (no reverse proxy in tests).

let dir: string;
let ctx: ReturnType<typeof setup>;
let rental: RentalStore;
let app: FastifyInstance;
const ORIGIN = `http://${TEST_HOST}`;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-discord-http-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [MEMBER]: '合成 太郎' } }));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>common</title>');
  ctx = setup();
  rental = new RentalStore(path.join(dir, 'rental'));
  const mail = await seedState();
  app = await buildApp({
    store: new StateStore({ ...mail, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), audit: ctx.audit, publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    rental: { store: rental, itemOrigin: null, webDir: null },
  });
});
afterEach(async () => {
  await app.close();
  rental.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { body?: unknown; cookie?: string; csrf?: boolean; headers?: Record<string, string> } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN } : {}),
      ...(method !== 'GET' && options.csrf !== false ? { 'x-smm-csrf': '1' } : {}),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, headers: res.headers, json: json as any, body: res.body };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

describe('committee card HTTP flow', () => {
  async function issued() {
    const member = await register(ctx, MEMBER, '21112222');
    const admin = await register(ctx, CHAIR, '21113333');
    const memberCookie = `__Host-iy_session=${member.sessionToken}`;
    const adminCookie = `__Host-iy_session=${admin.sessionToken}`;
    const enrolled = await call('POST', '/api/auth/cards/device', { cookie: memberCookie, body: { label: '合成スマホ' } });
    expect(enrolled.status).toBe(200);
    const deviceCookie = cookieOf(enrolled.headers['set-cookie']);
    expect(String(enrolled.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect(String(enrolled.headers['set-cookie'])).toMatch(/Secure/);
    expect(String(enrolled.headers['set-cookie'])).toMatch(/SameSite=Strict/);
    const card = await call('POST', '/api/auth/cards/issue', { cookie: adminCookie, body: { account: member.initialLoginId, label: '委員 太郎' } });
    expect(card.status).toBe(200);
    return { memberCookie, adminCookie, deviceCookie, id: card.json.id as string, token: String(card.json.url).split('#')[1]!, url: card.json.url as string };
  }
  it('issues, activates, signs in, resolves identity, and stops the resulting session', async () => {
    const c = await issued();
    expect(c.url.startsWith(ORIGIN + '/card#')).toBe(true);
    expect((await call('POST', '/api/auth/cards/login', { cookie: c.deviceCookie, body: { token: c.token } })).status).toBe(401);
    expect((await call('POST', '/api/auth/cards/activate', { cookie: c.adminCookie, body: { id: c.id } })).status).toBe(200);
    const login = await call('POST', '/api/auth/cards/login', { cookie: c.deviceCookie, body: { token: c.token } });
    expect(login.status).toBe(200);
    expect(login.headers['cache-control']).toContain('no-store');
    const cookie = cookieOf(login.headers['set-cookie']);
    expect((await call('GET', '/api/session', { cookie })).json.user.displayName).toBe('合成 太郎');
    const settings = await call('GET', '/api/auth/cards', { cookie: `${c.memberCookie}; ${c.deviceCookie}` });
    expect(settings.json.deviceRegistered).toBe(true);
    expect(settings.body).not.toContain(c.token);
    expect(settings.body).not.toContain('tokenHash');
    expect((await call('POST', '/api/auth/cards/revoke', { cookie: c.memberCookie, body: { id: c.id } })).status).toBe(200);
    expect((await call('GET', '/api/session', { cookie })).json.user).toBeNull();
  });
  it('requires a device cookie and never grants card access to a raw IDm or an unknown browser', async () => {
    const c = await issued();
    await call('POST', '/api/auth/cards/activate', { cookie: c.adminCookie, body: { id: c.id } });
    expect((await call('POST', '/api/auth/cards/login', { body: { token: c.token } })).json.error).toBe('device_required');
    expect((await call('POST', '/api/auth/cards/login', { cookie: c.deviceCookie, body: { token: '0123456789ABCDEF' } })).status).toBe(400);
    expect((await call('POST', '/api/auth/cards/login', { cookie: `${c.deviceCookie}; ${c.deviceCookie}`, body: { token: c.token } })).json.error).toBe('device_required');
  });
  it('keeps CSRF, origin, query, and admin boundaries on card operations', async () => {
    const c = await issued();
    expect((await call('POST', '/api/auth/cards/device', { cookie: c.memberCookie, body: { label: '端末' }, csrf: false })).status).toBe(403);
    expect((await call('POST', '/api/auth/cards/login', { cookie: c.deviceCookie, body: { token: c.token }, headers: { origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await call('POST', '/api/auth/cards/login?token=forbidden', { body: { token: c.token } })).status).toBe(400);
    expect((await call('GET', '/api/auth/cards')).status).toBe(401);
    expect((await call('POST', '/api/auth/cards/issue', { cookie: c.memberCookie, body: { account: 'iy-00000001', label: '不許可' } })).status).toBe(403);
    expect((await call('POST', '/api/auth/cards/activate', { cookie: c.memberCookie, body: { id: c.id } })).status).toBe(403);
  });
  it('requires explicit confirmation before switching an already signed-in account', async () => {
    const c = await issued();
    await call('POST', '/api/auth/cards/activate', { cookie: c.adminCookie, body: { id: c.id } });
    const cookie = `${c.adminCookie}; ${c.deviceCookie}`;
    expect((await call('POST', '/api/auth/cards/login', { cookie, body: { token: c.token } })).json.error).toBe('account_switch');
    expect((await call('GET', '/api/session', { cookie: c.adminCookie })).json.user).not.toBeNull();
    expect((await call('POST', '/api/auth/cards/login', { cookie, body: { token: c.token, switchAccount: true } })).status).toBe(200);
    expect((await call('GET', '/api/session', { cookie: c.adminCookie })).json.user).toBeNull();
  });
  it('does not turn a card sign-in into recent password confirmation for mail', async () => {
    const c = await issued();
    await call('POST', '/api/auth/cards/activate', { cookie: c.adminCookie, body: { id: c.id } });
    const login = await call('POST', '/api/auth/cards/login', { cookie: c.deviceCookie, body: { token: c.token } });
    const cookie = cookieOf(login.headers['set-cookie']);
    const token = cookie.split('=')[1]!;
    expect((await ctx.service.authenticate(token)).passwordAt).toBe(0);
    expect((await call('POST', '/api/auth/cards/device', { cookie, body: { label: '新端末' } })).status).toBe(403);
    expect((await call('POST', '/api/auth/reauth', { cookie, body: { password: PASSWORD } })).status).toBe(200);
  });
  it('serves the phone entry without caching, with no referrer and no token in HTML', async () => {
    const response = await call('GET', '/card');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('sign-in over HTTP', () => {
  it('signs in with the student ID, keeps the cookie for 14 days and shows the roster name', async () => {
    await register(ctx, MEMBER, '21123456');
    expect((await call('GET', '/api/session')).json).toMatchObject({ authMode: 'discord', user: null, sessionDays: 14 });
    expect((await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: PASSWORD }, csrf: false })).status).toBe(403);
    const login = await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: PASSWORD } });
    expect(login.status).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('__Host-iy_session=');
    expect(setCookie).toContain('Max-Age=1209600');
    expect(setCookie).toMatch(/HttpOnly/i);
    const session = await call('GET', '/api/session', { cookie: cookieOf(login.headers['set-cookie']) });
    expect(session.json).toMatchObject({ user: { displayName: '合成 太郎', roleLabel: '委員' }, account: { studentId: '21123456' }, degraded: false });
    expect((await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: 'not the password 0' } })).status).toBe(401);
  });

  it('tells the person at sign-in about wrong passwords since the previous one', async () => {
    await register(ctx, MEMBER, '21123456');
    expect((await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: 'not the password 0' } })).status).toBe(401);
    const login = await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: PASSWORD } });
    expect(login.json.signIn).toEqual({ previousLoginAt: new Date(ctx.clock.now).toISOString(), failedSince: 1 });
    const session = await call('GET', '/api/session', { cookie: cookieOf(login.headers['set-cookie']) });
    expect(session.json.account.signIn).toEqual(login.json.signIn);
  });

  it('refuses a client after ten failed sign-ins in fifteen minutes, even with the right password', async () => {
    await register(ctx, MEMBER, '21123456');
    for (let i = 0; i < 10; i += 1) expect((await call('POST', '/api/auth/login', { body: { loginId: `2999999${i}`, password: 'not the password 0' } })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: PASSWORD } })).status).toBe(429);
    expect(ctx.audit.recent(0, 1)[0]).toMatchObject({ kind: 'login_blocked', reason: 'client_limit', loginId: '21123456' });
  });

  it('opens the common screen at /register and /login', async () => {
    for (const url of ['/register', '/login']) expect((await call('GET', url)).body).toContain('<title>common</title>');
  });
});

describe('registration code issued by the Bot host', () => {
  const issue = (body: Record<string, unknown>, key = ctx.config.bridgeKey, nonce?: string) => {
    const text = JSON.stringify(body);
    const headers = signedHeaders(key, { client: 'iyakusai-bot', method: 'POST', path: '/v1/registration/issue', body: text, actor: '' });
    if (nonce) headers['x-svc-nonce'] = nonce;
    return app.inject({ method: 'POST', url: '/v1/registration/issue', headers: { host: TEST_HOST, 'content-type': 'application/json', ...headers }, payload: text });
  };

  it('accepts only a signed, fresh request, then the code completes registration', async () => {
    ctx.host.join(MEMBER);
    const body = { guildId: GUILD, discordUserId: MEMBER, source: 'authenticated_discord_self_interaction', interactionId: '1000000000000009001' };
    const unsigned = await app.inject({ method: 'POST', url: '/v1/registration/issue', headers: { host: TEST_HOST, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(unsigned.statusCode).toBe(401);
    expect((await issue(body, Buffer.alloc(32, 7))).statusCode).toBe(401);
    const first = await issue(body);
    expect(first.statusCode).toBe(200);
    const { initialLoginId } = first.json() as { initialLoginId: string };
    const register = await call('POST', '/api/auth/register', { body: { initialLoginId, code: ctx.host.lastCode(), studentId: '21123456', password: PASSWORD } });
    expect(register.status).toBe(200);
    expect(String(register.headers['set-cookie'])).toContain('__Host-iy_session=');
  });
});

describe('sign-in records for access administrators', () => {
  it('show every account and the failures, to administrators only', async () => {
    // The log window (14 days) is counted from the real time.
    ctx.clock.now = Date.now();
    await register(ctx, CHAIR, '20000001');
    await register(ctx, MEMBER, '21123456');
    await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: 'not the password 0' } });
    const chairCookie = cookieOf((await call('POST', '/api/auth/login', { body: { loginId: '20000001', password: PASSWORD } })).headers['set-cookie']);
    const memberCookie = cookieOf((await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: PASSWORD } })).headers['set-cookie']);
    expect((await call('GET', '/api/auth/admin/activity')).status).toBe(401);
    expect((await call('GET', '/api/auth/admin/activity', { cookie: memberCookie })).status).toBe(403);
    const activity = await call('GET', '/api/auth/admin/activity', { cookie: chairCookie });
    expect(activity.status).toBe(200);
    expect(activity.json.accounts.map((a: { initialLoginId: string; status: string }) => [a.initialLoginId, a.status])).toEqual([
      ['iy-00000001', 'active'],
      ['iy-00000002', 'active'],
    ]);
    expect(activity.json.accounts[1]).toMatchObject({ name: '合成 太郎', studentId: '21123456', failedSinceLogin: 0, failures24h: 0, limited: false });
    expect(activity.json.events).toContainEqual(expect.objectContaining({ kind: 'login_failed', reason: 'wrong_password', loginId: '21123456', account: 'iy-00000002', name: '合成 太郎' }));
    expect(activity.json.limits).toEqual({ accountTriesPer10Min: 5, accountFailuresPerDay: 15, clientFailures: 10, clientWindowMinutes: 15 });
    expect(activity.body).not.toContain(PASSWORD);
  });
});

describe('bulk issue of registration codes', () => {
  const DAY = 86_400_000;
  const bulk = (body: Record<string, unknown>, key = ctx.config.bridgeKey) => {
    const text = JSON.stringify(body);
    const headers = signedHeaders(key, { client: 'iyakusai-bot', method: 'POST', path: '/v1/registration/bulk-issue', body: text, actor: '' });
    return app.inject({ method: 'POST', url: '/v1/registration/bulk-issue', headers: { host: TEST_HOST, 'content-type': 'application/json', ...headers }, payload: text });
  };
  const body = (dryRun: boolean) => ({ guildId: GUILD, discordUserId: MEMBER, source: 'committee_bulk_issue', expiresAt: ctx.clock.now + 4 * DAY, dryRun });

  it('is closed unless the configured window is open', async () => {
    ctx.host.join(MEMBER);
    expect((await bulk(body(false))).statusCode).toBe(401);
    ctx.config.bulkRegistrationUntil = Date.now() - 1;
    expect((await bulk(body(false))).statusCode).toBe(401);
  });

  it('accepts only signed requests, skips registered people and returns a code that completes registration', async () => {
    ctx.config.bulkRegistrationUntil = Date.now() + 3_600_000;
    await register(ctx, CHAIR, '20000001');
    ctx.host.join(MEMBER);
    const unsigned = await app.inject({ method: 'POST', url: '/v1/registration/bulk-issue', headers: { host: TEST_HOST, 'content-type': 'application/json' }, payload: JSON.stringify(body(false)) });
    expect(unsigned.statusCode).toBe(401);
    expect((await bulk(body(false), Buffer.alloc(32, 7))).statusCode).toBe(401);
    expect((await bulk({ ...body(false), source: 'authenticated_discord_self_interaction' })).statusCode).toBe(401);
    expect((await bulk({ ...body(false), discordUserId: CHAIR })).json()).toEqual({ status: 'skipped', reason: 'active' });
    expect((await bulk(body(true))).json()).toEqual({ status: 'would_issue' });
    const issued = (await bulk(body(false))).json() as { status: string; initialLoginId: string; code: string };
    expect(issued.status).toBe('issued');
    const registered = await call('POST', '/api/auth/register', { body: { initialLoginId: issued.initialLoginId, code: issued.code, studentId: '21123456', password: PASSWORD } });
    expect(registered.status).toBe(200);
  });
});

describe('rental permissions with Discord accounts', () => {
  it('are granted by the chair and used under the account real name', async () => {
    await register(ctx, CHAIR, '20000001');
    const member = await register(ctx, MEMBER, '21123456');
    const chairCookie = cookieOf((await call('POST', '/api/auth/login', { body: { loginId: '20000001', password: PASSWORD } })).headers['set-cookie']);
    const memberCookie = cookieOf((await call('POST', '/api/auth/login', { body: { loginId: '21123456', password: PASSWORD } })).headers['set-cookie']);
    expect((await call('GET', '/api/rental/borrowers', { cookie: memberCookie })).status).toBe(403);
    expect((await call('PUT', `/api/rental/admin/permissions/${member.initialLoginId}`, { cookie: memberCookie, body: { permissions: ['rental.loan'] } })).status).toBe(403);
    const granted = await call('PUT', `/api/rental/admin/permissions/${member.initialLoginId}`, { cookie: chairCookie, body: { permissions: ['rental.loan'] } });
    expect(granted.json).toEqual({ userId: member.initialLoginId, permissions: ['rental.loan'] });
    const me = await call('GET', '/api/rental/me', { cookie: memberCookie });
    expect(me.json).toMatchObject({ staff: { id: member.initialLoginId, name: '合成 太郎' }, permissions: ['rental.loan'] });
  });
});
