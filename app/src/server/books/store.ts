import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SheetsFailure } from './sheets.js';
import {
  DEFAULT_FISCAL_START_MONTH,
  DEFAULT_TAX_CLASS,
  type AccountInput,
  type AccountKind,
  type ClaimInput,
  type ClaimState,
  type EntryForm,
  type EntryInput,
  type JournalSource,
  type ReceiptType,
} from '../../shared/books.js';

// Books (会計の帳簿, 2026-11-05): one SQLite file (books.sqlite3) in the mail folder next to payments.sqlite3, so the
// folder's backup carries it, and the receipts' files in books-receipts/ beside it.
// - A journal (仕訳) has two or more lines (debit and credit), their totals equal. The plain entries (収入・支出・口座の
//   移動・振替) make two lines; a 弥生 file may bring more.
// - Nothing is deleted: a journal is withdrawn (voided), a claim is turned down or taken back, a receipt is marked
//   removed. The history keeps who did what and when.
// - Every change of a journal or a claim checks its version inside BEGIN IMMEDIATE ('conflict' from an older screen).
// - 弥生: a journal sent to 弥生 keeps the batch it went in; a change after that marks it so the accounting section
//   fixes it in 弥生 by hand (nothing is sent twice). A journal that came from 弥生 is never sent back.

export const BOOKS_FILE = 'books.sqlite3';
export const RECEIPTS_DIR = 'books-receipts';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sub TEXT NOT NULL,
  kind TEXT NOT NULL,
  grp TEXT NOT NULL,
  money INTEGER NOT NULL,
  label TEXT NOT NULL,
  tax_class TEXT NOT NULL,
  active INTEGER NOT NULL,
  sort INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_name ON accounts(name, sub);
CREATE TABLE IF NOT EXISTS journals(
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  client_token TEXT UNIQUE,
  fiscal_year INTEGER NOT NULL,
  date TEXT NOT NULL,
  form TEXT NOT NULL,
  entry_json TEXT,
  counterparty TEXT NOT NULL,
  memo TEXT NOT NULL,
  department TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  claim_id TEXT,
  yayoi_no TEXT NOT NULL DEFAULT '',
  yayoi_key TEXT,
  sticky INTEGER NOT NULL DEFAULT 0,
  voided INTEGER NOT NULL DEFAULT 0,
  void_note TEXT NOT NULL DEFAULT '',
  yayoi_batch TEXT,
  yayoi_dirty INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journals_year ON journals(fiscal_year, date, seq);
CREATE INDEX IF NOT EXISTS journals_source ON journals(source, source_ref);
CREATE INDEX IF NOT EXISTS journals_yayoi_key ON journals(yayoi_key);
CREATE TABLE IF NOT EXISTS lines(
  journal_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  side TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  tax_class TEXT NOT NULL,
  department TEXT NOT NULL,
  partner TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(journal_id, line_no)
);
CREATE INDEX IF NOT EXISTS lines_account ON lines(account_id);
CREATE TABLE IF NOT EXISTS claims(
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  client_token TEXT UNIQUE,
  fiscal_year INTEGER NOT NULL,
  claimant_id TEXT NOT NULL,
  claimant_name TEXT NOT NULL,
  spent_on TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  payee TEXT NOT NULL,
  purpose TEXT NOT NULL,
  department TEXT NOT NULL,
  account_id TEXT,
  preapproval TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  accrual_journal_id TEXT,
  payment_journal_id TEXT,
  approved_at TEXT,
  approved_by TEXT,
  paid_on TEXT,
  paid_from TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_seq ON claims(fiscal_year, seq);
CREATE INDEX IF NOT EXISTS claims_claimant ON claims(claimant_id);
CREATE TABLE IF NOT EXISTS receipts(
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT
);
CREATE INDEX IF NOT EXISTS receipts_owner ON receipts(owner_kind, owner_id);
CREATE TABLE IF NOT EXISTS budgets(fiscal_year INTEGER NOT NULL, account_name TEXT NOT NULL, amount_yen INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(fiscal_year, account_name));
CREATE TABLE IF NOT EXISTS openings(fiscal_year INTEGER NOT NULL, account_id TEXT NOT NULL, amount_yen INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(fiscal_year, account_id));
CREATE TABLE IF NOT EXISTS deposit_links(
  deposit_id TEXT PRIMARY KEY,
  journal_id TEXT,
  note TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS yayoi_exports(
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  count INTEGER NOT NULL,
  date_from TEXT,
  date_to TEXT,
  csv BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS yayoi_imports(id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL, added INTEGER NOT NULL, changed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS history_subject ON history(subject, subject_id, id);
`;

export interface AccountRow {
  id: string;
  name: string;
  sub: string;
  kind: AccountKind;
  grp: string;
  money: number;
  label: string;
  tax_class: string;
  active: number;
  sort: number;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface LineRow {
  journal_id: string;
  line_no: number;
  side: 'debit' | 'credit';
  account_id: string;
  amount_yen: number;
  tax_class: string;
  department: string;
  partner: string;
}

export interface JournalRow {
  id: string;
  seq: number;
  client_token: string | null;
  fiscal_year: number;
  date: string;
  form: EntryForm | 'compound';
  entry_json: string | null;
  counterparty: string;
  memo: string;
  department: string;
  source: JournalSource;
  source_ref: string | null;
  claim_id: string | null;
  yayoi_no: string;
  yayoi_key: string | null;
  sticky: number;
  voided: number;
  void_note: string;
  yayoi_batch: string | null;
  yayoi_dirty: number;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface ClaimRow {
  id: string;
  seq: number;
  client_token: string | null;
  fiscal_year: number;
  claimant_id: string;
  claimant_name: string;
  spent_on: string;
  amount_yen: number;
  payee: string;
  purpose: string;
  department: string;
  account_id: string | null;
  preapproval: string;
  state: ClaimState;
  note: string;
  accrual_journal_id: string | null;
  payment_journal_id: string | null;
  approved_at: string | null;
  approved_by: string | null;
  paid_on: string | null;
  paid_from: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface ReceiptRow {
  id: string;
  owner_kind: 'claim' | 'journal';
  owner_id: string;
  name: string;
  type: ReceiptType;
  bytes: number;
  sha256: string;
  uploaded_at: string;
  uploaded_by: string;
  removed_at: string | null;
}

export interface HistoryRow {
  id: number;
  subject: string;
  subject_id: string;
  at: string;
  actor_id: string;
  action: string;
  detail: Record<string, unknown> | null;
}

export interface NewLine {
  side: 'debit' | 'credit';
  accountId: string;
  amountYen: number;
  taxClass: string;
  department: string;
  /** 弥生's 取引先名 of this side (27-column files). */
  partner: string;
}

export interface NewJournal {
  date: string;
  fiscalYear: number;
  form: EntryForm | 'compound';
  entry: EntryInput | null;
  counterparty: string;
  memo: string;
  department: string;
  source: JournalSource;
  sourceRef: string | null;
  claimId: string | null;
  yayoiNo: string;
  yayoiKey: string | null;
  sticky: number;
  lines: NewLine[];
}

/** What made a write stop: the routes turn each into a message. */
export type BooksRefusal =
  | 'conflict'
  | 'voided'
  | 'not_voided'
  | 'unbalanced'
  | 'account_unknown'
  | 'account_inactive'
  | 'account_taken'
  | 'claim_state'
  | 'not_editable'
  | 'receipts_full'
  | 'claim_account_unset'
  | 'deposit_booked';

export class BooksRefused extends Error {
  constructor(readonly reason: BooksRefusal) {
    super(reason);
  }
}

const num = (row: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (row[k] !== null && row[k] !== undefined) row[k] = Number(row[k]);
};
const accountRow = (raw: unknown): AccountRow => {
  const r = raw as Record<string, unknown>;
  num(r, 'money', 'active', 'sort', 'version');
  return r as unknown as AccountRow;
};
const journalRow = (raw: unknown): JournalRow => {
  const r = raw as Record<string, unknown>;
  num(r, 'seq', 'fiscal_year', 'sticky', 'voided', 'yayoi_dirty', 'version');
  return r as unknown as JournalRow;
};
const lineRow = (raw: unknown): LineRow => {
  const r = raw as Record<string, unknown>;
  num(r, 'line_no', 'amount_yen');
  return r as unknown as LineRow;
};
const claimRow = (raw: unknown): ClaimRow => {
  const r = raw as Record<string, unknown>;
  num(r, 'seq', 'fiscal_year', 'amount_yen', 'version');
  return r as unknown as ClaimRow;
};
const receiptRow = (raw: unknown): ReceiptRow => {
  const r = raw as Record<string, unknown>;
  num(r, 'bytes');
  return r as unknown as ReceiptRow;
};

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

export const journalNumber = (seq: number) => `J-${String(seq).padStart(6, '0')}`;
export const claimNumber = (year: number, seq: number) => `TK-${year}-${String(seq).padStart(3, '0')}`;

export class BooksStore {
  readonly db: DatabaseSync;
  readonly receiptsDir: string;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.receiptsDir = path.join(root, RECEIPTS_DIR);
    this.db = new DatabaseSync(path.join(root, BOOKS_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('books schema version');
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
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

  addHistory(subject: string, subjectId: string, actor: string, now: string, action: string, detail: Record<string, unknown> | null): void {
    this.db.prepare('INSERT INTO history(subject,subject_id,at,actor_id,action,detail_json) VALUES(?,?,?,?,?,?)').run(subject, subjectId, now, actor, action, detail ? JSON.stringify(detail) : null);
  }

  history(subject: string, subjectId: string, limit = 60): HistoryRow[] {
    const rows = this.db.prepare('SELECT * FROM history WHERE subject=? AND subject_id=? ORDER BY id DESC LIMIT ?').all(subject, subjectId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      subject: String(r.subject),
      subject_id: String(r.subject_id),
      at: String(r.at),
      actor_id: String(r.actor_id),
      action: String(r.action),
      detail: r.detail_json ? (JSON.parse(String(r.detail_json)) as Record<string, unknown>) : null,
    }));
  }

  recentHistory(subjects: string[], limit = 30): HistoryRow[] {
    const rows = this.db.prepare(`SELECT * FROM history WHERE subject IN (${subjects.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(...subjects, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      subject: String(r.subject),
      subject_id: String(r.subject_id),
      at: String(r.at),
      actor_id: String(r.actor_id),
      action: String(r.action),
      detail: r.detail_json ? (JSON.parse(String(r.detail_json)) as Record<string, unknown>) : null,
    }));
  }

  // ---- settings

  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  fiscalStartMonth(): number {
    return this.setting('fiscalStartMonth', DEFAULT_FISCAL_START_MONTH);
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key=?').run(key);
    else this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  /** A number that changes with every write that the spreadsheet shows (the sync compares it). */
  bumpRevision(): void {
    const n = Number(this.meta('revision') ?? '0') + 1;
    this.setMeta('revision', String(n));
  }

  revision(): number {
    return Number(this.meta('revision') ?? '0');
  }

  /** The spreadsheet's last write, kept with the book (the status shown in the app survives a restart). */
  sheetsState(): { lastOkAt: string | null; lastAttemptAt: string | null; lastError: SheetsFailure | null; syncedRevision: number } {
    return {
      lastOkAt: this.meta('sheets.lastOkAt'),
      lastAttemptAt: this.meta('sheets.lastAttemptAt'),
      lastError: this.meta('sheets.lastError') as SheetsFailure | null,
      syncedRevision: Number(this.meta('sheets.syncedRevision') ?? '0'),
    };
  }

  setSheetsState(s: { lastOkAt: string | null; lastAttemptAt: string | null; lastError: SheetsFailure | null; syncedRevision: number }): void {
    this.setMeta('sheets.lastOkAt', s.lastOkAt);
    this.setMeta('sheets.lastAttemptAt', s.lastAttemptAt);
    this.setMeta('sheets.lastError', s.lastError);
    this.setMeta('sheets.syncedRevision', String(s.syncedRevision));
  }

  // ---- accounts

  accounts(): AccountRow[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY sort, name, sub, id').all().map(accountRow);
  }

  account(id: string): AccountRow | null {
    const raw = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    return raw ? accountRow(raw) : null;
  }

  accountByName(name: string, sub: string): AccountRow | null {
    const raw = this.db.prepare('SELECT * FROM accounts WHERE name=? AND sub=?').get(name, sub);
    return raw ? accountRow(raw) : null;
  }

  usedAccountIds(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT account_id FROM lines').all() as { account_id: string }[];
    const out = new Set(rows.map((r) => r.account_id));
    for (const r of this.db.prepare('SELECT DISTINCT account_id FROM openings').all() as { account_id: string }[]) out.add(r.account_id);
    return out;
  }

  private nextSort(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sort),0) AS n FROM accounts').get() as { n: number };
    return Number(row.n) + 10;
  }

  /** Adds an account; refused when the same name and 補助科目 exist. Inside a transaction of the caller or its own. */
  insertAccount(input: AccountInput, actor: string, now: string): AccountRow {
    if (this.accountByName(input.name, input.sub)) throw new BooksRefused('account_taken');
    const id = newId('ac');
    this.db
      .prepare('INSERT INTO accounts(id,name,sub,kind,grp,money,label,tax_class,active,sort,version,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)')
      .run(id, input.name, input.sub, input.kind, input.group, input.money ? 1 : 0, input.label, input.taxClass, input.active ? 1 : 0, this.nextSort(), now, now, actor);
    this.addHistory('account', id, actor, now, 'account_created', { name: input.name, sub: input.sub });
    return this.account(id)!;
  }

  createAccount(input: AccountInput, actor: string, now: string): AccountRow {
    return this.tx(() => {
      const row = this.insertAccount(input, actor, now);
      this.bumpRevision();
      return row;
    });
  }

  /**
   * Changes an account. Its name and 補助科目 can change only while no journal uses it (journals sent to 弥生 name it;
   * a used account is turned off and a new one added instead).
   */
  updateAccount(id: string, expectedVersion: number, input: AccountInput, actor: string, now: string): AccountRow | null {
    return this.tx(() => {
      const before = this.account(id);
      if (!before) return null;
      if (before.version !== expectedVersion) throw new BooksRefused('conflict');
      const renamed = before.name !== input.name || before.sub !== input.sub;
      if (renamed && this.usedAccountIds().has(id)) throw new BooksRefused('not_editable');
      if (renamed && this.accountByName(input.name, input.sub)) throw new BooksRefused('account_taken');
      this.db
        .prepare('UPDATE accounts SET name=?,sub=?,kind=?,grp=?,money=?,label=?,tax_class=?,active=?,version=version+1,updated_at=?,updated_by=? WHERE id=?')
        .run(input.name, input.sub, input.kind, input.group, input.money ? 1 : 0, input.label, input.taxClass, input.active ? 1 : 0, now, actor, id);
      this.addHistory('account', id, actor, now, 'account_updated', { name: input.name, sub: input.sub });
      this.bumpRevision();
      return this.account(id);
    });
  }

  // ---- journals

  journal(id: string): JournalRow | null {
    const raw = this.db.prepare('SELECT * FROM journals WHERE id=?').get(id);
    return raw ? journalRow(raw) : null;
  }

  journalByToken(token: string): JournalRow | null {
    const raw = this.db.prepare('SELECT * FROM journals WHERE client_token=?').get(token);
    return raw ? journalRow(raw) : null;
  }

  journalBySeq(seq: number): JournalRow | null {
    const raw = this.db.prepare('SELECT * FROM journals WHERE seq=?').get(seq);
    return raw ? journalRow(raw) : null;
  }

  journalsOfYear(fiscalYear: number, includeVoided = true): JournalRow[] {
    return this.db
      .prepare(`SELECT * FROM journals WHERE fiscal_year=? ${includeVoided ? '' : 'AND voided=0'} ORDER BY date, seq`)
      .all(fiscalYear)
      .map(journalRow);
  }

  allJournals(): JournalRow[] {
    return this.db.prepare('SELECT * FROM journals ORDER BY date, seq').all().map(journalRow);
  }

  lines(journalId: string): LineRow[] {
    return this.db.prepare('SELECT * FROM lines WHERE journal_id=? ORDER BY line_no').all(journalId).map(lineRow);
  }

  /** The lines of many journals at once (the lists), by journal. */
  linesOf(journalIds: string[]): Map<string, LineRow[]> {
    const out = new Map<string, LineRow[]>();
    for (let i = 0; i < journalIds.length; i += 500) {
      const part = journalIds.slice(i, i + 500);
      if (part.length === 0) continue;
      const rows = this.db.prepare(`SELECT * FROM lines WHERE journal_id IN (${part.map(() => '?').join(',')}) ORDER BY journal_id, line_no`).all(...part).map(lineRow);
      for (const r of rows) {
        const list = out.get(r.journal_id) ?? [];
        list.push(r);
        out.set(r.journal_id, list);
      }
    }
    return out;
  }

  /** Every live line of a fiscal year with its journal's date (the reports and the balances). */
  yearLines(fiscalYear: number): (LineRow & { date: string })[] {
    return this.db
      .prepare('SELECT l.*, j.date AS date FROM lines l JOIN journals j ON j.id=l.journal_id WHERE j.fiscal_year=? AND j.voided=0 ORDER BY j.date, j.seq, l.line_no')
      .all(fiscalYear)
      .map((r) => lineRow(r) as LineRow & { date: string });
  }

  private checkLines(lines: NewLine[]): void {
    if (lines.length < 2) throw new BooksRefused('unbalanced');
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      const a = this.account(l.accountId);
      if (!a) throw new BooksRefused('account_unknown');
      if (!Number.isSafeInteger(l.amountYen) || l.amountYen < 0) throw new BooksRefused('unbalanced');
      if (l.side === 'debit') debit += l.amountYen;
      else credit += l.amountYen;
    }
    if (debit !== credit || debit === 0) throw new BooksRefused('unbalanced');
  }

  private writeLines(journalId: string, lines: NewLine[]): void {
    this.db.prepare('DELETE FROM lines WHERE journal_id=?').run(journalId);
    const insert = this.db.prepare('INSERT INTO lines(journal_id,line_no,side,account_id,amount_yen,tax_class,department,partner) VALUES(?,?,?,?,?,?,?,?)');
    lines.forEach((l, i) => insert.run(journalId, i + 1, l.side, l.accountId, l.amountYen, l.taxClass, l.department, l.partner));
  }

  /** Adds a journal (inside the caller's transaction). Accounts must exist; the inactive ones are refused for new input. */
  insertJournal(j: NewJournal, clientToken: string | null, actor: string, now: string, allowInactive = false): JournalRow {
    this.checkLines(j.lines);
    if (!allowInactive && j.lines.some((l) => this.account(l.accountId)?.active === 0)) throw new BooksRefused('account_inactive');
    const id = newId('jn');
    const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM journals').get() as { n: number }).n);
    this.db
      .prepare(
        `INSERT INTO journals(id,seq,client_token,fiscal_year,date,form,entry_json,counterparty,memo,department,source,source_ref,claim_id,yayoi_no,yayoi_key,sticky,version,created_at,created_by,updated_at,updated_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      )
      .run(id, seq, clientToken, j.fiscalYear, j.date, j.form, j.entry ? JSON.stringify(j.entry) : null, j.counterparty, j.memo, j.department, j.source, j.sourceRef, j.claimId, j.yayoiNo, j.yayoiKey, j.sticky, now, actor, now, actor);
    this.writeLines(id, j.lines);
    this.addHistory('journal', id, actor, now, 'journal_created', { source: j.source, amountYen: j.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amountYen, 0) });
    this.bumpRevision();
    return this.journal(id)!;
  }

  createJournal(j: NewJournal, clientToken: string, actor: string, now: string): JournalRow {
    return this.tx(() => {
      const again = this.journalByToken(clientToken);
      if (again) return again;
      return this.insertJournal(j, clientToken, actor, now);
    });
  }

  private checked(id: string, expectedVersion: number): JournalRow {
    const row = this.journal(id);
    if (!row) throw new BooksRefused('conflict');
    if (row.version !== expectedVersion) throw new BooksRefused('conflict');
    return row;
  }

  /** Changes an entry made from a form (収入・支出…). Journals of claims, deposits and 弥生 are changed through those. */
  updateJournal(id: string, expectedVersion: number, j: NewJournal, actor: string, now: string): JournalRow | null {
    return this.tx(() => {
      if (!this.journal(id)) return null;
      const before = this.checked(id, expectedVersion);
      if (before.voided === 1) throw new BooksRefused('voided');
      if (before.source !== 'manual') throw new BooksRefused('not_editable');
      this.checkLines(j.lines);
      const beforeLines = this.lines(id);
      if (j.lines.some((l) => this.account(l.accountId)?.active === 0 && !beforeLines.some((b) => b.account_id === l.accountId))) throw new BooksRefused('account_inactive');
      this.db
        .prepare(
          `UPDATE journals SET fiscal_year=?,date=?,form=?,entry_json=?,counterparty=?,memo=?,department=?,version=version+1,updated_at=?,updated_by=?,
           yayoi_dirty=CASE WHEN yayoi_batch IS NULL THEN 0 ELSE 1 END WHERE id=?`,
        )
        .run(j.fiscalYear, j.date, j.form, j.entry ? JSON.stringify(j.entry) : null, j.counterparty, j.memo, j.department, now, actor, id);
      this.writeLines(id, j.lines);
      this.addHistory('journal', id, actor, now, 'journal_updated', { exported: before.yayoi_batch !== null });
      this.bumpRevision();
      return this.journal(id);
    });
  }

  /** Withdraws a journal (取り消し). Inside the caller's transaction. */
  voidJournalIn(id: string, note: string, actor: string, now: string): void {
    this.db
      .prepare('UPDATE journals SET voided=1, void_note=?, version=version+1, updated_at=?, updated_by=?, yayoi_dirty=CASE WHEN yayoi_batch IS NULL THEN 0 ELSE 1 END WHERE id=?')
      .run(note, now, actor, id);
    this.addHistory('journal', id, actor, now, 'journal_voided', { note });
    this.bumpRevision();
  }

  voidJournal(id: string, expectedVersion: number, note: string, actor: string, now: string, allowSources: JournalSource[] = ['manual', 'deposit', 'yayoi']): JournalRow | null {
    return this.tx(() => {
      if (!this.journal(id)) return null;
      const before = this.checked(id, expectedVersion);
      if (before.voided === 1) throw new BooksRefused('voided');
      if (!allowSources.includes(before.source)) throw new BooksRefused('not_editable');
      this.voidJournalIn(id, note, actor, now);
      if (before.source === 'deposit' && before.source_ref) this.db.prepare('DELETE FROM deposit_links WHERE deposit_id=? AND journal_id=?').run(before.source_ref, id);
      return this.journal(id);
    });
  }

  restoreJournal(id: string, expectedVersion: number, actor: string, now: string): JournalRow | null {
    return this.tx(() => {
      if (!this.journal(id)) return null;
      const before = this.checked(id, expectedVersion);
      if (before.voided !== 1) throw new BooksRefused('not_voided');
      if (before.source !== 'manual' && before.source !== 'yayoi') throw new BooksRefused('not_editable');
      this.db
        .prepare("UPDATE journals SET voided=0, void_note='', version=version+1, updated_at=?, updated_by=?, yayoi_dirty=CASE WHEN yayoi_batch IS NULL THEN 0 ELSE 1 END WHERE id=?")
        .run(now, actor, id);
      this.addHistory('journal', id, actor, now, 'journal_restored', null);
      this.bumpRevision();
      return this.journal(id);
    });
  }

  // ---- claims

  claim(id: string): ClaimRow | null {
    const raw = this.db.prepare('SELECT * FROM claims WHERE id=?').get(id);
    return raw ? claimRow(raw) : null;
  }

  claimByToken(token: string): ClaimRow | null {
    const raw = this.db.prepare('SELECT * FROM claims WHERE client_token=?').get(token);
    return raw ? claimRow(raw) : null;
  }

  claimsOfYear(fiscalYear: number): ClaimRow[] {
    return this.db.prepare('SELECT * FROM claims WHERE fiscal_year=? ORDER BY seq DESC').all(fiscalYear).map(claimRow);
  }

  claimsOf(claimantId: string, fiscalYear: number): ClaimRow[] {
    return this.db.prepare('SELECT * FROM claims WHERE claimant_id=? AND fiscal_year=? ORDER BY seq DESC').all(claimantId, fiscalYear).map(claimRow);
  }

  allClaims(): ClaimRow[] {
    return this.db.prepare('SELECT * FROM claims ORDER BY fiscal_year, seq').all().map(claimRow);
  }

  /** Approved claims not yet paid back, any year (a claim of December is paid in January). */
  owedClaims(): ClaimRow[] {
    return this.db.prepare("SELECT * FROM claims WHERE state='approved' ORDER BY claimant_name, spent_on, seq").all().map(claimRow);
  }

  createClaim(input: ClaimInput, fiscalYear: number, claimant: { id: string; name: string }, clientToken: string, now: string): ClaimRow {
    return this.tx(() => {
      const again = this.claimByToken(clientToken);
      if (again) return again;
      const id = newId('cl');
      const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM claims WHERE fiscal_year=?').get(fiscalYear) as { n: number }).n);
      this.db
        .prepare(
          `INSERT INTO claims(id,seq,client_token,fiscal_year,claimant_id,claimant_name,spent_on,amount_yen,payee,purpose,department,account_id,preapproval,state,version,created_at,updated_at,updated_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',1,?,?,?)`,
        )
        .run(id, seq, clientToken, fiscalYear, claimant.id, claimant.name, input.spentOn, input.amountYen, input.payee, input.purpose, input.department, input.accountId, input.preapproval, now, now, claimant.id);
      this.addHistory('claim', id, claimant.id, now, 'claim_submitted', { amountYen: input.amountYen });
      this.bumpRevision();
      return this.claim(id)!;
    });
  }

  private checkedClaim(id: string, expectedVersion: number): ClaimRow {
    const row = this.claim(id);
    if (!row || row.version !== expectedVersion) throw new BooksRefused('conflict');
    return row;
  }

  /** The member changes a claim while it waits (確認待ち) or after it was turned down (差し戻し: it waits again). */
  updateClaim(id: string, expectedVersion: number, input: ClaimInput, fiscalYear: number, actor: string, now: string): ClaimRow | null {
    return this.tx(() => {
      if (!this.claim(id)) return null;
      const before = this.checkedClaim(id, expectedVersion);
      if (before.state !== 'submitted' && before.state !== 'rejected') throw new BooksRefused('claim_state');
      let seq = before.seq;
      if (fiscalYear !== before.fiscal_year) seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM claims WHERE fiscal_year=?').get(fiscalYear) as { n: number }).n);
      this.db
        .prepare(
          `UPDATE claims SET fiscal_year=?,seq=?,spent_on=?,amount_yen=?,payee=?,purpose=?,department=?,account_id=?,preapproval=?,state='submitted',note='',version=version+1,updated_at=?,updated_by=? WHERE id=?`,
        )
        .run(fiscalYear, seq, input.spentOn, input.amountYen, input.payee, input.purpose, input.department, input.accountId, input.preapproval, now, actor, id);
      this.addHistory('claim', id, actor, now, before.state === 'rejected' ? 'claim_resubmitted' : 'claim_updated', { amountYen: input.amountYen });
      this.bumpRevision();
      return this.claim(id);
    });
  }

  setClaimState(id: string, expectedVersion: number, from: ClaimState[], to: ClaimState, note: string, actor: string, now: string, action: string): ClaimRow | null {
    return this.tx(() => {
      if (!this.claim(id)) return null;
      const before = this.checkedClaim(id, expectedVersion);
      if (!from.includes(before.state)) throw new BooksRefused('claim_state');
      this.db.prepare('UPDATE claims SET state=?, note=?, version=version+1, updated_at=?, updated_by=? WHERE id=?').run(to, note, now, actor, id);
      this.addHistory('claim', id, actor, now, action, note ? { note } : null);
      this.bumpRevision();
      return this.claim(id);
    });
  }

  /** Approves a claim: its spending goes into the books (the account against the claim account) in one transaction. */
  approveClaim(id: string, expectedVersion: number, accountId: string, journal: (claim: ClaimRow) => NewJournal, actor: string, now: string): ClaimRow | null {
    return this.tx(() => {
      if (!this.claim(id)) return null;
      const before = this.checkedClaim(id, expectedVersion);
      if (before.state !== 'submitted') throw new BooksRefused('claim_state');
      const j = this.insertJournal(journal({ ...before, account_id: accountId }), null, actor, now);
      this.db
        .prepare("UPDATE claims SET state='approved', account_id=?, accrual_journal_id=?, approved_at=?, approved_by=?, note='', version=version+1, updated_at=?, updated_by=? WHERE id=?")
        .run(accountId, j.id, now, actor, now, actor, id);
      this.addHistory('claim', id, actor, now, 'claim_approved', { journal: j.seq });
      return this.claim(id);
    });
  }

  /** Takes an approval back (承認を取り消す): its journal is withdrawn and the claim waits again. Not after it was paid. */
  unapproveClaim(id: string, expectedVersion: number, note: string, actor: string, now: string): ClaimRow | null {
    return this.tx(() => {
      if (!this.claim(id)) return null;
      const before = this.checkedClaim(id, expectedVersion);
      if (before.state !== 'approved') throw new BooksRefused('claim_state');
      if (before.accrual_journal_id) this.voidJournalIn(before.accrual_journal_id, note || '承認の取り消し', actor, now);
      this.db.prepare("UPDATE claims SET state='submitted', accrual_journal_id=NULL, approved_at=NULL, approved_by=NULL, version=version+1, updated_at=?, updated_by=? WHERE id=?").run(now, actor, id);
      this.addHistory('claim', id, actor, now, 'claim_unapproved', note ? { note } : null);
      return this.claim(id);
    });
  }

  /** Pays approved claims back (返金): one journal each, the same day and account. All or nothing. */
  payClaims(items: { id: string; expectedVersion: number }[], paidOn: string, moneyAccountId: string, journal: (claim: ClaimRow) => NewJournal, actor: string, now: string): ClaimRow[] {
    return this.tx(() => {
      const out: ClaimRow[] = [];
      for (const item of items) {
        const before = this.checkedClaim(item.id, item.expectedVersion);
        if (before.state !== 'approved') throw new BooksRefused('claim_state');
        const j = this.insertJournal(journal(before), null, actor, now);
        this.db
          .prepare("UPDATE claims SET state='paid', payment_journal_id=?, paid_on=?, paid_from=?, version=version+1, updated_at=?, updated_by=? WHERE id=?")
          .run(j.id, paidOn, moneyAccountId, now, actor, item.id);
        this.addHistory('claim', item.id, actor, now, 'claim_paid', { journal: j.seq, paidOn });
        out.push(this.claim(item.id)!);
      }
      return out;
    });
  }

  /** Takes a payment back (返金を取り消す): its journal is withdrawn and the claim is owed again. */
  unpayClaim(id: string, expectedVersion: number, note: string, actor: string, now: string): ClaimRow | null {
    return this.tx(() => {
      if (!this.claim(id)) return null;
      const before = this.checkedClaim(id, expectedVersion);
      if (before.state !== 'paid') throw new BooksRefused('claim_state');
      if (before.payment_journal_id) this.voidJournalIn(before.payment_journal_id, note || '返金の取り消し', actor, now);
      this.db.prepare("UPDATE claims SET state='approved', payment_journal_id=NULL, paid_on=NULL, paid_from=NULL, version=version+1, updated_at=?, updated_by=? WHERE id=?").run(now, actor, id);
      this.addHistory('claim', id, actor, now, 'claim_unpaid', note ? { note } : null);
      return this.claim(id);
    });
  }

  // ---- receipts

  receipts(ownerKind: 'claim' | 'journal', ownerId: string): ReceiptRow[] {
    return this.db.prepare('SELECT * FROM receipts WHERE owner_kind=? AND owner_id=? AND removed_at IS NULL ORDER BY uploaded_at, id').all(ownerKind, ownerId).map(receiptRow);
  }

  receiptsOf(ownerKind: 'claim' | 'journal', ownerIds: string[]): Map<string, ReceiptRow[]> {
    const out = new Map<string, ReceiptRow[]>();
    for (let i = 0; i < ownerIds.length; i += 500) {
      const part = ownerIds.slice(i, i + 500);
      if (part.length === 0) continue;
      const rows = this.db
        .prepare(`SELECT * FROM receipts WHERE owner_kind=? AND removed_at IS NULL AND owner_id IN (${part.map(() => '?').join(',')}) ORDER BY uploaded_at, id`)
        .all(ownerKind, ...part)
        .map(receiptRow);
      for (const r of rows) {
        const list = out.get(r.owner_id) ?? [];
        list.push(r);
        out.set(r.owner_id, list);
      }
    }
    return out;
  }

  receipt(id: string): ReceiptRow | null {
    const raw = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    return raw ? receiptRow(raw) : null;
  }

  /** Keeps a receipt's file (written first, renamed into place) and its row. At most `max` live receipts an owner. */
  addReceipt(ownerKind: 'claim' | 'journal', ownerId: string, file: { name: string; type: ReceiptType; data: Buffer }, max: number, actor: string, now: string): ReceiptRow {
    mkdirSync(this.receiptsDir, { recursive: true });
    const id = newId('rc');
    const target = path.join(this.receiptsDir, id);
    const temp = `${target}.tmp`;
    writeFileSync(temp, file.data, { mode: 0o600 });
    try {
      return this.tx(() => {
        if (this.receipts(ownerKind, ownerId).length >= max) throw new BooksRefused('receipts_full');
        renameSync(temp, target);
        const sha = createHash('sha256').update(file.data).digest('hex');
        this.db
          .prepare('INSERT INTO receipts(id,owner_kind,owner_id,name,type,bytes,sha256,uploaded_at,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, ownerKind, ownerId, file.name, file.type, file.data.length, sha, now, actor);
        this.addHistory(ownerKind, ownerId, actor, now, 'receipt_added', { name: file.name });
        this.bumpRevision();
        return this.receipt(id)!;
      });
    } catch (err) {
      rmSync(temp, { force: true });
      rmSync(target, { force: true });
      throw err;
    }
  }

  /** Marks a receipt removed (the file stays, as the books keep everything). */
  removeReceipt(id: string, actor: string, now: string): ReceiptRow | null {
    return this.tx(() => {
      const row = this.receipt(id);
      if (!row || row.removed_at !== null) return null;
      this.db.prepare('UPDATE receipts SET removed_at=?, removed_by=? WHERE id=?').run(now, actor, id);
      this.addHistory(row.owner_kind, row.owner_id, actor, now, 'receipt_removed', { name: row.name });
      this.bumpRevision();
      return this.receipt(id);
    });
  }

  receiptFile(row: ReceiptRow): Buffer {
    return readFileSync(path.join(this.receiptsDir, row.id));
  }

  // ---- budget and opening balances

  budget(fiscalYear: number): { account_name: string; amount_yen: number }[] {
    return (this.db.prepare('SELECT account_name, amount_yen FROM budgets WHERE fiscal_year=? ORDER BY account_name').all(fiscalYear) as { account_name: string; amount_yen: number }[]).map((r) => ({
      account_name: r.account_name,
      amount_yen: Number(r.amount_yen),
    }));
  }

  /** Replaces the budget of a year with these lines (lines left out are removed). */
  setBudget(fiscalYear: number, lines: { accountName: string; amountYen: number }[], actor: string, now: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM budgets WHERE fiscal_year=?').run(fiscalYear);
      const insert = this.db.prepare('INSERT INTO budgets(fiscal_year,account_name,amount_yen,updated_at,updated_by) VALUES(?,?,?,?,?)');
      for (const l of lines) insert.run(fiscalYear, l.accountName, l.amountYen, now, actor);
      this.addHistory('budget', String(fiscalYear), actor, now, 'budget_set', { lines: lines.length, totalYen: lines.reduce((s, l) => s + l.amountYen, 0) });
      this.bumpRevision();
    });
  }

  openings(fiscalYear: number): { account_id: string; amount_yen: number }[] {
    return (this.db.prepare('SELECT account_id, amount_yen FROM openings WHERE fiscal_year=?').all(fiscalYear) as { account_id: string; amount_yen: number }[]).map((r) => ({
      account_id: r.account_id,
      amount_yen: Number(r.amount_yen),
    }));
  }

  /** Every fiscal year the book has something in (journals, claims, budgets, opening balances), newest first. */
  years(): number[] {
    const rows = this.db
      .prepare('SELECT fiscal_year AS y FROM journals UNION SELECT fiscal_year FROM claims UNION SELECT fiscal_year FROM budgets UNION SELECT fiscal_year FROM openings ORDER BY 1 DESC')
      .all() as { y: number }[];
    return rows.map((r) => Number(r.y));
  }

  /** Replaces the opening balances of a year. Signed as a debit balance: positive on the debit side, negative on the credit side. */
  setOpenings(fiscalYear: number, rows: { accountId: string; amountYen: number }[], actor: string, now: string, inTx = false): void {
    const run = () => {
      this.db.prepare('DELETE FROM openings WHERE fiscal_year=?').run(fiscalYear);
      const insert = this.db.prepare('INSERT INTO openings(fiscal_year,account_id,amount_yen,updated_at,updated_by) VALUES(?,?,?,?,?)');
      for (const r of rows) if (r.amountYen !== 0) insert.run(fiscalYear, r.accountId, r.amountYen, now, actor);
      this.addHistory('openings', String(fiscalYear), actor, now, 'openings_set', { rows: rows.filter((r) => r.amountYen !== 0).length });
      this.bumpRevision();
    };
    if (inTx) run();
    else this.tx(run);
  }

  // ---- deposits of the payments screen

  depositLinks(): Map<string, { journal_id: string | null; note: string; at: string; actor_id: string }> {
    const rows = this.db.prepare('SELECT * FROM deposit_links').all() as { deposit_id: string; journal_id: string | null; note: string; at: string; actor_id: string }[];
    return new Map(rows.map((r) => [r.deposit_id, r]));
  }

  /** Books a confirmed deposit: a new journal, or a mark that it is in the books already (a 弥生 journal, with a note). */
  linkDeposit(depositId: string, make: (() => NewJournal) | null, note: string, actor: string, now: string): JournalRow | null {
    return this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM deposit_links WHERE deposit_id=?').get(depositId)) throw new BooksRefused('deposit_booked');
      const journal = make ? this.insertJournal(make(), null, actor, now) : null;
      this.db.prepare('INSERT INTO deposit_links(deposit_id,journal_id,note,at,actor_id) VALUES(?,?,?,?,?)').run(depositId, journal?.id ?? null, note, now, actor);
      this.addHistory('deposit', depositId, actor, now, journal ? 'deposit_booked' : 'deposit_marked', { journal: journal?.seq ?? null, note });
      this.bumpRevision();
      return journal;
    });
  }

  /** Takes a "booked elsewhere" mark back (a journal made from a deposit is withdrawn instead). */
  unlinkDeposit(depositId: string, actor: string, now: string): boolean {
    return this.tx(() => {
      const row = this.db.prepare('SELECT journal_id FROM deposit_links WHERE deposit_id=?').get(depositId) as { journal_id: string | null } | undefined;
      if (!row || row.journal_id !== null) return false;
      this.db.prepare('DELETE FROM deposit_links WHERE deposit_id=?').run(depositId);
      this.addHistory('deposit', depositId, actor, now, 'deposit_unmarked', null);
      this.bumpRevision();
      return true;
    });
  }

  // ---- 弥生

  /** Journals to send to 弥生: live, made here, not sent yet, of the year (up to a day if given). */
  unexported(fiscalYear: number, to: string | null): JournalRow[] {
    return this.db
      .prepare(`SELECT * FROM journals WHERE fiscal_year=? AND voided=0 AND source<>'yayoi' AND yayoi_batch IS NULL ${to ? 'AND date<=?' : ''} ORDER BY date, seq`)
      .all(...(to ? [fiscalYear, to] : [fiscalYear]))
      .map(journalRow);
  }

  /** Journals sent to 弥生 and changed (or withdrawn) since. */
  changedAfterExport(): JournalRow[] {
    return this.db.prepare('SELECT * FROM journals WHERE yayoi_batch IS NOT NULL AND yayoi_dirty=1 ORDER BY date, seq').all().map(journalRow);
  }

  /** The accounting section fixed it in 弥生 by hand: the mark goes. */
  clearExportChange(id: string, actor: string, now: string): boolean {
    return this.tx(() => {
      const r = this.db.prepare('UPDATE journals SET yayoi_dirty=0 WHERE id=? AND yayoi_dirty=1').run(id);
      if (Number(r.changes) === 0) return false;
      this.addHistory('journal', id, actor, now, 'yayoi_change_cleared', null);
      return true;
    });
  }

  recordExport(fiscalYear: number, journalIds: string[], range: { from: string | null; to: string | null }, csv: Buffer, actor: string, now: string): string {
    return this.tx(() => {
      const id = newId('yx');
      this.db.prepare('INSERT INTO yayoi_exports(id,at,actor_id,fiscal_year,count,date_from,date_to,csv) VALUES(?,?,?,?,?,?,?,?)').run(id, now, actor, fiscalYear, journalIds.length, range.from, range.to, csv);
      const mark = this.db.prepare('UPDATE journals SET yayoi_batch=?, yayoi_dirty=0 WHERE id=? AND yayoi_batch IS NULL');
      for (const j of journalIds) mark.run(id, j);
      this.addHistory('yayoi_export', id, actor, now, 'yayoi_exported', { count: journalIds.length });
      this.bumpRevision();
      return id;
    });
  }

  exports(limit = 20): { id: string; at: string; actor_id: string; fiscal_year: number; count: number; date_from: string | null; date_to: string | null }[] {
    return (this.db.prepare('SELECT id,at,actor_id,fiscal_year,count,date_from,date_to FROM yayoi_exports ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => {
      num(r, 'fiscal_year', 'count');
      return r as unknown as { id: string; at: string; actor_id: string; fiscal_year: number; count: number; date_from: string | null; date_to: string | null };
    });
  }

  exportFile(id: string): { csv: Buffer; at: string } | null {
    const row = this.db.prepare('SELECT csv, at FROM yayoi_exports WHERE id=?').get(id) as { csv: Uint8Array; at: string } | undefined;
    return row ? { csv: Buffer.from(row.csv), at: row.at } : null;
  }

  lastExportAt(): string | null {
    const row = this.db.prepare('SELECT MAX(at) AS at FROM yayoi_exports').get() as { at: string | null };
    return row.at ?? null;
  }

  /** Journals imported from 弥生 (and ours seen back) by their key: 伝票No and date. */
  journalsByYayoiKey(keys: string[]): Map<string, JournalRow> {
    const out = new Map<string, JournalRow>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 500) {
      const part = unique.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT * FROM journals WHERE yayoi_key IN (${part.map(() => '?').join(',')})`).all(...part).map(journalRow);
      for (const r of rows) out.set(r.yayoi_key!, r);
    }
    return out;
  }

  /** Notes 弥生's 伝票No of a journal made here, seen in 弥生's file (inside the caller's transaction). */
  setYayoiNo(id: string, yayoiNo: string, yayoiKey: string): void {
    this.db.prepare('UPDATE journals SET yayoi_no=?, yayoi_key=? WHERE id=?').run(yayoiNo, yayoiKey, id);
  }

  /** Replaces the content of a journal that came from 弥生 with what 弥生's newer file says (inside the caller's transaction). */
  replaceFromYayoi(id: string, j: NewJournal, actor: string, now: string): void {
    this.checkLines(j.lines);
    this.db
      .prepare('UPDATE journals SET fiscal_year=?,date=?,form=?,counterparty=?,memo=?,department=?,sticky=?,voided=0,void_note=\'\',version=version+1,updated_at=?,updated_by=? WHERE id=?')
      .run(j.fiscalYear, j.date, j.form, j.counterparty, j.memo, j.department, j.sticky, now, actor, id);
    this.writeLines(id, j.lines);
    this.addHistory('journal', id, actor, now, 'journal_updated_from_yayoi', null);
    this.bumpRevision();
  }

  recordYayoiImport(kind: 'journals' | 'openings', label: string, added: number, changed: number, actor: string, now: string): string {
    const id = newId('yi');
    this.db.prepare('INSERT INTO yayoi_imports(id,at,actor_id,label,kind,added,changed) VALUES(?,?,?,?,?,?,?)').run(id, now, actor, label, kind, added, changed);
    this.addHistory('yayoi_import', id, actor, now, 'yayoi_imported', { kind, added, changed });
    return id;
  }

  yayoiImports(limit = 10): { id: string; at: string; actor_id: string; label: string; kind: string; added: number; changed: number }[] {
    return (this.db.prepare('SELECT * FROM yayoi_imports ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => {
      num(r, 'added', 'changed');
      return r as unknown as { id: string; at: string; actor_id: string; label: string; kind: string; added: number; changed: number };
    });
  }

  /** The counts the backup notes in its manifest. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const table of ['accounts', 'journals', 'lines', 'claims', 'receipts', 'budgets', 'openings', 'deposit_links', 'yayoi_exports', 'history']) {
      out[table] = Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    }
    return out;
  }
}

/** Default tax class of a new line: the account's own (弥生's 税区分), else 対象外. */
export const taxOf = (a: AccountRow | null) => a?.tax_class || DEFAULT_TAX_CLASS;
