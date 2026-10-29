import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDriveSyncHandler, ledgerPayload, type SyncRequest, type SyncResponse } from '../../src/server/rental/drive-sync.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { BLUE, metadata, RED } from './helpers.js';

// The Apps Script (deploy/unified/gas/sync_rental_to_drive.gs) run as written, against stand-ins for
// DriveApp, SpreadsheetApp and the other Apps Script services. Its requests go to the app's sync
// handler exactly as signed, so the script and the app are checked against each other.

const SCRIPT = readFileSync(path.join(import.meta.dirname, '../../deploy/unified/gas/sync_rental_to_drive.gs'), 'utf8');
const KEY = randomBytes(32);
const STAFF = { id: 'iy-00000001', name: '試験 太郎' };

type Signed = number[];
const toSigned = (buf: Buffer): Signed => [...buf].map((b) => (b > 127 ? b - 256 : b));
const toBuffer = (bytes: Signed) => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b)));

interface Blob {
  bytes: Buffer;
  mime: string;
  name: string;
}

let nextId = 0;
const driveId = () => `fakeDriveId${String((nextId += 1)).padStart(6, '0')}`;

class FakeFile {
  readonly id = driveId();
  trashed = false;
  constructor(
    public name: string,
    public bytes: Buffer,
    public mime: string,
    public parent: FakeFolder | null,
  ) {}
  getId = () => this.id;
  getName = () => this.name;
  isTrashed = () => this.trashed;
  getBlob = () => ({ getBytes: () => toSigned(this.bytes) });
}

const iterator = <T>(list: T[]) => {
  let i = 0;
  return { hasNext: () => i < list.length, next: () => list[i++]! };
};

class FakeFolder {
  readonly id = driveId();
  trashed = false;
  folders: FakeFolder[] = [];
  files: FakeFile[] = [];
  constructor(public name: string) {}
  getId = () => this.id;
  getName = () => this.name;
  isTrashed = () => this.trashed;
  getFoldersByName = (name: string) => iterator(this.folders.filter((f) => f.name === name));
  createFolder = (name: string) => {
    const folder = new FakeFolder(name);
    this.folders.push(folder);
    return folder;
  };
  getFiles = () => iterator([...this.files]);
  createFile = (blob: Blob) => {
    const file = new FakeFile(blob.name, blob.bytes, blob.mime, this);
    this.files.push(file);
    return file;
  };
  /** Every file below this folder. */
  all(): FakeFile[] {
    return [...this.files, ...this.folders.flatMap((f) => f.all())];
  }
}

class FakeSheet {
  maxRows = 1000;
  maxColumns = 26;
  cells = new Map<string, string>();
  frozen = 0;
  writes = 0;
  constructor(public name: string) {}
  setName = (name: string) => void (this.name = name);
  clearContents = () => void this.cells.clear();
  getMaxRows = () => this.maxRows;
  getMaxColumns = () => this.maxColumns;
  insertRowsAfter = (_after: number, n: number) => void (this.maxRows += n);
  insertColumnsAfter = (_after: number, n: number) => void (this.maxColumns += n);
  setFrozenRows = (n: number) => void (this.frozen = n);
  getRange = (row: number | string, column?: number, rows?: number, columns?: number) => {
    if (typeof row === 'string') {
      const m = /^([A-Z])(\d+)$/.exec(row)!;
      return { setValue: (v: string) => void this.cells.set(`${Number(m[2])},${m[1]!.charCodeAt(0) - 64}`, v) };
    }
    const range = {
      setNumberFormat: (format: string) => {
        expect(format).toBe('@');
        return range;
      },
      setValues: (values: string[][]) => {
        expect(values).toHaveLength(rows!);
        expect(row + rows! - 1).toBeLessThanOrEqual(this.maxRows);
        expect(column! + columns! - 1).toBeLessThanOrEqual(this.maxColumns);
        values.forEach((r, i) => {
          expect(r).toHaveLength(columns!);
          r.forEach((v, j) => this.cells.set(`${row + i},${column! + j}`, v));
        });
        this.writes += 1;
        return range;
      },
    };
    return range;
  };
  /** The written rows (1-based cells), as the sheet would show them. */
  rows(): string[][] {
    const out: string[][] = [];
    for (const [k, v] of this.cells) {
      const [r, c] = k.split(',').map(Number) as [number, number];
      (out[r - 1] ??= [])[c - 1] = v;
    }
    return out;
  }
}

class FakeSpreadsheet {
  readonly id = driveId();
  sheets: FakeSheet[] = [new FakeSheet('シート1')];
  constructor(public name: string) {}
  getId = () => this.id;
  getSheets = () => this.sheets;
  getSheetByName = (name: string) => this.sheets.find((s) => s.name === name) ?? null;
  insertSheet = (name: string) => {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  };
}

interface Env {
  parent: FakeFolder;
  spreadsheets: FakeSpreadsheet[];
  locations: Map<string, FakeFolder | null>;
  props: Map<string, string>;
  triggers: { handler: string; minutes: number }[];
  requests: SyncRequest[];
  /** Answers a request instead of the app (e.g. a lost report), or undefined to pass it on. */
  intercept: (request: SyncRequest) => SyncResponse | undefined;
}

function loadScript(handle: (request: SyncRequest) => SyncResponse, env: Env) {
  const folders = () => {
    const out: FakeFolder[] = [];
    const walk = (f: FakeFolder) => {
      out.push(f);
      f.folders.forEach(walk);
    };
    walk(env.parent);
    return out;
  };
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    MacAlgorithm: { HMAC_SHA_256: 'hmac-sha256' },
    newBlob: (value: string | Signed, mime = 'text/plain', name = '') => {
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : toBuffer(value);
      return { bytes, mime, name, getBytes: () => toSigned(bytes) };
    },
    computeDigest: (_alg: string, bytes: Signed) => toSigned(createHash('sha256').update(toBuffer(bytes)).digest()),
    computeHmacSignature: (_alg: string, value: Signed, key: Signed) => toSigned(createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest()),
    getUuid: () => randomUUID(),
    formatDate: (_d: Date, tz: string, format: string) => `${tz} ${format}`,
  };
  const UrlFetchApp = {
    fetch: (url: string, o: { method: string; headers: Record<string, string>; payload?: Signed; contentType?: string; followRedirects: boolean; muteHttpExceptions: boolean }) => {
      expect(url.startsWith('https://app.iyakusai.com/v1/rental/sync/')).toBe(true);
      expect([o.followRedirects, o.muteHttpExceptions]).toEqual([false, true]);
      const request: SyncRequest = {
        method: o.method.toUpperCase(),
        url: url.slice('https://app.iyakusai.com'.length),
        rawHeaders: [...Object.entries(o.headers).flat(), ...(o.contentType ? ['Content-Type', o.contentType] : [])],
        body: o.payload ? toBuffer(o.payload) : Buffer.alloc(0),
      };
      env.requests.push(request);
      const out = env.intercept(request) ?? handle(request);
      return {
        getResponseCode: () => out.status,
        getContent: () => toSigned(out.bytes ?? Buffer.from(JSON.stringify(out.json))),
        getContentText: () => (out.bytes ? out.bytes.toString('utf8') : JSON.stringify(out.json)),
      };
    },
  };
  const DriveApp = {
    getFolderById: (id: string) => {
      const found = folders().find((f) => f.id === id);
      if (!found) throw new Error('not found');
      return found;
    },
    getFileById: (id: string) => ({
      moveTo: (folder: FakeFolder) => void env.locations.set(id, folder),
    }),
  };
  const SpreadsheetApp = {
    create: (name: string) => {
      const ss = new FakeSpreadsheet(name);
      env.spreadsheets.push(ss);
      env.locations.set(ss.id, null); // My Drive until moved
      return ss;
    },
    openById: (id: string) => {
      const ss = env.spreadsheets.find((s) => s.id === id);
      if (!ss) throw new Error('not found');
      return ss;
    },
  };
  const ScriptApp = {
    newTrigger: (handler: string) => ({ timeBased: () => ({ everyMinutes: (minutes: number) => ({ create: () => void env.triggers.push({ handler, minutes }) }) }) }),
    getProjectTriggers: () => env.triggers.map((t) => ({ getHandlerFunction: () => t.handler, t })),
    deleteTrigger: (trigger: { t: { handler: string; minutes: number } }) => void env.triggers.splice(env.triggers.indexOf(trigger.t), 1),
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k: string) => env.props.get(k) ?? null, setProperty: (k: string, v: string) => void env.props.set(k, v) }) };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  const Logger = { log: () => {} };
  const factory = new Function('Utilities', 'UrlFetchApp', 'DriveApp', 'SpreadsheetApp', 'ScriptApp', 'PropertiesService', 'LockService', 'Logger', `${SCRIPT}\nreturn { run, checkSetup, installTrigger, removeTrigger, CONFIG };`);
  return factory(Utilities, UrlFetchApp, DriveApp, SpreadsheetApp, ScriptApp, PropertiesService, LockService, Logger) as {
    run: () => void;
    checkSetup: () => void;
    installTrigger: () => void;
    removeTrigger: () => void;
    CONFIG: Record<string, unknown>;
  };
}

let dir: string;
let store: RentalStore;
let env: Env;
let script: ReturnType<typeof loadScript>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rental-gas-'));
  store = new RentalStore(dir, { driveSync: true });
  store.addItems([
    ['IY-100123', '長机'],
    ['IY-100124', 'パイプ椅子'],
  ]);
  store.addBorrowers(['模擬店A', '模擬店B']);
  env = { parent: new FakeFolder('物品管理'), spreadsheets: [], locations: new Map(), props: new Map([['RENTAL_SYNC_KEY', KEY.toString('hex')]]), triggers: [], requests: [], intercept: () => undefined };
  script = loadScript(createDriveSyncHandler({ store, key: KEY }), env);
  script.CONFIG.PARENT_FOLDER_ID = env.parent.id;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function lend(code: string, borrower: string, photos = [RED, BLUE]) {
  return store.submit(metadata({ item_code: code, borrower, ...(photos.length < 2 ? { photo_skip: true } : {}) }), photos, STAFF);
}

const root = () => env.parent.folders.find((f) => f.name === '物品貸出_写真と記録（自動保存）')!;
const itemFolder = (name: string) => root().folders.find((f) => f.name === '物品別')!.folders.find((f) => f.name === name)!;

describe('the Apps Script', () => {
  it('copies checkpoint photos and records without ending the active loan or counting a return', () => {
    lend('IY-100123','模擬店A');
    const check = metadata({item_code:'IY-100123',item_version:1,action:'check',borrower:'',condition:'damage',note:'搬出前の確認'});
    store.submit(check,[RED],STAFF);
    script.run();
    expect(store.operation(check.operation_id).status).toBe('complete');
    expect(store.item('IY-100123').status).toBe('loaned');
    expect(store.overview().items.find(i=>i.code==='IY-100123')!.returned_at).toBeNull();
    const desk = itemFolder('IY-100123_No.123_長机');
    expect(desk.files.filter(f=>f.name.includes('随時チェック')).map(f=>f.mime).sort()).toEqual(['application/json','image/jpeg']);
    expect(JSON.stringify(env.spreadsheets[0]!.getSheetByName('操作履歴')!.rows())).toContain('随時チェック');
  });
  it('copies photos and records into a folder per item and writes the sheet', () => {
    const a = lend('IY-100123', '模擬店A');
    const b = lend('IY-100124', '模擬店B', []);
    script.run();

    expect(env.parent.folders.map((f) => f.name)).toEqual(['物品貸出_写真と記録（自動保存）']);
    const desk = itemFolder('IY-100123_No.123_長机');
    expect(desk.files.map((f) => [f.name.replace(/^\d{8}-\d{6}_/, ''), f.mime])).toEqual([
      [`貸出_模擬店A_${a.operation_id.slice(0, 8)}_01.jpg`, 'image/jpeg'],
      [`貸出_模擬店A_${a.operation_id.slice(0, 8)}_02.jpg`, 'image/jpeg'],
      [`貸出_模擬店A_${a.operation_id.slice(0, 8)}_記録.json`, 'application/json'],
    ]);
    expect(desk.files[0]!.bytes.equals(RED)).toBe(true);
    expect(desk.files[1]!.bytes.equals(BLUE)).toBe(true);
    expect(JSON.parse(desk.files[2]!.bytes.toString('utf8'))).toMatchObject({ 操作: '貸出', 個体コード: 'IY-100123', 団体: '模擬店A', 担当: '試験 太郎' });
    // A loan without photos still gets its record.
    expect(itemFolder('IY-100124_No.124_パイプ椅子').files.map((f) => f.name.endsWith('_記録.json'))).toEqual([true]);

    expect(store.operation(a.operation_id)).toMatchObject({ status: 'complete', drive_synced_count: 2 });
    expect(store.operation(b.operation_id).status).toBe('complete');
    // The Drive IDs recorded are those of the files the script created.
    const ids = (store.db.prepare('SELECT drive_id FROM files WHERE operation_id=? ORDER BY idx').all(a.operation_id) as { drive_id: string }[]).map((r) => r.drive_id);
    expect(ids.sort()).toEqual(desk.files.map((f) => f.id).sort());

    // The sheet: created once, moved into the folder, the app's rows as they are, the check time in B2.
    expect(env.spreadsheets).toHaveLength(1);
    const ss = env.spreadsheets[0]!;
    expect([ss.name, env.locations.get(ss.id)]).toEqual(['物品貸出_状況一覧（アプリから自動更新）', root()]);
    const expected = ledgerPayload(store, new Date());
    expect(ss.sheets.map((s) => s.name)).toEqual(expected.sheets.map((s) => s.name));
    for (const s of expected.sheets) {
      const written = ss.getSheetByName(s.name)!;
      const rows = written.rows();
      if (s.name === '更新情報') {
        expect(rows[1]![1]).toBe('Asia/Tokyo yyyy/MM/dd HH:mm:ss');
        expect(rows.filter((r) => r[0] !== '一覧を書き出した時刻（日本時間）').slice(2)).toEqual(s.rows.filter((r) => r[0] !== '一覧を書き出した時刻（日本時間）').slice(2));
      } else {
        expect(rows).toEqual(s.rows);
      }
      expect(written.frozen).toBe(1);
    }
    expect(ss.getSheetByName('操作履歴')!.rows().slice(1).map((r) => r[10])).toEqual(['保存済み', '保存済み']);
  });

  it('creates nothing again on the next run, and only stamps an unchanged sheet', () => {
    lend('IY-100123', '模擬店A');
    script.run();
    const files = root().all().length;
    const ss = env.spreadsheets[0]!;
    const writes = ss.sheets.map((s) => s.writes);
    env.requests = [];
    script.run();
    expect(root().all()).toHaveLength(files);
    expect(env.spreadsheets).toHaveLength(1);
    expect(ss.sheets.map((s) => s.writes)).toEqual(writes);
    expect(env.requests.map((r) => r.url.split('?')[0])).toEqual(['/v1/rental/sync/pending', '/v1/rental/sync/ledger']);
  });

  it('after a lost report, finds the files it saved by name and reports them without copying again', () => {
    const a = lend('IY-100123', '模擬店A');
    env.intercept = (r) => (r.url === '/v1/rental/sync/ack' ? { status: 503, json: { error: 'unavailable' } } : undefined);
    expect(() => script.run()).toThrow(/報告できません/);
    const desk = itemFolder('IY-100123_No.123_長机');
    expect(desk.files).toHaveLength(3);
    expect(store.operation(a.operation_id).status).toBe('drive_pending');

    env.intercept = () => undefined;
    env.requests = [];
    script.run();
    expect(desk.files).toHaveLength(3);
    expect(env.requests.filter((r) => r.url.startsWith('/v1/rental/sync/file'))).toEqual([]);
    expect(store.operation(a.operation_id).status).toBe('complete');
  });

  it('does not overwrite a different file of the same name, and reports it', () => {
    lend('IY-100123', '模擬店A');
    script.run();
    const desk = itemFolder('IY-100123_No.123_長机');
    // A return whose first photo name is already taken by someone else's file.
    const b = store.submit(metadata({ item_code: 'IY-100123', item_version: 1, action: 'return', borrower: '', condition: 'normal' }), [BLUE], STAFF);
    const taken = listed()[0]!.files[0]!.name;
    const intruder = desk.createFile({ name: taken, bytes: Buffer.from('someone else'), mime: 'image/jpeg' });

    script.run();
    expect(intruder.bytes.toString()).toBe('someone else');
    expect(desk.files.filter((f) => f.name === taken)).toEqual([intruder]);
    expect(store.operation(b.operation_id)).toMatchObject({ status: 'drive_error', error: 'Drive に同じ名前の別のファイルがあります。管理者が確認してください。' });
  });

  it('checks the setup and sets and removes its trigger', () => {
    script.checkSetup();
    expect(root()).toBeDefined();
    script.installTrigger();
    script.installTrigger();
    expect(env.triggers).toEqual([{ handler: 'run', minutes: 5 }]);
    script.removeTrigger();
    expect(env.triggers).toEqual([]);
  });

  it('refuses to start without its key or the parent folder', () => {
    env.props.delete('RENTAL_SYNC_KEY');
    expect(() => script.run()).toThrow(/RENTAL_SYNC_KEY/);
    env.props.set('RENTAL_SYNC_KEY', KEY.toString('hex'));
    script.CONFIG.PARENT_FOLDER_ID = '';
    expect(() => script.run()).toThrow(/PARENT_FOLDER_ID/);
    expect(env.parent.folders).toEqual([]);
  });

  it('is refused by the app with another key', () => {
    env.props.set('RENTAL_SYNC_KEY', randomBytes(32).toString('hex'));
    lend('IY-100123', '模擬店A');
    expect(() => script.run()).toThrow(/401/);
  });
});

/** The app's pending list, signed as the script would sign it. */
function listed(): { operation_id: string; files: { name: string }[] }[] {
  const url = '/v1/rental/sync/pending?limit=10';
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString('base64url');
  const text = ['svc-auth/v1', 'rental-drive-sync', 'GET', url, timestamp, nonce, '', createHash('sha256').update('').digest('hex')].join('\n');
  const signature = createHmac('sha256', KEY).update(text).digest('hex');
  const out = createDriveSyncHandler({ store, key: KEY })({ method: 'GET', url, body: Buffer.alloc(0), rawHeaders: ['X-Svc-Client', 'rental-drive-sync', 'X-Svc-Timestamp', timestamp, 'X-Svc-Nonce', nonce, 'X-Svc-Signature', signature] });
  return (out.json as { operations: { operation_id: string; files: { name: string }[] }[] }).operations;
}
