import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { staffRouteAllowed } from '../../src/server/discord-auth/temporary-staff.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { LOW_COST_TEST_ONLY, PasswordHasher } from '../../src/server/login/password.js';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { PASSWORD, setup } from './helpers.js';

// Temporary staff (operator-issued item accounts) signed in through the Discord login: the counted supplies,
// attachments and the 団体 board are rental.loan work, so their routes pass the staff allow-list; the
// definitions (rental.issue) do not. Synthetic numbers and names only.

const RANGE = '00000100-00000199';
const STAFF_NUMBER = '00000150';
const GROUP = '試用 模擬店A';
const ORIGIN = `http://${TEST_HOST}`;

describe('the temporary staff allow-list for the supplies', () => {
  it('opens reading, lending, returning, using up, checking and undoing a loan', () => {
    for (const route of ['', '/movements', '/board', '/collection', '/shortages', '/attachments']) {
      expect(staffRouteAllowed('GET', `/api/rental/supplies${route}`)).toBe(true);
    }
    for (const route of ['/lend', '/return', '/consume', '/attachment-checks', '/movements/:id/reverse']) {
      expect(staffRouteAllowed('POST', `/api/rental/supplies${route}`)).toBe(true);
    }
  });

  it('keeps the definitions closed', () => {
    expect(staffRouteAllowed('POST', '/api/rental/supplies/items')).toBe(false);
    expect(staffRouteAllowed('PATCH', '/api/rental/supplies/items/:id')).toBe(false);
    expect(staffRouteAllowed('POST', '/api/rental/supplies/items/:id/stock')).toBe(false);
    expect(staffRouteAllowed('POST', '/api/rental/supplies/attachments')).toBe(false);
    expect(staffRouteAllowed('PATCH', '/api/rental/supplies/attachments/:id')).toBe(false);
  });
});

describe('temporary staff using the supplies over the Discord login', () => {
  const savedRange = process.env.SMM_TEMPORARY_STAFF_RANGE;
  let dir: string;
  let rental: RentalStore;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    // The range decides what a staff account is, so it is set before any account state is validated.
    process.env.SMM_TEMPORARY_STAFF_RANGE = RANGE;
    dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-staff-supplies-'));
    writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: {} }));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>common</title>');
    const ctx = setup();
    const password = await new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY }).hash(PASSWORD);
    const uid = `staff:${STAFF_NUMBER}`;
    ctx.store.transact((s) => {
      s.accounts[uid] = {
        accountType: 'temporary_staff',
        initialLoginId: `iy-${STAFF_NUMBER}`,
        guildId: null,
        discordUserId: uid,
        joinEpochMs: null,
        version: 1,
        status: 'active',
        password,
        taskUserId: null,
        existingRoleIds: [],
        issueTimes: [],
        loginFailures: [],
        registrationFailures: [],
        pending: null,
        studentId: STAFF_NUMBER,
        memberVerifiedAt: null,
      };
    });
    rental = new RentalStore(path.join(dir, 'rental'), { demo: true });
    seedRentalDemo(rental);
    app = await buildApp({
      store: new StateStore({ ...(await seedState()), users: [], grants: [] }, null),
      listenPort: TEST_PORT,
      staticDir: dir,
      auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
      discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), audit: ctx.audit, publicOrigin: null, publicHost: null, trustedProxies: new Set() },
      rental: { store: rental, itemOrigin: null, webDir: null },
    });
    const { sessionToken } = await ctx.service.login({ loginId: STAFF_NUMBER, password: PASSWORD });
    cookie = `__Host-iy_session=${sessionToken}`;
  });

  afterEach(async () => {
    await app.close();
    rental.close();
    rmSync(dir, { recursive: true, force: true });
    if (savedRange === undefined) delete process.env.SMM_TEMPORARY_STAFF_RANGE;
    else process.env.SMM_TEMPORARY_STAFF_RANGE = savedRange;
  });

  async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
    const res = await app.inject({
      method,
      url,
      headers: {
        host: TEST_HOST,
        cookie,
        ...(method !== 'GET' ? { origin: ORIGIN, 'x-smm-csrf': '1' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.statusCode, json: res.json() as any };
  }

  it('is a staff account holding rental.loan only', async () => {
    const me = await call('GET', '/api/rental/me');
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ temporary_staff: true, permissions: ['rental.loan'] });
  });

  it('reads the supplies and the board, lends, takes back and undoes a loan', async () => {
    const snap = await call('GET', '/api/rental/supplies');
    expect(snap.status).toBe(200);
    expect((await call('GET', `/api/rental/supplies/board?group=${encodeURIComponent(GROUP)}`)).status).toBe(200);
    expect((await call('GET', '/api/rental/supplies/collection')).status).toBe(200);
    expect((await call('GET', '/api/rental/supplies/shortages')).status).toBe(200);

    const item = snap.json.items.find((i: { kind: string }) => i.kind === 'lend') as { id: string; version: number; on_hand: number; attachments: { id: string; expected_per_unit: number }[] };
    const attachments = (n: number) => item.attachments.map((a) => ({ attachment_id: a.id, found: a.expected_per_unit * n }));
    const lend = await call('POST', '/api/rental/supplies/lend', { id: randomUUID(), group: GROUP, lines: [{ item_id: item.id, qty: 2, expected_version: item.version, attachments: attachments(2) }] });
    expect(lend.status).toBe(200);
    expect(lend.json.lines[0].on_hand).toBe(item.on_hand - 2);

    const back = await call('POST', '/api/rental/supplies/return', { id: randomUUID(), group: GROUP, lines: [{ item_id: item.id, qty: 1, expected_version: lend.json.lines[0].version, attachments: attachments(1) }] });
    expect(back.status).toBe(200);

    const moves = await call('GET', `/api/rental/supplies/movements?item_id=${item.id}`);
    expect(moves.status).toBe(200);
    const returned = moves.json.movements.find((m: { kind: string }) => m.kind === 'return');
    const undo = await call('POST', `/api/rental/supplies/movements/${returned.id}/reverse`, { reason: '数え間違い', expected_version: back.json.lines[0].version });
    expect(undo.status).toBe(200);
  });

  it('uses up a consumable', async () => {
    const snap = await call('GET', '/api/rental/supplies');
    const item = snap.json.items.find((i: { kind: string; on_hand: number }) => i.kind === 'consumable' && i.on_hand > 0);
    const used = await call('POST', '/api/rental/supplies/consume', { id: randomUUID(), item_id: item.id, qty: 1, expected_version: item.version });
    expect(used.status).toBe(200);
    expect(used.json.on_hand).toBe(item.on_hand - 1);
  });

  it('is refused the definitions before they reach the rental permission check', async () => {
    const snap = await call('GET', '/api/rental/supplies');
    const item = snap.json.items[0] as { id: string; version: number };
    for (const [method, url, body] of [
      ['POST', '/api/rental/supplies/items', { name: '試験 椅子', unit: '脚', kind: 'lend' }],
      ['PATCH', `/api/rental/supplies/items/${item.id}`, { name: '試験', expected_version: item.version }],
      ['POST', `/api/rental/supplies/items/${item.id}/stock`, { delta: 1, expected_version: item.version }],
      ['POST', '/api/rental/supplies/attachments', { owner_kind: 'supply', owner_key: item.id, name: '試験', expected: 1 }],
    ] as const) {
      const res = await call(method, url, body);
      expect(res.status).toBe(403);
      expect(res.json.message).toContain('物品の貸出・返却・随時チェック専用');
    }
  });
});
