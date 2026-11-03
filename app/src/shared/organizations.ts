// Organizations (団体の台帳, 2026-11-03): sponsors, donors, exhibiting groups, suppliers, university
// departments and other parties, in one list for the whole committee. The rules shared by the server (checks,
// the stages of each kind, the placeholders of a mail template, the import plan) and the screen (the same
// messages before a request is sent). Synthetic data only in tests; no personal data in this file.

export const ORG_KINDS = ['sponsor', 'donor', 'exhibitor', 'vendor', 'university', 'other'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export const ORG_KIND_LABELS: Record<OrgKind, string> = {
  sponsor: '協賛',
  donor: '寄付',
  exhibitor: '出展団体',
  vendor: '業者',
  university: '大学の部署',
  other: 'その他',
};

/** The stages of a kind, in order. The other kinds take any short text as their status. */
export const ORG_STAGES: Partial<Record<OrgKind, readonly string[]>> = {
  sponsor: ['依頼前', '依頼済み', '申込を受けた', '請求済み', '入金済み', 'お礼状を送った'],
  exhibitor: ['申込', '書類確認', '請求済み', '入金済み', '当日', '完了'],
};

/** The status a new organization of this kind starts with. */
export function defaultStatus(kind: OrgKind): string {
  return ORG_STAGES[kind]?.[0] ?? '未対応';
}

export const ORG_LIMITS = {
  name: 100,
  department: 40,
  nextAction: 200,
  content: 500,
  notes: 2000,
  status: 20,
  templateName: 40,
  templateSubject: 200,
  templateBody: 20_000,
  /** Recipients in one mail batch: the same as the hourly limit of sending (30 messages an hour per person). */
  batch: 30,
  /** Rows in one import (not counting the header). */
  importRows: 1000,
  importColumns: 60,
  fiscalYearMin: 2000,
  fiscalYearMax: 2100,
  amountMax: 999_999_999,
  pageSizeMax: 100,
  query: 100,
  /** Rows sent in one request of a batch; the screen repeats the request until the batch is finished. */
  sendChunk: 5,
} as const;

export interface OrgInput {
  kind: OrgKind;
  /** The fiscal year the organization is for (2026 is the 2026 festival). */
  fiscalYear: number;
  name: string;
  /** The committee's own department in charge (部局). */
  department: string;
  /** A committee member in charge (user ID), or null. */
  ownerId: string | null;
  /** The contact at the organization (連絡先 ID, ct_…), or null. Its address is the mail address. */
  contactId: string | null;
  status: string;
  /** Sponsorship or stall fee, in yen; null when not yet known. */
  amountYen: number | null;
  /** What the sponsor gives (the size of the advertisement, and so on). */
  content: string;
  nextAction: string;
  /** Next deadline, YYYY-MM-DD, or null. */
  nextDue: string | null;
  notes: string;
}

export const ORG_FIELD_LABELS: Record<keyof OrgInput, string> = {
  kind: '種別',
  fiscalYear: '年度',
  name: '団体名',
  department: '委員会側の部局',
  ownerId: '委員会側の担当',
  contactId: '相手の担当者',
  status: '状態',
  amountYen: '金額',
  content: '協賛の内容',
  nextAction: '次の対応',
  nextDue: '期限',
  notes: 'メモ',
};

export class OrgValidationError extends Error {
  constructor(
    readonly field: keyof OrgInput | null,
    message: string,
  ) {
    super(message);
  }
}

const fail = (field: keyof OrgInput | null, message: string): never => {
  throw new OrgValidationError(field, message);
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
/** C1 controls, zero-width and direction controls: they can make a name look like another. */
const DECEPTIVE = /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const USER_ID = /^[a-z0-9-]{1,40}$/;
const CONTACT_ID = /^ct_[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Text as one line (spaces collapsed) or as several lines. Empty is allowed here; the caller decides. */
export function cleanText(value: unknown, max: number, label: string, multiline = false): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new OrgValidationError(null, `${label}の形式が正しくありません。`);
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  const text = multiline ? normalized.trim() : normalized.replace(/\s+/g, ' ').trim();
  if ((multiline ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(text) || DECEPTIVE.test(text)) throw new OrgValidationError(null, `${label}に使えない文字があります。`);
  if (text.length > max) throw new OrgValidationError(null, `${label}は ${max} 文字までです。`);
  return text;
}

/** A calendar date as YYYY-MM-DD, or null when it is not one. */
export function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Whether a status can stay as it is for this kind (a stage of the kind, or any short text for the other kinds). */
export function statusAllowed(kind: OrgKind, value: string): boolean {
  const stages = ORG_STAGES[kind];
  if (stages) return stages.includes(value);
  return value.length > 0 && value.length <= ORG_LIMITS.status;
}

/** The status checked against the kind: a stage of that kind, or any short text for the other kinds. */
export function statusFor(kind: OrgKind, value: unknown): string {
  if (typeof value !== 'string') return fail('status', '状態を選んでください。');
  const stages = ORG_STAGES[kind];
  if (stages) {
    if (!stages.includes(value)) return fail('status', `状態「${value}」は ${ORG_KIND_LABELS[kind]} にはありません。`);
    return value;
  }
  const free = cleanText(value, ORG_LIMITS.status, '状態');
  if (!free) return fail('status', '状態を入れてください。');
  return free;
}

/**
 * Checks and tidies one organization (the server's rule; the screen uses the same rule to show errors early).
 * Throws OrgValidationError naming the field. Empty optional text becomes "", an empty ID becomes null.
 */
export function validateOrg(input: unknown): OrgInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(null, '団体の形式が正しくありません。');
  const o = input as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !(ORG_KINDS as readonly string[]).includes(o.kind)) return fail('kind', '種別を選んでください。');
  const kind = o.kind as OrgKind;
  if (typeof o.fiscalYear !== 'number' || !Number.isInteger(o.fiscalYear) || o.fiscalYear < ORG_LIMITS.fiscalYearMin || o.fiscalYear > ORG_LIMITS.fiscalYearMax) {
    return fail('fiscalYear', '年度は西暦の数字で入れてください（例: 2026）。');
  }
  const name = cleanText(o.name, ORG_LIMITS.name, '団体名');
  if (!name) return fail('name', '団体名を入れてください。');
  const department = cleanText(o.department, ORG_LIMITS.department, '委員会側の部局');
  let ownerId: string | null = null;
  if (o.ownerId !== undefined && o.ownerId !== null && o.ownerId !== '') {
    if (typeof o.ownerId !== 'string' || !USER_ID.test(o.ownerId)) return fail('ownerId', '委員会側の担当の形式が正しくありません。');
    ownerId = o.ownerId;
  }
  let contactId: string | null = null;
  if (o.contactId !== undefined && o.contactId !== null && o.contactId !== '') {
    if (typeof o.contactId !== 'string' || !CONTACT_ID.test(o.contactId)) return fail('contactId', '相手の担当者の形式が正しくありません。');
    contactId = o.contactId;
  }
  const status = statusFor(kind, o.status);
  let amountYen: number | null = null;
  if (o.amountYen !== undefined && o.amountYen !== null && o.amountYen !== '') {
    if (typeof o.amountYen !== 'number' || !Number.isInteger(o.amountYen) || o.amountYen < 0 || o.amountYen > ORG_LIMITS.amountMax) {
      return fail('amountYen', `金額は 0 から ${ORG_LIMITS.amountMax.toLocaleString('en-US')} 円までの整数で入れてください。`);
    }
    amountYen = o.amountYen;
  }
  const content = cleanText(o.content, ORG_LIMITS.content, '協賛の内容', true);
  const nextAction = cleanText(o.nextAction, ORG_LIMITS.nextAction, '次の対応');
  let nextDue: string | null = null;
  if (o.nextDue !== undefined && o.nextDue !== null && o.nextDue !== '') {
    if (typeof o.nextDue !== 'string' || !validDate(o.nextDue)) return fail('nextDue', '期限は 2026-11-30 の形（年-月-日）で入れてください。');
    nextDue = o.nextDue;
  }
  const notes = cleanText(o.notes, ORG_LIMITS.notes, 'メモ', true);
  return { kind, fiscalYear: o.fiscalYear, name, department, ownerId, contactId, status, amountYen, content, nextAction, nextDue, notes };
}

/** Name in matching form: NFKC, lower case, spaces left out. Two rows with the same form are the same organization. */
export function orgNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// ---- mail templates and placeholders ------------------------------------------------------------------

export const MAIL_PLACEHOLDERS = ['団体名', '担当者名', '年度', '種別', '金額', '協賛内容', '委員会の担当', '状態', '次の対応', '期限'] as const;
export type MailPlaceholder = (typeof MAIL_PLACEHOLDERS)[number];

export interface MailTemplateInput {
  name: string;
  subject: string;
  body: string;
}

const PLACEHOLDER = /\{([^{}\r\n]{1,20})\}/g;

/** The placeholder names written in a text ({団体名} gives 団体名). */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

export function validateTemplate(input: unknown): MailTemplateInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new OrgValidationError(null, 'テンプレートの形式が正しくありません。');
  const o = input as Record<string, unknown>;
  const name = cleanText(o.name, ORG_LIMITS.templateName, 'テンプレート名');
  if (!name) throw new OrgValidationError(null, 'テンプレート名を入れてください。');
  const subject = cleanText(o.subject, ORG_LIMITS.templateSubject, '件名');
  if (!subject) throw new OrgValidationError(null, '件名を入れてください。');
  const body = cleanText(o.body, ORG_LIMITS.templateBody, '本文', true);
  if (!body) throw new OrgValidationError(null, '本文を入れてください。');
  const unknown = [...placeholdersIn(subject), ...placeholdersIn(body)].filter((p) => !(MAIL_PLACEHOLDERS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new OrgValidationError(null, `差し込みの「{${[...new Set(unknown)].join('}・{')}}」は使えません。使えるのは ${MAIL_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')} です。`);
  }
  return { name, subject, body };
}

/** The values the placeholders of one organization stand for. Empty means "nothing to put in". */
export interface MailSource {
  name: string;
  fiscalYear: number;
  kind: OrgKind;
  status: string;
  amountYen: number | null;
  content: string;
  nextAction: string;
  nextDue: string | null;
  department: string;
  /** Name of the committee member in charge ("" when none). */
  ownerName: string;
  /** Name of the contact at the organization ("" when none). */
  contactName: string;
}

export function mailValues(s: MailSource): Record<MailPlaceholder, string> {
  return {
    団体名: s.name,
    担当者名: s.contactName,
    年度: `${s.fiscalYear}年度`,
    種別: ORG_KIND_LABELS[s.kind],
    金額: s.amountYen === null ? '' : `${String(s.amountYen).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`,
    協賛内容: s.content,
    委員会の担当: [s.department, s.ownerName].filter(Boolean).join(' '),
    状態: s.status,
    次の対応: s.nextAction,
    期限: s.nextDue ?? '',
  };
}

/**
 * Fills the placeholders. A placeholder with an empty value is reported in `empty` and left blank in the text;
 * a name that is not a placeholder stays as written (templates are checked when they are saved).
 * A subject is one line: its line breaks become spaces.
 */
export function renderMail(text: string, values: Partial<Record<string, string>>, oneLine = false): { text: string; empty: string[] } {
  const empty: string[] = [];
  const filled = text.replace(PLACEHOLDER, (whole: string, key: string) => {
    const value = values[key];
    if (value === undefined) return whole;
    if (value === '') {
      empty.push(key);
      return '';
    }
    return oneLine ? value.replace(/\s+/g, ' ') : value;
  });
  return { text: oneLine ? filled.replace(/\s+/g, ' ').trim() : filled, empty: [...new Set(empty)] };
}

// ---- CSV import ---------------------------------------------------------------------------------------

export const IMPORT_FIELDS = ['name', 'kind', 'department', 'ownerName', 'contactEmail', 'amountYen', 'content', 'status', 'nextAction', 'nextDue', 'notes'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  name: '団体名（必須）',
  kind: '種別',
  department: '委員会側の部局',
  ownerName: '委員会側の担当（名前）',
  contactEmail: '相手のメール（連絡先と結ぶ）',
  amountYen: '金額',
  content: '協賛の内容',
  status: '状態',
  nextAction: '次の対応',
  nextDue: '期限',
  notes: 'メモ',
};

/** Column of each field (index), or null when no column is used for it. */
export type ImportMapping = Partial<Record<ImportField, number | null>>;

/** Decodes a CSV file: UTF-8 when it is valid UTF-8 (the BOM is taken off), else Shift_JIS (what Excel writes). */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'shift_jis' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
  }
}

export class CsvError extends Error {}

export interface CsvRecord {
  /** The physical line of the sheet this record starts on (a quoted cell may hold line breaks). */
  line: number;
  cells: string[];
}

/**
 * RFC 4180 style: quotes around a cell (doubled quotes inside), CRLF or LF. Each record keeps the physical line it
 * starts on, so the row numbers the screen shows match the sheet even after blank lines or line breaks in a cell.
 * Empty records are left out.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const src = text.replace(/^\ufeff/, '');
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  const endRecord = () => {
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) records.push({ line: recordLine, cells: row });
    row = [];
    cell = '';
  };
  for (let i = 0; i < src.length; ) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      endRecord();
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      line += 1;
      recordLine = line;
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (quoted) throw new CsvError('引用符（"）が閉じていない行があります。');
  if (cell !== '' || row.length > 0) endRecord();
  return records;
}

/** The cells of each record (the line numbers are left out; see parseCsvRecords). */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((r) => r.cells);
}

/** A kind by its name or its label (協賛, 出展団体…); null when it is neither. */
export function kindFromText(value: string): OrgKind | null {
  const v = value.normalize('NFKC').trim();
  for (const kind of ORG_KINDS) {
    if (v === kind || v === ORG_KIND_LABELS[kind]) return kind;
  }
  return null;
}

/**
 * An amount as written in a sheet: 1,000,000 / ¥1,000,000 / 1000000円 / full-width digits. Empty gives null.
 * Anything else gives "invalid".
 */
export function parseYenText(value: string): number | null | 'invalid' {
  const v = value.normalize('NFKC').replace(/[¥,，\s]/g, '').replace(/円$/, '');
  if (v === '') return null;
  if (!/^\d+$/.test(v)) return 'invalid';
  const n = Number(v);
  return Number.isSafeInteger(n) && n <= ORG_LIMITS.amountMax ? n : 'invalid';
}

/** Columns guessed from the header names of a sheet (the screen shows the guess; the user can change it). */
export function guessMapping(headers: string[]): ImportMapping {
  const rules: [ImportField, RegExp][] = [
    ['name', /団体名|企業名|組織|名称|団体/],
    ['kind', /種別|種類/],
    ['department', /部局|部署/],
    ['ownerName', /委員会.*担当|担当者名|担当/],
    ['contactEmail', /メール|mail/i],
    ['amountYen', /金額|協賛額|出展料|額/],
    ['content', /協賛の内容|内容|広告/],
    ['status', /状態|進捗|ステータス/],
    ['nextAction', /次の対応/],
    ['nextDue', /期限/],
    ['notes', /メモ|備考/],
  ];
  const mapping: ImportMapping = {};
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

// ---- wire types ----------------------------------------------------------------------------------------

/** The organization as the screen shows it: the names of the people behind the IDs are filled in. */
export interface OrgView extends OrgInput {
  id: string;
  version: number;
  ownerName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  createdAt: string;
  createdByName: string;
  updatedAt: string;
  updatedByName: string;
}

export interface OrgListItem {
  id: string;
  kind: OrgKind;
  fiscalYear: number;
  name: string;
  department: string;
  ownerName: string | null;
  status: string;
  amountYen: number | null;
  nextDue: string | null;
  contactEmail: string | null;
}

export interface OrgListResponse {
  items: OrgListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Organizations per status, for the kind and year (and the search) chosen; the status filter is not applied. */
  statusCounts: Record<string, number>;
  /** The departments (委員会側の部局) used in the year, for the filter. */
  departments: string[];
  /** The filters the server applied, echoed back. */
  kind: OrgKind | null;
}

export type OrgHistoryAction = 'created' | 'updated' | 'deleted' | 'imported' | 'reverted' | 'mail_sent';

export interface OrgHistoryView {
  id: number;
  at: string;
  actorName: string;
  action: OrgHistoryAction;
  /** Labels of the changed fields (updates, imports and reverts). */
  changed: string[];
  /** Mail: the subject and the number of messages sent. Null for other actions. */
  mail: { subject: string; sent: number } | null;
  /** The earlier state can be put back from this row (updates, imports and reverts that kept one). */
  canRevert: boolean;
}

export interface OrgDetailResponse {
  org: OrgView;
  history: OrgHistoryView[];
  /** Committee administrators may delete an organization. */
  canAdminister: boolean;
}

export interface OrgImportPlanRow {
  /** Line in the sheet, counting the header as line 1. */
  line: number;
  action: 'create' | 'update' | 'skip';
  name: string;
  /** The reason for a skip; for an update the fields that will change. */
  message: string;
  /** Labels of the fields that change (updates only). */
  changed: string[];
}

export interface OrgImportResponse {
  dryRun: boolean;
  create: number;
  update: number;
  skip: number;
  rows: OrgImportPlanRow[];
  /** A digest of the plan as it stands; the commit sends it back and is refused when the plan has changed since. */
  planToken: string;
}

export interface OrgMailItem {
  index: number;
  orgId: string;
  orgName: string;
  /** The address the mail goes to ("" when there is none). */
  toAddress: string;
  toName: string;
  subject: string;
  body: string;
  /** Why the item is not sent, or null when it is sent. */
  skipReason: string | null;
  /** A note for a message that is sent (the organization was sent something else before); null otherwise. */
  warning: string | null;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped';
  error: string | null;
  sentAt: string | null;
}

/** A file attached to every message of a batch (the same files for each organization). */
export interface OrgMailAttachment {
  index: number;
  filename: string;
  size: number;
}

export interface OrgMailBatch {
  id: string;
  status: 'draft' | 'sending' | 'partial' | 'done';
  mailboxId: string;
  mailboxAddress: string;
  templateName: string | null;
  subject: string;
  createdAt: string;
  /** Counts of the items by status. */
  counts: Record<OrgMailItem['status'], number>;
  items: OrgMailItem[];
  /** The shared attachments: they can be changed only while the batch is a draft. */
  attachments: OrgMailAttachment[];
  /** The message shown after the last request (for example: the hourly limit was reached). */
  notice: string | null;
}

/** A batch that was started and is not finished (the list the screen offers to continue). */
export interface OrgMailBatchSummary {
  id: string;
  subject: string;
  mailboxAddress: string;
  createdAt: string;
  counts: Record<OrgMailItem['status'], number>;
}

/** What the screens need to know before they show the organizations and the mail: from GET /api/organizations/meta. */
export interface OrgMeta {
  stages: Partial<Record<OrgKind, string[]>>;
  kindLabels: Record<OrgKind, string>;
  kinds: OrgKind[];
  placeholders: string[];
  limits: { batch: number; importRows: number; sendChunk: number; templateBody: number; templateSubject: number; attachments: number; attachmentBytes: number };
  /** `readable`: the person may read mail (the mail screens' sign-in and trial rules). Sending is shown only when `enabled`. */
  mail: { enabled: boolean; readable: boolean; from: { mailboxId: string; name: string; address: string }[] };
  /** Members who can be put in charge of an organization. */
  people: { id: string; name: string }[];
  /** Access administrators: delete. */
  canAdminister: boolean;
}

/** GET /api/organizations/:id/mail: the threads of the contact's address that this person may read. */
export interface OrgMailThreads {
  address: string | null;
  threads: { threadId: string; mailboxId: string; mailboxName: string; subject: string; latestReceivedAt: string; senders: string[] }[];
}

export interface OrgTemplateView extends MailTemplateInput {
  id: string;
  version: number;
  updatedAt: string;
  updatedByName: string;
}
