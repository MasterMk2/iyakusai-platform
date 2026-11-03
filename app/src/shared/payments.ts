// Payments (入金確認, 2026-11-03): invoices to the organizations of the 団体の台帳, the bank statement's deposits, and
// the matching of the two by the accounting section (会計課). The rules shared by the server (checks, the statement
// rows, the names, the ranking of candidates) and the screen (the same messages and the same reading of a CSV before
// anything is sent). Synthetic data only in tests; no personal data in this file.

export const ACCOUNTING_PERMISSIONS = ['accounting.view', 'accounting.confirm'] as const;
export type AccountingPermission = (typeof ACCOUNTING_PERMISSIONS)[number];

export const ACCOUNTING_PERMISSION_LABELS: Record<AccountingPermission, string> = {
  'accounting.view': '会計を見る',
  'accounting.confirm': '請求と入金の確定',
};

/** open: nothing received; partial: part of it; paid: settled (in full, over, or a shortfall accepted); void: withdrawn. */
export const INVOICE_STATES = ['open', 'partial', 'paid', 'void'] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export const INVOICE_STATE_LABELS: Record<InvoiceState, string> = {
  open: '未入金',
  partial: '一部入金',
  paid: '入金済み',
  void: '取り消した請求',
};

export const PAYMENT_LIMITS = {
  number: 30,
  memo: 500,
  payerKana: 60,
  note: 200,
  amountMax: 999_999_999,
  /** Rows of one statement import (not counting the header). */
  statementRows: 3000,
  statementCell: 200,
  /** Deposits put on one invoice in one confirmation. */
  confirmMax: 20,
  candidates: 10,
  fiscalYearMin: 2000,
  fiscalYearMax: 2100,
} as const;

export class PaymentValidationError extends Error {
  constructor(
    readonly field: string | null,
    message: string,
  ) {
    super(message);
  }
}

const fail = (field: string | null, message: string): never => {
  throw new PaymentValidationError(field, message);
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ORG_ID = /^og_[0-9a-f]{16}$/;
const INVOICE_NUMBER = /^[0-9A-Za-z][0-9A-Za-z_-]{0,29}$/;

function text(value: unknown, max: number, label: string, multiline = false): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return fail(null, `${label}の形式が正しくありません。`);
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  const out = multiline ? normalized.trim() : normalized.replace(/\s+/g, ' ').trim();
  if ((multiline ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(out)) return fail(null, `${label}に使えない文字があります。`);
  if (out.length > max) return fail(null, `${label}は ${max} 文字までです。`);
  return out;
}

/** A calendar date written as YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today in Japan (the committee's day), as YYYY-MM-DD. */
export function tokyoDate(at: Date | number | string = new Date()): string {
  return new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

export interface InvoiceInput {
  orgId: string;
  /** 請求番号. Empty: the server gives the next number of the year (2026-001…). */
  number: string;
  amountYen: number;
  /** 請求日 (YYYY-MM-DD), or null while not issued. */
  issuedOn: string | null;
  /** 支払の期限 (YYYY-MM-DD), or null. */
  dueOn: string | null;
  /** The name the payer's bank shows (振込名義、カナ). It is what the matching compares with the statement. */
  payerKana: string;
  memo: string;
}

function optionalDate(value: unknown, field: string, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isCalendarDate(value)) return fail(field, `${label}は 2026-11-30 の形（年-月-日）で入れてください。`);
  return value;
}

/** Checks and tidies one invoice (the server's rule; the screen shows the same errors early). */
export function validateInvoice(input: unknown): InvoiceInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(null, '請求の形式が正しくありません。');
  const o = input as Record<string, unknown>;
  if (typeof o.orgId !== 'string' || !ORG_ID.test(o.orgId)) return fail('orgId', '請求先の団体を選んでください。');
  const number = text(o.number, PAYMENT_LIMITS.number, '請求番号');
  if (number && !INVOICE_NUMBER.test(number)) return fail('number', '請求番号は英数字・ハイフン・下線で 30 文字までです（例: 2026-001）。');
  if (typeof o.amountYen !== 'number' || !Number.isInteger(o.amountYen) || o.amountYen < 1 || o.amountYen > PAYMENT_LIMITS.amountMax) {
    return fail('amountYen', `請求額は 1 から ${PAYMENT_LIMITS.amountMax.toLocaleString('en-US')} 円までの整数で入れてください。`);
  }
  const issuedOn = optionalDate(o.issuedOn, 'issuedOn', '請求日');
  const dueOn = optionalDate(o.dueOn, 'dueOn', '支払の期限');
  if (issuedOn && dueOn && dueOn < issuedOn) return fail('dueOn', '支払の期限は請求日より後の日にしてください。');
  const payerKana = text(o.payerKana, PAYMENT_LIMITS.payerKana, '振込名義');
  const memo = text(o.memo, PAYMENT_LIMITS.memo, 'メモ', true);
  return { orgId: o.orgId, number, amountYen: o.amountYen, issuedOn, dueOn, payerKana, memo };
}

/** A short note (a reason to withdraw an invoice, to accept a shortfall, to set a deposit aside). */
export function validateNote(value: unknown, label = 'メモ'): string {
  return text(value, PAYMENT_LIMITS.note, label);
}

// ---- names ---------------------------------------------------------------------------------------------

/** Legal-form words, written out, as a bank or a person writes them (after the kana are made large). */
const LEGAL_WORDS = [
  'カブシキガイシヤ',
  'カブシキカイシヤ',
  'ユウゲンガイシヤ',
  'ユウゲンカイシヤ',
  'ゴウドウガイシヤ',
  'ゴウドウカイシヤ',
  'ゴウメイガイシヤ',
  'ゴウシガイシヤ',
  'イツパンシヤダンホウジン',
  'イツパンザイダンホウジン',
  'コウエキシヤダンホウジン',
  'コウエキザイダンホウジン',
  'トクテイヒエイリカツドウホウジン',
  'イリヨウホウジン',
  'ガツコウホウジン',
  'シヤカイフクシホウジン',
  '株式会社',
  '有限会社',
  '合同会社',
  '合名会社',
  '合資会社',
  '一般社団法人',
  '一般財団法人',
  '公益社団法人',
  '公益財団法人',
  '特定非営利活動法人',
  '医療法人',
  '学校法人',
  '社会福祉法人',
];
/** The bank's short marks of a legal form, written in brackets: (カ) 株式会社, (ユ) 有限会社, (ド) 合同会社… */
const LEGAL_MARK = '(?:カ|ユ|ド|メ|シ|ザイ|シヤ|イ|ガク|トクヒ|フク|株|有|同|財|社|医|学)';
const LEGAL_MARK_PATTERN = new RegExp(`\\(${LEGAL_MARK}\\)|^${LEGAL_MARK}\\)|\\(${LEGAL_MARK}$`, 'g');
const SMALL_KANA: Record<string, string> = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ' };

/**
 * A name in the form the matching compares: full-width kana (a bank's half-width kana too), hiragana as katakana,
 * small kana as large ones (banks write ｼﾖｳｼﾞ for ショウジ), upper-case Latin letters, the legal form left out
 * ((カ), 株式会社, カブシキガイシヤ…), a leading 振込/フリコミ left out, and no spaces, digits, long-vowel marks or
 * punctuation. Two names that differ only in these ways give the same text.
 */
export function normalizePayerName(name: string): string {
  let s = name.normalize('NFKC').toUpperCase();
  s = s.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  s = s.replace(/[ァィゥェォッャュョヮヵヶ]/g, (ch) => SMALL_KANA[ch] ?? ch);
  s = s.replace(/\s+/g, '');
  s = s.replace(/^(?:フリコミ|振込)+/, '');
  s = s.replace(LEGAL_MARK_PATTERN, '');
  for (const word of LEGAL_WORDS) s = s.split(word).join('');
  // Keep letters (kana, kanji, Latin); drop digits, marks, brackets and the long-vowel marks.
  s = s.replace(/[^\p{L}]/gu, '').replace(/[ー゛゜]/g, '');
  return s;
}

function bigrams(s: string): string[] {
  const chars = [...s];
  if (chars.length < 2) return chars;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/**
 * How close two normalized names are, from 0 to 1: 1 when equal, 0.9 when one holds the other (at least two letters),
 * else the Dice coefficient of their letter pairs.
 */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if ([...short].length >= 2 && long.includes(short)) return 0.9;
  const x = bigrams(a);
  const y = new Map<string, number>();
  for (const g of bigrams(b)) y.set(g, (y.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of x) {
    const n = y.get(g) ?? 0;
    if (n > 0) {
      common += 1;
      y.set(g, n - 1);
    }
  }
  const total = x.length + bigrams(b).length;
  return total === 0 ? 0 : Math.round(((2 * common) / total) * 1000) / 1000;
}

// ---- candidates ----------------------------------------------------------------------------------------

/** An invoice as the ranking sees it. `names` are already normalized (振込名義, the organization's name, its contact…). */
export interface RankInvoice {
  id: string;
  amountYen: number;
  /** Already confirmed for this invoice. */
  paidYen: number;
  issuedOn: string | null;
  dueOn: string | null;
  names: string[];
}

/** A deposit as the ranking sees it. `payerKey` is normalizePayerName of the statement's description. */
export interface RankDeposit {
  id: string;
  bookedOn: string;
  amountYen: number;
  payerKey: string;
}

export type AmountFit = 'exact' | 'fee' | 'part' | 'over' | 'other';

export interface Ranked {
  score: number;
  amountFit: AmountFit;
  nameScore: number;
  /** Why it is a candidate, in the screen's words. */
  reasons: string[];
}

/** Transfer fees a payer may take off the amount (the banks' fees are at most a few hundred yen). */
export const TRANSFER_FEE_MAX = 990;

/**
 * Ranks one deposit for one invoice: the amount first (the amount still owed, the amount less a transfer fee, a part
 * of it), then how close the payer's name is, and a deposit before the invoice date counts against it.
 */
export function rankDeposit(invoice: RankInvoice, deposit: RankDeposit): Ranked {
  const remaining = invoice.amountYen - invoice.paidYen;
  const reasons: string[] = [];
  let score = 0;
  let amountFit: AmountFit = 'other';
  if (remaining > 0 && deposit.amountYen === remaining) {
    amountFit = 'exact';
    score += 60;
    reasons.push(invoice.paidYen > 0 ? '残りの額と一致' : '金額が一致');
  } else if (remaining > 0 && deposit.amountYen < remaining && remaining - deposit.amountYen <= TRANSFER_FEE_MAX) {
    amountFit = 'fee';
    score += 40;
    reasons.push(`${yen(remaining - deposit.amountYen)}少ない（振込手数料を引いた額かもしれません）`);
  } else if (remaining > 0 && deposit.amountYen < remaining) {
    amountFit = 'part';
    score += 10;
    reasons.push('請求額より少ない（分割の入金かもしれません）');
  } else if (deposit.amountYen > remaining) {
    amountFit = 'over';
    reasons.push(remaining > 0 ? '請求額より多い' : 'この請求は全額入金済み');
  }
  const nameScore = Math.max(0, ...invoice.names.map((n) => nameSimilarity(n, deposit.payerKey)));
  score += Math.round(nameScore * 40);
  if (nameScore >= 0.9) reasons.push('振込人の名前が一致');
  else if (nameScore >= 0.5) reasons.push('振込人の名前が近い');
  if (invoice.issuedOn && deposit.bookedOn < invoice.issuedOn) {
    score -= 10;
    reasons.push('請求日より前の入金');
  }
  return { score, amountFit, nameScore, reasons };
}

/** A candidate is worth showing when the amount or the name points to it. */
export const CANDIDATE_MIN_SCORE = 20;

/** Deposits for one invoice, best first. Ties: the earlier deposit, then the id (the order never changes by chance). */
export function rankDepositsFor(invoice: RankInvoice, deposits: RankDeposit[]): (Ranked & { deposit: RankDeposit })[] {
  return deposits
    .map((deposit) => ({ ...rankDeposit(invoice, deposit), deposit }))
    .sort((a, b) => b.score - a.score || a.deposit.bookedOn.localeCompare(b.deposit.bookedOn) || a.deposit.id.localeCompare(b.deposit.id));
}

/** Invoices for one deposit, best first. Ties: the earlier deadline (none last), then the id. */
export function rankInvoicesFor(deposit: RankDeposit, invoices: RankInvoice[]): (Ranked & { invoice: RankInvoice })[] {
  const due = (i: RankInvoice) => i.dueOn ?? '9999-12-31';
  return invoices
    .map((invoice) => ({ ...rankDeposit(invoice, deposit), invoice }))
    .sort((a, b) => b.score - a.score || due(a.invoice).localeCompare(due(b.invoice)) || a.invoice.id.localeCompare(b.invoice.id));
}

/**
 * The state an invoice is in from what was confirmed for it. A shortfall counts as paid only when someone accepted it
 * (a transfer fee taken off, for example): it is never closed by itself.
 */
export function invoiceState(amountYen: number, paidYen: number, shortAccepted: boolean, voided: boolean): InvoiceState {
  if (voided) return 'void';
  if (paidYen <= 0) return 'open';
  if (paidYen >= amountYen || shortAccepted) return 'paid';
  return 'partial';
}

// ---- bank statement ------------------------------------------------------------------------------------

export const STATEMENT_FIELDS = ['date', 'description', 'deposit', 'withdrawal', 'balance'] as const;
export type StatementField = (typeof STATEMENT_FIELDS)[number];

export const STATEMENT_FIELD_LABELS: Record<StatementField, string> = {
  date: '日付（必須）',
  description: '摘要・振込人（必須）',
  deposit: '入金額（必須。出金と同じ列でもよい）',
  withdrawal: '出金額',
  balance: '残高',
};

export type StatementMapping = Partial<Record<StatementField, number | null>>;

/** Columns guessed from the header names (each bank names them differently; the screen lets the user change them). */
export function guessStatementMapping(headers: string[]): StatementMapping {
  const rules: [StatementField, RegExp][] = [
    ['date', /日付|取引日|年月日|勘定日|日時|date/i],
    ['description', /摘要|振込人|依頼人|お取引内容|内容|取引先|名義|description/i],
    ['deposit', /入金|預(?:け|か)?り|預入|受入|credit|deposit/i],
    ['withdrawal', /出金|お引出し|お支払|引出|払出|支払|debit|withdraw/i],
    ['balance', /残高|balance/i],
  ];
  const mapping: StatementMapping = {};
  const used = new Set<number>();
  for (const [field, pattern] of rules) {
    const index = headers.findIndex((h, i) => !used.has(i) && pattern.test(h.normalize('NFKC')));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  }
  return mapping;
}

/** The header row: the first of the first ten rows that names a date column and an amount column (banks put lines above it). */
export function guessHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const m = guessStatementMapping(rows[i] ?? []);
    if (m.date !== undefined && (m.deposit !== undefined || m.balance !== undefined)) return i;
  }
  return 0;
}

const ERA_START: Record<string, number> = { R: 2018, 令和: 2018, H: 1988, 平成: 1988 };

/**
 * A statement date as YYYY-MM-DD: 2026/11/05, 2026-11-05, 2026.11.05, 20261105, 2026年11月5日, 令和8年11月5日,
 * R8.11.5 and R08/11/05. A time after the date is left out. Null when it is none of these or not a real day.
 */
export function parseStatementDate(value: string): string | null {
  const v = value.normalize('NFKC').trim().replace(/\s+\d{1,2}:\d{2}(?::\d{2})?$/, '');
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/.exec(v);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{4})(\d{2})(\d{2})$/.exec(v))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(R|H|令和|平成)\s*(\d{1,2}|元)[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/i.exec(v))) {
    const era = ERA_START[match[1]!.toUpperCase()]!;
    y = era + (match[2] === '元' ? 1 : Number(match[2]));
    [m, d] = [Number(match[3]), Number(match[4])];
  } else {
    return null;
  }
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isCalendarDate(iso) ? iso : null;
}

/**
 * An amount as a statement writes it: 1,000 / ¥1,000 / 1000円 / full-width digits. A minus, △, ▲ or brackets make it
 * negative (a withdrawal in a one-column statement). Empty gives null; anything else gives "invalid".
 */
export function parseStatementAmount(value: string): number | null | 'invalid' {
  let v = value.normalize('NFKC').replace(/[¥\\,，\s]/g, '').replace(/円$/, '');
  if (v === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  if (/^[-−△▲]/.test(v)) {
    negative = true;
    v = v.slice(1);
  } else if (v.startsWith('+')) {
    v = v.slice(1);
  }
  if (!/^\d+$/.test(v)) return 'invalid';
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n > PAYMENT_LIMITS.amountMax) return 'invalid';
  return negative ? -n : n;
}

/** The cells of one statement row the screen sends (only the mapped columns leave the browser). */
export interface StatementRowInput {
  /** The line in the file (the header row is counted). */
  line: number;
  date: string;
  description: string;
  deposit: string;
  withdrawal: string;
  balance: string;
}

export type StatementRowResult =
  | { kind: 'deposit'; bookedOn: string; description: string; amountYen: number; balanceYen: number | null }
  | { kind: 'withdrawal' }
  | { kind: 'unreadable'; reason: string };

/** Reads one row: a deposit, a withdrawal (never kept), or why it cannot be read. */
export function readStatementRow(row: Omit<StatementRowInput, 'line'>): StatementRowResult {
  const withdrawal = parseStatementAmount(row.withdrawal);
  if (withdrawal === 'invalid') return { kind: 'unreadable', reason: `出金額「${row.withdrawal.trim()}」が数字になっていません` };
  const deposit = parseStatementAmount(row.deposit);
  if (deposit === 'invalid') return { kind: 'unreadable', reason: `入金額「${row.deposit.trim()}」が数字になっていません` };
  // A withdrawal: a withdrawal column with an amount, or a negative amount in the deposit column. Never kept.
  if ((withdrawal !== null && withdrawal !== 0 && (deposit === null || deposit === 0)) || (deposit !== null && deposit < 0)) return { kind: 'withdrawal' };
  if (deposit === null || deposit === 0) return { kind: 'unreadable', reason: '入金額が空です' };
  const bookedOn = parseStatementDate(row.date);
  if (!bookedOn) return { kind: 'unreadable', reason: `日付「${row.date.trim()}」が読めません（2026/11/05 や R8.11.5 の形）` };
  const description = row.description.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!description) return { kind: 'unreadable', reason: '摘要（振込人）が空です' };
  if (CONTROL.test(description) || description.length > PAYMENT_LIMITS.statementCell) return { kind: 'unreadable', reason: '摘要に使えない文字があるか、長すぎます' };
  const balance = parseStatementAmount(row.balance);
  if (balance === 'invalid') return { kind: 'unreadable', reason: `残高「${row.balance.trim()}」が数字になっていません` };
  return { kind: 'deposit', bookedOn, description, amountYen: deposit, balanceYen: balance };
}

/** The key two rows share when they are the same deposit: the date, the description, the amount and the balance. */
export function depositKey(d: { bookedOn: string; description: string; amountYen: number; balanceYen: number | null }): string {
  return [d.bookedOn, d.description, String(d.amountYen), d.balanceYen === null ? '' : String(d.balanceYen)].join('\u001f');
}

// ---- wire types ----------------------------------------------------------------------------------------

/** GET /api/payments/me: what this person may do in the accounting screens. */
export interface PaymentsMe {
  canView: boolean;
  canConfirm: boolean;
  /** Access administrators give the accounting permissions (設定). */
  canAdminister: boolean;
}

export interface AllocationView {
  transactionId: string;
  bookedOn: string;
  description: string;
  amountYen: number;
  confirmedAt: string;
  confirmedByName: string;
}

export interface InvoiceView {
  id: string;
  orgId: string;
  /** The organization's name now (or as it was when the invoice was made, if it is gone). */
  orgName: string;
  orgExists: boolean;
  fiscalYear: number;
  number: string;
  amountYen: number;
  issuedOn: string | null;
  dueOn: string | null;
  payerKana: string;
  memo: string;
  state: InvoiceState;
  paidYen: number;
  /** paid − amount: positive is 過払い, negative is 不足 (zero while nothing is paid). */
  differenceYen: number;
  shortAccepted: boolean;
  shortNote: string;
  voidNote: string;
  overdue: boolean;
  lastPaidOn: string | null;
  version: number;
  updatedAt: string;
  updatedByName: string;
}

export interface DepositView {
  id: string;
  bookedOn: string;
  description: string;
  amountYen: number;
  balanceYen: number | null;
  line: number;
  importedAt: string;
  excluded: boolean;
  excludedNote: string;
  /** The invoice this deposit was put on, or null. */
  invoiceId: string | null;
  invoiceLabel: string | null;
}

export interface DepositCandidate {
  deposit: DepositView;
  score: number;
  amountFit: AmountFit;
  reasons: string[];
}

export interface InvoiceCandidate {
  invoice: InvoiceView;
  score: number;
  amountFit: AmountFit;
  reasons: string[];
}

export type PaymentHistoryAction =
  | 'invoice_created'
  | 'invoice_updated'
  | 'invoice_voided'
  | 'invoice_restored'
  | 'confirmed'
  | 'unconfirmed'
  | 'deposit_excluded'
  | 'deposit_included'
  | 'statement_imported'
  | 'import_removed';

export interface PaymentHistoryView {
  id: number;
  at: string;
  actorName: string;
  action: PaymentHistoryAction;
  /** The screen's sentence for the row (amounts and dates; never a payer's name). */
  text: string;
}

export interface InvoiceDetailResponse {
  invoice: InvoiceView;
  allocations: AllocationView[];
  /** Deposits not yet put on any invoice, best first (at most CANDIDATES_MAX); the ones that fit come first, then the rest. */
  candidates: DepositCandidate[];
  /** How many deposits could be put on it in all (more than `candidates` holds when the list was cut). */
  candidatesTotal: number;
  /** Days a mail batch was sent to the organization (Japan's day), for 請求日; nothing is set by itself. */
  issuedOnHints: { date: string; subject: string }[];
  history: PaymentHistoryView[];
  /** After a change of the invoice (made, changed, withdrawn, restored): what happened to the organization's stage. */
  org?: ConfirmResponse['org'];
}

/** The most candidates an invoice lists; the rest are confirmed from the deposit's side. */
export const CANDIDATES_MAX = 100;

export interface DepositDetailResponse {
  deposit: DepositView;
  candidates: InvoiceCandidate[];
  history: PaymentHistoryView[];
}

/** An organization of the year with an amount and no invoice yet: an invoice can be made from it. */
export interface InvoiceableOrg {
  orgId: string;
  name: string;
  kindLabel: string;
  status: string;
  amountYen: number | null;
  payerKana: string;
  issuedOnHints: { date: string; subject: string }[];
}

export interface PaymentsOverview {
  fiscalYear: number;
  /** Open and partly paid invoices: past their deadline first, then by deadline. */
  unpaid: InvoiceView[];
  paid: InvoiceView[];
  /** Deposits not put on any invoice and not set aside, newest first. */
  unmatched: DepositView[];
  /** Deposits set aside as not for an invoice (interest and so on), newest first. */
  excluded: DepositView[];
  /** Paid invoices whose deposits differ from the amount (過払い, or a shortfall someone accepted). */
  discrepancies: InvoiceView[];
  voided: InvoiceView[];
  invoiceable: InvoiceableOrg[];
  imports: StatementImportSummary[];
  today: string;
}

export interface StatementImportSummary {
  id: string;
  at: string;
  actorName: string;
  label: string;
  added: number;
  removed: boolean;
  /** Deposits of this import already put on an invoice (the import cannot be taken back while any are). */
  matched: number;
}

export interface StatementPlanRow {
  line: number;
  action: 'new' | 'duplicate' | 'withdrawal' | 'unreadable';
  bookedOn: string | null;
  description: string;
  amountYen: number | null;
  reason: string;
}

export interface StatementImportResponse {
  dryRun: boolean;
  counts: Record<StatementPlanRow['action'], number>;
  rows: StatementPlanRow[];
  /** A digest of the plan; the commit sends it back and is refused when the plan has changed since. */
  planToken: string;
}

/** The state of one organization's payment for every committee member; the details only with accounting.view. */
export interface OrgPaymentStatus {
  state: 'none' | 'unpaid' | 'paid';
  detail: { invoices: InvoiceView[]; allocations: Record<string, AllocationView[]> } | null;
  canView: boolean;
  canConfirm: boolean;
}

export interface ConfirmResponse {
  invoice: InvoiceDetailResponse;
  /** What happened to the organization's stage: advanced to 入金済み, put back, unchanged, or it could not be written. */
  org: 'advanced' | 'reverted' | 'unchanged' | 'failed';
}

export interface AccountingAccessResponse {
  revision: number;
  people: { id: string; displayName: string; roleLabel: string; stored: AccountingPermission[]; effective: AccountingPermission[] }[];
  departments: string[];
  departmentGrants: { department: string; permission: AccountingPermission }[];
  history: { id: number; at: string; actorName: string; text: string }[];
}
