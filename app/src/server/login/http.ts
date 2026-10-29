import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import type { ApiError, SessionUser } from '../../shared/api.js';
import { parsePublicOrigin } from '../auth.js';
import { CHALLENGE_ID_PATTERN, type LoginService } from './service.js';

// LOCAL HTTP HARNESS for the login core (PREPARATION). It is deliberately not
// registered by buildApp or src/server/main.ts and has no CLI/env entry point:
// tests drive it with app.inject only. It shows the proposed cookie, Host,
// Origin, CSRF and cache rules around LoginService.

export const LOGIN_COOKIE = '__Host-smm_login';
export const LOGIN_SESSION_COOKIE = '__Host-smm_session';
/** Custom header a cross-site form or simple request cannot send without a CORS preflight. */
export const CSRF_HEADER = 'x-smm-login';

export const LOGIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface LoginHarnessOptions {
  service: LoginService;
  /** Canonical https origin (validated like SMM_PUBLIC_ORIGIN). */
  publicOrigin: string;
  /** Operator-defined client rate key from trusted transport context (e.g. the socket). Never a browser header. */
  clientKey: (request: FastifyRequest) => string | null;
  /** Presents the existing internal principal; role/permissions come only from here. */
  presentPrincipal: (principalId: string) => SessionUser | null;
}

const challengeBody = z.strictObject({ email: z.string().max(320) });
const resendBody = z.strictObject({ challengeId: z.string().regex(CHALLENGE_ID_PATTERN) });
const verifyBody = z.strictObject({ challengeId: z.string().regex(CHALLENGE_ID_PATTERN), code: z.string().max(16) });
const emptyBody = z.strictObject({});

const COOKIE_BASE = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } as const;

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

const failure = (error: string, message: string): ApiError => ({ error, message });
const LOGIN_FAILED = failure('login_failed', 'コードが正しくないか、有効期限が切れています。最初からやり直してください。');
const RATE_LIMITED = failure('rate_limited', '要求が多すぎます。しばらく待ってから再試行してください。');
const UNAVAILABLE = failure('unavailable', '現在ログインを受け付けられません。しばらく待ってから再試行してください。');
const ACCEPTED_MESSAGE = '登録済みで条件を満たす場合は、連携済みの Discord アカウントへ Bot から DM でコードを送ります。';

export async function buildLoginHarness(options: LoginHarnessOptions): Promise<FastifyInstance> {
  const { origin, host } = parsePublicOrigin(options.publicOrigin);
  const { service } = options;
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 });
  await app.register(cookie);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Content-Security-Policy', LOGIN_CSP);
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    const hosts = rawHeaderValues(request, 'host');
    if (hosts.length !== 1 || hosts[0]!.toLowerCase() !== host) return reply.code(421).send(failure('invalid_host', '公開用ホスト名以外への要求は受け付けません。'));
    // Codes, secrets and tokens never travel in URLs.
    if (request.url.includes('?')) return reply.code(400).send(failure('invalid_request', 'クエリ文字列は受け付けません。'));
    const origins = rawHeaderValues(request, 'origin');
    const sites = rawHeaderValues(request, 'sec-fetch-site');
    const sameSite = sites.length === 0 || (sites.length === 1 && sites[0] === 'same-origin');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (origins.length !== 1 || origins[0] !== origin || !sameSite || rawHeaderValues(request, CSRF_HEADER).join() !== '1') {
        return reply.code(403).send(failure('forbidden', '公開オリジン以外からの変更要求は受け付けません。'));
      }
    } else if ((origins.length > 0 && (origins.length !== 1 || origins[0] !== origin)) || !(sameSite || (sites.length === 1 && sites[0] === 'none'))) {
      return reply.code(403).send(failure('forbidden', '別オリジンからの要求は受け付けません。'));
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status === 415 ? 415 : 400).send(failure('invalid_request', 'リクエストの形式が正しくありません。'));
    return reply.code(500).send(failure('internal', 'サーバー内部でエラーが発生しました。'));
  });

  const parse = <T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null => {
    const result = schema.safeParse(body ?? {});
    if (result.success) return result.data;
    void reply.code(400).send(failure('invalid_request', 'リクエストの形式が正しくありません。'));
    return null;
  };

  const accepted = (reply: FastifyReply, challengeId: string, expiresInSeconds: number) =>
    reply.code(202).send({ status: 'accepted', challengeId, expiresInSeconds, message: ACCEPTED_MESSAGE });

  app.post('/api/login/challenge', async (request, reply) => {
    const body = parse(challengeBody, request.body, reply);
    if (!body) return reply;
    const outcome = service.requestChallenge({ email: body.email, clientKey: options.clientKey(request) });
    if (!outcome.ok) {
      if (outcome.error === 'invalid_request') return reply.code(400).send(failure('invalid_request', 'メールアドレスの形式が正しくありません。'));
      return outcome.error === 'rate_limited' ? reply.code(429).send(RATE_LIMITED) : reply.code(503).send(UNAVAILABLE);
    }
    // The browser-binding secret goes only into an HttpOnly cookie, never into JSON.
    reply.setCookie(LOGIN_COOKIE, outcome.browserSecret, { ...COOKIE_BASE, maxAge: service.policy.challengeLifetimeMs / 1000 });
    return accepted(reply, outcome.challengeId, outcome.expiresInSeconds);
  });

  app.post('/api/login/resend', async (request, reply) => {
    const body = parse(resendBody, request.body, reply);
    if (!body) return reply;
    const outcome = service.resend({ challengeId: body.challengeId, browserSecret: singleCookie(request, LOGIN_COOKIE) ?? '', clientKey: options.clientKey(request) });
    if (!outcome.ok) return outcome.error === 'rate_limited' ? reply.code(429).send(RATE_LIMITED) : reply.code(401).send(LOGIN_FAILED);
    return accepted(reply, outcome.challengeId, outcome.expiresInSeconds);
  });

  app.post('/api/login/verify', async (request, reply) => {
    const body = parse(verifyBody, request.body, reply);
    if (!body) return reply;
    const outcome = await service.verify({
      challengeId: body.challengeId,
      browserSecret: singleCookie(request, LOGIN_COOKIE) ?? '',
      code: body.code,
      clientKey: options.clientKey(request),
      priorSessionToken: singleCookie(request, LOGIN_SESSION_COOKIE),
    });
    if (!outcome.ok) {
      if (outcome.error === 'rate_limited') return reply.code(429).send(RATE_LIMITED);
      return outcome.error === 'unavailable' ? reply.code(503).send(UNAVAILABLE) : reply.code(401).send(LOGIN_FAILED);
    }
    const user = options.presentPrincipal(outcome.principalId);
    if (!user) {
      service.logout(outcome.sessionToken);
      return reply.code(401).send(LOGIN_FAILED);
    }
    reply.clearCookie(LOGIN_COOKIE, COOKIE_BASE);
    reply.setCookie(LOGIN_SESSION_COOKIE, outcome.sessionToken, { ...COOKIE_BASE, maxAge: service.policy.sessionAbsoluteMs / 1000 });
    return reply.code(200).send({ user });
  });

  app.get('/api/login/session', async (request, reply) => {
    const session = await service.authenticate(singleCookie(request, LOGIN_SESSION_COOKIE));
    const user = session ? options.presentPrincipal(session.principalId) : null;
    if (!user) {
      reply.clearCookie(LOGIN_SESSION_COOKIE, COOKIE_BASE);
      return reply.code(401).send(failure('unauthenticated', 'ログインしていません。'));
    }
    return { user };
  });

  app.post('/api/login/logout', async (request, reply) => {
    if (!parse(emptyBody, request.body, reply)) return reply;
    service.logout(singleCookie(request, LOGIN_SESSION_COOKIE));
    reply.clearCookie(LOGIN_SESSION_COOKIE, COOKIE_BASE);
    reply.clearCookie(LOGIN_COOKIE, COOKIE_BASE);
    return { ok: true };
  });

  app.all('/*', async (_request, reply) => reply.code(404).send(failure('not_found', '見つかりません。')));
  return app;
}
