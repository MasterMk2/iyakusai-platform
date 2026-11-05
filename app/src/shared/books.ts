// Books (会計の帳簿, 2026-11-05): the committee's income and spending, entered in the plain form a member understands
// (収入・支出・口座の移動) and kept as double-entry journals underneath, so the same rows go to 弥生会計 (its import
// format) during the move and to the committee's Google spreadsheet. Also the reimbursements (立替精算), their
// receipts, the budget of each account (科目) and the deposits the payments screen confirmed (入金確認).
// The rules shared by the server and the screen. Synthetic data only in tests; no personal data in this file.

export const BOOKS_LIMITS = {
  accountName: 24,
  accountLabel: 40,
  taxClass: 32,
  memo: 200,
  counterparty: 60,
  department: 40,
  note: 200,
  purpose: 200,
  amountMax: 999_999_999,
  /** Lines of one journal (弥生 takes at most 100 lines a journal). */
  journalLines: 100,
  /** Receipts on one claim or one journal. */
  receipts: 5,
  receiptBytes: 10 * 1024 * 1024,
  receiptName: 120,
  /** Rows of one 弥生 file (弥生会計 Next takes at most 5,000 lines a file). */
  yayoiRows: 5000,
  fiscalYearMin: 2000,
  fiscalYearMax: 2100,
  /** Claims settled together in one action. */
  settleMax: 50,
} as const;

export class BooksValidationError extends Error {
  constructor(
    readonly field: string | null,
    message: string,
  ) {
    super(message);
  }
}

const fail = (field: string | null, message: string): never => {
  throw new BooksValidationError(field, message);
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ACCOUNT_ID = /^ac_[0-9a-f]{16}$/;
export const JOURNAL_ID = /^jn_[0-9a-f]{16}$/;
export const CLAIM_ID = /^cl_[0-9a-f]{16}$/;
export const RECEIPT_ID = /^rc_[0-9a-f]{16}$/;

/** One line of text: NFC, spaces folded, no control characters, at most `max` characters. Empty when absent. */
export function oneLine(value: unknown, max: number, label: string, field: string | null = null): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return fail(field, `${label}の形式が正しくありません。`);
  const out = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (CONTROL.test(out)) return fail(field, `${label}に使えない文字があります。`);
  if (out.length > max) return fail(field, `${label}は ${max} 文字までです。`);
  return out;
}

/** A calendar date written as YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function date(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || !isCalendarDate(value)) return fail(field, `${label}は 2026-11-30 の形（年-月-日）で入れてください。`);
  return value;
}

function amount(value: unknown, field: string, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > BOOKS_LIMITS.amountMax) {
    return fail(field, `${label}は 1 から ${BOOKS_LIMITS.amountMax.toLocaleString('en-US')} 円までの整数で入れてください。`);
  }
  return value;
}

function id(value: unknown, pattern: RegExp, field: string, message: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) return fail(field, message);
  return value;
}

export const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

/** Today in Japan (the committee's day), as YYYY-MM-DD. */
export function tokyoDate(at: Date | number | string = new Date()): string {
  return new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// ---- fiscal year ---------------------------------------------------------------------------------------

/** The committee's year starts in January (弥生会計 Next: 2026年度 = 2026/01/01〜12/31). Kept as a setting. */
export const DEFAULT_FISCAL_START_MONTH = 1;

/** The fiscal year a day belongs to: the calendar year its year started in. */
export function fiscalYearOf(day: string, startMonth = DEFAULT_FISCAL_START_MONTH): number {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m >= startMonth ? y : y - 1;
}

/** The first and the last day of a fiscal year. */
export function fiscalRange(year: number, startMonth = DEFAULT_FISCAL_START_MONTH): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${year}-${pad(startMonth)}-01`;
  const end = new Date(Date.UTC(year + 1, startMonth - 1, 1) - 86_400_000);
  return { from, to: end.toISOString().slice(0, 10) };
}

// ---- accounts (勘定科目) --------------------------------------------------------------------------------

export const ACCOUNT_KINDS = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  asset: '資産',
  liability: '負債',
  equity: '純資産',
  income: '収入',
  expense: '支出',
};

/** The side an account grows on: assets and spending on the debit side (借方), the others on the credit side (貸方). */
export const normalSide = (kind: AccountKind): 'debit' | 'credit' => (kind === 'asset' || kind === 'expense' ? 'debit' : 'credit');

/** 弥生's tax class for a committee that is not a taxable business: every line is 対象外 unless an account says otherwise. */
export const DEFAULT_TAX_CLASS = '対象外';

export interface AccountSeed {
  name: string;
  kind: AccountKind;
  /** The heading 弥生 puts it under (販売管理費, 営業外収益…), for the reports. */
  group: string;
  /** Cash or a bank account: money is received into it and paid from it (口座). */
  money?: boolean;
}

/**
 * 弥生会計's usual names, offered in the settings to a book that does not start from 弥生 (and used by the demo). A
 * book that uses 弥生 starts instead by importing 弥生's journals and opening balances, which makes the committee's own
 * accounts and 補助科目 with 弥生's exact names. No bank, branch or account number here: those are 補助科目 of 普通預金
 * on the server. Names must match 弥生's exactly, or 弥生 asks to match them on import.
 */
export const DEFAULT_ACCOUNTS: AccountSeed[] = [
  { name: '現金', kind: 'asset', group: '現金・預金', money: true },
  { name: '普通預金', kind: 'asset', group: '現金・預金', money: true },
  { name: '立替金', kind: 'asset', group: 'その他の資産' },
  { name: '未収入金', kind: 'asset', group: 'その他の資産' },
  { name: '前払金', kind: 'asset', group: 'その他の資産' },
  { name: '未払金', kind: 'liability', group: '負債' },
  { name: '預り金', kind: 'liability', group: '負債' },
  { name: '繰越利益', kind: 'equity', group: '純資産' },
  { name: '協賛金', kind: 'income', group: '収入' },
  { name: '出展料', kind: 'income', group: '収入' },
  { name: '学内寄付金', kind: 'income', group: '収入' },
  { name: '新入生寄付金', kind: 'income', group: '収入' },
  { name: '寄付金収入', kind: 'income', group: '収入' },
  { name: '補助金収入', kind: 'income', group: '収入' },
  { name: '受取利息', kind: 'income', group: '収入' },
  { name: '雑収入', kind: 'income', group: '収入' },
  { name: '前期損益修正益', kind: 'income', group: '特別利益' },
  { name: '荷造運賃', kind: 'expense', group: '支出' },
  { name: '広告宣伝費', kind: 'expense', group: '支出' },
  { name: '交際費', kind: 'expense', group: '支出' },
  { name: '会議費', kind: 'expense', group: '支出' },
  { name: '旅費交通費', kind: 'expense', group: '支出' },
  { name: '通信費', kind: 'expense', group: '支出' },
  { name: '消耗品費', kind: 'expense', group: '支出' },
  { name: '事務用品費', kind: 'expense', group: '支出' },
  { name: '賃借料', kind: 'expense', group: '支出' },
  { name: '保険料', kind: 'expense', group: '支出' },
  { name: '支払手数料', kind: 'expense', group: '支出' },
  { name: '雑費', kind: 'expense', group: '支出' },
];

const KNOWN_KINDS = new Map(DEFAULT_ACCOUNTS.map((a) => [a.name, a]));

/**
 * The kind of an account met in a 弥生 file, from its name: a known name, else the endings 弥生's names use. Null
 * when the name says nothing (the screen then asks the accounting section to choose).
 */
export function guessAccount(name: string): { kind: AccountKind; group: string; money: boolean } | null {
  const known = KNOWN_KINDS.get(name);
  if (known) return { kind: known.kind, group: known.group, money: known.money === true };
  if (/現金|預金|貯金/.test(name)) return { kind: 'asset', group: '現金・預金', money: true };
  if (/未払|預り|借入|前受|仮受/.test(name)) return { kind: 'liability', group: '負債' , money: false };
  if (/未収|立替|仮払|前払|売掛|貸付|備品|建物|器具/.test(name)) return { kind: 'asset', group: 'その他の資産', money: false };
  if (/繰越利益|元入金|資本金|剰余金/.test(name)) return { kind: 'equity', group: '純資産', money: false };
  if (/収入|収益|売上|受取|寄付金|協賛|補助金|助成金|利益$|益$/.test(name)) return { kind: 'income', group: '収入', money: false };
  if (/費$|料$|代$|損$|運賃$|手数料$/.test(name)) return { kind: 'expense', group: '支出', money: false };
  return null;
}

export interface AccountInput {
  name: string;
  /** 補助科目 (a bank account under 普通預金, for example). Empty: none. */
  sub: string;
  kind: AccountKind;
  group: string;
  money: boolean;
  /** The name the screens show (a bank account's nickname). Empty: name and sub. */
  label: string;
  taxClass: string;
  active: boolean;
}

/**
 * A 科目 or 補助科目 name exactly as 弥生 holds it: 弥生 matches names character for character (a space at the end
 * included), so nothing is trimmed or folded here. Only control characters and the length are refused.
 */
export function yayoiName(value: unknown, label: string, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return fail(field, `${label}の形式が正しくありません。`);
  if (CONTROL.test(value) || /[\r\n\t]/.test(value)) return fail(field, `${label}に使えない文字があります。`);
  if ([...value].length > BOOKS_LIMITS.accountName) return fail(field, `${label}は ${BOOKS_LIMITS.accountName} 文字までです（弥生の上限）。`);
  return value;
}

export function validateAccount(input: unknown): AccountInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(null, '科目の形式が正しくありません。');
  const o = input as Record<string, unknown>;
  const name = yayoiName(o.name, '科目名', 'name');
  if (!name.trim()) return fail('name', '科目名を入れてください。');
  const sub = yayoiName(o.sub, '補助科目', 'sub');
  if (typeof o.kind !== 'string' || !(ACCOUNT_KINDS as readonly string[]).includes(o.kind)) return fail('kind', '科目の種類（資産・負債・純資産・収入・支出）を選んでください。');
  const kind = o.kind as AccountKind;
  const group = oneLine(o.group, BOOKS_LIMITS.accountLabel, '区分', 'group') || ACCOUNT_KIND_LABELS[kind];
  const money = o.money === true;
  if (money && kind !== 'asset') return fail('money', '口座（現金・預金）にできるのは資産の科目だけです。');
  const label = oneLine(o.label, BOOKS_LIMITS.accountLabel, '表示名', 'label');
  const taxClass = oneLine(o.taxClass, BOOKS_LIMITS.taxClass, '税区分', 'taxClass') || DEFAULT_TAX_CLASS;
  const active = o.active !== false;
  return { name, sub, kind, group, money, label, taxClass, active };
}

/** The name an account shows: its label, else the name and the sub-account. */
export function accountTitle(a: { name: string; sub: string; label: string }): string {
  return a.label || (a.sub ? `${a.name}（${a.sub}）` : a.name);
}

// ---- entries (収支の入力) --------------------------------------------------------------------------------

/**
 * The forms of an entry: 収入 (money comes into an account), 支出 (money goes out of one), 口座の移動 (from one account
 * to another, a deposit of cash for example) and 振替 (any debit and credit account, for the accounting section).
 */
export const ENTRY_FORMS = ['income', 'expense', 'transfer', 'journal'] as const;
export type EntryForm = (typeof ENTRY_FORMS)[number];

export const ENTRY_FORM_LABELS: Record<EntryForm | 'compound', string> = {
  income: '収入',
  expense: '支出',
  transfer: '口座の移動',
  journal: '振替',
  compound: '複合仕訳',
};

export interface EntryInput {
  form: EntryForm;
  date: string;
  amountYen: number;
  /** income: the account the money came into; expense: the one it left; transfer: the one it left. */
  moneyAccountId: string | null;
  /** income: the income account; expense: the spending account. */
  accountId: string | null;
  /** transfer: the account the money went to. */
  toMoneyAccountId: string | null;
  /** journal: both sides. */
  debitAccountId: string | null;
  creditAccountId: string | null;
  counterparty: string;
  memo: string;
  department: string;
}

export function validateEntry(input: unknown): EntryInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(null, '入力の形式が正しくありません。');
  const o = input as Record<string, unknown>;
  if (typeof o.form !== 'string' || !(ENTRY_FORMS as readonly string[]).includes(o.form)) return fail('form', '収入・支出・口座の移動・振替のどれかを選んでください。');
  const form = o.form as EntryForm;
  const out: EntryInput = {
    form,
    date: date(o.date, 'date', '日付'),
    amountYen: amount(o.amountYen, 'amountYen', '金額'),
    moneyAccountId: null,
    accountId: null,
    toMoneyAccountId: null,
    debitAccountId: null,
    creditAccountId: null,
    counterparty: oneLine(o.counterparty, BOOKS_LIMITS.counterparty, '取引先', 'counterparty'),
    memo: oneLine(o.memo, BOOKS_LIMITS.memo, '摘要', 'memo'),
    department: oneLine(o.department, BOOKS_LIMITS.department, '部局', 'department'),
  };
  if (form === 'income' || form === 'expense') {
    out.moneyAccountId = id(o.moneyAccountId, ACCOUNT_ID, 'moneyAccountId', form === 'income' ? '入金した口座を選んでください。' : '支払った口座を選んでください。');
    out.accountId = id(o.accountId, ACCOUNT_ID, 'accountId', '科目を選んでください。');
  } else if (form === 'transfer') {
    out.moneyAccountId = id(o.moneyAccountId, ACCOUNT_ID, 'moneyAccountId', '移す元の口座を選んでください。');
    out.toMoneyAccountId = id(o.toMoneyAccountId, ACCOUNT_ID, 'toMoneyAccountId', '移す先の口座を選んでください。');
    if (out.moneyAccountId === out.toMoneyAccountId) fail('toMoneyAccountId', '移す元と先に同じ口座は選べません。');
  } else {
    out.debitAccountId = id(o.debitAccountId, ACCOUNT_ID, 'debitAccountId', '借方の科目を選んでください。');
    out.creditAccountId = id(o.creditAccountId, ACCOUNT_ID, 'creditAccountId', '貸方の科目を選んでください。');
    if (out.debitAccountId === out.creditAccountId) fail('creditAccountId', '借方と貸方に同じ科目は選べません。');
  }
  return out;
}

/** A note (a reason to withdraw an entry, to turn down a claim). */
export function validateNote(value: unknown, label = 'メモ'): string {
  return oneLine(value, BOOKS_LIMITS.note, label, 'note');
}

// ---- reimbursements (立替精算) ---------------------------------------------------------------------------

/** submitted: waiting for the accounting section; approved: the spending is in the books, the money not yet paid
 * back; paid: paid back; rejected: turned down (with a reason); withdrawn: taken back by the member. */
export const CLAIM_STATES = ['submitted', 'approved', 'paid', 'rejected', 'withdrawn'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const CLAIM_STATE_LABELS: Record<ClaimState, string> = {
  submitted: '確認待ち',
  approved: '返金待ち',
  paid: '返金済み',
  rejected: '差し戻し',
  withdrawn: '取り下げ',
};

/** Purchases above this need the officers' approval first (会計マニュアル: 2,000円を超える物品は役員の承認). */
export const PREAPPROVAL_ABOVE_YEN = 2000;

export interface ClaimInput {
  spentOn: string;
  amountYen: number;
  /** Where it was bought (店・サービス). */
  payee: string;
  /** What and what for. */
  purpose: string;
  department: string;
  /** The account the member thinks it is (the accounting section decides). Null: not chosen. */
  accountId: string | null;
  /** Who approved it beforehand, for purchases above PREAPPROVAL_ABOVE_YEN (free text: 役員会 10/1 など). */
  preapproval: string;
}

export function validateClaim(input: unknown): ClaimInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(null, '申請の形式が正しくありません。');
  const o = input as Record<string, unknown>;
  const spentOn = date(o.spentOn, 'spentOn', '支払った日');
  const amountYen = amount(o.amountYen, 'amountYen', '金額');
  const payee = oneLine(o.payee, BOOKS_LIMITS.counterparty, '支払先', 'payee');
  const purpose = oneLine(o.purpose, BOOKS_LIMITS.purpose, '品名・用途', 'purpose');
  if (!purpose) return fail('purpose', '品名・用途を入れてください（何を何のために）。');
  const department = oneLine(o.department, BOOKS_LIMITS.department, '部局', 'department');
  const accountId = o.accountId === null || o.accountId === undefined || o.accountId === '' ? null : id(o.accountId, ACCOUNT_ID, 'accountId', '科目を選び直してください。');
  const preapproval = oneLine(o.preapproval, BOOKS_LIMITS.note, '事前の承認', 'preapproval');
  return { spentOn, amountYen, payee, purpose, department, accountId, preapproval };
}

// ---- receipts (領収書) -----------------------------------------------------------------------------------

export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** The type of a receipt file from its first bytes (the name and the browser's type are not trusted). Null: none of them. */
export function sniffReceiptType(bytes: Uint8Array): ReceiptType | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'image/png';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46 && b(4) === 0x2d) return 'application/pdf';
  return null;
}

/** A file name safe to keep and to show: no path, no control characters, at most BOOKS_LIMITS.receiptName characters. */
export function receiptName(name: string, type: ReceiptType): string {
  const base = name.normalize('NFC').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().slice(0, BOOKS_LIMITS.receiptName);
  if (clean) return clean;
  return type === 'application/pdf' ? '領収書.pdf' : `領収書.${type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]}`;
}

// ---- budget (予算) ---------------------------------------------------------------------------------------

export interface BudgetLineInput {
  /** The account's name (the budget is per 科目, all its 補助科目 together). */
  accountName: string;
  amountYen: number;
}

export function validateBudget(input: unknown): BudgetLineInput[] {
  if (!Array.isArray(input) || input.length > 300) return fail(null, '予算の形式が正しくありません。');
  const seen = new Set<string>();
  return input.map((row, i) => {
    if (typeof row !== 'object' || row === null) return fail(null, `予算の ${i + 1} 行目の形式が正しくありません。`);
    const o = row as Record<string, unknown>;
    const accountName = yayoiName(o.accountName, '科目名', 'accountName');
    if (!accountName.trim()) return fail('accountName', `予算の ${i + 1} 行目に科目がありません。`);
    if (seen.has(accountName)) return fail('accountName', `予算に「${accountName}」が 2 回あります。`);
    seen.add(accountName);
    if (typeof o.amountYen !== 'number' || !Number.isInteger(o.amountYen) || o.amountYen < 0 || o.amountYen > BOOKS_LIMITS.amountMax) {
      return fail('amountYen', `「${accountName}」の予算は 0 以上の整数（円）で入れてください。`);
    }
    return { accountName, amountYen: o.amountYen };
  });
}

// ---- wire types ----------------------------------------------------------------------------------------

/** GET /api/books/me: what this person may do. Every committee member may claim; the books need the accounting permissions. */
export interface BooksMe {
  canClaim: boolean;
  canView: boolean;
  canEdit: boolean;
  departments: string[];
  fiscalYear: number;
  fiscalStartMonth: number;
  /** The spreadsheet is set up on the server (books-sheets.json). */
  sheetsConfigured: boolean;
}

export interface AccountView {
  id: string;
  name: string;
  sub: string;
  kind: AccountKind;
  group: string;
  money: boolean;
  label: string;
  title: string;
  taxClass: string;
  active: boolean;
  /** Journals use it (it can then only be turned off, not renamed into another account's name). */
  used: boolean;
  version: number;
}

export interface JournalLineView {
  side: 'debit' | 'credit';
  accountId: string;
  accountTitle: string;
  amountYen: number;
  taxClass: string;
  department: string;
}

export type JournalSource = 'manual' | 'claim' | 'deposit' | 'yayoi';

export const JOURNAL_SOURCE_LABELS: Record<JournalSource, string> = {
  manual: '入力',
  claim: '立替精算',
  deposit: '入金確認',
  yayoi: '弥生から',
};

export interface JournalView {
  id: string;
  /** J-000123: the number the screens, the sheet and the 弥生 file (in 摘要) show. */
  number: string;
  fiscalYear: number;
  date: string;
  form: EntryForm | 'compound';
  amountYen: number;
  /** The plain reading: the money account and the other side, when the journal has two lines. */
  moneyAccountTitle: string | null;
  accountTitle: string | null;
  direction: 'in' | 'out' | 'move' | 'none';
  counterparty: string;
  memo: string;
  department: string;
  lines: JournalLineView[];
  source: JournalSource;
  sourceLabel: string;
  voided: boolean;
  voidNote: string;
  /** Sent to 弥生 (the batch's time), changed after it was sent, or came from 弥生 (never sent back). */
  yayoiExportedAt: string | null;
  yayoiChangedAfterExport: boolean;
  receipts: ReceiptView[];
  /** 弥生's 伝票No of an imported journal (or of ours, once 弥生's file showed it back). */
  yayoiNo: string;
  /** 弥生's 付箋1 (0 none, 1–5), kept and sent back as it was. */
  sticky: number;
  /** The claim this journal belongs to (立替精算), if any. */
  claimId: string | null;
  version: number;
  updatedAt: string;
  updatedByName: string;
  /** The entry form that made it, to edit it (null: a compound or imported journal, withdrawn and entered again instead). */
  entry: EntryInput | null;
}

export interface ReceiptView {
  id: string;
  name: string;
  type: ReceiptType;
  bytes: number;
  uploadedAt: string;
}

export interface ClaimView {
  id: string;
  number: string;
  fiscalYear: number;
  claimantId: string;
  claimantName: string;
  mine: boolean;
  spentOn: string;
  amountYen: number;
  payee: string;
  purpose: string;
  department: string;
  accountId: string | null;
  accountTitle: string | null;
  preapproval: string;
  state: ClaimState;
  stateLabel: string;
  note: string;
  approvedAt: string | null;
  approvedByName: string | null;
  paidOn: string | null;
  paidFromTitle: string | null;
  receipts: ReceiptView[];
  version: number;
  submittedAt: string;
  updatedAt: string;
}

export interface ClaimsOverview {
  fiscalYear: number;
  /** The member's own claims, newest first. */
  mine: ClaimView[];
  /** Only with the accounting permission: every claim by state. */
  submitted: ClaimView[] | null;
  approved: ClaimView[] | null;
  closed: ClaimView[] | null;
  /** Owed to each member (approved, not paid), for paying back together (毎月の一括返金). */
  owed: { claimantId: string; claimantName: string; count: number; amountYen: number }[] | null;
}

export interface MoneyBalance {
  accountId: string;
  title: string;
  openingYen: number;
  inYen: number;
  outYen: number;
  balanceYen: number;
}

export interface BudgetRow {
  accountName: string;
  kind: 'income' | 'expense';
  group: string;
  budgetYen: number | null;
  actualYen: number;
  /** actual − budget (income: more than planned is positive; spending: over budget is positive). */
  differenceYen: number | null;
  /** actual ÷ budget in percent, one decimal; null without a budget. */
  rate: number | null;
}

export interface BooksSummary {
  fiscalYear: number;
  from: string;
  to: string;
  balances: MoneyBalance[];
  incomeYen: number;
  expenseYen: number;
  budget: BudgetRow[];
  /** Approved claims not yet paid back. */
  owedYen: number;
  /** Claims waiting for the accounting section's check (確認待ち), of any year. */
  claimsWaiting: number;
  /** Deposits the payments screen confirmed that are not in the books yet. */
  depositsToBook: number;
  yayoi: { unexported: number; changedAfterExport: number; lastExportAt: string | null };
  sheets: SheetsStatus;
  today: string;
}

export interface SheetsStatus {
  configured: boolean;
  lastOkAt: string | null;
  lastAttemptAt: string | null;
  /** The kind of the last failure (never a token or a response body), cleared by a success. */
  lastError: string | null;
  pending: boolean;
  /** The spreadsheet's address (null when it is not set up). */
  url: string | null;
}

export interface JournalList {
  fiscalYear: number;
  journals: JournalView[];
  total: number;
}

export interface OpeningRow {
  accountId: string;
  title: string;
  kind: AccountKind;
  amountYen: number;
}

/** A confirmed deposit of the payments screen, as the books see it. */
export interface DepositToBook {
  depositId: string;
  bookedOn: string;
  description: string;
  amountYen: number;
  invoiceNumber: string;
  orgName: string;
  orgKind: string;
  orgKindLabel: string;
  /** The income account the settings name for this kind of organization, or null. */
  suggestedAccountId: string | null;
  journalId: string | null;
  /** Booked, but its confirmation was taken back in the payments screen since: the journal needs a look. */
  unconfirmedSince: boolean;
}

/** The settings of the books (設定): who reads them is in BooksMe; these change how entries are made. */
export interface BooksSettings {
  fiscalStartMonth: number;
  /**
   * The account a reimbursement is owed on between its approval and the payment back (the committee's 弥生 uses
   * 立替金; 未払金 is the usual one). Null: not chosen yet, and claims cannot be approved.
   */
  claimAccountId: string | null;
  /** The account confirmed deposits go into by default (the bank account the organizations pay to). */
  depositMoneyAccountId: string | null;
  /** The income account per organization kind (sponsor → 協賛金…). */
  depositAccountByKind: Record<string, string | null>;
  version: number;
}

export function validateSettings(input: unknown): Omit<BooksSettings, 'version'> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(null, '設定の形式が正しくありません。');
  const o = input as Record<string, unknown>;
  const month = o.fiscalStartMonth;
  if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12) return fail('fiscalStartMonth', '年度の始まりの月は 1〜12 で選んでください。');
  const optional = (v: unknown, field: string) => (v === null || v === undefined || v === '' ? null : id(v, ACCOUNT_ID, field, '科目を選び直してください。'));
  const byKindRaw = o.depositAccountByKind;
  const depositAccountByKind: Record<string, string | null> = {};
  if (byKindRaw !== undefined && byKindRaw !== null) {
    if (typeof byKindRaw !== 'object' || Array.isArray(byKindRaw)) return fail('depositAccountByKind', '団体の種類ごとの科目の形式が正しくありません。');
    for (const [kind, value] of Object.entries(byKindRaw as Record<string, unknown>)) {
      if (!/^[a-z]{1,20}$/.test(kind)) return fail('depositAccountByKind', '団体の種類が正しくありません。');
      depositAccountByKind[kind] = optional(value, 'depositAccountByKind');
    }
  }
  return {
    fiscalStartMonth: month,
    claimAccountId: optional(o.claimAccountId, 'claimAccountId'),
    depositMoneyAccountId: optional(o.depositMoneyAccountId, 'depositMoneyAccountId'),
    depositAccountByKind,
  };
}

export interface YayoiExportPlan {
  fiscalYear: number;
  count: number;
  rows: number;
  /** Journals sent before and changed since: to be fixed in 弥生 by hand (they are not sent twice). */
  changed: { id: string; number: string; date: string; amountYen: number }[];
  /** Characters 弥生 cannot read (Shift_JIS) in the journals to send, with where they are. */
  unencodable: { number: string; field: string; chars: string }[];
  batches: { id: string; at: string; actorName: string; count: number; from: string | null; to: string | null }[];
}

export interface YayoiImportRow {
  line: number;
  action: 'new' | 'duplicate' | 'ours' | 'unreadable';
  date: string | null;
  amountYen: number | null;
  memo: string;
  reason: string;
}

export interface YayoiImportResponse {
  dryRun: boolean;
  counts: Record<YayoiImportRow['action'], number>;
  rows: YayoiImportRow[];
  /** Accounts the file names that the books do not have yet: made when it is imported. */
  newAccounts: { name: string; sub: string; kind: AccountKind | null }[];
  planToken: string;
  encoding: 'utf-8' | 'shift_jis';
}

export interface BooksHistoryView {
  id: number;
  at: string;
  actorName: string;
  text: string;
}
