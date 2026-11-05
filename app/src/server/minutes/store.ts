import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MinutesAudioExtension, MinutesDraft, MinutesStage, MinutesVisibility, Transcript } from '../../shared/minutes.js';

// Meeting minutes (α, 2026-11-02): one SQLite file (minutes.sqlite3) in the mail folder, so the app's backup
// carries it; the recordings are separate files in minutes-audio/ and are not backed up (they are deleted a
// fixed number of days after confirmation). A meeting moves through the stages of shared/minutes.ts; the worker
// takes a waiting stage with a lease, and a lease that runs out puts the stage back (at most MAX_ATTEMPTS times).
// Every change of the minutes keeps a history row with the body as it was before; a change of the settings (title,
// date, who may read it) keeps the settings as they were before, as JSON in the same column.

export const MINUTES_FILE = 'minutes.sqlite3';
export const AUDIO_DIR = 'minutes-audio';
const SCHEMA_VERSION = '1';
export const MAX_ATTEMPTS = 3;
/** How long the worker may hold a stage before it is offered again. */
export const LEASE_MS = { transcribe: 8 * 3_600_000, summarize: 45 * 60_000 } as const;
export type WorkerStage = keyof typeof LEASE_MS;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meetings(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  held_on TEXT NOT NULL,
  visibility TEXT NOT NULL,
  viewers_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  failed_stage TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  audio_ext TEXT NOT NULL,
  audio_bytes INTEGER NOT NULL,
  audio_sha256 TEXT NOT NULL,
  audio_deleted_at TEXT,
  transcript_json TEXT,
  draft_json TEXT,
  body TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS meetings_stage ON meetings(stage, created_at);
CREATE TABLE IF NOT EXISTS meeting_history(id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, before_body TEXT);
CREATE INDEX IF NOT EXISTS meeting_history_meeting ON meeting_history(meeting_id, id);
`;

export interface MeetingRow {
  id: string;
  title: string;
  heldOn: string;
  visibility: MinutesVisibility;
  viewers: string[];
  stage: MinutesStage;
  failedStage: WorkerStage | null;
  error: string | null;
  attempts: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  audioExt: MinutesAudioExtension;
  audioBytes: number;
  audioSha256: string;
  audioDeletedAt: string | null;
  transcript: Transcript | null;
  draft: MinutesDraft | null;
  body: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

interface RawRow {
  id: string;
  title: string;
  held_on: string;
  visibility: string;
  viewers_json: string;
  stage: string;
  failed_stage: string | null;
  error: string | null;
  attempts: number;
  lease_token: string | null;
  lease_until: number | null;
  audio_ext: string;
  audio_bytes: number;
  audio_sha256: string;
  audio_deleted_at: string | null;
  transcript_json: string | null;
  draft_json: string | null;
  body: string;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

const fromRaw = (r: RawRow): MeetingRow => ({
  id: r.id,
  title: r.title,
  heldOn: r.held_on,
  visibility: r.visibility as MinutesVisibility,
  viewers: JSON.parse(r.viewers_json) as string[],
  stage: r.stage as MinutesStage,
  failedStage: (r.failed_stage as WorkerStage | null) ?? null,
  error: r.error,
  attempts: Number(r.attempts),
  leaseToken: r.lease_token,
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  audioExt: r.audio_ext as MinutesAudioExtension,
  audioBytes: Number(r.audio_bytes),
  audioSha256: r.audio_sha256,
  audioDeletedAt: r.audio_deleted_at,
  transcript: r.transcript_json ? (JSON.parse(r.transcript_json) as Transcript) : null,
  draft: r.draft_json ? (JSON.parse(r.draft_json) as MinutesDraft) : null,
  body: r.body,
  version: Number(r.version),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
});

export interface NewMeeting {
  title: string;
  heldOn: string;
  visibility: MinutesVisibility;
  viewers: string[];
  audioExt: MinutesAudioExtension;
  audioBytes: number;
  audioSha256: string;
}

export type MeetingSettings = Pick<MeetingRow, 'title' | 'heldOn' | 'visibility' | 'viewers'>;

export interface ClaimedJob {
  row: MeetingRow;
  stage: WorkerStage;
  leaseToken: string;
}

export const newMeetingId = () => `mt_${randomBytes(8).toString('hex')}`;

export class MinutesStore {
  readonly db: DatabaseSync;
  readonly audioDir: string;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.audioDir = path.join(root, AUDIO_DIR);
    mkdirSync(this.audioDir, { recursive: true });
    this.db = new DatabaseSync(path.join(root, MINUTES_FILE));
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      if (!version) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (version.value !== SCHEMA_VERSION) throw new Error('minutes schema version');
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  audioPath(row: Pick<MeetingRow, 'id' | 'audioExt'>): string {
    return path.join(this.audioDir, `${row.id}.${row.audioExt}`);
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

  private history(id: string, at: string, actor: string, action: string, beforeBody: string | null): void {
    this.db.prepare('INSERT INTO meeting_history(meeting_id, at, actor_id, action, before_body) VALUES(?,?,?,?,?)').run(id, at, actor, action, beforeBody);
  }

  get(id: string): MeetingRow | null {
    const r = this.db.prepare('SELECT * FROM meetings WHERE id=?').get(id) as RawRow | undefined;
    return r ? fromRaw(r) : null;
  }

  /** Newest meetings first (the routes filter what a person may see). */
  all(): MeetingRow[] {
    return (this.db.prepare('SELECT * FROM meetings ORDER BY held_on DESC, created_at DESC').all() as unknown as RawRow[]).map(fromRaw);
  }

  /** A meeting whose audio file is already in place (the routes write it first under the new ID). */
  create(id: string, m: NewMeeting, actor: string, now: string): MeetingRow {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO meetings(id,title,held_on,visibility,viewers_json,stage,audio_ext,audio_bytes,audio_sha256,body,version,created_by,created_at,updated_by,updated_at)
           VALUES(?,?,?,?,?,'transcribe_wait',?,?,?,'',1,?,?,?,?)`,
        )
        .run(id, m.title, m.heldOn, m.visibility, JSON.stringify(m.viewers), m.audioExt, m.audioBytes, m.audioSha256, actor, now, actor, now);
      this.history(id, now, actor, 'create', null);
    });
    return this.get(id)!;
  }

  /**
   * Gives the worker the oldest waiting stage, or a running one whose lease ran out (counted as a new attempt;
   * after MAX_ATTEMPTS the meeting fails). Only the stages the worker asked for.
   */
  claim(stages: WorkerStage[], nowMs: number, now: string): ClaimedJob | null {
    return this.tx(() => {
      // Stages held too long, of the kinds this worker does: back to waiting, or failed after the last attempt. (A
      // worker that only summarizes never takes a long transcription away from the one that transcribes.)
      const running = stages.map((s) => `'${s}_run'`).join(',');
      if (!running) return null;
      const expired = this.db.prepare(`SELECT * FROM meetings WHERE stage IN (${running}) AND lease_until < ?`).all(nowMs) as unknown as RawRow[];
      for (const r of expired) {
        const stage: WorkerStage = r.stage === 'transcribe_run' ? 'transcribe' : 'summarize';
        if (Number(r.attempts) >= MAX_ATTEMPTS) {
          this.db
            .prepare("UPDATE meetings SET stage='failed', failed_stage=?, error=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?")
            .run(stage, `処理が ${MAX_ATTEMPTS} 回とも時間内に終わりませんでした。`, now, r.id);
        } else {
          this.db.prepare('UPDATE meetings SET stage=?, lease_token=NULL, lease_until=NULL WHERE id=?').run(`${stage}_wait`, r.id);
        }
      }
      const waiting = stages.map((s) => `'${s}_wait'`).join(',');
      if (!waiting) return null;
      const r = this.db.prepare(`SELECT * FROM meetings WHERE stage IN (${waiting}) ORDER BY created_at, id LIMIT 1`).get() as RawRow | undefined;
      if (!r) return null;
      const stage: WorkerStage = r.stage === 'transcribe_wait' ? 'transcribe' : 'summarize';
      const token = randomBytes(18).toString('base64url');
      this.db
        .prepare('UPDATE meetings SET stage=?, lease_token=?, lease_until=?, attempts=attempts+1, error=NULL, failed_stage=NULL WHERE id=?')
        .run(`${stage}_run`, token, nowMs + LEASE_MS[stage], r.id);
      return { row: this.get(r.id)!, stage, leaseToken: token };
    });
  }

  /** The row while the worker still holds this stage with this lease, else null (a late or repeated answer). */
  private held(id: string, stage: WorkerStage, token: string): RawRow | null {
    const r = this.db.prepare('SELECT * FROM meetings WHERE id=?').get(id) as RawRow | undefined;
    if (!r || r.stage !== `${stage}_run` || r.lease_token !== token) return null;
    return r;
  }

  completeTranscript(id: string, token: string, transcript: Transcript, now: string): boolean {
    return this.tx(() => {
      if (!this.held(id, 'transcribe', token)) return false;
      this.db
        .prepare("UPDATE meetings SET stage='summarize_wait', transcript_json=?, attempts=0, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?")
        .run(JSON.stringify(transcript), now, id);
      this.history(id, now, 'worker', 'transcribed', null);
      return true;
    });
  }

  completeDraft(id: string, token: string, draft: MinutesDraft, body: string, now: string): boolean {
    return this.tx(() => {
      if (!this.held(id, 'summarize', token)) return false;
      this.db
        .prepare("UPDATE meetings SET stage='draft', draft_json=?, body=?, version=version+1, attempts=0, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?")
        .run(JSON.stringify(draft), body, now, id);
      this.history(id, now, 'worker', 'drafted', null);
      return true;
    });
  }

  fail(id: string, token: string, stage: WorkerStage, message: string, now: string): boolean {
    return this.tx(() => {
      if (!this.held(id, stage, token)) return false;
      this.db.prepare("UPDATE meetings SET stage='failed', failed_stage=?, error=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?").run(stage, message, now, id);
      this.history(id, now, 'worker', `failed:${stage}`, null);
      return true;
    });
  }

  /** A failed meeting goes back to the stage that failed (the transcript is kept when only the summary failed). */
  retry(id: string, actor: string, now: string): MeetingRow | null | 'not-failed' | 'no-audio' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'failed') return 'not-failed';
      const back = r.failedStage === 'summarize' && r.transcript ? 'summarize_wait' : 'transcribe_wait';
      if (back === 'transcribe_wait' && r.audioDeletedAt) return 'no-audio';
      this.db.prepare('UPDATE meetings SET stage=?, failed_stage=NULL, error=NULL, attempts=0, updated_by=?, updated_at=? WHERE id=?').run(back, actor, now, id);
      this.history(id, now, actor, 'retry', null);
      return this.get(id)!;
    });
  }

  /**
   * The title, the date and who may read the meeting, at any stage (2026-11-05). The version is left as it is: it
   * guards the body, and a reader's unsaved corrections must not be refused because the settings changed.
   */
  updateSettings(id: string, settings: MeetingSettings, actor: string, now: string): MeetingRow | null {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      const before: MeetingSettings = { title: r.title, heldOn: r.heldOn, visibility: r.visibility, viewers: r.viewers };
      this.db
        .prepare('UPDATE meetings SET title=?, held_on=?, visibility=?, viewers_json=?, updated_by=?, updated_at=? WHERE id=?')
        .run(settings.title, settings.heldOn, settings.visibility, JSON.stringify(settings.viewers), actor, now, id);
      this.history(id, now, actor, 'settings', JSON.stringify(before));
      return this.get(id)!;
    });
  }

  updateBody(id: string, expectedVersion: number, body: string, actor: string, now: string): MeetingRow | null | 'conflict' | 'locked' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'draft') return 'locked';
      if (r.version !== expectedVersion) return 'conflict';
      this.db.prepare('UPDATE meetings SET body=?, version=version+1, updated_by=?, updated_at=? WHERE id=?').run(body, actor, now, id);
      this.history(id, now, actor, 'edit', r.body);
      return this.get(id)!;
    });
  }

  confirm(id: string, expectedVersion: number, actor: string, now: string): MeetingRow | null | 'conflict' | 'locked' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'draft') return 'locked';
      if (r.version !== expectedVersion) return 'conflict';
      this.db.prepare("UPDATE meetings SET stage='confirmed', version=version+1, confirmed_by=?, confirmed_at=?, updated_by=?, updated_at=? WHERE id=?").run(actor, now, actor, now, id);
      this.history(id, now, actor, 'confirm', null);
      return this.get(id)!;
    });
  }

  /** Removes the meeting (the routes remove its audio file). The history keeps that it was deleted. */
  delete(id: string, actor: string, now: string): MeetingRow | null {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      this.db.prepare('DELETE FROM meetings WHERE id=?').run(id);
      // Deleted means gone: the earlier bodies kept for undoing edits go too; the history keeps only who did what.
      this.db.prepare('UPDATE meeting_history SET before_body=NULL WHERE meeting_id=?').run(id);
      this.history(id, now, actor, 'delete', null);
      return r;
    });
  }

  markAudioDeleted(id: string, now: string): void {
    this.db.prepare('UPDATE meetings SET audio_deleted_at=? WHERE id=? AND audio_deleted_at IS NULL').run(now, id);
  }

  /** Confirmed meetings whose audio is still kept and was confirmed before `cutoff`. */
  audioDue(cutoff: string): MeetingRow[] {
    return (this.db.prepare("SELECT * FROM meetings WHERE stage='confirmed' AND audio_deleted_at IS NULL AND confirmed_at <= ?").all(cutoff) as unknown as RawRow[]).map(fromRaw);
  }
}
