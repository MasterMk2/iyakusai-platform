import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountSessionResponse, ApiError, SessionUser } from '../../shared/api.js';
import { normalizeAddress } from '../auth.js';
import type { User } from '../domain/types.js';
import { verifiedCommitteeReader } from '../domain/shared-mail-policy.js';
import { PASSWORD_POLICY, type PasswordPolicyError } from '../login/password.js';
import { CHALLENGE_ID_PATTERN, type LoginService } from '../login/service.js';
import type { MockAccountProviders } from './mock-providers.js';

// Account authentication for the common Web entry (SMM_AUTH_MODE=account / account-mock).
//  - First use and recovery: email -> DM code to the verified Discord binding -> one-time grant ->
//    the person sets their own password. Normal use: email + password. Logout revokes.
//  - Identity is only the server-side session; no browser header names a user, source or role.
//  - Every write needs the exact public Origin and the custom CSRF header (no CORS is offered).
//  - Production: requests only via the allowlisted reverse proxy, exact public Host, Secure
//    __Host- cookies. Mock: loopback only, synthetic providers, plus clearly labelled /api/mock/*.

export const ACCOUNT_COOKIES = {
  session: '__Host-smm_session',
  challenge: '__Host-smm_challenge',
  setup: '__Host-smm_setup',
} as const;
export const CSRF_HEADER = 'x-smm-csrf';

export interface AccountRuntime {
  service: LoginService;
  composition: 'production' | 'mock';
  /** Production: canonical https origin. Mock: null (the loopback Host decides). */
  publicOrigin: string | null;
  publicHost: string | null;
  trustedProxies: ReadonlySet<string>;
  mock: MockAccountProviders | null;
}

export interface AccountDeps {
  listenPort: number;
  isAllowedLoopbackHost: (host: string | undefined, port: number) => boolean;
  lookupUser: (principalId: string) => User | undefined;
  sessionUser: (user: User) => SessionUser;
}

const COOKIE = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } as const;

const emailBody = z.strictObject({ email: z.string().max(320) });
const resendBody = z.strictObject({ challengeId: z.string().regex(CHALLENGE_ID_PATTERN) });
const verifyBody = z.strictObject({ challengeId: z.string().regex(CHALLENGE_ID_PATTERN), code: z.string().max(16) });
// Oversized input is rejected outright (never truncated); the policy check then applies exact limits.
const passwordField = z.string().max(PASSWORD_POLICY.maxLength * 4);
const setupBody = z.strictObject({ password: passwordField, confirmation: passwordField });
const loginBody = z.strictObject({ email: z.string().max(320), password: passwordField });
const emptyBody = z.strictObject({});
const mockActionBody = z.strictObject({
  principalId: z.string().regex(/^[a-z0-9-]{1,40}$/),
  action: z.enum(['remove_membership', 'restore_membership', 'unresolve_membership', 'disable', 'enable', 'replace_binding', 'dm_closed', 'dm_open']),
});

const fail = (error: string, message: string): ApiError => ({ error, message });
const RATE_LIMITED = fail('rate_limited', '要求が多すぎます。しばらく待ってから再試行してください。');
const UNAVAILABLE = fail('unavailable', '現在ログインを受け付けられません。しばらく待ってから再試行してください。');
const CODE_FAILED = fail('code_failed', 'コードが正しくないか、有効期限が切れています。新しいコードを申請してください。');
const SETUP_FAILED = fail('setup_failed', 'パスワード設定の有効期限が切れたか、本人確認を続けられませんでした。最初からやり直してください。');
const LOGIN_FAILED = fail('login_failed', 'メールアドレスまたはパスワードが正しくないか、現在ログインできない状態です。');
const ACCEPTED_MESSAGE =
  '登録済みで利用条件を満たす場合は、連携済みの Discord アカウントへ Bot から DM で確認コードを送ります。届かない場合は、しばらく待ってから再送してください。';
const POLICY_MESSAGES: Record<PasswordPolicyError, string> = {
  too_short: `パスワードは ${PASSWORD_POLICY.minLength} 文字以上にしてください。`,
  too_long: `パスワードは ${PASSWORD_POLICY.maxLength} 文字以内にしてください（切り詰めずに拒否します）。`,
  control_characters: 'パスワードに制御文字は使えません。',
  contains_email: 'パスワードにメールアドレスを含めないでください。',
};

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const raw = request.raw.rawHeaders;
  const values: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!);
  return values;
}

/** Exactly one occurrence of the cookie, or null (duplicates are ambiguous and denied). */
function singleCookie(request: FastifyRequest, name: string): string | null {
  const found = rawHeaderValues(request, 'cookie')
    .flatMap((h) => h.split(';'))
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`))
    .map((p) => p.slice(name.length + 1));
  return found.length === 1 ? found[0]! : null;
}

const isApi = (request: FastifyRequest) => (request.url.split('?')[0] ?? '').startsWith('/api/') || (request.routeOptions.url ?? '').startsWith('/api/');

export function installAccount(app: FastifyInstance, rt: AccountRuntime, deps: AccountDeps): { currentUser: (request: FastifyRequest) => User | null } {
  const { service } = rt;
  const users = new WeakMap<FastifyRequest, User>();
  const production = rt.composition === 'production';

  function expectedOrigin(request: FastifyRequest): string {
    return rt.publicOrigin ?? `http://${request.headers.host ?? ''}`;
  }

  /** Rate-limit key from trusted transport only: the proxy-appended client address, or the loopback socket. */
  function clientKey(request: FastifyRequest): string | null {
    if (!production) return normalizeAddress(request.raw.socket.remoteAddress);
    const forwarded = rawHeaderValues(request, 'x-forwarded-for');
    if (forwarded.length !== 1) return null;
    const last = forwarded[0]!.split(',').at(-1)?.trim();
    return normalizeAddress(last);
  }

  // ---- gate: transport, Host, Origin and CSRF (before any handler or body parsing)
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (production) {
      const remote = normalizeAddress(request.raw.socket.remoteAddress);
      const trusted = remote !== null && rt.trustedProxies.has(remote);
      if (path === '/api/health' && (request.method === 'GET' || request.method === 'HEAD') && (trusted || remote === '127.0.0.1' || remote === '::1')) return;
      if (!trusted) return reply.code(403).send(fail('untrusted_proxy', '許可されたリバースプロキシを経由しない要求は受け付けません。'));
      const hosts = rawHeaderValues(request, 'host');
      if (hosts.length !== 1 || hosts[0]!.toLowerCase() !== rt.publicHost) return reply.code(421).send(fail('invalid_host', '公開用ホスト名以外への要求は受け付けません。'));
    } else if (!deps.isAllowedLoopbackHost(request.headers.host, deps.listenPort)) {
      return reply.code(421).send(fail('invalid_host', 'ループバックのホスト名以外からの要求は受け付けません。'));
    }
    const origins = rawHeaderValues(request, 'origin');
    const sites = rawHeaderValues(request, 'sec-fetch-site');
    const originOk = origins.length === 1 && origins[0] === expectedOrigin(request);
    const siteIs = (...allowed: string[]) => sites.length === 0 || (sites.length === 1 && allowed.includes(sites[0]!));
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!originOk || !siteIs('same-origin') || (isApi(request) && rawHeaderValues(request, CSRF_HEADER).join() !== '1')) {
        return reply.code(403).send(fail('forbidden', '公開オリジン以外からの変更要求は受け付けません。'));
      }
    } else if (isApi(request) && ((origins.length > 0 && !originOk) || !siteIs('same-origin', 'none'))) {
      return reply.code(403).send(fail('forbidden', '別オリジンからの API 要求は受け付けません。'));
    }
    // Codes, secrets and passwords never travel in URLs.
    if (path.startsWith('/api/auth/') && request.url.includes('?')) return reply.code(400).send(fail('invalid_request', 'クエリ文字列は受け付けません。'));
  });

  // ---- session resolution (server-side only)
  app.addHook('preHandler', async (request) => {
    if (!isApi(request)) return;
    const token = singleCookie(request, ACCOUNT_COOKIES.session);
    if (!token) return;
    const session = await service.authenticate(token);
    const user = session ? deps.lookupUser(session.principalId) : undefined;
    if (user && !user.disabled) users.set(request, verifiedCommitteeReader(user));
  });

  const parse = <T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null => {
    const result = schema.safeParse(body ?? {});
    if (result.success) return result.data;
    void reply.code(400).send(fail('invalid_request', '入力の形式が正しくないか、長すぎます。'));
    return null;
  };

  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(ACCOUNT_COOKIES.session, token, { ...COOKIE, maxAge: service.policy.sessionAbsoluteMs / 1000 });

  const sessionResponse = (user: User | null): AccountSessionResponse => ({
    demoAuthentication: false,
    authMode: 'account',
    composition: rt.composition,
    user: user ? deps.sessionUser(user) : null,
    passwordPolicy: { minLength: PASSWORD_POLICY.minLength, maxLength: PASSWORD_POLICY.maxLength },
  });

  app.get('/api/session', async (request, reply) => {
    const user = users.get(request) ?? null;
    if (!user && singleCookie(request, ACCOUNT_COOKIES.session)) reply.clearCookie(ACCOUNT_COOKIES.session, COOKIE);
    return sessionResponse(user);
  });

  // ---- first use / recovery through the verified binding
  app.post('/api/auth/setup/request', async (request, reply) => {
    const body = parse(emailBody, request.body, reply);
    if (!body) return reply;
    const outcome = service.requestChallenge({ email: body.email, clientKey: clientKey(request), purpose: 'password_setup' });
    if (!outcome.ok) {
      if (outcome.error === 'invalid_request') return reply.code(400).send(fail('invalid_request', 'メールアドレスの形式が正しくありません。'));
      return outcome.error === 'rate_limited' ? reply.code(429).send(RATE_LIMITED) : reply.code(503).send(UNAVAILABLE);
    }
    reply.setCookie(ACCOUNT_COOKIES.challenge, outcome.browserSecret, { ...COOKIE, maxAge: service.policy.challengeLifetimeMs / 1000 });
    return reply.code(202).send({ status: 'accepted', challengeId: outcome.challengeId, expiresInSeconds: outcome.expiresInSeconds, message: ACCEPTED_MESSAGE });
  });

  app.post('/api/auth/setup/resend', async (request, reply) => {
    const body = parse(resendBody, request.body, reply);
    if (!body) return reply;
    const outcome = service.resend({ challengeId: body.challengeId, browserSecret: singleCookie(request, ACCOUNT_COOKIES.challenge) ?? '', clientKey: clientKey(request) });
    if (!outcome.ok) return outcome.error === 'rate_limited' ? reply.code(429).send(RATE_LIMITED) : reply.code(401).send(CODE_FAILED);
    return reply.code(202).send({ status: 'accepted', challengeId: outcome.challengeId, expiresInSeconds: outcome.expiresInSeconds, message: ACCEPTED_MESSAGE });
  });

  app.post('/api/auth/setup/verify', async (request, reply) => {
    const body = parse(verifyBody, request.body, reply);
    if (!body) return reply;
    const outcome = await service.verifySetupCode({
      challengeId: body.challengeId,
      browserSecret: singleCookie(request, ACCOUNT_COOKIES.challenge) ?? '',
      code: body.code,
      clientKey: clientKey(request),
    });
    if (!outcome.ok) {
      if (outcome.error === 'rate_limited') return reply.code(429).send(RATE_LIMITED);
      return outcome.error === 'unavailable' ? reply.code(503).send(UNAVAILABLE) : reply.code(401).send(CODE_FAILED);
    }
    reply.clearCookie(ACCOUNT_COOKIES.challenge, COOKIE);
    reply.setCookie(ACCOUNT_COOKIES.setup, outcome.setupToken, { ...COOKIE, maxAge: outcome.expiresInSeconds });
    return { next: 'set_password', hasPassword: outcome.hasPassword, expiresInSeconds: outcome.expiresInSeconds };
  });

  app.post('/api/auth/setup/password', async (request, reply) => {
    const body = parse(setupBody, request.body, reply);
    if (!body) return reply;
    if (body.password !== body.confirmation) return reply.code(400).send(fail('password_mismatch', '確認用のパスワードが一致しません。'));
    const outcome = await service.completePasswordSetup({
      setupToken: singleCookie(request, ACCOUNT_COOKIES.setup) ?? '',
      password: body.password,
      clientKey: clientKey(request),
      priorSessionToken: singleCookie(request, ACCOUNT_COOKIES.session),
    });
    if (!outcome.ok) {
      if (outcome.error === 'policy') return reply.code(400).send(fail('password_policy', POLICY_MESSAGES[outcome.policy]));
      if (outcome.error === 'rate_limited') return reply.code(429).send(RATE_LIMITED);
      if (outcome.error === 'unavailable') return reply.code(503).send(UNAVAILABLE);
      reply.clearCookie(ACCOUNT_COOKIES.setup, COOKIE);
      return reply.code(401).send(SETUP_FAILED);
    }
    const user = deps.lookupUser(outcome.principalId);
    reply.clearCookie(ACCOUNT_COOKIES.setup, COOKIE);
    if (!user || user.disabled) {
      service.logout(outcome.sessionToken);
      return reply.code(401).send(SETUP_FAILED);
    }
    setSession(reply, outcome.sessionToken);
    return sessionResponse(user);
  });

  // ---- normal login / logout
  app.post('/api/auth/login', async (request, reply) => {
    const body = parse(loginBody, request.body, reply);
    if (!body) return reply;
    const outcome = await service.passwordLogin({ email: body.email, password: body.password, clientKey: clientKey(request), priorSessionToken: singleCookie(request, ACCOUNT_COOKIES.session) });
    if (!outcome.ok) {
      if (outcome.error === 'rate_limited') return reply.code(429).send(RATE_LIMITED);
      return outcome.error === 'unavailable' ? reply.code(503).send(UNAVAILABLE) : reply.code(401).send(LOGIN_FAILED);
    }
    const user = deps.lookupUser(outcome.principalId);
    if (!user || user.disabled) {
      service.logout(outcome.sessionToken);
      return reply.code(401).send(LOGIN_FAILED);
    }
    setSession(reply, outcome.sessionToken);
    return sessionResponse(user);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (!parse(emptyBody, request.body, reply)) return reply;
    service.logout(singleCookie(request, ACCOUNT_COOKIES.session));
    for (const name of Object.values(ACCOUNT_COOKIES)) reply.clearCookie(name, COOKIE);
    return sessionResponse(null);
  });

  // ---- MOCK ONLY: synthetic DM outbox and directory controls (never registered in production)
  if (rt.mock && !production) {
    const mock = rt.mock;
    app.get('/api/mock/dm-outbox', async () => ({ notice: '模擬 DM です。実際の Discord には送信していません。', messages: mock.dmOutbox() }));
    app.get('/api/mock/directory', async () => ({ notice: '合成の本人紐付けと Group 会員です。', people: mock.directory() }));
    app.post('/api/mock/directory', async (request, reply) => {
      const body = parse(mockActionBody, request.body, reply);
      if (!body) return reply;
      const event = mock.apply(body.principalId, body.action);
      const revoked = event ? service.handleDirectoryEvent(event) : { sessions: 0, challenges: 0 };
      return { ok: true, revoked };
    });
  }

  return { currentUser: (request) => users.get(request) ?? null };
}
