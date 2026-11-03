import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DayOfStore } from '../../src/server/dayof/store.js';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { jstDate } from '../../src/shared/calendar.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, setup, testConfig } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from '../mailbox/helpers.js';

// The festival-day board under the Discord login: a member with the 臨時スタッフ role reads only the notices marked
// for temporary staff, through the one route the login lets them call. Synthetic names and IDs only.

const ROLE_STAFF = '1000000000000002099';
const ORIGIN = `http://${TEST_HOST}`;
let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let dayof: DayOfStore;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-dayof-discord-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup({ config: testConfig({ departmentRoleIds: { [ROLE_STAFF]: '臨時スタッフ' } }) });
  const config = testMailboxConfig(path.join(dir, 'mail'), {}, randomBytes(32));
  mail = new MailboxStore(config.dataDir);
  dayof = new DayOfStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) },
    dayof,
  });
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  dayof?.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST', url: string, options: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; json: any; body: string; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1' } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

const cookieOf = (setCookie: unknown) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  await register(ctx, uid, studentId, roles);
  const login = await call('POST', '/api/auth/login', { body: { loginId: studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return cookieOf(login.headers['set-cookie']);
}

describe('temporary staff under the Discord login', () => {
  it('read the notices marked for them without names, and nothing else of the board', async () => {
    const today = jstDate(new Date(ctx.clock.now));
    dayof.saveSettings({ startDate: today, endDate: today, rules: '本部長が決める（合成）' }, 1, 'system', new Date(ctx.clock.now).toISOString());
    const at = new Date(ctx.clock.now).toISOString();
    const shown = dayof.create({ body: '正門のテントを畳みます（合成）', priority: 'urgent', place: '正門', departments: [], staffVisible: true }, 'system', at, null).row;
    dayof.create({ body: '委員だけの連絡（合成）', priority: 'normal', place: '', departments: [], staffVisible: false }, 'system', at, null);

    const staff = await signIn(OTHER, '21000003', [ROLE_STAFF]);
    const notices = await call('GET', '/api/dayof/notices', { cookie: staff });
    expect(notices.status, notices.body).toBe(200);
    expect(notices.json).toMatchObject({ active: true, staff: true });
    expect(notices.json.posts.map((p: { id: string }) => p.id)).toEqual([shown.id]);
    expect(notices.json.posts[0]).toMatchObject({ authorName: '本部', canEdit: false });
    expect(notices.body).not.toContain('本部長が決める');
    expect((await call('GET', '/api/dayof/board', { cookie: staff })).status).toBe(403);
    expect((await call('GET', '/api/dayof/admin', { cookie: staff })).status).toBe(403);
    expect((await call('POST', '/api/dayof/decisions', { cookie: staff, body: { title: '合成', place: '', departments: ['somu'], clientToken: 'tok-0000000000000001' } })).status).toBe(403);

    // A committee member reads the whole board.
    const member = await signIn(MEMBER, '21000002');
    const board = await call('GET', '/api/dayof/board', { cookie: member });
    expect(board.status, board.body).toBe(200);
    expect(board.json).toMatchObject({ active: true, rules: '本部長が決める（合成）', canPost: false });
    expect(board.json.posts).toHaveLength(2);
    expect((await call('GET', '/api/dayof/notices', { cookie: member })).json.posts).toHaveLength(2);
  });
});
