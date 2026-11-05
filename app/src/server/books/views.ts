import {
  accountTitle,
  CLAIM_STATE_LABELS,
  JOURNAL_SOURCE_LABELS,
  normalSide,
  type AccountView,
  type BudgetRow,
  type ClaimView,
  type EntryInput,
  type JournalView,
  type MoneyBalance,
  type ReceiptView,
} from '../../shared/books.js';
import { claimNumber, journalNumber, taxOf, type AccountRow, type BooksStore, type ClaimRow, type JournalRow, type LineRow, type NewJournal, type NewLine, type ReceiptRow } from './store.js';
import type { ExportJournal } from './yayoi.js';

// The books as the screens and the 弥生 file see them (the spreadsheet's tabs are in sheet-tabs.ts): the views of the rows, the journals the plain
// forms make, the balances of the money accounts and the budget against the actual figures.

export type NameOf = (userId: string) => string;

export const accountView = (a: AccountRow, used: Set<string>): AccountView => ({
  id: a.id,
  name: a.name,
  sub: a.sub,
  kind: a.kind,
  group: a.grp,
  money: a.money === 1,
  label: a.label,
  title: accountTitle(a),
  taxClass: a.tax_class,
  active: a.active === 1,
  used: used.has(a.id),
  version: a.version,
});

export const receiptView = (r: ReceiptRow): ReceiptView => ({ id: r.id, name: r.name, type: r.type, bytes: r.bytes, uploadedAt: r.uploaded_at });

// ---- the plain forms → journals

/** One line. 弥生's 部門 is left empty (the committee's 弥生 has none; the 部局 stays on the journal). */
const line = (side: 'debit' | 'credit', a: AccountRow, amountYen: number, partner = ''): NewLine => ({ side, accountId: a.id, amountYen, taxClass: taxOf(a), department: '', partner });

/**
 * The two lines of a plain entry: 収入 (the money account against the income), 支出 (the spending against the money
 * account), 口座の移動 (to against from), 振替 (as chosen). The 取引先 goes on the side that is not money.
 * `account` looks the ids up; a missing one is refused by the store.
 */
export function entryJournal(e: EntryInput, account: (id: string | null) => AccountRow | null, fiscalYear: number): NewJournal {
  const need = (id: string | null): AccountRow => {
    const a = account(id);
    if (!a) throw new MissingAccount();
    return a;
  };
  let lines: NewLine[];
  if (e.form === 'income') {
    const money = need(e.moneyAccountId);
    const other = need(e.accountId);
    if (money.money !== 1) throw new NotMoney();
    lines = [line('debit', money, e.amountYen), line('credit', other, e.amountYen, e.counterparty)];
  } else if (e.form === 'expense') {
    const money = need(e.moneyAccountId);
    const other = need(e.accountId);
    if (money.money !== 1) throw new NotMoney();
    lines = [line('debit', other, e.amountYen, e.counterparty), line('credit', money, e.amountYen)];
  } else if (e.form === 'transfer') {
    const from = need(e.moneyAccountId);
    const to = need(e.toMoneyAccountId);
    if (from.money !== 1 || to.money !== 1) throw new NotMoney();
    lines = [line('debit', to, e.amountYen), line('credit', from, e.amountYen)];
  } else {
    lines = [line('debit', need(e.debitAccountId), e.amountYen, e.counterparty), line('credit', need(e.creditAccountId), e.amountYen, e.counterparty)];
  }
  return {
    date: e.date,
    fiscalYear,
    form: e.form,
    entry: e,
    counterparty: e.counterparty,
    memo: e.memo,
    department: e.department,
    source: 'manual',
    sourceRef: null,
    claimId: null,
    yayoiNo: '',
    yayoiKey: null,
    sticky: 0,
    lines,
  };
}

export class MissingAccount extends Error {}
export class NotMoney extends Error {}

/** A claim approved: the spending against the claim account (立替金 or 未払金), the member's name as 取引先. */
export function claimAccrualJournal(c: ClaimRow, spending: AccountRow, owed: AccountRow, fiscalYear: number): NewJournal {
  const memo = `立替精算 ${claimNumber(c.fiscal_year, c.seq)} ${c.purpose}${c.payee ? `（${c.payee}）` : ''} ${c.claimant_name}`.slice(0, 200);
  return {
    date: c.spent_on,
    fiscalYear,
    form: 'journal',
    entry: null,
    counterparty: c.claimant_name,
    memo,
    department: c.department,
    source: 'claim',
    sourceRef: `${c.id}:accrual`,
    claimId: c.id,
    yayoiNo: '',
    yayoiKey: null,
    sticky: 0,
    lines: [line('debit', spending, c.amount_yen, c.payee), line('credit', owed, c.amount_yen, c.claimant_name)],
  };
}

/** A claim paid back: the claim account against the money account it was paid from. */
export function claimPaymentJournal(c: ClaimRow, owed: AccountRow, money: AccountRow, paidOn: string, fiscalYear: number): NewJournal {
  return {
    date: paidOn,
    fiscalYear,
    form: 'journal',
    entry: null,
    counterparty: c.claimant_name,
    memo: `立替精算の返金 ${claimNumber(c.fiscal_year, c.seq)} ${c.claimant_name}`.slice(0, 200),
    department: c.department,
    source: 'claim',
    sourceRef: `${c.id}:payment`,
    claimId: c.id,
    yayoiNo: '',
    yayoiKey: null,
    sticky: 0,
    lines: [line('debit', owed, c.amount_yen, c.claimant_name), line('credit', money, c.amount_yen)],
  };
}

/** A confirmed deposit: the money account against the income of the organization's kind. */
export function depositJournal(d: { depositId: string; bookedOn: string; amountYen: number; orgName: string; invoiceNumber: string }, money: AccountRow, income: AccountRow, fiscalYear: number): NewJournal {
  return {
    date: d.bookedOn,
    fiscalYear,
    form: 'income',
    entry: null,
    counterparty: d.orgName,
    memo: `入金 ${d.orgName}（請求 ${d.invoiceNumber}）`.slice(0, 200),
    department: '',
    source: 'deposit',
    sourceRef: d.depositId,
    claimId: null,
    yayoiNo: '',
    yayoiKey: null,
    sticky: 0,
    lines: [line('debit', money, d.amountYen), line('credit', income, d.amountYen, d.orgName)],
  };
}

// ---- journals → views

export interface Books {
  accounts: Map<string, AccountRow>;
  nameOf: NameOf;
}

export function booksOf(store: BooksStore, nameOf: NameOf): Books {
  return { accounts: new Map(store.accounts().map((a) => [a.id, a])), nameOf };
}

const titleOf = (b: Books, id: string) => {
  const a = b.accounts.get(id);
  return a ? accountTitle(a) : '（不明な科目）';
};

/** The plain reading of a journal: which money account, which way, and the other account. */
export function plainOf(b: Books, lines: LineRow[]): { direction: JournalView['direction']; money: string | null; other: string | null } {
  if (lines.length !== 2) return { direction: 'none', money: null, other: null };
  const debit = lines.find((l) => l.side === 'debit');
  const credit = lines.find((l) => l.side === 'credit');
  if (!debit || !credit) return { direction: 'none', money: null, other: null };
  const dm = b.accounts.get(debit.account_id)?.money === 1;
  const cm = b.accounts.get(credit.account_id)?.money === 1;
  if (dm && cm) return { direction: 'move', money: titleOf(b, credit.account_id), other: titleOf(b, debit.account_id) };
  if (dm) return { direction: 'in', money: titleOf(b, debit.account_id), other: titleOf(b, credit.account_id) };
  if (cm) return { direction: 'out', money: titleOf(b, credit.account_id), other: titleOf(b, debit.account_id) };
  return { direction: 'none', money: null, other: `${titleOf(b, debit.account_id)} ／ ${titleOf(b, credit.account_id)}` };
}

export function journalView(b: Books, j: JournalRow, lines: LineRow[], receipts: ReceiptRow[]): JournalView {
  const amount = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount_yen, 0);
  const plain = plainOf(b, lines);
  return {
    id: j.id,
    number: journalNumber(j.seq),
    fiscalYear: j.fiscal_year,
    date: j.date,
    form: j.form,
    amountYen: amount,
    moneyAccountTitle: plain.money,
    accountTitle: plain.other,
    direction: plain.direction,
    counterparty: j.counterparty,
    memo: j.memo,
    department: j.department,
    lines: lines.map((l) => ({ side: l.side, accountId: l.account_id, accountTitle: titleOf(b, l.account_id), amountYen: l.amount_yen, taxClass: l.tax_class, department: l.department })),
    source: j.source,
    sourceLabel: JOURNAL_SOURCE_LABELS[j.source],
    voided: j.voided === 1,
    voidNote: j.void_note,
    yayoiExportedAt: j.yayoi_batch,
    yayoiChangedAfterExport: j.yayoi_dirty === 1,
    receipts: receipts.map(receiptView),
    yayoiNo: j.yayoi_no,
    sticky: j.sticky,
    claimId: j.claim_id,
    version: j.version,
    updatedAt: j.updated_at,
    updatedByName: b.nameOf(j.updated_by),
    entry: j.source === 'manual' && j.entry_json ? (JSON.parse(j.entry_json) as EntryInput) : null,
  };
}

export function journalViews(store: BooksStore, b: Books, rows: JournalRow[]): JournalView[] {
  const ids = rows.map((r) => r.id);
  const lines = store.linesOf(ids);
  const receipts = store.receiptsOf('journal', ids);
  return rows.map((r) => journalView(b, r, lines.get(r.id) ?? [], receipts.get(r.id) ?? []));
}

export function claimView(b: Books, c: ClaimRow, receipts: ReceiptRow[], viewerId: string): ClaimView {
  const account = c.account_id ? b.accounts.get(c.account_id) : undefined;
  const from = c.paid_from ? b.accounts.get(c.paid_from) : undefined;
  return {
    id: c.id,
    number: claimNumber(c.fiscal_year, c.seq),
    fiscalYear: c.fiscal_year,
    claimantId: c.claimant_id,
    claimantName: c.claimant_name,
    mine: c.claimant_id === viewerId,
    spentOn: c.spent_on,
    amountYen: c.amount_yen,
    payee: c.payee,
    purpose: c.purpose,
    department: c.department,
    accountId: c.account_id,
    accountTitle: account ? accountTitle(account) : null,
    preapproval: c.preapproval,
    state: c.state,
    stateLabel: CLAIM_STATE_LABELS[c.state],
    note: c.note,
    approvedAt: c.approved_at,
    approvedByName: c.approved_by ? b.nameOf(c.approved_by) : null,
    paidOn: c.paid_on,
    paidFromTitle: from ? accountTitle(from) : null,
    receipts: receipts.map(receiptView),
    version: c.version,
    submittedAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export function claimViews(store: BooksStore, b: Books, rows: ClaimRow[], viewerId: string): ClaimView[] {
  const receipts = store.receiptsOf('claim', rows.map((r) => r.id));
  return rows.map((r) => claimView(b, r, receipts.get(r.id) ?? [], viewerId));
}

// ---- reports

/** Debit-positive balance of each account over a year: the opening balance and the year's lines. */
export function accountTotals(store: BooksStore, fiscalYear: number): Map<string, { opening: number; debit: number; credit: number }> {
  const out = new Map<string, { opening: number; debit: number; credit: number }>();
  const get = (id: string) => {
    let t = out.get(id);
    if (!t) out.set(id, (t = { opening: 0, debit: 0, credit: 0 }));
    return t;
  };
  for (const o of store.openings(fiscalYear)) get(o.account_id).opening += o.amount_yen;
  for (const l of store.yearLines(fiscalYear)) {
    if (l.side === 'debit') get(l.account_id).debit += l.amount_yen;
    else get(l.account_id).credit += l.amount_yen;
  }
  return out;
}

export function moneyBalances(b: Books, totals: Map<string, { opening: number; debit: number; credit: number }>): MoneyBalance[] {
  return [...b.accounts.values()]
    .filter((a) => a.money === 1 && (a.active === 1 || totals.has(a.id)))
    .map((a) => {
      const t = totals.get(a.id) ?? { opening: 0, debit: 0, credit: 0 };
      return { accountId: a.id, title: accountTitle(a), openingYen: t.opening, inYen: t.debit, outYen: t.credit, balanceYen: t.opening + t.debit - t.credit };
    });
}

/** Income and spending per 科目 (its 補助科目 together) against the budget of the year. */
export function budgetRows(b: Books, totals: Map<string, { opening: number; debit: number; credit: number }>, budget: { account_name: string; amount_yen: number }[]): BudgetRow[] {
  const rows = new Map<string, BudgetRow>();
  for (const a of b.accounts.values()) {
    if (a.kind !== 'income' && a.kind !== 'expense') continue;
    const t = totals.get(a.id);
    const actual = t ? (normalSide(a.kind) === 'debit' ? t.debit - t.credit : t.credit - t.debit) : 0;
    const row = rows.get(a.name) ?? { accountName: a.name, kind: a.kind, group: a.grp, budgetYen: null, actualYen: 0, differenceYen: null, rate: null };
    row.actualYen += actual;
    rows.set(a.name, row);
  }
  for (const line of budget) {
    const row = rows.get(line.account_name);
    if (row) row.budgetYen = line.amount_yen;
  }
  const out = [...rows.values()].filter((r) => r.budgetYen !== null || r.actualYen !== 0);
  for (const r of out) {
    if (r.budgetYen !== null) {
      r.differenceYen = r.actualYen - r.budgetYen;
      r.rate = r.budgetYen > 0 ? Math.round((r.actualYen / r.budgetYen) * 1000) / 10 : null;
    }
  }
  const order = (r: BudgetRow) => (r.kind === 'income' ? 0 : 1);
  return out.sort((x, y) => order(x) - order(y) || x.group.localeCompare(y.group, 'ja') || x.accountName.localeCompare(y.accountName, 'ja'));
}

// ---- 弥生

export function exportJournal(b: Books, j: JournalRow, lines: LineRow[]): ExportJournal {
  return {
    number: journalNumber(j.seq),
    date: j.date,
    memo: j.counterparty && !j.memo.includes(j.counterparty) ? `${j.memo} ${j.counterparty}`.trim() : j.memo,
    sticky: j.sticky,
    lines: lines.map((l) => {
      const a = b.accounts.get(l.account_id);
      return { side: l.side, account: a?.name ?? '', sub: a?.sub ?? '', department: l.department, taxClass: l.tax_class, amountYen: l.amount_yen, partner: l.partner };
    }),
  };
}

