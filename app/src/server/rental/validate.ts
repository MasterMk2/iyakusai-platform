// Input rules of the rental ledger, ported from the Python server (reference/rental-python/server/store.py).
// The same rules and the same canonical JSON matter beyond validation: an operation queued on a phone
// before the switch to this app may be resent afterwards, and it must hash to the same fingerprint.

export const ITEM_RE = /^IY-[A-Z0-9][A-Z0-9-]{2,39}$/;
export const BORROWER_ID_RE = /^B-[0-9a-f]{32}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MIN_BORROW_PHOTOS = 2;
export const MAX_PIXELS = 16_000_000;

/** An answer the API returns as `{ error, code }` with this status. */
export class RentalError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'invalid_request',
  ) {
    super(message);
  }
}

/**
 * Python's `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`.
 * Object keys are sorted by code point (Python's str ordering), not by UTF-16 unit.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).filter((k) => (value as Record<string, unknown>)[k] !== undefined);
    keys.sort((a, b) => {
      const ca = [...a];
      const cb = [...b];
      for (let i = 0; i < Math.min(ca.length, cb.length); i += 1) {
        const d = ca[i]!.codePointAt(0)! - cb[i]!.codePointAt(0)!;
        if (d !== 0) return d;
      }
      return ca.length - cb.length;
    });
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new TypeError('not JSON');
}

// Python's str.strip() removes every character for which str.isspace() is true.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
export const pyStrip = (s: string): string => s.replace(PY_STRIP, '');

/** Python `len()` counts code points. */
const pyLen = (s: string): number => [...s].length;

export const utcNow = (): string => new Date().toISOString();

export function operationUuid(value: unknown): string {
  if (typeof value !== 'string') throw new RentalError(400, 'operation_id は UUID で指定してください。');
  if (!UUID_V4_RE.test(value)) {
    // Python accepted other spellings as a UUID and only then required the lowercase v4 form.
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value.replace(/^\{|\}$/g, '').replace(/^urn:uuid:/i, ''))) {
      throw new RentalError(400, 'operation_id は小文字の UUID v4 で指定してください。');
    }
    throw new RentalError(400, 'operation_id は UUID で指定してください。');
  }
  return value;
}

export function itemCode(value: unknown): string {
  if (typeof value !== 'string' || !ITEM_RE.test(value)) throw new RentalError(400, '個体コードの形式が正しくありません。');
  return value;
}

export function textField(meta: Record<string, unknown>, key: string, limit: number, fallback = ''): string {
  const value = key in meta ? meta[key] : fallback;
  if (typeof value !== 'string' || pyLen(value) > limit || value.includes('\x00')) throw new RentalError(400, `${key} の形式が正しくありません。`);
  return pyStrip(value);
}

/** A timezone-aware ISO 8601 date-time, as Python's datetime.fromisoformat accepted it with tzinfo. */
function isAwareDateTime(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)$/.exec(text);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d) &&
    Number(h) < 24 &&
    Number(mi) < 60 &&
    (s === undefined || Number(s) < 60)
  );
}

export interface IrregularDetails {
  name: string;
  quantity: number;
  unit: string;
  item_scope: '学内' | '学外' | '委員会';
  item_owner: string;
}

export function irregularDetails(value: unknown): IrregularDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RentalError(400, '今回貸す物品の情報を入力してください。');
  const v = value as Record<string, unknown>;
  const line = (key: string, max: number) => {
    const s = textField(v, key, max);
    if ([...s].some(c => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127)) throw new RentalError(400, '物品情報に改行や制御文字は使えません。');
    return s;
  };
  const name = line('name', 160), unit = line('unit', 20), owner = line('item_owner', 120);
  if (!name || !unit) throw new RentalError(400, '品名・数量の単位を入力してください。');
  if (typeof v.quantity !== 'number' || !Number.isInteger(v.quantity) || v.quantity < 1 || v.quantity > 10000) throw new RentalError(400, '数量は1〜10000の整数で入力してください。');
  if (v.item_scope !== '学内' && v.item_scope !== '学外' && v.item_scope !== '委員会') throw new RentalError(400, '物品区分を選んでください。');
  if (v.item_scope === '学外' && !owner) throw new RentalError(400, '学外物品の借用元を入力してください。');
  return { name, quantity: v.quantity, unit, item_scope: v.item_scope, item_owner: owner };
}

export interface OperationMeta {
  operation_id: string;
  item_code: string;
  item_version: number;
  action: 'borrow' | 'return' | 'check';
  borrower: string;
  condition: 'normal' | 'maintenance' | 'damage';
  note: string;
  client_at: string;
  client_read_at: string;
  /** A loan registered without the two photos (chairs and the like). Present only when chosen. */
  photo_skip?: true;
  irregular?: IrregularDetails;
}

export function validateMetadata(meta: unknown): OperationMeta {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new RentalError(400, 'metadata は JSON オブジェクトで指定してください。');
  const m = meta as Record<string, unknown>;
  const action = m.action;
  if (action !== 'borrow' && action !== 'return' && action !== 'check') throw new RentalError(400, 'action は borrow / return / check です。');
  const version = m.item_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 2 ** 53 - 1) {
    throw new RentalError(400, 'item_version は非負整数で指定してください。');
  }
  const condition = 'condition' in m ? m.condition : 'normal';
  if (condition !== 'normal' && condition !== 'maintenance' && condition !== 'damage') throw new RentalError(400, '状態は normal / maintenance / damage のいずれかです。');
  // At a loan the committee member records whether the item is already damaged.
  if (action === 'borrow' && condition === 'maintenance') throw new RentalError(400, '貸出時の状態は normal（損傷なし）か damage（損傷あり）です。');
  const borrower = textField(m, 'borrower', 120);
  if (action === 'borrow' && !borrower) throw new RentalError(400, '貸出先を指定してください。');
  const note = textField(m, 'note', 2000);
  if (action === 'borrow' && condition === 'damage' && !note) throw new RentalError(400, '破損がある場合は、場所と内容をメモに書いてください。');
  const photoSkip = 'photo_skip' in m ? m.photo_skip : false;
  if (typeof photoSkip !== 'boolean') throw new RentalError(400, 'photo_skip は true または false で指定してください。');
  if (photoSkip && action !== 'borrow') throw new RentalError(400, '写真の省略は貸出だけで指定できます。');
  const stamps: Record<'client_at' | 'client_read_at', string> = { client_at: '', client_read_at: '' };
  for (const key of ['client_at', 'client_read_at'] as const) {
    const stamp = textField(m, key, 60);
    stamps[key] = stamp;
    if (stamp && !isAwareDateTime(stamp)) throw new RentalError(400, `${key} はタイムゾーン付き日時で指定してください。`);
  }
  // Actor or staff fields sent by the client are ignored on purpose: the server decides who acted.
  // photo_skip is left out unless chosen, so operations from before it existed keep their fingerprint.
  return {
    operation_id: operationUuid(m.operation_id),
    item_code: itemCode(m.item_code),
    item_version: version,
    action,
    borrower,
    condition,
    note,
    ...stamps,
    ...(photoSkip ? { photo_skip: true as const } : {}),
    ...('irregular' in m ? { irregular: irregularDetails(m.irregular) } : {}),
  };
}

export function borrowerName(name: unknown): string {
  if (typeof name !== 'string' || !pyStrip(name) || pyLen(name) > 120 || [...name].some((ch) => ch.codePointAt(0)! < 32)) {
    throw new RentalError(400, '団体名は改行なしの 1〜120 文字で指定してください。');
  }
  return pyStrip(name);
}
