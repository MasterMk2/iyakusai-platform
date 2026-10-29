import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyBytesSignature } from '../tasks/signing.js';
import { DRIVE_ERROR_CODES, type DriveErrorCode, type DriveWaiting, type RentalStore } from './store.js';
import { canonical, RentalError } from './validate.js';

// Copies of the rental ledger in the committee's shared Drive, made by an Apps Script
// (deploy/unified/gas/sync_rental_to_drive.gs) running on a committee account. The app holds no Google
// credential: the script fetches what is waiting over requests signed with svc-auth/v1 (client
// "rental-drive-sync", key file SMM_RENTAL_DRIVE_SYNC_KEY_FILE), writes it to Drive, and reports back.
//
//   GET  /v1/rental/sync/pending?limit=<1-20>        operations whose files are not all on Drive, oldest first
//   GET  /v1/rental/sync/file?op=<uuid>&idx=<0-5>    one file: a photo as accepted, or (idx 0) the record
//   POST /v1/rental/sync/ack                         { operation_id, saved: [{ idx, drive_id, sha256, size }], error? }
//   GET  /v1/rental/sync/ledger?known=<version>      the sheet's contents, or { unchanged } when the version is the same
//
// Drive layout (names made here, so the script only creates what it is told):
//   <root>/物品別/<IY-100123>_No.123_<物品名>/<20261017-102345>_貸出_<団体>_<操作IDの先頭8字>_01.jpg … _記録.json
// The record is written for people: it leaves out the login ID and replaces a name that is only a
// student or login ID (an account without a roster name) with "（氏名未登録）". The raw operation.json
// stays on the server. Nothing on Drive is overwritten or deleted by this route or the script.

export const SYNC_CLIENT = 'rental-drive-sync';
export const SYNC_ACK_PATH = '/v1/rental/sync/ack';
const MAX_SKEW_MS = 5 * 60_000;
const MAX_ACK_BYTES = 16 * 1024;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,160}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// ---- names and texts as they appear on Drive and in the sheet

const JST = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** "2026-10-17 10:23:45" (Japan time) from an ISO time; '' when there is none. */
function jstParts(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : JST.format(t);
}

/** "2026/10/17 10:23:45" in Japan time. */
export function jstText(iso: unknown): string {
  return jstParts(iso).replaceAll('-', '/');
}

/** "20261017-102345" in Japan time, for file names that sort by time. */
export function jstStamp(iso: unknown): string {
  return jstParts(iso).replace(/[-:]/g, '').replace(' ', '-');
}

/** The short number written by hand and printed on labels: IY-100123 → "123" (the phone's shortNumber). */
export function itemNumber(code: string): string | null {
  const m = /^IY-1(\d{5})$/.exec(code);
  return m && Number(m[1]) ? String(Number(m[1])) : null;
}

/** A name part safe for Drive and for people: no path or control characters, single spaces, bounded length. */
export function driveSafe(text: unknown, max: number, fallback: string): string {
  const replaced = [...String(text ?? '')].map((ch) => (ch.codePointAt(0)! < 32 || ch === '\u007f' || '\\/:*?"<>|'.includes(ch) ? '_' : ch)).join('');
  const clean = [...replaced.replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
  return clean || fallback;
}

/** Folder of one item under 物品別. */
export function itemFolderName(code: string, name: unknown): string {
  const no = itemNumber(code);
  return `${code}${no ? `_No.${no}` : ''}_${driveSafe(name, 60, '物品名なし')}`;
}

const ACTION_LABELS: Record<string, string> = { borrow: '貸出', return: '返却', check: '随時チェック' };
const BORROW_CONDITIONS: Record<string, string> = { normal: '損傷なし', damage: '損傷あり' };
const RETURN_CONDITIONS: Record<string, string> = { normal: '異常なし', maintenance: '要清掃・整備', damage: '破損・不足' };
const PHASE_LABELS: Record<string, string> = { loaned: '貸出中', review: '要確認', planned: '予定', returned: '返却済', unassigned: '未割当' };
const PHASE_ORDER = ['loaned', 'review', 'planned', 'returned', 'unassigned'];

function conditionLabel(action: unknown, condition: unknown): string {
  const table = action === 'borrow' ? BORROW_CONDITIONS : RETURN_CONDITIONS;
  return table[String(condition)] ?? String(condition ?? '');
}

/** The group of an operation: the loan's group, or for a return the group of the loan it ends. */
function groupOf(archive: Record<string, unknown>): string {
  const own = typeof archive.borrower === 'string' ? archive.borrower : '';
  const previous = archive.previous_loan && typeof archive.previous_loan === 'object' ? (archive.previous_loan as Record<string, unknown>).borrower : '';
  return own || (typeof previous === 'string' ? previous : '');
}

/**
 * The person who acted, for Drive and the sheet. An account without a roster name shows its student ID
 * or login ID as its display name; neither is written to Drive.
 */
export function actorLabel(archive: Record<string, unknown>): string {
  const actor = archive.actor && typeof archive.actor === 'object' ? (archive.actor as Record<string, unknown>) : {};
  const name = typeof actor.name === 'string' ? actor.name.trim() : '';
  if (!name || /^iy-/i.test(name) || (/^[0-9A-Z]{5,12}$/.test(name) && /\d/.test(name)) || name === actor.id) return '（氏名未登録）';
  return name;
}

interface ExportFile {
  idx: number;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

interface ExportOperation {
  operation_id: string;
  item_code: string;
  action: string;
  server_at: string;
  folder: string;
  files: ExportFile[];
}

/** File names of one operation; photos keep their extension, the record is idx 0. */
function fileBase(op: { id: string; action: string; server_at: string; archive: Record<string, unknown> }): string {
  return `${jstStamp(op.server_at)}_${ACTION_LABELS[op.action] ?? op.action}_${driveSafe(groupOf(op.archive), 30, '団体不明')}_${op.id.slice(0, 8)}`;
}

function photoName(base: string, idx: number, filePath: string): string {
  return `${base}_${String(idx).padStart(2, '0')}${path.extname(filePath).toLowerCase() || '.bin'}`;
}

/** The record written next to the photos (idx 0), the same bytes every time it is built. */
export function recordBytes(op: { id: string; action: string; server_at: string; item_code: string; archive: Record<string, unknown> }, photos: { idx: number; path: string; sha256: string }[]): Buffer {
  const a = op.archive;
  const base = fileBase(op);
  const names = photos.map((p) => photoName(base, p.idx, p.path));
  const record = {
    種類: '物品の貸出・返却の記録（委員会アプリから自動保存）',
    操作: ACTION_LABELS[op.action] ?? op.action,
    '日時（日本時間）': jstText(op.server_at),
    個体コード: op.item_code,
    'No.': itemNumber(op.item_code) ?? '',
    物品名: typeof a.item_name === 'string' ? a.item_name : '',
    団体: groupOf(a),
    状態: conditionLabel(op.action, a.condition),
    メモ: typeof a.note === 'string' ? a.note : '',
    写真: a.photo_skip === true && names.length === 0 ? '省略' : names,
    写真の省略: a.photo_skip === true,
    担当: actorLabel(a),
    操作ID: op.id,
    '写真の SHA-256': Object.fromEntries(names.map((n, i) => [n, photos[i]!.sha256])),
  };
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** All photo rows of an operation (also those already on Drive), for the record's list of photos. */
function allPhotos(store: RentalStore, opId: string): { idx: number; path: string; sha256: string }[] {
  return store.db
    .prepare('SELECT idx,path,sha256 FROM files WHERE operation_id=? AND idx>0 ORDER BY idx')
    .all(opId)
    .map((r) => ({ idx: Number(r.idx), path: String(r.path), sha256: String(r.sha256) }));
}

/** One queued operation as the script sees it: photos first, the record last. */
function exportOperation(store: RentalStore, op: DriveWaiting): ExportOperation {
  const base = fileBase(op);
  const files: ExportFile[] = [];
  for (const f of op.files.filter((x) => x.idx > 0)) files.push({ idx: f.idx, name: photoName(base, f.idx, f.path), mime: f.mime, size: f.size, sha256: f.sha256 });
  if (op.files.some((x) => x.idx === 0)) {
    const bytes = recordBytes(op, allPhotos(store, op.id));
    files.push({ idx: 0, name: `${base}_記録.json`, mime: 'application/json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { operation_id: op.id, item_code: op.item_code, action: op.action, server_at: op.server_at, folder: itemFolderName(op.item_code, op.archive.item_name), files };
}

/** The bytes of one file as the script must store them. */
function exportFile(store: RentalStore, opId: string, idx: number): { data: Buffer; mime: string } {
  if (idx > 0) return store.spooledFile(opId, idx);
  const op = store.driveOperation(opId);
  if (!op) throw new RentalError(404, 'この処理は記録されていません。', 'not_found');
  return { data: recordBytes(op, allPhotos(store, opId)), mime: 'application/json' };
}

// ---- the sheet

/** Sheets reads a cell starting with = + - @ as a formula; a leading apostrophe keeps it text. */
const cell = (value: unknown): string => {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
};

export interface LedgerSheet {
  name: string;
  rows: string[][];
}

export interface LedgerPayload {
  version: string;
  generated_at: string;
  /** Where the script writes the time of each check (also when nothing changed). */
  stamp: { sheet: string; cell: string };
  unchanged?: true;
  sheets?: LedgerSheet[];
}

const INFO_SHEET = '更新情報';

export function ledgerPayload(store: RentalStore, now: Date): Omit<LedgerPayload, 'unchanged'> & { sheets: LedgerSheet[] } {
  const overview = store.overview();
  const status = store.driveSyncStatus();

  // 物品一覧: the phone's CSV (団体, then state, then code).
  const groups = new Map<string, { name: string; items: typeof overview.items }>();
  for (const item of overview.items) {
    const id = item.group?.id ?? '';
    const g = groups.get(id) ?? { name: item.group?.name ?? '団体の割当なし', items: [] };
    g.items.push(item);
    groups.set(id, g);
  }
  const ordered = [...groups.entries()].sort(([ia, a], [ib, b]) => Number(!ia) - Number(!ib) || a.name.localeCompare(b.name, 'ja'));
  const byPhase = (a: (typeof overview.items)[number], b: (typeof overview.items)[number]) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) || a.code.localeCompare(b.code);
  const items: string[][] = [['団体', '状況', 'No.', '個体コード', '物品名', '貸出日時', '貸出時の状態', '貸出時のメモ', '写真の省略', '返却日時', '返却時の状態', '返却時のメモ', '物品区分', '借用元']];
  const perGroup: string[][] = [['団体', '貸出中', '要確認', '予定', '返却済', '未割当', '合計', '貸出中・要確認の No.']];
  for (const [id, g] of ordered) {
    const sorted = [...g.items].sort(byPhase);
    for (const i of sorted) {
      items.push([
        id ? g.name : '',
        PHASE_LABELS[i.phase] ?? i.phase,
        itemNumber(i.code) ?? '',
        i.code,
        i.name,
        jstText(i.lent_at),
        i.lent_condition ? BORROW_CONDITIONS[i.lent_condition]! : '',
        i.lent_note,
        i.lent_photo_skip ? '省略' : '',
        jstText(i.returned_at),
        i.return_condition ? (RETURN_CONDITIONS[i.return_condition] ?? i.return_condition) : '',
        i.return_note,
        i.item_scope ?? '区分未確認',
        i.item_owner ?? '',
      ]);
    }
    const count = (phase: string) => String(g.items.filter((i) => i.phase === phase).length);
    const open = sorted.filter((i) => i.phase === 'loaned' || i.phase === 'review').map((i) => itemNumber(i.code) ?? i.code);
    perGroup.push([g.name, count('loaned'), count('review'), count('planned'), count('returned'), count('unassigned'), String(g.items.length), open.join(' ')]);
  }

  // 操作履歴: newest first. A cancelled registration keeps its row with a mark, the group of a loan shows
  // its correction, and each correction is a row of its own (corrections.ts; nothing on Drive is rewritten).
  const names = new Map(overview.items.map((i) => [i.code, i.name]));
  const history: string[][] = [['日時', '操作', 'No.', '個体コード', '物品名', '団体', '状態', 'メモ', '写真', '担当', 'Drive']];
  const fix = store.correctionState();
  const operations = store.operationLog();
  const byId = new Map(operations.map((op) => [op.id, op.archive]));
  const groupText = (opId: string, a: Record<string, unknown>): string => {
    const group = groupOf(a);
    const previous = a.previous_loan && typeof a.previous_loan === 'object' ? (a.previous_loan as Record<string, unknown>) : null;
    const loanId = a.action === 'borrow' ? opId : previous ? previous.operation_id : null;
    const fixed = loanId ? fix.borrowers.get(String(loanId)) : undefined;
    return fixed && fixed.borrower !== group ? `${fixed.borrower}（訂正前：${group || '団体不明'}）` : group;
  };
  const entries: { at: string; order: number; row: string[] }[] = operations.map((op, order) => {
    const a = op.archive;
    const code = String(a.item_code ?? '');
    const photos = Array.isArray(a.photos) ? a.photos.length : 0;
    return {
      at: String(a.server_at ?? ''),
      order,
      row: [
        jstText(a.server_at),
        `${ACTION_LABELS[String(a.action)] ?? String(a.action ?? '')}${fix.voided.has(op.id) ? '（取消済み）' : ''}`,
        itemNumber(code) ?? '',
        code,
        typeof a.item_name === 'string' ? a.item_name : (names.get(code) ?? ''),
        groupText(op.id, a),
        conditionLabel(a.action, a.condition),
        typeof a.note === 'string' ? a.note : '',
        a.photo_skip === true && photos === 0 ? '省略' : `${photos}枚`,
        actorLabel(a),
        op.status === 'complete' ? '保存済み' : op.status === 'drive_error' ? 'エラー（再試行）' : '待ち',
      ],
    };
  });
  const CORRECTION_LABELS: Record<string, string> = { void: '登録の取消', borrower: '貸出先の訂正', release: '要確認の解除' };
  for (const c of store.all('SELECT kind,item_code,operation_id,actor_id,actor_name,server_at,reason,before_json,after_json FROM operation_corrections ORDER BY server_at,rowid')) {
    const code = String(c.item_code);
    const target = c.operation_id ? byId.get(String(c.operation_id)) : undefined;
    const before = JSON.parse(String(c.before_json)) as { borrower?: { name?: string } };
    const after = JSON.parse(String(c.after_json)) as { borrower?: { name?: string } };
    entries.push({
      at: String(c.server_at),
      order: entries.length,
      row: [
        jstText(String(c.server_at)),
        CORRECTION_LABELS[String(c.kind)] ?? String(c.kind),
        itemNumber(code) ?? '',
        code,
        names.get(code) ?? (typeof target?.item_name === 'string' ? target.item_name : ''),
        c.kind === 'borrower' ? `${after.borrower?.name ?? ''}（訂正前：${before.borrower?.name || '団体不明'}）` : target ? groupText(String(c.operation_id), target) : '',
        c.kind === 'void' && target ? `${ACTION_LABELS[String(target.action)] ?? String(target.action ?? '')}（${jstText(target.server_at)}）を取消` : c.kind === 'release' ? '貸出可能に戻した' : '',
        String(c.reason),
        '',
        actorLabel({ actor: { id: String(c.actor_id), name: String(c.actor_name) } }),
        '台帳のみ',
      ],
    });
  }
  entries.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : y.order - x.order));
  for (const entry of entries) history.push(entry.row);

  const info: string[][] = [
    ['項目', '内容'],
    ['最後に確認した時刻（日本時間）', ''],
    ['一覧を書き出した時刻（日本時間）', jstText(now.toISOString())],
    ['物品の数', String(overview.items.length)],
    ['Drive への保存待ちの操作', status.enabled ? String(status.waiting) : ''],
    ['うち保存エラー（自動で再試行）', status.enabled ? String(status.errors) : ''],
    ['このファイルについて', '委員会アプリ（app.iyakusai.com）の物品の台帳から自動で書き出しています。手で書き換えても次の更新で元に戻ります。写真と記録は同じフォルダの「物品別」にあります。'],
  ];
  const sheets: LedgerSheet[] = [
    { name: INFO_SHEET, rows: info },
    { name: '物品一覧', rows: items },
    { name: '団体別', rows: perGroup },
    { name: '操作履歴', rows: history },
  ].map((s) => ({ name: s.name, rows: s.rows.map((r) => r.map(cell)) }));
  // The version leaves out the export time, so an unchanged ledger is not written again.
  const stable = sheets.map((s) => (s.name === INFO_SHEET ? { ...s, rows: s.rows.filter((r) => r[0] !== '一覧を書き出した時刻（日本時間）') } : s));
  const version = createHash('sha256').update(canonical(stable)).digest('hex');
  return { version, generated_at: now.toISOString(), stamp: { sheet: INFO_SHEET, cell: 'B2' }, sheets };
}

// ---- signed requests

export interface SyncRequest {
  method: string;
  /** Path with query, exactly as sent (the signed string covers it). */
  url: string;
  /** Raw header names and values in order (Node's rawHeaders), so a repeated x-svc-* header is refused. */
  rawHeaders: string[];
  body: Buffer;
}

export interface SyncResponse {
  status: number;
  /** JSON body, or bytes for a file. */
  json?: unknown;
  bytes?: Buffer;
  contentType?: string;
}

export interface DriveSyncOptions {
  store: RentalStore;
  key: Buffer;
  now?: () => number;
}

const rejected = (): SyncResponse => ({ status: 401, json: { error: 'rejected', message: 'Drive sync request rejected' } });

/**
 * The four sync routes as one synchronous function (the ledger is synchronous SQLite), so the Apps
 * Script can be run in tests against it exactly as it calls the app.
 */
export function createDriveSyncHandler(opts: DriveSyncOptions): (request: SyncRequest) => SyncResponse {
  const { store, key } = opts;
  const now = opts.now ?? Date.now;

  function verified(request: SyncRequest): boolean {
    const headers = new Map<string, string>();
    const raw = request.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i]!.toLowerCase();
      if (name === 'origin') return false; // never a browser
      if (!name.startsWith('x-svc-')) continue;
      if (headers.has(name)) return false;
      headers.set(name, raw[i + 1]!);
    }
    const allowed = ['x-svc-client', 'x-svc-timestamp', 'x-svc-nonce', 'x-svc-actor', 'x-svc-signature'];
    if ([...headers.keys()].some((k) => !allowed.includes(k))) return false;
    const client = headers.get('x-svc-client');
    const timestamp = headers.get('x-svc-timestamp');
    const nonce = headers.get('x-svc-nonce');
    const signature = headers.get('x-svc-signature');
    const actor = headers.get('x-svc-actor') ?? '';
    const at = now();
    if (client !== SYNC_CLIENT || actor !== '' || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(at - Number(timestamp)) > MAX_SKEW_MS) return false;
    if (!nonce || !/^[-_A-Za-z0-9]{24,128}$/.test(nonce) || !signature) return false;
    if (!verifyBytesSignature(key, { client, method: request.method, path: request.url, timestamp, nonce, actor: '' }, request.body, signature)) return false;
    // Accepted once (durably), so a captured request cannot be replayed.
    const digest = createHmac('sha256', key).update(JSON.stringify(['rental-drive-sync-replay', client, nonce])).digest('hex');
    return store.acceptSyncNonce(digest, Math.max(at, Number(timestamp)) + MAX_SKEW_MS + 1000, at);
  }

  function ack(body: Buffer): SyncResponse {
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      return { status: 400, json: { error: 'invalid_request', message: 'JSON を解釈できません。' } };
    }
    const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    const opId = v?.operation_id;
    const saved = v?.saved ?? [];
    const error = v?.error;
    if (!v || typeof opId !== 'string' || !/^[0-9a-f-]{36}$/.test(opId) || !Array.isArray(saved) || saved.length > 6 || (error !== undefined && !DRIVE_ERROR_CODES.includes(error as DriveErrorCode))) {
      return { status: 400, json: { error: 'invalid_request', message: '報告の形式が正しくありません。' } };
    }
    const op = store.driveOperation(opId);
    if (!op) return { status: 404, json: { error: 'not_found', message: 'この処理は記録されていません。' } };
    const expected = new Map(exportOperation(store, op).files.map((f) => [f.idx, f]));
    const entries: { idx: number; driveId: string }[] = [];
    for (const s of saved as unknown[]) {
      const e = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      if (!Number.isInteger(e.idx) || typeof e.drive_id !== 'string' || !DRIVE_ID_RE.test(e.drive_id) || typeof e.sha256 !== 'string' || !SHA256_RE.test(e.sha256) || !Number.isInteger(e.size)) {
        return { status: 400, json: { error: 'invalid_request', message: '保存したファイルの報告の形式が正しくありません。' } };
      }
      const want = expected.get(e.idx as number);
      // Already on Drive: driveSaved accepts the same ID again and refuses another one.
      if (!want) {
        entries.push({ idx: e.idx as number, driveId: e.drive_id });
        continue;
      }
      if (want.sha256 !== e.sha256 || want.size !== e.size) {
        // Set aside with a retry delay, so one operation cannot hold up the queue behind it.
        store.driveFailed(opId, 'integrity', now());
        return { status: 409, json: { error: 'integrity', message: 'Drive に保存した内容がサーバーの記録と一致しません。' } };
      }
      entries.push({ idx: e.idx as number, driveId: e.drive_id });
    }
    const at = new Date(now()).toISOString();
    let receipt;
    try {
      receipt = store.driveSaved(opId, entries, at);
    } catch (err) {
      if (err instanceof RentalError && err.status === 409) store.driveFailed(opId, 'name_conflict', now());
      throw err;
    }
    if (error !== undefined && receipt.status !== 'complete') receipt = store.driveFailed(opId, error as DriveErrorCode, now());
    return { status: 200, json: receipt };
  }

  return (request: SyncRequest): SyncResponse => {
    const method = request.method.toUpperCase();
    const pending = /^\/v1\/rental\/sync\/pending\?limit=([1-9]|1\d|20)$/.exec(request.url);
    const file = /^\/v1\/rental\/sync\/file\?op=([0-9a-f-]{36})&idx=([0-5])$/.exec(request.url);
    const ledger = /^\/v1\/rental\/sync\/ledger\?known=([0-9a-f]{64})?$/.exec(request.url);
    const isAck = request.url === SYNC_ACK_PATH;
    const shape = method === 'GET' ? (pending || file || ledger) && request.body.length === 0 : method === 'POST' && isAck && request.body.length <= MAX_ACK_BYTES;
    if (!shape || !verified(request)) return rejected();
    try {
      if (pending) {
        const ops = store.driveWaiting(Number(pending[1]), now()).map((op) => exportOperation(store, op));
        return { status: 200, json: { operations: ops, drive_sync: store.driveSyncStatus() } };
      }
      if (file) {
        const out = exportFile(store, file[1]!, Number(file[2]));
        return { status: 200, bytes: out.data, contentType: out.mime };
      }
      if (ledger) {
        const payload = ledgerPayload(store, new Date(now()));
        if (ledger[1] === payload.version) return { status: 200, json: { version: payload.version, generated_at: payload.generated_at, stamp: payload.stamp, unchanged: true } };
        return { status: 200, json: payload };
      }
      return ack(request.body);
    } catch (err) {
      if (err instanceof RentalError) return { status: err.status, json: { error: err.code, message: err.message } };
      throw err;
    }
  };
}

/** Mounts the sync routes. The body of the report is read as bytes so that its signature can be checked. */
export function attachRentalDriveSync(app: FastifyInstance, opts: DriveSyncOptions): void {
  const handle = createDriveSyncHandler(opts);
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_ACK_BYTES }, (_request, body, done) => done(null, body));
    const route = async (request: FastifyRequest, reply: FastifyReply) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const out = handle({ method: request.method, url: request.url, rawHeaders: request.raw.rawHeaders, body });
      reply.code(out.status).header('Cache-Control', 'no-store');
      if (out.bytes) {
        return reply
          .header('Content-Type', out.contentType ?? 'application/octet-stream')
          .header('X-Content-SHA256', createHash('sha256').update(out.bytes).digest('hex'))
          .send(out.bytes);
      }
      return reply.send(out.json);
    };
    for (const p of ['/v1/rental/sync/pending', '/v1/rental/sync/file', '/v1/rental/sync/ledger']) scope.get(p, route);
    scope.post(SYNC_ACK_PATH, { bodyLimit: MAX_ACK_BYTES }, route);
  });
}
