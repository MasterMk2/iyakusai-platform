import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { staffRouteAllowed } from '../../src/server/discord-auth/temporary-staff.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, ROLE_PLANNING, setup } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from './helpers.js';

// The website editor with the Discord login (the production composition): the person is known on /site-editor/ too,
// although it is outside /api/, and the login's gate still guards it. Synthetic accounts and pages only.

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let app: FastifyInstance;
let seen: { url: string; actor: string | undefined }[];
const ORIGIN = `http://${TEST_HOST}`;

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  seen.push({ url: String(input), actor: headers['x-svc-actor'] });
  return new Response('{"wge":1,"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeEach(async () => {
  seen = [];
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-site-editor-discord-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  const config = testMailboxConfig(path.join(dir, 'mail'), {}, randomBytes(32));
  mail = new MailboxStore(config.dataDir, config.restrictedSenderDomains);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) },
    siteEditor: {
      config: { upstream: 'http://wge.invalid:8080', key: randomBytes(32), siteUrl: null, editors: { departments: ['企画部'], userIds: [] }, publishers: { departments: [], userIds: [] } },
      fetch: fakeFetch,
    },
  });
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST', url: string, options: { cookie?: string; origin?: string | null; body?: string } = {}) {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' && origin ? { origin } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json', 'x-wge-request': '1' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { payload: options.body } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, text: res.body, json: json as any };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  await register(ctx, uid, studentId, roles);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: TEST_HOST, origin: ORIGIN, 'x-smm-csrf': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ loginId: studentId, password: PASSWORD }),
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res.headers['set-cookie']);
}

describe('the website editor with the Discord login', () => {
  it('knows the person on /site-editor/ and lets a named department edit', async () => {
    const planner = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    expect((await call('GET', '/api/site-editor/meta', { cookie: planner })).json).toMatchObject({ enabled: true, canEdit: true, canPublish: false });
    expect((await call('GET', '/site-editor/api/ping', { cookie: planner })).status).toBe(200);
    expect((await call('POST', '/site-editor/api/pages/top/draft', { cookie: planner, body: '{"source":"","baseRevision":0}' })).status).toBe(200);
    // The actor is the account's ID (iy-…), not the student ID the person signs in with.
    expect(seen.map((s) => s.actor)).toEqual([expect.stringMatching(/^iy-\d+$/), expect.stringMatching(/^iy-\d+$/)]);
    expect(seen[0]!.actor).toBe(seen[1]!.actor);
    expect(seen[0]!.actor).not.toBe('21000002');
    expect((await call('POST', '/site-editor/api/pages/top/publish', { cookie: planner, body: '{"revision":1}' })).json).toMatchObject({ reason: 'forbidden' });
  });

  it('lets an access administrator publish, and refuses a member it does not name', async () => {
    const admin = await signIn(OTHER, '21000003', [ROLE_GENERAL_AFFAIRS]);
    expect((await call('POST', '/site-editor/api/pages/top/publish', { cookie: admin, body: '{"revision":1}' })).status).toBe(200);
    const plain = await signIn('1000000000000001004', '21000004');
    expect((await call('GET', '/api/site-editor/meta', { cookie: plain })).json).toMatchObject({ enabled: true, canEdit: false, editorUrl: null });
    expect((await call('GET', '/site-editor/editor/', { cookie: plain })).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it('refuses a person not signed in, and a write from another origin or without one', async () => {
    const res = await call('GET', '/site-editor/editor/');
    expect(res.status).toBe(401);
    expect(res.text).toContain('ログイン');
    const planner = await signIn(MEMBER, '21000002', [ROLE_PLANNING]);
    expect((await call('POST', '/site-editor/api/pages/top/draft', { cookie: planner, body: '{}', origin: 'https://evil.example.invalid' })).status).toBe(403);
    expect((await call('POST', '/site-editor/api/pages/top/draft', { cookie: planner, body: '{}', origin: null })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('is not on the routes a temporary staff account may call', () => {
    for (const method of ['GET', 'POST'] as const) expect(staffRouteAllowed(method, '/site-editor/*'), method).toBe(false);
    expect(staffRouteAllowed('GET', '/api/site-editor/meta')).toBe(false);
  });
});
