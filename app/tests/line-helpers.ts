import type { FastifyInstance } from 'fastify';
import type { TrustedProxyAuth } from '../src/server/auth.js';
import { StateStore } from '../src/server/domain/store.js';
import type { AppState } from '../src/server/domain/types.js';
import { buildApp, SESSION_COOKIE } from '../src/server/http/app.js';
import { MockLinePushConnector } from '../src/server/line/connector.js';
import { BOT, LINE_GROUP, LINE_LEGACY, LINE_ROOM, LINE_SHOP, LINE_SUPPORT, LINE_USER, mockEventId } from '../src/server/line/fixtures.js';
import { conversationIdFor } from '../src/server/line/ingest.js';
import { createLineSeedState } from '../src/server/line/seed.js';
import { LineStore, type FileWriter } from '../src/server/line/store.js';
import type { LineState } from '../src/server/line/types.js';
import { PROXY_IP, PUBLIC_HOST, PUBLIC_ORIGIN, seedState, T0, TEST_HOST, TEST_PORT } from './helpers.js';

// Synthetic LINE test harness: in-process app with a controllable clock, the mock
// push connector and an optional failing writer. No network, files only in .tmp.

const api = (id: string) => ({ kind: 'messaging_api' as const, id });
export const CONV = {
  l1: conversationIdFor(LINE_SUPPORT, { ...api(LINE_USER.l1), type: 'user' }),
  l2Unfollowed: conversationIdFor(LINE_SUPPORT, { ...api(LINE_USER.l2), type: 'user' }),
  group: conversationIdFor(LINE_SUPPORT, { ...api(LINE_GROUP), type: 'group' }),
  room: conversationIdFor(LINE_SUPPORT, { ...api(LINE_ROOM), type: 'room' }),
  shopL1: conversationIdFor(LINE_SHOP, { ...api(LINE_USER.l1), type: 'user' }),
  legacy: conversationIdFor(LINE_LEGACY, { kind: 'legacy_chat', legacyKind: 'user', ref: 'legacy-chat-001' }),
};

/** In-memory "disk" whose writes can be made to fail. */
export class FlakyDisk {
  files = new Map<string, string>();
  writes = 0;
  failWrites = new Set<number>();
  readonly writer: FileWriter = (file, text) => {
    this.writes += 1;
    if (this.failWrites.has(this.writes)) throw new Error('simulated disk failure');
    this.files.set(file, text);
  };
  /** Fails the n-th write from now (1 = the next write). */
  failNth(n: number): void {
    this.failWrites.add(this.writes + n);
  }
  load(file: string): LineState {
    return JSON.parse(this.files.get(file) ?? 'null') as LineState;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Res = { status: number; json: any; raw: string };

export interface LineTestApp {
  app: FastifyInstance;
  mail: StateStore;
  line: LineStore;
  connector: MockLinePushConnector;
  advance: (ms: number) => void;
  now: () => string;
  call: (userId: string | null, method: Method, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
}

export interface LineAppOptions {
  lineState?: LineState;
  mailState?: AppState;
  file?: string | null;
  writer?: FileWriter;
  connector?: MockLinePushConnector;
  replyGrants?: boolean;
  startAt?: number;
  auth?: TrustedProxyAuth;
}

export async function makeLineApp(opts: LineAppOptions = {}): Promise<LineTestApp> {
  let now = opts.startAt ?? Date.parse(T0);
  const clock = () => new Date(now).toISOString();
  const mail = new StateStore(opts.mailState ?? (await seedState()), null);
  const connector = opts.connector ?? new MockLinePushConnector(() => now);
  const line = new LineStore(opts.lineState ?? createLineSeedState(T0, { replyGrants: opts.replyGrants ?? true }), opts.file ?? null, opts.writer);
  const app = await buildApp({
    store: mail,
    listenPort: TEST_PORT,
    clock,
    ...(opts.auth ? { auth: opts.auth } : {}),
    line: { store: line, connector, seed: (at) => createLineSeedState(at, { replyGrants: opts.replyGrants ?? true }) },
  });
  const call: LineTestApp['call'] = async (userId, method, url, body, headers = {}) => {
    const base = opts.auth
      ? { host: PUBLIC_HOST, ...(userId ? { 'x-mail-user': userId } : {}), ...(method === 'GET' ? {} : { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin' }) }
      : { host: TEST_HOST, ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}) };
    const res = await app.inject({
      method,
      url,
      ...(opts.auth ? { remoteAddress: PROXY_IP } : {}),
      headers: { ...base, ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    let json: unknown;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, raw: res.body };
  };
  return { app, mail, line, connector, advance: (ms) => (now += ms), now: clock, call };
}

/** Draft -> preview, returning everything a send needs. */
export async function prepare(t: LineTestApp, userId: string, conv: string, body: string) {
  const current = await t.call(userId, 'GET', `/api/line/conversations/${conv}`);
  const expectedVersion = current.json?.reply?.draft?.version ?? null;
  const draft = await t.call(userId, 'PUT', `/api/line/conversations/${conv}/reply/draft`, { body, expectedVersion });
  if (draft.status !== 200) throw new Error(`draft ${draft.status} ${draft.raw}`);
  const preview = await t.call(userId, 'POST', `/api/line/conversations/${conv}/reply/preview`, { draftId: draft.json.id, draftVersion: draft.json.version });
  if (preview.status !== 200) throw new Error(`preview ${preview.status} ${preview.raw}`);
  return {
    preview: preview.json,
    send: (operationId: string, overrides: Record<string, unknown> = {}) =>
      t.call(userId, 'POST', `/api/line/conversations/${conv}/reply/send`, {
        consentId: preview.json.consentId,
        operationId,
        draftId: preview.json.draftId,
        draftVersion: preview.json.draftVersion,
        body: preview.json.body,
        ...overrides,
      }),
  };
}

/** A validated envelope as the existing receiver would export it (synthetic). */
export function envelope(n: number, type: string, extra: Record<string, unknown>, opts: { account?: string; destination?: string; userId?: string; timestamp?: string } = {}) {
  return {
    schema: 'line-event/v1',
    accountId: opts.account ?? LINE_SUPPORT,
    destination: opts.destination ?? BOT.support,
    webhookEventId: mockEventId(n),
    isRedelivery: false,
    timestamp: opts.timestamp ?? '2026-09-20T00:00:00.000Z',
    source: { type: 'user', userId: opts.userId ?? LINE_USER.l1 },
    cursor: `test-${n}`,
    type,
    ...extra,
  };
}

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
