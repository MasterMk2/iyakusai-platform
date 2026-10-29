import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { EDITOR_C, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { setup } from '../discord-auth/helpers.js';
import { BLUE, metadata, RED } from './helpers.js';

// The sync routes inside the app with the Discord login, as in production: the Apps Script's requests
// pass the transport/Origin gate (its report is a server-to-server POST) and reach the signature check.

const KEY = randomBytes(32);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

let dir: string;
let store: RentalStore;
let app: FastifyInstance;

async function discordApp(driveSyncKey: Buffer | null) {
  const ctx = setup();
  return buildApp({
    store: new StateStore({ ...(await seedState()), users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    rental: { store, itemOrigin: 'https://app.example.invalid', webDir: null, driveSyncKey },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rental-drive-http-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: {} }));
  store = new RentalStore(path.join(dir, 'rental'), { driveSync: true });
  store.addItems([['IY-100123', '長机']]);
  store.addBorrowers(['模擬店A']);
  app = await discordApp(KEY);
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function headers(method: string, url: string, body: Buffer) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString('base64url');
  const text = ['svc-auth/v1', 'rental-drive-sync', method, url, timestamp, nonce, '', sha256(body)].join('\n');
  return { 'x-svc-client': 'rental-drive-sync', 'x-svc-timestamp': timestamp, 'x-svc-nonce': nonce, 'x-svc-signature': createHmac('sha256', KEY).update(text).digest('hex') };
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: TEST_HOST, ...headers('GET', url, Buffer.alloc(0)) } });

function post(value: unknown, extra: Record<string, string> = {}, sign = true) {
  const body = Buffer.from(JSON.stringify(value));
  return app.inject({ method: 'POST', url: '/v1/rental/sync/ack', headers: { host: TEST_HOST, 'content-type': 'application/json', ...(sign ? headers('POST', '/v1/rental/sync/ack', body) : {}), ...extra }, payload: body });
}

describe('sync routes with the Discord login', () => {
  it('lists, serves and records a copy end to end', async () => {
    const receipt = store.submit(metadata({ item_code: 'IY-100123', borrower: '模擬店A' }), [RED, BLUE], { id: 'iy-00000001', name: '試験 太郎' });
    const listed = await get('/v1/rental/sync/pending?limit=10');
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const [op] = listed.json().operations as { operation_id: string; files: { idx: number; sha256: string; size: number }[] }[];
    expect(op!.operation_id).toBe(receipt.operation_id);

    const photo = await get(`/v1/rental/sync/file?op=${receipt.operation_id}&idx=1`);
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.headers['x-content-sha256']).toBe(sha256(RED));
    expect(photo.rawPayload.equals(RED)).toBe(true);

    const saved = await post({ operation_id: op!.operation_id, saved: op!.files.map((f) => ({ idx: f.idx, drive_id: `drivefile0000${f.idx}`, sha256: f.sha256, size: f.size })) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ status: 'complete', drive_synced_count: 2 });
  });

  it('refuses a report without a signature or from a browser, at the signature check', async () => {
    const receipt = store.submit(metadata({ item_code: 'IY-100123', borrower: '模擬店A' }), [RED, BLUE], { id: 'iy-00000001', name: '試験 太郎' });
    expect((await post({ operation_id: receipt.operation_id, saved: [] }, {}, false)).statusCode).toBe(401);
    expect((await post({ operation_id: receipt.operation_id, saved: [] }, { origin: 'https://app.example.invalid' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/rental/sync/pending?limit=10', headers: { host: TEST_HOST } })).statusCode).toBe(401);
    expect(store.operation(receipt.operation_id).status).toBe('drive_pending');
  });

  it('is not mounted without the key', async () => {
    await app.close();
    app = await discordApp(null);
    expect((await get('/v1/rental/sync/pending?limit=10')).statusCode).toBe(404);
  });
});

describe('information tab', () => {
  it('tells the phones how the copy is doing', async () => {
    await app.close();
    store.close();
    store = new RentalStore(path.join(dir, 'demo'), { demo: true, driveSync: true });
    seedRentalDemo(store);
    app = await buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT, rental: { store, itemOrigin: null, webDir: null } });
    const res = await app.inject({ method: 'GET', url: '/api/rental/overview', headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${EDITOR_C}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().drive_sync).toEqual({ enabled: true, waiting: 0, errors: 0, last_seen_at: null, last_saved_at: null });
  });

  it('hands the print sheet the return-place rules kept beside the ledger, and none when there is no file', async () => {
    await app.close();
    store.close();
    store = new RentalStore(path.join(dir, 'demo'), { demo: true });
    seedRentalDemo(store);
    app = await buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT, rental: { store, itemOrigin: null, webDir: null } });
    const overview = async () => (await app.inject({ method: 'GET', url: '/api/rental/overview', headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${EDITOR_C}` } })).json();
    expect((await overview()).print_rules).toBeNull();
    const rules = [{ field: 'owner', value: '貸出サンプル商会', location: '正門横の倉庫' }];
    writeFileSync(path.join(store.root, 'print-rules.json'), JSON.stringify(rules));
    expect((await overview()).print_rules).toEqual(rules);
    writeFileSync(path.join(store.root, 'print-rules.json'), '{ broken');
    expect((await overview()).print_rules).toBeNull();
  });

  it('accepts a loan from the phone as waiting for Drive (202), which the phone counts as accepted', async () => {
    await app.close();
    store.close();
    store = new RentalStore(path.join(dir, 'demo'), { demo: true, driveSync: true });
    seedRentalDemo(store);
    app = await buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT, rental: { store, itemOrigin: null, webDir: null } });
    const me = await app.inject({ method: 'GET', url: '/api/rental/me', headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${EDITOR_C}` } });
    expect(me.json()).toMatchObject({ mode: 'drive' });
    const boundary = `TestBoundary${randomBytes(8).toString('hex')}`;
    const meta = metadata();
    const CRLF = '\r\n';
    const parts = [Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="metadata"${CRLF}${CRLF}${JSON.stringify(meta)}${CRLF}`)];
    for (const photo of [RED, BLUE]) parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="photos"; filename="photo.jpg"${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}`), photo, Buffer.from(CRLF));
    parts.push(Buffer.from(`--${boundary}--${CRLF}`));
    const res = await app.inject({
      method: 'POST',
      url: '/api/rental/operations',
      headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${EDITOR_C}`, origin: `http://${TEST_HOST}`, 'x-smm-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ operation_id: meta.operation_id, status: 'drive_pending', photos_count: 2, drive_synced_count: 0 });
  });

  it('refuses the key outside the Discord login', async () => {
    await expect(buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT, rental: { store, itemOrigin: null, webDir: null, driveSyncKey: KEY } })).rejects.toThrow(/discord/);
  });
});
