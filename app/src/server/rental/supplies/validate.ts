import { itemCode, pyStrip, RentalError } from '../validate.js';

// Input rules of the supply extension. Every rule is checked on the server; the phone screen repeats them
// only to show the message next to the field.

export const SUPPLY_KINDS = ['lend', 'consumable'] as const;
export type SupplyKind = (typeof SUPPLY_KINDS)[number];
export const OWNER_KINDS = ['card', 'supply'] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];
export const CHECK_PHASES = ['borrow', 'return', 'check'] as const;
export type CheckPhase = (typeof CHECK_PHASES)[number];

const SUPPLY_ID_RE = /^S-[0-9a-f]{32}$/;
const ATTACHMENT_ID_RE = /^A-[0-9a-f]{32}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MAX_QTY = 9999;
export const MAX_ATTACHMENTS_PER_OWNER = 30;
export const MAX_LINES = 60;

export function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new RentalError(400, 'JSON オブジェクトで送信してください。');
  }
  return value as Record<string, unknown>;
}

export function arrayOf(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new RentalError(400, `${label}は${min}〜${max}件で指定してください。`);
  }
  return value;
}

/** An integer in [min, max]. Strings and fractions are refused, not rounded. */
export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RentalError(400, `${label}は${min}〜${max}の整数で入力してください。`);
  }
  return value;
}

/** Single-line text, trimmed like the card ledger trims its own text. Control characters are refused. */
export function line(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string') throw new RentalError(400, `${label}を文字で入力してください。`);
  const text = pyStrip(value);
  if (required && !text) throw new RentalError(400, `${label}を入力してください。`);
  if ([...text].length > max) throw new RentalError(400, `${label}は${max}文字以内で入力してください。`);
  if ([...text].some((ch) => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127)) {
    throw new RentalError(400, `${label}に改行や制御文字は使えません。`);
  }
  return text;
}

/** Free text (a note) may have line breaks, but no other control characters. */
export function note(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new RentalError(400, `${label}を文字で入力してください。`);
  const text = pyStrip(value);
  if ([...text].length > max) throw new RentalError(400, `${label}は${max}文字以内で入力してください。`);
  if ([...text].some((ch) => { const c = ch.codePointAt(0)!; return c < 32 && c !== 10 && c !== 9 || c === 127; })) {
    throw new RentalError(400, `${label}に使えない文字が含まれています。`);
  }
  return text;
}

export function supplyId(value: unknown): string {
  if (typeof value !== 'string' || !SUPPLY_ID_RE.test(value)) throw new RentalError(400, '物品の ID の形式が正しくありません。', 'not_found');
  return value;
}

export function attachmentId(value: unknown): string {
  if (typeof value !== 'string' || !ATTACHMENT_ID_RE.test(value)) throw new RentalError(400, '付属品の ID の形式が正しくありません。', 'not_found');
  return value;
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_RE.test(value)) throw new RentalError(400, 'id は小文字の UUID v4 で指定してください。');
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RentalError(400, `${label}は ${allowed.join(' / ')} のいずれかです。`);
  }
  return value as T;
}

/** The owner of an attachment: a card (its individual code) or a counted supply item (its ID). */
export function ownerKey(kind: OwnerKind, value: unknown): string {
  if (kind === 'card') return itemCode(value);
  return supplyId(value);
}

export { itemCode };
