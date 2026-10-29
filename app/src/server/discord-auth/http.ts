import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DiscordSessionResponse, LoginActivityResponse, SessionUser, SignInSummary } from '../../shared/api.js';
import { normalizeAddress } from '../auth.js';
import type { User } from '../domain/types.js';
import { KdfBusyError, PASSWORD_POLICY } from '../login/password.js';
import { loggableLoginId, type LoginAudit } from './audit.js';
import { attachRegistrationIssuer, BULK_ISSUER_PATH, ISSUER_PATH } from './bot-host.js';
import type { DiscordAuthConfig } from './config.js';
import type { NameRoster } from './names.js';
import { ACCOUNT_FAILURES_PER_DAY, ACCOUNT_TRIES_PER_10_MIN, AccountError, type AccountIdentity, type DiscordAccountService, type SessionIdentity, type SignInRecord } from './service.js';
import type { AccountStore } from './store.js';
import { CardAuthError, DEVICE_DAYS } from './cards.js';
import { staffRouteAllowed, temporaryStaffName } from './temporary-staff.js';

// Browser side of the Discord account login: transport gate, session cookie, and the sign-in,
// registration and account routes. Same gate as the account mode (trusted reverse proxy, public Host,
// same-origin writes with the X-SMM-CSRF header), except the signed server-to-server route
// /v1/registration/issue, which the Bot host calls without a browser Origin.

export const SESSION_COOKIE = '__Host-iy_session';
export const CARD_DEVICE_COOKIE = '__Host-iy_card_device';
const CSRF_HEADER = 'x-smm-csrf';
const COOKIE = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } as const;
/** Failed sign-ins, and failed registrations, per client address in a 15-minute window. */
export const CLIENT_FAILURES = 10;
export const CLIENT_WINDOW_MS = 15 * 60_000;
/** Sign-in log shown to access administrators. */
const ACTIVITY_DAYS = 14;
const ACTIVITY_EVENTS = 500;

export interface DiscordAuthRuntime {
  service: DiscordAccountService;
  store: AccountStore;
  config: DiscordAuthConfig;
  names: NameRoster;
  /** Sign-in log (the same one the service writes); none in tests that do not look at it. */
  audit?: LoginAudit;
  /** null only in tests on loopback. */
  publicOrigin: string | null;
  publicHost: string | null;
  trustedProxies: ReadonlySet<string>;
}

interface Deps {
  listenPort: number;
  isAllowedLoopbackHost: (host: string | undefined, port: number) => boolean;
  sessionUser: (user: User) => SessionUser;
  /** Further signed server-to-server routes (no browser Origin), each verified by its own handler. */
  serverToServerPaths?: readonly string[];
}

const fail = (error: string, message: string) => ({ error, message });
const REJECTED = fail('unauthenticated', 'ログインID（学籍番号）・パスワード・登録コードのいずれかが正しくないか、いまは利用できない状態です。');
const RATE_LIMITED = fail('rate_limited', '試行が続いたため、しばらく待ってから再試行してください。');
const UNAVAILABLE = fail('unavailable', 'Discord との確認ができませんでした。しばらくしてから再試行してください。');
const STUDENT_ID_TAKEN = fail('conflict', 'この学籍番号は別のアカウントで使われています。番号を確かめるか、委員会のシステム担当に連絡してください。');
const STUDENT_ID_REQUIRED = fail('validation', '学籍番号を入力してください（委員会の名簿にあなたの学籍番号が見つかりませんでした）。');

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const raw = request.raw.rawHeaders;
  const values: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!);
  return values;
}

function singleCookie(request: FastifyRequest, name: string): string | null {
  const found = rawHeaderValues(request, 'cookie')
    .flatMap((h) => h.split(';'))
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`));
  return found.length === 1 ? found[0]!.slice(name.length + 1) : null;
}

const isApi = (request: FastifyRequest) => (request.url.split('?')[0] ?? '').startsWith('/api/');

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof CardAuthError) {
    const messages = {
      card_rejected: 'この委員カードは使えません。未有効化・期限切れ・停止済みの可能性があります。パスワードでログインするか、発行担当に確認してください。',
      device_required: 'このブラウザでは、初回の本人確認が必要です。パスワードでログインし、設定の「委員カード」でこの端末を登録してから、もう一度カードにタッチしてください。',
      account_switch: '別のアカウントでログイン中です。入力中の内容を保存してから、カードのアカウントに切り替えてください。',
      card_forbidden: '設定を変更するには、パスワードを入力して本人確認してください。カードの発行・有効化は共通システムの権限管理者が行います。',
      card_limit: '登録数の上限です。使わないカード・端末を停止してから、もう一度登録してください。',
    };
    return reply.code(err.code === 'account_switch' ? 409 : err.code === 'card_rejected' ? 401 : 403).send(fail(err.code, messages[err.code]));
  }
  if (err instanceof KdfBusyError) return reply.code(503).send(fail('unavailable', '現在受け付けられません。しばらくしてから再試行してください。'));
  if (err instanceof AccountError) {
    if (err.code === 'RATE_LIMITED') return reply.code(429).send(RATE_LIMITED);
    if (err.code === 'DEPENDENCY_UNAVAILABLE') return reply.code(503).send(UNAVAILABLE);
    if (err.code === 'STUDENT_ID_TAKEN') return reply.code(409).send(STUDENT_ID_TAKEN);
    if (err.code === 'STUDENT_ID_REQUIRED') return reply.code(400).send(STUDENT_ID_REQUIRED);
    return reply.code(401).send(REJECTED);
  }
  throw err;
}

const loginBody = z.strictObject({ loginId: z.string().min(1).max(64), password: z.string().min(1).max(1024) });
const registerBody = z.strictObject({ initialLoginId: z.string().max(16), code: z.string().max(16), password: z.string().max(1024), studentId: z.string().max(32) });
const passwordBody = z.strictObject({ currentPassword: z.string().max(1024), newPassword: z.string().max(1024) });
const studentIdBody = z.strictObject({ password: z.string().max(1024), studentId: z.string().max(32) });
const reauthBody = z.strictObject({ password: z.string().min(1).max(1024) });
const logoutBody = z.strictObject({ everywhere: z.boolean().optional() });

/** Per-client attempt limit for sign-in and registration (memory only; per-account limits are stored). */
class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  allow(key: string | null, now = Date.now()): boolean {
    const k = key ?? 'unknown';
    const recent = (this.hits.get(k) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) return false;
    recent.push(now);
    this.hits.set(k, recent);
    if (this.hits.size > 4096) this.hits.clear();
    return true;
  }
}

/** Failures per client (memory only): refused once `limit` failures fall within the window. */
class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  private recent(k: string, now: number): number[] {
    return (this.hits.get(k) ?? []).filter((t) => t > now - this.windowMs);
  }
  blocked(key: string | null, now = Date.now()): boolean {
    return this.recent(key ?? 'unknown', now).length >= this.limit;
  }
  fail(key: string | null, now = Date.now()): void {
    const k = key ?? 'unknown';
    const recent = this.recent(k, now);
    recent.push(now);
    this.hits.set(k, recent);
    if (this.hits.size > 4096) this.hits.clear();
  }
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const summary = (r: SignInRecord): SignInSummary => ({ previousLoginAt: iso(r.previousLoginAt), failedSince: r.failedSince });

export function installDiscordAuth(app: FastifyInstance, rt: DiscordAuthRuntime, deps: Deps) {
  const users = new WeakMap<FastifyRequest, { user: User; identity: SessionIdentity }>();
  const limiter = new AttemptLimiter(20, 60_000);
  const loginFailures = new FailureLimiter(CLIENT_FAILURES, CLIENT_WINDOW_MS);
  const registerFailures = new FailureLimiter(CLIENT_FAILURES, CLIENT_WINDOW_MS);
  const rejected = (err: unknown) => err instanceof AccountError && err.code === 'REJECTED';
  const production = rt.publicOrigin !== null;

  const expectedOrigin = (request: FastifyRequest) => rt.publicOrigin ?? `http://${request.headers.host ?? ''}`;

  function clientKey(request: FastifyRequest): string | null {
    if (!production) return normalizeAddress(request.raw.socket.remoteAddress);
    const forwarded = rawHeaderValues(request, 'x-forwarded-for');
    return forwarded.length === 1 ? normalizeAddress(forwarded[0]!.split(',').at(-1)?.trim()) : null;
  }

  function toUser(identity: AccountIdentity | Omit<AccountIdentity, 'degraded'>): User {
    const name = rt.names.nameOf(identity.discordUserId);
    return {
      id: identity.initialLoginId,
      displayName: identity.temporaryStaff ? temporaryStaffName(identity.studentId) : name ?? identity.studentId ?? identity.initialLoginId,
      roleLabel: identity.departments.join('・') || '委員',
      email: '',
      canManageAccess: identity.admin,
    };
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
    // Server-to-server and signed: no browser Origin, verified by the issuer itself.
    if ((path === ISSUER_PATH || path === BULK_ISSUER_PATH || (deps.serverToServerPaths ?? []).includes(path)) && request.method === 'POST') return;
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
    if (path.startsWith('/api/auth/') && request.url.includes('?')) return reply.code(400).send(fail('invalid_request', 'クエリ文字列は受け付けません。'));
  });

  // ---- session resolution (server-side only)
  app.addHook('preHandler', async (request, reply) => {
    // The matched route, so the temporary staff allow-list below compares route patterns, not raw URLs.
    if (!(request.routeOptions.url ?? '').startsWith('/api/')) return;
    const token = singleCookie(request, SESSION_COOKIE);
    if (!token) return;
    try {
      const identity = await rt.service.authenticate(token);
      users.set(request, { user: toUser(identity), identity });
      if (identity.temporaryStaff && !staffRouteAllowed(request.method, request.routeOptions.url)) {
        return reply.code(403).header('Cache-Control', 'no-store').send(fail('forbidden', 'このアカウントは物品の貸出・返却・随時チェック専用です。'));
      }
    } catch (err) {
      // The Bot host is unreachable beyond the grace period: say so instead of pretending to be signed out.
      if (err instanceof AccountError && err.code === 'DEPENDENCY_UNAVAILABLE' && (request.url.split('?')[0] ?? '') !== '/api/session') return reply.code(503).send(UNAVAILABLE);
    }
  });

  const sessionResponse = (request: FastifyRequest): DiscordSessionResponse => {
    const current = users.get(request);
    return {
      demoAuthentication: false,
      authMode: 'discord',
      user: current ? deps.sessionUser(current.user) : null,
      account: current
        ? { initialLoginId: current.identity.initialLoginId, studentId: current.identity.studentId, temporaryStaff: current.identity.temporaryStaff === true, departments: current.identity.departments, signIn: summary(current.identity.signIn) }
        : null,
      degraded: current?.identity.degraded ?? false,
      passwordPolicy: { minLength: PASSWORD_POLICY.minLength, maxLength: PASSWORD_POLICY.maxLength },
      sessionDays: rt.config.sessionDays,
    };
  };

  const setSession = (reply: FastifyReply, token: string) => reply.setCookie(SESSION_COOKIE, token, { ...COOKIE, maxAge: Math.floor(rt.service.sessionLifetimeMs / 1000) });

  app.get('/api/session', async (request, reply) => {
    if (!users.get(request) && singleCookie(request, SESSION_COOKIE)) reply.clearCookie(SESSION_COOKIE, COOKIE);
    return sessionResponse(request);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(fail('invalid_request', 'ログインIDとパスワードを入力してください。'));
    const client = clientKey(request);
    if (!limiter.allow(client)) return reply.code(429).send(RATE_LIMITED);
    if (loginFailures.blocked(client)) {
      rt.audit?.record({ at: Date.now(), kind: 'login_blocked', loginId: loggableLoginId(body.data.loginId), account: null, client, reason: 'client_limit' });
      return reply.code(429).send(RATE_LIMITED);
    }
    try {
      const { sessionToken, ...signIn } = await rt.service.login({ ...body.data, client });
      setSession(reply, sessionToken);
      return { ok: true, signIn: summary(signIn) };
    } catch (err) {
      if (rejected(err)) loginFailures.fail(client);
      return sendError(reply, err);
    }
  });

  app.post('/api/auth/register', async (request, reply) => {
    const body = registerBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(fail('invalid_request', '入力の形式が正しくないか、長すぎます。'));
    const client = clientKey(request);
    if (!limiter.allow(client)) return reply.code(429).send(RATE_LIMITED);
    if (registerFailures.blocked(client)) {
      rt.audit?.record({ at: Date.now(), kind: 'register_blocked', loginId: loggableLoginId(body.data.initialLoginId), account: null, client, reason: 'client_limit' });
      return reply.code(429).send(RATE_LIMITED);
    }
    try {
      await rt.service.completeRegistration({ ...body.data, client });
    } catch (err) {
      if (rejected(err)) registerFailures.fail(client);
      return sendError(reply, err);
    }
    try {
      const { sessionToken, ...signIn } = await rt.service.login({ loginId: body.data.initialLoginId, password: body.data.password, client });
      setSession(reply, sessionToken);
      return { ok: true, signIn: summary(signIn) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  const requireToken = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const token = singleCookie(request, SESSION_COOKIE);
    if (!token || !users.get(request)) {
      void reply.code(401).send(fail('unauthenticated', 'ログインしてください。'));
      return null;
    }
    return token;
  };

  const proof = z.string().min(1).max(1024).optional();
  const cardId = z.string().regex(/^[a-f0-9]{32}$/);
  app.get('/api/auth/cards', async (request, reply) => {
    const token = requireToken(request, reply);
    if (!token) return reply;
    try {
      const result = await rt.service.loginCardSettings(token, singleCookie(request, CARD_DEVICE_COOKIE));
      result.people = result.people.map(p => ({ ...p, name: rt.names.nameOf(rt.service.identityByLoginId(p.account)!.discordUserId) ?? p.name }));
      return result;
    } catch (err) { return sendError(reply, err); }
  });
  const cardAction = (path: string, schema: z.ZodType, action: (body: Record<string, string | undefined>, request: FastifyRequest, reply: FastifyReply, token: string) => Promise<unknown>) => {
    app.post(path, async (request, reply) => {
      const body = schema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send(fail('invalid_request', '入力内容を確認してください。'));
      const token = requireToken(request, reply);
      if (!token) return reply;
      if (!limiter.allow(clientKey(request))) return reply.code(429).send(RATE_LIMITED);
      try { return await action(body.data as Record<string, string | undefined>, request, reply, token); }
      catch (err) { return sendError(reply, err); }
    });
  };
  cardAction('/api/auth/cards/device', z.strictObject({ label: z.string().trim().min(1).max(80), password: proof }), async (body, request, reply, token) => {
    const secret = await rt.service.registerCardDevice(token, singleCookie(request, CARD_DEVICE_COOKIE), body.label!, body.password);
    reply.setCookie(CARD_DEVICE_COOKIE, secret, { ...COOKIE, maxAge: DEVICE_DAYS * 86400 });
    return { ok: true };
  });
  cardAction('/api/auth/cards/issue', z.strictObject({ account: z.string().regex(/^iy-\d{8}$/), label: z.string().trim().min(1).max(80), password: proof }), async (body, request, _reply, token) => {
    const result = await rt.service.issueLoginCard(token, body.account!, body.label!, body.password);
    return { id: result.id, url: `${expectedOrigin(request)}/card#${result.secret}` };
  });
  cardAction('/api/auth/cards/activate', z.strictObject({ id: cardId, password: proof }), async (body, _request, _reply, token) => {
    await rt.service.activateLoginCard(token, body.id!, body.password);
    return { ok: true };
  });
  cardAction('/api/auth/cards/revoke', z.strictObject({ id: cardId }), async (body, _request, _reply, token) => {
    await rt.service.revokeLoginCard(token, body.id!);
    return { ok: true };
  });
  cardAction('/api/auth/cards/device/revoke', z.strictObject({ id: cardId }), async (body, _request, _reply, token) => {
    await rt.service.revokeCardDevice(token, body.id!);
    return { ok: true };
  });
  app.post('/api/auth/cards/login', async (request, reply) => {
    const body = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), switchAccount: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(fail('invalid_request', '委員カードを読み直してください。'));
    const client = clientKey(request);
    if (!limiter.allow(client) || loginFailures.blocked(client)) return reply.code(429).send(RATE_LIMITED);
    try {
      const result = await rt.service.loginWithCard(body.data.token, singleCookie(request, CARD_DEVICE_COOKIE), singleCookie(request, SESSION_COOKIE), body.data.switchAccount);
      setSession(reply, result.sessionToken);
      return { ok: true };
    } catch (err) {
      if (err instanceof CardAuthError && err.code === 'card_rejected') loginFailures.fail(client);
      return sendError(reply, err);
    }
  });

  app.post('/api/auth/password', async (request, reply) => {
    const body = passwordBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(fail('invalid_request', '入力の形式が正しくないか、長すぎます。'));
    const token = requireToken(request, reply);
    if (!token) return reply;
    try {
      const { sessionToken } = await rt.service.changePassword({ sessionToken: token, ...body.data, client: clientKey(request) });
      setSession(reply, sessionToken);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The password typed again on this device (asked by the mail screens after a period without use).
  app.post('/api/auth/reauth', async (request, reply) => {
    const body = reauthBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(fail('invalid_request', 'パスワードを入力してください。'));
    const token = requireToken(request, reply);
    if (!token) return reply;
    try {
      const { sessionToken } = await rt.service.reauthenticate({ sessionToken: token, password: body.data.password, client: clientKey(request) });
      setSession(reply, sessionToken);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/auth/student-id', async (request, reply) => {
    const body = studentIdBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(fail('invalid_request', '入力の形式が正しくないか、長すぎます。'));
    const token = requireToken(request, reply);
    if (!token) return reply;
    try {
      await rt.service.setStudentId({ sessionToken: token, ...body.data, client: clientKey(request) });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const body = logoutBody.safeParse(request.body ?? {});
    const token = singleCookie(request, SESSION_COOKIE);
    if (token) await rt.service.logout(token, body.success && body.data.everywhere === true);
    reply.clearCookie(SESSION_COOKIE, COOKIE);
    return { ok: true };
  });

  // Access administrators look into sign-ins: every account's record and the sign-in log (no secrets).
  app.get('/api/auth/admin/activity', async (request, reply) => {
    const current = users.get(request);
    if (!current) return reply.code(401).send(fail('unauthenticated', 'ログインしてください。'));
    if (!current.identity.admin) return reply.code(403).send(fail('forbidden', 'ログインの記録は権限管理者だけが見られます。'));
    const activity = rt.service.accountActivity();
    const nameOf = new Map(activity.map((a) => [a.initialLoginId, rt.names.nameOf(a.discordUserId)]));
    const now = Date.now();
    const response: LoginActivityResponse = {
      accounts: activity
        .map((a) => ({
          initialLoginId: a.initialLoginId,
          name: nameOf.get(a.initialLoginId) ?? null,
          studentId: a.studentId,
          status: a.status,
          lastLoginAt: iso(a.lastLoginAt),
          failedSinceLogin: a.failedSinceLogin,
          failures24h: a.failures24h,
          limited: a.limited,
          pendingCode: a.pendingCode ? { expiresAt: iso(a.pendingCode.expiresAt)!, bulk: a.pendingCode.bulk, attempts: a.pendingCode.attempts } : null,
          sessions: a.sessions,
        }))
        .sort((x, y) => x.initialLoginId.localeCompare(y.initialLoginId)),
      events: (rt.audit?.recent(now - ACTIVITY_DAYS * 86_400_000, ACTIVITY_EVENTS) ?? []).map((e) => ({
        at: iso(e.at)!,
        kind: e.kind,
        loginId: e.loginId,
        account: e.account,
        name: e.account ? (nameOf.get(e.account) ?? null) : null,
        client: e.client,
        reason: e.reason ?? null,
      })),
      days: ACTIVITY_DAYS,
      limits: {
        accountTriesPer10Min: ACCOUNT_TRIES_PER_10_MIN,
        accountFailuresPerDay: ACCOUNT_FAILURES_PER_DAY,
        clientFailures: CLIENT_FAILURES,
        clientWindowMinutes: CLIENT_WINDOW_MS / 60_000,
      },
    };
    return response;
  });

  attachRegistrationIssuer(app, { service: rt.service, store: rt.store, config: rt.config });

  return {
    currentUser: (request: FastifyRequest): User | null => users.get(request)?.user ?? null,
    /** This request's sign-in (session key, password time, Discord ID); server-side only. */
    currentSession: (request: FastifyRequest): SessionIdentity | null => users.get(request)?.identity ?? null,
    /** Discord ID of an active account, from stored data (never for authorization by itself). */
    discordUserIdOf: (initialLoginId: string): string | null => {
      const identity = rt.service.identityByLoginId(initialLoginId);
      return identity && !identity.temporaryStaff ? identity.discordUserId : null;
    },
    /** Accounts that can sign in now, for choosing people (grants); never for authorization. */
    listUsers: (): User[] => rt.service.listActiveIdentities().map(toUser),
    /** For showing who acted (rental permissions screen); never for authorization. */
    lookupUser: (initialLoginId: string): User | undefined => {
      const identity = rt.service.identityByLoginId(initialLoginId);
      return identity ? toUser(identity) : undefined;
    },
    /** The roster name of an active account and nothing else: unlike `lookupUser` it never falls back to the student ID or login ID (Bot data source). */
    rosterNameOf: (initialLoginId: string): string | null => {
      const identity = rt.service.identityByLoginId(initialLoginId);
      return identity ? rt.names.nameOf(identity.discordUserId) : null;
    },
    /** Task actor of the IyakusaiBot task API: discord-<Discord user ID>. */
    taskUserFor: (initialLoginId: string): string | null => {
      const identity = rt.service.identityByLoginId(initialLoginId);
      return identity && !identity.temporaryStaff ? `discord-${identity.discordUserId}` : null;
    },
  };
}
