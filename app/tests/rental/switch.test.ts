import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { RentalSwitch } from '../../src/server/rental/switch.js';
import { ADMIN, EDITOR_A, seedState, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';

// 設定 › 使う機能 (2026-11-09): stopping rental for a while, without touching the ledger.
let dir: string;
let store: RentalStore;
let app: FastifyInstance;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rental-switch-'));
  store = new RentalStore(dir, { demo: true });
  seedRentalDemo(store);
  app = await buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT, rental: { store, itemOrigin: null, webDir: null, allMembersAdmin: true } });
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(url: string, user: string | null = ADMIN, method: 'GET' | 'PUT' | 'POST' = 'GET', body?: unknown) {
  return app.inject({
    url,
    method,
    headers: { host: TEST_HOST, ...(user ? { cookie: `${SESSION_COOKIE}=${user}` } : {}), ...(body === undefined ? {} : { origin: `http://${TEST_HOST}`, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
const setSwitch = (enabled: unknown, user = ADMIN) => call('/api/rental/admin/switch', user, 'PUT', { enabled });
const ledger = () => JSON.stringify([store.db.prepare('SELECT * FROM items ORDER BY code').all(), store.db.prepare('SELECT * FROM operations ORDER BY id').all(), store.db.prepare('SELECT * FROM borrowers ORDER BY name').all()]);

describe('the rental switch', () => {
  it('is in use when nothing was stored, and reading it writes nothing', async () => {
    const me = await call('/api/rental/me', VIEWER_B);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ enabled: true });
    const read = await call('/api/rental/admin/switch');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ enabled: true, history: [], loaned: expect.any(Number), review: expect.any(Number) });
    expect(store.db.prepare("SELECT * FROM config WHERE key='rental_enabled'").all()).toEqual([]);
    expect((await call('/api/rental/summary', VIEWER_B)).statusCode).toBe(200);
  });

  it('is changed by access administrators only', async () => {
    expect((await call('/api/rental/admin/switch', null)).statusCode).toBe(401);
    // Everyone administers rental here (allMembersAdmin), yet the switch stays with the access administrators.
    expect((await call('/api/rental/admin/switch', VIEWER_B)).statusCode).toBe(403);
    expect((await setSwitch(false, EDITOR_A)).statusCode).toBe(403);
    expect(new RentalSwitch(store).enabled()).toBe(true);
    expect((await setSwitch('off')).statusCode).toBe(400);
    expect(new RentalSwitch(store).enabled()).toBe(true);
  });

  it('stops every rental request but /me and the settings, and keeps the ledger', async () => {
    const before = ledger();
    const stopped = await setSwitch(false);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ enabled: false, history: [{ enabled: false, actorName: expect.any(String) }] });

    const me = await call('/api/rental/me', VIEWER_B);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ enabled: false });
    for (const url of ['/api/rental/summary', '/api/rental/overview', '/api/rental/borrowers', '/api/rental/supplies', '/api/rental/issuer/state']) {
      const res = await call(url, VIEWER_B);
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toMatchObject({ code: 'rental_paused' });
    }
    const write = await call('/api/rental/borrowers', VIEWER_B, 'POST', { name: '合成の団体' });
    expect(write.statusCode).toBe(503);
    expect(write.json()).toMatchObject({ code: 'rental_paused' });

    // The settings stay usable: the switch to start again, and the grants prepared meanwhile.
    expect((await call('/api/rental/admin/switch')).json()).toMatchObject({ enabled: false });
    const access = await call('/api/rental/admin/access');
    expect(access.statusCode).toBe(200);
    expect((await call('/api/rental/admin/access', ADMIN, 'PUT', { kind: 'policy', allMembersAdmin: false, expectedRevision: access.json().revision })).statusCode).toBe(200);
    expect(ledger()).toBe(before);
  });

  it('records a change once, survives reopening, and starts again as it was', async () => {
    const before = ledger();
    await setSwitch(false);
    expect((await setSwitch(false)).json().history).toHaveLength(1);
    const second = new RentalStore(dir, { demo: true });
    try {
      expect(new RentalSwitch(second).enabled()).toBe(false);
    } finally {
      second.close();
    }
    const started = await setSwitch(true);
    expect(started.json()).toMatchObject({ enabled: true, history: [{ enabled: true }, { enabled: false }] });
    expect((await call('/api/rental/me', VIEWER_B)).json()).toMatchObject({ enabled: true });
    expect((await call('/api/rental/summary', VIEWER_B)).statusCode).toBe(200);
    expect(ledger()).toBe(before);
  });

  it('answers 404 where rental is not set up, so the settings leave the part out', async () => {
    await app.close();
    app = await buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT });
    expect((await call('/api/rental/admin/switch')).statusCode).toBe(404);
  });
});
