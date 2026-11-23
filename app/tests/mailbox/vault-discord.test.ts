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
import { VaultCipher } from '../../src/server/vault/cipher.js';
import { VaultStore } from '../../src/server/vault/store.js';
import { MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, setup } from '../discord-auth/helpers.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { testMailboxConfig } from './helpers.js';

// パスワード帳 with the Discord login (the production composition): the time the password was typed on the device is
// the sign-in's own, and /api/auth/reauth renews it. Synthetic accounts, names and values only.

let dir: string;
let ctx: ReturnType<typeof setup>;
let mail: MailboxStore;
let vault: VaultStore;
let app: FastifyInstance;
const ORIGIN = `http://${TEST_HOST}`;
const MINUTE = 60_000;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-vault-discord-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [MEMBER]: '合成 太郎', [OTHER]: '合成 花子' } }));
  ctx = setup();
  const config = testMailboxConfig(path.join(dir, 'mail'), {}, randomBytes(32));
  mail = new MailboxStore(config.dataDir, config.restrictedSenderDomains);
  vault = new VaultStore(config.dataDir);
  const seed = await seedState();
  app = await buildApp({
    store: new StateStore({ ...seed, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) },
    vault: { store: vault, cipher: new VaultCipher(randomBytes(32)), revealMinutes: 10 },
  });
});
afterEach(async () => {
  await app?.close();
  mail?.close();
  vault?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { body?: unknown; cookie?: string } = {}) {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, headers: res.headers, json: json as any };
}

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

async function signIn(uid: string, studentId: string, roles: string[] = []) {
  await register(ctx, uid, studentId, roles);
  const login = await call('POST', '/api/auth/login', { body: { loginId: studentId, password: PASSWORD } });
  expect(login.status).toBe(200);
  return cookieOf(login.headers['set-cookie']);
}

describe('the password book with the Discord login', () => {
  it('opens entries for 10 minutes after the password, and again after it is typed once more', async () => {
    // 総務部 holds the access administrators' role in the test configuration.
    const admin = await signIn(OTHER, '21000003', [ROLE_GENERAL_AFFAIRS]);
    const member = await signIn(MEMBER, '21000002');
    expect((await call('GET', '/api/vault/meta', { cookie: admin })).json).toMatchObject({ enabled: true, canAdminister: true });
    const section = (await call('POST', '/api/vault/sections', { cookie: admin, body: { name: '合成の区分', note: '' } })).json.section;
    const members = (await call('GET', `/api/vault/sections/${section.id}/members`, { cookie: admin })).json;
    const memberId = members.choices.people.find((p: { name: string }) => p.name === '合成 太郎').id;
    expect((await call('PUT', `/api/vault/sections/${section.id}/members`, { cookie: admin, body: { kind: 'user', target: memberId, role: 'view', expectedVersion: section.version } })).status).toBe(200);
    const created = await call('POST', '/api/vault/entries', { cookie: admin, body: { sectionId: section.id, name: '合成の管理画面', url: '', username: 'synthetic', password: 'Synthetic-Pass-0001', notes: '', clientToken: 'tok-synthetic-discord-01' } });
    expect(created.status).toBe(201);

    expect((await call('GET', '/api/vault/entries', { cookie: member })).json.entries).toHaveLength(1);
    ctx.clock.now += 11 * MINUTE;
    const locked = await call('POST', `/api/vault/entries/${created.json.entry.id}/reveal`, { cookie: member, body: { field: 'password', purpose: 'show' } });
    expect(locked.status).toBe(401);
    expect(locked.json.error).toBe('vault_reauth_required');
    expect((await call('GET', '/api/vault/meta', { cookie: member })).json.freshUntil).toBeNull();
    // The rest of the app keeps the sign-in.
    expect((await call('GET', '/api/session', { cookie: member })).json.user).not.toBeNull();

    const again = await call('POST', '/api/auth/reauth', { cookie: member, body: { password: PASSWORD } });
    expect(again.status).toBe(200);
    const renewed = cookieOf(again.headers['set-cookie']);
    const shown = await call('POST', `/api/vault/entries/${created.json.entry.id}/reveal`, { cookie: renewed, body: { field: 'password', purpose: 'show' } });
    expect(shown.json).toEqual({ field: 'password', value: 'Synthetic-Pass-0001' });
    expect((await call('GET', '/api/vault/meta', { cookie: renewed })).json.freshUntil).toBe(new Date(ctx.clock.now + 10 * MINUTE).toISOString());
  });

  it('is not on the routes a temporary staff account may call', () => {
    for (const [method, route] of [
      ['GET', '/api/vault/meta'],
      ['GET', '/api/vault/sections'],
      ['GET', '/api/vault/entries'],
      ['POST', '/api/vault/entries/:entryId/reveal'],
      ['POST', '/api/vault/sections/:sectionId/print'],
    ] as const) {
      expect(staffRouteAllowed(method, route), `${method} ${route}`).toBe(false);
    }
  });
});
