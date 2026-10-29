import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRentalConfig } from '../../src/server/config.js';
import { actorLabel, createDriveSyncHandler, itemFolderName, jstStamp, SYNC_CLIENT, type SyncRequest, type SyncResponse } from '../../src/server/rental/drive-sync.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { BLUE, metadata, RED } from './helpers.js';

// The copy to Google Drive as the Apps Script sees it: signed requests, the queue of operations whose
// files are not on Drive yet, the report back, and the sheet's contents.

const KEY = randomBytes(32);
const STAFF = { id: 'iy-00000001', name: '試験 太郎' };
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

let dir: string;
let store: RentalStore;
let clock: { now: number };
let handle: (request: SyncRequest) => SyncResponse;

function open(driveSync = true) {
  store = new RentalStore(dir, { driveSync });
  handle = createDriveSyncHandler({ store, key: KEY, now: () => clock.now });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rental-drive-'));
  // Whole seconds, so retry times (seconds) compare exactly.
  clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  open();
  store.addItems([
    ['IY-100123', '長机'],
    ['IY-100124', 'パイプ椅子'],
  ]);
  store.addBorrowers(['模擬店A', '=SUM(A1)の会']);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface SignOptions {
  key?: Buffer;
  client?: string;
  timestamp?: string;
  nonce?: string;
  extra?: string[];
  signedUrl?: string;
  signedBody?: Buffer;
}

function signed(method: string, url: string, body = Buffer.alloc(0), o: SignOptions = {}): SyncRequest {
  const timestamp = o.timestamp ?? String(clock.now);
  const nonce = o.nonce ?? randomBytes(18).toString('base64url');
  const client = o.client ?? SYNC_CLIENT;
  const text = ['svc-auth/v1', client, method, o.signedUrl ?? url, timestamp, nonce, '', sha256(o.signedBody ?? body)].join('\n');
  const signature = createHmac('sha256', o.key ?? KEY).update(text, 'utf8').digest('hex');
  return { method, url, body, rawHeaders: ['X-Svc-Client', client, 'X-Svc-Timestamp', timestamp, 'X-Svc-Nonce', nonce, 'X-Svc-Signature', signature, ...(o.extra ?? [])] };
}

const get = (url: string) => handle(signed('GET', url));
const report = (value: unknown) => handle(signed('POST', '/v1/rental/sync/ack', Buffer.from(JSON.stringify(value))));

interface Listed {
  operation_id: string;
  item_code: string;
  folder: string;
  files: { idx: number; name: string; mime: string; size: number; sha256: string }[];
}
const pending = (limit = 20) => (get(`/v1/rental/sync/pending?limit=${limit}`).json as { operations: Listed[] }).operations;
const statusOf = (id: string) => store.db.prepare('SELECT status,error,attempts FROM operations WHERE id=?').get(id) as { status: string; error: string | null; attempts: number };

function lend(code = 'IY-100123', changes: Record<string, unknown> = {}, photos = [RED, BLUE], actor = STAFF) {
  const meta = metadata({ item_code: code, borrower: '模擬店A', ...changes });
  return store.submit(meta, photos, actor);
}

/** Reports every listed file of an operation as saved under made-up Drive IDs. */
function saveAll(op: Listed, idPrefix = 'drivefile') {
  return report({ operation_id: op.operation_id, saved: op.files.map((f) => ({ idx: f.idx, drive_id: `${idPrefix}${op.operation_id.slice(0, 8)}${f.idx}`, sha256: f.sha256, size: f.size })) });
}

describe('the queue', () => {
  it('keeps new operations waiting for Drive', () => {
    expect(store.mode).toBe('drive');
    expect(lend()).toMatchObject({ status: 'drive_pending', photos_count: 2, drive_synced_count: 0 });
    expect(store.driveSyncStatus()).toMatchObject({ enabled: true, waiting: 1, errors: 0, last_saved_at: null });
  });

  it('lists the photos first and the record last, under names for people', () => {
    const receipt = lend();
    const [op] = pending();
    const base = `${jstStamp(receipt.server_at)}_貸出_模擬店A_${receipt.operation_id.slice(0, 8)}`;
    expect(op!.folder).toBe('IY-100123_No.123_長机');
    expect(op!.files.map((f) => [f.idx, f.name, f.mime])).toEqual([
      [1, `${base}_01.jpg`, 'image/jpeg'],
      [2, `${base}_02.jpg`, 'image/jpeg'],
      [0, `${base}_記録.json`, 'application/json'],
    ]);
    expect(op!.files[0]!.sha256).toBe(sha256(RED));
  });

  it('serves the accepted photo and a record that matches its listing', () => {
    const receipt = lend('IY-100123', { condition: 'damage', note: '天板に傷' });
    const [op] = pending();
    const photo = get(`/v1/rental/sync/file?op=${receipt.operation_id}&idx=1`);
    expect(photo).toMatchObject({ status: 200, contentType: 'image/jpeg' });
    expect(photo.bytes!.equals(RED)).toBe(true);
    const record = get(`/v1/rental/sync/file?op=${receipt.operation_id}&idx=0`).bytes!;
    const listed = op!.files.find((f) => f.idx === 0)!;
    expect([record.length, sha256(record)]).toEqual([listed.size, listed.sha256]);
    const json = JSON.parse(record.toString('utf8'));
    expect(json).toMatchObject({ 操作: '貸出', 個体コード: 'IY-100123', 'No.': '123', 物品名: '長机', 団体: '模擬店A', 状態: '損傷あり', メモ: '天板に傷', 担当: '試験 太郎', 操作ID: receipt.operation_id });
    expect(json.写真).toEqual(op!.files.filter((f) => f.idx > 0).map((f) => f.name));
    // The login ID stays on the server.
    expect(record.toString('utf8')).not.toContain('iy-00000001');
  });

  it('names the group of a return from the loan it ends', () => {
    lend();
    for (const op of pending()) saveAll(op);
    const receipt = store.submit(metadata({ item_code: 'IY-100123', item_version: 1, action: 'return', borrower: '', condition: 'maintenance' }), [BLUE], STAFF);
    const [op] = pending();
    expect(op!.files.map((f) => f.name)).toEqual([`${jstStamp(receipt.server_at)}_返却_模擬店A_${receipt.operation_id.slice(0, 8)}_01.jpg`, `${jstStamp(receipt.server_at)}_返却_模擬店A_${receipt.operation_id.slice(0, 8)}_記録.json`]);
    expect(JSON.parse(get(`/v1/rental/sync/file?op=${receipt.operation_id}&idx=0`).bytes!.toString('utf8'))).toMatchObject({ 操作: '返却', 団体: '模擬店A', 状態: '要清掃・整備' });
  });

  it('writes no student or login ID as the name of the person who acted', () => {
    expect(actorLabel({ actor: { id: 'iy-00000002', name: 'B2512345' } })).toBe('（氏名未登録）');
    expect(actorLabel({ actor: { id: 'iy-00000002', name: '12345678' } })).toBe('（氏名未登録）');
    expect(actorLabel({ actor: { id: 'iy-00000002', name: 'iy-00000002' } })).toBe('（氏名未登録）');
    expect(actorLabel({ actor: { id: 'iy-00000002', name: '' } })).toBe('（氏名未登録）');
    expect(actorLabel({ actor: { id: 'iy-00000002', name: '医薬 花子' } })).toBe('医薬 花子');
    expect(actorLabel({ actor: { id: 'iy-00000002', name: 'ExampleUser' } })).toBe('ExampleUser');
  });

  it('keeps folder names free of path characters', () => {
    expect(itemFolderName('IY-100007', '延長コード 10m/赤:予備')).toBe('IY-100007_No.7_延長コード 10m_赤_予備');
    expect(itemFolderName('IY-TEST-1', '')).toBe('IY-TEST-1_物品名なし');
  });
});

describe('the report back', () => {
  it('completes an operation when every file is on Drive, and keeps a partial one waiting', () => {
    const receipt = lend();
    const [op] = pending();
    const photo = op!.files[0]!;
    const partial = report({ operation_id: receipt.operation_id, saved: [{ idx: photo.idx, drive_id: 'drivefileAAAA1', sha256: photo.sha256, size: photo.size }] });
    expect(partial).toMatchObject({ status: 200, json: { status: 'drive_pending', drive_synced_count: 1 } });
    expect(pending()[0]!.files.map((f) => f.idx)).toEqual([2, 0]);
    expect(saveAll(pending()[0]!)).toMatchObject({ status: 200, json: { status: 'complete', drive_synced_count: 2 } });
    expect(pending()).toEqual([]);
    expect(store.operation(receipt.operation_id).status).toBe('complete');
    expect(store.driveSyncStatus()).toMatchObject({ waiting: 0, errors: 0, last_saved_at: new Date(clock.now).toISOString() });
  });

  it('accepts the same Drive file again and refuses another one', () => {
    lend();
    const [op] = pending();
    expect(saveAll(op!).status).toBe(200);
    expect(saveAll(op!)).toMatchObject({ status: 200, json: { status: 'complete' } });
    expect(saveAll(op!, 'otherfile')).toMatchObject({ status: 409, json: { error: 'drive_conflict' } });
    expect(store.operation(op!.operation_id).status).toBe('complete');
  });

  it('refuses content that differs from the ledger and sets the operation aside for a while', () => {
    const receipt = lend();
    lend('IY-100124');
    const [op] = pending();
    const wrong = report({ operation_id: op!.operation_id, saved: [{ idx: 1, drive_id: 'drivefileAAAA1', sha256: sha256('別の写真'), size: op!.files[0]!.size }] });
    expect(wrong).toMatchObject({ status: 409, json: { error: 'integrity' } });
    expect(statusOf(receipt.operation_id)).toMatchObject({ status: 'drive_error', attempts: 1 });
    // The next operation is not held up behind it, and the set-aside one comes back after 5 seconds.
    expect(pending().map((o) => o.item_code)).toEqual(['IY-100124']);
    clock.now += 5_000;
    expect(pending().map((o) => o.item_code)).toEqual(['IY-100123', 'IY-100124']);
  });

  it('shows a failure on the phones and waits longer after each one', () => {
    const receipt = lend();
    expect(report({ operation_id: receipt.operation_id, saved: [], error: 'drive' })).toMatchObject({ status: 200, json: { status: 'drive_error', error: 'Drive への保存に失敗しました。自動で再試行します。' } });
    expect(store.driveSyncStatus()).toMatchObject({ waiting: 1, errors: 1 });
    clock.now += 5_000;
    expect(report({ operation_id: receipt.operation_id, saved: [], error: 'name_conflict' })).toMatchObject({ json: { error: 'Drive に同じ名前の別のファイルがあります。管理者が確認してください。' } });
    clock.now += 9_000;
    expect(pending()).toEqual([]);
    clock.now += 1_000;
    expect(pending()).toHaveLength(1);
    expect(saveAll(pending()[0]!)).toMatchObject({ json: { status: 'complete' } });
    expect(store.operation(receipt.operation_id)).not.toHaveProperty('error');
  });

  it('refuses reports in another shape', () => {
    const receipt = lend();
    for (const value of [null, [], { operation_id: 'x' }, { operation_id: receipt.operation_id, saved: 'all' }, { operation_id: receipt.operation_id, error: 'other' }, { operation_id: receipt.operation_id, saved: [{ idx: 1, drive_id: 'short', sha256: sha256(RED), size: RED.length }] }]) {
      expect(report(value).status).toBe(400);
    }
    expect(report({ operation_id: '00000000-0000-4000-8000-000000000000', saved: [] }).status).toBe(404);
    expect(statusOf(receipt.operation_id).status).toBe('drive_pending');
  });

  it('also copies operations accepted before the copy was set up', () => {
    store.close();
    open(false);
    const receipt = lend();
    expect(receipt.status).toBe('local_saved');
    store.close();
    open(true);
    const [op] = pending();
    expect(op!.operation_id).toBe(receipt.operation_id);
    expect(saveAll(op!)).toMatchObject({ json: { status: 'complete' } });
  });
});

describe('signed requests', () => {
  it('answers only the committee script, once per request', () => {
    lend();
    const url = '/v1/rental/sync/pending?limit=5';
    expect(handle(signed('GET', url)).status).toBe(200);
    const once = signed('GET', url);
    expect(handle(once).status).toBe(200);
    expect(handle(once).status).toBe(401); // replayed nonce
    const refused: SyncRequest[] = [
      { method: 'GET', url, body: Buffer.alloc(0), rawHeaders: [] },
      signed('GET', url, Buffer.alloc(0), { key: randomBytes(32) }),
      signed('GET', url, Buffer.alloc(0), { client: 'mail-collector' }),
      signed('GET', url, Buffer.alloc(0), { timestamp: String(clock.now - 6 * 60_000) }),
      signed('GET', url, Buffer.alloc(0), { nonce: 'short' }),
      signed('GET', url, Buffer.alloc(0), { extra: ['X-Svc-Client', SYNC_CLIENT] }),
      signed('GET', url, Buffer.alloc(0), { extra: ['Origin', 'https://app.iyakusai.com'] }),
      signed('GET', url, Buffer.alloc(0), { extra: ['X-Svc-Actor', 'iy-00000001'] }),
      signed('GET', url, Buffer.alloc(0), { extra: ['X-Svc-Other', '1'] }),
      signed('GET', '/v1/rental/sync/pending?limit=20', Buffer.alloc(0), { signedUrl: url }),
      signed('POST', '/v1/rental/sync/ack', Buffer.from('{"operation_id":"x"}'), { signedBody: Buffer.from('{}') }),
      { ...signed('POST', url), method: 'GET' },
      signed('GET', '/v1/rental/sync/pending?limit=0'),
      signed('GET', '/v1/rental/sync/pending?limit=21'),
      signed('GET', '/v1/rental/sync/pending'),
      signed('GET', '/v1/rental/sync/file?op=../../x&idx=1'),
      signed('GET', '/v1/rental/sync/ledger?known=abc'),
      signed('POST', '/v1/rental/sync/pending?limit=5'),
    ];
    for (const request of refused) expect(handle(request).status).toBe(401);
  });

  it('notes when the script was last seen', () => {
    expect(store.driveSyncStatus()).toMatchObject({ last_seen_at: null });
    get('/v1/rental/sync/pending?limit=1');
    expect(store.driveSyncStatus()).toMatchObject({ last_seen_at: new Date(clock.now).toISOString() });
  });

  it('says not found for a photo that was not recorded', () => {
    const receipt = lend();
    expect(get(`/v1/rental/sync/file?op=${receipt.operation_id}&idx=5`)).toMatchObject({ status: 404 });
    expect(get('/v1/rental/sync/file?op=00000000-0000-4000-8000-000000000000&idx=0')).toMatchObject({ status: 404 });
  });
});

describe('the sheet', () => {
  type Ledger = { version: string; unchanged?: true; stamp: { sheet: string; cell: string }; sheets?: { name: string; rows: string[][] }[] };
  const ledger = (known = '') => get(`/v1/rental/sync/ledger?known=${known}`).json as Ledger;
  const sheet = (l: Ledger, name: string) => l.sheets!.find((s) => s.name === name)!.rows;

  it('writes the state of every item, the groups and the history, as text that is never a formula', () => {
    lend();
    lend('IY-100124', { borrower: '=SUM(A1)の会', photo_skip: true }, []);
    const l = ledger();
    expect(l.sheets!.map((s) => s.name)).toEqual(['更新情報', '物品一覧', '団体別', '操作履歴']);
    expect(l.stamp).toEqual({ sheet: '更新情報', cell: 'B2' });
    for (const s of l.sheets!) expect(new Set(s.rows.map((r) => r.length)).size).toBe(1);
    const items = sheet(l, '物品一覧');
    expect(items[0]).toEqual(['団体', '状況', 'No.', '個体コード', '物品名', '貸出日時', '貸出時の状態', '貸出時のメモ', '写真の省略', '返却日時', '返却時の状態', '返却時のメモ', '物品区分', '借用元']);
    expect(items.slice(1).map((r) => r.slice(0, 5))).toEqual([
      ["'=SUM(A1)の会", '貸出中', '124', 'IY-100124', 'パイプ椅子'],
      ['模擬店A', '貸出中', '123', 'IY-100123', '長机'],
    ]);
    expect(sheet(l, '団体別').slice(1).map((r) => [r[0], r[1], r[7]])).toEqual([
      ["'=SUM(A1)の会", '1', '124'],
      ['模擬店A', '1', '123'],
    ]);
    const history = sheet(l, '操作履歴');
    expect(history[0]).toEqual(['日時', '操作', 'No.', '個体コード', '物品名', '団体', '状態', 'メモ', '写真', '担当', 'Drive']);
    expect(history.slice(1).map((r) => [r[3], r[8], r[9], r[10]])).toEqual([
      ['IY-100124', '省略', '試験 太郎', '待ち'],
      ['IY-100123', '2枚', '試験 太郎', '待ち'],
    ]);
    expect(sheet(l, '更新情報').find((r) => r[0] === 'Drive への保存待ちの操作')![1]).toBe('2');
  });

  it('is not written again until the ledger changes', () => {
    lend();
    const first = ledger();
    clock.now += 60_000;
    expect(ledger(first.version)).toMatchObject({ version: first.version, unchanged: true });
    expect(ledger(first.version)).not.toHaveProperty('sheets');
    for (const op of pending()) saveAll(op);
    const after = ledger(first.version);
    expect(after.version).not.toBe(first.version);
    expect(sheet(after, '操作履歴')[1]![10]).toBe('保存済み');
  });
});

describe('configuration', () => {
  it('reads the key for the Discord login only, and only with a ledger', () => {
    const keyFile = path.join(dir, 'rental-drive-sync.key');
    writeFileSync(keyFile, randomBytes(32).toString('hex'));
    chmodSync(keyFile, 0o600);
    const env = { SMM_RENTAL_DATA_DIR: path.join(dir, 'rental'), SMM_RENTAL_ITEM_ORIGIN: 'https://app.example.invalid', SMM_RENTAL_DRIVE_SYNC_KEY_FILE: keyFile };
    const on = parseRentalConfig(env, 'discord');
    expect(on.mode === 'on' && on.driveSyncKey?.length).toBe(32);
    expect(() => parseRentalConfig(env, 'demo')).toThrow(/discord/);
    expect(() => parseRentalConfig({ SMM_RENTAL_DRIVE_SYNC_KEY_FILE: keyFile }, 'discord')).toThrow(/SMM_RENTAL_DATA_DIR/);
    const off = parseRentalConfig({ SMM_RENTAL_DATA_DIR: path.join(dir, 'rental'), SMM_RENTAL_ITEM_ORIGIN: 'https://app.example.invalid' }, 'discord');
    expect(off.mode === 'on' && off.driveSyncKey).toBeNull();
  });
});
