// Committee contacts. One list for the whole
// committee: outside parties (sponsors, suppliers, university offices, the other campuses), exhibiting groups,
// the committee's own group addresses and committee members. Every committee member reads and edits it;
// only access administrators delete or import. Temporary staff never see it.
import { isMailAddress } from './mailbox.js';

export const CONTACT_CATEGORIES = ['external', 'exhibitor', 'committee', 'member'] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ContactCategory, string> = {
  external: '外部の相手先',
  exhibitor: '出展団体',
  committee: '委員会の窓口',
  member: '委員',
};

export const CONTACT_LIMITS = {
  /** organization, section, name, nameKana */
  text: 100,
  address: 300,
  notes: 2000,
  tag: 30,
  tags: 10,
  emails: 5,
  phones: 5,
  label: 20,
  source: 300,
  /** Contacts in one import. */
  importMax: 3000,
  /** The list's 「すべて」 (a few hundred committee contacts; the rows are short). */
  pageSizeMax: 1000,
  query: 200,
} as const;

export interface ContactEmail {
  label: string;
  address: string;
}

export interface ContactPhone {
  label: string;
  number: string;
}

/** What a person types (POST and PUT). */
export interface ContactInput {
  category: ContactCategory;
  organization: string;
  section: string;
  name: string;
  nameKana: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  postalCode: string;
  address: string;
  tags: string[];
  notes: string;
}

export interface ContactView extends ContactInput {
  id: string;
  /** Where an imported contact came from (empty for one typed in the app). */
  source: string;
  version: number;
  createdAt: string;
  createdByName: string;
  updatedAt: string;
  updatedByName: string;
}

/** One row of the list: the first address and number only. */
export interface ContactListItem {
  id: string;
  category: ContactCategory;
  organization: string;
  section: string;
  name: string;
  nameKana: string;
  email: string | null;
  phone: ContactPhone | null;
  tags: string[];
}

export interface ContactListResponse {
  items: ContactListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Contacts per category (and all) with the search and tag applied, before the category. */
  counts: Record<ContactCategory | 'all', number>;
  /** Every tag in use, most used first. */
  tags: { tag: string; count: number }[];
  /** Access administrators: delete, import and the CSV export. */
  canAdminister: boolean;
}

export type ContactHistoryAction = 'created' | 'updated' | 'deleted' | 'imported';

export interface ContactHistoryView {
  at: string;
  actorName: string;
  action: ContactHistoryAction;
  /** Labels of the changed fields (updates only). */
  changed: string[];
}

export interface ContactDetailResponse {
  contact: ContactView;
  history: ContactHistoryView[];
  canAdminister: boolean;
}

/** One address offered while a recipient is typed (GET /api/contacts/suggest). */
export interface ContactSuggestion {
  contactId: string;
  /** The name written in front of the address ("名前 <address>"). */
  name: string;
  organization: string;
  address: string;
  label: string;
}

/** GET /api/contacts/by-address: which of these addresses are in the contacts. */
export interface ContactAddressMatch {
  address: string;
  contactId: string;
  name: string;
}

export interface ContactImportRequest {
  contacts: (ContactInput & { source?: string })[];
  /** Check only: nothing is stored. */
  dryRun: boolean;
}

export interface ContactImportResponse {
  dryRun: boolean;
  added: number;
  /** Already in the contacts (the same address, or the same category, organization and name). */
  duplicates: { index: number; label: string; reason: string }[];
  invalid: { index: number; label: string; message: string }[];
}

/** The field labels the screen and the history use. */
export const FIELD_LABELS: Record<keyof ContactInput, string> = {
  category: '種類',
  organization: '組織・団体',
  section: '部署・役職',
  name: '氏名',
  nameKana: 'ふりがな',
  emails: 'メール',
  phones: '電話',
  postalCode: '郵便番号',
  address: '住所',
  tags: 'タグ',
  notes: 'メモ',
};

/** Name shown for a contact: the person, else the organization. */
export function contactTitle(c: Pick<ContactInput, 'name' | 'organization'>): string {
  return c.name.trim() || c.organization.trim() || '（名前なし）';
}

const KATAKANA = /[ァ-ヶ]/g;

/** Search form: NFKC, lower case, katakana as hiragana (ヤマダ finds やまだ). */
export function normalizeContactSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(KATAKANA, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** Digits of a phone number (search for 0764 finds 076-4…). */
export const phoneDigits = (value: string): string => value.normalize('NFKC').replace(/\D/g, '');

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
/** C1 controls, zero-width characters and direction controls: they can make a name or an address look like another. */
const DECEPTIVE = /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
/** Rows looked at in one list before the limits apply (a longer list is refused before any work). */
const ROWS_MAX = 20;

export type ContactField = keyof ContactInput | `emails.${number}` | `phones.${number}` | `tags.${number}`;

export class ContactValidationError extends Error {
  constructor(
    readonly field: ContactField | null,
    message: string,
  ) {
    super(message);
  }
}

const fail = (field: ContactField | null, message: string): never => {
  throw new ContactValidationError(field, message);
};

function text(value: unknown, field: ContactField, max: number, label: string, multiline = false): string {
  if (typeof value !== 'string') return fail(field, `${label}の形式が正しくありません。`);
  if (value.length > max * 4) return fail(field, `${label}は ${max} 文字までです。`);
  const v = multiline ? value.replace(/\r\n?/g, '\n').trim() : value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if ((multiline ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(v) || DECEPTIVE.test(v)) return fail(field, `${label}に使えない文字があります。`);
  if (v.length > max) return fail(field, `${label}は ${max} 文字までです。`);
  return v;
}

/** A list field: an array of at most ROWS_MAX rows (empty rows included), checked before any row is read. */
function rows(value: unknown, field: 'emails' | 'phones' | 'tags', label: string, limit: number, unit: string): unknown[] {
  const list = value ?? [];
  if (!Array.isArray(list)) return fail(field, `${label}の形式が正しくありません。`);
  if (list.length > ROWS_MAX) return fail(field, `${label}は ${limit} ${unit}までです。`);
  return list;
}

/** A phone number as written: digits, +, -, (, ), spaces and an extension; full-width forms are made half-width. */
export function normalizePhone(value: string): string | null {
  const v = value
    .normalize('NFKC')
    .replace(/[‐‑‒–—―ー−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length > 40 || !/^\+?[0-9() -]+(?: ?(?:内線|ext\.?|#) ?[0-9]{1,6})?$/i.test(v)) return null;
  const digits = phoneDigits(v);
  return digits.length >= 2 && digits.length <= 20 ? v : null;
}

/** 〒 code as 123-4567 (seven digits, written with or without the hyphen). */
export function normalizePostalCode(value: string): string | null {
  const digits = value.normalize('NFKC').replace(/[〒\s-]/g, '');
  if (digits === '') return '';
  return /^\d{7}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
}

/**
 * Checks and tidies one contact (the server's rule; the screen uses it to show errors early). Throws
 * ContactValidationError naming the field. Emails and numbers are de-duplicated; empty rows are dropped.
 */
export function validateContact(input: unknown): ContactInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(null, '連絡先の形式が正しくありません。');
  const o = input as Record<string, unknown>;
  const category = o.category;
  if (typeof category !== 'string' || !(CONTACT_CATEGORIES as readonly string[]).includes(category)) return fail('category', '種類を選んでください。');
  const organization = text(o.organization ?? '', 'organization', CONTACT_LIMITS.text, '組織・団体');
  const name = text(o.name ?? '', 'name', CONTACT_LIMITS.text, '氏名');
  if (!organization && !name) return fail('name', '氏名か組織・団体のどちらかを入れてください。');
  const section = text(o.section ?? '', 'section', CONTACT_LIMITS.text, '部署・役職');
  const nameKana = text(o.nameKana ?? '', 'nameKana', CONTACT_LIMITS.text, 'ふりがな');

  const emails: ContactEmail[] = [];
  const seenAddresses = new Set<string>();
  rows(o.emails, 'emails', 'メール', CONTACT_LIMITS.emails, '件').forEach((e: unknown, i) => {
    const row = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    const address = text(row.address ?? '', `emails.${i}`, 254, 'メールアドレス').normalize('NFKC');
    const label = text(row.label ?? '', `emails.${i}`, CONTACT_LIMITS.label, 'メールの種類');
    if (!address) return;
    if (!isMailAddress(address)) fail(`emails.${i}`, `メールアドレス「${address}」の形が正しくありません。`);
    const key = address.toLowerCase();
    if (seenAddresses.has(key)) return;
    seenAddresses.add(key);
    emails.push({ label, address });
  });
  if (emails.length > CONTACT_LIMITS.emails) return fail('emails', `メールは ${CONTACT_LIMITS.emails} 件までです。`);

  const phones: ContactPhone[] = [];
  const seenNumbers = new Set<string>();
  rows(o.phones, 'phones', '電話', CONTACT_LIMITS.phones, '件').forEach((p: unknown, i) => {
    const row = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
    const typed = text(row.number ?? '', `phones.${i}`, 40, '電話番号');
    const label = text(row.label ?? '', `phones.${i}`, CONTACT_LIMITS.label, '電話の種類');
    if (!typed) return;
    const number = normalizePhone(typed);
    if (number === null) return fail(`phones.${i}`, `電話番号「${typed}」の形が正しくありません（数字と - ( ) + だけ）。`);
    const key = phoneDigits(number);
    if (seenNumbers.has(key)) return;
    seenNumbers.add(key);
    phones.push({ label, number });
  });
  if (phones.length > CONTACT_LIMITS.phones) return fail('phones', `電話は ${CONTACT_LIMITS.phones} 件までです。`);

  const postalTyped = text(o.postalCode ?? '', 'postalCode', 20, '郵便番号');
  const postalCode = normalizePostalCode(postalTyped);
  if (postalCode === null) return fail('postalCode', '郵便番号は 7 桁の数字で入れてください（例: 123-4567）。');
  const address = text(o.address ?? '', 'address', CONTACT_LIMITS.address, '住所');

  const tags: string[] = [];
  rows(o.tags, 'tags', 'タグ', CONTACT_LIMITS.tags, '個').forEach((t: unknown, i) => {
    const tag = text(t, `tags.${i}`, CONTACT_LIMITS.tag, 'タグ').replace(/[,、，]/g, ' ').trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  });
  if (tags.length > CONTACT_LIMITS.tags) return fail('tags', `タグは ${CONTACT_LIMITS.tags} 個までです。`);
  const notes = text(o.notes ?? '', 'notes', CONTACT_LIMITS.notes, 'メモ', true);
  return { category: category as ContactCategory, organization, section, name, nameKana, emails, phones, postalCode, address, tags, notes };
}

/** Tags typed in one field, separated by commas, 、 or spaces. */
export function splitTags(value: string): string[] {
  return [...new Set(value.split(/[,、，\s]+/).map((t) => t.trim()).filter(Boolean))];
}

/** "名前 <address>" for a recipient field: the name is quoted when it holds a separator, and loses <, > and ". */
export function recipientText(name: string, address: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[<>"\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!clean) return address;
  return /[,;、，；]/.test(clean) ? `"${clean}" <${address}>` : `${clean} <${address}>`;
}
