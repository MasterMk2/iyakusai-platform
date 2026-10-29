import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkPhoto, type CheckedPhoto } from './image-probe.js';
import { BORROWER_ID_RE, borrowerName, canonical, itemCode, MAX_PHOTOS, MIN_BORROW_PHOTOS, operationUuid, RentalError, textField, utcNow, validateMetadata, type IrregularDetails } from './validate.js';

// The rental ledger. A TypeScript port of reference/rental-python/server/store.py that opens the same
// SQLite file with the same tables, so switching from the Python server is a copy of its data
// directory (rental.sqlite3 and spool/). Added here: explicit rental permissions per account
// (`grants`). The staff and sessions tables of the Python server are kept but no longer used: people
// sign in with the common account. Not ported: the service-account Drive upload and mounted-folder
// mirror workers and the label PDF renderer. Copies to Google Drive are made by an Apps Script that
// fetches them over signed requests (drive-sync.ts); this store keeps that queue (`driveSync`).

export const RENTAL_PERMISSIONS = ['rental.loan', 'rental.issue', 'rental.admin'] as const;
export type RentalPermission = (typeof RENTAL_PERMISSIONS)[number];

/** Who acted, as recorded in the ledger. The id is the common account's user ID. */
export interface Actor {
  id: string;
  name: string;
}

/** Answer of GET /api/rental/summary. */
export interface RentalSummary {
  total: number;
  counts: { ready: number; loaned: number; review: number };
  /** Ready items that already have a planned group (lent when the group comes). */
  planned: number;
  loanedByGroup: { borrower: string; loaned: number; since: string }[];
  /** Items returned with a problem, up to 20. */
  review: { code: string; name: string }[];
}

export interface Receipt {
  operation_id: string;
  item_code: string;
  action: string;
  status: string;
  server_at: string;
  photos_count: number;
  drive_synced_count: number;
  error?: string;
  mirror_status?: string;
  cloud_sync_verified?: false;
  mirror_error?: string;
}

/** One item as the information tab shows it. Times are the server's UTC ISO strings. */
export interface OverviewItem {
  code: string;
  name: string;
  status: string;
  item_scope: string | null;
  item_owner: string | null;
  /** loaned: with the group now; review: back with a problem; planned: assigned, not yet lent; returned: back without a problem. */
  phase: 'loaned' | 'review' | 'planned' | 'returned' | 'unassigned';
  group: { id: string; name: string } | null;
  lent_at: string | null;
  lent_condition: 'normal' | 'damage' | null;
  lent_note: string;
  lent_photo_skip: boolean;
  returned_at: string | null;
  return_condition: string | null;
  return_note: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS irregular_card_batches(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,count INTEGER NOT NULL,generation INTEGER NOT NULL,server_at TEXT NOT NULL,result_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff(id TEXT PRIMARY KEY,name TEXT NOT NULL,salt TEXT NOT NULL,code_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,staff_id TEXT NOT NULL,expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS borrowers(name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS issuance(code TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,actor_id TEXT NOT NULL,server_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(code TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ready',version INTEGER NOT NULL DEFAULT 0,current_loan TEXT);
CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,item_code TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,fingerprint TEXT NOT NULL,metadata TEXT NOT NULL,server_at TEXT NOT NULL,status TEXT NOT NULL,error TEXT,next_retry REAL NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS files(operation_id TEXT NOT NULL,idx INTEGER NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,md5 TEXT NOT NULL,drive_id TEXT,state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(operation_id,idx));
CREATE INDEX IF NOT EXISTS operations_queue ON operations(status,next_retry);
CREATE INDEX IF NOT EXISTS operations_item ON operations(item_code,server_at);
CREATE TABLE IF NOT EXISTS preassignment_events(id INTEGER PRIMARY KEY AUTOINCREMENT,item_code TEXT NOT NULL,borrower_id TEXT NOT NULL,previous_borrower_id TEXT,previous_state TEXT NOT NULL,actor_id TEXT NOT NULL,server_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS item_metadata_events(id INTEGER PRIMARY KEY AUTOINCREMENT,item_code TEXT NOT NULL,previous_scope TEXT,item_scope TEXT,previous_owner TEXT,item_owner TEXT,actor_id TEXT NOT NULL,server_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grants(user_id TEXT NOT NULL,permission TEXT NOT NULL,granted_by TEXT NOT NULL,granted_at TEXT NOT NULL,PRIMARY KEY(user_id,permission));
CREATE TABLE IF NOT EXISTS rental_access_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_nonces(digest TEXT PRIMARY KEY,expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS numbering_reset_archives(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,actor_id TEXT NOT NULL,server_at TEXT NOT NULL,sha256 TEXT NOT NULL,snapshot_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operation_corrections(id TEXT PRIMARY KEY,item_code TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('void','borrower','release')),operation_id TEXT,ledger_generation INTEGER NOT NULL,fingerprint TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,server_at TEXT NOT NULL,reason TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS operation_corrections_item ON operation_corrections(item_code,ledger_generation,server_at);
CREATE UNIQUE INDEX IF NOT EXISTS operation_corrections_void ON operation_corrections(operation_id) WHERE kind='void';
`;

/** Leaves out registrations cancelled in corrections.ts; their rows and files stay as they were. */
export const NOT_VOIDED = "id NOT IN (SELECT operation_id FROM operation_corrections WHERE kind='void' AND operation_id IS NOT NULL)";

/** A cancelled registration (kind void) as corrections.ts recorded it. */
export interface VoidedRegistration {
  server_at: string;
  actor_name: string;
  reason: string;
}

/** The group a loan was corrected to (kind borrower). */
export interface CorrectedBorrower {
  borrower: string;
  borrower_id: string;
  server_at: string;
  actor_name: string;
  reason: string;
}

/** Corrections in force, by operation ID. Operation IDs are UUIDs, so one map serves every ledger generation. */
export interface CorrectionState {
  voided: Map<string, VoidedRegistration>;
  borrowers: Map<string, CorrectedBorrower>;
}

/** Operation states whose files are still to be copied to Drive (local_saved: accepted before the copy was set up). */
const DRIVE_WAITING = ['local_saved', 'drive_pending', 'drive_error'] as const;
const DRIVE_ERROR_MESSAGES = {
  integrity: 'Drive に保存した内容を確認できませんでした。自動で再試行します。',
  name_conflict: 'Drive に同じ名前の別のファイルがあります。管理者が確認してください。',
  drive: 'Drive への保存に失敗しました。自動で再試行します。',
} as const;
export type DriveErrorCode = keyof typeof DRIVE_ERROR_MESSAGES;
export const DRIVE_ERROR_CODES = Object.keys(DRIVE_ERROR_MESSAGES) as DriveErrorCode[];

/** One operation waiting for its copy to Drive, with the files not copied yet. */
export interface DriveWaiting {
  id: string;
  item_code: string;
  action: string;
  server_at: string;
  status: string;
  /** The operation record as archived when it was accepted (operation.json). */
  archive: Record<string, unknown>;
  files: { idx: number; path: string; size: number; mime: string; sha256: string }[];
}

/** What the information tab and the sheet say about the copy to Drive. */
export type DriveSyncStatus =
  | { enabled: false }
  | { enabled: true; waiting: number; errors: number; last_seen_at: string | null; last_saved_at: string | null };

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const md5 = (data: string | Buffer) => createHash('md5').update(data).digest('hex');

/** Python's urllib.parse.urlsplit pieces that the item-URL rule looks at. */
export function itemUrlValid(url: string, code: string, itemOrigin: string | null): boolean {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
  if (!m) return false;
  const [, scheme, netloc, urlPath, query, fragment] = m;
  if (netloc!.includes('@')) return false;
  const host = netloc!.startsWith('[') ? netloc!.slice(1, netloc!.indexOf(']')) : netloc!.split(':')[0]!;
  const hostname = host.toLowerCase();
  const validScheme = scheme === 'https' || (scheme === 'http' && ['127.0.0.1', 'localhost', '::1'].includes(hostname));
  return (
    validScheme &&
    !!hostname &&
    urlPath === `/i/${code}` &&
    !query?.slice(1) &&
    !fragment?.slice(1) &&
    Buffer.byteLength(url, 'utf8') <= 180 &&
    ![...url].some((ch) => ch.codePointAt(0)! <= 32) &&
    (itemOrigin === null || url === `${itemOrigin}/i/${code}`)
  );
}

export class RentalStore {
  ledgerGeneration(): number {
    return Number(this.db.prepare("SELECT value FROM config WHERE key='rental_ledger_generation'").get()?.value??0);
  }
  itemVersionFloor(): number {
    return Number(this.db.prepare("SELECT value FROM config WHERE key='rental_item_version_floor'").get()?.value??0);
  }
  checkLedgerGeneration(value:unknown):void {
    const generation=this.ledgerGeneration();
    if((value===undefined&&generation===0)||String(value)===String(generation))return;
    throw new RentalError(409,'台帳が番号を含めて初期化されています。新版ソフトでログインし直し、台帳とラベルを作り直してください。','ledger_reset');
  }
  readonly root: string;
  readonly spool: string;
  readonly db: DatabaseSync;
  /** New operations wait for their copy to Drive (status drive_pending) instead of being only local. */
  readonly driveSync: boolean;

  /** Separate method so tests can inject a disk failure part-way through an operation. */
  writeFile: (target: string, data: Buffer) => void = (target, data) => {
    const fd = openSync(target, 'wx', 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  constructor(dataDir: string, options: { demo?: boolean; driveSync?: boolean } = {}) {
    this.driveSync = options.driveSync ?? false;
    this.root = path.resolve(dataDir);
    mkdirSync(this.root, { recursive: true });
    this.spool = path.join(this.root, 'spool');
    mkdirSync(this.spool, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'rental.sqlite3'));
    try {
      this.prepareSchema(options.demo ?? false);
    } catch (err) {
      // A refused folder must not stay open (Windows keeps open files locked).
      this.db.close();
      throw err;
    }
  }

  private prepareSchema(demo: boolean): void {
    this.db.exec('PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
    const opColumns = new Set(this.all('PRAGMA table_info(operations)').map((r) => r.name));
    for (const [field, definition] of [
      ['mirror_status', 'TEXT'],
      ['mirror_error', 'TEXT'],
      ['mirror_next_retry', 'REAL NOT NULL DEFAULT 0'],
      ['mirror_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['ledger_generation', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!opColumns.has(field)) this.db.exec(`ALTER TABLE operations ADD COLUMN ${field} ${definition}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS operations_mirror_queue ON operations(mirror_status,mirror_next_retry)');
    this.transaction(() => {
      const borrowerColumns = new Set(this.all('PRAGMA table_info(borrowers)').map((r) => r.name));
      if (!borrowerColumns.has('id')) this.db.exec('ALTER TABLE borrowers ADD COLUMN id TEXT');
      for (const b of this.all('SELECT name FROM borrowers WHERE id IS NULL')) this.run('UPDATE borrowers SET id=? WHERE name=?', `B-${randomUUID().replaceAll('-', '')}`, String(b.name));
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS borrowers_id ON borrowers(id)');
      const itemColumns = new Set(this.all('PRAGMA table_info(items)').map((r) => r.name));
      for (const [field, definition] of [
        ['card_kind', "TEXT NOT NULL DEFAULT 'regular' CHECK(card_kind IN ('regular','irregular'))"],
        ['archived_at', 'TEXT'],
        ['item_scope', 'TEXT'],
        ['item_owner', 'TEXT'],
        ['photo_required', 'INTEGER CHECK(photo_required IN (0,1))'],
        ['planned_borrower_id', 'TEXT'],
        ['planned_state', "TEXT NOT NULL DEFAULT 'unassigned'"],
        ['planned_assigned_at', 'TEXT'],
        ['planned_actor_id', 'TEXT'],
        ['planned_consumed_operation', 'TEXT'],
      ] as const) {
        if (!itemColumns.has(field)) this.db.exec(`ALTER TABLE items ADD COLUMN ${field} ${definition}`);
      }
      // Derive the new requirement only for a confirmed scope; legacy unclassified rows stay null.
      this.db.exec("UPDATE items SET photo_required=CASE WHEN item_scope='学外' THEN 1 ELSE 0 END WHERE photo_required IS NULL AND item_scope IN ('学内','学外','委員会')");
    });
    const flag = this.get("SELECT value FROM config WHERE key='demo'");
    const expected = demo ? '1' : '0';
    if (flag && flag.value !== expected) throw new Error('Demo and real rental state must use different data directories.');
    this.run("INSERT OR IGNORE INTO config VALUES('demo',?)", expected);
  }

  get mode(): 'local' | 'drive' {
    return this.driveSync ? 'drive' : 'local';
  }

  /** Cancelled registrations and corrected loan groups (corrections.ts), by operation ID. */
  correctionState(): CorrectionState {
    const voided = new Map<string, VoidedRegistration>();
    const borrowers = new Map<string, CorrectedBorrower>();
    for (const r of this.all("SELECT kind,operation_id,actor_name,server_at,reason,after_json FROM operation_corrections WHERE kind IN ('void','borrower') AND operation_id IS NOT NULL ORDER BY server_at,rowid")) {
      if (r.kind === 'void') voided.set(String(r.operation_id), { server_at: String(r.server_at), actor_name: String(r.actor_name), reason: String(r.reason) });
      else {
        const to = (JSON.parse(String(r.after_json)) as { borrower: { name: unknown; id: unknown } }).borrower;
        borrowers.set(String(r.operation_id), { borrower: String(to.name), borrower_id: String(to.id), server_at: String(r.server_at), actor_name: String(r.actor_name), reason: String(r.reason) });
      }
    }
    return { voided, borrowers };
  }

  /** An operation's record with the group of its loan as corrected. */
  correctedArchive(opId: string, archive: Row, state: CorrectionState): Row {
    const fixed = archive.action === 'borrow' ? state.borrowers.get(opId) : undefined;
    return fixed ? { ...archive, borrower: fixed.borrower, borrower_id: fixed.borrower_id } : archive;
  }

  close(): void {
    this.db.close();
  }

  // ---- small SQLite helpers (also used by item-editor.ts, corrections.ts and drive-sync.ts)

  all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  /** BEGIN IMMEDIATE … COMMIT, rolled back on any error. Synchronous, so nothing interleaves in-process. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- catalogue

  addItems(rows: [string, string][]): void {
    const prepared = rows.map(([code, name]) => {
      itemCode(code);
      if (typeof name !== 'string' || !name.trim() || [...name].length > 200) throw new Error('Item name invalid.');
      return [code, name.trim()] as const;
    });
    this.transaction(() => {
      for (const [code, name] of prepared) this.run('INSERT OR IGNORE INTO items(code,name,version) VALUES(?,?,?)', code, name, this.itemVersionFloor());
    });
  }

  addBorrowers(names: string[]): void {
    const prepared = names.map((n) => borrowerName(n));
    this.transaction(() => {
      for (const name of prepared) this.run('INSERT OR IGNORE INTO borrowers(name,id) VALUES(?,?)', name, `B-${randomUUID().replaceAll('-', '')}`);
    });
  }

  createBorrower(name: unknown): { borrower: { id: string; name: string }; created: boolean } {
    const clean = borrowerName(name);
    return this.transaction(() => {
      const prior = this.get('SELECT id,name FROM borrowers WHERE name=?', clean);
      if (prior) return { borrower: { id: String(prior.id), name: String(prior.name) }, created: false };
      const borrower = { id: `B-${randomUUID().replaceAll('-', '')}`, name: clean };
      this.run('INSERT INTO borrowers(name,id) VALUES(?,?)', clean, borrower.id);
      return { borrower, created: true };
    });
  }

  borrowers(): string[] {
    return this.all('SELECT name FROM borrowers ORDER BY name').map((r) => String(r.name));
  }

  borrowerGroups(): { id: string; name: string }[] {
    return this.all('SELECT id,name FROM borrowers ORDER BY name').map((r) => ({ id: String(r.id), name: String(r.name) }));
  }

  item(code: unknown): Row {
    const c = itemCode(code);
    const row = this.get(
      'SELECT items.*, borrowers.name AS planned_borrower_name, issuance.url FROM items LEFT JOIN borrowers ON borrowers.id=items.planned_borrower_id LEFT JOIN issuance ON issuance.code=items.code WHERE items.code=?',
      c,
    );
    if (!row) throw new RentalError(404, 'この個体コードは未登録です。', 'not_found');
    if (row.archived_at != null) throw new RentalError(410, 'この物品はリセット前の台帳に保管されています。現在のラベルを確認してください。', 'archived_item');
    const current = row.current_loan ? (JSON.parse(String(row.current_loan)) as Row) : null;
    const details = row.card_kind === 'irregular' ? (current?.irregular as IrregularDetails | undefined) : undefined;
    const publicRow: Row = { ...row, ...(details ? { name: details.name, item_scope: details.item_scope, item_owner: details.item_owner, photo_required: details.item_scope === '学外' ? 1 : 0 } : {}) };
    delete publicRow.archived_at;
    if (row.card_kind !== 'irregular') delete publicRow.card_kind;
    return { ...publicRow, photo_required: publicRow.photo_required == null ? null : publicRow.photo_required === 1, current_loan: row.current_loan ? JSON.parse(String(row.current_loan)) : null };
  }

  /** Read-only snapshot for a venue check. Plans and past loans never count as current loans. */
  inspection(code: unknown) {
    const item = this.item(code);
    const fix = this.correctionState();
    const lastRow = this.get(`SELECT id,metadata FROM operations WHERE item_code=? AND ledger_generation=? AND ${NOT_VOIDED} ORDER BY server_at DESC,rowid DESC LIMIT 1`, String(item.code),this.ledgerGeneration());
    const last = lastRow ? JSON.parse(String(lastRow.metadata)) as Row : null;
    const checkRow = this.get(`SELECT id,metadata FROM operations WHERE item_code=? AND action='check' AND ledger_generation=? AND ${NOT_VOIDED} ORDER BY server_at DESC,rowid DESC LIMIT 1`, String(item.code),this.ledgerGeneration());
    const check = checkRow ? JSON.parse(String(checkRow.metadata)) as Row : null;
    const current = item.current_loan as Row | null;
    const active = item.status === 'loaned' || item.status === 'borrowed';
    const op = active && current?.operation_id
      ? this.get("SELECT id,metadata FROM operations WHERE id=? AND item_code=? AND action='borrow'", String(current.operation_id), String(item.code))
      : this.get(`SELECT id,metadata FROM operations WHERE item_code=? AND action='borrow' AND ledger_generation=? AND ${NOT_VOIDED} ORDER BY server_at DESC,rowid DESC LIMIT 1`, String(item.code),this.ledgerGeneration());
    const archive = op ? this.correctedArchive(String(op.id), JSON.parse(String(op.metadata)) as Row, fix) : null;
    const lent = archive ?? (active ? current : null);
    const source = active ? 'current' : item.planned_state === 'pending' && item.planned_borrower_id ? 'planned' : 'last_loan';
    const groupId = source === 'planned' ? item.planned_borrower_id : lent?.borrower_id;
    const groupName = source === 'planned' ? item.planned_borrower_name : lent?.borrower;
    const borrower = groupId ? this.get('SELECT id,name FROM borrowers WHERE id=?', String(groupId))
      : groupName ? this.get('SELECT id,name FROM borrowers WHERE name=?', String(groupName)) : undefined;
    const id = borrower?.id ?? groupId ?? null;
    const name = borrower?.name ?? groupName ?? null;
    const items: { code: string; name: string; item_scope: string; item_owner: string; quantity?: number; unit?: string }[] = name || id ? this.all("SELECT code,name,item_scope,item_owner,current_loan,card_kind FROM items WHERE archived_at IS NULL AND status IN ('loaned','borrowed') ORDER BY code").filter((row) => {
      const loan = row.current_loan ? JSON.parse(String(row.current_loan)) as Row : null;
      return !!loan && (id && loan.borrower_id ? loan.borrower_id === id : !!name && loan.borrower === name);
    }).map((row) => {
      const detail = row.card_kind === 'irregular' ? (JSON.parse(String(row.current_loan)) as { irregular?: IrregularDetails }).irregular : null;
      return { code: String(row.code), name: String(detail?.name ?? row.name), item_scope: String(detail?.item_scope ?? row.item_scope ?? ''), item_owner: String(detail?.item_owner ?? row.item_owner ?? ''), ...(detail ? { quantity: Number(detail.quantity), unit: String(detail.unit) } : {}) };
    }) : [];
    const inventory = new Map<string, { name: string; item_scope: string; item_owner: string; quantity: number; unit?: string; codes: string[] }>();
    for (const row of items) {
      const key = canonical([row.name, row.item_scope, row.item_owner, row.unit ?? '点']);
      const entry = inventory.get(key) ?? { name: row.name, item_scope: row.item_scope, item_owner: row.item_owner, quantity: 0, ...(row.unit ? { unit: row.unit } : {}), codes: [] };
      entry.quantity += row.quantity ?? 1;
      entry.codes.push(row.code);
      inventory.set(key, entry);
    }
    return {
      generated_at: utcNow(), item,
      ...(item.card_kind === 'irregular' ? { irregular_history: this.all('SELECT id,metadata FROM operations WHERE item_code=? AND ledger_generation=? ORDER BY server_at DESC,rowid DESC LIMIT 50', String(item.code), this.ledgerGeneration()).map((r) => {
        const a = this.correctedArchive(String(r.id), JSON.parse(String(r.metadata)) as Row, fix);
        const previous = a.previous_loan as Row | null | undefined;
        const loanFix = previous?.operation_id ? fix.borrowers.get(String(previous.operation_id)) : undefined;
        return { operation_id: a.operation_id, action: a.action, server_at: a.server_at, borrower: a.borrower || loanFix?.borrower || previous?.borrower, irregular: a.irregular, condition: a.condition, note: a.note, ...(fix.voided.has(String(r.id)) ? { voided: true } : {}) };
      }) } : {}),
      latest: last ? { action: last.action, condition: last.condition, note: last.note, server_at: last.server_at } : null,
      last_check: check ? { condition: check.condition, note: check.note, server_at: check.server_at, photos: this.all('SELECT idx FROM files WHERE operation_id=? AND idx>0 ORDER BY idx', String(checkRow!.id)).map((r) => ({ index: Number(r.idx), url: `/api/rental/operations/${String(checkRow!.id)}/photos/${Number(r.idx)}` })) } : null,
      loan: lent ? {
        active, operation_id: op ? String(op.id) : null, borrower: String(lent.borrower ?? ''),
        server_at: String(lent.server_at ?? ''), condition: typeof lent.condition === 'string' ? lent.condition : null,
        ...(lent.irregular ? { irregular: lent.irregular } : {}),
        note: String(lent.note ?? ''), photo_skip: lent.photo_skip === true,
        photos: op ? this.all('SELECT idx FROM files WHERE operation_id=? AND idx>0 ORDER BY idx', String(op.id)).map((row) => ({ index: Number(row.idx), url: `/api/rental/operations/${String(op.id)}/photos/${Number(row.idx)}` })) : [],
      } : null,
      group: name || id ? { id, name: String(name ?? id), source, loaned_total: items.length, inventory: [...inventory.values()], items } : null,
    };
  }

  /** Validated photo access for signed-in rental staff; operation JSON is never served here. */
  loanPhoto(opId: unknown, index: unknown) {
    const id = operationUuid(opId);
    if (typeof index !== 'string' || !/^[1-5]$/.test(index)) throw new RentalError(404, 'この写真は記録されていません。', 'not_found');
    if (!this.get('SELECT id FROM operations WHERE id=?', id)) throw new RentalError(404, '写真は記録されていません。', 'not_found');
    return this.spooledFile(id, Number(index));
  }

  /** Counts for the home screen: items by state, open loans per group, and the items waiting for a check. */
  summary(): RentalSummary {
    const counts = { ready: 0, loaned: 0, review: 0 };
    for (const r of this.all('SELECT status, count(*) AS n FROM items WHERE archived_at IS NULL GROUP BY status')) {
      if (r.status === 'ready' || r.status === 'loaned' || r.status === 'review') counts[r.status] = Number(r.n);
    }
    const total = Number(this.get('SELECT count(*) AS n FROM items WHERE archived_at IS NULL')!.n);
    const planned = Number(this.get("SELECT count(*) AS n FROM items WHERE archived_at IS NULL AND status='ready' AND planned_state='pending'")!.n);
    const groups = new Map<string, { borrower: string; loaned: number; since: string }>();
    for (const r of this.all("SELECT current_loan FROM items WHERE archived_at IS NULL AND status='loaned' AND current_loan IS NOT NULL")) {
      const loan = JSON.parse(String(r.current_loan)) as { borrower?: unknown; server_at?: unknown };
      const borrower = typeof loan.borrower === 'string' ? loan.borrower : '（不明）';
      const at = typeof loan.server_at === 'string' ? loan.server_at : '';
      const g = groups.get(borrower) ?? { borrower, loaned: 0, since: at };
      g.loaned += 1;
      if (at && (!g.since || at < g.since)) g.since = at;
      groups.set(borrower, g);
    }
    const review = this.all("SELECT code,name FROM items WHERE archived_at IS NULL AND status='review' ORDER BY code LIMIT 20").map((r) => ({ code: String(r.code), name: String(r.name) }));
    return {
      total,
      counts,
      planned,
      loanedByGroup: [...groups.values()].sort((a, b) => b.loaned - a.loaned || a.borrower.localeCompare(b.borrower, 'ja')),
      review,
    };
  }

  issuance(code: unknown): { code: string; name: string; url: string } {
    const c = itemCode(code);
    if (this.get('SELECT archived_at FROM items WHERE code=?', c)?.archived_at != null) throw new RentalError(410, 'このNo.はリセット前の台帳に保管されています。', 'archived_item');
    const row = this.get('SELECT code,name,url FROM issuance WHERE code=?', c);
    if (!row) throw new RentalError(404, 'この個体コードのラベル URL は未発行です。', 'not_found');
    return { code: String(row.code), name: String(row.name), url: String(row.url) };
  }

  // ---- planned borrowers (issued before the event; never a loan)

  preassign(values: unknown, actor: Actor, itemOrigin: string | null = null) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 10000) throw new RentalError(400, '事前登録は 1〜10000 個体を指定してください。');
    const seen = new Set<string>();
    const prepared = values.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RentalError(400, '各物品に code/name/url/borrower_id が必要です。');
      const v = value as Record<string, unknown>;
      const code = itemCode(v.code);
      if (seen.has(code)) throw new RentalError(400, '同じ個体コードを 1 回の登録に重複して含められません。');
      seen.add(code);
      const name = textField(v, 'name', 160);
      if (!name || [...name].some((ch) => ch.codePointAt(0)! < 32)) throw new RentalError(400, '物品名は改行なしの 1〜160 文字で指定してください。');
      const url = textField(v, 'url', 180);
      const issuedUrl = this.get('SELECT url FROM issuance WHERE code=?', code)?.url;
      if (!itemUrlValid(url, code, itemOrigin) && !(issuedUrl === url && itemUrlValid(url, code, null))) throw new RentalError(400, 'URL は公開先の /i/個体コード に固定してください。団体情報は URL に含めません。');
      const groupId = v.borrower_id;
      if (typeof groupId !== 'string' || !BORROWER_ID_RE.test(groupId)) throw new RentalError(400, '登録済み団体の borrower_id を指定してください。');
      const givenName = 'borrower_name' in v ? borrowerName(v.borrower_name) : null;
      const scope = 'item_scope' in v ? v.item_scope : undefined;
      if (scope !== undefined && !['学内', '学外', '委員会', '区分未確認'].includes(String(scope))) throw new RentalError(400, '物品区分は学内・学外・委員会・区分未確認を指定してください。');
      if ('item_scope' in v && typeof scope !== 'string') throw new RentalError(400, '物品区分を文字で指定してください。');
      const owner = 'item_owner' in v ? textField(v, 'item_owner', 120) : undefined;
      if ('photo_required' in v && typeof v.photo_required !== 'boolean') throw new RentalError(400, '写真必須は true または false で指定してください。');
      if ('photo_required' in v && scope !== undefined && ['学内','学外','委員会'].includes(String(scope)) && v.photo_required !== (scope === '学外')) throw new RentalError(400, '写真必須は学外物品のみ true にしてください。');
      if (owner !== undefined && (!owner || [...owner].some((ch) => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127))) throw new RentalError(400, '借用元は改行なしの1〜120文字で指定してください。');
      return { code, name, url, groupId, givenName, scope, owner, photoRequired: v.photo_required };
    });
    return this.transaction(() => {
      const items: Row[] = [];
      let created = 0;
      let updated = 0;
      const now = utcNow();
      for (const value of prepared) {
        const group = this.get('SELECT id,name FROM borrowers WHERE id=?', value.groupId);
        if (!group || (value.givenName !== null && value.givenName !== group.name)) throw new RentalError(400, '団体 ID と団体名の対応を確認してください。');
        const row = this.get('SELECT * FROM items WHERE code=?', value.code);
        if (row?.card_kind === 'irregular' || value.code.startsWith('IY-IR-')) throw new RentalError(409, 'イレギュラーカードは通常の物品・予定団体として変更できません。');
        if (row?.archived_at != null) throw new RentalError(409, '保管済みのNo.は再利用できません。新しいNo.を指定してください。', 'archived_code');
        const issued = this.get('SELECT name,url FROM issuance WHERE code=?', value.code);
        if ((row && row.name !== value.name) || (issued && (issued.name !== value.name || issued.url !== value.url))) {
          throw new RentalError(409, '登録済み個体の物品名・発行 URL は変更できません。', 'issuance_conflict');
        }
        const isNew = !row;
        const scope = value.scope === undefined ? (row?.item_scope ?? null) : value.scope;
        const owner = value.owner === undefined ? (value.scope !== undefined && value.scope !== '学外' ? null : (row?.item_owner ?? null)) : value.owner;
        const photoRequired = ['学内','学外','委員会'].includes(String(scope)) ? (scope === '学外' ? 1 : 0) : null;
        if (value.photoRequired !== undefined && (photoRequired === null || value.photoRequired !== (photoRequired === 1))) throw new RentalError(400, '物品区分と写真必須の対応を確認してください。');
        const metadataChanged = scope !== (row?.item_scope ?? null) || owner !== (row?.item_owner ?? null);
        const changed = isNew || row.planned_borrower_id !== group.id || row.planned_state !== 'pending' || metadataChanged;
        if (changed && row && row.status !== 'ready') throw new RentalError(409, '貸出中・要確認の物品に新しい予定団体を割り当てられません。', 'preassignment_state_conflict');
        if (isNew) {
          this.run('INSERT INTO items(code,name,version) VALUES(?,?,?)', value.code, value.name, this.itemVersionFloor());
          created += 1;
        }
        if (metadataChanged) {
          this.run('INSERT INTO item_metadata_events(item_code,previous_scope,item_scope,previous_owner,item_owner,actor_id,server_at) VALUES(?,?,?,?,?,?,?)',
            value.code, (row?.item_scope as string | null) ?? null, scope as string | null, (row?.item_owner as string | null) ?? null, owner as string | null, actor.id, now);
          this.run('UPDATE items SET item_scope=?,item_owner=? WHERE code=?', scope as string | null, owner as string | null, value.code);
        }
        this.run('UPDATE items SET photo_required=? WHERE code=?', photoRequired as number | null, value.code);
        if (!issued) this.run('INSERT INTO issuance(code,name,url,actor_id,server_at) VALUES(?,?,?,?,?)', value.code, value.name, value.url, actor.id, now);
        let version = row ? Number(row.version) : 0;
        if (changed) {
          this.run(
            'INSERT INTO preassignment_events(item_code,borrower_id,previous_borrower_id,previous_state,actor_id,server_at) VALUES(?,?,?,?,?,?)',
            value.code,
            String(group.id),
            row ? ((row.planned_borrower_id as string | null) ?? null) : null,
            row ? String(row.planned_state) : 'unassigned',
            actor.id,
            now,
          );
          this.run(
            "UPDATE items SET planned_borrower_id=?,planned_state='pending',planned_assigned_at=?,planned_actor_id=?,planned_consumed_operation=NULL,version=version+1 WHERE code=?",
            String(group.id),
            now,
            actor.id,
            value.code,
          );
          version += 1;
          updated += 1;
        }
        items.push({ code: value.code, name: value.name, url: value.url, borrower_id: group.id, borrower_name: group.name, planned_state: 'pending', version, created: isNew, updated: changed, ...(scope !== null ? { item_scope: scope } : {}), ...(owner !== null ? { item_owner: owner } : {}) });
      }
      return { items, registered_count: created, updated_count: updated, reused_count: items.length - updated };
    });
  }

  // ---- loans and returns

  private result(opId: string): Receipt {
    const row = this.get('SELECT * FROM operations WHERE id=?', opId);
    if (!row) throw new RentalError(404, 'この処理はまだサーバーに保存されていません。', 'not_found');
    const files = this.all('SELECT idx,state FROM files WHERE operation_id=? AND idx>0', opId);
    const value: Receipt = {
      operation_id: String(row.id),
      item_code: String(row.item_code),
      action: String(row.action),
      status: String(row.status),
      server_at: String(row.server_at),
      photos_count: files.length,
      drive_synced_count: files.filter((f) => f.state === 'complete').length,
    };
    if (row.error) value.error = String(row.error);
    if (row.mirror_status !== null && row.mirror_status !== undefined) {
      value.mirror_status = String(row.mirror_status);
      value.cloud_sync_verified = false;
      if (row.mirror_error) value.mirror_error = String(row.mirror_error);
    }
    return value;
  }

  operation(opId: unknown): Receipt {
    return this.result(operationUuid(opId));
  }

  submit(rawMeta: unknown, photoBytes: Buffer[], actor: Actor): Receipt {
    const meta = validateMetadata(rawMeta);
    if (photoBytes.length > MAX_PHOTOS) throw new RentalError(400, '写真は最大5枚です。');
    const photos: CheckedPhoto[] = photoBytes.map((p) => checkPhoto(p));
    const descriptor = photos.map((p) => ({ sha256: p.sha256, size: p.size, mime: p.mime }));
    const fingerprint = sha256(canonical({ metadata: meta, photos: descriptor }));
    const opId = meta.operation_id;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get('SELECT fingerprint,actor_id FROM operations WHERE id=?', opId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new RentalError(409, '同じ処理 ID に異なる内容は送れません。', 'operation_mismatch');
        if (prior.actor_id !== actor.id) throw new RentalError(403, 'この処理は別のスタッフが登録しています。', 'forbidden');
        const replay = this.result(opId);
        this.db.exec('ROLLBACK');
        return replay;
      }
      const row = this.get('SELECT * FROM items WHERE code=?', meta.item_code);
      if (meta.condition === 'damage' && !meta.note) throw new RentalError(400, '破損がある場合は、場所と内容をメモに書いてください。', 'note_required');
      if (row?.archived_at != null) throw new RentalError(410, 'この物品はリセット前の台帳に保管されています。', 'archived_item');
      if (!row) throw new RentalError(404, 'この個体コードは未登録です。', 'not_found');
      // An irregular card lends whatever is entered at the loan; the return and checks follow that loan.
      const isIrregular = row.card_kind === 'irregular';
      if (isIrregular && meta.action === 'borrow' && !meta.irregular) throw new RentalError(400, '今回貸す物品の品名・数量・区分を入力してください。', 'irregular_required');
      if ((!isIrregular || meta.action !== 'borrow') && meta.irregular) throw new RentalError(400, '物品情報の入力はイレギュラーカードの貸出時だけです。');
      const activeDetails = row.current_loan ? (JSON.parse(String(row.current_loan)) as { irregular?: IrregularDetails }).irregular : undefined;
      if (isIrregular && meta.action !== 'borrow' && (!activeDetails || row.status !== 'loaned')) throw new RentalError(409, 'このカードは貸出中ではありません。過去の内容は履歴で確認してください。');
      const details = isIrregular ? (meta.action === 'borrow' ? meta.irregular : activeDetails) : undefined;
      const photoRequired = details ? details.item_scope === '学外' : row.photo_required == null ? null : row.photo_required === 1;
      if (photoRequired && photoBytes.length < 1) throw new RentalError(400, '学外物品は写真を1枚以上登録してください。', 'photo_required');
      if (photoRequired == null && meta.action === 'borrow' && !meta.photo_skip && photoBytes.length < MIN_BORROW_PHOTOS) throw new RentalError(400, '区分未設定の旧物品は、貸出写真2枚または写真省略の明示が必要です。');
      if (Number(row.version) !== meta.item_version) throw new RentalError(409, '物品の状態が更新されています。読み取り直してください。', 'version_conflict');
      const expected = meta.action === 'borrow' ? 'ready' : 'loaned';
      if (meta.action !== 'check' && row.status !== expected) throw new RentalError(409, 'この物品は現在この操作を受け付けられません。', 'state_conflict');
      const actualGroup = meta.action === 'borrow' ? this.get('SELECT id,name FROM borrowers WHERE name=?', meta.borrower) : undefined;
      if (meta.action === 'borrow' && !actualGroup) throw new RentalError(400, '登録済みの貸出先から選んでください。');
      const serverAt = utcNow();
      const previousLoan = row.current_loan ? (JSON.parse(String(row.current_loan)) as Record<string, unknown>) : null;
      const archive = {
        ...meta,
        server_at: serverAt,
        actor,
        previous_loan: previousLoan,
        photos: descriptor,
        ...(details ? { irregular: details, card_kind: 'irregular' } : {}),
        item_name: details?.name ?? row.name,
        item_scope: details?.item_scope ?? row.item_scope ?? null,
        item_owner: details?.item_owner ?? row.item_owner ?? null,
        photo_required: photoRequired,
        borrower_id: actualGroup ? actualGroup.id : ((previousLoan ?? {}).borrower_id ?? null),
        preassignment: { borrower_id: row.planned_borrower_id ?? null, state: row.planned_state },
      };
      const attempt = path.join(this.spool, opId, randomUUID());
      mkdirSync(attempt, { recursive: true });
      const records: [number, string, number, string, string, string][] = [];
      photos.forEach((photo, i) => {
        const idx = i + 1;
        const target = path.join(attempt, `${String(idx).padStart(2, '0')}.${photo.ext}`);
        this.writeFile(target, photo.data);
        records.push([idx, path.relative(this.root, target), photo.size, photo.mime, photo.sha256, photo.md5]);
      });
      const encoded = Buffer.from(canonical(archive), 'utf8');
      const archiveFile = path.join(attempt, 'operation.json');
      this.writeFile(archiveFile, encoded);
      records.push([0, path.relative(this.root, archiveFile), encoded.length, 'application/json', sha256(encoded), md5(encoded)]);
      this.run(
        'INSERT INTO operations(id,item_code,action,actor_id,fingerprint,metadata,server_at,status,ledger_generation) VALUES(?,?,?,?,?,?,?,?,?)',
        opId,
        meta.item_code,
        meta.action,
        actor.id,
        fingerprint,
        encoded.toString('utf8'),
        serverAt,
        this.driveSync ? 'drive_pending' : 'local_saved',
        this.ledgerGeneration(),
      );
      for (const [idx, rel, size, mime, fileSha, fileMd5] of records) {
        this.run('INSERT INTO files(operation_id,idx,path,size,mime,sha256,md5) VALUES(?,?,?,?,?,?,?)', opId, idx, rel, size, mime, fileSha, fileMd5);
      }
      let newStatus: string;
      let currentLoan: string | null;
      if (meta.action === 'borrow') {
        newStatus = 'loaned';
        // Damage found at the loan travels with the loan, so the return does not blame the group for it.
        const damage = meta.condition === 'damage' ? { condition: 'damage', note: meta.note } : {};
        currentLoan = canonical({ operation_id: opId, borrower: meta.borrower, borrower_id: actualGroup!.id, server_at: serverAt, actor, ...damage, ...(details ? { irregular: details } : {}) });
        if (row.planned_state === 'pending') this.run("UPDATE items SET planned_state='fulfilled',planned_consumed_operation=? WHERE code=?", opId, meta.item_code);
      } else if (meta.action === 'check') {
        newStatus = String(row.status);
        currentLoan = row.current_loan == null ? null : String(row.current_loan);
      } else {
        newStatus = meta.condition === 'normal' ? 'ready' : 'review';
        currentLoan = null;
      }
      this.run('UPDATE items SET status=?,version=version+1,current_loan=? WHERE code=?', newStatus, currentLoan, meta.item_code);
      const receipt = this.result(opId);
      this.db.exec('COMMIT');
      return receipt;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- information tab

  /**
   * Every item with the group it belongs to now: the current loan, else the plan still waiting, else the
   * last loan. The phone's information tab counts these per group, so the cards a group hands back can
   * be checked against its "loaned" count, and lists the missing numbers.
   */
  overview(): { generated_at: string; items: OverviewItem[] } {
    const groupNames = new Map(this.all('SELECT id,name FROM borrowers').map((r) => [String(r.id), String(r.name)]));
    const lastBorrow = new Map<string, Record<string, unknown>>();
    const lastReturn = new Map<string, Record<string, unknown>>();
    const fix = this.correctionState();
    for (const op of this.all('SELECT id,item_code,action,metadata FROM operations WHERE ledger_generation=? ORDER BY server_at,rowid',this.ledgerGeneration())) {
      if (fix.voided.has(String(op.id))) continue;
      const archive = this.correctedArchive(String(op.id), JSON.parse(String(op.metadata)) as Row, fix);
      const code = String(op.item_code);
      if (op.action === 'borrow') {
        lastBorrow.set(code, archive);
        lastReturn.delete(code);
      } else if (op.action === 'return') {
        lastReturn.set(code, archive);
      }
    }
    const group = (id: unknown, fallback: unknown) => (typeof id === 'string' && id ? { id, name: groupNames.get(id) ?? String(fallback ?? id) } : null);
    const items = this.all(
      'SELECT items.code,items.name,items.status,items.item_scope,items.item_owner,items.card_kind,items.current_loan,items.planned_state,items.planned_borrower_id FROM items WHERE archived_at IS NULL ORDER BY items.code',
    ).map((row): OverviewItem => {
      const code = String(row.code);
      const loan = row.current_loan ? (JSON.parse(String(row.current_loan)) as Record<string, unknown>) : null;
      const irregular = loan?.irregular as IrregularDetails | undefined;
      const lent = lastBorrow.get(code);
      const back = lastReturn.get(code);
      const status = String(row.status);
      const planned = row.planned_state === 'pending' ? group(row.planned_borrower_id, null) : null;
      let phase: OverviewItem['phase'];
      let owner: OverviewItem['group'];
      if (status === 'loaned' || status === 'borrowed') {
        phase = 'loaned';
        owner = group(loan?.borrower_id, loan?.borrower);
      } else if (status !== 'ready' && status !== 'available') {
        phase = 'review';
        owner = lent ? group(lent.borrower_id, lent.borrower) : null;
      } else if (planned) {
        phase = 'planned';
        owner = planned;
      } else if (lent) {
        phase = 'returned';
        owner = group(lent.borrower_id, lent.borrower);
      } else {
        phase = 'unassigned';
        owner = null;
      }
      return {
        code,
        name: row.card_kind === 'irregular' && irregular ? `${String(irregular.name)}（${String(irregular.quantity)}${String(irregular.unit)}）` : String(row.name),
        status,
        item_scope: irregular?.item_scope ?? (row.item_scope as string | null) ?? null,
        item_owner: irregular?.item_owner ?? (row.item_owner as string | null) ?? null,
        phase,
        group: owner,
        lent_at: lent ? String(lent.server_at) : null,
        lent_condition: lent ? (lent.condition === 'damage' ? 'damage' : 'normal') : null,
        lent_note: lent ? String(lent.note ?? '') : '',
        lent_photo_skip: lent?.photo_skip === true,
        returned_at: back ? String(back.server_at) : null,
        return_condition: back ? String(back.condition) : null,
        return_note: back ? String(back.note ?? '') : '',
      };
    });
    return { generated_at: utcNow(), items };
  }

  // ---- copy to Google Drive (fetched by the Apps Script over signed requests, drive-sync.ts)

  /**
   * Operations whose files are not all on Drive yet, oldest first, leaving out those waiting for a retry
   * after an error. Files already copied are not listed again. Times are epoch milliseconds.
   */
  driveWaiting(limit: number, nowMs: number): DriveWaiting[] {
    const marks = DRIVE_WAITING.map(() => '?').join(',');
    const ops = this.all(`SELECT * FROM operations WHERE status IN (${marks}) AND next_retry<=? ORDER BY server_at,rowid LIMIT ?`, ...DRIVE_WAITING, nowMs / 1000, limit);
    return ops.map((op) => this.driveEntry(op));
  }

  /** One operation of the queue (also when it is already complete), or null when it is not in the ledger. */
  driveOperation(opId: string): DriveWaiting | null {
    const op = this.get('SELECT * FROM operations WHERE id=?', opId);
    return op ? this.driveEntry(op) : null;
  }

  private driveEntry(op: Row): DriveWaiting {
    const files = this.all("SELECT idx,path,size,mime,sha256 FROM files WHERE operation_id=? AND state!='complete' ORDER BY idx", String(op.id)).map((f) => ({
      idx: Number(f.idx),
      path: String(f.path),
      size: Number(f.size),
      mime: String(f.mime),
      sha256: String(f.sha256),
    }));
    return {
      id: String(op.id),
      item_code: String(op.item_code),
      action: String(op.action),
      server_at: String(op.server_at),
      status: String(op.status),
      archive: JSON.parse(String(op.metadata)) as Record<string, unknown>,
      files,
    };
  }

  /** A spooled photo, read back and checked against the hash recorded when it was accepted. */
  spooledFile(opId: string, idx: number): { data: Buffer; mime: string; sha256: string } {
    const row = this.get('SELECT path,size,mime,sha256 FROM files WHERE operation_id=? AND idx=?', opId, idx);
    if (!row) throw new RentalError(404, 'この写真は記録されていません。', 'not_found');
    const file = path.resolve(this.root, String(row.path));
    if (!file.startsWith(path.resolve(this.spool) + path.sep)) throw new RentalError(500, '保存先が作業フォルダの外を指しています。', 'integrity');
    const data = readFileSync(file);
    if (data.length !== Number(row.size) || sha256(data) !== row.sha256) throw new RentalError(500, 'サーバーに保存した写真の整合性を確認できません。', 'integrity');
    return { data, mime: String(row.mime), sha256: String(row.sha256) };
  }

  /**
   * Records files the Apps Script saved to Drive (contents already checked by the caller). When every
   * file of the operation is on Drive, the operation is complete. A file already recorded with another
   * Drive ID is refused: the script reuses a file it finds by name, so a second copy means a mix-up.
   */
  driveSaved(opId: string, saved: { idx: number; driveId: string }[], at: string): Receipt {
    this.transaction(() => {
      const op = this.get('SELECT status FROM operations WHERE id=?', opId);
      if (!op) throw new RentalError(404, 'この処理は記録されていません。', 'not_found');
      for (const { idx, driveId } of saved) {
        const row = this.get('SELECT drive_id,state FROM files WHERE operation_id=? AND idx=?', opId, idx);
        if (!row) throw new RentalError(400, '記録にないファイルです。');
        if (row.state === 'complete') {
          if (row.drive_id !== driveId) throw new RentalError(409, 'このファイルは別の Drive ファイルとして記録済みです。', 'drive_conflict');
          continue;
        }
        this.run("UPDATE files SET drive_id=?,state='complete' WHERE operation_id=? AND idx=?", driveId, opId, idx);
      }
      if (saved.length > 0) this.run("INSERT INTO config(key,value) VALUES('drive_sync_saved_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", at);
      const left = this.get("SELECT count(*) AS n FROM files WHERE operation_id=? AND state!='complete'", opId)!;
      if (Number(left.n) === 0) this.run("UPDATE operations SET status='complete',error=NULL WHERE id=?", opId);
    });
    return this.result(opId);
  }

  /** The script could not save this operation: shown on the phones, retried after min(300, 5·2^attempts) s. */
  driveFailed(opId: string, code: DriveErrorCode, nowMs: number): Receipt {
    this.transaction(() => {
      const op = this.get('SELECT status,attempts FROM operations WHERE id=?', opId);
      if (!op) throw new RentalError(404, 'この処理は記録されていません。', 'not_found');
      if (op.status === 'complete') return;
      const delay = Math.min(300, 5 * 2 ** Math.min(Number(op.attempts), 6));
      this.run("UPDATE operations SET status='drive_error',error=?,next_retry=?,attempts=attempts+1 WHERE id=?", DRIVE_ERROR_MESSAGES[code], nowMs / 1000 + delay, opId);
    });
    return this.result(opId);
  }

  /** A signed request's nonce, accepted once until it expires; also notes when the script was last seen. */
  acceptSyncNonce(digest: string, expiresMs: number, nowMs: number): boolean {
    return this.transaction(() => {
      this.run('DELETE FROM sync_nonces WHERE expires<?', nowMs);
      if (this.get('SELECT 1 FROM sync_nonces WHERE digest=?', digest)) return false;
      this.run('INSERT INTO sync_nonces(digest,expires) VALUES(?,?)', digest, expiresMs);
      this.run("INSERT INTO config(key,value) VALUES('drive_sync_seen_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", new Date(nowMs).toISOString());
      return true;
    });
  }

  driveSyncStatus(): DriveSyncStatus {
    if (!this.driveSync) return { enabled: false };
    const marks = DRIVE_WAITING.map(() => '?').join(',');
    const waiting = Number(this.get(`SELECT count(*) AS n FROM operations WHERE status IN (${marks})`, ...DRIVE_WAITING)!.n);
    const errors = Number(this.get("SELECT count(*) AS n FROM operations WHERE status='drive_error'")!.n);
    const config = (key: string) => {
      const row = this.get('SELECT value FROM config WHERE key=?', key);
      return row ? String(row.value) : null;
    };
    return { enabled: true, waiting, errors, last_seen_at: config('drive_sync_seen_at'), last_saved_at: config('drive_sync_saved_at') };
  }

  /** Every operation, oldest first, with its archive and whether it is on Drive (for the sheet's history). */
  operationLog(): { id: string; status: string; archive: Record<string, unknown> }[] {
    return this.all('SELECT id,status,metadata FROM operations ORDER BY server_at,rowid').map((r) => ({
      id: String(r.id),
      status: String(r.status),
      archive: JSON.parse(String(r.metadata)) as Record<string, unknown>,
    }));
  }

  // ---- rental permissions of common accounts

  permissionsOf(userId: string): RentalPermission[] {
    return this.all('SELECT permission FROM grants WHERE user_id=? ORDER BY permission', userId)
      .map((r) => String(r.permission))
      .filter((p): p is RentalPermission => (RENTAL_PERMISSIONS as readonly string[]).includes(p));
  }

  /** Replaces one account's rental permissions. Nothing is implied by other roles. */
  setPermissions(userId: string, permissions: RentalPermission[], by: Actor): RentalPermission[] {
    const wanted = [...new Set(permissions)];
    if (wanted.some((p) => !(RENTAL_PERMISSIONS as readonly string[]).includes(p))) throw new RentalError(400, '物品の権限は rental.loan / rental.issue / rental.admin で指定してください。');
    this.transaction(() => {
      this.run('DELETE FROM grants WHERE user_id=?', userId);
      const now = utcNow();
      for (const p of wanted) this.run('INSERT INTO grants(user_id,permission,granted_by,granted_at) VALUES(?,?,?,?)', userId, p, by.id, now);
    });
    return this.permissionsOf(userId);
  }

  listPermissions(): { userId: string; permissions: RentalPermission[] }[] {
    const map = new Map<string, RentalPermission[]>();
    for (const r of this.all('SELECT user_id,permission FROM grants ORDER BY user_id,permission')) {
      const list = map.get(String(r.user_id)) ?? [];
      list.push(r.permission as RentalPermission);
      map.set(String(r.user_id), list);
    }
    return [...map].map(([userId, permissions]) => ({ userId, permissions }));
  }
}
