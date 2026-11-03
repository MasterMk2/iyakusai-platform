import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeContactSearch } from '../../shared/contacts.js';
import { orgNameKey, type OrgHistoryAction, type OrgInput, type OrgKind } from '../../shared/organizations.js';

// Organizations (団体の台帳): one SQLite file (organizations.sqlite3) next to contacts.sqlite3 in the mail folder,
// so the backups of the folder carry it. It has its own schema version, so it never touches contacts.sqlite3.
// Every change keeps a history row; an update, import, revert or delete keeps the state as it was before
// (before_json), so a mistaken change can be put back. A deleted organization cannot be put back from the screen: its
// last state stays in the history for the record. Mail templates and mail batches live here too: a batch
// keeps the exact subject and body that were checked, and one random token per recipient (the sending
// service's clientToken), so a sent message is never sent twice.

export const ORGANIZATIONS_FILE = 'organizations.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS organizations(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  department TEXT NOT NULL,
  owner_id TEXT,
  contact_id TEXT,
  status TEXT NOT NULL,
  search_text TEXT NOT NULL,
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS organizations_year_kind ON organizations(fiscal_year, kind, name);
CREATE INDEX IF NOT EXISTS organizations_key ON organizations(fiscal_year, name_key);
CREATE TABLE IF NOT EXISTS organization_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_json TEXT NOT NULL,
  before_json TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS organization_history_org ON organization_history(org_id, id);
CREATE TABLE IF NOT EXISTS mail_templates(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_batches(
  id TEXT PRIMARY KEY,
  client_token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  mailbox_address TEXT NOT NULL,
  template_name TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  locked_at TEXT,
  notice TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS mail_batch_items(
  batch_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  org_name TEXT NOT NULL,
  to_address TEXT NOT NULL,
  to_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  skip_reason TEXT,
  send_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  error TEXT,
  receipt_id TEXT,
  sent_at TEXT,
  PRIMARY KEY(batch_id, idx)
);
CREATE TABLE IF NOT EXISTS mail_batch_attachments(
  batch_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(batch_id, idx)
);
`;

export interface OrgRow {
  id: string;
  data: OrgInput;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface RawOrg {
  id: string;
  data_json: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface OrgFilter {
  kind?: OrgKind;
  fiscalYear?: number;
  status?: string;
  department?: string;
  ownerId?: string;
  /** Every term must be in the search text (search form). */
  terms: string[];
}

export interface HistoryRaw {
  id: number;
  org_id: string;
  at: string;
  actor_id: string;
  action: OrgHistoryAction;
  changed: string[];
  before: OrgInput | null;
  detail: { subject?: string; sent?: number; batchId?: string } | null;
}

export interface TemplateRow {
  id: string;
  name: string;
  subject: string;
  body: string;
  version: number;
  updated_at: string;
  updated_by: string;
}

export type BatchStatus = 'draft' | 'sending' | 'partial' | 'done';
export type ItemStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped';

export interface BatchRow {
  id: string;
  client_token: string;
  created_by: string;
  created_at: string;
  mailbox_id: string;
  mailbox_address: string;
  template_name: string | null;
  subject: string;
  status: BatchStatus;
  locked_at: string | null;
  notice: string | null;
  finished_at: string | null;
}

export interface BatchItemRow {
  batch_id: string;
  idx: number;
  org_id: string;
  org_name: string;
  to_address: string;
  to_name: string;
  subject: string;
  body: string;
  skip_reason: string | null;
  send_token: string;
  status: ItemStatus;
  error: string | null;
  receipt_id: string | null;
  sent_at: string | null;
}

const likeEscape = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** The text a search runs over: the organization's own words (names, department, content, notes). */
export function orgSearchText(data: OrgInput): string {
  return normalizeContactSearch([data.name, data.department, data.content, data.nextAction, data.notes, data.status].join('\n'));
}

export class OrganizationsStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, ORGANIZATIONS_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('organizations schema version');
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

  private static row(raw: RawOrg): OrgRow {
    return { id: raw.id, data: JSON.parse(raw.data_json) as OrgInput, version: Number(raw.version), created_at: raw.created_at, created_by: raw.created_by, updated_at: raw.updated_at, updated_by: raw.updated_by };
  }

  private where(f: OrgFilter, withStatus: boolean): { sql: string; params: (string | number)[] } {
    const parts: string[] = [];
    const params: (string | number)[] = [];
    for (const term of f.terms) {
      parts.push("search_text LIKE ? ESCAPE '\\'");
      params.push(`%${likeEscape(term)}%`);
    }
    if (f.kind !== undefined) {
      parts.push('kind = ?');
      params.push(f.kind);
    }
    if (f.fiscalYear !== undefined) {
      parts.push('fiscal_year = ?');
      params.push(f.fiscalYear);
    }
    if (f.department !== undefined) {
      parts.push('department = ?');
      params.push(f.department);
    }
    if (f.ownerId !== undefined) {
      parts.push('owner_id = ?');
      params.push(f.ownerId);
    }
    if (withStatus && f.status !== undefined) {
      parts.push('status = ?');
      params.push(f.status);
    }
    return { sql: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
  }

  page(f: OrgFilter, limit: number, offset: number): { total: number; rows: OrgRow[] } {
    const w = this.where(f, true);
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM organizations WHERE ${w.sql}`).get(...w.params) as { n: number }).n);
    const rows = this.db.prepare(`SELECT * FROM organizations WHERE ${w.sql} ORDER BY fiscal_year DESC, name, id LIMIT ? OFFSET ?`).all(...w.params, limit, offset) as unknown as RawOrg[];
    return { total, rows: rows.map(OrganizationsStore.row) };
  }

  /** Counts per status with every filter but the status applied (the status chips). */
  statusCounts(f: OrgFilter): Record<string, number> {
    const w = this.where(f, false);
    const rows = this.db.prepare(`SELECT status, count(*) AS n FROM organizations WHERE ${w.sql} GROUP BY status`).all(...w.params) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  get(id: string): OrgRow | null {
    const raw = this.db.prepare('SELECT * FROM organizations WHERE id=?').get(id) as unknown as RawOrg | undefined;
    return raw ? OrganizationsStore.row(raw) : null;
  }

  /** Organizations of one year with this name (for the import: the same name and year is an update). */
  byNameKey(fiscalYear: number, key: string): OrgRow[] {
    return (this.db.prepare('SELECT * FROM organizations WHERE fiscal_year=? AND name_key=? ORDER BY id').all(fiscalYear, key) as unknown as RawOrg[]).map(OrganizationsStore.row);
  }

  /** Every organization in one year (the import checks its rows against these). */
  allOfYear(fiscalYear: number): OrgRow[] {
    return (this.db.prepare('SELECT * FROM organizations WHERE fiscal_year=? ORDER BY id').all(fiscalYear) as unknown as RawOrg[]).map(OrganizationsStore.row);
  }

  /** The history of one organization, newest first. */
  history(orgId: string, limit = 60): HistoryRaw[] {
    const rows = this.db
      .prepare('SELECT id, org_id, at, actor_id, action, changed_json, before_json, detail_json FROM organization_history WHERE org_id=? ORDER BY id DESC LIMIT ?')
      .all(orgId, limit) as { id: number; org_id: string; at: string; actor_id: string; action: string; changed_json: string; before_json: string | null; detail_json: string | null }[];
    return rows.map((r) => ({
      id: Number(r.id),
      org_id: r.org_id,
      at: r.at,
      actor_id: r.actor_id,
      action: r.action as OrgHistoryAction,
      changed: JSON.parse(r.changed_json) as string[],
      before: r.before_json ? (JSON.parse(r.before_json) as OrgInput) : null,
      detail: r.detail_json ? (JSON.parse(r.detail_json) as HistoryRaw['detail']) : null,
    }));
  }

  historyRow(orgId: string, historyId: number): HistoryRaw | null {
    return this.history(orgId, 10_000).find((h) => h.id === historyId) ?? null;
  }

  private writeRow(id: string, data: OrgInput, version: number, actor: string, now: string, insert: boolean): void {
    const values = [data.kind, data.fiscalYear, data.name, orgNameKey(data.name), data.department, data.ownerId, data.contactId, data.status, orgSearchText(data), JSON.stringify(data), version];
    if (insert) {
      this.db
        .prepare('INSERT INTO organizations(id,kind,fiscal_year,name,name_key,department,owner_id,contact_id,status,search_text,data_json,version,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, ...values, now, actor, now, actor);
    } else {
      this.db
        .prepare('UPDATE organizations SET kind=?,fiscal_year=?,name=?,name_key=?,department=?,owner_id=?,contact_id=?,status=?,search_text=?,data_json=?,version=?,updated_at=?,updated_by=? WHERE id=?')
        .run(...values, now, actor, id);
    }
  }

  private addHistory(orgId: string, actor: string, now: string, action: OrgHistoryAction, changed: string[], before: OrgInput | null, detail: HistoryRaw['detail'] = null): void {
    this.db
      .prepare('INSERT INTO organization_history(org_id,at,actor_id,action,changed_json,before_json,detail_json) VALUES(?,?,?,?,?,?,?)')
      .run(orgId, now, actor, action, JSON.stringify(changed), before ? JSON.stringify(before) : null, detail ? JSON.stringify(detail) : null);
  }

  create(data: OrgInput, actor: string, now: string, action: 'created' | 'imported' = 'created'): OrgRow {
    return this.tx(() => {
      const id = `og_${randomBytes(8).toString('hex')}`;
      this.writeRow(id, data, 1, actor, now, true);
      this.addHistory(id, actor, now, action, [], null);
      return this.get(id)!;
    });
  }

  /**
   * Replaces the data of one organization. Null when it is gone; 'conflict' when someone saved it first.
   * `changed` is the list of field names that differ (computed by the caller for its messages).
   */
  update(id: string, expectedVersion: number, data: OrgInput, actor: string, now: string, action: 'updated' | 'imported' | 'reverted' = 'updated'): OrgRow | 'conflict' | null {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      const changed = changedFields(before.data, data);
      if (changed.length === 0) return before;
      this.writeRow(id, data, before.version + 1, actor, now, false);
      this.addHistory(id, actor, now, action, changed, before.data);
      return this.get(id)!;
    });
  }

  delete(id: string, expectedVersion: number, actor: string, now: string): 'deleted' | 'conflict' | null {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      this.db.prepare('DELETE FROM organizations WHERE id=?').run(id);
      this.addHistory(id, actor, now, 'deleted', [], before.data);
      return 'deleted';
    });
  }

  /** A sent mail, in the organization's history (the message itself is kept in the mailbox). */
  recordMail(orgId: string, actor: string, now: string, detail: { subject: string; sent: number; batchId: string }): void {
    this.tx(() => this.addHistory(orgId, actor, now, 'mail_sent', [], null, detail));
  }

  // ---- mail templates ----

  templates(): TemplateRow[] {
    return this.db.prepare('SELECT * FROM mail_templates ORDER BY name, id').all() as unknown as TemplateRow[];
  }

  template(id: string): TemplateRow | null {
    return (this.db.prepare('SELECT * FROM mail_templates WHERE id=?').get(id) as unknown as TemplateRow | undefined) ?? null;
  }

  createTemplate(input: { name: string; subject: string; body: string }, actor: string, now: string): TemplateRow {
    const id = `tp_${randomBytes(8).toString('hex')}`;
    this.db.prepare('INSERT INTO mail_templates(id,name,subject,body,version,updated_at,updated_by) VALUES(?,?,?,?,1,?,?)').run(id, input.name, input.subject, input.body, now, actor);
    return this.template(id)!;
  }

  /** Null when gone; 'conflict' when someone saved it first. */
  updateTemplate(id: string, expectedVersion: number, input: { name: string; subject: string; body: string }, actor: string, now: string): TemplateRow | 'conflict' | null {
    const before = this.template(id);
    if (!before) return null;
    if (before.version !== expectedVersion) return 'conflict';
    this.db
      .prepare('UPDATE mail_templates SET name=?,subject=?,body=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?')
      .run(input.name, input.subject, input.body, now, actor, id, expectedVersion);
    return this.template(id);
  }

  deleteTemplate(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM mail_templates WHERE id=?').run(id).changes) > 0;
  }

  // ---- mail batches ----

  batchByToken(token: string): BatchRow | null {
    return (this.db.prepare('SELECT * FROM mail_batches WHERE client_token=?').get(token) as unknown as BatchRow | undefined) ?? null;
  }

  batch(id: string): BatchRow | null {
    return (this.db.prepare('SELECT * FROM mail_batches WHERE id=?').get(id) as unknown as BatchRow | undefined) ?? null;
  }

  batchItems(batchId: string): BatchItemRow[] {
    return this.db.prepare('SELECT * FROM mail_batch_items WHERE batch_id=? ORDER BY idx').all(batchId) as unknown as BatchItemRow[];
  }

  /** A new draft with its items (each with a new token for its own message). Nothing is sent by this. */
  createBatch(
    batch: Omit<BatchRow, 'status' | 'locked_at' | 'notice' | 'finished_at'>,
    items: Omit<BatchItemRow, 'batch_id' | 'idx' | 'send_token' | 'status' | 'error' | 'receipt_id' | 'sent_at'>[],
  ): BatchRow {
    return this.tx(() => {
      this.db
        .prepare("INSERT INTO mail_batches(id,client_token,created_by,created_at,mailbox_id,mailbox_address,template_name,subject,status,locked_at,notice,finished_at) VALUES(?,?,?,?,?,?,?,?,'draft',NULL,NULL,NULL)")
        .run(batch.id, batch.client_token, batch.created_by, batch.created_at, batch.mailbox_id, batch.mailbox_address, batch.template_name, batch.subject);
      const insert = this.db.prepare(
        "INSERT INTO mail_batch_items(batch_id,idx,org_id,org_name,to_address,to_name,subject,body,skip_reason,send_token,status,error,receipt_id,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)",
      );
      items.forEach((item, idx) => {
        insert.run(batch.id, idx, item.org_id, item.org_name, item.to_address, item.to_name, item.subject, item.body, item.skip_reason, `tk_${randomBytes(24).toString('base64url')}`, item.skip_reason ? 'skipped' : 'pending');
      });
      return this.batch(batch.id)!;
    });
  }

  /**
   * Takes the batch for one sending request. Only its creator; a batch that is "sending" counts as taken for ten
   * minutes (after that it was cut off, and the items left "sending" become unknown). Returns false when taken.
   */
  claimBatch(id: string, actor: string, now: string, staleBefore: string): boolean {
    return this.tx(() => {
      const changes = Number(
        this.db
          .prepare("UPDATE mail_batches SET status='sending', locked_at=? WHERE id=? AND created_by=? AND (status IN ('draft','partial') OR (status='sending' AND locked_at < ?))")
          .run(now, id, actor, staleBefore).changes,
      );
      if (changes === 0) return false;
      // An item still "sending" was cut off mid-send: it may have gone out, so it is never sent again.
      this.db.prepare("UPDATE mail_batch_items SET status='unknown', error='送信の途中で止まりました' WHERE batch_id=? AND status='sending'").run(id);
      return true;
    });
  }

  /**
   * The next items to send: the pending ones, and with `includeFailed` the failed ones too (the user's 再送).
   * Only items after `afterIndex` are listed, so a retry that walks the batch forward meets each failed item once.
   * Unknown items are never listed: they may have gone out.
   */
  nextItems(batchId: string, limit: number, includeFailed: boolean, afterIndex = -1): BatchItemRow[] {
    const statuses = includeFailed ? "('pending','failed')" : "('pending')";
    return this.db.prepare(`SELECT * FROM mail_batch_items WHERE batch_id=? AND idx>? AND status IN ${statuses} ORDER BY idx LIMIT ?`).all(batchId, afterIndex, limit) as unknown as BatchItemRow[];
  }

  // ---- shared attachments of a batch (draft only; the screens and the API check that) ----

  batchAttachmentMeta(batchId: string): { index: number; filename: string; size: number }[] {
    const rows = this.db.prepare('SELECT idx, filename, length(content) AS size FROM mail_batch_attachments WHERE batch_id=? ORDER BY idx').all(batchId) as { idx: number; filename: string; size: number }[];
    return rows.map((r) => ({ index: Number(r.idx), filename: r.filename, size: Number(r.size) }));
  }

  /** The files as they are sent (the same for every message of the batch). */
  batchAttachments(batchId: string): { filename: string; contentType: string; content: Buffer }[] {
    const rows = this.db.prepare('SELECT filename, content_type, content FROM mail_batch_attachments WHERE batch_id=? ORDER BY idx').all(batchId) as { filename: string; content_type: string; content: Uint8Array }[];
    return rows.map((r) => ({ filename: r.filename, contentType: r.content_type, content: Buffer.from(r.content) }));
  }

  addBatchAttachments(batchId: string, files: { filename: string; contentType: string; content: Buffer }[]): void {
    this.tx(() => {
      const next = Number((this.db.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM mail_batch_attachments WHERE batch_id=?').get(batchId) as { n: number }).n);
      const insert = this.db.prepare('INSERT INTO mail_batch_attachments(batch_id,idx,filename,content_type,content) VALUES(?,?,?,?,?)');
      files.forEach((f, k) => insert.run(batchId, next + k, f.filename, f.contentType, f.content));
    });
  }

  removeBatchAttachment(batchId: string, index: number): boolean {
    return Number(this.db.prepare('DELETE FROM mail_batch_attachments WHERE batch_id=? AND idx=?').run(batchId, index).changes) > 0;
  }

  /** The batches of one person that are started and not finished (partial): the list the screen offers to continue. */
  openBatchesOf(userId: string, limit = 10): BatchRow[] {
    return this.db.prepare("SELECT * FROM mail_batches WHERE created_by=? AND status='partial' ORDER BY created_at DESC LIMIT ?").all(userId, limit) as unknown as BatchRow[];
  }

  /** Mail sent to one organization, from its history (newest first). `batchId` is null for a sent mail without one. */
  mailSentTo(orgId: string): { at: string; subject: string; batchId: string | null }[] {
    const rows = this.db.prepare("SELECT at, detail_json FROM organization_history WHERE org_id=? AND action='mail_sent' ORDER BY id DESC").all(orgId) as { at: string; detail_json: string | null }[];
    return rows.map((r) => {
      const detail = r.detail_json ? (JSON.parse(r.detail_json) as HistoryRaw['detail']) : null;
      return { at: r.at, subject: detail?.subject ?? '', batchId: detail?.batchId ?? null };
    });
  }

  /**
   * Messages of other batches to one organization with one subject, newest batch first: waiting (pending, failed),
   * going out (sending), gone out (sent) or perhaps gone out (unknown). Skipped ones are left out.
   */
  sameSubjectInOtherBatches(orgId: string, subject: string, batchId: string): { batchId: string; status: ItemStatus; at: string }[] {
    const rows = this.db
      .prepare(
        "SELECT i.batch_id AS batch_id, i.status AS status, COALESCE(i.sent_at, b.created_at) AS at FROM mail_batch_items i JOIN mail_batches b ON b.id=i.batch_id WHERE i.org_id=? AND i.subject=? AND i.batch_id<>? AND i.status<>'skipped' ORDER BY b.created_at DESC LIMIT 20",
      )
      .all(orgId, subject, batchId) as { batch_id: string; status: ItemStatus; at: string }[];
    return rows.map((r) => ({ batchId: r.batch_id, status: r.status, at: r.at }));
  }

  /** Holds one message back when it is about to be sent (another batch sent the same subject): kept with the reason. */
  skipItem(batchId: string, idx: number, reason: string): void {
    this.db.prepare("UPDATE mail_batch_items SET status='skipped', skip_reason=?, error=NULL WHERE batch_id=? AND idx=? AND status IN ('pending','failed')").run(reason, batchId, idx);
  }

  /** The departments (委員会側の部局) used in one year, or in all years, for the filter. */
  departments(fiscalYear?: number): string[] {
    const rows =
      fiscalYear === undefined
        ? (this.db.prepare("SELECT DISTINCT department AS d FROM organizations WHERE department<>'' ORDER BY department LIMIT 200").all() as { d: string }[])
        : (this.db.prepare("SELECT DISTINCT department AS d FROM organizations WHERE fiscal_year=? AND department<>'' ORDER BY department LIMIT 200").all(fiscalYear) as { d: string }[]);
    return rows.map((r) => r.d);
  }

  setItem(batchId: string, idx: number, patch: { status: ItemStatus; error?: string | null; receiptId?: string | null; sentAt?: string | null }): void {
    this.db
      .prepare('UPDATE mail_batch_items SET status=?, error=?, receipt_id=?, sent_at=? WHERE batch_id=? AND idx=?')
      .run(patch.status, patch.error ?? null, patch.receiptId ?? null, patch.sentAt ?? null, batchId, idx);
  }

  /** Ends the sending request: the batch is "partial" while anything can still be sent, else "done". */
  finishBatch(id: string, notice: string | null, now: string): void {
    this.db
      .prepare(
        "UPDATE mail_batches SET status=CASE WHEN EXISTS (SELECT 1 FROM mail_batch_items WHERE batch_id=? AND status IN ('pending','failed','sending')) THEN 'partial' ELSE 'done' END, locked_at=NULL, notice=?, finished_at=? WHERE id=?",
      )
      .run(id, notice, now, id);
  }
}

/** The fields that differ between two versions of an organization (labels are the screen's). */
export function changedFields(before: OrgInput, after: OrgInput): string[] {
  return (Object.keys(after) as (keyof OrgInput)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}
