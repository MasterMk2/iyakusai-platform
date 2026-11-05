import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNTING_PERMISSIONS, invoiceState, type AccountingPermission, type InvoiceInput, type InvoiceState, type PaymentHistoryAction } from '../../shared/payments.js';

// Payments (入金確認, 2026-11-03): one SQLite file (payments.sqlite3) in the mail folder next to organizations.sqlite3,
// so the folder's backup carries it. Invoices, the deposits of the bank statements, the confirmed matches between
// them (allocations), the accounting permissions, and a history of every change.
// - A deposit is put on at most one invoice: a partial UNIQUE index on the live allocations makes a second use fail
//   inside the database, whatever the screens send. One invoice may take several deposits (分割の入金).
// - Nothing is deleted: a confirmation taken back keeps its row (undone_at), a withdrawn invoice is marked void, an
//   import taken back marks its deposits removed. The history keeps who did what and when.
// - Every write to an invoice checks its version inside BEGIN IMMEDIATE: a second confirmation from an older screen
//   gets 'conflict'.
// The statement's other columns are never stored: only the date, the description (摘要), the amount and the balance.

export const PAYMENTS_FILE = 'payments.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoices(
  id TEXT PRIMARY KEY,
  client_token TEXT UNIQUE,
  org_id TEXT NOT NULL,
  org_name TEXT NOT NULL,
  org_name_key TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  number TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  issued_on TEXT,
  due_on TEXT,
  payer_kana TEXT NOT NULL,
  memo TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  void_note TEXT NOT NULL DEFAULT '',
  short_accepted INTEGER NOT NULL DEFAULT 0,
  short_note TEXT NOT NULL DEFAULT '',
  org_status_before TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_number ON invoices(fiscal_year, number);
CREATE INDEX IF NOT EXISTS invoices_org ON invoices(org_id);
CREATE INDEX IF NOT EXISTS invoices_name_key ON invoices(org_name_key);
CREATE TABLE IF NOT EXISTS imports(
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  label TEXT NOT NULL,
  added INTEGER NOT NULL,
  removed_at TEXT,
  removed_by TEXT
);
CREATE TABLE IF NOT EXISTS deposits(
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  line INTEGER NOT NULL,
  booked_on TEXT NOT NULL,
  description TEXT NOT NULL,
  payer_key TEXT NOT NULL,
  dup_key TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  balance_yen INTEGER,
  excluded INTEGER NOT NULL DEFAULT 0,
  excluded_note TEXT NOT NULL DEFAULT '',
  removed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deposits_key ON deposits(dup_key);
CREATE INDEX IF NOT EXISTS deposits_import ON deposits(import_id);
CREATE TABLE IF NOT EXISTS allocations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL,
  deposit_id TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS allocations_live ON allocations(deposit_id) WHERE undone_at IS NULL;
CREATE INDEX IF NOT EXISTS allocations_invoice ON allocations(invoice_id);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS history_subject ON history(subject, subject_id, id);
CREATE TABLE IF NOT EXISTS grants(user_id TEXT NOT NULL, permission TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(user_id, permission));
CREATE TABLE IF NOT EXISTS department_grants(department TEXT NOT NULL, permission TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(department, permission));
CREATE TABLE IF NOT EXISTS access_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted INTEGER NOT NULL
);
`;

export interface InvoiceRow {
  id: string;
  client_token: string | null;
  org_id: string;
  org_name: string;
  org_name_key: string;
  fiscal_year: number;
  number: string;
  amount_yen: number;
  issued_on: string | null;
  due_on: string | null;
  payer_kana: string;
  memo: string;
  voided: number;
  void_note: string;
  short_accepted: number;
  short_note: string;
  org_status_before: string | null;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  /** The sum of the live allocations. */
  paid_yen: number;
  /** The latest day of a deposit put on it, or null. */
  last_paid_on: string | null;
}

export interface DepositRow {
  id: string;
  import_id: string;
  line: number;
  booked_on: string;
  description: string;
  payer_key: string;
  dup_key: string;
  amount_yen: number;
  balance_yen: number | null;
  excluded: number;
  excluded_note: string;
  removed_at: string | null;
  created_at: string;
  /** The invoice of the live allocation, or null. */
  invoice_id: string | null;
}

export interface AllocationRow {
  id: number;
  invoice_id: string;
  deposit_id: string;
  amount_yen: number;
  confirmed_at: string;
  confirmed_by: string;
}

export interface ImportRow {
  id: string;
  at: string;
  actor_id: string;
  label: string;
  added: number;
  removed_at: string | null;
  removed_by: string | null;
  matched: number;
}

export interface HistoryRow {
  id: number;
  subject: 'invoice' | 'deposit' | 'import';
  subject_id: string;
  at: string;
  actor_id: string;
  action: PaymentHistoryAction;
  before: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
}

export interface NewDeposit {
  line: number;
  bookedOn: string;
  description: string;
  payerKey: string;
  dupKey: string;
  amountYen: number;
  balanceYen: number | null;
}

/** What made a write stop: the screens turn each into a message. */
export type WriteRefusal = 'conflict' | 'void' | 'not_void' | 'has_payments' | 'number_taken' | 'deposit_taken' | 'deposit_unusable' | 'nothing_to_confirm' | 'not_allocated';

export class PaymentRefused extends Error {
  constructor(readonly reason: WriteRefusal) {
    super(reason);
  }
}

const INVOICE_SELECT = `
SELECT i.*, COALESCE(SUM(a.amount_yen), 0) AS paid_yen, MAX(d.booked_on) AS last_paid_on
FROM invoices i
LEFT JOIN allocations a ON a.invoice_id = i.id AND a.undone_at IS NULL
LEFT JOIN deposits d ON d.id = a.deposit_id`;

const DEPOSIT_SELECT = `
SELECT d.*, a.invoice_id AS invoice_id
FROM deposits d
LEFT JOIN allocations a ON a.deposit_id = d.id AND a.undone_at IS NULL`;

const num = (row: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (row[k] !== null && row[k] !== undefined) row[k] = Number(row[k]);
};

function invoiceRow(raw: unknown): InvoiceRow {
  const row = raw as Record<string, unknown>;
  num(row, 'fiscal_year', 'amount_yen', 'voided', 'short_accepted', 'version', 'paid_yen');
  return row as unknown as InvoiceRow;
}

function depositRow(raw: unknown): DepositRow {
  const row = raw as Record<string, unknown>;
  num(row, 'line', 'amount_yen', 'balance_yen', 'excluded');
  return row as unknown as DepositRow;
}

export const stateOf = (row: InvoiceRow): InvoiceState => invoiceState(row.amount_yen, row.paid_yen, row.short_accepted === 1, row.voided === 1);

export class PaymentsStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, PAYMENTS_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('payments schema version');
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private addHistory(subject: HistoryRow['subject'], subjectId: string, actor: string, now: string, action: PaymentHistoryAction, before: Record<string, unknown> | null, detail: Record<string, unknown> | null): void {
    this.db
      .prepare('INSERT INTO history(subject,subject_id,at,actor_id,action,before_json,detail_json) VALUES(?,?,?,?,?,?,?)')
      .run(subject, subjectId, now, actor, action, before ? JSON.stringify(before) : null, detail ? JSON.stringify(detail) : null);
  }

  history(subject: HistoryRow['subject'], subjectId: string, limit = 60): HistoryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM history WHERE subject=? AND subject_id=? ORDER BY id DESC LIMIT ?')
      .all(subject, subjectId, limit) as { id: number; subject: string; subject_id: string; at: string; actor_id: string; action: string; before_json: string | null; detail_json: string | null }[];
    return rows.map((r) => ({
      id: Number(r.id),
      subject: r.subject as HistoryRow['subject'],
      subject_id: r.subject_id,
      at: r.at,
      actor_id: r.actor_id,
      action: r.action as PaymentHistoryAction,
      before: r.before_json ? (JSON.parse(r.before_json) as Record<string, unknown>) : null,
      detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
    }));
  }

  // ---- invoices

  invoice(id: string): InvoiceRow | null {
    const raw = this.db.prepare(`${INVOICE_SELECT} WHERE i.id=? GROUP BY i.id`).get(id);
    return raw ? invoiceRow(raw) : null;
  }

  invoiceByToken(token: string): InvoiceRow | null {
    const raw = this.db.prepare(`${INVOICE_SELECT} WHERE i.client_token=? GROUP BY i.id`).get(token);
    return raw ? invoiceRow(raw) : null;
  }

  invoicesOfYear(fiscalYear: number): InvoiceRow[] {
    return this.db.prepare(`${INVOICE_SELECT} WHERE i.fiscal_year=? GROUP BY i.id ORDER BY i.number, i.id`).all(fiscalYear).map(invoiceRow);
  }

  invoicesOfOrg(orgId: string): InvoiceRow[] {
    return this.db.prepare(`${INVOICE_SELECT} WHERE i.org_id=? GROUP BY i.id ORDER BY i.created_at, i.id`).all(orgId).map(invoiceRow);
  }

  /** Invoices not void and not paid: the ones a deposit can still be put on. */
  openInvoices(): InvoiceRow[] {
    return this.db
      .prepare(`${INVOICE_SELECT} WHERE i.voided=0 GROUP BY i.id ORDER BY i.due_on IS NULL, i.due_on, i.id`)
      .all()
      .map(invoiceRow)
      .filter((r) => stateOf(r) === 'open' || stateOf(r) === 'partial');
  }

  /**
   * The name the payer used before, for an organization of this name (any year): the 振込名義 of its latest invoice,
   * else the description of the latest deposit put on one of its invoices. Empty when there is none.
   */
  payerHint(orgNameKey: string): string {
    const kana = this.db.prepare("SELECT payer_kana FROM invoices WHERE org_name_key=? AND payer_kana<>'' ORDER BY created_at DESC, id DESC LIMIT 1").get(orgNameKey) as { payer_kana: string } | undefined;
    if (kana) return kana.payer_kana;
    const seen = this.learnedDescriptions(orgNameKey, 1);
    return seen[0] ?? '';
  }

  /** Descriptions of the deposits once put on an invoice of an organization of this name (the names it paid under). */
  learnedDescriptions(orgNameKey: string, limit = 5): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT d.description AS description FROM allocations a JOIN invoices i ON i.id=a.invoice_id JOIN deposits d ON d.id=a.deposit_id
         WHERE i.org_name_key=? AND a.undone_at IS NULL ORDER BY a.confirmed_at DESC LIMIT ?`,
      )
      .all(orgNameKey, limit) as { description: string }[];
    return rows.map((r) => r.description);
  }

  private nextNumber(fiscalYear: number): string {
    const rows = this.db.prepare('SELECT number FROM invoices WHERE fiscal_year=?').all(fiscalYear) as { number: string }[];
    const prefix = `${fiscalYear}-`;
    let max = 0;
    for (const r of rows) {
      if (r.number.startsWith(prefix) && /^\d+$/.test(r.number.slice(prefix.length))) max = Math.max(max, Number(r.number.slice(prefix.length)));
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  private numberTaken(fiscalYear: number, number: string, exceptId: string | null): boolean {
    return (this.db.prepare('SELECT id FROM invoices WHERE fiscal_year=? AND number=?').all(fiscalYear, number) as { id: string }[]).some((r) => r.id !== exceptId);
  }

  /** A new invoice; the same client token again gives the first invoice back (a double tap makes one invoice). */
  createInvoice(input: InvoiceInput, org: { name: string; nameKey: string; fiscalYear: number }, clientToken: string, actor: string, now: string): InvoiceRow {
    return this.tx(() => {
      const known = this.invoiceByToken(clientToken);
      if (known) return known;
      const number = input.number || this.nextNumber(org.fiscalYear);
      if (this.numberTaken(org.fiscalYear, number, null)) throw new PaymentRefused('number_taken');
      const id = `iv_${randomBytes(8).toString('hex')}`;
      this.db
        .prepare(
          'INSERT INTO invoices(id,client_token,org_id,org_name,org_name_key,fiscal_year,number,amount_yen,issued_on,due_on,payer_kana,memo,version,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)',
        )
        .run(id, clientToken, input.orgId, org.name, org.nameKey, org.fiscalYear, number, input.amountYen, input.issuedOn, input.dueOn, input.payerKana, input.memo, now, actor, now, actor);
      this.addHistory('invoice', id, actor, now, 'invoice_created', null, { number, amountYen: input.amountYen });
      return this.invoice(id)!;
    });
  }

  private checkedInvoice(id: string, expectedVersion: number): InvoiceRow {
    const row = this.invoice(id);
    if (!row) throw new PaymentRefused('conflict');
    if (row.version !== expectedVersion) throw new PaymentRefused('conflict');
    return row;
  }

  private bump(id: string, actor: string, now: string, set = '', params: (string | number | null)[] = []): void {
    this.db.prepare(`UPDATE invoices SET ${set}${set ? ',' : ''}version=version+1, updated_at=?, updated_by=? WHERE id=?`).run(...params, now, actor, id);
  }

  /** Changes the amount, the dates, the number, the payer name and the memo. Null when the invoice is gone. */
  updateInvoice(id: string, expectedVersion: number, input: InvoiceInput, actor: string, now: string): InvoiceRow | null {
    return this.tx(() => {
      if (!this.invoice(id)) return null;
      const before = this.checkedInvoice(id, expectedVersion);
      if (before.voided === 1) throw new PaymentRefused('void');
      const number = input.number || before.number;
      if (this.numberTaken(before.fiscal_year, number, id)) throw new PaymentRefused('number_taken');
      const keep = { number: before.number, amountYen: before.amount_yen, issuedOn: before.issued_on, dueOn: before.due_on, payerKana: before.payer_kana, memo: before.memo };
      const after = { number, amountYen: input.amountYen, issuedOn: input.issuedOn, dueOn: input.dueOn, payerKana: input.payerKana, memo: input.memo };
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== keep[k]);
      if (changed.length === 0) return before;
      // A new amount can make a shortfall disappear; an accepted shortfall is for the amount it was accepted for.
      const resetShort = after.amountYen !== keep.amountYen ? ',short_accepted=0,short_note=\'\'' : '';
      this.bump(id, actor, now, `number=?,amount_yen=?,issued_on=?,due_on=?,payer_kana=?,memo=?${resetShort}`, [number, input.amountYen, input.issuedOn, input.dueOn, input.payerKana, input.memo]);
      this.addHistory('invoice', id, actor, now, 'invoice_updated', keep, { changed });
      return this.invoice(id)!;
    });
  }

  /** Withdraws an invoice (取り消し). Only one without confirmed deposits: those are taken back first. */
  voidInvoice(id: string, expectedVersion: number, note: string, actor: string, now: string): InvoiceRow | null {
    return this.tx(() => {
      if (!this.invoice(id)) return null;
      const before = this.checkedInvoice(id, expectedVersion);
      if (before.voided === 1) throw new PaymentRefused('void');
      if (before.paid_yen > 0) throw new PaymentRefused('has_payments');
      this.bump(id, actor, now, 'voided=1, void_note=?', [note]);
      this.addHistory('invoice', id, actor, now, 'invoice_voided', null, { note });
      return this.invoice(id)!;
    });
  }

  restoreInvoice(id: string, expectedVersion: number, actor: string, now: string): InvoiceRow | null {
    return this.tx(() => {
      if (!this.invoice(id)) return null;
      const before = this.checkedInvoice(id, expectedVersion);
      if (before.voided !== 1) throw new PaymentRefused('not_void');
      this.bump(id, actor, now, "voided=0, void_note=''");
      this.addHistory('invoice', id, actor, now, 'invoice_restored', { note: before.void_note }, null);
      return this.invoice(id)!;
    });
  }

  allocations(invoiceId: string): AllocationRow[] {
    const rows = this.db.prepare('SELECT id, invoice_id, deposit_id, amount_yen, confirmed_at, confirmed_by FROM allocations WHERE invoice_id=? AND undone_at IS NULL ORDER BY id').all(invoiceId) as Record<string, unknown>[];
    return rows.map((r) => {
      num(r, 'id', 'amount_yen');
      return r as unknown as AllocationRow;
    });
  }

  /**
   * Confirms deposits as the payment of one invoice (この請求の入金). Each deposit must be live, not set aside and not
   * on any invoice. `acceptShort` closes a shortfall (a transfer fee taken off, for example) with a note; it can be
   * sent with no deposit when the invoice already has some. Returns the invoice before and after.
   */
  confirm(id: string, expectedVersion: number, depositIds: string[], acceptShort: { note: string } | null, actor: string, now: string): { before: InvoiceRow; after: InvoiceRow; amountYen: number; lastOn: string | null } | null {
    return this.tx(() => {
      if (!this.invoice(id)) return null;
      const before = this.checkedInvoice(id, expectedVersion);
      if (before.voided === 1) throw new PaymentRefused('void');
      if (depositIds.length === 0 && (!acceptShort || before.paid_yen === 0)) throw new PaymentRefused('nothing_to_confirm');
      let amount = 0;
      let lastOn: string | null = null;
      for (const depositId of depositIds) {
        const d = this.deposit(depositId);
        if (!d || d.removed_at !== null || d.excluded === 1) throw new PaymentRefused('deposit_unusable');
        if (d.invoice_id !== null) throw new PaymentRefused('deposit_taken');
        try {
          this.db.prepare('INSERT INTO allocations(invoice_id,deposit_id,amount_yen,confirmed_at,confirmed_by) VALUES(?,?,?,?,?)').run(id, depositId, d.amount_yen, now, actor);
        } catch {
          // The partial unique index: the same deposit on two invoices.
          throw new PaymentRefused('deposit_taken');
        }
        amount += d.amount_yen;
        if (!lastOn || d.booked_on > lastOn) lastOn = d.booked_on;
      }
      const set = acceptShort ? 'short_accepted=1, short_note=?' : '';
      this.bump(id, actor, now, set, acceptShort ? [acceptShort.note] : []);
      this.addHistory('invoice', id, actor, now, 'confirmed', null, { depositIds, amountYen: amount, lastOn, acceptShort: acceptShort !== null, note: acceptShort?.note ?? '' });
      for (const depositId of depositIds) this.addHistory('deposit', depositId, actor, now, 'confirmed', null, { invoiceId: id, number: before.number });
      return { before, after: this.invoice(id)!, amountYen: amount, lastOn };
    });
  }

  /**
   * Takes confirmed deposits off an invoice (確定を外す); with no deposit named, an accepted shortfall is taken back.
   * Any change takes back an accepted shortfall too: it is accepted again after a new check.
   */
  unconfirm(id: string, expectedVersion: number, depositIds: string[], actor: string, now: string): { before: InvoiceRow; after: InvoiceRow; amountYen: number } | null {
    return this.tx(() => {
      if (!this.invoice(id)) return null;
      const before = this.checkedInvoice(id, expectedVersion);
      if (depositIds.length === 0 && before.short_accepted !== 1) throw new PaymentRefused('nothing_to_confirm');
      let amount = 0;
      for (const depositId of depositIds) {
        const live = this.db.prepare('SELECT id, amount_yen FROM allocations WHERE invoice_id=? AND deposit_id=? AND undone_at IS NULL').get(id, depositId) as { id: number; amount_yen: number } | undefined;
        if (!live) throw new PaymentRefused('not_allocated');
        this.db.prepare('UPDATE allocations SET undone_at=?, undone_by=? WHERE id=?').run(now, actor, live.id);
        amount += Number(live.amount_yen);
      }
      this.bump(id, actor, now, "short_accepted=0, short_note=''");
      this.addHistory('invoice', id, actor, now, 'unconfirmed', null, { depositIds, amountYen: amount, shortTakenBack: before.short_accepted === 1 });
      for (const depositId of depositIds) this.addHistory('deposit', depositId, actor, now, 'unconfirmed', null, { invoiceId: id, number: before.number });
      return { before, after: this.invoice(id)!, amountYen: amount };
    });
  }

  /** The organization's status before this invoice moved it to 入金済み (so taking the payment back can put it back). */
  setOrgStatusBefore(id: string, status: string | null): void {
    this.db.prepare('UPDATE invoices SET org_status_before=? WHERE id=?').run(status, id);
  }

  // ---- deposits and imports

  deposit(id: string): DepositRow | null {
    const raw = this.db.prepare(`${DEPOSIT_SELECT} WHERE d.id=?`).get(id);
    return raw ? depositRow(raw) : null;
  }

  /** Live deposits (not removed), newest first. */
  deposits(): DepositRow[] {
    return this.db.prepare(`${DEPOSIT_SELECT} WHERE d.removed_at IS NULL ORDER BY d.booked_on DESC, d.created_at DESC, d.line DESC, d.id`).all().map(depositRow);
  }

  depositsOf(invoiceId: string): DepositRow[] {
    return this.db
      .prepare(`${DEPOSIT_SELECT} WHERE a.invoice_id=? ORDER BY d.booked_on, d.id`)
      .all(invoiceId)
      .map(depositRow);
  }

  /**
   * For the books (会計の帳簿, 2026-11-05): the deposits put on an invoice now (a live allocation), with the invoice's
   * number and organization, oldest first. Read only.
   */
  confirmedDeposits(): { deposit_id: string; booked_on: string; description: string; amount_yen: number; invoice_id: string; number: string; org_id: string; org_name: string }[] {
    const rows = this.db
      .prepare(
        `SELECT d.id AS deposit_id, d.booked_on, d.description, d.amount_yen, i.id AS invoice_id, i.number, i.org_id, i.org_name
         FROM allocations a JOIN deposits d ON d.id=a.deposit_id JOIN invoices i ON i.id=a.invoice_id
         WHERE a.undone_at IS NULL AND d.removed_at IS NULL ORDER BY d.booked_on, d.id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => {
      num(r, 'amount_yen');
      return r as unknown as { deposit_id: string; booked_on: string; description: string; amount_yen: number; invoice_id: string; number: string; org_id: string; org_name: string };
    });
  }

  /** How many live deposits each key has (the import's duplicate check). */
  keyCounts(keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 500) {
      const part = unique.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT dup_key, count(*) AS n FROM deposits WHERE removed_at IS NULL AND dup_key IN (${part.map(() => '?').join(',')}) GROUP BY dup_key`).all(...part) as { dup_key: string; n: number }[];
      for (const r of rows) out.set(r.dup_key, Number(r.n));
    }
    return out;
  }

  addImport(label: string, deposits: NewDeposit[], actor: string, now: string): string {
    return this.tx(() => {
      const id = `si_${randomBytes(8).toString('hex')}`;
      this.db.prepare('INSERT INTO imports(id,at,actor_id,label,added) VALUES(?,?,?,?,?)').run(id, now, actor, label, deposits.length);
      const insert = this.db.prepare('INSERT INTO deposits(id,import_id,line,booked_on,description,payer_key,dup_key,amount_yen,balance_yen,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const d of deposits) insert.run(`dp_${randomBytes(8).toString('hex')}`, id, d.line, d.bookedOn, d.description, d.payerKey, d.dupKey, d.amountYen, d.balanceYen, now);
      this.addHistory('import', id, actor, now, 'statement_imported', null, { added: deposits.length });
      return id;
    });
  }

  imports(limit = 20): ImportRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT count(*) FROM deposits d JOIN allocations a ON a.deposit_id=d.id AND a.undone_at IS NULL WHERE d.import_id=s.id) AS matched
         FROM imports s ORDER BY s.at DESC, s.id DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => {
      num(r, 'added', 'matched');
      return r as unknown as ImportRow;
    });
  }

  /** Takes an import back (its deposits are marked removed). Refused while any of them is on an invoice. */
  removeImport(id: string, actor: string, now: string): 'removed' | 'matched' | null {
    return this.tx(() => {
      const row = this.db.prepare('SELECT removed_at FROM imports WHERE id=?').get(id) as { removed_at: string | null } | undefined;
      if (!row) return null;
      if (row.removed_at) return 'removed';
      const matched = Number((this.db.prepare('SELECT count(*) AS n FROM deposits d JOIN allocations a ON a.deposit_id=d.id AND a.undone_at IS NULL WHERE d.import_id=?').get(id) as { n: number }).n);
      if (matched > 0) return 'matched';
      this.db.prepare('UPDATE imports SET removed_at=?, removed_by=? WHERE id=?').run(now, actor, id);
      this.db.prepare('UPDATE deposits SET removed_at=? WHERE import_id=? AND removed_at IS NULL').run(now, id);
      this.addHistory('import', id, actor, now, 'import_removed', null, null);
      return 'removed';
    });
  }

  /** Sets a deposit aside as not for any invoice (利息など), or takes it back into the list. Not one on an invoice. */
  setExcluded(id: string, excluded: boolean, note: string, actor: string, now: string): DepositRow | null {
    return this.tx(() => {
      const d = this.deposit(id);
      if (!d || d.removed_at !== null) return null;
      if (d.invoice_id !== null) throw new PaymentRefused('deposit_taken');
      if ((d.excluded === 1) === excluded) return d;
      this.db.prepare('UPDATE deposits SET excluded=?, excluded_note=? WHERE id=?').run(excluded ? 1 : 0, excluded ? note : '', id);
      this.addHistory('deposit', id, actor, now, excluded ? 'deposit_excluded' : 'deposit_included', excluded ? null : { note: d.excluded_note }, excluded ? { note } : null);
      return this.deposit(id)!;
    });
  }

  // ---- accounting permissions (per member and per department; the routes leave out temporary staff)

  accessRevision(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='access_revision'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  grants(): { user_id: string; permission: AccountingPermission }[] {
    return this.db.prepare('SELECT user_id, permission FROM grants ORDER BY user_id, permission').all() as { user_id: string; permission: AccountingPermission }[];
  }

  departmentGrants(): { department: string; permission: AccountingPermission }[] {
    return this.db.prepare('SELECT department, permission FROM department_grants ORDER BY department, permission').all() as { department: string; permission: AccountingPermission }[];
  }

  /** The permissions a member holds: their own and their departments'. accounting.confirm includes accounting.view. */
  permissionsOf(userId: string, departments: string[]): AccountingPermission[] {
    const own = (this.db.prepare('SELECT permission FROM grants WHERE user_id=?').all(userId) as { permission: string }[]).map((r) => r.permission);
    const dept =
      departments.length === 0
        ? []
        : (this.db.prepare(`SELECT permission FROM department_grants WHERE department IN (${departments.map(() => '?').join(',')})`).all(...departments) as { permission: string }[]).map((r) => r.permission);
    const all = new Set([...own, ...dept].filter((p): p is AccountingPermission => (ACCOUNTING_PERMISSIONS as readonly string[]).includes(p)));
    if (all.has('accounting.confirm')) all.add('accounting.view');
    return ACCOUNTING_PERMISSIONS.filter((p) => all.has(p));
  }

  /** Gives or takes one permission from a member or a department. 'conflict' when another administrator saved first. */
  setAccess(expectedRevision: number, target: { kind: 'user' | 'department'; id: string }, permission: AccountingPermission, on: boolean, actor: string, now: string): number | 'conflict' {
    return this.tx(() => {
      const current = this.accessRevision();
      if (current !== expectedRevision) return 'conflict';
      const table = target.kind === 'user' ? 'grants' : 'department_grants';
      const column = target.kind === 'user' ? 'user_id' : 'department';
      if (on) this.db.prepare(`INSERT OR IGNORE INTO ${table}(${column},permission,granted_by,granted_at) VALUES(?,?,?,?)`).run(target.id, permission, actor, now);
      else this.db.prepare(`DELETE FROM ${table} WHERE ${column}=? AND permission=?`).run(target.id, permission);
      this.db.prepare('INSERT INTO access_events(at,actor_id,target_kind,target,permission,granted) VALUES(?,?,?,?,?,?)').run(now, actor, target.kind, target.id, permission, on ? 1 : 0);
      this.db.prepare("INSERT INTO meta(key,value) VALUES('access_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(current + 1));
      return current + 1;
    });
  }

  accessEvents(limit = 20): { id: number; at: string; actor_id: string; target_kind: 'user' | 'department'; target: string; permission: AccountingPermission; granted: boolean }[] {
    const rows = this.db.prepare('SELECT * FROM access_events ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor_id: String(r.actor_id),
      target_kind: r.target_kind as 'user' | 'department',
      target: String(r.target),
      permission: r.permission as AccountingPermission,
      granted: Number(r.granted) === 1,
    }));
  }
}
