import { createHash } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACCOUNT_ID,
  BOOKS_LIMITS,
  BooksValidationError,
  CLAIM_ID,
  DEFAULT_ACCOUNTS,
  fiscalRange,
  fiscalYearOf,
  guessAccount,
  JOURNAL_ID,
  PREAPPROVAL_ABOVE_YEN,
  RECEIPT_ID,
  receiptName,
  sniffReceiptType,
  tokyoDate,
  validateAccount,
  validateBudget,
  validateClaim,
  validateEntry,
  validateNote,
  validateSettings,
  yen,
  type AccountView,
  type BooksHistoryView,
  type BooksMe,
  type BooksSettings,
  type BooksSummary,
  type ClaimsOverview,
  type ClaimView,
  type DepositToBook,
  type JournalList,
  type JournalView,
  type OpeningRow,
  type SheetsStatus,
  type YayoiExportPlan,
  type YayoiImportResponse,
  type YayoiImportRow,
} from '../../shared/books.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import { ORG_KIND_LABELS } from '../../shared/organizations.js';
import type { AccountingPermission } from '../../shared/payments.js';
import { committeeMember, type ContactRouteDeps } from '../contacts/routes.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { attachmentDisposition } from '../http/content-disposition.js';
import { HttpError } from '../http/http-error.js';
import type { OrganizationsStore } from '../organizations/store.js';
import type { PaymentsStore } from '../payments/store.js';
import { SHEETS_FAILURE_LABELS, type SheetsSync } from './sheets.js';
import { BooksRefused, journalNumber, type AccountRow, type BooksRefusal, type BooksStore, type ClaimRow, type HistoryRow, type NewJournal, type NewLine } from './store.js';
import {
  accountTotals,
  accountView,
  booksOf,
  budgetRows,
  claimAccrualJournal,
  claimPaymentJournal,
  claimViews,
  depositJournal,
  entryJournal,
  exportJournal,
  journalViews,
  MissingAccount,
  moneyBalances,
  NotMoney,
  type Books,
} from './views.js';
import { encodeShiftJis, parseYayoiJournals, parseYayoiOpenings, unencodable, yayoiCsv } from './yayoi.js';

// Books (会計の帳簿, 2026-11-05), at /api/books in the committee mailbox's app (its people and sign-in). Permissions,
// checked on the server for every request:
// - every committee member (not temporary staff): their own reimbursement claims (立替精算) and their receipts;
// - 会計を見る (accounting.view, the payments' permission): the books, every claim, the reports, the 弥生 batches;
// - 会計の確定 (accounting.confirm): entries, approving and paying claims, the accounts, the budget, 弥生, the sheet.
// Amounts, names and receipts are never logged (the app's logger is off).

export interface BooksRouteDeps extends ContactRouteDeps {
  payments: PaymentsStore | null;
  organizations: OrganizationsStore | null;
  now: () => number;
  /** The spreadsheet's writer, when books-sheets.json is set up. */
  sheets: SheetsSync | null;
  /** The spreadsheet's address, for the link on the settings screen (only shown to the accounting section). */
  sheetsUrl?: string | null;
  /** The accounting permissions of a person (the payments' grants); none when the payments are off. */
  permissionsOf: (user: User) => AccountingPermission[];
}

const REFUSALS: Record<BooksRefusal, { code: 'conflict' | 'validation'; message: string }> = {
  conflict: { code: 'conflict', message: 'ほかの人が先に変更しました。最新の内容を読み込み直してから、もう一度操作してください。' },
  voided: { code: 'conflict', message: 'この仕訳は取り消されています。' },
  not_voided: { code: 'conflict', message: 'この仕訳は取り消されていません。読み直してください。' },
  unbalanced: { code: 'validation', message: '借方と貸方の合計が合いません。' },
  account_unknown: { code: 'validation', message: '科目が見つかりません。科目の設定を読み直してください。' },
  account_inactive: { code: 'validation', message: '使わない設定の科目は選べません。科目の設定で「使う」に戻してください。' },
  account_taken: { code: 'conflict', message: '同じ科目名・補助科目の科目がもうあります。' },
  claim_state: { code: 'conflict', message: 'この申請は、ほかの人が先に状態を変えました。読み直してください。' },
  not_editable: { code: 'conflict', message: 'この操作はここではできません（立替精算・入金確認・弥生から来た仕訳は、それぞれの画面で直します。使われている科目の名前は変えられません）。' },
  receipts_full: { code: 'validation', message: `領収書は ${BOOKS_LIMITS.receipts} 枚までです。` },
  claim_account_unset: { code: 'validation', message: '設定で「立替精算で使う科目」を選んでから承認してください。' },
  deposit_booked: { code: 'conflict', message: 'この入金はもう帳簿に入っています。読み直してください。' },
};

/** Input errors and refused writes as the API's answers. */
function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof BooksValidationError) throw new DomainError('validation', err.message, { field: err.field });
    if (err instanceof BooksRefused) {
      const r = REFUSALS[err.reason];
      throw new DomainError(r.code, r.message);
    }
    if (err instanceof MissingAccount) throw new DomainError('validation', '科目が見つかりません。科目の設定を読み直してください。');
    if (err instanceof NotMoney) throw new DomainError('validation', '口座には「口座（現金・預金）」の印がある科目を選んでください。');
    throw err;
  }
}

const token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const version = z.number().int().min(1);
const journalParams = z.strictObject({ journalId: z.string().regex(JOURNAL_ID) });
const claimParams = z.strictObject({ claimId: z.string().regex(CLAIM_ID) });
const accountParams = z.strictObject({ accountId: z.string().regex(ACCOUNT_ID) });
const receiptParams = z.strictObject({ receiptId: z.string().regex(RECEIPT_ID) });
const exportParams = z.strictObject({ exportId: z.string().regex(/^yx_[0-9a-f]{16}$/) });
const yearQuery = z.strictObject({ fiscalYear: z.coerce.number().int().min(BOOKS_LIMITS.fiscalYearMin).max(BOOKS_LIMITS.fiscalYearMax).optional() });
const journalQuery = z.strictObject({
  fiscalYear: yearQuery.shape.fiscalYear,
  accountId: z.string().regex(ACCOUNT_ID).optional(),
  q: z.string().max(100).optional(),
  voided: z.enum(['0', '1']).optional(),
});
const planQuery = z.strictObject({ fiscalYear: yearQuery.shape.fiscalYear, to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const note = z.string().max(BOOKS_LIMITS.note * 2).optional();

const SHEET_FAILURE = SHEETS_FAILURE_LABELS as Record<string, string>;

export function registerBooksRoutes(app: FastifyInstance, opened: BooksStore | null, deps: BooksRouteDeps): void {
  const nameOf = (userId: string) => deps.people.lookup(userId)?.displayName ?? '（不明な利用者）';
  const member = (request: FastifyRequest): User => {
    try {
      return committeeMember(deps, request);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'forbidden') throw new DomainError('forbidden', '会計は委員だけが使えます。');
      throw err;
    }
  };

  if (!opened) {
    const unavailable = async (request: FastifyRequest) => {
      member(request);
      throw new HttpError(503, { error: 'books_unavailable', message: '会計の帳簿の保存ファイルを開けませんでした。システム課に連絡してください（ほかの機能は使えます）。' });
    };
    app.all('/api/books', unavailable);
    app.all('/api/books/*', unavailable);
    return;
  }
  const store = opened;
  const sheets = deps.sheets;

  const can = (user: User, p: AccountingPermission) => deps.permissionsOf(user).includes(p);
  const viewer = (request: FastifyRequest): User => {
    const user = member(request);
    if (!can(user, 'accounting.view')) throw new DomainError('forbidden', '会計を見る権限がありません。権限管理者に「会計を見る」の権限を依頼してください。');
    return user;
  };
  const editor = (request: FastifyRequest): User => {
    const user = member(request);
    if (!can(user, 'accounting.confirm')) throw new DomainError('forbidden', '帳簿を付ける権限がありません。権限管理者に「会計の確定」の権限を依頼してください。');
    return user;
  };
  const departmentsOf = (user: User) => departmentsOfLabel(user.roleLabel).filter((d) => d !== TEMPORARY_STAFF_DEPARTMENT);
  const today = () => tokyoDate(deps.now());
  const startMonth = () => store.fiscalStartMonth();
  const yearOf = (day: string) => fiscalYearOf(day, startMonth());
  const thisYear = () => yearOf(today());
  const books = (): Books => booksOf(store, nameOf);
  /** Every write asks the spreadsheet for a fresh copy (after the pause). */
  const changed = () => sheets?.request();

  const account = (id: string | null): AccountRow | null => (id ? store.account(id) : null);

  const settings = (): BooksSettings => ({
    fiscalStartMonth: startMonth(),
    claimAccountId: store.setting<string | null>('claimAccountId', null),
    depositMoneyAccountId: store.setting<string | null>('depositMoneyAccountId', null),
    depositAccountByKind: store.setting<Record<string, string | null>>('depositAccountByKind', {}),
    version: store.setting<number>('settingsVersion', 1),
  });

  const sheetsStatus = (): SheetsStatus => ({
    configured: sheets !== null,
    lastOkAt: store.meta('sheets.lastOkAt'),
    lastAttemptAt: store.meta('sheets.lastAttemptAt'),
    lastError: store.meta('sheets.lastError') ? (SHEET_FAILURE[store.meta('sheets.lastError')!] ?? store.meta('sheets.lastError')) : null,
    pending: sheets?.pending() ?? false,
    url: sheets ? (deps.sheetsUrl ?? null) : null,
  });

  const historyText = (h: HistoryRow): string => {
    const d = h.detail ?? {};
    const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
    const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
    const withNote = (text: string) => (s('note') ? `${text}（${s('note')}）` : text);
    switch (h.action) {
      case 'journal_created':
        return `記帳しました（${yen(n('amountYen'))}）`;
      case 'journal_updated':
        return d.exported === true ? '内容を変えました（弥生へ書き出し済みのため、弥生でも直してください）' : '内容を変えました';
      case 'journal_voided':
        return withNote('取り消しました');
      case 'journal_restored':
        return '取り消しを戻しました';
      case 'journal_updated_from_yayoi':
        return '弥生の書き出しに合わせて変えました';
      case 'yayoi_change_cleared':
        return '弥生で直したことを確認しました';
      case 'receipt_added':
        return `領収書を付けました（${s('name')}）`;
      case 'receipt_removed':
        return `領収書を外しました（${s('name')}）`;
      case 'claim_submitted':
        return `申請しました（${yen(n('amountYen'))}）`;
      case 'claim_updated':
        return `申請を直しました（${yen(n('amountYen'))}）`;
      case 'claim_resubmitted':
        return `直して出し直しました（${yen(n('amountYen'))}）`;
      case 'claim_withdrawn':
        return '取り下げました';
      case 'claim_rejected':
        return withNote('差し戻しました');
      case 'claim_approved':
        return `承認して帳簿に入れました（${journalNumber(n('journal'))}）`;
      case 'claim_unapproved':
        return withNote('承認を取り消しました');
      case 'claim_paid':
        return `返金しました（${s('paidOn')}・${journalNumber(n('journal'))}）`;
      case 'claim_unpaid':
        return withNote('返金を取り消しました');
      default:
        return h.action;
    }
  };
  const historyView = (h: HistoryRow): BooksHistoryView => ({ id: h.id, at: h.at, actorName: nameOf(h.actor_id), text: historyText(h) });

  // ---- who may do what

  app.get('/api/books/me', async (request): Promise<BooksMe> => {
    const user = member(request);
    return {
      canClaim: true,
      canView: can(user, 'accounting.view'),
      canEdit: can(user, 'accounting.confirm'),
      departments: departmentsOf(user),
      fiscalYear: thisYear(),
      fiscalStartMonth: startMonth(),
      sheetsConfigured: sheets !== null,
    };
  });

  // ---- settings and accounts

  const accountViews = (): AccountView[] => {
    const used = store.usedAccountIds();
    return store.accounts().map((a) => accountView(a, used));
  };

  app.get('/api/books/settings', async (request) => {
    viewer(request);
    return { settings: settings(), accounts: accountViews(), orgKinds: Object.entries(ORG_KIND_LABELS).map(([key, label]) => ({ key, label })) };
  });

  app.put('/api/books/settings', async (request) => {
    const user = editor(request);
    const body = deps.parse(z.strictObject({ expectedVersion: version, settings: z.unknown() }), request.body);
    const input = checked(() => validateSettings(body.settings));
    for (const id of [input.claimAccountId, input.depositMoneyAccountId, ...Object.values(input.depositAccountByKind)]) {
      if (id && !store.account(id)) throw new DomainError('validation', '設定に、見つからない科目があります。読み直してください。');
    }
    if (input.depositMoneyAccountId && store.account(input.depositMoneyAccountId)?.money !== 1) throw new DomainError('validation', '入金の口座には「口座（現金・預金）」の科目を選んでください。');
    store.tx(() => {
      if (store.setting<number>('settingsVersion', 1) !== body.expectedVersion) throw new DomainError('conflict', 'ほかの人が先に設定を変えました。読み直してください。');
      store.setSetting('fiscalStartMonth', input.fiscalStartMonth);
      store.setSetting('claimAccountId', input.claimAccountId);
      store.setSetting('depositMoneyAccountId', input.depositMoneyAccountId);
      store.setSetting('depositAccountByKind', input.depositAccountByKind);
      store.setSetting('settingsVersion', body.expectedVersion + 1);
      store.addHistory('settings', 'books', user.id, deps.clock(), 'settings_updated', null);
    });
    return { settings: settings(), accounts: accountViews() };
  });

  app.post('/api/books/accounts', async (request, reply) => {
    const user = editor(request);
    const body = deps.parse(z.strictObject({ account: z.unknown() }), request.body);
    const input = checked(() => validateAccount(body.account));
    const row = checked(() => store.createAccount(input, user.id, deps.clock()));
    changed();
    return reply.code(201).send({ account: accountView(row, new Set()), accounts: accountViews() });
  });

  app.put('/api/books/accounts/:accountId', async (request) => {
    const user = editor(request);
    const { accountId } = deps.parse(accountParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, account: z.unknown() }), request.body);
    const input = checked(() => validateAccount(body.account));
    const row = checked(() => store.updateAccount(accountId, body.expectedVersion, input, user.id, deps.clock()));
    if (!row) throw notFound();
    changed();
    return { accounts: accountViews() };
  });

  /** Adds 弥生's usual accounts that the book does not have (for a book that does not start from 弥生). */
  app.post('/api/books/accounts/defaults', async (request) => {
    const user = editor(request);
    const now = deps.clock();
    let added = 0;
    store.tx(() => {
      for (const a of DEFAULT_ACCOUNTS) {
        if (store.accountByName(a.name, '')) continue;
        store.insertAccount({ name: a.name, sub: '', kind: a.kind, group: a.group, money: a.money === true, label: '', taxClass: '対象外', active: true }, user.id, now);
        added += 1;
      }
      store.bumpRevision();
    });
    changed();
    return { added, accounts: accountViews() };
  });

  // ---- summary

  app.get('/api/books/summary', async (request): Promise<BooksSummary> => {
    const user = viewer(request);
    const q = deps.parse(yearQuery, request.query);
    const fiscalYear = q.fiscalYear ?? thisYear();
    const b = books();
    const totals = accountTotals(store, fiscalYear);
    const budget = budgetRows(b, totals, store.budget(fiscalYear));
    const { from, to } = fiscalRange(fiscalYear, startMonth());
    const owed = store.owedClaims().reduce((s, c) => s + c.amount_yen, 0);
    void user;
    return {
      fiscalYear,
      from,
      to,
      balances: moneyBalances(b, totals),
      incomeYen: budget.filter((r) => r.kind === 'income').reduce((s, r) => s + r.actualYen, 0),
      expenseYen: budget.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.actualYen, 0),
      budget,
      owedYen: owed,
      claimsWaiting: store.allClaims().filter((c) => c.state === 'submitted').length,
      depositsToBook: depositsToBook().filter((d) => d.journalId === null && !linked().has(d.depositId)).length,
      yayoi: { unexported: store.unexported(fiscalYear, null).length, changedAfterExport: store.changedAfterExport().length, lastExportAt: store.lastExportAt() },
      sheets: sheetsStatus(),
      today: today(),
    };
  });

  // ---- journals

  const journalOf = (id: string): JournalView => {
    const row = store.journal(id);
    if (!row) throw notFound();
    return journalViews(store, books(), [row])[0]!;
  };

  app.get('/api/books/journals', async (request): Promise<JournalList> => {
    viewer(request);
    const q = deps.parse(journalQuery, request.query);
    const fiscalYear = q.fiscalYear ?? thisYear();
    let rows = store.journalsOfYear(fiscalYear);
    if (q.voided !== '1') rows = rows.filter((r) => r.voided === 0);
    if (q.accountId) {
      const lines = store.linesOf(rows.map((r) => r.id));
      rows = rows.filter((r) => (lines.get(r.id) ?? []).some((l) => l.account_id === q.accountId));
    }
    let views = journalViews(store, books(), rows);
    const text = q.q?.normalize('NFKC').trim().toLowerCase();
    if (text) views = views.filter((v) => [v.number, v.memo, v.counterparty, v.department, v.accountTitle ?? '', v.moneyAccountTitle ?? '', String(v.amountYen)].some((s) => s.normalize('NFKC').toLowerCase().includes(text)));
    return { fiscalYear, journals: views.reverse(), total: views.length };
  });

  app.get('/api/books/journals/:journalId', async (request) => {
    viewer(request);
    const { journalId } = deps.parse(journalParams, request.params);
    return { journal: journalOf(journalId), history: store.history('journal', journalId).map(historyView) };
  });

  const newJournal = (entryRaw: unknown): NewJournal => {
    const entry = checked(() => validateEntry(entryRaw));
    return checked(() => entryJournal(entry, account, yearOf(entry.date)));
  };

  app.post('/api/books/journals', async (request, reply) => {
    const user = editor(request);
    const body = deps.parse(z.strictObject({ clientToken: token, entry: z.unknown() }), request.body);
    const row = checked(() => store.createJournal(newJournal(body.entry), body.clientToken, user.id, deps.clock()));
    changed();
    return reply.code(201).send({ journal: journalOf(row.id) });
  });

  app.put('/api/books/journals/:journalId', async (request) => {
    const user = editor(request);
    const { journalId } = deps.parse(journalParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, entry: z.unknown() }), request.body);
    const row = checked(() => store.updateJournal(journalId, body.expectedVersion, newJournal(body.entry), user.id, deps.clock()));
    if (!row) throw notFound();
    changed();
    return { journal: journalOf(journalId) };
  });

  app.post('/api/books/journals/:journalId/void', async (request) => {
    const user = editor(request);
    const { journalId } = deps.parse(journalParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, note }), request.body);
    const text = checked(() => validateNote(body.note, '取り消しの理由'));
    const row = checked(() => store.voidJournal(journalId, body.expectedVersion, text, user.id, deps.clock()));
    if (!row) throw notFound();
    changed();
    return { journal: journalOf(journalId) };
  });

  app.post('/api/books/journals/:journalId/restore', async (request) => {
    const user = editor(request);
    const { journalId } = deps.parse(journalParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version }), request.body);
    const row = checked(() => store.restoreJournal(journalId, body.expectedVersion, user.id, deps.clock()));
    if (!row) throw notFound();
    changed();
    return { journal: journalOf(journalId) };
  });

  app.post('/api/books/journals/:journalId/yayoi-fixed', async (request) => {
    const user = editor(request);
    const { journalId } = deps.parse(journalParams, request.params);
    if (!store.journal(journalId)) throw notFound();
    store.clearExportChange(journalId, user.id, deps.clock());
    return { journal: journalOf(journalId) };
  });

  // ---- reimbursements (立替精算)

  const claimRow = (id: string): ClaimRow => {
    const row = store.claim(id);
    if (!row) throw notFound();
    return row;
  };
  const claimOf = (row: ClaimRow, viewerId: string): ClaimView => claimViews(store, books(), [row], viewerId)[0]!;
  /** The claimant, or someone who sees the books. Anyone else gets 404 (a claim's number says nothing). */
  const claimReader = (request: FastifyRequest, id: string): { user: User; row: ClaimRow } => {
    const user = member(request);
    const row = claimRow(id);
    if (row.claimant_id !== user.id && !can(user, 'accounting.view')) throw notFound();
    return { user, row };
  };
  const spendingAccounts = (): AccountView[] => accountViews().filter((a) => a.active && a.kind === 'expense');

  app.get('/api/books/claims', async (request): Promise<ClaimsOverview & { accounts: AccountView[]; departments: string[]; preapprovalAboveYen: number; moneyAccounts: AccountView[] | null }> => {
    const user = member(request);
    const q = deps.parse(yearQuery, request.query);
    const fiscalYear = q.fiscalYear ?? thisYear();
    const b = books();
    const mine = claimViews(store, b, store.claimsOf(user.id, fiscalYear), user.id);
    const sees = can(user, 'accounting.view');
    let submitted: ClaimView[] | null = null;
    let approved: ClaimView[] | null = null;
    let closed: ClaimView[] | null = null;
    let owed: ClaimsOverview['owed'] = null;
    if (sees) {
      const all = claimViews(store, b, store.claimsOfYear(fiscalYear), user.id);
      // Waiting for a check: of any year (a claim filed at the turn of the year is not lost in the other year).
      submitted = claimViews(store, b, store.allClaims().filter((c) => c.state === 'submitted'), user.id);
      closed = all.filter((c) => c.state === 'paid' || c.state === 'rejected' || c.state === 'withdrawn');
      // Owed: approved claims of any year (December's are paid in January).
      approved = claimViews(store, b, store.owedClaims(), user.id);
      const by = new Map<string, { claimantId: string; claimantName: string; count: number; amountYen: number }>();
      for (const c of approved) {
        const o = by.get(c.claimantId) ?? { claimantId: c.claimantId, claimantName: c.claimantName, count: 0, amountYen: 0 };
        o.count += 1;
        o.amountYen += c.amountYen;
        by.set(c.claimantId, o);
      }
      owed = [...by.values()].sort((x, y) => x.claimantName.localeCompare(y.claimantName, 'ja'));
    }
    return {
      fiscalYear,
      mine,
      submitted,
      approved,
      closed,
      owed,
      accounts: spendingAccounts(),
      departments: departmentsOf(user),
      preapprovalAboveYen: PREAPPROVAL_ABOVE_YEN,
      moneyAccounts: can(user, 'accounting.confirm') ? accountViews().filter((a) => a.active && a.money) : null,
    };
  });

  app.get('/api/books/claims/:claimId', async (request) => {
    const { claimId } = deps.parse(claimParams, request.params);
    const { user, row } = claimReader(request, claimId);
    return { claim: claimOf(row, user.id), history: store.history('claim', claimId).map(historyView) };
  });

  const claimInput = (raw: unknown) => {
    const input = checked(() => validateClaim(raw));
    if (input.accountId) {
      const a = store.account(input.accountId);
      if (!a || a.kind !== 'expense' || a.active !== 1) throw new DomainError('validation', '科目を選び直してください（支出の科目）。', { field: 'accountId' });
    }
    return input;
  };

  app.post('/api/books/claims', async (request, reply) => {
    const user = member(request);
    const body = deps.parse(z.strictObject({ clientToken: token, claim: z.unknown() }), request.body);
    const input = claimInput(body.claim);
    const row = checked(() => store.createClaim(input, yearOf(input.spentOn), { id: user.id, name: user.displayName }, body.clientToken, deps.clock()));
    changed();
    return reply.code(201).send({ claim: claimOf(row, user.id) });
  });

  app.put('/api/books/claims/:claimId', async (request) => {
    const user = member(request);
    const { claimId } = deps.parse(claimParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, claim: z.unknown() }), request.body);
    const before = claimRow(claimId);
    if (before.claimant_id !== user.id) throw notFound();
    const input = claimInput(body.claim);
    const row = checked(() => store.updateClaim(claimId, body.expectedVersion, input, yearOf(input.spentOn), user.id, deps.clock()));
    if (!row) throw notFound();
    changed();
    return { claim: claimOf(row, user.id) };
  });

  app.post('/api/books/claims/:claimId/withdraw', async (request) => {
    const user = member(request);
    const { claimId } = deps.parse(claimParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version }), request.body);
    if (claimRow(claimId).claimant_id !== user.id) throw notFound();
    const row = checked(() => store.setClaimState(claimId, body.expectedVersion, ['submitted', 'rejected'], 'withdrawn', '', user.id, deps.clock(), 'claim_withdrawn'));
    if (!row) throw notFound();
    changed();
    return { claim: claimOf(row, user.id) };
  });

  app.post('/api/books/claims/:claimId/reject', async (request) => {
    const user = editor(request);
    const { claimId } = deps.parse(claimParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, note }), request.body);
    const text = checked(() => validateNote(body.note, '差し戻しの理由'));
    if (!text) throw new DomainError('validation', '差し戻しの理由を書いてください（申請した人に見えます）。', { field: 'note' });
    const row = checked(() => store.setClaimState(claimId, body.expectedVersion, ['submitted'], 'rejected', text, user.id, deps.clock(), 'claim_rejected'));
    if (!row) throw notFound();
    changed();
    return { claim: claimOf(row, user.id) };
  });

  const claimAccount = (): AccountRow => {
    const id = store.setting<string | null>('claimAccountId', null);
    const a = id ? store.account(id) : null;
    if (!a) throw new BooksRefused('claim_account_unset');
    return a;
  };

  app.post('/api/books/claims/:claimId/approve', async (request) => {
    const user = editor(request);
    const { claimId } = deps.parse(claimParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, accountId: z.string().regex(ACCOUNT_ID) }), request.body);
    const spending = store.account(body.accountId);
    if (!spending || spending.active !== 1 || spending.money === 1) throw new DomainError('validation', '科目を選び直してください。', { field: 'accountId' });
    const row = checked(() => {
      const owed = claimAccount();
      return store.approveClaim(claimId, body.expectedVersion, body.accountId, (c) => claimAccrualJournal(c, spending, owed, yearOf(c.spent_on)), user.id, deps.clock());
    });
    if (!row) throw notFound();
    changed();
    return { claim: claimOf(row, user.id) };
  });

  app.post('/api/books/claims/:claimId/unapprove', async (request) => {
    const user = editor(request);
    const { claimId } = deps.parse(claimParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, note }), request.body);
    const text = checked(() => validateNote(body.note, '取り消しの理由'));
    const row = checked(() => store.unapproveClaim(claimId, body.expectedVersion, text, user.id, deps.clock()));
    if (!row) throw notFound();
    changed();
    return { claim: claimOf(row, user.id) };
  });

  app.post('/api/books/claims/pay', async (request) => {
    const user = editor(request);
    const body = deps.parse(
      z.strictObject({
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        moneyAccountId: z.string().regex(ACCOUNT_ID),
        claims: z.array(z.strictObject({ id: z.string().regex(CLAIM_ID), expectedVersion: version })).min(1).max(BOOKS_LIMITS.settleMax),
      }),
      request.body,
    );
    if (new Set(body.claims.map((c) => c.id)).size !== body.claims.length) throw new DomainError('validation', '同じ申請が 2 回選ばれています。');
    const money = store.account(body.moneyAccountId);
    if (!money || money.money !== 1 || money.active !== 1) throw new DomainError('validation', '返金した口座を選び直してください。', { field: 'moneyAccountId' });
    if (!fiscalRange(yearOf(body.paidOn), startMonth()) || Number.isNaN(Date.parse(`${body.paidOn}T00:00:00Z`))) throw new DomainError('validation', '返金した日を選び直してください。', { field: 'paidOn' });
    const rows = checked(() => {
      const owed = claimAccount();
      return store.payClaims(body.claims, body.paidOn, money.id, (c) => claimPaymentJournal(c, owed, money, body.paidOn, yearOf(body.paidOn)), user.id, deps.clock());
    });
    changed();
    return { claims: claimViews(store, books(), rows, user.id), totalYen: rows.reduce((s, r) => s + r.amount_yen, 0) };
  });

  app.post('/api/books/claims/:claimId/unpay', async (request) => {
    const user = editor(request);
    const { claimId } = deps.parse(claimParams, request.params);
    const body = deps.parse(z.strictObject({ expectedVersion: version, note }), request.body);
    const text = checked(() => validateNote(body.note, '取り消しの理由'));
    const row = checked(() => store.unpayClaim(claimId, body.expectedVersion, text, user.id, deps.clock()));
    if (!row) throw notFound();
    changed();
    return { claim: claimOf(row, user.id) };
  });

  // ---- receipts (領収書): on a claim (its member while it can still change, or the accounting section) or a journal

  const receiptWriter = (user: User, ownerKind: 'claim' | 'journal', ownerId: string) => {
    if (ownerKind === 'journal') {
      if (!can(user, 'accounting.confirm')) throw new DomainError('forbidden', '帳簿を付ける権限がありません。');
      if (!store.journal(ownerId)) throw notFound();
      return;
    }
    const row = claimRow(ownerId);
    const own = row.claimant_id === user.id && (row.state === 'submitted' || row.state === 'rejected');
    if (!own && !can(user, 'accounting.confirm')) {
      if (row.claimant_id !== user.id && !can(user, 'accounting.view')) throw notFound();
      throw new DomainError('forbidden', '確認が済んだ申請の領収書は、会計課だけが付け外しできます。');
    }
  };

  void app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: BOOKS_LIMITS.receiptBytes, files: 1, fields: 0, parts: 1 } });
    const upload = async (request: FastifyRequest): Promise<{ name: string; data: Buffer }> => {
      if (!request.isMultipart()) throw new DomainError('validation', 'multipart/form-data の形式で送ってください。');
      let file: { name: string; data: Buffer } | null = null;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file' && !file) file = { name: part.filename ?? '', data: await part.toBuffer() };
          else if (part.type === 'file') await part.toBuffer();
        }
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') throw new DomainError('validation', `ファイルが大きすぎます（${BOOKS_LIMITS.receiptBytes / 1024 / 1024} MB まで）。`, { field: 'file' });
        throw new DomainError('validation', 'ファイルを読み取れませんでした。もう一度選んでください。', { field: 'file' });
      }
      if (!file || file.data.length === 0) throw new DomainError('validation', 'ファイルを選んでください。', { field: 'file' });
      return file;
    };

    for (const ownerKind of ['claim', 'journal'] as const) {
      const route = ownerKind === 'claim' ? '/api/books/claims/:claimId/receipts' : '/api/books/journals/:journalId/receipts';
      scope.post(route, { bodyLimit: BOOKS_LIMITS.receiptBytes + 64 * 1024 }, async (request, reply) => {
        const user = member(request);
        const ownerId = ownerKind === 'claim' ? deps.parse(claimParams, request.params).claimId : deps.parse(journalParams, request.params).journalId;
        receiptWriter(user, ownerKind, ownerId);
        const file = await upload(request);
        const type = sniffReceiptType(file.data);
        if (!type) throw new DomainError('validation', '領収書は写真（JPEG・PNG・WebP）か PDF にしてください。', { field: 'file' });
        const row = checked(() => store.addReceipt(ownerKind, ownerId, { name: receiptName(file.name, type), type, data: file.data }, BOOKS_LIMITS.receipts, user.id, deps.clock()));
        changed();
        return reply.code(201).send({ receipt: { id: row.id, name: row.name, type: row.type, bytes: row.bytes, uploadedAt: row.uploaded_at } });
      });
    }

    /** 弥生's files: the journals (仕訳) or the opening balances (期首残高). Read twice: a look first, then the import. */
    scope.post('/api/books/yayoi/import', { bodyLimit: 5 * 1024 * 1024 + 64 * 1024 }, async (request): Promise<YayoiImportResponse> => {
      const user = editor(request);
      const q = deps.parse(z.strictObject({ kind: z.enum(['journals', 'openings']), dryRun: z.enum(['1', '0']), planToken: z.string().regex(/^[0-9a-f]{64}$/).optional() }), request.query);
      if (!request.isMultipart()) throw new DomainError('validation', 'multipart/form-data の形式で送ってください。');
      let data: Buffer | null = null;
      let name = '';
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file' && !data) {
            data = await part.toBuffer();
            name = part.filename ?? '';
          } else if (part.type === 'file') await part.toBuffer();
        }
      } catch {
        throw new DomainError('validation', 'ファイルが大きすぎるか、読み取れませんでした（5 MB まで）。', { field: 'file' });
      }
      if (!data || data.length === 0) throw new DomainError('validation', '弥生から書き出したファイルを選んでください。', { field: 'file' });
      return q.kind === 'journals' ? importJournals(user, data, name, q.dryRun === '1', q.planToken) : importOpenings(user, data, name, q.dryRun === '1', q.planToken);
    });
  });

  app.get('/api/books/receipts/:receiptId', async (request, reply: FastifyReply) => {
    const user = member(request);
    const { receiptId } = deps.parse(receiptParams, request.params);
    const row = store.receipt(receiptId);
    if (!row || row.removed_at !== null) throw notFound();
    if (row.owner_kind === 'claim') {
      const c = store.claim(row.owner_id);
      if (!c || (c.claimant_id !== user.id && !can(user, 'accounting.view'))) throw notFound();
    } else if (!can(user, 'accounting.view')) throw notFound();
    let data: Buffer;
    try {
      data = store.receiptFile(row);
    } catch {
      throw new DomainError('not_found', '領収書のファイルが見つかりません。システム課に連絡してください。');
    }
    reply.header('Content-Type', row.type);
    reply.header('Content-Disposition', attachmentDisposition(row.name, 'receipt').replace(/^attachment/, 'inline'));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(data);
  });

  app.post('/api/books/receipts/:receiptId/remove', async (request) => {
    const user = member(request);
    const { receiptId } = deps.parse(receiptParams, request.params);
    const row = store.receipt(receiptId);
    if (!row || row.removed_at !== null) throw notFound();
    receiptWriter(user, row.owner_kind, row.owner_id);
    store.removeReceipt(receiptId, user.id, deps.clock());
    changed();
    return { removed: true };
  });

  // ---- budget and opening balances

  app.get('/api/books/budget', async (request) => {
    viewer(request);
    const q = deps.parse(yearQuery, request.query);
    const fiscalYear = q.fiscalYear ?? thisYear();
    const b = books();
    const names = [...new Map([...b.accounts.values()].filter((a) => a.kind === 'income' || a.kind === 'expense').map((a) => [a.name, { name: a.name, kind: a.kind, group: a.grp, active: a.active === 1 }])).values()];
    return { fiscalYear, rows: budgetRows(b, accountTotals(store, fiscalYear), store.budget(fiscalYear)), lines: store.budget(fiscalYear).map((l) => ({ accountName: l.account_name, amountYen: l.amount_yen })), accountNames: names };
  });

  app.put('/api/books/budget', async (request) => {
    const user = editor(request);
    const body = deps.parse(z.strictObject({ fiscalYear: z.number().int().min(BOOKS_LIMITS.fiscalYearMin).max(BOOKS_LIMITS.fiscalYearMax), lines: z.unknown() }), request.body);
    const lines = checked(() => validateBudget(body.lines));
    const known = new Set(store.accounts().filter((a) => a.kind === 'income' || a.kind === 'expense').map((a) => a.name));
    const unknown = lines.find((l) => !known.has(l.accountName));
    if (unknown) throw new DomainError('validation', `「${unknown.accountName}」という収入・支出の科目がありません。`);
    store.setBudget(body.fiscalYear, lines, user.id, deps.clock());
    changed();
    return { fiscalYear: body.fiscalYear, rows: budgetRows(books(), accountTotals(store, body.fiscalYear), store.budget(body.fiscalYear)) };
  });

  app.get('/api/books/openings', async (request): Promise<{ fiscalYear: number; rows: OpeningRow[] }> => {
    viewer(request);
    const q = deps.parse(yearQuery, request.query);
    const fiscalYear = q.fiscalYear ?? thisYear();
    const b = books();
    return {
      fiscalYear,
      rows: store.openings(fiscalYear).map((o) => {
        const a = b.accounts.get(o.account_id);
        return { accountId: o.account_id, title: a ? accountView(a, new Set()).title : '（不明な科目）', kind: a?.kind ?? 'asset', amountYen: o.amount_yen };
      }),
    };
  });

  app.put('/api/books/openings', async (request) => {
    const user = editor(request);
    const body = deps.parse(
      z.strictObject({
        fiscalYear: z.number().int().min(BOOKS_LIMITS.fiscalYearMin).max(BOOKS_LIMITS.fiscalYearMax),
        rows: z.array(z.strictObject({ accountId: z.string().regex(ACCOUNT_ID), amountYen: z.number().int().min(-BOOKS_LIMITS.amountMax).max(BOOKS_LIMITS.amountMax) })).max(500),
      }),
      request.body,
    );
    if (body.rows.some((r) => !store.account(r.accountId))) throw new DomainError('validation', '見つからない科目があります。読み直してください。');
    if (new Set(body.rows.map((r) => r.accountId)).size !== body.rows.length) throw new DomainError('validation', '同じ科目が 2 回あります。');
    const total = body.rows.reduce((s, r) => s + r.amountYen, 0);
    if (total !== 0) throw new DomainError('validation', `借方と貸方の期首残高が合いません（差 ${yen(Math.abs(total))}）。繰越利益などで合わせてください。`);
    store.setOpenings(body.fiscalYear, body.rows, user.id, deps.clock());
    changed();
    return { saved: true };
  });

  // ---- the deposits the payments screen confirmed (入金確認との連動)

  const linked = () => store.depositLinks();
  const depositsToBook = (): DepositToBook[] => {
    const payments = deps.payments;
    if (!payments) return [];
    const byKind = store.setting<Record<string, string | null>>('depositAccountByKind', {});
    const links = linked();
    const confirmed = payments.confirmedDeposits();
    const live = new Set(confirmed.map((d) => d.deposit_id));
    const out: DepositToBook[] = confirmed.map((d) => {
      const org = deps.organizations?.get(d.org_id) ?? null;
      const kind = org?.data.kind ?? 'other';
      const link = links.get(d.deposit_id);
      return {
        depositId: d.deposit_id,
        bookedOn: d.booked_on,
        description: d.description,
        amountYen: d.amount_yen,
        invoiceNumber: d.number,
        orgName: org?.data.name ?? d.org_name,
        orgKind: kind,
        orgKindLabel: ORG_KIND_LABELS[kind as keyof typeof ORG_KIND_LABELS] ?? kind,
        suggestedAccountId: byKind[kind] ?? null,
        journalId: link?.journal_id ?? null,
        unconfirmedSince: false,
      };
    });
    // Booked from a deposit whose confirmation was taken back since: the journal needs a look.
    for (const [depositId, link] of links) {
      if (live.has(depositId) || !link.journal_id) continue;
      const j = store.journal(link.journal_id);
      if (!j || j.voided === 1) continue;
      out.push({ depositId, bookedOn: j.date, description: j.memo, amountYen: 0, invoiceNumber: '', orgName: j.counterparty, orgKind: '', orgKindLabel: '', suggestedAccountId: null, journalId: j.id, unconfirmedSince: true });
    }
    return out;
  };

  app.get('/api/books/deposits', async (request) => {
    viewer(request);
    const links = linked();
    const all = depositsToBook();
    return {
      paymentsAvailable: deps.payments !== null,
      toBook: all.filter((d) => d.journalId === null && !links.has(d.depositId)),
      booked: all.filter((d) => d.journalId !== null && !d.unconfirmedSince).map((d) => ({ ...d, journalNumber: journalNumber(store.journal(d.journalId!)?.seq ?? 0) })),
      markedElsewhere: all.filter((d) => d.journalId === null && links.has(d.depositId)).map((d) => ({ ...d, note: links.get(d.depositId)?.note ?? '' })),
      takenBack: all.filter((d) => d.unconfirmedSince).map((d) => ({ ...d, journalNumber: journalNumber(store.journal(d.journalId!)?.seq ?? 0) })),
      settings: settings(),
      moneyAccounts: accountViews().filter((a) => a.active && a.money),
      incomeAccounts: accountViews().filter((a) => a.active && a.kind === 'income'),
    };
  });

  app.post('/api/books/deposits/book', async (request) => {
    const user = editor(request);
    const body = deps.parse(
      z.strictObject({ items: z.array(z.strictObject({ depositId: z.string().regex(/^dp_[0-9a-f]{16}$/), moneyAccountId: z.string().regex(ACCOUNT_ID), accountId: z.string().regex(ACCOUNT_ID) })).min(1).max(200) }),
      request.body,
    );
    const confirmed = new Map(depositsToBook().filter((d) => !d.unconfirmedSince).map((d) => [d.depositId, d]));
    const now = deps.clock();
    let booked = 0;
    for (const item of body.items) {
      const d = confirmed.get(item.depositId);
      if (!d) throw new DomainError('conflict', '入金確認で確定されていない入金があります。読み直してください。');
      const money = store.account(item.moneyAccountId);
      const income = store.account(item.accountId);
      if (!money || money.money !== 1 || money.active !== 1) throw new DomainError('validation', '入金した口座を選び直してください。');
      if (!income || income.money === 1 || income.active !== 1) throw new DomainError('validation', '科目を選び直してください。');
      checked(() => store.linkDeposit(item.depositId, () => depositJournal(d, money, income, yearOf(d.bookedOn)), '', user.id, now));
      booked += 1;
    }
    changed();
    return { booked };
  });

  app.post('/api/books/deposits/mark', async (request) => {
    const user = editor(request);
    const body = deps.parse(z.strictObject({ depositId: z.string().regex(/^dp_[0-9a-f]{16}$/), note }), request.body);
    const text = checked(() => validateNote(body.note, 'メモ'));
    if (!depositsToBook().some((d) => d.depositId === body.depositId && !d.unconfirmedSince)) throw new DomainError('conflict', '入金確認で確定されていない入金です。読み直してください。');
    checked(() => store.linkDeposit(body.depositId, null, text || '別に記帳済み（弥生など）', user.id, deps.clock()));
    changed();
    return { marked: true };
  });

  app.post('/api/books/deposits/unmark', async (request) => {
    const user = editor(request);
    const body = deps.parse(z.strictObject({ depositId: z.string().regex(/^dp_[0-9a-f]{16}$/) }), request.body);
    if (!store.unlinkDeposit(body.depositId, user.id, deps.clock())) throw new DomainError('conflict', 'この入金に「別に記帳済み」の印はありません。読み直してください。');
    changed();
    return { unmarked: true };
  });

  // ---- 弥生: send the journals made here; read 弥生's journals and opening balances

  const exportPlan = (fiscalYear: number, to: string | null): YayoiExportPlan & { journals: ReturnType<BooksStore['unexported']> } => {
    const journals = store.unexported(fiscalYear, to);
    const b = books();
    const lines = store.linesOf(journals.map((j) => j.id));
    const bad: YayoiExportPlan['unencodable'] = [];
    let rows = 0;
    for (const j of journals) {
      const e = exportJournal(b, j, lines.get(j.id) ?? []);
      rows += Math.max(e.lines.filter((l) => l.side === 'debit').length, e.lines.filter((l) => l.side === 'credit').length);
      const fields: [string, string][] = [
        ['摘要', e.memo],
        ...e.lines.flatMap((l): [string, string][] => [
          ['科目', l.account + l.sub],
          ['取引先', l.partner],
          ['税区分', l.taxClass],
        ]),
      ];
      for (const [field, text] of fields) {
        const chars = unencodable(text);
        if (chars.length > 0) bad.push({ number: journalNumber(j.seq), field, chars: chars.join('') });
      }
    }
    return {
      fiscalYear,
      count: journals.length,
      rows,
      changed: store.changedAfterExport().map((j) => ({ id: j.id, number: journalNumber(j.seq), date: j.date, amountYen: (store.lines(j.id).filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount_yen, 0)) })),
      unencodable: bad,
      batches: store.exports().map((x) => ({ id: x.id, at: x.at, actorName: nameOf(x.actor_id), count: x.count, from: x.date_from, to: x.date_to })),
      journals,
    };
  };

  app.get('/api/books/yayoi/plan', async (request): Promise<YayoiExportPlan> => {
    editor(request);
    const q = deps.parse(planQuery, request.query);
    const { journals: _journals, ...plan } = exportPlan(q.fiscalYear ?? thisYear(), q.to ?? null);
    void _journals;
    return plan;
  });

  app.post('/api/books/yayoi/export', async (request) => {
    const user = editor(request);
    const body = deps.parse(z.strictObject({ fiscalYear: z.number().int().min(BOOKS_LIMITS.fiscalYearMin).max(BOOKS_LIMITS.fiscalYearMax), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), expectedCount: z.number().int().min(1) }), request.body);
    const plan = exportPlan(body.fiscalYear, body.to ?? null);
    if (plan.count === 0) throw new DomainError('validation', '弥生へ書き出す仕訳がありません（すべて書き出し済みです）。');
    if (plan.count !== body.expectedCount) throw new DomainError('conflict', '書き出す仕訳の数が変わりました（ほかの人が記帳しました）。読み直してから、もう一度書き出してください。');
    if (plan.unencodable.length > 0) throw new DomainError('validation', `弥生が読めない文字があります（${plan.unencodable.map((u) => `${u.number} の${u.field}「${u.chars}」`).join('、')}）。仕訳を直してから書き出してください。`);
    if (plan.rows > BOOKS_LIMITS.yayoiRows) throw new DomainError('validation', `一度に書き出せるのは ${BOOKS_LIMITS.yayoiRows} 行までです。日付で区切って書き出してください。`);
    const b = books();
    const lines = store.linesOf(plan.journals.map((j) => j.id));
    const csv = encodeShiftJis(yayoiCsv(plan.journals.map((j) => exportJournal(b, j, lines.get(j.id) ?? []))));
    const dates = plan.journals.map((j) => j.date).sort();
    const id = store.recordExport(body.fiscalYear, plan.journals.map((j) => j.id), { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null }, csv, user.id, deps.clock());
    changed();
    return { exportId: id, count: plan.count };
  });

  app.get('/api/books/yayoi/exports/:exportId', async (request, reply: FastifyReply) => {
    editor(request);
    const { exportId } = deps.parse(exportParams, request.params);
    const file = store.exportFile(exportId);
    if (!file) throw notFound();
    const stamp = file.at.replace(/[^0-9]/g, '').slice(0, 14);
    reply.header('Content-Type', 'text/csv; charset=shift_jis');
    reply.header('Content-Disposition', attachmentDisposition(`弥生取込用_仕訳_${stamp}.csv`, `yayoi_${stamp}.csv`));
    reply.header('Cache-Control', 'no-store');
    return reply.send(file.csv);
  });

  const planToken = (data: Buffer, plan: unknown) => createHash('sha256').update(data).update(JSON.stringify(plan)).digest('hex');

  function importJournals(user: User, data: Buffer, name: string, dryRun: boolean, token: string | undefined): YayoiImportResponse {
    const parsed = parseYayoiJournals(data);
    const rows: YayoiImportRow[] = parsed.problems.map((p) => ({ line: p.line, action: 'unreadable', date: null, amountYen: null, memo: '', reason: p.reason }));
    const known = store.journalsByYayoiKey(parsed.journals.map((j) => j.key));
    const seen = new Set<string>();
    const newAccounts = new Map<string, { name: string; sub: string; kind: ReturnType<typeof guessAccount> }>();
    type Work = { j: (typeof parsed.journals)[number]; action: 'new' | 'changed' | 'ours'; target: string | null };
    const work: Work[] = [];
    for (const j of parsed.journals) {
      const amount = j.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amountYen, 0);
      const row = (action: YayoiImportRow['action'], reason: string) => rows.push({ line: j.line, action, date: j.date, amountYen: amount, memo: j.memo, reason });
      if (seen.has(j.key)) {
        row('duplicate', 'ファイルの中で同じ仕訳が 2 回あります');
        continue;
      }
      seen.add(j.key);
      if (j.ours) {
        const mine = store.journalBySeq(Number(j.ours.slice(2)));
        if (mine) {
          row('ours', `基盤から書き出した ${j.ours}（弥生の伝票 ${j.yayoiNo || '番号なし'}）`);
          work.push({ j, action: 'ours', target: mine.id });
          continue;
        }
      }
      const existing = known.get(j.key);
      if (existing) {
        const sameContent = existing.source === 'yayoi' && store.meta(`yayoi.digest.${existing.id}`) === j.digest;
        if (sameContent || existing.source !== 'yayoi') {
          row('duplicate', '取り込み済み');
          continue;
        }
        row('new', `弥生で変わった仕訳（${journalNumber(existing.seq)} を弥生に合わせて変えます）`);
        work.push({ j, action: 'changed', target: existing.id });
      } else {
        row('new', '');
        work.push({ j, action: 'new', target: null });
      }
      for (const l of j.lines) {
        if (!store.accountByName(l.account, l.sub)) newAccounts.set(`${l.account}\u001f${l.sub}`, { name: l.account, sub: l.sub, kind: guessAccount(l.account) });
      }
    }
    rows.sort((a, b) => a.line - b.line);
    const counts = { new: 0, duplicate: 0, ours: 0, unreadable: 0 } as YayoiImportResponse['counts'];
    for (const r of rows) counts[r.action] += 1;
    const accountsOut = [...newAccounts.values()].map((a) => ({ name: a.name, sub: a.sub, kind: a.kind?.kind ?? null }));
    const plan = { counts, accounts: accountsOut, keys: work.map((w) => `${w.action}:${w.j.key}`) };
    const tokenNow = planToken(data, plan);
    if (dryRun) return { dryRun: true, counts, rows, newAccounts: accountsOut, planToken: tokenNow, encoding: parsed.encoding };
    if (token !== tokenNow) throw new DomainError('conflict', '下見のあとで帳簿かファイルが変わりました。もう一度「下見を見る」から進めてください。');
    const unknownKind = accountsOut.filter((a) => a.kind === null);
    if (unknownKind.length > 0) {
      throw new DomainError('validation', `種類が分からない科目があります（${unknownKind.map((a) => a.name).join('、')}）。先に科目の設定で、この名前の科目を種類を選んで足してから取り込んでください。`);
    }
    const now = deps.clock();
    let added = 0;
    let changedCount = 0;
    store.tx(() => {
      const accountId = (nameText: string, sub: string): string => {
        const found = store.accountByName(nameText, sub);
        if (found) return found.id;
        const g = guessAccount(nameText)!;
        return store.insertAccount({ name: nameText, sub, kind: g.kind, group: g.group, money: g.money, label: '', taxClass: '対象外', active: true }, user.id, now).id;
      };
      // An account met first in 弥生's file takes the tax class 弥生 uses most for it.
      const taxVotes = new Map<string, Map<string, number>>();
      for (const w of work) {
        if (w.action === 'ours') {
          store.setYayoiNo(w.target!, w.j.yayoiNo, w.j.key);
          continue;
        }
        const lines: NewLine[] = w.j.lines.map((l) => {
          const id = accountId(l.account, l.sub);
          const votes = taxVotes.get(id) ?? new Map<string, number>();
          votes.set(l.taxClass, (votes.get(l.taxClass) ?? 0) + 1);
          taxVotes.set(id, votes);
          return { side: l.side, accountId: id, amountYen: l.amountYen, taxClass: l.taxClass, department: l.department, partner: l.partner };
        });
        const nj: NewJournal = {
          date: w.j.date,
          fiscalYear: yearOf(w.j.date),
          form: lines.length === 2 ? 'journal' : 'compound',
          entry: null,
          counterparty: w.j.lines.find((l) => l.partner)?.partner ?? '',
          memo: w.j.memo,
          department: '',
          source: 'yayoi',
          sourceRef: null,
          claimId: null,
          yayoiNo: w.j.yayoiNo,
          yayoiKey: w.j.key,
          sticky: w.j.sticky,
          lines,
        };
        if (w.action === 'changed') {
          store.replaceFromYayoi(w.target!, nj, user.id, now);
          store.setMeta(`yayoi.digest.${w.target}`, w.j.digest);
          changedCount += 1;
        } else {
          const row = store.insertJournal(nj, null, user.id, now, true);
          store.setMeta(`yayoi.digest.${row.id}`, w.j.digest);
          added += 1;
        }
      }
      for (const [id, votes] of taxVotes) {
        const a = store.account(id);
        if (!a || a.created_at !== now) continue;
        const best = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
        if (best) store.db.prepare('UPDATE accounts SET tax_class=? WHERE id=?').run(best, id);
      }
      store.recordYayoiImport('journals', name.slice(0, 120), added, changedCount, user.id, now);
      store.bumpRevision();
    });
    changed();
    return { dryRun: false, counts, rows, newAccounts: accountsOut, planToken: tokenNow, encoding: parsed.encoding };
  }

  function importOpenings(user: User, data: Buffer, name: string, dryRun: boolean, token: string | undefined): YayoiImportResponse {
    const parsed = parseYayoiOpenings(data);
    const rows: YayoiImportRow[] = parsed.problems.map((p) => ({ line: p.line, action: 'unreadable', date: null, amountYen: null, memo: '', reason: p.reason }));
    const newAccounts = new Map<string, { name: string; sub: string; kind: ReturnType<typeof guessAccount> }>();
    for (const r of parsed.rows) {
      rows.push({ line: r.line, action: 'new', date: r.date, amountYen: r.amountYen, memo: `${r.account}${r.sub ? `（${r.sub}）` : ''}`, reason: r.amountYen === 0 ? '残高 0（入れません）' : '' });
      if (!store.accountByName(r.account, r.sub)) newAccounts.set(`${r.account}\u001f${r.sub}`, { name: r.account, sub: r.sub, kind: guessAccount(r.account) });
    }
    rows.sort((a, b) => a.line - b.line);
    const counts = { new: 0, duplicate: 0, ours: 0, unreadable: 0 } as YayoiImportResponse['counts'];
    for (const r of rows) counts[r.action] += 1;
    const accountsOut = [...newAccounts.values()].map((a) => ({ name: a.name, sub: a.sub, kind: a.kind?.kind ?? null }));
    const total = parsed.rows.reduce((s, r) => s + r.amountYen, 0);
    const plan = { counts, accounts: accountsOut, total, rows: parsed.rows.map((r) => [r.account, r.sub, r.amountYen]) };
    const tokenNow = planToken(data, plan);
    if (dryRun) return { dryRun: true, counts, rows, newAccounts: accountsOut, planToken: tokenNow, encoding: parsed.encoding };
    if (token !== tokenNow) throw new DomainError('conflict', '下見のあとで帳簿かファイルが変わりました。もう一度「下見を見る」から進めてください。');
    if (parsed.rows.length === 0) throw new DomainError('validation', '期首残高の行がありません。');
    if (total !== 0) throw new DomainError('validation', `借方と貸方の期首残高が合いません（差 ${yen(Math.abs(total))}）。弥生から書き出し直してください。`);
    const unknownKind = accountsOut.filter((a) => a.kind === null);
    if (unknownKind.length > 0) throw new DomainError('validation', `種類が分からない科目があります（${unknownKind.map((a) => a.name).join('、')}）。先に科目の設定で足してから取り込んでください。`);
    const fiscalYear = yearOf(parsed.rows[0]!.date);
    const now = deps.clock();
    store.tx(() => {
      const out: { accountId: string; amountYen: number }[] = [];
      const sums = new Map<string, number>();
      for (const r of parsed.rows) {
        let a = store.accountByName(r.account, r.sub);
        if (!a) {
          const g = guessAccount(r.account)!;
          a = store.insertAccount({ name: r.account, sub: r.sub, kind: g.kind, group: g.group, money: g.money, label: '', taxClass: '対象外', active: true }, user.id, now);
        }
        sums.set(a.id, (sums.get(a.id) ?? 0) + r.amountYen);
      }
      for (const [accountId, amountYen] of sums) out.push({ accountId, amountYen });
      store.setOpenings(fiscalYear, out, user.id, now, true);
      store.recordYayoiImport('openings', name.slice(0, 120), out.filter((o) => o.amountYen !== 0).length, 0, user.id, now);
    });
    changed();
    return { dryRun: false, counts, rows, newAccounts: accountsOut, planToken: tokenNow, encoding: parsed.encoding };
  }

  app.get('/api/books/yayoi/imports', async (request) => {
    editor(request);
    return { imports: store.yayoiImports().map((i) => ({ id: i.id, at: i.at, actorName: nameOf(i.actor_id), label: i.label, kind: i.kind, added: i.added, changed: i.changed })) };
  });

  // ---- the spreadsheet

  app.get('/api/books/sheets', async (request): Promise<SheetsStatus> => {
    viewer(request);
    return sheetsStatus();
  });

  app.post('/api/books/sheets/sync', async (request): Promise<SheetsStatus> => {
    editor(request);
    if (!sheets) throw new DomainError('validation', 'スプレッドシートの設定（books-sheets.json）がありません。システム課に依頼してください。');
    await sheets.run();
    return sheetsStatus();
  });
}
