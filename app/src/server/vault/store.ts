import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VAULT_LIMITS, vaultRoleRank, type VaultAction, type VaultMemberKind, type VaultRole } from '../../shared/vault.js';
import type { Sealed } from './cipher.js';
import { VAULT_FILE } from './config.js';

// パスワード帳 (2026-11-23): one SQLite file (vault.sqlite3) next to mail.sqlite3, so the app's backup of the mail
// folder carries it. It holds sealed entries only (cipher.ts): the names, addresses, IDs, passwords and notes are never
// written in the clear. What is plain: the sections' names and notes, who may open them, when entries changed and by
// whom, and the record of what was done (events) — never a value.
//
// A section must keep at least one member named in person with 管理する, so someone can always change who opens it.
// A section with entries cannot be removed.

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sections(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sections_name ON sections(name);
CREATE TABLE IF NOT EXISTS members(
  section_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  role TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY(section_id, kind, target)
);
CREATE TABLE IF NOT EXISTS entries(
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  data TEXT NOT NULL,
  client_token TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_token ON entries(client_token);
CREATE INDEX IF NOT EXISTS entries_section ON entries(section_id);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  section_id TEXT,
  entry_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_section ON events(section_id, id);
`;

export interface SectionRow {
  id: string;
  name: string;
  note: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface MemberRow {
  kind: VaultMemberKind;
  target: string;
  role: VaultRole;
  grantedBy: string;
  grantedAt: string;
}

export interface EntryRow {
  id: string;
  sectionId: string;
  sealed: Sealed;
  clientToken: string | null;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface EventRow {
  id: number;
  at: string;
  actorId: string;
  sectionId: string | null;
  entryId: string | null;
  action: VaultAction;
  detail: Record<string, unknown>;
}

/** Why a write was refused (null from a method means: not found). */
export type VaultRefusal = 'conflict' | 'duplicate_name' | 'not_empty' | 'last_manager' | 'too_many';

const ENTRY_CHANGES: VaultAction[] = ['entry_created', 'entry_updated', 'entry_deleted'];

export class VaultStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, VAULT_FILE));
    try {
      // secure_delete: a removed entry, and the sealed message an update replaced, are overwritten in the file.
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('vault schema version');
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

  // ---- sections

  private static section(raw: Record<string, unknown>): SectionRow {
    return {
      id: String(raw.id),
      name: String(raw.name),
      note: String(raw.note),
      version: Number(raw.version),
      createdAt: String(raw.created_at),
      createdBy: String(raw.created_by),
      updatedAt: String(raw.updated_at),
      updatedBy: String(raw.updated_by),
    };
  }

  sections(): SectionRow[] {
    return (this.db.prepare('SELECT * FROM sections ORDER BY name, id').all() as Record<string, unknown>[]).map(VaultStore.section);
  }

  section(id: string): SectionRow | null {
    const raw = this.db.prepare('SELECT * FROM sections WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return raw ? VaultStore.section(raw) : null;
  }

  private nameTaken(name: string, except: string | null): boolean {
    return this.db.prepare('SELECT 1 FROM sections WHERE name=? AND id IS NOT ?').get(name, except) !== undefined;
  }

  /** A new section; the person who makes it is its first member, with 管理する. */
  createSection(id: string, name: string, note: string, actor: string, now: string): SectionRow | 'duplicate_name' | 'too_many' {
    return this.tx(() => {
      if (this.nameTaken(name, null)) return 'duplicate_name';
      if (this.sections().length >= VAULT_LIMITS.sections) return 'too_many';
      this.db.prepare('INSERT INTO sections(id,name,note,version,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,1,?,?,?,?)').run(id, name, note, now, actor, now, actor);
      this.db.prepare("INSERT INTO members(section_id,kind,target,role,granted_by,granted_at) VALUES(?,'user',?,'manage',?,?)").run(id, actor, actor, now);
      this.event(now, actor, id, null, 'section_created', { name });
      return this.section(id)!;
    });
  }

  updateSection(id: string, expectedVersion: number, name: string, note: string, actor: string, now: string): SectionRow | VaultRefusal | null {
    return this.tx(() => {
      const cur = this.section(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      if (cur.name === name && cur.note === note) return cur;
      if (this.nameTaken(name, id)) return 'duplicate_name';
      this.db.prepare('UPDATE sections SET name=?,note=?,version=version+1,updated_at=?,updated_by=? WHERE id=?').run(name, note, now, actor, id);
      this.event(now, actor, id, null, 'section_updated', { from: cur.name, to: name, note: cur.note !== note });
      return this.section(id)!;
    });
  }

  /** Removes an empty section and who opens it (the record of what was done stays). */
  deleteSection(id: string, expectedVersion: number, actor: string, now: string): true | VaultRefusal | null {
    return this.tx(() => {
      const cur = this.section(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      if (this.entryCount(id) > 0) return 'not_empty';
      this.db.prepare('DELETE FROM members WHERE section_id=?').run(id);
      this.db.prepare('DELETE FROM sections WHERE id=?').run(id);
      this.event(now, actor, id, null, 'section_deleted', { name: cur.name });
      return true;
    });
  }

  // ---- who opens a section

  members(sectionId: string): MemberRow[] {
    const rows = this.db.prepare("SELECT * FROM members WHERE section_id=? ORDER BY CASE kind WHEN 'department' THEN 0 ELSE 1 END, target").all(sectionId) as Record<string, unknown>[];
    return rows.map((r) => ({ kind: r.kind as VaultMemberKind, target: String(r.target), role: r.role as VaultRole, grantedBy: String(r.granted_by), grantedAt: String(r.granted_at) }));
  }

  /** Every grant of every section (section id → grants), for working out a person's sections at once. */
  allMembers(): Map<string, MemberRow[]> {
    const out = new Map<string, MemberRow[]>();
    for (const s of this.sections()) out.set(s.id, this.members(s.id));
    return out;
  }

  /**
   * Gives a role to a department or a member, changes it, or (role null) takes it away. Refused when another change came
   * first (the section's version), or when the change would leave no current member named in person with 管理する
   * (`current`: still a committee member; someone who left does not count).
   */
  setMember(sectionId: string, expectedVersion: number, kind: VaultMemberKind, target: string, role: VaultRole | null, actor: string, now: string, current: (userId: string) => boolean = () => true): SectionRow | VaultRefusal | null {
    return this.tx(() => {
      const cur = this.section(sectionId);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      const before = this.members(sectionId);
      const existing = before.find((m) => m.kind === kind && m.target === target) ?? null;
      if ((existing?.role ?? null) === role) return cur;
      const after = before.filter((m) => !(m.kind === kind && m.target === target));
      if (role) after.push({ kind, target, role, grantedBy: actor, grantedAt: now });
      const managers = (list: MemberRow[]) => list.filter((m) => m.kind === 'user' && m.role === 'manage' && current(m.target)).length;
      // Only a change that takes away the last one is refused: a section whose managers have all left can still be fixed.
      if (managers(after) === 0 && managers(before) > 0) return 'last_manager';
      if (role && !existing && before.length >= VAULT_LIMITS.membersPerSection) return 'too_many';
      if (role) {
        this.db
          .prepare('INSERT INTO members(section_id,kind,target,role,granted_by,granted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(section_id,kind,target) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by, granted_at=excluded.granted_at')
          .run(sectionId, kind, target, role, actor, now);
      } else {
        this.db.prepare('DELETE FROM members WHERE section_id=? AND kind=? AND target=?').run(sectionId, kind, target);
      }
      this.db.prepare('UPDATE sections SET version=version+1,updated_at=?,updated_by=? WHERE id=?').run(now, actor, sectionId);
      this.event(now, actor, sectionId, null, role ? 'member_set' : 'member_removed', { kind, target, role, from: existing?.role ?? null });
      return this.section(sectionId)!;
    });
  }

  /** The strongest role this person holds in a section, from their own grant and their departments'. */
  static roleIn(grants: MemberRow[], userId: string, departments: string[]): VaultRole | null {
    let best: VaultRole | null = null;
    for (const g of grants) {
      const hit = g.kind === 'user' ? g.target === userId : departments.includes(g.target);
      if (hit && vaultRoleRank(g.role) > vaultRoleRank(best)) best = g.role;
    }
    return best;
  }

  // ---- entries

  private static entry(raw: Record<string, unknown>): EntryRow {
    return {
      id: String(raw.id),
      sectionId: String(raw.section_id),
      sealed: { keyId: String(raw.key_id), iv: String(raw.iv), tag: String(raw.tag), data: String(raw.data) },
      clientToken: raw.client_token === null ? null : String(raw.client_token),
      version: Number(raw.version),
      createdAt: String(raw.created_at),
      createdBy: String(raw.created_by),
      updatedAt: String(raw.updated_at),
      updatedBy: String(raw.updated_by),
    };
  }

  entryCount(sectionId: string): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM entries WHERE section_id=?').get(sectionId) as { n: number }).n);
  }

  entries(sectionIds: string[]): EntryRow[] {
    if (sectionIds.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM entries WHERE section_id IN (${sectionIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...sectionIds) as Record<string, unknown>[];
    return rows.map(VaultStore.entry);
  }

  entry(id: string): EntryRow | null {
    const raw = this.db.prepare('SELECT * FROM entries WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return raw ? VaultStore.entry(raw) : null;
  }

  entryByToken(token: string): EntryRow | null {
    const raw = this.db.prepare('SELECT * FROM entries WHERE client_token=?').get(token) as Record<string, unknown> | undefined;
    return raw ? VaultStore.entry(raw) : null;
  }

  insertEntry(id: string, sectionId: string, sealed: Sealed, token: string | null, actor: string, now: string): EntryRow | VaultRefusal | null {
    return this.tx(() => {
      if (!this.section(sectionId)) return null;
      if (this.entryCount(sectionId) >= VAULT_LIMITS.entriesPerSection) return 'too_many';
      this.db
        .prepare('INSERT INTO entries(id,section_id,key_id,iv,tag,data,client_token,version,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)')
        .run(id, sectionId, sealed.keyId, sealed.iv, sealed.tag, sealed.data, token, now, actor, now, actor);
      this.event(now, actor, sectionId, id, 'entry_created', {});
      return this.entry(id)!;
    });
  }

  /** Replaces an entry's sealed message (and its section, when it moves). `changed` names the fields, never values. */
  updateEntry(id: string, expectedVersion: number, sectionId: string, sealed: Sealed, changed: string[], actor: string, now: string): EntryRow | VaultRefusal | null {
    return this.tx(() => {
      const cur = this.entry(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      if (sectionId !== cur.sectionId) {
        if (!this.section(sectionId)) return null;
        if (this.entryCount(sectionId) >= VAULT_LIMITS.entriesPerSection) return 'too_many';
      }
      this.db
        .prepare('UPDATE entries SET section_id=?,key_id=?,iv=?,tag=?,data=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?')
        .run(sectionId, sealed.keyId, sealed.iv, sealed.tag, sealed.data, now, actor, id, expectedVersion);
      if (sectionId !== cur.sectionId) {
        // A move is a change in both sections: their paper copies are both out of date.
        this.event(now, actor, cur.sectionId, id, 'entry_updated', { changed, movedTo: sectionId });
        this.event(now, actor, sectionId, id, 'entry_updated', { changed, movedFrom: cur.sectionId });
      } else {
        this.event(now, actor, sectionId, id, 'entry_updated', { changed });
      }
      return this.entry(id)!;
    });
  }

  deleteEntry(id: string, expectedVersion: number, actor: string, now: string): true | VaultRefusal | null {
    return this.tx(() => {
      const cur = this.entry(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      this.db.prepare('DELETE FROM entries WHERE id=? AND version=?').run(id, expectedVersion);
      this.event(now, actor, cur.sectionId, id, 'entry_deleted', {});
      return true;
    });
  }

  // ---- the record

  private event(at: string, actor: string, sectionId: string | null, entryId: string | null, action: VaultAction, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events(at,actor_id,section_id,entry_id,action,detail_json) VALUES(?,?,?,?,?,?)').run(at, actor, sectionId, entryId, action, JSON.stringify(detail));
  }

  /** Records a value handed out (shown, copied, printed). Written before the value leaves the server. */
  record(at: string, actor: string, sectionId: string, entryId: string | null, action: 'revealed' | 'copied' | 'printed', detail: Record<string, unknown>): void {
    this.event(at, actor, sectionId, entryId, action, detail);
  }

  events(sectionId: string, limit: number = VAULT_LIMITS.events): EventRow[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE section_id=? ORDER BY id DESC LIMIT ?').all(sectionId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actorId: String(r.actor_id),
      sectionId: r.section_id === null ? null : String(r.section_id),
      entryId: r.entry_id === null ? null : String(r.entry_id),
      action: r.action as VaultAction,
      detail: JSON.parse(String(r.detail_json)) as Record<string, unknown>,
    }));
  }

  /** When the section was last printed, and how many entry changes came after (since the start when never printed). */
  printState(sectionId: string): { lastPrintedAt: string | null; changesSincePrint: number } {
    const last = this.db.prepare("SELECT id, at FROM events WHERE section_id=? AND action='printed' ORDER BY id DESC LIMIT 1").get(sectionId) as { id: number; at: string } | undefined;
    const since = last ? Number(last.id) : 0;
    const n = this.db
      .prepare(`SELECT count(*) AS n FROM events WHERE section_id=? AND id>? AND action IN (${ENTRY_CHANGES.map(() => '?').join(',')})`)
      .get(sectionId, since, ...ENTRY_CHANGES) as { n: number };
    return { lastPrintedAt: last ? String(last.at) : null, changesSincePrint: Number(n.n) };
  }
}
