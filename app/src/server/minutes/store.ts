import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MinutesAudioExtension, MinutesDraft, MinutesStage, MinutesVisibility, Transcript, TranscriptSegment } from '../../shared/minutes.js';

// Meeting minutes (α, 2026-11-02): one SQLite file (minutes.sqlite3) in the mail folder, so the app's backup
// carries it; the recordings are separate files in minutes-audio/ and are not backed up (they are deleted a
// fixed number of days after the first confirmation). A meeting moves through the stages of shared/minutes.ts; the
// worker takes a waiting stage with a lease, and a lease that runs out puts the stage back (at most MAX_ATTEMPTS
// times; since 2026-11-07 a report of progress pushes the lease out, so only a worker that stopped loses it). Every change of the minutes keeps a history row with the body as it was before; a change of the settings
// (title, date, who may read it) keeps the settings as they were before, as JSON in the same column; a corrected
// segment of the transcript keeps its index and text before, the same way.
//
// 2026-11-06: a draft can be sent back to the AI with a comment (meeting_reviews: the meeting goes back to
// summarize_wait, and the worker reworks the draft), and confirmed minutes can be corrected (meeting_versions keeps
// every confirmed version; a correction is the stage "draft" again while the last version still stands). The stages
// are the same as before and the columns were only added, so the app of before still opens the file.
//
// 2026-11-10: the AI guesses what was said in the segments to listen to again (meeting_suggestions). The guessing runs
// beside the draft, not as a stage of the meeting, so people keep working on the draft meanwhile; it is only a table
// added, and an app of before ignores it.

export const MINUTES_FILE = 'minutes.sqlite3';
export const AUDIO_DIR = 'minutes-audio';
/** Kept at 1: the changes of 2026-11-06 only add columns and tables (an older app must still open the file). */
const SCHEMA_VERSION = '1';
export const MAX_ATTEMPTS = 3;
/** How long the worker may hold a stage before it is offered again. */
export const LEASE_MS = { transcribe: 8 * 3_600_000, summarize: 45 * 60_000, suggest: 30 * 60_000 } as const;
/**
 * How far each report of progress pushes the lease out (2026-11-07). The worker reports about every 20 seconds while
 * it works, so a stage that takes longer than LEASE_MS on a slow machine is kept; a worker that stops reporting loses
 * the stage this long after its last report (or LEASE_MS after it took it, whichever is later).
 */
export const LEASE_RENEW_MS = { transcribe: 2 * 3_600_000, summarize: 45 * 60_000, suggest: 30 * 60_000 } as const;
export type WorkerStage = keyof typeof LEASE_MS;
/** The stages a meeting itself goes through; the AI's guesses (`suggest`) run beside the draft, in their own table. */
export type MeetingWorkStage = Exclude<WorkerStage, 'suggest'>;
/** Segments the AI guesses for in one lease (2026-11-10): one call of the AI, so a summary waiting meanwhile is not held up long. */
export const SUGGEST_PART = 120;

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
CREATE TABLE IF NOT EXISTS meeting_reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  comment TEXT NOT NULL,
  status TEXT NOT NULL,
  reply TEXT,
  error TEXT,
  done_at TEXT,
  before_body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meeting_reviews_meeting ON meeting_reviews(meeting_id, id);
CREATE TABLE IF NOT EXISTS meeting_versions(
  meeting_id TEXT NOT NULL,
  no INTEGER NOT NULL,
  body TEXT NOT NULL,
  draft_json TEXT,
  draft_round INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY(meeting_id, no)
);
CREATE TABLE IF NOT EXISTS meeting_suggestions(
  meeting_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  part_end INTEGER,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  done_at TEXT,
  error TEXT,
  targets_json TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '{}'
);
`;

/** Columns added on 2026-11-06 (ALTER TABLE on a file made before). */
const ADDED_COLUMNS: [string, string][] = [
  // The first confirmation: the audio is deleted a fixed number of days after it, however often it is corrected.
  ['first_confirmed_at', 'TEXT'],
  // How many times the AI reworked the draft: the decision items of each round are told apart by it.
  ['draft_round', 'INTEGER NOT NULL DEFAULT 0'],
  // The body as the AI last wrote it (to tell whether people changed it since).
  ['ai_body', 'TEXT'],
];

/** A segment as kept: who checked it is kept by ID (the routes show the name). */
export type StoredSegment = Omit<TranscriptSegment, 'checked' | 'suggestion'> & { checked?: { original: string; by: string; at: string; ai?: true } };

/** The AI's guess for a segment, with the text it was made for (a guess for a text changed since is not shown). */
export interface SuggestionItem {
  heard: string;
  text: string;
}

export type SuggestionStatus = 'wait' | 'run' | 'done' | 'failed';

/**
 * The AI's guesses for one meeting (2026-11-10): the segments to guess for, fixed when asked (`targets`), are taken a
 * part at a time (`done` of them so far); each part has its own lease, and its guesses are kept as soon as they come.
 */
export interface SuggestionRow {
  meetingId: string;
  status: SuggestionStatus;
  attempts: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  /** The end (in `targets`) of the part being guessed while the lease holds. */
  partEnd: number | null;
  requestedBy: string;
  requestedAt: string;
  doneAt: string | null;
  error: string | null;
  targets: number[];
  done: number;
  items: Record<number, SuggestionItem>;
}

interface RawSuggestion {
  meeting_id: string;
  status: string;
  attempts: number;
  lease_token: string | null;
  lease_until: number | null;
  part_end: number | null;
  requested_by: string;
  requested_at: string;
  done_at: string | null;
  error: string | null;
  targets_json: string;
  done: number;
  items_json: string;
}

const suggestionFromRaw = (r: RawSuggestion): SuggestionRow => ({
  meetingId: r.meeting_id,
  status: r.status as SuggestionStatus,
  attempts: Number(r.attempts),
  leaseToken: r.lease_token,
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  partEnd: r.part_end === null ? null : Number(r.part_end),
  requestedBy: r.requested_by,
  requestedAt: r.requested_at,
  doneAt: r.done_at,
  error: r.error,
  targets: JSON.parse(r.targets_json) as number[],
  done: Number(r.done),
  items: JSON.parse(r.items_json) as Record<number, SuggestionItem>,
});

/** A part of the AI's guesses given to the worker. */
export interface ClaimedSuggestion {
  row: MeetingRow;
  leaseToken: string;
  /** The segments of this part (still unchecked when it was given). */
  targets: number[];
  /** Segments guessed for before this part, and all of them. */
  done: number;
  total: number;
}
export interface StoredTranscript extends Omit<Transcript, 'segments'> {
  segments: StoredSegment[];
}

export type ReviewStatus = 'pending' | 'done' | 'failed';

export interface ReviewRow {
  id: number;
  meetingId: string;
  at: string;
  actorId: string;
  comment: string;
  status: ReviewStatus;
  reply: string | null;
  error: string | null;
  doneAt: string | null;
  beforeBody: string;
}

export interface VersionRow {
  meetingId: string;
  no: number;
  body: string;
  draft: MinutesDraft | null;
  draftRound: number;
  confirmedBy: string;
  confirmedAt: string;
  note: string;
}

export interface MeetingRow {
  id: string;
  title: string;
  heldOn: string;
  visibility: MinutesVisibility;
  viewers: string[];
  stage: MinutesStage;
  failedStage: MeetingWorkStage | null;
  error: string | null;
  attempts: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  audioExt: MinutesAudioExtension;
  audioBytes: number;
  audioSha256: string;
  audioDeletedAt: string | null;
  transcript: StoredTranscript | null;
  draft: MinutesDraft | null;
  body: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  firstConfirmedAt: string | null;
  draftRound: number;
  aiBody: string | null;
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
  first_confirmed_at: string | null;
  draft_round: number;
  ai_body: string | null;
}

const fromRaw = (r: RawRow): MeetingRow => ({
  id: r.id,
  title: r.title,
  heldOn: r.held_on,
  visibility: r.visibility as MinutesVisibility,
  viewers: JSON.parse(r.viewers_json) as string[],
  stage: r.stage as MinutesStage,
  failedStage: (r.failed_stage as MeetingWorkStage | null) ?? null,
  error: r.error,
  attempts: Number(r.attempts),
  leaseToken: r.lease_token,
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  audioExt: r.audio_ext as MinutesAudioExtension,
  audioBytes: Number(r.audio_bytes),
  audioSha256: r.audio_sha256,
  audioDeletedAt: r.audio_deleted_at,
  transcript: r.transcript_json ? (JSON.parse(r.transcript_json) as StoredTranscript) : null,
  draft: r.draft_json ? (JSON.parse(r.draft_json) as MinutesDraft) : null,
  body: r.body,
  version: Number(r.version),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
  firstConfirmedAt: r.first_confirmed_at,
  draftRound: Number(r.draft_round ?? 0),
  aiBody: r.ai_body ?? null,
});

interface RawReview {
  id: number;
  meeting_id: string;
  at: string;
  actor_id: string;
  comment: string;
  status: string;
  reply: string | null;
  error: string | null;
  done_at: string | null;
  before_body: string;
}

const reviewFromRaw = (r: RawReview): ReviewRow => ({
  id: Number(r.id),
  meetingId: r.meeting_id,
  at: r.at,
  actorId: r.actor_id,
  comment: r.comment,
  status: r.status as ReviewStatus,
  reply: r.reply,
  error: r.error,
  doneAt: r.done_at,
  beforeBody: r.before_body,
});

interface RawVersion {
  meeting_id: string;
  no: number;
  body: string;
  draft_json: string | null;
  draft_round: number;
  confirmed_by: string;
  confirmed_at: string;
  note: string;
}

const versionFromRaw = (r: RawVersion): VersionRow => ({
  meetingId: r.meeting_id,
  no: Number(r.no),
  body: r.body,
  draft: r.draft_json ? (JSON.parse(r.draft_json) as MinutesDraft) : null,
  draftRound: Number(r.draft_round),
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
  note: r.note,
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
  stage: MeetingWorkStage;
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
      this.tx(() => this.migrate());
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Brings a file made before 2026-11-06 (or touched by an older app since) up to date: the added columns, the first
   * confirmation, and a version for every confirmation that has none yet (version 1 of the meetings confirmed before;
   * a confirmation an older app made after a correction began becomes the next version).
   */
  private migrate(): void {
    const have = new Set((this.db.prepare('PRAGMA table_info(meetings)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of ADDED_COLUMNS) if (!have.has(name)) this.db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${type}`);
    this.db.exec('UPDATE meetings SET first_confirmed_at=confirmed_at WHERE first_confirmed_at IS NULL AND confirmed_at IS NOT NULL');
    this.db.exec(`INSERT INTO meeting_versions(meeting_id,no,body,draft_json,draft_round,confirmed_by,confirmed_at,note)
      SELECT m.id, COALESCE((SELECT MAX(v.no) FROM meeting_versions v WHERE v.meeting_id=m.id), 0) + 1, m.body, m.draft_json, m.draft_round, m.confirmed_by, m.confirmed_at, ''
      FROM meetings m
      WHERE m.stage='confirmed' AND m.confirmed_by IS NOT NULL AND m.confirmed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM meeting_versions v WHERE v.meeting_id=m.id AND v.confirmed_at=m.confirmed_at)`);
    // A comment still pending on a meeting that is not being reworked (an older app ran in between and wrote a new
    // draft without it): it did not come off.
    this.db.exec(`UPDATE meeting_reviews SET status='failed', error='アプリの版が入れ替わる間に処理されたため、コメントに沿った手直しになっていません。', done_at=at
      WHERE status='pending' AND meeting_id NOT IN (SELECT id FROM meetings WHERE stage IN ('summarize_wait','summarize_run'))`);
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
   * after MAX_ATTEMPTS the meeting fails, or a reworking of a draft goes back to the draft). Only the stages the
   * worker asked for.
   */
  claim(stages: MeetingWorkStage[], nowMs: number, now: string): ClaimedJob | null {
    return this.tx(() => {
      // Stages held too long, of the kinds this worker does: back to waiting, or failed after the last attempt. (A
      // worker that only summarizes never takes a long transcription away from the one that transcribes.)
      const running = stages.map((s) => `'${s}_run'`).join(',');
      if (!running) return null;
      const expired = this.db.prepare(`SELECT * FROM meetings WHERE stage IN (${running}) AND lease_until < ?`).all(nowMs) as unknown as RawRow[];
      for (const r of expired) {
        const stage: MeetingWorkStage = r.stage === 'transcribe_run' ? 'transcribe' : 'summarize';
        if (Number(r.attempts) >= MAX_ATTEMPTS) {
          const message = `処理が ${MAX_ATTEMPTS} 回とも時間内に終わりませんでした。`;
          if (stage === 'summarize' && this.abandonReview(r, message, now)) continue;
          this.db
            .prepare("UPDATE meetings SET stage='failed', failed_stage=?, error=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?")
            .run(stage, message, now, r.id);
        } else {
          this.db.prepare('UPDATE meetings SET stage=?, lease_token=NULL, lease_until=NULL WHERE id=?').run(`${stage}_wait`, r.id);
        }
      }
      const waiting = stages.map((s) => `'${s}_wait'`).join(',');
      if (!waiting) return null;
      const r = this.db.prepare(`SELECT * FROM meetings WHERE stage IN (${waiting}) ORDER BY created_at, id LIMIT 1`).get() as RawRow | undefined;
      if (!r) return null;
      const stage: MeetingWorkStage = r.stage === 'transcribe_wait' ? 'transcribe' : 'summarize';
      const token = randomBytes(18).toString('base64url');
      this.db
        .prepare('UPDATE meetings SET stage=?, lease_token=?, lease_until=?, attempts=attempts+1, error=NULL, failed_stage=NULL WHERE id=?')
        .run(`${stage}_run`, token, nowMs + LEASE_MS[stage], r.id);
      return { row: this.get(r.id)!, stage, leaseToken: token };
    });
  }

  /** Pushes the lease out to `untilMs` (never pulls it in) while the worker holds the stage with this lease. */
  renewLease(id: string, stage: MeetingWorkStage, token: string, untilMs: number): boolean {
    const r = this.db.prepare('UPDATE meetings SET lease_until=MAX(lease_until, ?) WHERE id=? AND stage=? AND lease_token=?').run(untilMs, id, `${stage}_run`, token);
    return Number(r.changes) > 0;
  }

  /** The row while the worker still holds this stage with this lease, else null (a late or repeated answer). */
  private held(id: string, stage: MeetingWorkStage, token: string): RawRow | null {
    const r = this.db.prepare('SELECT * FROM meetings WHERE id=?').get(id) as RawRow | undefined;
    if (!r || r.stage !== `${stage}_run` || r.lease_token !== token) return null;
    return r;
  }

  /**
   * A reworking that did not come off: the meeting goes back to its draft as it was (the draft before the comment),
   * and the comment is marked failed with the reason. False when the meeting was not being reworked.
   */
  private abandonReview(r: RawRow, message: string, now: string): boolean {
    const pending = this.pendingReview(r.id);
    if (!pending || !r.draft_json) return false;
    this.db.prepare("UPDATE meetings SET stage='draft', attempts=0, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?").run(now, r.id);
    this.db.prepare("UPDATE meeting_reviews SET status='failed', error=?, done_at=? WHERE id=?").run(message.slice(0, 500), now, pending.id);
    this.history(r.id, now, 'worker', 'review-failed', null);
    return true;
  }

  completeTranscript(id: string, token: string, transcript: StoredTranscript, now: string): boolean {
    return this.tx(() => {
      if (!this.held(id, 'transcribe', token)) return false;
      this.db
        .prepare("UPDATE meetings SET stage='summarize_wait', transcript_json=?, attempts=0, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?")
        .run(JSON.stringify(transcript), now, id);
      // Guesses made for a transcript that is no longer there.
      this.db.prepare('DELETE FROM meeting_suggestions WHERE meeting_id=?').run(id);
      this.history(id, now, 'worker', 'transcribed', null);
      return true;
    });
  }

  /** The first draft; `suggestTargets` (the segments to listen to again) are queued for the AI's guesses at once. */
  completeDraft(id: string, token: string, draft: MinutesDraft, body: string, now: string, suggestTargets: number[] = []): boolean {
    return this.tx(() => {
      if (!this.held(id, 'summarize', token)) return false;
      if (suggestTargets.length > 0) this.queueSuggestions(id, suggestTargets, 'worker', now);
      this.db
        .prepare("UPDATE meetings SET stage='draft', draft_json=?, body=?, ai_body=?, version=version+1, attempts=0, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?")
        .run(JSON.stringify(draft), body, body, now, id);
      this.history(id, now, 'worker', 'drafted', null);
      return true;
    });
  }

  /**
   * The draft reworked after the comment `reviewId`: it replaces the draft and the body (the body before is kept with
   * the comment), and starts a new round of decision items.
   */
  completeRevision(id: string, token: string, reviewId: number, draft: MinutesDraft, body: string, reply: string, now: string): boolean {
    return this.tx(() => {
      if (!this.held(id, 'summarize', token)) return false;
      if (this.pendingReview(id)?.id !== reviewId) return false;
      this.db
        .prepare(
          "UPDATE meetings SET stage='draft', draft_json=?, body=?, ai_body=?, draft_round=draft_round+1, version=version+1, attempts=0, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(draft), body, body, now, id);
      this.db.prepare("UPDATE meeting_reviews SET status='done', reply=?, done_at=? WHERE id=?").run(reply, now, reviewId);
      this.history(id, now, 'worker', 'revised', null);
      return true;
    });
  }

  fail(id: string, token: string, stage: MeetingWorkStage, message: string, now: string): boolean {
    return this.tx(() => {
      const r = this.held(id, stage, token);
      if (!r) return false;
      if (stage === 'summarize' && this.abandonReview(r, message, now)) return true;
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

  /**
   * A segment of the transcript corrected after listening again (or confirmed as it was), while the minutes are a
   * draft. The text the person saw must still be the text: a correction made meanwhile by someone else is not
   * overwritten. The version is left as it is (it guards the body).
   */
  checkSegment(id: string, index: number, expectedText: string, text: string, actor: string, now: string): MeetingRow | null | 'locked' | 'conflict' | 'no-segment' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'draft') return 'locked';
      const segment = r.transcript?.segments[index];
      if (!r.transcript || !segment) return 'no-segment';
      if (segment.text !== expectedText) return 'conflict';
      const segments = r.transcript.segments.slice();
      const original = segment.checked?.original ?? segment.text;
      // Confirmed as the AI guessed it (and not as it was heard): kept apart from a correction a person typed.
      const guess = this.suggestion(id)?.items[index];
      const ai = !!guess && guess.heard === segment.text && guess.text === text && text !== original;
      segments[index] = { ...segment, text, checked: { original, by: actor, at: now, ...(ai ? { ai: true as const } : {}) } };
      this.db.prepare('UPDATE meetings SET transcript_json=?, updated_by=?, updated_at=? WHERE id=?').run(JSON.stringify({ ...r.transcript, segments }), actor, now, id);
      this.history(id, now, actor, 'segment', JSON.stringify({ index, text: segment.text }));
      return this.get(id)!;
    });
  }

  /** The draft sent back to the AI with a comment: the meeting waits for the worker to rework it. */
  sendBack(id: string, expectedVersion: number, comment: string, limit: number, actor: string, now: string): MeetingRow | null | 'locked' | 'conflict' | 'no-draft' | 'limit' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'draft') return 'locked';
      if (r.version !== expectedVersion) return 'conflict';
      if (!r.transcript || !r.draft) return 'no-draft';
      const used = this.db.prepare("SELECT COUNT(*) AS n FROM meeting_reviews WHERE meeting_id=? AND status IN ('pending','done')").get(id) as { n: number };
      if (Number(used.n) >= limit) return 'limit';
      this.db.prepare("INSERT INTO meeting_reviews(meeting_id,at,actor_id,comment,status,before_body) VALUES(?,?,?,?,'pending',?)").run(id, now, actor, comment, r.body);
      this.db
        .prepare("UPDATE meetings SET stage='summarize_wait', attempts=0, error=NULL, failed_stage=NULL, version=version+1, updated_by=?, updated_at=? WHERE id=?")
        .run(actor, now, id);
      this.history(id, now, actor, 'review', null);
      return this.get(id)!;
    });
  }

  pendingReview(id: string): ReviewRow | null {
    const r = this.db.prepare("SELECT * FROM meeting_reviews WHERE meeting_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(id) as RawReview | undefined;
    return r ? reviewFromRaw(r) : null;
  }

  reviews(id: string): ReviewRow[] {
    return (this.db.prepare('SELECT * FROM meeting_reviews WHERE meeting_id=? ORDER BY id').all(id) as unknown as RawReview[]).map(reviewFromRaw);
  }

  versions(id: string): VersionRow[] {
    return (this.db.prepare('SELECT * FROM meeting_versions WHERE meeting_id=? ORDER BY no').all(id) as unknown as RawVersion[]).map(versionFromRaw);
  }

  /** IDs of the meetings the AI is reworking, and of those confirmed at least once (for the list). */
  flags(): { revising: Set<string>; versioned: Set<string> } {
    const ids = (sql: string) => new Set((this.db.prepare(sql).all() as { meeting_id: string }[]).map((r) => r.meeting_id));
    return {
      revising: ids("SELECT DISTINCT meeting_id FROM meeting_reviews WHERE status='pending'"),
      versioned: ids('SELECT DISTINCT meeting_id FROM meeting_versions'),
    };
  }

  /**
   * Confirms the draft as the next version. A correction of confirmed minutes needs a note of what it changed; the
   * first confirmation does not.
   */
  confirm(id: string, expectedVersion: number, note: string, actor: string, now: string): MeetingRow | null | 'conflict' | 'locked' | 'note' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'draft') return 'locked';
      if (r.version !== expectedVersion) return 'conflict';
      const last = this.db.prepare('SELECT MAX(no) AS n FROM meeting_versions WHERE meeting_id=?').get(id) as { n: number | null };
      const no = Number(last.n ?? 0) + 1;
      if (no > 1 && !note) return 'note';
      this.db
        .prepare(
          "UPDATE meetings SET stage='confirmed', version=version+1, confirmed_by=?, confirmed_at=?, first_confirmed_at=COALESCE(first_confirmed_at, ?), updated_by=?, updated_at=? WHERE id=?",
        )
        .run(actor, now, now, actor, now, id);
      this.db
        .prepare('INSERT INTO meeting_versions(meeting_id,no,body,draft_json,draft_round,confirmed_by,confirmed_at,note) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, no, r.body, r.draft ? JSON.stringify(r.draft) : null, r.draftRound, actor, now, no > 1 ? note : '');
      this.history(id, now, actor, 'confirm', null);
      return this.get(id)!;
    });
  }

  /** Starts a correction of confirmed minutes: a draft again, while the last confirmed version still stands. */
  reopen(id: string, expectedVersion: number, actor: string, now: string): MeetingRow | null | 'conflict' | 'locked' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'confirmed') return 'locked';
      if (r.version !== expectedVersion) return 'conflict';
      this.db.prepare("UPDATE meetings SET stage='draft', version=version+1, updated_by=?, updated_at=? WHERE id=?").run(actor, now, id);
      this.history(id, now, actor, 'reopen', null);
      return this.get(id)!;
    });
  }

  /**
   * Drops a correction: the minutes and the AI's items go back to the last confirmed version (the body dropped is kept
   * in the history; the corrections of the transcript stay, as they are corrections of what was said).
   */
  discard(id: string, expectedVersion: number, actor: string, now: string): MeetingRow | null | 'conflict' | 'locked' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      const last = this.db.prepare('SELECT * FROM meeting_versions WHERE meeting_id=? ORDER BY no DESC LIMIT 1').get(id) as RawVersion | undefined;
      if (r.stage !== 'draft' || !last) return 'locked';
      if (r.version !== expectedVersion) return 'conflict';
      this.db
        .prepare(
          "UPDATE meetings SET stage='confirmed', body=?, draft_json=?, draft_round=?, confirmed_by=?, confirmed_at=?, version=version+1, updated_by=?, updated_at=? WHERE id=?",
        )
        .run(last.body, last.draft_json, last.draft_round, last.confirmed_by, last.confirmed_at, actor, now, id);
      this.history(id, now, actor, 'discard', r.body);
      return this.get(id)!;
    });
  }

  /** Removes the meeting (the routes remove its audio file). The history keeps that it was deleted. */
  delete(id: string, actor: string, now: string): MeetingRow | null {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      this.db.prepare('DELETE FROM meetings WHERE id=?').run(id);
      // Deleted means gone: the earlier bodies kept for undoing edits go too, with the comments and the confirmed
      // versions; the history keeps only who did what.
      this.db.prepare('UPDATE meeting_history SET before_body=NULL WHERE meeting_id=?').run(id);
      this.db.prepare('DELETE FROM meeting_reviews WHERE meeting_id=?').run(id);
      this.db.prepare('DELETE FROM meeting_versions WHERE meeting_id=?').run(id);
      this.db.prepare('DELETE FROM meeting_suggestions WHERE meeting_id=?').run(id);
      this.history(id, now, actor, 'delete', null);
      return r;
    });
  }

  // ---- the AI's guesses for the segments to listen to again (2026-11-10)

  suggestion(id: string): SuggestionRow | null {
    const r = this.db.prepare('SELECT * FROM meeting_suggestions WHERE meeting_id=?').get(id) as RawSuggestion | undefined;
    return r ? suggestionFromRaw(r) : null;
  }

  /**
   * Queues the guesses for `targets` (asked again: from the start, the guesses made before stay until a new one
   * replaces them). Inside a transaction of the caller.
   */
  private queueSuggestions(id: string, targets: number[], actor: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO meeting_suggestions(meeting_id,status,attempts,lease_token,lease_until,part_end,requested_by,requested_at,done_at,error,targets_json,done,items_json)
         VALUES(?,'wait',0,NULL,NULL,NULL,?,?,NULL,NULL,?,0,'{}')
         ON CONFLICT(meeting_id) DO UPDATE SET status='wait', attempts=0, lease_token=NULL, lease_until=NULL, part_end=NULL, requested_by=excluded.requested_by,
           requested_at=excluded.requested_at, done_at=NULL, error=NULL, targets_json=excluded.targets_json, done=0`,
      )
      .run(id, actor, now, JSON.stringify(targets));
  }

  /**
   * A person asks for the guesses while the minutes are a draft. After a failure the guessing goes on from where it
   * stopped; otherwise it starts again over `targets` (the segments still to be checked now).
   */
  requestSuggestions(id: string, targets: number[], actor: string, now: string): MeetingRow | null | 'locked' | 'busy' | 'none' {
    return this.tx(() => {
      const r = this.get(id);
      if (!r) return null;
      if (r.stage !== 'draft' || !r.transcript) return 'locked';
      const s = this.suggestion(id);
      if (s && (s.status === 'wait' || s.status === 'run')) return 'busy';
      if (s && s.status === 'failed' && s.done < s.targets.length) {
        this.db.prepare("UPDATE meeting_suggestions SET status='wait', attempts=0, error=NULL, requested_by=?, requested_at=? WHERE meeting_id=?").run(actor, now, id);
      } else {
        if (targets.length === 0) return 'none';
        this.queueSuggestions(id, targets, actor, now);
      }
      this.history(id, now, actor, 'suggest', null);
      return this.get(id)!;
    });
  }

  /**
   * Gives the worker the next part of the oldest waiting guesses of a meeting that is a draft (a part held too long
   * goes back to waiting, or fails after MAX_ATTEMPTS). Segments checked since they were queued are skipped.
   */
  claimSuggestion(nowMs: number, now: string, part = SUGGEST_PART): ClaimedSuggestion | null {
    return this.tx(() => {
      const expired = this.db.prepare("SELECT * FROM meeting_suggestions WHERE status='run' AND lease_until < ?").all(nowMs) as unknown as RawSuggestion[];
      for (const r of expired) {
        if (Number(r.attempts) >= MAX_ATTEMPTS) {
          this.db
            .prepare("UPDATE meeting_suggestions SET status='failed', error=?, lease_token=NULL, lease_until=NULL, part_end=NULL WHERE meeting_id=?")
            .run(`AI の案づくりが ${MAX_ATTEMPTS} 回とも時間内に終わりませんでした。`, r.meeting_id);
        } else {
          this.db.prepare("UPDATE meeting_suggestions SET status='wait', lease_token=NULL, lease_until=NULL, part_end=NULL WHERE meeting_id=?").run(r.meeting_id);
        }
      }
      const waiting = this.db
        .prepare("SELECT s.* FROM meeting_suggestions s JOIN meetings m ON m.id=s.meeting_id WHERE s.status='wait' AND m.stage='draft' ORDER BY s.requested_at, s.meeting_id")
        .all() as unknown as RawSuggestion[];
      for (const raw of waiting) {
        const s = suggestionFromRaw(raw);
        const row = this.get(s.meetingId)!;
        const segments = row.transcript?.segments ?? [];
        let start = s.done;
        let end = start;
        let targets: number[] = [];
        // Parts whose segments were all checked meanwhile are passed over.
        while (start < s.targets.length && targets.length === 0) {
          end = Math.min(s.targets.length, start + part);
          targets = s.targets.slice(start, end).filter((i) => segments[i] && !segments[i]!.checked && segments[i]!.text.trim());
          if (targets.length === 0) start = end;
        }
        if (targets.length === 0) {
          this.db.prepare("UPDATE meeting_suggestions SET status='done', done=?, done_at=?, attempts=0 WHERE meeting_id=?").run(s.targets.length, now, s.meetingId);
          continue;
        }
        const token = randomBytes(18).toString('base64url');
        this.db
          .prepare("UPDATE meeting_suggestions SET status='run', lease_token=?, lease_until=?, part_end=?, done=?, attempts=attempts+1, error=NULL WHERE meeting_id=?")
          .run(token, nowMs + LEASE_MS.suggest, end, start, s.meetingId);
        return { row, leaseToken: token, targets, done: start, total: s.targets.length };
      }
      return null;
    });
  }

  /** The guesses of the meeting while the worker holds a part of them with this lease, else null. */
  private heldSuggestion(id: string, token: string): SuggestionRow | null {
    const s = this.suggestion(id);
    return s && s.status === 'run' && s.leaseToken === token ? s : null;
  }

  holdsSuggestion(id: string, token: string): boolean {
    return this.heldSuggestion(id, token) !== null;
  }

  renewSuggestionLease(id: string, token: string, untilMs: number): boolean {
    const r = this.db.prepare("UPDATE meeting_suggestions SET lease_until=MAX(lease_until, ?) WHERE meeting_id=? AND status='run' AND lease_token=?").run(untilMs, id, token);
    return Number(r.changes) > 0;
  }

  /**
   * The guesses of a part: kept for the segments that still read as the worker was given them and are not checked
   * (a person who corrected one meanwhile is not overruled). The guessing goes on with the next part, or is done.
   */
  completeSuggestions(id: string, token: string, guesses: { index: number; heard: string; text: string }[], now: string): boolean {
    return this.tx(() => {
      const s = this.heldSuggestion(id, token);
      if (!s) return false;
      const segments = this.get(id)?.transcript?.segments ?? [];
      const items = { ...s.items };
      for (const g of guesses) {
        const segment = segments[g.index];
        if (segment && !segment.checked && segment.text === g.heard && g.text) items[g.index] = { heard: g.heard, text: g.text };
      }
      const done = Math.min(s.targets.length, s.partEnd ?? s.done);
      const finished = done >= s.targets.length;
      this.db
        .prepare('UPDATE meeting_suggestions SET status=?, done=?, done_at=?, attempts=0, lease_token=NULL, lease_until=NULL, part_end=NULL, items_json=? WHERE meeting_id=?')
        .run(finished ? 'done' : 'wait', done, finished ? now : null, JSON.stringify(items), id);
      return true;
    });
  }

  /**
   * A part the worker could not guess for (the AI failed, or answered out of form): tried again with the next claim,
   * and the guessing stops only after MAX_ATTEMPTS failures of the same part (a person may ask again from there).
   */
  failSuggestions(id: string, token: string, message: string, now: string): boolean {
    return this.tx(() => {
      const s = this.heldSuggestion(id, token);
      if (!s) return false;
      const stop = s.attempts >= MAX_ATTEMPTS;
      this.db
        .prepare('UPDATE meeting_suggestions SET status=?, error=?, lease_token=NULL, lease_until=NULL, part_end=NULL WHERE meeting_id=?')
        .run(stop ? 'failed' : 'wait', message, id);
      if (stop) this.history(id, now, 'worker', 'suggest-failed', null);
      return true;
    });
  }

  markAudioDeleted(id: string, now: string): void {
    this.db.prepare('UPDATE meetings SET audio_deleted_at=? WHERE id=? AND audio_deleted_at IS NULL').run(now, id);
  }

  /**
   * Meetings whose audio is still kept and that were first confirmed before `cutoff` (a correction after the
   * confirmation does not keep the audio longer).
   */
  audioDue(cutoff: string): MeetingRow[] {
    return (
      this.db.prepare('SELECT * FROM meetings WHERE first_confirmed_at IS NOT NULL AND audio_deleted_at IS NULL AND first_confirmed_at <= ?').all(cutoff) as unknown as RawRow[]
    ).map(fromRaw);
  }
}
