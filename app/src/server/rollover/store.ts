import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ONCE_PER_YEAR_STEPS, type RolloverStep } from '../../shared/rollover.js';

// Records of the year rollover (年度の切り替え): one SQLite file (rollover.sqlite3) in the mail folder, so the app's backup
// carries it. Only the records live here: the organizations and events a run makes are written by their own stores
// (with their own history). Each run keeps who, when, which step, the counts, and one row per thing it made, written
// as it goes, so a run cut off half way can still be taken back.
//
// The copy steps run once per target year: a partial unique index refuses a second running or completed run for the
// same step and year, so two administrators pressing at once still make one copy. A run left "running" for ten
// minutes was cut off; the next confirm takes it over (the copy skips what already exists, so nothing doubles), even
// when nothing is left to copy, and it can be taken back like a completed one.

export const ROLLOVER_FILE = 'rollover.sqlite3';
const SCHEMA_VERSION = '1';
const STALE_MS = 10 * 60_000;

/** A run still "running" ten minutes after it started (or after its undo was claimed): it was cut off. */
export function isStale(run: { status: string; startedAt: string; undoneAt: string | null }, now: string): boolean {
  return run.status === 'running' && Date.parse(now) - Date.parse(run.undoneAt ?? run.startedAt) >= STALE_MS;
}

const onceSteps = ONCE_PER_YEAR_STEPS.map((s) => `'${s}'`).join(',');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  source_year INTEGER NOT NULL,
  target_year INTEGER NOT NULL,
  status TEXT NOT NULL,
  plan_token TEXT,
  actor_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT,
  undo_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_once_per_year ON runs(step, target_year) WHERE status IN ('running','done') AND step IN (${onceSteps});
CREATE UNIQUE INDEX IF NOT EXISTS runs_once_per_plan ON runs(step, plan_token) WHERE plan_token IS NOT NULL AND step = 'grants';
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS run_items(
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  made_id TEXT,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(run_id, idx)
);
`;

export type RunStatus = 'running' | 'done' | 'undone';

export interface RunRow {
  id: string;
  step: RolloverStep;
  sourceYear: number;
  targetYear: number;
  status: RunStatus;
  planToken: string | null;
  actorId: string;
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  counts: Record<string, number>;
  undoneAt: string | null;
  undoneBy: string | null;
  undo: unknown;
}

interface RawRun {
  id: string;
  step: string;
  source_year: number;
  target_year: number;
  status: string;
  plan_token: string | null;
  actor_id: string;
  started_at: string;
  finished_at: string | null;
  summary: string;
  counts_json: string;
  undone_at: string | null;
  undone_by: string | null;
  undo_json: string | null;
}

export interface RunItem {
  idx: number;
  kind: string;
  sourceId: string | null;
  madeId: string | null;
  name: string;
  data: Record<string, unknown>;
}

/** The answer of `begin`: a run to write into, or the run that stands in the way. */
export type BeginOutcome = { kind: 'started'; run: RunRow; resumed: boolean } | { kind: 'exists'; run: RunRow };

export class RolloverStore {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, ROLLOVER_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('rollover schema version');
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
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

  private static row(raw: RawRun): RunRow {
    return {
      id: raw.id,
      step: raw.step as RolloverStep,
      sourceYear: Number(raw.source_year),
      targetYear: Number(raw.target_year),
      status: raw.status as RunStatus,
      planToken: raw.plan_token,
      actorId: raw.actor_id,
      startedAt: raw.started_at,
      finishedAt: raw.finished_at,
      summary: raw.summary,
      counts: JSON.parse(raw.counts_json) as Record<string, number>,
      undoneAt: raw.undone_at,
      undoneBy: raw.undone_by,
      undo: raw.undo_json ? (JSON.parse(raw.undo_json) as unknown) : null,
    };
  }

  get(id: string): RunRow | null {
    const raw = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as RawRun | undefined;
    return raw ? RolloverStore.row(raw) : null;
  }

  /** The newest runs first. */
  list(limit = 50): RunRow[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?').all(limit) as unknown as RawRun[]).map(RolloverStore.row);
  }

  /** The newest run of a step for a target year (any status), or null. */
  lastOf(step: RolloverStep, targetYear: number): RunRow | null {
    const raw = this.db.prepare('SELECT * FROM runs WHERE step=? AND target_year=? ORDER BY started_at DESC, id DESC LIMIT 1').get(step, targetYear) as unknown as RawRun | undefined;
    return raw ? RolloverStore.row(raw) : null;
  }

  /** The running or completed copy of a step for a target year (what stops a second one), or null. */
  standing(step: RolloverStep, targetYear: number): RunRow | null {
    const raw = this.db.prepare("SELECT * FROM runs WHERE step=? AND target_year=? AND status IN ('running','done') ORDER BY started_at DESC LIMIT 1").get(step, targetYear) as unknown as RawRun | undefined;
    return raw ? RolloverStore.row(raw) : null;
  }

  /** The run that confirmed this plan (grants), or null. */
  byPlan(step: RolloverStep, planToken: string): RunRow | null {
    const raw = this.db.prepare('SELECT * FROM runs WHERE step=? AND plan_token=? LIMIT 1').get(step, planToken) as unknown as RawRun | undefined;
    return raw ? RolloverStore.row(raw) : null;
  }

  /**
   * Starts a run. For a copy step, a completed or still-running run for the same year comes back as `exists`, except a
   * copy cut off ten minutes ago or more, which this one takes over (`resumed`); an undo cut off is left to the next
   * undo. For the grants, the same plan confirmed twice comes back as `exists`.
   */
  begin(input: { step: RolloverStep; sourceYear: number; targetYear: number; planToken: string | null; actorId: string; now: string }): BeginOutcome {
    return this.tx(() => {
      if (ONCE_PER_YEAR_STEPS.includes(input.step)) {
        const standing = this.standing(input.step, input.targetYear);
        if (standing) {
          // A run being taken back (undone_at holds the claim) is finished by the undo, never taken over by a copy.
          if (!isStale(standing, input.now) || standing.undoneAt !== null) return { kind: 'exists' as const, run: standing };
          this.db.prepare('UPDATE runs SET actor_id=?, started_at=?, plan_token=?, undone_at=NULL WHERE id=?').run(input.actorId, input.now, input.planToken, standing.id);
          return { kind: 'started' as const, run: this.get(standing.id)!, resumed: true };
        }
      } else if (input.planToken !== null) {
        const same = this.byPlan(input.step, input.planToken);
        if (same) return { kind: 'exists' as const, run: same };
      }
      const id = `ro_${randomBytes(8).toString('hex')}`;
      this.db
        .prepare("INSERT INTO runs(id,step,source_year,target_year,status,plan_token,actor_id,started_at,finished_at,summary,counts_json) VALUES(?,?,?,?,'running',?,?,?,NULL,'','{}')")
        .run(id, input.step, input.sourceYear, input.targetYear, input.planToken, input.actorId, input.now);
      return { kind: 'started' as const, run: this.get(id)!, resumed: false };
    });
  }

  /** One thing the run made (or did), written at once so that an interrupted run can still be taken back. */
  addItem(runId: string, item: Omit<RunItem, 'idx'>): void {
    this.tx(() => {
      const next = Number((this.db.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM run_items WHERE run_id=?').get(runId) as { n: number }).n);
      this.db.prepare('INSERT INTO run_items(run_id,idx,kind,source_id,made_id,name,data_json) VALUES(?,?,?,?,?,?,?)').run(runId, next, item.kind, item.sourceId, item.madeId, item.name, JSON.stringify(item.data));
    });
  }

  items(runId: string): RunItem[] {
    const rows = this.db.prepare('SELECT idx, kind, source_id, made_id, name, data_json FROM run_items WHERE run_id=? ORDER BY idx').all(runId) as { idx: number; kind: string; source_id: string | null; made_id: string | null; name: string; data_json: string }[];
    return rows.map((r) => ({ idx: Number(r.idx), kind: r.kind, sourceId: r.source_id, madeId: r.made_id, name: r.name, data: JSON.parse(r.data_json) as Record<string, unknown> }));
  }

  finish(runId: string, summary: string, counts: Record<string, number>, now: string): RunRow {
    this.db.prepare("UPDATE runs SET status='done', summary=?, counts_json=?, finished_at=? WHERE id=?").run(summary, JSON.stringify(counts), now, runId);
    return this.get(runId)!;
  }

  /** A run that ends at once (the exports: nothing to take back). */
  record(input: { step: RolloverStep; sourceYear: number; targetYear: number; actorId: string; now: string; summary: string; counts: Record<string, number> }): RunRow {
    const id = `ro_${randomBytes(8).toString('hex')}`;
    this.db
      .prepare("INSERT INTO runs(id,step,source_year,target_year,status,plan_token,actor_id,started_at,finished_at,summary,counts_json) VALUES(?,?,?,?,'done',NULL,?,?,?,?,?)")
      .run(id, input.step, input.sourceYear, input.targetYear, input.actorId, input.now, input.now, input.summary, JSON.stringify(input.counts));
    return this.get(id)!;
  }

  /** Marks a run claimed by `claimUndo` as taken back. */
  markUndone(runId: string, actorId: string, now: string, undo: unknown): RunRow {
    this.db.prepare("UPDATE runs SET status='undone', undone_at=?, undone_by=?, undo_json=? WHERE id=? AND status='running'").run(now, actorId, JSON.stringify(undo), runId);
    return this.get(runId)!;
  }

  /**
   * Lets one undo at a time take a completed run, or a run cut off half way (two administrators taking back the same
   * run): the run is "running" while its copies are removed, so a new copy for the same year cannot start in between.
   * The claim's time goes in undone_at, so an undo in progress is not mistaken for a cut-off run, and an undo cut off
   * itself can be taken up again ten minutes later. Answers the status the run had, or null when it cannot be claimed.
   */
  claimUndo(runId: string, now: string): 'done' | 'running' | null {
    return this.tx(() => {
      const run = this.get(runId);
      if (run?.status === 'done') {
        this.db.prepare("UPDATE runs SET status='running', undone_at=? WHERE id=? AND status='done'").run(now, runId);
        return 'done' as const;
      }
      if (run && isStale(run, now)) {
        this.db.prepare("UPDATE runs SET undone_at=? WHERE id=? AND status='running'").run(now, runId);
        return 'running' as const;
      }
      return null;
    });
  }

  /**
   * Puts a claimed run back as it was when its undo failed: its status, and the claim time of an earlier undo it was
   * taking over (so a run being taken back stays one, and is not taken over by a copy).
   */
  releaseUndo(runId: string, previous: 'done' | 'running', previousUndoneAt: string | null = null): void {
    this.db.prepare("UPDATE runs SET status=?, undone_at=? WHERE id=? AND status='running'").run(previous, previousUndoneAt, runId);
  }

  count(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n);
  }
}
