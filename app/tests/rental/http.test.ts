import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { canonical } from '../../src/server/rental/validate.js';
import { ADMIN, EDITOR_A, EDITOR_C, seedState, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';
import { BLUE, metadata, RED, variant } from './helpers.js';

// The rental API and phone screen inside the common app (demo login). Port of the HTTP cases of
// reference/rental-python/server/test_backend.py, with the common account and rental permissions in
// place of staff codes: u-editor-a may lend and issue, u-editor-c may only lend, u-viewer-b has neither.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let dir: string;
let store: RentalStore;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rental-http-'));
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
  method?: 'GET' | 'POST' | 'PUT';
  body?: string | Buffer;
  type?: string;
  origin?: string | null;
  headers?: Record<string, string>;
}

async function call(url: string, { user = EDITOR_A, method = 'GET', body, type = 'application/json', origin = `http://${TEST_HOST}`, headers = {} }: Call = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(user ? { cookie: `${SESSION_COOKIE}=${user}` } : {}),
      ...(body !== undefined ? { 'content-type': type } : {}),
      ...(origin && method !== 'GET' ? { origin } : {}),
      ...headers,
    },
    ...(body !== undefined ? { payload: body } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, headers: res.headers, json: json as any, raw: res.rawPayload };
}

function multipart(meta: Record<string, unknown>, photos: Buffer[]): { body: Buffer; type: string } {
  const boundary = `TestBoundary${randomUUID().replaceAll('-', '')}`;
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n`), Buffer.from(canonical(meta)), Buffer.from('\r\n')];
  for (const photo of photos) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), photo, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

describe('desktop issuer management over the authenticated API', () => {
  it('negotiates a three digit force-reset code and checks it on the server', async()=>{
    store.setPermissions(ADMIN,['rental.issue'],{id:ADMIN,name:'管理者'});
    expect((await call('/api/rental/me',{user:ADMIN})).json.capabilities).toContain('issuer_reset_code_v1');
    const p=await call('/api/rental/issuer/preview',{user:ADMIN,method:'POST',body:JSON.stringify({mode:'force_reset_all',confirmation_style:'digits3'})});
    expect(p.status).toBe(200);expect(p.json.confirmation_code).toMatch(/^[1-9][0-9]{2}$/);
    const payload={token:p.json.token,all_writers_stopped:true,confirmation:'連番と重複防止を含めて初期化'};
    expect((await call('/api/rental/issuer/apply',{user:ADMIN,method:'POST',body:JSON.stringify(payload)})).status).toBe(400);
    const reset=await call('/api/rental/issuer/apply',{user:ADMIN,method:'POST',body:JSON.stringify({...payload,confirmation:p.json.confirmation_code})});
    expect(reset.status).toBe(200);expect(reset.json.ledger_generation).toBe(1);
  });
  it('resets numbering only with its own mode, then rejects old desktop generations', async()=>{
    store.setPermissions(ADMIN,['rental.issue'],{id:ADMIN,name:'管理者'});
    const p=await call('/api/rental/issuer/preview',{user:ADMIN,method:'POST',body:JSON.stringify({mode:'force_reset_all'})});
    expect(p.status).toBe(200);
    const reset=await call('/api/rental/issuer/apply',{user:ADMIN,method:'POST',body:JSON.stringify({token:p.json.token,all_writers_stopped:true,confirmation:'連番と重複防止を含めて初期化'})});
    expect(reset.status).toBe(200);expect(reset.json).toMatchObject({reserved_through:100000,ledger_generation:1});
    expect((await call('/api/rental/me',{user:ADMIN})).json.capabilities).toContain('issuer_numbering_reset_v1');
    for(const route of ['/api/rental/issuer/preview','/api/rental/card-history/import','/api/rental/card-history/claim','/api/rental/preassignments'])
      expect((await call(route,{user:ADMIN,method:'POST',body:'{}'})).json.code).toBe('ledger_reset');
    const fresh=await call('/api/rental/issuer/preview',{user:ADMIN,method:'POST',headers:{'x-rental-generation':'1'},body:JSON.stringify({mode:'update',items:[{code:'IY-100001',name:'New generation',url:'https://app.example.test/i/IY-100001',borrower_name:'Synthetic'}]})});
    expect(fresh.status).toBe(200);
  });
  const row = { code: 'IY-100001', name: '検証用の机', url: 'https://app.example.test/i/IY-100001', borrower_name: '試用 本部', item_scope: '学内' };
  it('allows issuer reading but refuses anonymous, viewer, and loan-only accounts', async () => {
    for (const [user, status] of [[null, 401], [VIEWER_B, 403], [EDITOR_C, 403], [EDITOR_A, 200]] as const) {
      expect((await call('/api/rental/issuer/state', { user })).status).toBe(status);
    }
    expect((await call('/api/rental/me')).json.capabilities).toContain('issuer_management_v1');
  });
  it('creates a preview, enforces origin and ownership, and applies only the stored proposal', async () => {
    const p = await call('/api/rental/issuer/preview', { method: 'POST', body: JSON.stringify({ mode: 'overwrite', items: [row] }) });
    expect(p.status).toBe(200);
    expect(p.json.changed_count).toBe(1);
    const body = JSON.stringify({ token: p.json.token, confirmation: '上書きを実行', items: [{ ...row, name: '差し替え' }] });
    expect((await call('/api/rental/issuer/apply', { method: 'POST', body, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/rental/issuer/apply', { user: EDITOR_C, method: 'POST', body })).status).toBe(403);
    const result = await call('/api/rental/issuer/apply', { method: 'POST', body });
    expect(result.status).toBe(200);
    expect(result.json.items.find((i: { code: string }) => i.code === row.code).name).toBe(row.name);
    expect((await call('/api/rental/issuer/apply', { method: 'POST', body })).status).toBe(409);
  });
  it('reserves reset for an administrator who also has issuing permission', async () => {
    const body = JSON.stringify({ mode: 'reset' });
    expect((await call('/api/rental/issuer/preview', { method: 'POST', body })).status).toBe(403);
    store.setPermissions(ADMIN, ['rental.issue'], { id: ADMIN, name: '試験管理者' });
    expect((await call('/api/rental/issuer/state', { user: ADMIN })).json.reset_allowed).toBe(true);
    const p = await call('/api/rental/issuer/preview', { user: ADMIN, method: 'POST', body });
    expect(p.status).toBe(200);
    expect((await call('/api/rental/issuer/apply', { user: ADMIN, method: 'POST', body: JSON.stringify({ token: p.json.token, confirmation: '物品台帳をリセット' }) })).status).toBe(200);
    expect((await call('/api/rental/overview')).json.items).toEqual([]);
    expect((await call('/api/rental/items/IY-000123')).status).toBe(410);
  });
  it('enforces authentication, issuing permission, administrator access and Origin for forced reset', async () => {
    expect((await call('/api/rental/me')).json.capabilities).toContain('issuer_force_reset_v1');
    const body = JSON.stringify({ mode: 'force_reset' });
    for (const [user, status] of [[null,401],[VIEWER_B,403],[EDITOR_C,403],[EDITOR_A,403]] as const)
      expect((await call('/api/rental/issuer/preview',{ user,method:'POST',body })).status).toBe(status);
    store.setPermissions(ADMIN,['rental.issue'],{id:ADMIN,name:'管理者'});
    store.db.prepare("UPDATE items SET status='loaned' WHERE code='IY-000123'").run();
    const p = await call('/api/rental/issuer/preview',{user:ADMIN,method:'POST',body});
    expect(p.json).toMatchObject({ mode:'force_reset',blocked_count:0,reset_counts:{loaned:1} });
    const applyBody = JSON.stringify({token:p.json.token,confirmation:'物品台帳を強制リセット'});
    expect((await call('/api/rental/issuer/apply',{user:ADMIN,method:'POST',body:applyBody,origin:'https://evil.example'})).status).toBe(403);
    expect((await call('/api/rental/issuer/apply',{user:EDITOR_A,method:'POST',body:applyBody})).status).toBe(409);
    const result = await call('/api/rental/issuer/apply',{user:ADMIN,method:'POST',body:applyBody});
    expect(result.status).toBe(200);
    expect(result.json.items).toEqual([]);
    expect((await call('/api/rental/items/IY-000123')).status).toBe(410);
  });
});
function ledgerSnapshot(): string {
  const db = new DatabaseSync(path.join(dir, 'rental.sqlite3'), { readOnly: true });
  try {
    return JSON.stringify(['items', 'borrowers', 'operations', 'files', 'issuance', 'preassignment_events', 'item_metadata_events', 'grants', 'issuer_management_events'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  } finally { db.close(); }
}

describe('sign-in and rental permissions', () => {
  it('requires the common login and an explicit rental permission', async () => {
    const anonymous = await call('/api/rental/items/IY-000123', { user: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.json.code).toBe('unauthorized');
    const viewer = await call('/api/rental/me', { user: VIEWER_B });
    expect(viewer.status).toBe(200);
    expect(viewer.json.permissions).toEqual([]);
    expect((await call('/api/rental/borrowers', { user: VIEWER_B })).status).toBe(403);
    const editor = await call('/api/rental/me');
    expect(editor.json).toMatchObject({ staff: { id: EDITOR_A }, permissions: ['rental.issue', 'rental.loan'], mode: 'local' });
  });

  it('lets only the access administrator change rental permissions', async () => {
    const put = (user: string, target: string, permissions: string[]) => call(`/api/rental/admin/permissions/${target}`, { user, method: 'PUT', body: JSON.stringify({ permissions }) });
    expect((await put(EDITOR_A, VIEWER_B, ['rental.loan'])).status).toBe(403);
    expect((await put(ADMIN, 'u-nobody', ['rental.loan'])).status).toBe(404);
    expect((await put(ADMIN, VIEWER_B, ['rental.unknown'])).status).toBe(400);
    const granted = await put(ADMIN, VIEWER_B, ['rental.loan']);
    expect(granted.json).toEqual({ userId: VIEWER_B, permissions: ['rental.loan'] });
    expect((await call('/api/rental/borrowers', { user: VIEWER_B })).status).toBe(200);
    expect((await call('/api/rental/admin/permissions', { user: ADMIN })).json.accounts).toContainEqual({ userId: VIEWER_B, permissions: ['rental.loan'] });
  });
});

describe('loans through HTTP', () => {
  it('inspects the loan condition, photos and current group quantities without writing a loan or return', async () => {
    store.addItems([['IY-100001', '椅子'], ['IY-100002', '椅子'], ['IY-100003', '椅子'], ['IY-100004', '椅子']]);
    const actor = { id: EDITOR_C, name: '試験スタッフ' };
    const loan = metadata({ condition: 'damage', note: '貸出前から脚に傷' });
    store.submit(loan, [RED, BLUE], actor);
    for (const code of ['IY-100001', 'IY-100002', 'IY-100003']) store.submit(metadata({ item_code: code, photo_skip: true }), [], actor);
    store.submit(metadata({ item_code: 'IY-100003', item_version: 1, action: 'return', borrower: '' }), [], actor);
    store.submit(metadata({ item_code: 'IY-100004', borrower: '試用 模擬店B', photo_skip: true }), [], actor);
    const before = store.item('IY-000123');
    const overview = store.overview().items;
    const receipt = store.operation(loan.operation_id);
    const ledger = ledgerSnapshot();
    const result = await call('/api/rental/items/IY-000123/inspection');
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json.loan).toMatchObject({ active: true, condition: 'damage', note: '貸出前から脚に傷', photos: [{ index: 1 }, { index: 2 }] });
    expect(result.json.group).toMatchObject({ source: 'current', name: '試用 模擬店A', loaned_total: 3 });
    expect(result.json.group.inventory).toContainEqual({ name: '椅子', item_scope: '', item_owner: '', quantity: 2, codes: ['IY-100001', 'IY-100002'] });
    expect(result.json.group.items.map((item: { code: string }) => item.code)).not.toContain('IY-100003');
    expect(result.json.group.items.map((item: { code: string }) => item.code)).not.toContain('IY-100004');
    const photo = await call(result.json.loan.photos[0].url);
    expect(photo.status).toBe(200); expect(photo.raw).toEqual(RED); expect(photo.headers['cache-control']).toBe('no-store');
    expect(store.item('IY-000123')).toEqual(before);
    expect(store.overview().items).toEqual(overview);
    expect(store.operation(loan.operation_id)).toEqual(receipt);
    expect(ledgerSnapshot()).toEqual(ledger);
  });

  it('labels a returned item with its last loan and shows no current loan for unborrowed items', async () => {
    const actor = { id: EDITOR_C, name: '試験スタッフ' };
    expect((await call('/api/rental/items/IY-000123/inspection')).json).toMatchObject({ loan: null, group: null });
    store.submit(metadata({ photo_skip: true, note: '付属品確認済み' }), [], actor);
    store.submit(metadata({ action: 'return', item_version: 1, borrower: '' }), [], actor);
    const result = await call('/api/rental/items/IY-000123/inspection');
    expect(result.json).toMatchObject({ item: { status: 'ready', version: 2 }, loan: { active: false, condition: 'normal', note: '付属品確認済み', photo_skip: true, photos: [] }, group: { source: 'last_loan', loaned_total: 0 } });
  });

  it('uses the actual group for an active loan even when a different group was planned', async () => {
    const actor = { id: EDITOR_C, name: '試験スタッフ' };
    const group = store.borrowerGroups().find((g) => g.name === '試用 模擬店B')!;
    store.preassign([{ code: 'IY-000123', name: '試用 延長コード', url: 'https://example.invalid/i/IY-000123', borrower_id: group.id }], actor, null);
    expect((await call('/api/rental/items/IY-000123/inspection')).json).toMatchObject({ loan: null, group: { source: 'planned', name: '試用 模擬店B', loaned_total: 0 } });
    store.submit(metadata({ item_version: 1, photo_skip: true }), [], actor);
    expect((await call('/api/rental/items/IY-000123/inspection')).json.group).toMatchObject({ source: 'current', name: '試用 模擬店A', loaned_total: 1 });
  });

  it('requires rental read permission for inspections and photos and never serves operation JSON as a photo', async () => {
    const loan = metadata(); store.submit(loan, [RED, BLUE], { id: EDITOR_C, name: '試験スタッフ' });
    const base = `/api/rental/operations/${String(loan.operation_id)}/photos`;
    for (const url of ['/api/rental/items/IY-000123/inspection', `${base}/1`]) {
      expect((await call(url, { user: null })).status).toBe(401);
      expect((await call(url, { user: VIEWER_B })).status).toBe(403);
    }
    for (const index of ['0', '-1', '6', '1.0', 'abc']) expect((await call(`${base}/${index}`)).status).toBe(404);
    expect((await call('/api/rental/items/IY-MISSING/inspection')).status).toBe(404);
    expect((await call('/api/rental/operations/invalid/photos/1')).status).toBe(400);
  });

  it('keeps quantities separate for identically named items with different owners or scopes', async () => {
    const actor = { id: EDITOR_C, name: '試験スタッフ' };
    const group = store.borrowerGroups().find((g) => g.name === '試用 模擬店A')!;
    store.preassign([
      { code: 'IY-100001', name: '椅子', url: 'https://example.invalid/i/IY-100001', borrower_id: group.id, item_scope: '学内', item_owner: '大学' },
      { code: 'IY-100002', name: '椅子', url: 'https://example.invalid/i/IY-100002', borrower_id: group.id, item_scope: '学外', item_owner: '試験レンタル会社' },
    ], actor, null);
    for (const code of ['IY-100001', 'IY-100002']) store.submit(metadata({ item_code: code, item_version: 1, photo_skip: true }), code === 'IY-100002' ? [RED] : [], actor);
    const result = await call('/api/rental/items/IY-100001/inspection');
    expect(result.json.group.loaned_total).toBe(2);
    expect(result.json.group.inventory).toEqual([
      { name: '椅子', item_scope: '学内', item_owner: '大学', quantity: 1, codes: ['IY-100001'] },
      { name: '椅子', item_scope: '学外', item_owner: '試験レンタル会社', quantity: 1, codes: ['IY-100002'] },
    ]);
  });

  it('excludes archived items from group quantities and rejects reading their old cards', async () => {
    const actor = { id: EDITOR_C, name: '試験スタッフ' };
    store.submit(metadata({ photo_skip: true }), [], actor);
    store.submit(metadata({ item_code: 'IY-000124', photo_skip: true }), [], actor);
    // A retained historical row must not be counted, even if an older import left a loan state on it.
    store.db.prepare('UPDATE items SET archived_at=? WHERE code=?').run('2026-10-14T00:00:00Z', 'IY-000124');
    expect((await call('/api/rental/items/IY-000123/inspection')).json.group.loaned_total).toBe(1);
    expect((await call('/api/rental/items/IY-000124/inspection')).status).toBe(410);
  });

  it('commits a multipart loan, answers the receipt, replays it and rejects a changed resend', async () => {
    const meta = metadata();
    const { body, type } = multipart(meta, [RED, BLUE]);
    const first = await call('/api/rental/operations', { user: EDITOR_C, method: 'POST', body, type });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ photos_count: 2, status: 'local_saved', action: 'borrow' });
    expect((await call(`/api/rental/operations/${meta.operation_id}`, { user: EDITOR_C })).json).toEqual(first.json);
    expect((await call('/api/rental/operations', { user: EDITOR_C, method: 'POST', body, type })).json).toEqual(first.json);
    const changed = multipart({ ...meta, note: 'different' }, [RED, BLUE]);
    expect((await call('/api/rental/operations', { user: EDITOR_C, method: 'POST', body: changed.body, type: changed.type })).status).toBe(409);
    const item = await call('/api/rental/items/IY-000123', { user: EDITOR_C });
    expect(item.json).toMatchObject({ status: 'loaned', current_loan: { actor: { id: EDITOR_C } } });
  });

  it('summarises item states, open loans per group and items to check for the home screen', async () => {
    expect((await call('/api/rental/summary', { user: VIEWER_B })).status).toBe(403);
    expect((await call('/api/rental/summary')).json).toEqual({ total: 2, counts: { ready: 2, loaned: 0, review: 0 }, planned: 0, loanedByGroup: [], review: [] });
    const loan = multipart(metadata(), [RED, BLUE]);
    expect((await call('/api/rental/operations', { user: EDITOR_C, method: 'POST', body: loan.body, type: loan.type })).status).toBe(200);
    const lent = (await call('/api/rental/summary', { user: EDITOR_C })).json;
    expect(lent).toMatchObject({ counts: { ready: 1, loaned: 1, review: 0 }, loanedByGroup: [{ borrower: '試用 模擬店A', loaned: 1 }] });
    expect(lent.loanedByGroup[0].since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const back = multipart(metadata({ action: 'return', item_version: 1, borrower: '', condition: 'damage', note: '脚が曲がっている' }), [RED]);
    expect((await call('/api/rental/operations', { user: EDITOR_C, method: 'POST', body: back.body, type: back.type })).status).toBe(200);
    expect((await call('/api/rental/summary', { user: EDITOR_C })).json).toMatchObject({
      counts: { ready: 1, loaned: 0, review: 1 },
      loanedByGroup: [],
      review: [{ code: 'IY-000123', name: '試用 延長コード' }],
    });
  });

  it('needs the loan permission, five photos at most and two megabytes per photo', async () => {
    const { body, type } = multipart(metadata(), [RED, BLUE]);
    expect((await call('/api/rental/operations', { user: VIEWER_B, method: 'POST', body, type })).status).toBe(403);
    const six = multipart(metadata(), Array.from({ length: 6 }, (_, i) => variant(`p${i}`)));
    expect((await call('/api/rental/operations', { method: 'POST', body: six.body, type: six.type })).status).toBe(413);
    const huge = multipart(metadata(), [variant('x'.repeat(10), Buffer.concat([RED, Buffer.alloc(2 * 1024 * 1024)])), BLUE]);
    expect((await call('/api/rental/operations', { method: 'POST', body: huge.body, type: huge.type })).status).toBe(413);
    expect((await call('/api/rental/operations', { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await call('/api/rental/items/IY-000123')).json.version).toBe(0);
  });

  it('refuses writes from another origin before anything runs', async () => {
    const { body, type } = multipart(metadata(), [RED, BLUE]);
    expect((await call('/api/rental/operations', { method: 'POST', body, type, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/rental/borrowers', { method: 'POST', body: JSON.stringify({ name: '外部' }), origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/rental/items/IY-000123')).json.version).toBe(0);
  });
});

describe('planned borrowers through HTTP', () => {
  it('creates groups once, needs the issue permission to plan, and the plan is read with the item', async () => {
    const first = await call('/api/rental/borrowers', { method: 'POST', body: JSON.stringify({ name: '新規団体' }) });
    expect(first.status).toBe(201);
    expect(first.json.created).toBe(true);
    expect((await call('/api/rental/borrowers', { method: 'POST', body: JSON.stringify({ name: ' 新規団体 ' }) })).json.borrower).toEqual(first.json.borrower);
    const group = first.json.borrower as { id: string; name: string };
    expect((await call('/api/rental/borrowers')).json.groups).toContainEqual(group);
    const item = { code: 'IY-PLAN-000001', name: '計画用机', item_scope: '学外', item_owner: 'サンプルレンタル', url: 'https://rental.example.jp/i/IY-PLAN-000001', borrower_id: group.id, borrower_name: group.name };
    const payload = JSON.stringify({ items: [item] });
    expect((await call('/api/rental/preassignments', { user: EDITOR_C, method: 'POST', body: payload })).status).toBe(403);
    expect((await call('/api/rental/preassignments', { method: 'POST', body: payload })).status).toBe(200);
    const read = await call(`/api/rental/items/${item.code}`);
    expect((await call('/api/rental/me')).json.capabilities).toContain('item_metadata_v1');
    expect(read.json).toMatchObject({ item_scope: '学外', item_owner: 'サンプルレンタル', planned_borrower_id: group.id, planned_borrower_name: group.name, status: 'ready', current_loan: null, url: item.url });
    expect(store.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
  });
});

describe('information tab through HTTP', () => {
  it('lists every item with its group for anyone holding a rental permission', async () => {
    expect((await call('/api/rental/overview', { user: null })).status).toBe(401);
    expect((await call('/api/rental/overview', { user: VIEWER_B })).status).toBe(403);
    const { body, type } = multipart(metadata({ photo_skip: true }), []);
    expect((await call('/api/rental/operations', { user: EDITOR_C, method: 'POST', body, type })).json).toMatchObject({ action: 'borrow', photos_count: 0 });
    const overview = await call('/api/rental/overview', { user: EDITOR_C });
    expect(overview.status).toBe(200);
    expect(overview.headers['cache-control']).toBe('no-store');
    expect(overview.json.items).toHaveLength(2);
    expect(overview.json.items[0]).toMatchObject({ code: 'IY-000123', phase: 'loaned', group: { name: '試用 模擬店A' }, lent_photo_skip: true });
    expect(overview.json.items[1]).toMatchObject({ code: 'IY-000124', phase: 'unassigned', group: null });
  });
});

describe('phone screen', () => {
  it('has every element its script looks up', () => {
    const html = readFileSync(path.join(ROOT, 'src', 'rental-web', 'index.html'), 'utf8');
    const script = readFileSync(path.join(ROOT, 'src', 'rental-web', 'app.js'), 'utf8');
    const ids = new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!));
    // Elements the script creates itself when missing (the information tab's "新しい情報があります" notice, 10/20).
    const created = new Set([...script.matchAll(/\.id = '([\w-]+)'/g)].map((m) => m[1]!));
    expect(ids.size).toBeGreaterThan(40);
    for (const id of ids) if (!created.has(id)) expect(html, id).toContain(`id="${id}"`);
  });

  it('opens at /rental and at the label path /i/<code> with camera allowed only there', async () => {
    for (const url of ['/rental', '/i/IY-000123']) {
      const page = await call(url, { user: null });
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toMatch(/text\/html/);
      expect(page.headers['permissions-policy']).toContain('camera=(self)');
      // Only the reading desk on the same PC is reachable besides this server.
      expect(page.headers['content-security-policy']).toContain("connect-src 'self' http://127.0.0.1:48731;");
      expect(String(page.raw)).toContain('/rental/app.js');
    }
    expect((await call('/i/not-an-item', { user: null })).status).toBe(404);
    const worker = await call('/rental-sw.js', { user: null });
    expect(worker.headers['service-worker-allowed']).toBe('/');
    expect((await call('/rental/vendor/jsQR.js', { user: null })).status).toBe(200);
    // The QR fallback (phones and PCs without BarcodeDetector) loads from the path served above.
    const script = readFileSync(path.join(ROOT, 'src', 'rental-web', 'app.js'), 'utf8');
    expect(script).toContain("script.src = '/rental/vendor/jsQR.js'");
    expect((await call('/vendor/jsQR.js', { user: null })).status).toBe(404);
    expect((await call('/api/health', { user: null })).headers['permissions-policy']).toContain('camera=()');
  });
});


describe('all active members administer rental only', () => {
  let common: StateStore;
  beforeEach(async () => {
    await app.close();
    common = new StateStore(await seedState(), null);
    app = await buildApp({
      store: common,
      listenPort: TEST_PORT,
      rental: { store, itemOrigin: null, webDir: null, allMembersAdmin: true },
    });
  });

  it('gives a member without grants every rental capability and keeps common administration unchanged', async () => {
    expect(store.permissionsOf(VIEWER_B)).toEqual([]);
    const before = ledgerSnapshot();
    expect((await call('/api/rental/me', { user: VIEWER_B })).json).toMatchObject({ permissions: ['rental.issue', 'rental.loan'], issuer_reset_allowed: true });
    expect((await call('/api/rental/overview', { user: VIEWER_B })).status).toBe(200);
    expect((await call('/api/rental/issuer/state', { user: VIEWER_B })).json.reset_allowed).toBe(true);
    expect((await call('/api/rental/admin/permissions', { user: VIEWER_B })).status).toBe(403);
    expect((await call('/api/session', { user: VIEWER_B })).json.user.canManageAccess).toBe(false);
    expect((await call('/api/demo/reset', { user: VIEWER_B, method: 'POST', body: '{}' })).status).toBe(403);
    expect(ledgerSnapshot()).toBe(before);
  });

  it('automatically covers an account added after the app starts', async () => {
    const member = common.current.users.find(u => u.id === VIEWER_B)!;
    common.replace({ ...common.current, users: [...common.current.users, { ...member, id: 'u-new-member', displayName: '新規委員' }] });
    expect(store.permissionsOf('u-new-member')).toEqual([]);
    expect((await call('/api/rental/me', { user: 'u-new-member' })).json).toMatchObject({ permissions: ['rental.issue', 'rental.loan'], issuer_reset_allowed: true });
    expect((await call('/api/rental/issuer/state', { user: 'u-new-member' })).status).toBe(200);
  });

  it('still refuses anonymous and disabled accounts on read and administration endpoints', async () => {
    const member = common.current.users.find(u => u.id === VIEWER_B)!;
    common.replace({ ...common.current, users: [...common.current.users, { ...member, id: 'u-disabled-member', disabled: true }] });
    for (const endpoint of ['/api/rental/me', '/api/rental/issuer/state', '/api/rental/admin/permissions']) {
      expect((await call(endpoint, { user: null })).status).toBe(401);
      expect((await call(endpoint, { user: 'u-disabled-member' })).status).toBe(403);
    }
  });

  it('allows lending, return and issuing for a member without grants', async () => {
    const borrowed = multipart(metadata({ photo_skip: true }), []);
    expect((await call('/api/rental/operations', { user: VIEWER_B, method: 'POST', ...borrowed })).status).toBe(200);
    const returned = multipart(metadata({ item_version: 1, action: 'return', borrower: '' }), [RED]);
    expect((await call('/api/rental/operations', { user: VIEWER_B, method: 'POST', ...returned })).status).toBe(200);
    const group = store.borrowerGroups()[0]!;
    const row = { code: 'IY-100001', name: '追加物品', url: 'https://app.example.test/i/IY-100001', borrower_id: group.id, borrower_name: group.name };
    expect((await call('/api/rental/preassignments', { user: VIEWER_B, method: 'POST', body: JSON.stringify({ items: [row] }) })).status).toBe(200);
  });

  it('keeps exact reset confirmation, preview ownership and outstanding-loan protection', async () => {
    const preview = await call('/api/rental/issuer/preview', { user: VIEWER_B, method: 'POST', body: JSON.stringify({ mode: 'reset' }) });
    expect(preview.status).toBe(200);
    const payload = (confirmation: string) => JSON.stringify({ token: preview.json.token, confirmation });
    expect((await call('/api/rental/issuer/apply', { user: VIEWER_B, method: 'POST', body: payload('yes') })).status).toBe(400);
    expect((await call('/api/rental/issuer/apply', { user: EDITOR_A, method: 'POST', body: payload('物品台帳をリセット') })).status).toBe(409);
    expect((await call('/api/rental/issuer/apply', { user: VIEWER_B, method: 'POST', body: payload('物品台帳をリセット') })).status).toBe(200);
    expect(store.summary().total).toBe(0);
  });
});
