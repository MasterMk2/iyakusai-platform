import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeContactSearch } from '../../shared/contacts.js';
import {
  DECISION_FIELD_KEYS,
  DECISION_SOURCE_LABELS,
  DECISION_VENUE_LABELS,
  type DecisionAction,
  type DecisionInput,
  type DecisionSource,
  type DecisionStatus,
  type DecisionVenue,
} from '../../shared/decisions.js';
import { DomainError } from '../domain/types.js';

/** A form's retry with the same token but other content: the first one is saved, so the second cannot be. */
const SAME_TOKEN_OTHER_CONTENT ='同じ送信がすでに保存されていて、内容が違うため保存できませんでした。一覧で保存された内容を確かめてください。内容を変えるときは、その決定の「内容を直す」か「変更として登録」を使ってください。';

// Decision register (2026-11-03): one SQLite file (decisions.sqlite3) next to mail.sqlite3, so the backups of the
// mail folder carry it. A decision is never deleted: it is active, changed (replaced by a newer decision) or revoked.
// A change is a new decision that names the one it replaces; the old one points forward to it. Every change keeps
// a history row, and an edit, a replacement, a revoke or a restore keeps the record as it was before (before_json),
// so a mistake can be put back by hand. A registration may carry a client token: the same token returns the
// decision the first call made, so a retried registration never makes a second one.

export const DECISIONS_FILE = 'decisions.sqlite3';
const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  departments_json TEXT NOT NULL,
  decided_on TEXT NOT NULL,
  venue TEXT NOT NULL,
  venue_other TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  task_ids_json TEXT NOT NULL,
  supersedes TEXT,
  superseded_by TEXT,
  change_note TEXT NOT NULL,
  revoke_note TEXT NOT NULL,
  search_text TEXT NOT NULL,
  client_token TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_token ON decisions(client_token);
CREATE INDEX IF NOT EXISTS decisions_decided ON decisions(decided_on, created_at);
CREATE INDEX IF NOT EXISTS decisions_changed ON decisions(updated_at, id);
CREATE TABLE IF NOT EXISTS decision_history(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, changed_json TEXT NOT NULL, before_json TEXT);
CREATE INDEX IF NOT EXISTS decision_history_decision ON decision_history(decision_id, id);
`;

export interface DecisionRow {
  id: string;
  status: DecisionStatus;
  input: DecisionInput;
  supersedes: string | null;
  supersededBy: string | null;
  changeNote: string;
  revokeNote: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

interface RawRow {
  id: string;
  status: string;
  title: string;
  body: string;
  departments_json: string;
  decided_on: string;
  venue: string;
  venue_other: string;
  sources_json: string;
  task_ids_json: string;
  supersedes: string | null;
  superseded_by: string | null;
  change_note: string;
  revoke_note: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface HistoryRow {
  at: string;
  actorId: string;
  action: DecisionAction;
  changed: string[];
}

export interface DecisionFilter {
  terms: string[];
  department?: string;
  status?: DecisionStatus;
  /** Decided-on bounds (YYYY-MM-DD), both inclusive. */
  from?: string;
  to?: string;
}

/** A write's answer: the row, or a reason it was refused (null: not found). */
export type WriteOutcome = DecisionRow | 'conflict' | 'not_active' | 'not_revoked' | 'chain_busy' | null;

// The stored text a search reads: everything a person would type to find a decision.
export function decisionSearchText(input: DecisionInput, extra: string[] = []): string {
  const words = [input.title, input.body, input.departments.join(' '), input.venue, input.venueOther, ...input.sources.flatMap((s) => [s.label, DECISION_SOURCE_LABELS[s.kind]]), ...input.taskIds, ...extra];
  return normalizeContactSearch(words.join('\n'));
}

/** The fields of an input that differ between two versions of a decision (keys of DecisionInput). */
export function changedDecisionFields(before: DecisionInput, after: DecisionInput): string[] {
  return DECISION_FIELD_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

const newId = () => `dc_${randomBytes(8).toString('hex')}`;

export class DecisionsStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, DECISIONS_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('decisions schema version');
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

  private static row(raw: RawRow): DecisionRow {
    return {
      id: raw.id,
      status: raw.status as DecisionStatus,
      input: {
        title: raw.title,
        body: raw.body,
        departments: JSON.parse(raw.departments_json) as string[],
        decidedOn: raw.decided_on,
        venue: raw.venue as DecisionVenue,
        venueOther: raw.venue_other,
        sources: JSON.parse(raw.sources_json) as DecisionSource[],
        taskIds: JSON.parse(raw.task_ids_json) as string[],
      },
      supersedes: raw.supersedes,
      supersededBy: raw.superseded_by,
      changeNote: raw.change_note,
      revokeNote: raw.revoke_note,
      version: Number(raw.version),
      createdAt: raw.created_at,
      createdBy: raw.created_by,
      updatedAt: raw.updated_at,
      updatedBy: raw.updated_by,
    };
  }

  /** The record as it stood, for before_json (the input and the chain and status fields). */
  private static snapshot(r: DecisionRow): string {
    return JSON.stringify({ status: r.status, input: r.input, supersedes: r.supersedes, supersededBy: r.supersededBy, changeNote: r.changeNote, revokeNote: r.revokeNote });
  }

  private where(f: DecisionFilter): { sql: string; params: (string | number)[] } {
    const parts: string[] = [];
    const params: (string | number)[] = [];
    for (const raw of f.terms) {
      // The same folding as the stored text (katakana and width), so a term finds what the screen would show.
      const term = normalizeContactSearch(raw);
      parts.push("decisions.search_text LIKE ? ESCAPE '\\'");
      params.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    }
    if (f.department !== undefined) {
      parts.push('EXISTS (SELECT 1 FROM json_each(decisions.departments_json) j WHERE j.value = ?)');
      params.push(f.department);
    }
    if (f.status !== undefined) {
      parts.push('decisions.status = ?');
      params.push(f.status);
    }
    if (f.from !== undefined) {
      parts.push('decisions.decided_on >= ?');
      params.push(f.from);
    }
    if (f.to !== undefined) {
      parts.push('decisions.decided_on <= ?');
      params.push(f.to);
    }
    return { sql: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
  }

  /** One page, newest decided first (`decided`) or newest changed first (`changed`). */
  page(f: DecisionFilter, sort: 'decided' | 'changed', limit: number, offset: number): { total: number; rows: DecisionRow[] } {
    const w = this.where(f);
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM decisions WHERE ${w.sql}`).get(...w.params) as { n: number }).n);
    const order = sort === 'changed' ? 'decisions.updated_at DESC, decisions.id DESC' : 'decisions.decided_on DESC, decisions.created_at DESC, decisions.id DESC';
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...w.params, limit, offset) as unknown as RawRow[];
    return { total, rows: rows.map(DecisionsStore.row) };
  }

  get(id: string): DecisionRow | null {
    const raw = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id) as unknown as RawRow | undefined;
    return raw ? DecisionsStore.row(raw) : null;
  }

  /** How many decisions were registered with a token that starts so (the items of one meeting, 2026-11-06). */
  countByTokenPrefix(prefix: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE substr(client_token, 1, ?) = ?').get(prefix.length, prefix) as { n: number };
    return Number(r.n);
  }

  byToken(token: string): DecisionRow | null {
    const raw = this.db.prepare('SELECT * FROM decisions WHERE client_token=?').get(token) as unknown as RawRow | undefined;
    return raw ? DecisionsStore.row(raw) : null;
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }).n);
  }

  /** Department keys that some decision uses, in order. */
  departmentKeys(): string[] {
    return (this.db.prepare('SELECT DISTINCT j.value AS key FROM decisions, json_each(decisions.departments_json) j ORDER BY j.value').all() as { key: string }[]).map((r) => r.key);
  }

  /**
   * The chain a decision belongs to, oldest first, the decision itself included. A change that was revoked stays
   * in the chain of the decision it replaced (right after it): revoking the change cleared the replaced decision's
   * link forward, so the chain would otherwise lose it.
   */
  chain(id: string): DecisionRow[] {
    const cur = this.get(id);
    if (!cur) return [];
    const before: DecisionRow[] = [];
    for (let p = cur.supersedes, guard = 0; p && guard < 100; guard += 1) {
      const r = this.get(p);
      if (!r) break;
      before.unshift(r);
      p = r.supersedes;
    }
    const after: DecisionRow[] = [];
    for (let n = cur.supersededBy, guard = 0; n && guard < 100; guard += 1) {
      const r = this.get(n);
      if (!r) break;
      after.push(r);
      n = r.supersededBy;
    }
    const line = [...before, cur, ...after];
    const out: DecisionRow[] = [];
    const seen = new Set<string>();
    const visit = (row: DecisionRow, depth: number): void => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      out.push(row);
      if (depth >= 100) return;
      for (const revoked of this.revokedChanges(row.id)) visit(revoked, depth + 1);
    };
    for (const row of line) visit(row, 0);
    return out;
  }

  /** The changes of a decision that were revoked (they point back at it), oldest first. */
  private revokedChanges(id: string): DecisionRow[] {
    return (this.db.prepare("SELECT * FROM decisions WHERE supersedes=? AND status='revoked' ORDER BY created_at, id").all(id) as unknown as RawRow[]).map(DecisionsStore.row);
  }

  history(id: string, limit = 100): HistoryRow[] {
    const rows = this.db.prepare('SELECT at, actor_id, action, changed_json FROM decision_history WHERE decision_id=? ORDER BY id DESC LIMIT ?').all(id, limit) as { at: string; actor_id: string; action: string; changed_json: string }[];
    return rows.map((r) => ({ at: r.at, actorId: r.actor_id, action: r.action as DecisionAction, changed: JSON.parse(r.changed_json) as string[] }));
  }

  /** The most recently changed records, for the Bot's answer. */
  latestChanged(limit: number): DecisionRow[] {
    return (this.db.prepare('SELECT * FROM decisions ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit) as unknown as RawRow[]).map(DecisionsStore.row);
  }

  private addHistory(id: string, at: string, actorId: string, action: DecisionAction, changed: string[], before: string | null): void {
    this.db.prepare('INSERT INTO decision_history(decision_id,at,actor_id,action,changed_json,before_json) VALUES(?,?,?,?,?,?)').run(id, at, actorId, action, JSON.stringify(changed), before);
  }

  private insertRow(id: string, input: DecisionInput, meta: { status: DecisionStatus; supersedes: string | null; changeNote: string; token: string | null; now: string; actorId: string }): void {
    this.db
      .prepare(
        'INSERT INTO decisions(id,status,title,body,departments_json,decided_on,venue,venue_other,sources_json,task_ids_json,supersedes,superseded_by,change_note,revoke_note,search_text,client_token,version,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,\'\',?,?,1,?,?,?,?)',
      )
      .run(
        id,
        meta.status,
        input.title,
        input.body,
        JSON.stringify(input.departments),
        input.decidedOn,
        input.venue,
        input.venueOther,
        JSON.stringify(input.sources),
        JSON.stringify(input.taskIds),
        meta.supersedes,
        meta.changeNote,
        decisionSearchText(input, [DECISION_VENUE_LABELS[input.venue], input.venueOther, meta.changeNote]),
        meta.token,
        meta.now,
        meta.actorId,
        meta.now,
        meta.actorId,
      );
  }

  /**
   * A new decision. A token that an earlier registration already used answers that registration (`replayed`) and
   * writes nothing. With `compare` (a form's token) a different content is refused (409) rather than dropped
   * silently. With `first` (a minutes item, whose token names the item) the decision made for the item is returned
   * whatever the content.
   */
  create(input: DecisionInput, actorId: string, now: string, token: string | null, reuse: 'compare' | 'first' = 'compare'): { row: DecisionRow; replayed: boolean } {
    return this.tx(() => {
      if (token !== null) {
        const same = this.byToken(token);
        if (same) {
          if (reuse === 'first' || changedDecisionFields(same.input, input).length === 0) return { row: same, replayed: true };
          throw new DomainError('conflict', SAME_TOKEN_OTHER_CONTENT);
        }
      }
      const id = newId();
      this.insertRow(id, input, { status: 'active', supersedes: null, changeNote: '', token, now, actorId });
      this.addHistory(id, now, actorId, 'created', [], null);
      return { row: this.get(id)!, replayed: false };
    });
  }

  /** Edits an active decision. Nothing changed leaves the version alone. */
  update(id: string, expectedVersion: number, input: DecisionInput, actorId: string, now: string): WriteOutcome {
    return this.tx((): WriteOutcome => {
      const before = this.get(id);
      if (!before) return null;
      if (before.version !== expectedVersion) return 'conflict';
      if (before.status !== 'active') return 'not_active';
      const changed = changedDecisionFields(before.input, input);
      if (changed.length === 0) return before;
      this.db
        .prepare("UPDATE decisions SET title=?,body=?,departments_json=?,decided_on=?,venue=?,venue_other=?,sources_json=?,task_ids_json=?,search_text=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?")
        .run(
          input.title,
          input.body,
          JSON.stringify(input.departments),
          input.decidedOn,
          input.venue,
          input.venueOther,
          JSON.stringify(input.sources),
          JSON.stringify(input.taskIds),
          decisionSearchText(input, [DECISION_VENUE_LABELS[input.venue], input.venueOther, before.changeNote]),
          now,
          actorId,
          id,
          expectedVersion,
        );
      this.addHistory(id, now, actorId, 'updated', changed, DecisionsStore.snapshot(before));
      return this.get(id)!;
    });
  }

  /**
   * A change: a new active decision that replaces an active one. Both records move in one transaction; a second
   * change of the same decision finds it no longer active (or its version moved) and is refused.
   */
  supersede(oldId: string, expectedVersion: number, input: DecisionInput, changeNote: string, actorId: string, now: string): { old: DecisionRow; row: DecisionRow } | 'conflict' | 'not_active' | null {
    return this.tx(() => {
      const old = this.get(oldId);
      if (!old) return null;
      if (old.version !== expectedVersion) return 'conflict';
      if (old.status !== 'active') return 'not_active';
      const id = newId();
      this.insertRow(id, input, { status: 'active', supersedes: oldId, changeNote, token: null, now, actorId });
      this.db.prepare("UPDATE decisions SET status='changed', superseded_by=?, version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?").run(id, now, actorId, oldId, expectedVersion);
      this.addHistory(oldId, now, actorId, 'replaced', ['status'], DecisionsStore.snapshot(old));
      this.addHistory(id, now, actorId, 'created', [], null);
      return { old: this.get(oldId)!, row: this.get(id)! };
    });
  }

  /**
   * Revokes an active decision. If it was a change of another, that one becomes active again (it is not replaced
   * by a revoked decision).
   */
  revoke(id: string, expectedVersion: number, note: string, actorId: string, now: string): WriteOutcome {
    return this.tx((): WriteOutcome => {
      const cur = this.get(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      if (cur.status !== 'active') return 'not_active';
      this.db.prepare("UPDATE decisions SET status='revoked', revoke_note=?, version=version+1, updated_at=?, updated_by=? WHERE id=? AND version=?").run(note, now, actorId, id, expectedVersion);
      this.addHistory(id, now, actorId, 'revoked', ['status'], DecisionsStore.snapshot(cur));
      const prev = cur.supersedes ? this.get(cur.supersedes) : null;
      if (prev && prev.status === 'changed' && prev.supersededBy === id) {
        this.db.prepare("UPDATE decisions SET status='active', superseded_by=NULL, version=version+1, updated_at=?, updated_by=? WHERE id=?").run(now, actorId, prev.id);
        this.addHistory(prev.id, now, actorId, 'reactivated', ['status'], DecisionsStore.snapshot(prev));
      }
      return this.get(id)!;
    });
  }

  /**
   * Restores a revoked decision. A change comes back only when the decision it replaces is still active and not
   * replaced by another decision; then that one is replaced again.
   */
  restore(id: string, expectedVersion: number, actorId: string, now: string): WriteOutcome {
    return this.tx((): WriteOutcome => {
      const cur = this.get(id);
      if (!cur) return null;
      if (cur.version !== expectedVersion) return 'conflict';
      if (cur.status !== 'revoked') return 'not_revoked';
      const prev = cur.supersedes ? this.get(cur.supersedes) : null;
      if (prev && (prev.status !== 'active' || prev.supersededBy !== null)) return 'chain_busy';
      if (prev) {
        this.db.prepare("UPDATE decisions SET status='changed', superseded_by=?, version=version+1, updated_at=?, updated_by=? WHERE id=?").run(id, now, actorId, prev.id);
        this.addHistory(prev.id, now, actorId, 'replaced', ['status'], DecisionsStore.snapshot(prev));
      }
      this.db.prepare("UPDATE decisions SET status='active', revoke_note='', version=version+1, updated_at=?, updated_by=? WHERE id=?").run(now, actorId, id);
      this.addHistory(id, now, actorId, 'restored', ['status'], DecisionsStore.snapshot(cur));
      return this.get(id)!;
    });
  }
}
