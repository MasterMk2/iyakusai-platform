import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONTACT_CATEGORIES, FIELD_LABELS, normalizeContactSearch, phoneDigits, type ContactCategory, type ContactHistoryAction, type ContactInput } from '../../shared/contacts.js';

// Committee contacts: one SQLite file (contacts.sqlite3) next to mail.sqlite3, so the backups of the mail folder
// carry it. A contact is stored as one JSON document with the columns the list needs (category, search text,
// sort key, addresses). Every change keeps a history row, and an update or delete keeps the contact as it was
// before (before_json), so a mistaken edit can be put back by hand.

export const CONTACTS_FILE = 'contacts.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts(
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  data_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  source TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_sort ON contacts(sort_key, id);
CREATE TABLE IF NOT EXISTS contact_emails(contact_id TEXT NOT NULL, idx INTEGER NOT NULL, address_lower TEXT NOT NULL, PRIMARY KEY(contact_id, idx));
CREATE INDEX IF NOT EXISTS contact_emails_address ON contact_emails(address_lower);
CREATE TABLE IF NOT EXISTS contact_history(id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, changed_json TEXT NOT NULL, before_json TEXT);
CREATE INDEX IF NOT EXISTS contact_history_contact ON contact_history(contact_id, id);
`;

export interface ContactRow {
  id: string;
  category: ContactCategory;
  data: ContactInput;
  source: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface RawRow {
  id: string;
  category: string;
  data_json: string;
  source: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface HistoryRow {
  at: string;
  actor_id: string;
  action: ContactHistoryAction;
  changed: (keyof ContactInput)[];
}

export interface ContactFilter {
  terms: string[];
  category?: ContactCategory;
  tag?: string;
}

// Words in front of a company name that would put every company under か (株式会社) in a sorted list.
const LEGAL_FORMS = /^(?:株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|公益社団法人|一般財団法人|公益財団法人|医療法人社団|医療法人財団|医療法人|社会福祉法人|学校法人|国立大学法人|特定非営利活動法人|NPO法人|\(株\)|\(有\)|㈱|㈲)\s*/i;

/** Sort key: the reading if there is one, else the name or organization without its legal form. */
export function sortKey(c: ContactInput): string {
  const base = c.nameKana || c.name || c.organization.normalize('NFKC').replace(LEGAL_FORMS, '');
  return normalizeContactSearch(base).replace(/\s+/g, '');
}

/** Everything a search may match: names (also without spaces), addresses, numbers (also digits only), tags, notes. */
export function searchText(c: ContactInput): string {
  const words = [c.organization, c.section, c.name, c.nameKana, ...c.emails.flatMap((e) => [e.address, e.label]), ...c.phones.flatMap((p) => [p.number, p.label]), c.postalCode, c.address, ...c.tags, c.notes];
  const joined = normalizeContactSearch(words.join('\n'));
  const compact = normalizeContactSearch([c.organization, c.name, c.nameKana].join('\n')).replace(/[^\S\n]+/g, '');
  return [joined, compact, ...c.phones.map((p) => phoneDigits(p.number))].join('\n');
}

const likeEscape = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** The fields that differ between two versions of a contact. */
export function changedFields(before: ContactInput, after: ContactInput): (keyof ContactInput)[] {
  return (Object.keys(FIELD_LABELS) as (keyof ContactInput)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

export class ContactsStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, CONTACTS_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('contacts schema version');
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

  private static row(raw: RawRow): ContactRow {
    return { id: raw.id, category: raw.category as ContactCategory, data: JSON.parse(raw.data_json) as ContactInput, source: raw.source, version: Number(raw.version), created_at: raw.created_at, created_by: raw.created_by, updated_at: raw.updated_at, updated_by: raw.updated_by };
  }

  private where(f: ContactFilter, withCategory: boolean, table = 'contacts'): { sql: string; params: string[] } {
    const parts: string[] = [];
    const params: string[] = [];
    for (const term of f.terms) {
      parts.push(`${table}.search_text LIKE ? ESCAPE '\\'`);
      params.push(`%${likeEscape(term)}%`);
    }
    if (f.tag !== undefined) {
      parts.push(`EXISTS (SELECT 1 FROM json_each(${table}.data_json, '$.tags') t WHERE t.value = ?)`);
      params.push(f.tag);
    }
    if (withCategory && f.category !== undefined) {
      parts.push(`${table}.category = ?`);
      params.push(f.category);
    }
    return { sql: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
  }

  page(f: ContactFilter, limit: number, offset: number): { total: number; rows: ContactRow[] } {
    const w = this.where(f, true);
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM contacts WHERE ${w.sql}`).get(...w.params) as { n: number }).n);
    const rows = this.db.prepare(`SELECT * FROM contacts WHERE ${w.sql} ORDER BY sort_key, id LIMIT ? OFFSET ?`).all(...w.params, limit, offset) as unknown as RawRow[];
    return { total, rows: rows.map(ContactsStore.row) };
  }

  /** Contacts per category with the search and tag applied (the category chips). */
  categoryCounts(f: ContactFilter): Record<ContactCategory | 'all', number> {
    const w = this.where(f, false);
    const rows = this.db.prepare(`SELECT category, count(*) AS n FROM contacts WHERE ${w.sql} GROUP BY category`).all(...w.params) as { category: string; n: number }[];
    const counts = { all: 0, external: 0, exhibitor: 0, committee: 0, member: 0 } as Record<ContactCategory | 'all', number>;
    for (const r of rows) {
      if ((CONTACT_CATEGORIES as readonly string[]).includes(r.category)) counts[r.category as ContactCategory] = Number(r.n);
      counts.all += Number(r.n);
    }
    return counts;
  }

  tagCounts(): { tag: string; count: number }[] {
    const rows = this.db.prepare("SELECT t.value AS tag, count(*) AS n FROM contacts, json_each(contacts.data_json, '$.tags') t GROUP BY t.value ORDER BY n DESC, t.value").all() as { tag: string; n: number }[];
    return rows.map((r) => ({ tag: r.tag, count: Number(r.n) }));
  }

  get(id: string): ContactRow | null {
    const raw = this.db.prepare('SELECT * FROM contacts WHERE id=?').get(id) as unknown as RawRow | undefined;
    return raw ? ContactsStore.row(raw) : null;
  }

  history(id: string, limit = 50): HistoryRow[] {
    const rows = this.db.prepare('SELECT at, actor_id, action, changed_json FROM contact_history WHERE contact_id=? ORDER BY id DESC LIMIT ?').all(id, limit) as { at: string; actor_id: string; action: string; changed_json: string }[];
    return rows.map((r) => ({ at: r.at, actor_id: r.actor_id, action: r.action as ContactHistoryAction, changed: JSON.parse(r.changed_json) as (keyof ContactInput)[] }));
  }

  /** Contacts holding any of these addresses (lower-cased). */
  byAddresses(addresses: string[]): { address: string; row: ContactRow }[] {
    if (addresses.length === 0) return [];
    const lower = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const found = this.db
      .prepare(`SELECT e.address_lower AS address, c.* FROM contact_emails e JOIN contacts c ON c.id = e.contact_id WHERE e.address_lower IN (${lower.map(() => '?').join(',')}) ORDER BY c.sort_key, c.id`)
      .all(...lower) as unknown as (RawRow & { address: string })[];
    return found.map((r) => ({ address: r.address, row: ContactsStore.row(r) }));
  }

  /**
   * Addresses for a recipient field. Every term must match the contact (its names, numbers, tags…) or that
   * address itself, so "bill" offers billing@ and not the same company's other addresses. Addresses that start
   * with the first term come first.
   */
  suggest(terms: string[], limit: number): { row: ContactRow; idx: number }[] {
    if (terms.length === 0) return [];
    const w = this.where({ terms }, false, 'c');
    const rows = (this.db.prepare(`SELECT c.* FROM contacts c WHERE ${w.sql} AND EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id = c.id) ORDER BY c.sort_key, c.id LIMIT 500`).all(...w.params) as unknown as RawRow[]).map(ContactsStore.row);
    const found: { row: ContactRow; idx: number; starts: boolean }[] = [];
    for (const row of rows) {
      const rest = searchText({ ...row.data, emails: [] });
      row.data.emails.forEach((e, idx) => {
        const own = normalizeContactSearch(`${e.address}\n${e.label}`);
        if (terms.every((t) => rest.includes(t) || own.includes(t))) found.push({ row, idx, starts: e.address.toLowerCase().startsWith(terms[0]!) });
      });
    }
    return found
      .sort((a, b) => Number(b.starts) - Number(a.starts))
      .slice(0, limit)
      .map(({ row, idx }) => ({ row, idx }));
  }

  private writeEmails(id: string, data: ContactInput): void {
    this.db.prepare('DELETE FROM contact_emails WHERE contact_id=?').run(id);
    const insert = this.db.prepare('INSERT INTO contact_emails(contact_id,idx,address_lower) VALUES(?,?,?)');
    data.emails.forEach((e, i) => insert.run(id, i, e.address.toLowerCase()));
  }

  private insert(data: ContactInput, source: string, actorId: string, now: string, action: 'created' | 'imported'): ContactRow {
    const id = `ct_${randomBytes(8).toString('hex')}`;
    this.db
      .prepare('INSERT INTO contacts(id,category,data_json,search_text,sort_key,source,version,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,1,?,?,?,?)')
      .run(id, data.category, JSON.stringify(data), searchText(data), sortKey(data), source, now, actorId, now, actorId);
    this.writeEmails(id, data);
    this.db.prepare("INSERT INTO contact_history(contact_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,?,'[]',NULL)").run(id, now, actorId, action);
    return this.get(id)!;
  }

  create(data: ContactInput, actorId: string, now: string): ContactRow {
    return this.tx(() => this.insert(data, '', actorId, now, 'created'));
  }

  /** Null when the contact is gone; 'conflict' when someone saved it first. */
  update(id: string, expectedVersion: number, data: ContactInput, actorId: string, now: string): ContactRow | 'conflict' | null {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      const changed = changedFields(before.data, data);
      if (changed.length === 0) return before;
      this.db
        .prepare('UPDATE contacts SET category=?, data_json=?, search_text=?, sort_key=?, version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?')
        .run(data.category, JSON.stringify(data), searchText(data), sortKey(data), now, actorId, id, expectedVersion);
      this.writeEmails(id, data);
      this.db.prepare("INSERT INTO contact_history(contact_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,'updated',?,?)").run(id, now, actorId, JSON.stringify(changed), JSON.stringify(before));
      return this.get(id)!;
    });
  }

  delete(id: string, expectedVersion: number, actorId: string, now: string): 'deleted' | 'conflict' | null {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      this.db.prepare('DELETE FROM contacts WHERE id=?').run(id);
      this.db.prepare('DELETE FROM contact_emails WHERE contact_id=?').run(id);
      this.db.prepare("INSERT INTO contact_history(contact_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,'deleted','[]',?)").run(id, now, actorId, JSON.stringify(before));
      return 'deleted';
    });
  }

  /** The identity of a contact for finding duplicates: category, organization and name in search form. */
  static identity(c: Pick<ContactInput, 'category' | 'organization' | 'name'>): string {
    const n = (s: string) => normalizeContactSearch(s).replace(/\s+/g, '');
    return `${c.category}\n${n(c.organization)}\n${n(c.name)}`;
  }

  /**
   * Imports checked contacts in one transaction, leaving out those already stored (one of the addresses, or
   * — for a contact without an address — the same category, organization and name) and repeats in the list.
   * With `dryRun` nothing is written; the answer is the same.
   */
  import(items: { index: number; data: ContactInput; source: string }[], actorId: string, now: string, dryRun: boolean): { added: number; duplicates: { index: number; reason: string }[] } {
    const run = () => {
      const addresses = new Set((this.db.prepare('SELECT address_lower FROM contact_emails').all() as { address_lower: string }[]).map((r) => r.address_lower));
      const identities = new Set((this.db.prepare('SELECT data_json FROM contacts').all() as { data_json: string }[]).map((r) => ContactsStore.identity(JSON.parse(r.data_json) as ContactInput)));
      const duplicates: { index: number; reason: string }[] = [];
      let added = 0;
      for (const item of items) {
        const lower = item.data.emails.map((e) => e.address.toLowerCase());
        const known = lower.find((a) => addresses.has(a));
        const identity = ContactsStore.identity(item.data);
        if (known) {
          duplicates.push({ index: item.index, reason: `メールアドレス ${known} がすでにあります` });
          continue;
        }
        if (identities.has(identity) && lower.length === 0) {
          duplicates.push({ index: item.index, reason: '同じ種類・組織・氏名の連絡先がすでにあります' });
          continue;
        }
        if (!dryRun) this.insert(item.data, item.source, actorId, now, 'imported');
        lower.forEach((a) => addresses.add(a));
        identities.add(identity);
        added += 1;
      }
      return { added, duplicates };
    };
    if (!dryRun) return this.tx(run);
    return run();
  }

  /** Who took the whole list out and when (no contact, so it never shows in a contact's history). */
  recordExport(actorId: string, now: string, count: number): void {
    this.db.prepare("INSERT INTO contact_history(contact_id,at,actor_id,action,changed_json,before_json) VALUES('',?,?,'exported',?,NULL)").run(now, actorId, JSON.stringify({ count }));
  }

  /** All contacts in list order (the CSV export). */
  all(): ContactRow[] {
    return (this.db.prepare('SELECT * FROM contacts ORDER BY sort_key, id').all() as unknown as RawRow[]).map(ContactsStore.row);
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM contacts').get() as { n: number }).n);
  }
}
