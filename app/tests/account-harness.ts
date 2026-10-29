import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { expect } from 'vitest';
import type { AccountRuntime } from '../src/server/account/http.js';
import { IdentityBridgeClient } from '../src/server/account/bridge-client.js';
import { MOCK_GROUP_ID, MOCK_ORGANIZATION_ID, MockAccountProviders } from '../src/server/account/mock-providers.js';
import type { AccountAuth } from '../src/server/auth.js';
import { StateStore } from '../src/server/domain/store.js';
import { buildApp } from '../src/server/http/app.js';
import { MockLinePushConnector } from '../src/server/line/connector.js';
import { createLineSeedState } from '../src/server/line/seed.js';
import { LineStore } from '../src/server/line/store.js';
import { LoginService, LOW_COST_TEST_ONLY, memoryAuditSink, PasswordHasher, REFERENCE_STORE_ACK, type LoginCodeEnvelope } from '../src/server/login/index.js';
import { CHALLENGE_ID_PATTERN } from '../src/server/login/service.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON } from '../src/server/tasks/bridge.js';
import { TaskServiceClient } from '../src/server/tasks/client.js';
import { emptyLinkState, TaskLinkStore } from '../src/server/tasks/links.js';
import { SVC_HEADERS, verifySignature } from '../src/server/tasks/signing.js';
import { seedState, T0, TEST_HOST, TEST_PORT } from './helpers.js';
import type { TaskFake } from './task-fake.js';

// In-process account compositions for API tests: the labelled mock composition, and the
// production composition wired to a TEST-ONLY signed identity bridge (backed by the same
// synthetic people). Requests carry a small cookie jar so the real cookie flow is exercised.

export const PROD_ORIGIN = 'https://mail.example.invalid';
export const PROD_HOST = 'mail.example.invalid';
export const PROXY_IP = '10.0.0.2';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Res = { status: number; json: any; raw: string; headers: Record<string, unknown>; cookies: string[] };

export class Browser {
  readonly jar = new Map<string, string>();
  constructor(
    private readonly app: FastifyInstance,
    private readonly base: { host: string; origin: string; remoteAddress?: string; forwardedFor?: string },
  ) {}

  async call(method: Method, url: string, body?: unknown, headers: Record<string, string | null> = {}): Promise<Res> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const merged: Record<string, string | null> = {
      host: this.base.host,
      ...(method === 'GET' ? {} : { origin: this.base.origin, 'sec-fetch-site': 'same-origin', 'x-smm-csrf': '1' }),
      ...(cookie ? { cookie } : {}),
      ...(this.base.forwardedFor ? { 'x-forwarded-for': this.base.forwardedFor } : {}),
      ...headers,
    };
    const res = await this.app.inject({
      method,
      url,
      remoteAddress: this.base.remoteAddress ?? '127.0.0.1',
      headers: Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== null)),
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const setCookies = ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.jar.delete(name!);
      else this.jar.set(name!, value);
    }
    let json: unknown;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, raw: res.body, headers: res.headers, cookies: setCookies };
  }
}

/**
 * An accepted code request has exactly the public fields and an opaque challenge ID, and carries
 * the code actually DM'd neither in the body nor in any header. The generic "no 8-digit run" check
 * still covers every other byte of the body; only the random ID (32 hex characters, which can hold
 * such a run by chance) is left out of it.
 */
export function expectAcceptedWithoutCode(res: Res, code: string, expiresInSeconds: number): void {
  expect(res.status).toBe(202);
  expect(Object.keys(res.json).sort()).toEqual(['challengeId', 'expiresInSeconds', 'message', 'status']);
  expect(res.json).toMatchObject({ status: 'accepted', expiresInSeconds });
  expect(res.json.challengeId).toMatch(CHALLENGE_ID_PATTERN);
  expect(typeof res.json.message).toBe('string');
  expect(code).toMatch(/^\d{8}$/);
  expect(res.raw).not.toContain(code);
  expect(JSON.stringify(res.headers)).not.toContain(code);
  const rest = res.raw.split(res.json.challengeId);
  expect(rest).toHaveLength(2);
  expect(rest.join('')).not.toMatch(/\d{8}/);
}

const FAST = () => new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY });

export class Clock {
  t = Date.now();
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface AccountApp {
  app: FastifyInstance;
  clock: Clock;
  store: StateStore;
  service: LoginService;
  providers: MockAccountProviders;
  browser: (forwardedFor?: string) => Browser;
  /** Latest code DM'd to the person (mock outbox or the bridge's captured envelope). */
  codeFor: (principalId: string) => Promise<string>;
  close: () => Promise<void>;
}

async function common(auth: AccountAuth, account: AccountRuntime, providers: MockAccountProviders, fake: TaskFake | null) {
  const store = new StateStore(await seedState(), null);
  const app = await buildApp({
    store,
    listenPort: TEST_PORT,
    auth,
    account,
    line: { store: new LineStore(createLineSeedState(T0, { replyGrants: false }), null), connector: new MockLinePushConnector(), seed: (at) => createLineSeedState(at, { replyGrants: false }) },
    tasks: fake ? { client: new TaskServiceClient({ baseUrl: fake.url, key: fake.key }), bridge: parseTaskBridge(SYNTHETIC_TASK_BRIDGE_JSON), links: new TaskLinkStore(emptyLinkState(), null) } : null,
  });
  return { store, app, providers };
}

export async function makeMockAccountApp(fake: TaskFake | null = null): Promise<AccountApp> {
  const clock = new Clock();
  const providers = new MockAccountProviders(clock.now);
  const service = new LoginService({
    groupId: MOCK_GROUP_ID,
    organizationId: MOCK_ORGANIZATION_ID,
    acceptedLinkEvidence: ['verified_roster'],
    pepper: randomBytes(32),
    serviceLabel: '共有受信とタスク 模擬',
    audience: `http://${TEST_HOST}`,
    membership: providers.membership,
    links: providers.links,
    principals: providers.principals,
    deliver: providers.deliver,
    audit: memoryAuditSink().sink,
    stateStore: REFERENCE_STORE_ACK,
    passwords: FAST(),
    now: clock.now,
  });
  const auth: AccountAuth = { mode: 'account', composition: 'mock', publicOrigin: null, publicHost: null, trustedProxies: new Set() };
  const { store, app } = await common(auth, { service, composition: 'mock', publicOrigin: null, publicHost: null, trustedProxies: new Set(), mock: providers }, providers, fake);
  return {
    app,
    clock,
    store,
    service,
    providers,
    browser: () => new Browser(app, { host: TEST_HOST, origin: `http://${TEST_HOST}` }),
    codeFor: async (principalId) => {
      await service.idle();
      const label = providers.directory().find((p) => p.principalId === principalId)!.discordUserId;
      return providers.dmOutbox().find((m) => m.discordUserId === label)!.code;
    },
    close: () => app.close(),
  };
}

/** TEST-ONLY identity bridge: verifies svc-auth/v1 from "smm-auth" and serves the synthetic people. */
export async function startFakeBridge(providers: MockAccountProviders): Promise<{ url: string; key: Buffer; dms: LoginCodeEnvelope[]; garbage: { on: boolean }; close: () => Promise<void> }> {
  const key = randomBytes(32);
  const dms: LoginCodeEnvelope[] = [];
  const garbage = { on: false };
  const app = Fastify({ logger: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as FastifyRequest & { rawBody?: string }).rawBody = String(body);
    done(null, JSON.parse(String(body)));
  });
  app.addHook('preHandler', async (request, reply) => {
    const h = (n: string) => String(request.headers[n] ?? '');
    const ok =
      h(SVC_HEADERS.client) === 'smm-auth' &&
      verifySignature(key, { client: 'smm-auth', method: request.method, path: request.raw.url ?? '', timestamp: h(SVC_HEADERS.timestamp), nonce: h(SVC_HEADERS.nonce), actor: '', body: (request as FastifyRequest & { rawBody?: string }).rawBody ?? '' }, h(SVC_HEADERS.signature));
    if (!ok) return reply.code(401).send({ error: 'bad signature' });
    if (garbage.on) return reply.send({ link: { linkId: 'x', admin: true } });
  });
  app.post<{ Body: { email: string } }>('/v1/links/by-verified-email', async (r) => ({ link: await providers.links.findByVerifiedEmail(r.body.email) }));
  app.post<{ Body: { linkId: string } }>('/v1/links/get', async (r) => ({ link: await providers.links.getLink(r.body.linkId) }));
  app.post<{ Body: { principalId: string } }>('/v1/principals/get', async (r) => ({ principal: await providers.principals.getPrincipal(r.body.principalId) }));
  app.post<{ Body: { groupId: string; memberKey: string } }>('/v1/membership/effective', async (r) => providers.membership.lookup(r.body.groupId, r.body.memberKey));
  app.post<{ Body: LoginCodeEnvelope }>('/v1/dm/login-code', async (r) => {
    dms.push(r.body);
    return providers.deliver(r.body);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, key, dms, garbage, close: () => app.close() };
}

export async function makeProductionAccountApp(fake: TaskFake | null = null): Promise<AccountApp & { bridge: Awaited<ReturnType<typeof startFakeBridge>> }> {
  const clock = new Clock();
  const providers = new MockAccountProviders(clock.now);
  const bridgeServer = await startFakeBridge(providers);
  const bridge = new IdentityBridgeClient({ baseUrl: bridgeServer.url, key: bridgeServer.key, timeoutMs: 2_000 });
  const service = new LoginService({
    groupId: MOCK_GROUP_ID,
    organizationId: MOCK_ORGANIZATION_ID,
    acceptedLinkEvidence: ['verified_roster'],
    pepper: randomBytes(32),
    serviceLabel: '共有受信とタスク',
    audience: PROD_ORIGIN,
    membership: bridge.membership,
    links: bridge.links,
    principals: bridge.principals,
    deliver: bridge.deliver,
    audit: memoryAuditSink().sink,
    stateStore: REFERENCE_STORE_ACK,
    passwords: FAST(),
    now: clock.now,
  });
  const auth: AccountAuth = { mode: 'account', composition: 'production', publicOrigin: PROD_ORIGIN, publicHost: PROD_HOST, trustedProxies: new Set([PROXY_IP]) };
  const { store, app } = await common(auth, { service, composition: 'production', publicOrigin: PROD_ORIGIN, publicHost: PROD_HOST, trustedProxies: new Set([PROXY_IP]), mock: null }, providers, fake);
  return {
    app,
    clock,
    store,
    service,
    providers,
    bridge: bridgeServer,
    browser: (forwardedFor = '198.51.100.7') => new Browser(app, { host: PROD_HOST, origin: PROD_ORIGIN, remoteAddress: PROXY_IP, forwardedFor }),
    codeFor: async (principalId) => {
      await service.idle();
      const id = providers.directory().find((p) => p.principalId === principalId)!.discordUserId;
      return bridgeServer.dms.filter((d) => d.recipient.discordUserId === id).at(-1)!.code;
    },
    close: async () => {
      await app.close();
      await bridgeServer.close();
    },
  };
}

export const EMAIL: Record<string, string> = {
  'u-editor-a': 'editor-a@staff.invalid',
  'u-viewer-b': 'viewer-b@staff.invalid',
  'u-editor-c': 'editor-c@staff.invalid',
  'u-noaccess-d': 'noaccess-d@staff.invalid',
  'u-admin': 'admin@staff.invalid',
};

export const TEST_PASSWORD = 'synthetic passphrase 42';

/** Full first-use flow over HTTP; returns the logged-in browser. */
export async function signUp(a: AccountApp, principalId: string, browser = a.browser(), password = TEST_PASSWORD): Promise<Browser> {
  const req = await browser.call('POST', '/api/auth/setup/request', { email: EMAIL[principalId] });
  if (req.status !== 202) throw new Error(`request ${req.status}`);
  const code = await a.codeFor(principalId);
  const verify = await browser.call('POST', '/api/auth/setup/verify', { challengeId: req.json.challengeId, code });
  if (verify.status !== 200) throw new Error(`verify ${verify.status}`);
  const set = await browser.call('POST', '/api/auth/setup/password', { password, confirmation: password });
  if (set.status !== 200) throw new Error(`password ${set.status} ${set.raw}`);
  return browser;
}
