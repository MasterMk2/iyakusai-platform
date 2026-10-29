import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { HANDLING_STATUSES, LIMITS, type ApiError, type FaultState, type SessionResponse, type SessionUser } from '../../shared/api.js';
import { installAccount, type AccountRuntime } from '../account/http.js';
import { installDiscordAuth, type DiscordAuthRuntime } from '../discord-auth/http.js';
import { assertMappedUsers, ConfigError, IDENTITY_HEADER, isValidIdentity, normalizeAddress, type AuthConfig, type TrustedProxyAuth } from '../auth.js';
import { MockInboundConnector, type MockConnectorOptions } from '../connector/mock.js';
import type { InboundConnector } from '../connector/types.js';
import { findUser } from '../domain/access.js';
import { syntheticCommitteeReader } from '../domain/shared-mail-policy.js';
import { accessMatrix, auditLog, releaseMockBatch, setGrant } from '../domain/admin.js';
import { getAttachment, getReceipt, getThread, labelFacets, listThreads, mailboxSummaries } from '../domain/queries.js';
import { inboxLabels, listInbox } from '../domain/inbox.js';
import { createSeedState } from '../domain/seed.js';
import type { StateStore } from '../domain/store.js';
import { applyBatches, fetchAll } from '../domain/sync.js';
import { addNote, assigneeCandidates, updateTriage } from '../domain/triage.js';
import { DomainError, type User } from '../domain/types.js';
import { attachBotDatasource, BOT_DATASOURCE_PATH } from '../datasource/bot-datasource.js';
import { INGEST_PATH } from '../mailbox/ingest.js';
import { registerMailboxRoutes, type MailboxRuntime } from '../mailbox/routes.js';
import { attachRentalDriveSync, SYNC_ACK_PATH } from '../rental/drive-sync.js';
import { registerRentalRoutes, type RentalRuntime } from '../rental/routes.js';
import { registerTaskRoutes, type TaskRuntime } from '../tasks/routes.js';
import { registerAssistantRoutes, type AssistantRuntime } from '../assistant/routes.js';
import { HttpError } from './http-error.js';
import { registerLineRoutes, type LineRuntime } from './line-routes.js';

export const SESSION_COOKIE = 'smm_demo_persona';

export interface AppOptions {
  store: StateStore;
  clock?: () => string;
  staticDir?: string | null;
  /** Port the server listens on; the Host header must name a loopback host with exactly this port. */
  listenPort: number;
  /** Test seam: replaces the explicit mock connector (e.g. with a delayed one). */
  createConnector?: (options: MockConnectorOptions) => InboundConnector;
  /** Defaults to the loopback demo persona mode. */
  auth?: AuthConfig;
  /** LINE inbox (mock connector only). Absent: no LINE routes exist. */
  line?: LineRuntime;
  /** Task gateway to the separate Task service. Absent: the task API answers "not configured". */
  tasks?: TaskRuntime | null;
  /** Bot tab (IyakusaiBot). Absent: the assistant API answers ASSISTANT_DISABLED (404). */
  assistant?: AssistantRuntime | null;
  /** Required with auth mode "account": the login service and its composition. */
  account?: AccountRuntime;
  /** Rental ledger and phone screen. Absent: the rental API answers "not configured". */
  rental?: RentalRuntime | null;
  /** Required with auth mode "discord": the Discord account login. */
  discord?: DiscordAuthRuntime;
  /** Discord login only: the committee mailbox (SQLite). Replaces the synthetic inbox routes. */
  mailbox?: MailboxRuntime | null;
  /** Discord login only: key of the Bot's read-only data source (POST /v1/bot/datasource). Absent: the route does not exist. */
  botDatasourceKey?: Buffer | null;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * DNS-rebinding guard: accept only `<loopback name>:<listenPort>`. A hostile
 * name that resolves to 127.0.0.1 still carries its own name in Host and is rejected.
 */
export function isAllowedHost(host: string | undefined, listenPort: number): boolean {
  if (!host) return false;
  const match = /^(\[::1\]|[a-z0-9.]+):(\d{1,5})$/i.exec(host);
  if (!match) return false;
  return LOOPBACK_HOSTNAMES.has(match[1]!.toLowerCase()) && Number(match[2]) === listenPort;
}

const STATUS_CODE: Record<DomainError['code'], number> = {
  not_found: 404,
  forbidden: 403,
  validation: 422,
  conflict: 409,
  unauthenticated: 401,
};

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' http://127.0.0.1:48731",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const idParam = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{16}$`));
const receiptParams = z.strictObject({ receiptId: idParam('rc') });
const threadParams = z.strictObject({ threadId: idParam('th') });
const attachmentParams = z.strictObject({ receiptId: idParam('rc'), attachmentId: z.string().regex(/^att\d{1,2}$/) });
const shortId = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/);

const threadQuery = z.strictObject({
  mailboxId: shortId.optional(),
  q: z.string().max(LIMITS.queryMaxLength).optional(),
  status: z.enum(HANDLING_STATUSES).optional(),
  label: z.string().min(1).max(LIMITS.labelMaxLength).optional(),
  assignee: shortId.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(20),
});

const triageBody = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    status: z.enum(HANDLING_STATUSES).optional(),
    assigneeId: shortId.nullable().optional(),
    labels: z.array(z.string().max(200)).max(50).optional(),
  })
  .refine((b) => b.status !== undefined || b.assigneeId !== undefined || b.labels !== undefined, { message: '変更内容がありません' });

const inboxQuery = z
  .strictObject({
    source: z.enum(['all', 'email', 'line']).default('all'),
    mailboxId: shortId.optional(),
    lineAccountId: shortId.optional(),
    q: z.string().max(LIMITS.queryMaxLength).optional(),
    status: z.enum(HANDLING_STATUSES).optional(),
    label: z.string().min(1).max(LIMITS.labelMaxLength).optional(),
    assignee: shortId.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(20),
  })
  .refine((q) => q.mailboxId === undefined || q.lineAccountId === undefined, { message: '受信箱と LINE アカウントは同時に指定できません' });
const inboxLabelQuery = z
  .strictObject({ mailboxId: shortId.optional(), lineAccountId: shortId.optional() })
  .refine((q) => q.mailboxId === undefined || q.lineAccountId === undefined, { message: '受信箱と LINE アカウントは同時に指定できません' });

const noteBody = z.strictObject({ body: z.string().max(LIMITS.noteMaxLength * 2) });
const sessionBody = z.strictObject({ userId: shortId });
const grantBody = z.strictObject({
  userId: shortId,
  mailboxId: shortId,
  level: z.enum(['none', 'read', 'edit']),
  expectedVersion: z.number().int().min(1),
});
const syncBody = z.strictObject({ mode: z.enum(['incremental', 'full']).default('incremental') });
const faultBody = z.strictObject({
  failNextRequests: z.number().int().min(0).max(10),
  delayNextRequests: z.number().int().min(0).max(10),
  delayMs: z.number().int().min(0).max(10_000),
  connectorFailMailboxId: shortId.nullable(),
});

class RequestError extends Error {
  readonly details: unknown;
  constructor(details: unknown) {
    super('リクエストの形式が正しくありません。');
    this.details = details;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new RequestError(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return result.data;
}

const NO_FAULT_PATHS = [/^\/api\/health$/, /^\/api\/demo\//, /^\/api\/session$/, /^\/api\/personas$/, /^\/api\/tasks\/context$/];

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const raw = request.raw.rawHeaders;
  const values: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!);
  return values;
}

/**
 * API classification shared by the trusted-proxy gate and the response cache policy.
 * The router decodes percent-escapes, so the matched route (e.g. for /%61pi/...) counts too.
 */
function isApiRequest(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? '';
  return path.startsWith('/api/') || (request.routeOptions.url ?? '').startsWith('/api/');
}

type ProxyCheck = { ok: true; user: User | null } | { ok: false; status: number; body: ApiError };

const reject = (status: number, error: string, message: string): ProxyCheck => ({ ok: false, status, body: { error, message } });

/**
 * Trusted-proxy gate. The socket address (never a forwarded header) must be an
 * allowlisted proxy, Host must be the canonical public host, browser writes must
 * carry the exact public Origin, and exactly one valid identity header must map
 * to an active user. Cookies, X-Forwarded-* and Forwarded are never consulted.
 */
function checkProxyRequest(request: FastifyRequest, proxy: TrustedProxyAuth, lookup: (userId: string) => User | undefined): ProxyCheck {
  const remote = normalizeAddress(request.raw.socket.remoteAddress);
  const trusted = remote !== null && proxy.trustedProxies.has(remote);
  const path = request.url.split('?')[0] ?? '';
  const isApi = isApiRequest(request);
  // Liveness only (body is a constant): allowed from the proxy or a local container probe.
  if (path === '/api/health' && (request.method === 'GET' || request.method === 'HEAD') && (trusted || remote === '127.0.0.1' || remote === '::1')) {
    return { ok: true, user: null };
  }
  if (!trusted) return reject(403, 'untrusted_proxy', '許可されたリバースプロキシを経由しない要求は受け付けません。');

  const hosts = rawHeaderValues(request, 'host');
  if (hosts.length !== 1 || hosts[0]!.toLowerCase() !== proxy.publicHost) {
    return reject(421, 'invalid_host', '公開用ホスト名以外への要求は受け付けません。');
  }

  const origins = rawHeaderValues(request, 'origin');
  const fetchSite = rawHeaderValues(request, 'sec-fetch-site');
  const originOk = origins.length === 1 && origins[0] === proxy.publicOrigin;
  const siteIs = (...allowed: string[]) => fetchSite.length === 0 || (fetchSite.length === 1 && allowed.includes(fetchSite[0]!));
  if (!SAFE_METHODS.includes(request.method)) {
    // Ambient proxy credentials (e.g. Basic auth) are sent cross-site, so every write must prove the public Origin.
    if (!originOk || !siteIs('same-origin')) return reject(403, 'forbidden', '公開オリジン以外からの変更要求は受け付けません。');
  } else if (isApi && ((origins.length > 0 && !originOk) || !siteIs('same-origin', 'none'))) {
    return reject(403, 'forbidden', '別オリジンからの API 要求は受け付けません。');
  }

  // The static client bundle holds no data; serving it lets the UI explain an identity error.
  if (!isApi && (request.method === 'GET' || request.method === 'HEAD')) return { ok: true, user: null };

  const identities = rawHeaderValues(request, IDENTITY_HEADER);
  if (identities.length === 0 || identities.every((v) => v.trim() === '')) {
    return reject(401, 'unauthenticated', 'リバースプロキシで認証された利用者がありません。');
  }
  if (identities.length !== 1 || !isValidIdentity(identities[0]!)) {
    return reject(403, 'invalid_identity', '認証された利用者を一意に特定できません。');
  }
  const userId = proxy.identities.get(identities[0]!);
  const user = userId ? lookup(userId) : undefined;
  if (!user || user.disabled) return reject(403, 'unknown_identity', 'この利用者はアプリに登録されていないか、無効です。');
  return { ok: true, user };
}

const sessionUser = (u: User): SessionUser => ({ id: u.id, displayName: u.displayName, roleLabel: u.roleLabel, canManageAccess: u.canManageAccess });

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store } = options;
  const auth: AuthConfig = options.auth ?? { mode: 'demo' };
  const proxy = auth.mode === 'trusted-proxy' ? auth : null;
  const demo = auth.mode === 'demo';
  // Fail closed: account mode never starts without its login runtime (and never falls back to the demo).
  if (auth.mode === 'account' && (!options.account || options.account.composition !== auth.composition)) {
    throw new ConfigError('account モードのログイン構成がありません。');
  }
  if (auth.mode === 'discord' && !options.discord) throw new ConfigError('discord モードのログイン構成がありません。');
  const mailbox = options.mailbox ?? null;
  if (mailbox && (auth.mode !== 'discord' || options.line)) throw new ConfigError('委員会の受信箱は discord モードでだけ使えます（LINE の模擬受信とは併用できません）。');
  const botDatasourceKey = options.botDatasourceKey ?? null;
  if (botDatasourceKey && auth.mode !== 'discord') throw new ConfigError('Bot のデータソースは discord モードでだけ使えます。');
  let accountApi: ReturnType<typeof installAccount> | null = null;
  let discordApi: ReturnType<typeof installDiscordAuth> | null = null;
  // Refuse to start with a map that names unknown or inactive users.
  if (proxy) assertMappedUsers(proxy.identities, store.current.users);
  const proxyUsers = new WeakMap<FastifyRequest, User>();
  const clock = options.clock ?? (() => new Date().toISOString());
  const faults: FaultState = { failNextRequests: 0, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: null };
  // Sync and reset are mutually exclusive: a sync awaits the connector before it
  // applies its batches, and a reset during that await would be overwritten by stale results.
  let syncInProgress = false;
  let resetInProgress = false;

  const connectorOptions: MockConnectorOptions = {
    releasedBatch: () => store.current.mockConnector.releasedBatch,
    failingSourceKey: () => store.current.mailboxes.find((m) => m.id === faults.connectorFailMailboxId)?.sourceKey ?? null,
  };
  const connector = options.createConnector ? options.createConnector(connectorOptions) : new MockInboundConnector(connectorOptions);

  // Logging is off: request bodies may contain synthetic mail or notes and must not reach logs.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(cookie);

  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', APP_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (request.url.split('?')[0] === '/card') reply.header('Cache-Control', 'no-store');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    // The rental phone screen sets its own policy (camera for QR scanning and photos).
    if (!reply.hasHeader('Permissions-Policy')) reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Same API recognition as the gate; error responses (including unmatched paths) are never cacheable either.
    if (isApiRequest(request) || reply.statusCode >= 400) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  if (proxy) {
    // Every request, including static files, passes the trusted-proxy gate.
    app.addHook('onRequest', async (request, reply) => {
      const result = checkProxyRequest(request, proxy, (userId) => findUser(store.current, userId));
      if (!result.ok) return reply.code(result.status).send(result.body);
      if (result.user) proxyUsers.set(request, result.user);
    });
  } else if (auth.mode === 'account') {
    accountApi = installAccount(app, options.account!, {
      listenPort: options.listenPort,
      isAllowedLoopbackHost: isAllowedHost,
      lookupUser: (principalId) => findUser(store.current, principalId),
      sessionUser,
    });
  } else if (auth.mode === 'discord') {
    // The Bot data source path is always exempt from the browser Origin gate, so that without a key it answers 404 (no such route) like any unknown path.
    const serverToServerPaths = [...(mailbox ? [INGEST_PATH] : []), ...(options.rental?.driveSyncKey ? [SYNC_ACK_PATH] : []), BOT_DATASOURCE_PATH];
    discordApi = installDiscordAuth(app, options.discord!, { listenPort: options.listenPort, isAllowedLoopbackHost: isAllowedHost, sessionUser, serverToServerPaths });
  } else {
    // Every request (including reads and static files) must address the loopback
    // server by a loopback name, so a DNS-rebinding origin cannot reach the API at all.
    app.addHook('onRequest', async (request, reply) => {
      if (!isAllowedHost(request.headers.host, options.listenPort)) {
        return reply.code(421).send({ error: 'invalid_host', message: 'ループバックのホスト名以外からの要求は受け付けません。' } satisfies ApiError);
      }
    });

    // Mock-auth CSRF guard: state-changing requests must be same-origin JSON.
    app.addHook('onRequest', async (request, reply) => {
      if (SAFE_METHODS.includes(request.method)) return;
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if ((origin && origin !== `http://${request.headers.host}`) || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
        return reply.code(403).send({ error: 'forbidden', message: '別オリジンからの変更要求は受け付けません。' } satisfies ApiError);
      }
    });

    // Demo fault injection (labelled in the UI). Applies before any handler runs,
    // so an injected failure never performs a partial mutation. Not installed in trusted-proxy mode.
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      if (!path.startsWith('/api/') || NO_FAULT_PATHS.some((re) => re.test(path))) return;
      if (faults.delayNextRequests > 0) {
        faults.delayNextRequests -= 1;
        await new Promise((resolve) => setTimeout(resolve, faults.delayMs));
      }
      if (faults.failNextRequests > 0) {
        faults.failNextRequests -= 1;
        return reply.code(503).send({ error: 'simulated_failure', message: '模擬障害: サーバーが一時的に応答できませんでした。再試行してください。' } satisfies ApiError);
      }
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send(error.body);
    if (error instanceof DomainError) {
      const body: ApiError = { error: error.code, message: error.message };
      if (error.code === 'conflict' && error.details && typeof error.details === 'object' && 'current' in error.details) {
        body.current = (error.details as { current: ApiError['current'] }).current;
      } else if (error.details !== undefined) {
        body.details = error.details;
      }
      return reply.code(STATUS_CODE[error.code]).send(body);
    }
    if (error instanceof RequestError) {
      return reply.code(400).send({ error: 'invalid_request', message: error.message, details: error.details } satisfies ApiError);
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'invalid_request', message: 'リクエストを処理できませんでした。形式を確認してください。' } satisfies ApiError);
    }
    return reply.code(500).send({ error: 'internal', message: 'サーバー内部でエラーが発生しました。' } satisfies ApiError);
  });

  function currentUser(request: FastifyRequest): User | null {
    // Trusted-proxy identity is resolved per request; the demo cookie is never read in that mode.
    if (proxy) return proxyUsers.get(request) ?? null;
    if (accountApi) return accountApi.currentUser(request);
    if (discordApi) return discordApi.currentUser(request);
    const id = request.cookies[SESSION_COOKIE];
    const user = id ? findUser(store.current, id) : undefined;
    return user ? syntheticCommitteeReader(store.current, user) : null;
  }

  function requireUser(request: FastifyRequest): User {
    const user = currentUser(request);
    if (!user) {
      throw new DomainError('unauthenticated', proxy ? 'リバースプロキシで認証された利用者がありません。' : accountApi || discordApi ? 'ログインしてください。' : 'デモ用ペルソナを選択してください。');
    }
    return user;
  }

  function requireDemoAdmin(request: FastifyRequest, action: string): User {
    const user = requireUser(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', `${action}はデモ管理者だけが実行できます。`);
    return user;
  }

  function sendNotFoundForUnknownApi(reply: FastifyReply) {
    return reply.code(404).send({ error: 'not_found', message: 'API が見つかりません。' } satisfies ApiError);
  }

  const lineRoutes = options.line
    ? registerLineRoutes(app, { line: options.line, mail: store, clock, demo, parse, requireUser, requireDemoAdmin })
    : null;

  const committeeMail = mailbox && discordApi
    ? registerMailboxRoutes(app, mailbox, {
        requireUser,
        session: (request) => discordApi!.currentSession(request),
        people: { lookup: (userId) => discordApi!.lookupUser(userId), list: () => discordApi!.listUsers() },
        discordUserIdOf: (userId) => discordApi!.discordUserIdOf(userId),
        clock,
        now: () => Date.parse(clock()),
        parse,
      })
    : null;

  const taskRoutes = registerTaskRoutes(app, { tasks: options.tasks ?? null, mail: store, mailCases: committeeMail?.cases ?? null, line: options.line, clock, parse, requireUser });
  registerAssistantRoutes(app, { assistant: options.assistant ?? null, mailDraftBcc: options.mailbox?.config.draftBccAddress ?? null, parse, requireUser });

  await registerRentalRoutes(app, { rental: options.rental ?? null, requireUser, lookupUser: (userId) => (discordApi ? discordApi.lookupUser(userId) : findUser(store.current, userId)), listUsers: () => discordApi ? discordApi.listUsers() : store.current.users.filter((u) => !u.disabled) });
  // Copy to Google Drive: signed requests of the committee's Apps Script, Discord login only (the gate lets its report through).
  if (options.rental?.driveSyncKey) {
    if (auth.mode !== 'discord') throw new ConfigError('物品の Drive 同期は discord モードでだけ使えます。');
    attachRentalDriveSync(app, { store: options.rental.store, key: options.rental.driveSyncKey });
  }

  if (botDatasourceKey && discordApi) {
    attachBotDatasource(app, {
      key: botDatasourceKey,
      rental: options.rental ?? null,
      mailbox,
      tasks: options.tasks ?? null,
      displayName: (userId) => discordApi!.rosterNameOf(userId),
      now: () => Date.parse(clock()),
    });
  }

  // ---- public
  app.get('/api/health', async () => ({ ok: true }));

  if (proxy) {
    // No persona list, login or logout: identity comes only from the trusted proxy.
    app.get('/api/session', async (request): Promise<SessionResponse> => ({
      demoAuthentication: false,
      authMode: 'trusted-proxy',
      user: sessionUser(requireUser(request)),
    }));
  } else if (demo) {
    app.get('/api/personas', async () =>
      store.current.users.map((u) => ({ id: u.id, displayName: u.displayName, roleLabel: u.roleLabel })),
    );

    app.get('/api/session', async (request): Promise<SessionResponse> => {
      const user = currentUser(request);
      return { demoAuthentication: true, user: user ? sessionUser(user) : null };
    });

    app.post('/api/session', async (request, reply): Promise<SessionResponse> => {
      const { userId } = parse(sessionBody, request.body);
      const user = findUser(store.current, userId);
      if (!user) throw new DomainError('validation', '存在しないペルソナです。');
      reply.setCookie(SESSION_COOKIE, user.id, { path: '/', httpOnly: true, sameSite: 'strict' });
      return { demoAuthentication: true, user: sessionUser(user) };
    });

    app.delete('/api/session', async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { demoAuthentication: true, user: null };
    });
  }

  // ---- mail (all reads/mutations derive from the current user's grants). The committee mailbox
  // (Discord login with SMM_MAIL_DIR) serves these paths itself.
  if (!committeeMail) {
    app.get('/api/mailboxes', async (request) => {
      const user = requireUser(request);
      return store.read((s) => mailboxSummaries(s, user));
    });

    app.get('/api/threads', async (request) => {
      const user = requireUser(request);
      const query = parse(threadQuery, request.query);
      return store.read((s) => listThreads(s, user, query));
    });

    app.get('/api/threads/:threadId', async (request) => {
      const user = requireUser(request);
      const { threadId } = parse(threadParams, request.params);
      return store.read((s) => getThread(s, user, threadId));
    });

    app.get('/api/receipts/:receiptId', async (request) => {
      const user = requireUser(request);
      const { receiptId } = parse(receiptParams, request.params);
      return store.read((s) => getReceipt(s, user, receiptId));
    });

    app.get('/api/receipts/:receiptId/attachments/:attachmentId', async (request, reply) => {
      const user = requireUser(request);
      const { receiptId, attachmentId } = parse(attachmentParams, request.params);
      const attachment = store.read((s) => getAttachment(s, user, receiptId, attachmentId));
      // Always a download, never rendered inline by the app origin.
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="attachment.bin"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      return reply.send(Buffer.from(attachment.content, 'utf8'));
    });

    app.get('/api/receipts/:receiptId/assignees', async (request) => {
      const user = requireUser(request);
      const { receiptId } = parse(receiptParams, request.params);
      return store.read((s) => assigneeCandidates(s, user, receiptId));
    });

    app.patch('/api/receipts/:receiptId/triage', async (request) => {
      const user = requireUser(request);
      const { receiptId } = parse(receiptParams, request.params);
      const body = parse(triageBody, request.body);
      return store.transact((s) => updateTriage(s, user, receiptId, body, clock()));
    });

    app.post('/api/receipts/:receiptId/notes', async (request, reply) => {
      const user = requireUser(request);
      const { receiptId } = parse(receiptParams, request.params);
      const { body } = parse(noteBody, request.body);
      const note = store.transact((s) => addNote(s, user, receiptId, body, clock()));
      return reply.code(201).send(note);
    });

    // ---- integrated inbox (email + LINE, each under its own ACL)
    app.get('/api/inbox', async (request) => {
      const user = requireUser(request);
      const query = parse(inboxQuery, request.query);
      return listInbox(store.current, lineRoutes ? options.line!.store.current : null, user, query);
    });

    app.get('/api/inbox/labels', async (request) => {
      const user = requireUser(request);
      const scope = parse(inboxLabelQuery, request.query);
      return inboxLabels(store.current, lineRoutes ? options.line!.store.current : null, user, scope);
    });

    app.get('/api/labels', async (request) => {
      const user = requireUser(request);
      const { mailboxId } = parse(z.strictObject({ mailboxId: shortId.optional() }), request.query);
      return store.read((s) => labelFacets(s, user, mailboxId));
    });

    // ---- demo administration (grants, mock connector)
    app.get('/api/admin/access', async (request) => {
      const user = requireUser(request);
      return store.read((s) => accessMatrix(s, user));
    });

    app.put('/api/admin/access', async (request) => {
      const user = requireUser(request);
      const body = parse(grantBody, request.body);
      return store.transact((s) => setGrant(s, user, body, clock()));
    });

    app.get('/api/admin/audit', async (request) => {
      const user = requireUser(request);
      return store.read((s) => auditLog(s, user));
    });

    app.post('/api/admin/mock/release', async (request) => {
      const user = requireUser(request);
      const releasedBatch = store.transact((s) => releaseMockBatch(s, user, clock()));
      return { releasedBatch };
    });

    app.post('/api/admin/sync', async (request) => {
      const user = requireUser(request);
      if (!user.canManageAccess) throw new DomainError('forbidden', 'モック同期はデモ管理者だけが実行できます。');
      const { mode } = parse(syncBody, request.body);
      if (syncInProgress) throw new DomainError('conflict', '同期を実行中です。完了を待ってから再実行してください。');
      if (resetInProgress) throw new DomainError('conflict', 'サンプルを初期化中です。完了を待ってから再実行してください。');
      syncInProgress = true;
      try {
        const batches = await fetchAll(store.current, connector, mode);
        return store.transact((s) => applyBatches(s, connector.id, batches, user.id, clock()));
      } finally {
        syncInProgress = false;
      }
    });
  }

  // ---- demo controls (clearly labelled as demo-only in the UI). Not registered in
  // trusted-proxy or account mode, so they answer 404 there even for an administrator.
  if (demo) {
    app.get('/api/demo/faults', async (request) => {
      requireDemoAdmin(request, '障害シミュレーション');
      return faults;
    });

    app.put('/api/demo/faults', async (request) => {
      requireDemoAdmin(request, '障害シミュレーション');
      const body = parse(faultBody, request.body);
      if (body.connectorFailMailboxId !== null && !store.current.mailboxes.some((m) => m.id === body.connectorFailMailboxId)) {
        throw new DomainError('validation', '存在しない受信箱です。');
      }
      Object.assign(faults, body);
      return faults;
    });

    app.post('/api/demo/reset', async (request) => {
      requireDemoAdmin(request, 'サンプルのリセット');
      if (syncInProgress) throw new DomainError('conflict', 'モック同期を実行中のためリセットできません。同期の完了後に再実行してください。');
      if (resetInProgress) throw new DomainError('conflict', 'サンプルを初期化中です。');
      if (lineRoutes?.busy()) throw new DomainError('conflict', 'LINE の模擬送信を処理中のためリセットできません。完了後に再実行してください。');
      resetInProgress = true;
      try {
        store.replace(await createSeedState(clock()));
        lineRoutes?.reset(clock());
        taskRoutes.reset();
        Object.assign(faults, { failNextRequests: 0, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: null });
        return { ok: true };
      } finally {
        resetInProgress = false;
      }
    });
  }

  app.all('/api/*', async (_request, reply) => sendNotFoundForUnknownApi(reply));

  if (options.staticDir && existsSync(options.staticDir)) {
    await app.register(fastifyStatic, { root: options.staticDir, index: 'index.html' });
    // Sign-in and first registration (the link in the registration DM) open the same screen.
    for (const path of ['/register', '/login', '/card']) app.get(path, async (_request, reply) => {
      if (path === '/card') reply.header('Cache-Control', 'no-store');
      return reply.sendFile('index.html');
    });
  }

  return app;
}
