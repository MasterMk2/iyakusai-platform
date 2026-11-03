import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { EDITOR_A, EDITOR_C, seedState, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';

// The supply API and screen through the common app (demo login). u-editor-a may define and lend,
// u-editor-c may only lend, return and use up, u-viewer-b has no rental permission at all.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const GROUP = '試用 模擬店A';
let dir: string;
let store: RentalStore;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-supplies-http-'));
  store = new RentalStore(dir, { demo: true });
  seedRentalDemo(store);
  app = await buildApp({
    store: new StateStore(await seedState(), null),
    listenPort: TEST_PORT,
    rental: { store, itemOrigin: null, webDir: path.join(ROOT, 'src', 'rental-web') },
  });
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  user?: string | null;
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  origin?: string | null;
}

async function call(url: string, { user = EDITOR_A, method = 'GET', body, origin = `http://${TEST_HOST}` }: Call = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(user ? { cookie: `${SESSION_COOKIE}=${user}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(origin && method !== 'GET' ? { origin } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON (the screen files)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, headers: res.headers, json: json as any, raw: res.rawPayload };
}

interface LendableItem { id: string; version: number; on_hand: number; attachments: { id: string; expected_per_unit: number }[] }

async function firstLendItem(user = EDITOR_A) {
  const snap = await call('/api/rental/supplies', { user });
  const item = snap.json.items.find((i: { kind: string }) => i.kind === 'lend');
  return item as LendableItem;
}

/** One line of a lend: the attachments of the item are counted as present (the screen prefills the same numbers). */
function lendLine(item: LendableItem, qty: number) {
  return {
    item_id: item.id,
    qty,
    expected_version: item.version,
    attachments: item.attachments.map((a) => ({ attachment_id: a.id, found: a.expected_per_unit * qty })),
  };
}

describe('reading the supplies', () => {
  it('answers the signed-in staff with the items, groups and recent groups', async () => {
    const res = await call('/api/rental/supplies');
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBeGreaterThanOrEqual(5);
    expect(res.json.groups).toContain(GROUP);
    expect(res.json.items[0]).toMatchObject({ on_hand: expect.any(Number), version: expect.any(Number), low: expect.any(Boolean) });
  });

  it('refuses a person with no rental permission and a signed-out request', async () => {
    expect((await call('/api/rental/supplies', { user: VIEWER_B })).status).toBe(403);
    expect((await call('/api/rental/supplies', { user: null })).status).toBe(401);
  });

  it('gives the 団体 board for a registered group, and refuses an unregistered one', async () => {
    const board = await call(`/api/rental/supplies/board?group=${encodeURIComponent(GROUP)}`);
    expect(board.status).toBe(200);
    expect(board.json.group).toBe(GROUP);
    expect((await call(`/api/rental/supplies/board?group=${encodeURIComponent('登録されていない団体')}`)).status).toBe(400);
  });
});

describe('writing the supplies', () => {
  it('lets the loan staff lend and return, but not define items or correct stock', async () => {
    const item = await firstLendItem(EDITOR_C);
    const lend = await call('/api/rental/supplies/lend', {
      user: EDITOR_C, method: 'POST', body: { id: randomUUID(), group: GROUP, lines: [lendLine(item, 1)] },
    });
    expect(lend.status).toBe(200);
    expect(lend.json.lines[0].on_hand).toBe(item.on_hand - 1);

    const define = await call('/api/rental/supplies/items', {
      user: EDITOR_C, method: 'POST', body: { name: '試験 椅子', unit: '脚', kind: 'lend' },
    });
    expect(define.status).toBe(403);
    const stock = await call(`/api/rental/supplies/items/${item.id}/stock`, {
      user: EDITOR_C, method: 'POST', body: { delta: 1, expected_version: lend.json.lines[0].version, note: '補充' },
    });
    expect(stock.status).toBe(403);
  });

  it('answers a stale version with 409 and a message the screen can show', async () => {
    const item = await firstLendItem();
    const res = await call('/api/rental/supplies/lend', {
      method: 'POST', body: { id: randomUUID(), group: GROUP, lines: [{ ...lendLine(item, 1), expected_version: item.version + 50 }] },
    });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('version_conflict');
    expect(typeof res.json.error).toBe('string');
  });

  it('answers a lend without a request id with 400, and the same request id with the stored lend', async () => {
    const item = await firstLendItem();
    const without = await call('/api/rental/supplies/lend', {
      method: 'POST', body: { group: GROUP, lines: [lendLine(item, 1)] },
    });
    expect(without.status).toBe(400);
    const body = { id: randomUUID(), group: GROUP, lines: [lendLine(item, 1)] };
    const first = await call('/api/rental/supplies/lend', { method: 'POST', body });
    expect(first.status).toBe(200);
    const again = await call('/api/rental/supplies/lend', { method: 'POST', body });
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
  });

  it('creates an item and an attachment for it with the issue permission', async () => {
    const created = await call('/api/rental/supplies/items', {
      method: 'POST', body: { name: `試験 ${randomUUID().slice(0, 6)}`, unit: '個', kind: 'consumable', low_threshold: 3, initial_on_hand: 8 },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ on_hand: 8, low: false, kind: 'consumable' });
    const att = await call('/api/rental/supplies/attachments', {
      method: 'POST', body: { owner_kind: 'supply', owner_key: created.json.id, name: '替えの芯', expected: 2 },
    });
    expect(att.status).toBe(201);
    const list = await call(`/api/rental/supplies/attachments?owner_kind=supply&owner_key=${created.json.id}`);
    expect(list.json.attachments).toHaveLength(1);
  });

  it('rejects a bad kind, a bad number, and a cross-site change', async () => {
    expect((await call('/api/rental/supplies/items', { method: 'POST', body: { name: '試験', unit: '個', kind: 'x' } })).status).toBe(400);
    expect((await call('/api/rental/supplies/items', { method: 'POST', body: { name: '試験', unit: '個', kind: 'lend', initial_on_hand: '3' } })).status).toBe(400);
    expect((await call('/api/rental/supplies/items', { method: 'POST', origin: 'http://elsewhere.example', body: { name: '試験', unit: '個', kind: 'lend' } })).status).toBe(403);
  });

  it('records a card check once per id, answering the second send with the stored record', async () => {
    const add = await call('/api/rental/supplies/attachments', { method: 'POST', body: { owner_kind: 'card', owner_key: 'IY-000123', name: '試験バンド', expected: 2 } });
    expect(add.status).toBe(201);
    const attachments = await call('/api/rental/supplies/attachments?owner_kind=card&owner_key=IY-000123');
    // Every attachment of the card is checked in one record: the demo band (3) and the test band (2 here).
    const lines = attachments.json.attachments.map((a: { id: string; name: string }) => ({
      attachment_id: a.id, found: a.name === '試験バンド' ? 1 : 3, note: a.name === '試験バンド' ? '1 本ない' : '',
    }));
    const id = randomUUID();
    const body = { id, owner_kind: 'card', owner_key: 'IY-000123', phase: 'check', lines };
    const first = await call('/api/rental/supplies/attachment-checks', { method: 'POST', body });
    expect(first.status).toBe(201);
    expect(first.json.missing_total).toBe(1);
    expect(first.json.lines.find((l: { name: string }) => l.name === '試験バンド')).toMatchObject({ expected: 2, found: 1, missing: 1 });
    const replay = await call('/api/rental/supplies/attachment-checks', { method: 'POST', body });
    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(id);
    const shortages = await call('/api/rental/supplies/shortages');
    expect(shortages.json.shortages.some((s: { owner_key: string }) => s.owner_key === 'IY-000123')).toBe(true);
  });

  it('undoes a loan through the API and refuses the second undo', async () => {
    const item = await firstLendItem();
    const lend = await call('/api/rental/supplies/lend', {
      method: 'POST', body: { id: randomUUID(), group: GROUP, lines: [lendLine(item, 1)] },
    });
    const movements = await call(`/api/rental/supplies/movements?item_id=${item.id}`);
    const record = movements.json.movements.find((m: { kind: string }) => m.kind === 'lend');
    const undo = await call(`/api/rental/supplies/movements/${record.id}/reverse`, {
      method: 'POST', body: { reason: '入力の誤り', expected_version: lend.json.lines[0].version },
    });
    expect(undo.status).toBe(200);
    expect(undo.json.on_hand).toBe(item.on_hand);
    const again = await call(`/api/rental/supplies/movements/${record.id}/reverse`, {
      method: 'POST', body: { reason: 'もう一度', expected_version: undo.json.version },
    });
    expect(again.status).toBe(409);
  });
});

describe('the supply screen', () => {
  it('serves the page with the rental security headers and its script and style files', async () => {
    const page = await call('/rental/supplies', { user: null });
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toContain('text/html');
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(page.raw)).toContain('<html');
    const script = await call('/rental/supplies.js', { user: null });
    expect(script.status).toBe(200);
    expect(String(script.headers['content-type'])).toContain('javascript');
    expect((await call('/rental/supplies.css', { user: null })).status).toBe(200);
  });
});
