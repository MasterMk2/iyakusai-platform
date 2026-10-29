import type { FastifyInstance } from 'fastify';
import type { TrustedProxyAuth } from '../src/server/auth.js';
import { createSeedState } from '../src/server/domain/seed.js';
import { StateStore } from '../src/server/domain/store.js';
import { receiptIdFor } from '../src/server/domain/sync.js';
import { buildApp, SESSION_COOKIE, type AppOptions } from '../src/server/http/app.js';
import type { AppState, User } from '../src/server/domain/types.js';

export const T0 = '2026-10-01T00:00:00.000Z';

export const EDITOR_A = 'u-editor-a';
export const VIEWER_B = 'u-viewer-b';
export const EDITOR_C = 'u-editor-c';
export const NOACCESS_D = 'u-noaccess-d';
export const ADMIN = 'u-admin';

export function rid(sourceKey: string, providerMessageId: string): string {
  return receiptIdFor('mock-inbound', sourceKey, providerMessageId);
}

export const R = {
  supportLogin: rid('mock-src-support', 'mock-support-0001'),
  supportLoginReply: rid('mock-src-support', 'mock-support-0002'),
  supportHtml: rid('mock-src-support', 'mock-support-0003'),
  supportAttachment: rid('mock-src-support', 'mock-support-0004'),
  salesQuote: rid('mock-src-sales', 'mock-sales-0001'),
  salesContract: rid('mock-src-sales', 'mock-sales-0002'),
  salesEvent: rid('mock-src-sales', 'mock-sales-0003'),
  billingContract: rid('mock-src-billing', 'mock-billing-0001'),
  billingContractReply: rid('mock-src-billing', 'mock-billing-0002'),
  billingInvoice: rid('mock-src-billing', 'mock-billing-0003'),
  billingLate: rid('mock-src-billing', 'mock-billing-0004'),
};

export async function seedState(): Promise<AppState> {
  return createSeedState(T0);
}

export function userOf(state: AppState, id: string): User {
  const user = state.users.find((u) => u.id === id);
  if (!user) throw new Error(`no user ${id}`);
  return user;
}

export interface TestApp {
  app: FastifyInstance;
  store: StateStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (userId: string | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown) => Promise<{ status: number; json: any; raw: string; headers: Record<string, unknown> }>;
}

export const TEST_PORT = 5178;
export const TEST_HOST = `127.0.0.1:${TEST_PORT}`;

// ---- trusted-proxy mode (synthetic identities; reserved .invalid/.example names only)
export const PUBLIC_ORIGIN = 'https://mail.example.invalid';
export const PUBLIC_HOST = 'mail.example.invalid';
export const PROXY_IP = '10.0.0.2';
export const ID = {
  editorA: 'editor-a@idp.example',
  viewerB: 'viewer-b@idp.example',
  editorC: 'editor-c@idp.example',
  noAccessD: 'noaccess-d@idp.example',
  admin: 'admin@idp.example',
};
export const PROXY_MAP = new Map<string, string>([
  [ID.editorA, EDITOR_A],
  [ID.viewerB, VIEWER_B],
  [ID.editorC, EDITOR_C],
  [ID.noAccessD, NOACCESS_D],
  [ID.admin, ADMIN],
]);

export function proxyAuth(identities: ReadonlyMap<string, string> = PROXY_MAP, proxies: string[] = [PROXY_IP]): TrustedProxyAuth {
  return { mode: 'trusted-proxy', publicOrigin: PUBLIC_ORIGIN, publicHost: PUBLIC_HOST, trustedProxies: new Set(proxies), identities };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ProxyTestApp {
  app: FastifyInstance;
  store: StateStore;
  /**
   * Request as the trusted proxy would forward it: canonical Host, the identity header and,
   * for writes, the public Origin. `headers` overrides those; a null value removes a header.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (identity: string | null, method: Method, url: string, body?: unknown, headers?: Record<string, string | null>, remoteAddress?: string) => Promise<{ status: number; json: any; raw: string; headers: Record<string, unknown> }>;
}

export async function makeProxyApp(auth: TrustedProxyAuth = proxyAuth(), state?: AppState): Promise<ProxyTestApp> {
  const store = new StateStore(state ?? (await seedState()), null);
  let tick = 0;
  const app = await buildApp({ store, listenPort: TEST_PORT, auth, clock: () => new Date(Date.parse(T0) + ++tick * 1000).toISOString() });
  const call: ProxyTestApp['call'] = async (identity, method, url, body, headers = {}, remoteAddress = PROXY_IP) => {
    const merged: Record<string, string | null> = {
      host: PUBLIC_HOST,
      'x-mail-user': identity,
      ...(method === 'GET' ? {} : { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin' }),
      ...headers,
    };
    const res = await app.inject({
      method,
      url,
      remoteAddress,
      headers: Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== null)),
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    let json: unknown;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, raw: res.body, headers: res.headers };
  };
  return { app, store, call };
}

export async function makeApp(file: string | null = null, extra: Partial<Pick<AppOptions, 'createConnector'>> = {}): Promise<TestApp> {
  const store = new StateStore(await seedState(), file);
  let tick = 0;
  const app = await buildApp({ store, listenPort: TEST_PORT, clock: () => new Date(Date.parse(T0) + ++tick * 1000).toISOString(), ...extra });
  const call: TestApp['call'] = async (userId, method, url, body) => {
    const res = await app.inject({
      method,
      url,
      headers: userId ? { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${userId}` } : { host: TEST_HOST },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    let json: unknown;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, raw: res.body, headers: res.headers };
  };
  return { app, store, call };
}
