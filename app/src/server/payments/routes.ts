import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { compareDepartments } from '../../shared/departments.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import { ORG_KIND_LABELS, ORG_STAGES, orgNameKey, statusAllowed, type OrgPaymentCause, type OrgPaymentDetail } from '../../shared/organizations.js';
import {
  ACCOUNTING_PERMISSIONS,
  CANDIDATES_MAX,
  depositKey,
  normalizePayerName,
  PAYMENT_LIMITS,
  PaymentValidationError,
  rankDepositsFor,
  rankInvoicesFor,
  readStatementRow,
  tokyoDate,
  validateInvoice,
  validateNote,
  yen,
  type AccountingAccessResponse,
  type AccountingPermission,
  type AllocationView,
  type ConfirmResponse,
  type DepositDetailResponse,
  type DepositView,
  type InvoiceDetailResponse,
  type InvoiceView,
  type OrgPaymentStatus,
  type PaymentHistoryView,
  type PaymentsMe,
  type PaymentsOverview,
  type RankDeposit,
  type RankInvoice,
  type StatementImportResponse,
  type StatementPlanRow,
} from '../../shared/payments.js';
import { committeeMember, type ContactRouteDeps } from '../contacts/routes.js';
import type { ContactsStore } from '../contacts/store.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { attachmentDisposition } from '../http/content-disposition.js';
import { HttpError } from '../http/http-error.js';
import type { OrganizationsStore } from '../organizations/store.js';
import { PaymentRefused, stateOf, type DepositRow, type HistoryRow, type InvoiceRow, type NewDeposit, type PaymentsStore, type WriteRefusal } from './store.js';

// Payments (入金確認, 2026-11-03), at /api/payments next to the organizations (the committee mailbox's people and
// sign-in). Permissions, checked on the server for every request:
// - a committee member (not temporary staff) sees only whether an organization is paid (GET .../organizations/:id);
// - accounting.view: the invoices, the deposits, the candidates, the history and the CSV export;
// - accounting.confirm: making and changing invoices, importing statements, confirming and taking back payments;
// - access administrators give the two permissions to members and departments (会計課).
// The bank statement is sensitive: nothing here logs an amount or a name (the app's logger is off), and the payer's
// name never goes into the organization's history, which every member reads (its amounts, days and invoice numbers
// only with accounting.view: see paymentsVisible of the organization routes).

export interface PaymentRouteDeps extends ContactRouteDeps {
  organizations: OrganizationsStore | null;
  contacts: ContactsStore | null;
  now: () => number;
}

const PAID_STAGE = '入金済み';
const invoiceParams = z.strictObject({ invoiceId: z.string().regex(/^iv_[0-9a-f]{16}$/) });
const depositParams = z.strictObject({ depositId: z.string().regex(/^dp_[0-9a-f]{16}$/) });
const importParams = z.strictObject({ importId: z.string().regex(/^si_[0-9a-f]{16}$/) });
const orgParams = z.strictObject({ orgId: z.string().regex(/^og_[0-9a-f]{16}$/) });
const yearQuery = z.strictObject({ fiscalYear: z.coerce.number().int().min(PAYMENT_LIMITS.fiscalYearMin).max(PAYMENT_LIMITS.fiscalYearMax).optional() });
const exportQuery = z.strictObject({ fiscalYear: yearQuery.shape.fiscalYear, what: z.enum(['invoices', 'deposits']).default('invoices') });
const createBody = z.strictObject({ clientToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), invoice: z.unknown(), allowAnother: z.boolean().optional() });
const updateBody = z.strictObject({ expectedVersion: z.number().int().min(1), invoice: z.unknown() });
const versionBody = z.strictObject({ expectedVersion: z.number().int().min(1) });
const voidBody = z.strictObject({ expectedVersion: z.number().int().min(1), note: z.string().max(PAYMENT_LIMITS.note * 2).optional() });
const depositIds = z.array(depositParams.shape.depositId).max(PAYMENT_LIMITS.confirmMax);
const confirmBody = z.strictObject({
  expectedVersion: z.number().int().min(1),
  depositIds,
  /** Close a shortfall (a transfer fee taken off, for example) with a note. */
  acceptShort: z.strictObject({ note: z.string().max(PAYMENT_LIMITS.note * 2) }).nullable().optional(),
});
const unconfirmBody = z.strictObject({ expectedVersion: z.number().int().min(1), depositIds });
const excludeBody = z.strictObject({ excluded: z.boolean(), note: z.string().max(PAYMENT_LIMITS.note * 2).optional() });
const cell = z.string().max(PAYMENT_LIMITS.statementCell * 2);
const importBody = z.strictObject({
  dryRun: z.boolean(),
  label: z.string().max(200).optional(),
  rows: z
    .array(z.strictObject({ line: z.number().int().min(1).max(1_000_000), date: cell, description: cell, deposit: cell, withdrawal: cell, balance: cell }))
    .min(1)
    .max(PAYMENT_LIMITS.statementRows),
  planToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
// eslint-disable-next-line no-control-regex
const department = z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f・]+$/);
const accessBody = z
  .strictObject({
    expectedRevision: z.number().int().min(0),
    userId: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
    department: department.optional(),
    permission: z.enum(ACCOUNTING_PERMISSIONS),
    on: z.boolean(),
  })
  .refine((b) => (b.userId === undefined) !== (b.department === undefined), { message: 'userId か department のどちらか 1 つを指定してください' });

// eslint-disable-next-line no-control-regex
const LABEL_CONTROL = /[\u0000-\u001f\u007f]/g;

const REFUSALS: Record<WriteRefusal, { code: 'conflict' | 'validation'; message: string }> = {
  conflict: { code: 'conflict', message: 'ほかの人が先にこの請求を変更しました。最新の内容を読み込み直してから、もう一度操作してください。' },
  void: { code: 'conflict', message: 'この請求は取り消されています。先に「取り消しを戻す」を押してください。' },
  not_void: { code: 'conflict', message: 'この請求は取り消されていません。読み直してください。' },
  has_payments: { code: 'conflict', message: '確定した入金がある請求は取り消せません。先に入金の確定を外してください。' },
  number_taken: { code: 'conflict', message: 'この請求番号は同じ年度にもうあります。別の番号にするか、空にして自動の番号にしてください。' },
  deposit_taken: { code: 'conflict', message: '選んだ入金は、ほかの請求に充てられています（1 つの入金は 1 つの請求にだけ充てられます）。' },
  // A conflict (409): someone set the deposit aside or took its import back since the screen was read; it reloads.
  deposit_unusable: { code: 'conflict', message: '選んだ入金が見つからないか、ほかの人が照合の対象外にしたか取り込みを取り消しました。' },
  nothing_to_confirm: { code: 'validation', message: '確定する入金を選んでください。' },
  not_allocated: { code: 'conflict', message: 'その入金はこの請求に充てられていません。読み直してください。' },
};

const FIELD_LABELS: Record<string, string> = { number: '請求番号', amountYen: '請求額', issuedOn: '請求日', dueOn: '支払の期限', payerKana: '振込名義', memo: 'メモ' };

/** Input errors and refused writes as the API's answers. */
function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PaymentValidationError) throw new DomainError('validation', err.message, { field: err.field });
    if (err instanceof PaymentRefused) {
      const r = REFUSALS[err.reason];
      throw new DomainError(r.code, r.message);
    }
    throw err;
  }
}

/** A spreadsheet cell: quoted, and a leading =, +, -, @ (also full-width) made plain text so a spreadsheet never runs it. */
function csvText(value: string): string {
  const safe = /^[=+\-@\t\r＝＋－＠]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
/** Amounts are written as plain digits (never negative: 過払い and 不足 have columns of their own). */
const csvNumber = (value: number | null) => (value === null ? '""' : String(value));

/** The sentence of one history row, for the screen (amounts and dates only; never a payer's name). */
function historyText(h: HistoryRow): string {
  const d = h.detail ?? {};
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (h.action) {
    case 'invoice_created':
      return `請求を作りました（${s('number')}・${yen(n('amountYen'))}）`;
    case 'invoice_updated':
      return `請求を変えました（${(Array.isArray(d.changed) ? (d.changed as string[]) : []).map((k) => FIELD_LABELS[k] ?? k).join('・')}）`;
    case 'invoice_voided':
      return `請求を取り消しました${s('note') ? `（${s('note')}）` : ''}`;
    case 'invoice_restored':
      return '請求の取り消しを戻しました';
    case 'confirmed':
      if (h.subject === 'deposit') return `請求 ${s('number')} の入金として確定しました`;
      return [
        (Array.isArray(d.depositIds) ? (d.depositIds as unknown[]).length : 0) > 0 ? `入金を確認しました（${yen(n('amountYen'))}・${s('lastOn')}）` : '',
        d.acceptShort === true ? `不足を認めて入金済みにしました${s('note') ? `（${s('note')}）` : ''}` : '',
      ]
        .filter(Boolean)
        .join('。');
    case 'unconfirmed':
      if (h.subject === 'deposit') return `請求 ${s('number')} から外しました`;
      return [n('amountYen') > 0 ? `入金の確定を外しました（${yen(n('amountYen'))}）` : '', d.shortTakenBack === true ? '不足の承認を外しました' : ''].filter(Boolean).join('。');
    case 'deposit_excluded':
      return `照合の対象外にしました${s('note') ? `（${s('note')}）` : ''}`;
    case 'deposit_included':
      return '照合の対象に戻しました';
    case 'statement_imported':
      return `明細を取り込みました（${n('added')} 件）`;
    case 'import_removed':
      return '取り込みを取り消しました';
  }
}

/** The accounting permissions a person holds now. Temporary staff and disabled accounts hold nothing, whatever was granted. */
export function accountingPermissionsOf(store: PaymentsStore, user: User): AccountingPermission[] {
  const departments = departmentsOfLabel(user.roleLabel);
  if (user.disabled || isTemporaryStaffLoginId(user.id) || departments.includes(TEMPORARY_STAFF_DEPARTMENT)) return [];
  return store.permissionsOf(user.id, departments);
}

/**
 * `opened` is null when payments.sqlite3 could not be opened: the routes then answer 503 and the rest of the mail
 * folder (mail, contacts, organizations) keeps working.
 */
export function registerPaymentRoutes(app: FastifyInstance, opened: PaymentsStore | null, deps: PaymentRouteDeps): void {
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
      throw new HttpError(503, { error: 'payments_unavailable', message: '会計の保存ファイルを開けませんでした。システム課に連絡してください（団体やメールなどほかの機能は使えます）。' });
    };
    app.all('/api/payments', unavailable);
    app.all('/api/payments/*', unavailable);
    return;
  }
  const store = opened;
  const orgs = deps.organizations;
  const contacts = deps.contacts;

  const departmentsOf = (user: User) => departmentsOfLabel(user.roleLabel).filter((d) => d !== TEMPORARY_STAFF_DEPARTMENT);
  const permissions = (user: User): AccountingPermission[] => accountingPermissionsOf(store, user);
  const viewer = (request: FastifyRequest): User => {
    const user = member(request);
    if (!permissions(user).includes('accounting.view')) throw new DomainError('forbidden', '会計を見る権限がありません。権限管理者に「会計を見る」の権限を依頼してください。');
    return user;
  };
  const confirmer = (request: FastifyRequest): User => {
    const user = member(request);
    if (!permissions(user).includes('accounting.confirm')) throw new DomainError('forbidden', '請求と入金を確定する権限がありません。権限管理者に「請求と入金の確定」の権限を依頼してください。');
    return user;
  };
  const administrator = (request: FastifyRequest): User => {
    const user = member(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', '会計の権限は権限管理者だけが変えられます。');
    return user;
  };
  const today = () => tokyoDate(deps.now());
  const thisYear = () => Number(today().slice(0, 4));

  // ---- views

  const invoiceView = (r: InvoiceRow, day = today()): InvoiceView => {
    const org = orgs?.get(r.org_id) ?? null;
    const state = stateOf(r);
    return {
      id: r.id,
      orgId: r.org_id,
      orgName: org?.data.name ?? r.org_name,
      orgExists: org !== null,
      fiscalYear: r.fiscal_year,
      number: r.number,
      amountYen: r.amount_yen,
      issuedOn: r.issued_on,
      dueOn: r.due_on,
      payerKana: r.payer_kana,
      memo: r.memo,
      state,
      paidYen: r.paid_yen,
      differenceYen: r.paid_yen > 0 ? r.paid_yen - r.amount_yen : 0,
      shortAccepted: r.short_accepted === 1,
      shortNote: r.short_note,
      voidNote: r.void_note,
      overdue: (state === 'open' || state === 'partial') && r.due_on !== null && r.due_on < day,
      lastPaidOn: r.last_paid_on,
      version: r.version,
      updatedAt: r.updated_at,
      updatedByName: nameOf(r.updated_by),
    };
  };

  const depositView = (d: DepositRow, importedAt: Map<string, string>, labels: Map<string, string>): DepositView => ({
    id: d.id,
    bookedOn: d.booked_on,
    description: d.description,
    amountYen: d.amount_yen,
    balanceYen: d.balance_yen,
    line: d.line,
    importedAt: importedAt.get(d.import_id) ?? d.created_at,
    excluded: d.excluded === 1,
    excludedNote: d.excluded_note,
    invoiceId: d.invoice_id,
    invoiceLabel: d.invoice_id ? (labels.get(d.invoice_id) ?? null) : null,
  });

  /** The import times and the invoice labels the deposit views show. */
  const depositContext = () => {
    const importedAt = new Map(store.imports(10_000).map((i) => [i.id, i.at]));
    const labels = new Map<string, string>();
    const label = (invoiceId: string) => {
      if (!labels.has(invoiceId)) {
        const inv = store.invoice(invoiceId);
        if (inv) labels.set(invoiceId, `${inv.number} ${orgs?.get(inv.org_id)?.data.name ?? inv.org_name}`);
      }
    };
    return { importedAt, labels, label };
  };

  const historyView = (h: HistoryRow): PaymentHistoryView => ({ id: h.id, at: h.at, actorName: nameOf(h.actor_id), action: h.action, text: historyText(h) });

  const allocationViews = (invoiceId: string): AllocationView[] => {
    const rows = store.allocations(invoiceId);
    return rows.map((a) => {
      const d = store.deposit(a.deposit_id);
      return { transactionId: a.deposit_id, bookedOn: d?.booked_on ?? '', description: d?.description ?? '', amountYen: a.amount_yen, confirmedAt: a.confirmed_at, confirmedByName: nameOf(a.confirmed_by) };
    });
  };

  /** The names a payer of this invoice may use, normalized: 振込名義, the organization, its contact, earlier payments. */
  const namesOf = (r: InvoiceRow): string[] => {
    const org = orgs?.get(r.org_id) ?? null;
    const contact = org?.data.contactId && contacts ? contacts.get(org.data.contactId) : null;
    const raw = [r.payer_kana, org?.data.name ?? r.org_name, contact?.data.nameKana ?? '', contact?.data.organization ?? '', ...store.learnedDescriptions(r.org_name_key)];
    return [...new Set(raw.map(normalizePayerName).filter(Boolean))];
  };
  const rankInvoice = (r: InvoiceRow): RankInvoice => ({ id: r.id, amountYen: r.amount_yen, paidYen: r.paid_yen, issuedOn: r.issued_on, dueOn: r.due_on, names: namesOf(r) });
  const rankDeposit = (d: DepositRow): RankDeposit => ({ id: d.id, bookedOn: d.booked_on, amountYen: d.amount_yen, payerKey: d.payer_key });
  const usable = (d: DepositRow) => d.invoice_id === null && d.excluded === 0 && d.removed_at === null;

  /** Days a mail batch went to the organization (Japan's day), the ones about a 請求 first. Nothing is set by itself. */
  const issuedOnHints = (orgId: string): { date: string; subject: string }[] => {
    if (!orgs) return [];
    const seen = new Set<string>();
    const out: { date: string; subject: string }[] = [];
    for (const m of orgs.mailSentTo(orgId)) {
      const date = tokyoDate(m.at);
      const key = `${date}\u001f${m.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date, subject: m.subject });
    }
    return out.sort((a, b) => Number(b.subject.includes('請求')) - Number(a.subject.includes('請求'))).slice(0, 5);
  };

  const invoiceDetail = (r: InvoiceRow): InvoiceDetailResponse => {
    const ctx = depositContext();
    const deposits = store.deposits();
    const ranked = stateOf(r) === 'void' ? [] : rankDepositsFor(rankInvoice(r), deposits.filter(usable).map(rankDeposit));
    const byId = new Map(deposits.map((d) => [d.id, d]));
    return {
      invoice: invoiceView(r),
      allocations: allocationViews(r.id),
      candidates: ranked
        .slice(0, CANDIDATES_MAX)
        .map((c) => ({ deposit: depositView(byId.get(c.deposit.id)!, ctx.importedAt, ctx.labels), score: c.score, amountFit: c.amountFit, reasons: c.reasons })),
      candidatesTotal: ranked.length,
      issuedOnHints: issuedOnHints(r.org_id),
      history: store.history('invoice', r.id).map(historyView),
    };
  };

  const invoiceOr404 = (id: string): InvoiceRow => {
    const r = store.invoice(id);
    if (!r) throw notFound();
    return r;
  };

  // ---- the organization's stage (organizations.sqlite3 is written after payments.sqlite3, the record of the payment)

  /**
   * Puts the organization's stage in line with its invoices after any write to one of them: forward to 入金済み when
   * every invoice that is not withdrawn is paid (only for the kinds whose stages have it, 協賛・出展団体, and forward
   * only), back to where it was when that stops being so (only while it is still 入金済み: a stage someone moved on by
   * hand is left alone). A confirmation and a take-back always leave a line in the organization's history; a change of
   * an invoice (made, changed, withdrawn, restored) leaves one only when it moved the stage.
   */
  const syncOrg = (
    invoice: InvoiceRow,
    actor: string,
    now: string,
    line: { action: 'payment_confirmed' | 'payment_unconfirmed'; detail: OrgPaymentDetail } | { cause: OrgPaymentCause },
  ): ConfirmResponse['org'] => {
    if (!orgs) return 'failed';
    const all = store.invoicesOfOrg(invoice.org_id);
    const live = all.filter((i) => stateOf(i) !== 'void');
    const paid = live.length > 0 && live.every((i) => stateOf(i) === 'paid');
    // The invoice that moved the stage remembers where it was.
    const mover = all.find((i) => i.org_status_before !== null) ?? null;
    const recheck = 'cause' in line;
    const detail: OrgPaymentDetail = recheck ? { amountYen: 0, date: null, invoiceNumber: invoice.number, cause: line.cause, settled: paid } : line.detail;
    try {
      const result = orgs.recordPayment(
        invoice.org_id,
        actor,
        now,
        recheck ? 'payment_rechecked' : line.action,
        detail,
        (row) => {
          if (paid) {
            const stages = ORG_STAGES[row.data.kind];
            if (!stages) return null;
            const target = stages.indexOf(PAID_STAGE);
            const current = stages.indexOf(row.data.status);
            return target >= 0 && current >= 0 && current < target ? PAID_STAGE : null;
          }
          const back = mover?.org_status_before ?? null;
          return back && row.data.status === PAID_STAGE && statusAllowed(row.data.kind, back) ? back : null;
        },
        recheck,
      );
      if (!result || result.before === result.after) return 'unchanged';
      if (paid) {
        // One invoice keeps where the stage was: the latest move wins.
        for (const i of all) if (i.org_status_before !== null && i.id !== invoice.id) store.setOrgStatusBefore(i.id, null);
        store.setOrgStatusBefore(invoice.id, result.before);
        return 'advanced';
      }
      if (mover) store.setOrgStatusBefore(mover.id, null);
      return 'reverted';
    } catch {
      return 'failed';
    }
  };

  // ---- who may do what

  app.get('/api/payments/me', async (request): Promise<PaymentsMe> => {
    const user = member(request);
    const mine = permissions(user);
    return { canView: mine.includes('accounting.view'), canConfirm: mine.includes('accounting.confirm'), canAdminister: user.canManageAccess };
  });

  // The organization's payment for every member: only 入金済み or not, unless the person may see the accounting.
  app.get('/api/payments/organizations/:orgId', async (request): Promise<OrgPaymentStatus> => {
    const user = member(request);
    const { orgId } = deps.parse(orgParams, request.params);
    const live = store.invoicesOfOrg(orgId).filter((i) => stateOf(i) !== 'void');
    const state = live.length === 0 ? 'none' : live.every((i) => stateOf(i) === 'paid') ? 'paid' : 'unpaid';
    const mine = permissions(user);
    const canView = mine.includes('accounting.view');
    const canConfirm = mine.includes('accounting.confirm');
    if (!canView) return { state, detail: null, canView, canConfirm };
    const all = store.invoicesOfOrg(orgId);
    return { state, canView, canConfirm, detail: { invoices: all.map((r) => invoiceView(r)), allocations: Object.fromEntries(all.map((r) => [r.id, allocationViews(r.id)])) } };
  });

  // ---- the overview of a year (未入金・入金済み・照合できていない入金・過不足)

  app.get('/api/payments/overview', async (request): Promise<PaymentsOverview> => {
    viewer(request);
    const q = deps.parse(yearQuery, request.query);
    const fiscalYear = q.fiscalYear ?? thisYear();
    const day = today();
    const invoices = store.invoicesOfYear(fiscalYear).map((r) => invoiceView(r, day));
    const due = (i: InvoiceView) => i.dueOn ?? '9999-12-31';
    const unpaid = invoices
      .filter((i) => i.state === 'open' || i.state === 'partial')
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || due(a).localeCompare(due(b)) || a.number.localeCompare(b.number));
    const paid = invoices.filter((i) => i.state === 'paid').sort((a, b) => (b.lastPaidOn ?? '').localeCompare(a.lastPaidOn ?? '') || a.number.localeCompare(b.number));
    const ctx = depositContext();
    const deposits = store.deposits();
    for (const d of deposits) if (d.invoice_id) ctx.label(d.invoice_id);
    const views = deposits.map((d) => depositView(d, ctx.importedAt, ctx.labels));
    const invoiced = new Set(store.invoicesOfYear(fiscalYear).filter((r) => stateOf(r) !== 'void').map((r) => r.org_id));
    const invoiceable = (orgs?.allOfYear(fiscalYear) ?? [])
      .filter((o) => !invoiced.has(o.id))
      .sort((a, b) => Number(b.data.amountYen !== null) - Number(a.data.amountYen !== null) || a.data.name.localeCompare(b.data.name, 'ja'))
      .map((o) => ({ orgId: o.id, name: o.data.name, kindLabel: ORG_KIND_LABELS[o.data.kind], status: o.data.status, amountYen: o.data.amountYen, payerKana: store.payerHint(orgNameKey(o.data.name)), issuedOnHints: issuedOnHints(o.id) }));
    return {
      fiscalYear,
      unpaid,
      paid,
      unmatched: views.filter((d) => !d.invoiceId && !d.excluded),
      excluded: views.filter((d) => !d.invoiceId && d.excluded),
      discrepancies: paid.filter((i) => i.differenceYen !== 0),
      voided: invoices.filter((i) => i.state === 'void'),
      invoiceable,
      imports: store.imports().map((i) => ({ id: i.id, at: i.at, actorName: nameOf(i.actor_id), label: i.label, added: i.added, removed: i.removed_at !== null, matched: i.matched })),
      today: day,
    };
  });

  // ---- invoices

  app.get('/api/payments/invoices/:invoiceId', async (request): Promise<InvoiceDetailResponse> => {
    viewer(request);
    const { invoiceId } = deps.parse(invoiceParams, request.params);
    return invoiceDetail(invoiceOr404(invoiceId));
  });

  app.post('/api/payments/invoices', async (request, reply) => {
    const user = confirmer(request);
    const body = deps.parse(createBody, request.body);
    const known = store.invoiceByToken(body.clientToken);
    if (known) return reply.code(200).send(invoiceDetail(known));
    const input = checked(() => validateInvoice(body.invoice));
    if (!orgs) throw new HttpError(503, { error: 'organizations_unavailable', message: '団体の台帳を開けないため、請求を作れません。システム課に連絡してください。' });
    const org = orgs.get(input.orgId);
    if (!org) throw new DomainError('validation', '請求先の団体が見つかりません（削除された可能性があります）。団体を選び直してください。', { field: 'orgId' });
    const existing = store.invoicesOfOrg(org.id).find((i) => stateOf(i) !== 'void');
    if (existing && body.allowAnother !== true) {
      throw new DomainError('conflict', `この団体には請求 ${existing.number} がもうあります。2 つ目の請求として作るときは「追加の請求として作る」に印を付けてください。`, { field: 'orgId', invoiceId: existing.id });
    }
    const now = deps.clock();
    const row = checked(() => store.createInvoice(input, { name: org.data.name, nameKey: orgNameKey(org.data.name), fiscalYear: org.data.fiscalYear }, body.clientToken, user.id, now));
    // A second invoice for an organization that was 入金済み makes it not paid any more.
    const orgResult = syncOrg(row, user.id, now, { cause: 'invoice_created' });
    return reply.code(201).send({ ...invoiceDetail(row), org: orgResult });
  });

  // A change of an invoice can change whether the organization has paid everything (a new amount, a withdrawn duplicate,
  // a restored one): the organization's stage follows it, like after a confirmation.
  app.put('/api/payments/invoices/:invoiceId', async (request): Promise<InvoiceDetailResponse> => {
    const user = confirmer(request);
    const { invoiceId } = deps.parse(invoiceParams, request.params);
    const body = deps.parse(updateBody, request.body);
    const current = invoiceOr404(invoiceId);
    const input = checked(() => validateInvoice(body.invoice));
    if (input.orgId !== current.org_id) throw new DomainError('validation', '請求先の団体は変えられません。別の団体への請求は、この請求を取り消してから作ってください。', { field: 'orgId' });
    const now = deps.clock();
    const row = checked(() => store.updateInvoice(invoiceId, body.expectedVersion, input, user.id, now));
    if (!row) throw notFound();
    return { ...invoiceDetail(row), org: syncOrg(row, user.id, now, { cause: 'invoice_updated' }) };
  });

  app.post('/api/payments/invoices/:invoiceId/void', async (request): Promise<InvoiceDetailResponse> => {
    const user = confirmer(request);
    const { invoiceId } = deps.parse(invoiceParams, request.params);
    const body = deps.parse(voidBody, request.body);
    const note = checked(() => validateNote(body.note, '取り消しの理由'));
    const now = deps.clock();
    const row = checked(() => store.voidInvoice(invoiceId, body.expectedVersion, note, user.id, now));
    if (!row) throw notFound();
    return { ...invoiceDetail(row), org: syncOrg(row, user.id, now, { cause: 'invoice_voided' }) };
  });

  app.post('/api/payments/invoices/:invoiceId/restore', async (request): Promise<InvoiceDetailResponse> => {
    const user = confirmer(request);
    const { invoiceId } = deps.parse(invoiceParams, request.params);
    const body = deps.parse(versionBody, request.body);
    const now = deps.clock();
    const row = checked(() => store.restoreInvoice(invoiceId, body.expectedVersion, user.id, now));
    if (!row) throw notFound();
    return { ...invoiceDetail(row), org: syncOrg(row, user.id, now, { cause: 'invoice_restored' }) };
  });

  // この請求の入金: puts deposits on the invoice (one deposit, one invoice), then moves the organization to 入金済み
  // when every invoice of it is paid. The version stops a second confirmation from an older screen.
  app.post('/api/payments/invoices/:invoiceId/confirm', async (request): Promise<ConfirmResponse> => {
    const user = confirmer(request);
    const { invoiceId } = deps.parse(invoiceParams, request.params);
    const body = deps.parse(confirmBody, request.body);
    if (new Set(body.depositIds).size !== body.depositIds.length) throw new DomainError('validation', '同じ入金が 2 回選ばれています。');
    const acceptShort = body.acceptShort ? { note: checked(() => validateNote(body.acceptShort!.note, '不足を認める理由')) } : null;
    if (acceptShort && !acceptShort.note) throw new DomainError('validation', '不足を認める理由（振込手数料など）を書いてください。', { field: 'note' });
    const now = deps.clock();
    const result = checked(() => store.confirm(invoiceId, body.expectedVersion, body.depositIds, acceptShort, user.id, now));
    if (!result) throw notFound();
    const becamePaid = stateOf(result.before) !== 'paid' && stateOf(result.after) === 'paid';
    // A shortfall accepted with no deposit records what came in before it (not a payment of 0 yen).
    const detail: OrgPaymentDetail = {
      amountYen: result.amountYen,
      date: result.lastOn ?? result.after.last_paid_on,
      invoiceNumber: result.after.number,
      acceptShort: acceptShort !== null,
      paidYen: result.after.paid_yen,
    };
    const org = body.depositIds.length > 0 || becamePaid ? syncOrg(result.after, user.id, now, { action: 'payment_confirmed', detail }) : 'unchanged';
    return { invoice: invoiceDetail(result.after), org };
  });

  app.post('/api/payments/invoices/:invoiceId/unconfirm', async (request): Promise<ConfirmResponse> => {
    const user = confirmer(request);
    const { invoiceId } = deps.parse(invoiceParams, request.params);
    const body = deps.parse(unconfirmBody, request.body);
    if (new Set(body.depositIds).size !== body.depositIds.length) throw new DomainError('validation', '同じ入金が 2 回選ばれています。');
    const now = deps.clock();
    const result = checked(() => store.unconfirm(invoiceId, body.expectedVersion, body.depositIds, user.id, now));
    if (!result) throw notFound();
    const detail: OrgPaymentDetail = { amountYen: result.amountYen, date: null, invoiceNumber: result.after.number, acceptShort: result.before.short_accepted === 1, paidYen: result.after.paid_yen };
    const org = syncOrg(result.after, user.id, now, { action: 'payment_unconfirmed', detail });
    return { invoice: invoiceDetail(result.after), org };
  });

  // ---- deposits

  app.get('/api/payments/deposits/:depositId', async (request): Promise<DepositDetailResponse> => {
    viewer(request);
    const { depositId } = deps.parse(depositParams, request.params);
    const d = store.deposit(depositId);
    if (!d || d.removed_at !== null) throw notFound();
    const ctx = depositContext();
    if (d.invoice_id) ctx.label(d.invoice_id);
    const candidates = usable(d)
      ? rankInvoicesFor(rankDeposit(d), store.openInvoices().map(rankInvoice))
          .slice(0, 30)
          .map((c) => ({ invoice: invoiceView(store.invoice(c.invoice.id)!), score: c.score, amountFit: c.amountFit, reasons: c.reasons }))
      : [];
    return { deposit: depositView(d, ctx.importedAt, ctx.labels), candidates, history: store.history('deposit', d.id).map(historyView) };
  });

  // 照合の対象外 (interest, a member's own transfer…): out of the unmatched list, and back again.
  app.post('/api/payments/deposits/:depositId/exclude', async (request): Promise<DepositDetailResponse> => {
    const user = confirmer(request);
    const { depositId } = deps.parse(depositParams, request.params);
    const body = deps.parse(excludeBody, request.body);
    const note = checked(() => validateNote(body.note, '対象外にする理由'));
    const d = checked(() => store.setExcluded(depositId, body.excluded, note, user.id, deps.clock()));
    if (!d) throw notFound();
    const ctx = depositContext();
    return { deposit: depositView(d, ctx.importedAt, ctx.labels), candidates: [], history: store.history('deposit', d.id).map(historyView) };
  });

  // ---- statement import (下見 with dryRun, then the same rows with the plan token)

  app.post('/api/payments/statements/import', { bodyLimit: 2 * 1024 * 1024 }, async (request): Promise<StatementImportResponse> => {
    const user = confirmer(request);
    const body = deps.parse(importBody, request.body);
    const plan = planStatement(body.rows);
    const planToken = createHash('sha256').update(JSON.stringify(plan.rows.map((r) => [r.line, r.action, r.reason]))).digest('hex');
    if (!body.dryRun) {
      // Only the plan the person checked is written: a statement imported by someone else since stops it.
      if (body.planToken !== planToken) throw new DomainError('conflict', '下見のあとに明細の取り込みが変わりました。下見をやり直してから、もう一度取り込んでください。');
      if (plan.deposits.length > 0) store.addImport((body.label ?? '').replace(LABEL_CONTROL, '').trim().slice(0, 100) || '入出金明細', plan.deposits, user.id, deps.clock());
    }
    const counts = { new: 0, duplicate: 0, withdrawal: 0, unreadable: 0 };
    for (const r of plan.rows) counts[r.action] += 1;
    return { dryRun: body.dryRun, counts, rows: plan.rows, planToken };
  });

  /** Each row: a new deposit, one already imported (the same date, description, amount and balance), a withdrawal, or unreadable. */
  function planStatement(rows: z.infer<typeof importBody>['rows']): { rows: StatementPlanRow[]; deposits: NewDeposit[] } {
    const read = rows.map((r) => ({ line: r.line, result: readStatementRow(r) }));
    const keys = read.flatMap((r) => (r.result.kind === 'deposit' ? [depositKey(r.result)] : []));
    const stored = store.keyCounts(keys);
    // Two equal rows in one file (no balance column) are two deposits: the n-th is a duplicate only when n are stored.
    const seen = new Map<string, number>();
    const out: StatementPlanRow[] = [];
    const deposits: NewDeposit[] = [];
    for (const { line, result } of read) {
      if (result.kind === 'withdrawal') {
        out.push({ line, action: 'withdrawal', bookedOn: null, description: '', amountYen: null, reason: '出金なので取り込みません' });
        continue;
      }
      if (result.kind === 'unreadable') {
        out.push({ line, action: 'unreadable', bookedOn: null, description: '', amountYen: null, reason: result.reason });
        continue;
      }
      const key = depositKey(result);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if ((stored.get(key) ?? 0) >= n) {
        out.push({ line, action: 'duplicate', bookedOn: result.bookedOn, description: result.description, amountYen: result.amountYen, reason: 'すでに取り込んだ入金です（日付・摘要・金額・残高が同じ）' });
        continue;
      }
      out.push({ line, action: 'new', bookedOn: result.bookedOn, description: result.description, amountYen: result.amountYen, reason: '' });
      deposits.push({ line, bookedOn: result.bookedOn, description: result.description, payerKey: normalizePayerName(result.description), dupKey: key, amountYen: result.amountYen, balanceYen: result.balanceYen });
    }
    return { rows: out, deposits };
  }

  app.post('/api/payments/imports/:importId/remove', async (request): Promise<{ removed: true }> => {
    const user = confirmer(request);
    const { importId } = deps.parse(importParams, request.params);
    const result = store.removeImport(importId, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'matched') throw new DomainError('conflict', 'この取り込みの入金に、確定したものがあります。先にその入金の確定を外してください。');
    return { removed: true };
  });

  // ---- CSV export (会計を見る人だけ): the invoices of a year, or the deposits

  app.get('/api/payments/export.csv', async (request, reply: FastifyReply) => {
    viewer(request);
    const q = deps.parse(exportQuery, request.query);
    const fiscalYear = q.fiscalYear ?? thisYear();
    const day = today();
    let head: string[];
    let rows: string[][];
    if (q.what === 'invoices') {
      head = ['請求番号', '団体名', '請求額', '請求日', '支払の期限', '状態', '入金額', '過払い', '不足', '最後の入金日', '振込名義', 'メモ'];
      rows = store.invoicesOfYear(fiscalYear).map((r) => {
        const v = invoiceView(r, day);
        return [
          csvText(v.number),
          csvText(v.orgName),
          csvNumber(v.amountYen),
          csvText(v.issuedOn ?? ''),
          csvText(v.dueOn ?? ''),
          csvText({ open: v.overdue ? '未入金（期限切れ）' : '未入金', partial: '一部入金', paid: '入金済み', void: '取り消し' }[v.state]),
          csvNumber(v.paidYen),
          csvNumber(Math.max(0, v.differenceYen)),
          csvNumber(Math.max(0, -v.differenceYen)),
          csvText(v.lastPaidOn ?? ''),
          csvText(v.payerKana),
          csvText(v.memo),
        ];
      });
    } else {
      const ctx = depositContext();
      const deposits = store.deposits();
      for (const d of deposits) if (d.invoice_id) ctx.label(d.invoice_id);
      head = ['日付', '摘要', '入金額', '残高', '照合した請求', '対象外'];
      rows = deposits.map((d) => {
        const v = depositView(d, ctx.importedAt, ctx.labels);
        return [csvText(v.bookedOn), csvText(v.description), csvNumber(v.amountYen), csvNumber(v.balanceYen), csvText(v.invoiceLabel ?? ''), csvText(v.excluded ? `対象外${v.excludedNote ? `（${v.excludedNote}）` : ''}` : '')];
      });
    }
    const csv = '\uFEFF' + [head.map(csvText), ...rows].map((cells) => cells.join(',')).join('\r\n') + '\r\n';
    const name = q.what === 'invoices' ? `請求と入金_${fiscalYear}年度_${day.replaceAll('-', '')}.csv` : `入金明細_${day.replaceAll('-', '')}.csv`;
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', attachmentDisposition(name, 'payments.csv'));
    reply.header('Cache-Control', 'no-store');
    return reply.send(csv);
  });

  // ---- the accounting permissions (権限管理者): per member and per department

  const isCommitteeAccount = (u: User) => !u.disabled && !isTemporaryStaffLoginId(u.id) && !departmentsOfLabel(u.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT);
  const accessView = (): AccountingAccessResponse => {
    const people = deps.people.list().filter(isCommitteeAccount).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    const stored = new Map<string, AccountingPermission[]>();
    for (const g of store.grants()) stored.set(g.user_id, [...(stored.get(g.user_id) ?? []), g.permission]);
    const departments = [...new Set(people.flatMap(departmentsOf))].sort(compareDepartments);
    return {
      revision: store.accessRevision(),
      people: people.map((p) => ({ id: p.id, displayName: p.displayName, roleLabel: p.roleLabel, stored: stored.get(p.id) ?? [], effective: permissions(p) })),
      departments,
      departmentGrants: store.departmentGrants(),
      history: store.accessEvents().map((e) => ({
        id: e.id,
        at: e.at,
        actorName: nameOf(e.actor_id),
        text: `${e.target_kind === 'user' ? nameOf(e.target) : `部局「${e.target}」`}の「${e.permission === 'accounting.view' ? '会計を見る' : '請求と入金の確定'}」を${e.granted ? '付けました' : '外しました'}`,
      })),
    };
  };

  app.get('/api/payments/admin/access', async (request): Promise<AccountingAccessResponse> => {
    administrator(request);
    return accessView();
  });

  app.put('/api/payments/admin/access', async (request): Promise<AccountingAccessResponse> => {
    const user = administrator(request);
    const body = deps.parse(accessBody, request.body);
    let target: { kind: 'user' | 'department'; id: string };
    if (body.userId !== undefined) {
      const person = deps.people.lookup(body.userId);
      // Taking a permission away needs no current account (someone who left can still lose it).
      if (body.on && (!person || !isCommitteeAccount(person))) throw new DomainError('validation', 'このアカウントは見つからないか、会計の権限を付けられません（臨時スタッフには付けられません）。');
      target = { kind: 'user', id: body.userId };
    } else {
      const name = body.department!;
      if (body.on && !accessView().departments.includes(name)) throw new DomainError('validation', 'この部局には今、委員がいません（Discord のロールで部局が決まります）。');
      target = { kind: 'department', id: name };
    }
    const result = store.setAccess(body.expectedRevision, target, body.permission, body.on, user.id, deps.clock());
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの管理者が先に会計の権限を変えました。最新の内容を読み込み直してから、もう一度変えてください。');
    return accessView();
  });
}
