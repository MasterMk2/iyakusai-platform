import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, parseAuthMode } from '../../src/server/auth.js';
import { SAMPLE_USERS } from '../../src/server/connector/fixtures.js';
import { buildLoginHarness, CSRF_HEADER, LOGIN_COOKIE, LOGIN_CSP, LOGIN_SESSION_COOKIE } from '../../src/server/login/http.js';
import type { SessionUser } from '../../src/shared/api.js';
import { makeApp, makeProxyApp } from '../helpers.js';
import { LOGIN_HOST, LOGIN_ORIGIN, makeLogin, P, type LoginFixture } from '../login-fixtures.js';

// Injected-provider HTTP boundary tests for the local login harness. The Bot is a
// synthetic capture sink; nothing here is a Discord or directory integration.

const CLIENT_IP = '192.0.2.10';

const present = (principalId: string): SessionUser | null => {
  const u = SAMPLE_USERS.find((x) => x.id === principalId && !x.disabled);
  return u ? { id: u.id, displayName: u.displayName, roleLabel: u.roleLabel, canManageAccess: u.canManageAccess } : null;
};

type Method = 'GET' | 'POST';
interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  raw: string;
  headers: Record<string, unknown>;
  cookies: Map<string, string>;
  setCookie: string[];
}

let f: LoginFixture;
let app: FastifyInstance;

beforeEach(async () => {
  f = makeLogin();
  app = await buildLoginHarness({
    service: f.service,
    publicOrigin: LOGIN_ORIGIN,
    // Operator-defined trusted transport context: the socket address, never a header.
    clientKey: (request) => request.raw.socket.remoteAddress ?? null,
    presentPrincipal: present,
  });
});

async function call(method: Method, url: string, body?: unknown, headers: Record<string, string | null> = {}, remoteAddress = CLIENT_IP): Promise<Res> {
  const merged: Record<string, string | null> = {
    host: LOGIN_HOST,
    ...(method === 'POST' ? { origin: LOGIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: '1' } : {}),
    ...headers,
  };
  const res = await app.inject({
    method,
    url,
    remoteAddress,
    headers: Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== null)),
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  const raw = res.headers['set-cookie'];
  const setCookie = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  const cookies = new Map(setCookie.map((c) => [c.split('=')[0]!, c.split(';')[0]!.slice(c.indexOf('=') + 1)]));
  let json: unknown;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers, cookies, setCookie };
}

async function challenge(email: string, remote = CLIENT_IP) {
  const res = await call('POST', '/api/login/challenge', { email }, {}, remote);
  await f.service.idle();
  return { res, challengeId: res.json?.challengeId as string, secret: res.cookies.get(LOGIN_COOKIE) ?? '', code: f.sent.at(-1)?.code ?? '' };
}

async function signIn(email = P.editorA.email) {
  const c = await challenge(email);
  const res = await call('POST', '/api/login/verify', { challengeId: c.challengeId, code: c.code }, { cookie: `${LOGIN_COOKIE}=${c.secret}` });
  return { c, res, token: res.cookies.get(LOGIN_SESSION_COOKIE) ?? '' };
}

describe('login harness is not wired into the application', () => {
  it('demo and trusted-proxy apps do not expose login routes, and no new auth mode is accepted', async () => {
    const demo = await makeApp();
    expect((await demo.call(null, 'POST', '/api/login/challenge', { email: P.editorA.email })).status).toBe(404);
    const proxy = await makeProxyApp();
    expect((await proxy.call(null, 'POST', '/api/login/challenge', { email: P.editorA.email }, { 'x-mail-user': null })).status).toBe(401);
    expect((await proxy.call('admin@idp.example', 'POST', '/api/login/challenge', { email: P.editorA.email })).status).toBe(404);
    expect(() => parseAuthMode({ SMM_AUTH_MODE: 'group-discord' })).toThrow(ConfigError);
  });

  it('refuses a non-canonical or non-https public origin', async () => {
    for (const origin of ['http://login.example.invalid', 'https://login.example.invalid/', 'https://127.0.0.1']) {
      await expect(buildLoginHarness({ service: f.service, publicOrigin: origin, clientKey: () => 'x', presentPrincipal: present })).rejects.toThrow(ConfigError);
    }
  });
});

describe('challenge request', () => {
  it('keeps the browser secret in a __Host- Secure HttpOnly SameSite=Strict cookie only', async () => {
    const { res, secret } = await challenge(P.editorA.email);
    expect(res.status).toBe(202);
    expect(Object.keys(res.json).sort()).toEqual(['challengeId', 'expiresInSeconds', 'message', 'status']);
    expect(res.json.challengeId).toMatch(/^lc_[0-9a-f]{32}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.raw).not.toContain(secret);
    const cookie = res.setCookie.find((c) => c.startsWith(`${LOGIN_COOKIE}=`))!;
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).toContain('; Secure');
    expect(cookie).toContain('; HttpOnly');
    expect(cookie).toContain('; SameSite=Strict');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe(LOGIN_CSP);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('answers identically for members, unknown, unverified, non-member and rate-capped targets', async () => {
    f.dir.updateLink(P.viewerB.linkId, { emailVerified: false });
    f.dir.members.delete(P.admin.memberKey);
    const signature = (r: Res) =>
      JSON.stringify([r.status, Object.keys(r.json).sort(), r.json.status, r.json.expiresInSeconds, r.json.message, [...r.cookies.keys()], r.headers['content-type'], r.headers['cache-control']]);
    const seen = new Set<string>();
    for (const email of [P.editorA.email, 'nobody@staff.invalid', P.viewerB.email, P.admin.email, P.editorA.email]) seen.add(signature((await challenge(email)).res));
    expect(seen.size).toBe(1);
    // Only the eligible member received a DM; the repeat was target-rate-capped silently.
    expect(f.sent.map((e) => e.recipient.discordUserId)).toEqual([P.editorA.discordUserId]);
  });

  it('rejects browser-supplied destination, role, group or verified flags', async () => {
    for (const extra of [{ discordUserId: P.viewerB.discordUserId }, { role: 'admin' }, { groupId: 'grp-other' }, { verified: true }, { principalId: P.admin.principalId }]) {
      const res = await call('POST', '/api/login/challenge', { email: P.editorA.email, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    await f.service.idle();
    expect(f.sent).toHaveLength(0);
  });

  it('applies the client limit from the socket, not from forwarded headers', async () => {
    for (let i = 0; i < 10; i += 1) expect((await call('POST', '/api/login/challenge', { email: `n${i}@staff.invalid` }, { 'x-forwarded-for': `198.51.100.${i}` })).status).toBe(202);
    const limited = await call('POST', '/api/login/challenge', { email: 'other@staff.invalid' }, { 'x-forwarded-for': '198.51.100.200', forwarded: 'for=198.51.100.201' });
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('rate_limited');
    expect((await call('POST', '/api/login/challenge', { email: 'other@staff.invalid' }, {}, '192.0.2.11')).status).toBe(202);
    await f.service.idle();
  });
});

describe('request gate', () => {
  it('rejects wrong Host, foreign or missing Origin, missing CSRF header, cross-site fetch and query strings', async () => {
    const body = { email: P.editorA.email };
    const cases: [Record<string, string | null>, number][] = [
      [{ host: 'evil.example.invalid' }, 421],
      [{ host: `${LOGIN_HOST}:8443` }, 421],
      [{ origin: null }, 403],
      [{ origin: 'https://evil.example.invalid' }, 403],
      [{ origin: 'http://login.example.invalid' }, 403],
      [{ origin: 'null' }, 403],
      [{ [CSRF_HEADER]: null }, 403],
      [{ [CSRF_HEADER]: '0' }, 403],
      [{ 'sec-fetch-site': 'cross-site' }, 403],
      [{ 'sec-fetch-site': 'same-site' }, 403],
    ];
    for (const [headers, status] of cases) {
      const res = await call('POST', '/api/login/challenge', body, headers);
      expect(res.status, JSON.stringify(headers)).toBe(status);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.cookies.size).toBe(0);
    }
    expect((await call('POST', '/api/login/challenge?email=x', body)).status).toBe(400);
    expect((await call('GET', '/api/login/session', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call('GET', '/api/login/session', undefined, { origin: 'https://evil.example.invalid' })).status).toBe(403);
    const form = await app.inject({ method: 'POST', url: '/api/login/challenge', headers: { host: LOGIN_HOST, origin: LOGIN_ORIGIN, [CSRF_HEADER]: '1', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'email=a%40b.invalid' });
    expect(form.statusCode).toBeGreaterThanOrEqual(400);
    await f.service.idle();
    expect(f.sent).toHaveLength(0);
  });
});

describe('verification and session', () => {
  it('logs in with the code from the same browser and takes the role from the internal principal', async () => {
    const { res, token } = await signIn(P.viewerB.email);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ user: present(P.viewerB.principalId) });
    expect(res.json.user.canManageAccess).toBe(false);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.raw).not.toContain(token);
    const cookie = res.setCookie.find((c) => c.startsWith(`${LOGIN_SESSION_COOKIE}=`))!;
    for (const attr of ['; Secure', '; HttpOnly', '; SameSite=Strict', '; Path=/']) expect(cookie).toContain(attr);
    // The browser-binding cookie is cleared after use.
    expect(res.setCookie.some((c) => c.startsWith(`${LOGIN_COOKIE}=;`))).toBe(true);
    const session = await call('GET', '/api/login/session', undefined, { cookie: `${LOGIN_SESSION_COOKIE}=${token}` });
    expect(session.status).toBe(200);
    expect(session.json.user.id).toBe(P.viewerB.principalId);
  });

  it('an administrator role comes only from the internal principal, never from group membership', async () => {
    f.dir.members.set(P.editorA.memberKey, {});
    const editor = await signIn(P.editorA.email);
    expect(editor.res.json.user.canManageAccess).toBe(false);
    const admin = await signIn(P.admin.email);
    expect(admin.res.json.user.canManageAccess).toBe(true);
  });

  it('the victim code cannot be used from another browser, without the binding cookie, or twice', async () => {
    const victim = await challenge(P.editorA.email);
    const attacker = await challenge('nobody@staff.invalid', '192.0.2.66');
    const tries: Record<string, string | null>[] = [{ cookie: `${LOGIN_COOKIE}=${attacker.secret}` }, { cookie: null }, { cookie: `${LOGIN_COOKIE}=${victim.secret}; ${LOGIN_COOKIE}=${attacker.secret}` }];
    for (const headers of tries) {
      const res = await call('POST', '/api/login/verify', { challengeId: victim.challengeId, code: victim.code }, headers, '192.0.2.66');
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.json).toEqual({ error: 'login_failed', message: expect.any(String) });
      expect(res.cookies.has(LOGIN_SESSION_COOKIE)).toBe(false);
    }
    const ok = await call('POST', '/api/login/verify', { challengeId: victim.challengeId, code: victim.code }, { cookie: `${LOGIN_COOKIE}=${victim.secret}` });
    expect(ok.status).toBe(200);
    const replay = await call('POST', '/api/login/verify', { challengeId: victim.challengeId, code: victim.code }, { cookie: `${LOGIN_COOKIE}=${victim.secret}` });
    expect(replay.status).toBe(401);
  });

  it('denies session fixation: a planted session cookie is never adopted and is replaced at login', async () => {
    const planted = 'A'.repeat(43);
    const c = await challenge(P.editorA.email);
    const res = await call('POST', '/api/login/verify', { challengeId: c.challengeId, code: c.code }, { cookie: `${LOGIN_COOKIE}=${c.secret}; ${LOGIN_SESSION_COOKIE}=${planted}` });
    expect(res.status).toBe(200);
    expect(res.cookies.get(LOGIN_SESSION_COOKIE)).not.toBe(planted);
    expect((await call('GET', '/api/login/session', undefined, { cookie: `${LOGIN_SESSION_COOKIE}=${planted}` })).status).toBe(401);
  });

  it('logout revokes the session server-side; duplicate session cookies are denied', async () => {
    const { token } = await signIn();
    const other = await signIn(P.viewerB.email);
    expect((await call('GET', '/api/login/session', undefined, { cookie: `${LOGIN_SESSION_COOKIE}=${token}; ${LOGIN_SESSION_COOKIE}=${other.token}` })).status).toBe(401);
    const out = await call('POST', '/api/login/logout', {}, { cookie: `${LOGIN_SESSION_COOKIE}=${token}` });
    expect(out.status).toBe(200);
    expect(out.setCookie.some((c) => c.startsWith(`${LOGIN_SESSION_COOKIE}=;`))).toBe(true);
    expect((await call('GET', '/api/login/session', undefined, { cookie: `${LOGIN_SESSION_COOKIE}=${token}` })).status).toBe(401);
    expect((await call('GET', '/api/login/session', undefined, { cookie: `${LOGIN_SESSION_COOKIE}=${other.token}` })).status).toBe(200);
  });

  it('removing the member revokes the session on the next request', async () => {
    const { token } = await signIn();
    f.dir.members.delete(P.editorA.memberKey);
    const res = await call('GET', '/api/login/session', undefined, { cookie: `${LOGIN_SESSION_COOKIE}=${token}` });
    expect(res.status).toBe(401);
    expect(res.setCookie.some((c) => c.startsWith(`${LOGIN_SESSION_COOKIE}=;`))).toBe(true);
    f.dir.members.set(P.editorA.memberKey, {});
    expect((await call('GET', '/api/login/session', undefined, { cookie: `${LOGIN_SESSION_COOKIE}=${token}` })).status).toBe(401);
  });

  it('resend requires the same browser and keeps the response shape', async () => {
    const c = await challenge(P.editorA.email);
    expect((await call('POST', '/api/login/resend', { challengeId: c.challengeId })).status).toBe(401);
    f.clock.advance(60_000);
    const res = await call('POST', '/api/login/resend', { challengeId: c.challengeId }, { cookie: `${LOGIN_COOKIE}=${c.secret}` });
    expect(res.status).toBe(202);
    expect(Object.keys(res.json).sort()).toEqual(['challengeId', 'expiresInSeconds', 'message', 'status']);
    await f.service.idle();
    expect(f.sent).toHaveLength(2);
  });

  it('never places codes, secrets or tokens in any response body, header or audit event', async () => {
    const { c, res, token } = await signIn();
    const everything = JSON.stringify([res.json, c.res.json, f.audit]);
    for (const secret of [c.code, c.secret, token]) expect(everything).not.toContain(secret);
    expect(JSON.stringify(f.audit)).not.toContain(CLIENT_IP);
  });
});
