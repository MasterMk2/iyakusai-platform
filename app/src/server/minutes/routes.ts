import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DECISION_DEPARTMENT_KEY, DECISION_LIMITS, isDecisionDate, type MinutesRegisterResponse } from '../../shared/decisions.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import {
  carryOverAttendees,
  draftToMarkdown,
  MINUTES_AUDIO_EXTENSIONS,
  MINUTES_AUDIO_TYPES,
  MINUTES_CONSENT_TEXT,
  MINUTES_LIMITS,
  MINUTES_UPLOAD_HEAD_BYTES,
  MINUTES_VISIBILITIES,
  sizeLabel,
  suggestTargets,
  unclearTimes,
  type MinutesAudioExtension,
  type MinutesDetail,
  type MinutesListResponse,
  type MinutesMeta,
  type MinutesPerson,
  type MinutesProgress,
  type MinutesReviewBodyResponse,
  type MinutesUploadsResponse,
  type MinutesVersionResponse,
  type TranscriptSegment,
} from '../../shared/minutes.js';
import { SESSION_COOKIE } from '../discord-auth/http.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { decisionInputOfMinutesItem, minutesItemToken, minutesTokenPrefix } from '../decisions/from-minutes.js';
import type { DecisionsStore } from '../decisions/store.js';
import { attachmentDisposition } from '../http/content-disposition.js';
import { HttpError } from '../http/http-error.js';
import type { MailSession } from '../mailbox/routes.js';
import type { People } from '../mailbox/service.js';
import { MAX_SKEW_MS, verifySignature } from '../tasks/signing.js';
import type { MinutesConfig } from './config.js';
import { fixedSegment, fixTranscriptText } from './fixes.js';
import { LEASE_RENEW_MS, MinutesStore, newMeetingId, type MeetingRow, type MeetingWorkStage, type StoredTranscript, type SuggestionRow, type WorkerStage } from './store.js';
import { checkedDraft, draftSchema, transcriptSchema } from './validate.js';

// Meeting minutes (α, 2026-11-02). Browser routes under /api/minutes (Discord login, committee members only, like
// the contacts), and the signed routes of the minutes worker under /v1/minutes/worker (svc-auth/v1, client
// "iyakusai-minutes-worker", its own key from minutes.json). The worker runs on the server host and polls; the
// app never calls out, and the audio is only ever handed to the worker.
//
// Who sees what (設計書 §4-7): a meeting is read by its recorder, the people chosen for it (or every member), and
// the access administrators; its audio is played only by the recorder and the access administrators (2026-11-02
// review); its title, date and readers are changed (2026-11-05), and it is deleted, by the recorder or an access
// administrator. Whoever reads it may correct the draft, send it back to the AI with a comment, correct the
// transcript, confirm it, and start a correction of the confirmed minutes (2026-11-06): every confirmed version is
// kept, so a correction never loses what was confirmed before. The AI's guesses for the segments to listen to again
// (2026-11-10) are made by the same worker after the draft, a part at a time; whoever may correct the transcript may
// ask for them again.

export const WORKER_CLIENT = 'iyakusai-minutes-worker';
export const WORKER_PATHS = {
  claim: '/v1/minutes/worker/claim',
  audio: '/v1/minutes/worker/audio',
  result: '/v1/minutes/worker/result',
  progress: '/v1/minutes/worker/progress',
} as const;
/** Meetings whose progress is kept at once (one per running stage; more only if reports outlive their leases). */
const MAX_REPORTED = 200;
/** The pace of a stage is told only after this long, so the first seconds (download, loading the model) do not skew it. */
const PACE_AFTER_MS = 30_000;
const WORKER_BODY_MAX = 16 * 1024 * 1024;
const MAX_NONCES = 1024;
const REJECTED = { error: 'rejected' };
const RETENTION_CHECK_MS = 3_600_000;
/** One piece of an upload (under the reverse proxy's 17 MB). */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOADS_PER_PERSON = 3;
/** Meetings of one person whose audio is kept and that are not confirmed yet (a bound on the disk one person fills). */
const UNCONFIRMED_PER_PERSON = 10;
/** Free disk space always left for the rest of the server (mail, the database, the backups). */
const DISK_RESERVE_BYTES = 5 * 1024 * 1024 * 1024;
/** An upload that has had no new piece this long is dropped, with its part on disk (2026-11-07: was 12 hours after it was opened). */
const UPLOAD_IDLE_MS = 24 * 3_600_000;
/** Words the speech model is told to expect, besides the members' names and departments. */
const FIXED_GLOSSARY = ['医薬祭', '実行委員会', '役員会', '富山大学', '杉谷', '五福', '高岡', '富大祭', '創己祭', '白パス', '協賛', '出展団体', '物品貸出', '基盤システム'];

export interface MinutesRouteDeps {
  requireUser: (request: FastifyRequest) => User;
  session: (request: FastifyRequest) => MailSession | null;
  people: People;
  discordUserIdOf: (userId: string) => string | null;
  clock: () => string;
  now?: () => number;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
  /** The decision register (decisions.sqlite3), or null when it is off. */
  decisions?: DecisionsStore | null;
}

const meetingParams = z.strictObject({ meetingId: z.string().regex(/^mt_[0-9a-f]{16}$/) });
const bodyUpdate = z.strictObject({ expectedVersion: z.number().int().min(1), body: z.string().max(MINUTES_LIMITS.body) });
/** The decision items chosen to register: their numbers in the draft, and the department(s) and place they get. */
const decisionsRegisterBody = z.strictObject({
  items: z.array(z.number().int().min(0).max(999)).min(1).max(50),
  departments: z.array(z.string().regex(DECISION_DEPARTMENT_KEY)).min(1).max(DECISION_LIMITS.departments),
  venue: z.enum(['board', 'regular', 'subcommittee', 'mail']),
});
const versionOnly = z.strictObject({ expectedVersion: z.number().int().min(1) });
const confirmBody = z.strictObject({ expectedVersion: z.number().int().min(1), note: z.string().max(MINUTES_LIMITS.note * 2).optional() });
const reviewBody = z.strictObject({
  expectedVersion: z.number().int().min(1),
  comment: z.string().max(MINUTES_LIMITS.comment * 2).transform((s) => s.trim()).pipe(z.string().min(1, 'コメントを書いてください。').max(MINUTES_LIMITS.comment)),
});
const segmentParams = z.strictObject({ meetingId: z.string().regex(/^mt_[0-9a-f]{16}$/), index: z.coerce.number().int().min(0).max(MINUTES_LIMITS.segments) });
const segmentBody = z.strictObject({ expectedText: z.string().max(MINUTES_LIMITS.segmentText), text: z.string().max(MINUTES_LIMITS.segmentText * 2) });
const versionParams = z.strictObject({ meetingId: z.string().regex(/^mt_[0-9a-f]{16}$/), no: z.coerce.number().int().min(1).max(100_000) });
const reviewParams = z.strictObject({ meetingId: z.string().regex(/^mt_[0-9a-f]{16}$/), reviewId: z.coerce.number().int().min(1) });
const exportQuery = z.strictObject({ version: z.coerce.number().int().min(1).max(100_000).optional() });
const deleteQuery = z.strictObject({ expectedVersion: z.coerce.number().int().min(1) });
/** One line of plain text: control characters and runs of spaces become one space. */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();

const uploadParams = z.strictObject({ uploadId: z.string().regex(/^mt_[0-9a-f]{16}$/) });
const uploadOpen = z.strictObject({ filename: z.string().max(255), type: z.string().max(100), bytes: z.number().int().min(1) });
const chunkQuery = z.strictObject({ offset: z.coerce.number().int().min(0) });
const resumeBody = z.strictObject({ bytes: z.number().int().min(1), headBytes: z.number().int().min(0).max(MINUTES_UPLOAD_HEAD_BYTES), headSha256: z.string().regex(/^[0-9a-f]{64}$/) });
/** The note kept beside the part of an upload on disk, so a restart of the app does not lose it (2026-11-07). */
const storedUpload = z.strictObject({
  id: z.string().regex(/^mt_[0-9a-f]{16}$/),
  userId: z.string().min(1).max(200),
  ext: z.enum(MINUTES_AUDIO_EXTENSIONS),
  bytes: z.number().int().min(1).max(MINUTES_LIMITS.audioBytes),
  name: z.string().max(255),
  openedAt: z.number().int().min(0),
  touchedAt: z.number().int().min(0),
});
const settingsFields = {
  title: z.string().max(MINUTES_LIMITS.title * 2).transform(oneLine).pipe(z.string().min(1, '会議名を入力してください。').max(MINUTES_LIMITS.title)),
  heldOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付を選んでください。'),
  visibility: z.enum(MINUTES_VISIBILITIES),
  viewers: z.array(z.string().min(1).max(100)).max(MINUTES_LIMITS.viewers),
};
const createBody = z.strictObject({ uploadId: z.string().regex(/^mt_[0-9a-f]{16}$/), ...settingsFields });
const settingsBody = z.strictObject(settingsFields);

interface Upload {
  id: string;
  userId: string;
  ext: MinutesAudioExtension;
  bytes: number;
  received: number;
  tmp: string;
  /** The file's name as the sender's device gave it (shown when the sender comes back to it). */
  name: string;
  openedAt: number;
  /** When the last piece came (or the upload was opened or taken up again). */
  touchedAt: number;
  /** Being hashed and moved into place: it can no longer be dropped. */
  finalizing?: boolean;
}

/** `suggest` (2026-11-10) is asked for on its own after the meeting's stages; an app of before refuses the name. */
const claimBody = z.strictObject({ stages: z.array(z.enum(['transcribe', 'summarize', 'suggest'])).min(1).max(3) });
const audioBody = z.strictObject({ id: z.string().regex(/^mt_[0-9a-f]{16}$/), leaseToken: z.string().min(16).max(64) });
const resultBody = z.strictObject({
  id: z.string().regex(/^mt_[0-9a-f]{16}$/),
  leaseToken: z.string().min(16).max(64),
  stage: z.enum(['transcribe', 'summarize', 'suggest']),
  transcript: transcriptSchema.optional(),
  draft: draftSchema.optional(),
  error: z.string().max(500).optional(),
  /** The comment the draft was reworked after (2026-11-06; a worker of before never sends it). */
  reviewId: z.number().int().min(1).optional(),
  /** What the AI says it changed for the comment. */
  reply: z.string().max(MINUTES_LIMITS.reply * 4).optional(),
  /** The AI's guesses of a part (2026-11-10): the segment, its text as given, and the guess (the same text: nothing to change). */
  suggestions: z
    .array(z.strictObject({ index: z.number().int().min(0).max(MINUTES_LIMITS.segments), heard: z.string().max(MINUTES_LIMITS.segmentText), text: z.string().max(MINUTES_LIMITS.segmentText) }))
    .max(MINUTES_LIMITS.segments)
    .optional(),
});
/** transcribe: seconds of the recording; summarize: parts of the transcript; suggest: the part (it keeps the lease). */
const progressBody = z.strictObject({
  id: z.string().regex(/^mt_[0-9a-f]{16}$/),
  leaseToken: z.string().min(16).max(64),
  stage: z.enum(['transcribe', 'summarize', 'suggest']),
  done: z.number().min(0).max(1_000_000),
  total: z.number().positive().max(1_000_000).nullable(),
});

/** A stage's progress as the worker reported it, with where the pace is counted from. */
interface Reported {
  stage: MeetingWorkStage;
  leaseToken: string;
  done: number;
  total: number | null;
  firstAt: number;
  firstDone: number;
  at: number;
}

/** The extension of an upload, from its name or else its type; null when it is not a recording we take. */
export function audioExtension(filename: string | undefined, mimetype: string | undefined): MinutesAudioExtension | null {
  const ext = path.extname(filename ?? '').slice(1).toLowerCase();
  const byName = MINUTES_AUDIO_EXTENSIONS.find((e) => e === ext);
  if (byName) return byName;
  const type = (mimetype ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'audio/webm' || type === 'video/webm') return 'webm';
  if (type === 'audio/ogg') return 'ogg';
  if (type === 'audio/mp4' || type === 'audio/x-m4a') return 'm4a';
  if (type === 'audio/mpeg') return 'mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav';
  return null;
}

const dayAfter = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();

/**
 * `opened` is null when minutes.sqlite3 could not be opened: the minutes routes then answer 503 and the rest of
 * the app starts as usual.
 */
export function registerMinutesRoutes(app: FastifyInstance, config: MinutesConfig, opened: MinutesStore | null, deps: MinutesRouteDeps): void {
  const now = deps.now ?? Date.now;
  const nameOf = (userId: string) => deps.people.lookup(userId)?.displayName ?? '（不明な利用者）';

  const temporaryStaff = (user: User) =>
    isTemporaryStaffLoginId(user.id) || deps.discordUserIdOf(user.id) === null || departmentsOfLabel(user.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT);

  function member(request: FastifyRequest): User {
    const user = deps.requireUser(request);
    const session = deps.session(request);
    if (!session || user.disabled) throw new DomainError('unauthenticated', 'ログインしてください。');
    if (session.discordUserId.startsWith('staff:') || temporaryStaff(user)) throw new DomainError('forbidden', '議事録は委員だけが使えます。');
    return user;
  }

  if (!opened) {
    const unavailable = async (request: FastifyRequest) => {
      member(request);
      throw new HttpError(503, { error: 'minutes_unavailable', message: '議事録の保存ファイルを開けませんでした。システム課に連絡してください（ほかの機能は使えます）。' });
    };
    app.all('/api/minutes', unavailable);
    app.all('/api/minutes/*', unavailable);
    return;
  }
  const store = opened;

  const committee = (): MinutesPerson[] =>
    deps.people
      .list()
      .filter((u) => !u.disabled && !temporaryStaff(u))
      .map((u) => ({ id: u.id, name: u.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const canView = (row: MeetingRow, user: User) => user.canManageAccess || row.createdBy === user.id || row.visibility === 'members' || row.viewers.includes(user.id);
  // Not the person who confirmed: anyone who reads a meeting may confirm it, and that must not open the audio to them.
  const canListen = (row: MeetingRow, user: User) => !row.audioDeletedAt && (user.canManageAccess || row.createdBy === user.id);
  const canManage = (row: MeetingRow, user: User) => user.canManageAccess || row.createdBy === user.id;
  const canDelete = canManage;

  /** The people a meeting may be shown to: committee members, and those already chosen (kept if they left since). */
  function checkedViewers(given: string[], recorder: string, kept: string[] = []): string[] {
    const allowed = new Set([...committee().map((p) => p.id), ...kept]);
    const viewers = [...new Set(given)].filter((v) => v !== recorder);
    if (viewers.some((v) => !allowed.has(v))) throw new DomainError('validation', '見られる人に、委員でない人が含まれています。', { field: 'viewers' });
    return viewers;
  }

  /**
   * Items of the meeting already in the decision register, from any round of the AI's draft (their tokens name the
   * meeting, the round and the item).
   */
  const registeredDecisions = (row: MeetingRow) => deps.decisions?.countByTokenPrefix(minutesTokenPrefix(row.id)) ?? 0;

  /**
   * The transcript as the screen gets it: who checked a segment by name, not by ID, and the AI's guess on a segment
   * still to be checked that reads as the guess was made for (2026-11-10).
   */
  const shownTranscript = (t: StoredTranscript | null, guesses: SuggestionRow['items'] = {}) =>
    t && {
      ...t,
      segments: t.segments.map(({ checked, ...s }, i): TranscriptSegment => {
        if (checked) return { ...s, checked: { original: checked.original, at: checked.at, byName: nameOf(checked.by), ...(checked.ai ? { ai: true } : {}) } };
        const guess = guesses[i];
        return guess && guess.heard === s.text ? { ...s, suggestion: guess.text } : s;
      }),
    };

  /** The state of the AI's guesses, with how many segments now show one that changes the text and one that does not. */
  const suggestOf = (row: MeetingRow, s: SuggestionRow | null): MinutesDetail['suggest'] => {
    if (!s) return null;
    let changed = 0;
    let unchanged = 0;
    row.transcript?.segments.forEach((seg, i) => {
      const g = s.items[i];
      if (!seg.checked && g && g.heard === seg.text) {
        if (g.text === seg.text) unchanged++;
        else changed++;
      }
    });
    return {
      status: s.status,
      requestedAt: s.requestedAt,
      requestedByName: s.requestedBy === 'worker' ? '下書きのあと自動' : nameOf(s.requestedBy),
      doneAt: s.doneAt,
      error: s.status === 'failed' ? s.error : null,
      done: s.done,
      total: s.targets.length,
      changed,
      unchanged,
    };
  };

  function visible(request: FastifyRequest): { user: User; row: MeetingRow } {
    const user = member(request);
    const { meetingId } = deps.parse(meetingParams, request.params);
    const row = store.get(meetingId);
    // Someone not chosen for a meeting learns nothing of it, not even that it exists.
    if (!row || !canView(row, user)) throw notFound();
    return { user, row };
  }

  // Progress of the running stages (2026-11-05), in memory only: it is a display aid, and the worker reports again
  // within seconds after a restart. A report counts only while its lease still holds the stage, so a report of a lease
  // that ran out (and was claimed again) is not shown.
  const reported = new Map<string, Reported>();
  const holds = (row: MeetingRow, p: { stage: MeetingWorkStage; leaseToken: string }) => row.stage === `${p.stage}_run` && row.leaseToken === p.leaseToken;

  const progressOf = (row: MeetingRow): MinutesProgress | null => {
    const p = reported.get(row.id);
    if (!p || !holds(row, p)) return null;
    const ageMs = Math.max(0, now() - p.at);
    // A recording's length is sometimes an estimate, so a running stage never shows 100.
    const percent = p.total === null ? null : Math.min(99, Math.max(0, Math.floor((p.done / p.total) * 100)));
    const elapsed = p.at - p.firstAt;
    const gained = p.done - p.firstDone;
    const remaining = p.total !== null && elapsed >= PACE_AFTER_MS && gained > 0 ? (Math.max(0, p.total - p.done) * elapsed) / gained - ageMs : null;
    return { stage: p.stage, done: p.done, total: p.total, percent, remainingSec: remaining === null ? null : Math.max(0, Math.round(remaining / 1000)), ageSec: Math.round(ageMs / 1000) };
  };

  const detail = (row: MeetingRow, user: User): MinutesDetail => {
    // A correction after the confirmation does not keep the audio longer: the days count from the first confirmation.
    const keeps = row.firstConfirmedAt && !row.audioDeletedAt ? dayAfter(row.firstConfirmedAt, config.audioRetentionDays) : null;
    const reviews = store.reviews(row.id);
    const versions = store.versions(row.id);
    const revising = reviews.some((r) => r.status === 'pending');
    const reopened = row.stage === 'draft' && versions.length > 0;
    const draftStage = row.stage === 'draft';
    const used = reviews.filter((r) => r.status !== 'failed').length;
    const guesses = store.suggestion(row.id);
    return {
      id: row.id,
      title: row.title,
      heldOn: row.heldOn,
      stage: row.stage,
      failedStage: row.stage === 'failed' ? row.failedStage : null,
      error: row.stage === 'failed' ? row.error : null,
      progress: progressOf(row),
      visibility: row.visibility,
      viewers: row.viewers.map((id) => ({ id, name: nameOf(id) })),
      createdByName: nameOf(row.createdBy),
      createdAt: row.createdAt,
      confirmedByName: row.confirmedBy ? nameOf(row.confirmedBy) : null,
      confirmedAt: row.confirmedAt,
      audio: { present: !row.audioDeletedAt, bytes: row.audioBytes, deletesAt: keeps, deletedAt: row.audioDeletedAt },
      transcript: shownTranscript(row.transcript, guesses?.items),
      draft: row.draft,
      body: row.body,
      version: row.version,
      registeredDecisions: registeredDecisions(row),
      revising,
      reopened,
      bodyEdited: row.aiBody === null ? row.body.trim() !== '' : row.body !== row.aiBody,
      reviews: reviews.map((r) => ({ id: r.id, at: r.at, byName: nameOf(r.actorId), comment: r.comment, status: r.status, reply: r.reply, error: r.error, doneAt: r.doneAt })),
      versions: versions.map((v) => ({ no: v.no, confirmedByName: nameOf(v.confirmedBy), confirmedAt: v.confirmedAt, note: v.note })),
      suggest: suggestOf(row, guesses),
      can: {
        edit: draftStage,
        confirm: draftStage,
        listen: canListen(row, user),
        delete: canDelete(row, user),
        retry: row.stage === 'failed' && !(row.failedStage !== 'summarize' && row.audioDeletedAt),
        manage: canManage(row, user),
        review: draftStage && !!row.transcript && !!row.draft && used < MINUTES_LIMITS.reviews,
        check: draftStage && !!row.transcript,
        reopen: row.stage === 'confirmed',
        discard: reopened,
        suggest: draftStage && !!row.transcript && guesses?.status !== 'wait' && guesses?.status !== 'run',
      },
    };
  };

  app.get('/api/minutes/meta', async (request): Promise<MinutesMeta> => {
    const user = member(request);
    return { enabled: true, people: committee(), canAdminister: user.canManageAccess, audioRetentionDays: config.audioRetentionDays, maxAudioBytes: MINUTES_LIMITS.audioBytes, consentText: MINUTES_CONSENT_TEXT };
  });

  app.get('/api/minutes', async (request): Promise<MinutesListResponse> => {
    const user = member(request);
    const flags = store.flags();
    return {
      items: store
        .all()
        .filter((row) => canView(row, user))
        .map((row) => ({
          id: row.id,
          title: row.title,
          heldOn: row.heldOn,
          stage: row.stage,
          createdByName: nameOf(row.createdBy),
          createdAt: row.createdAt,
          confirmedAt: row.confirmedAt,
          durationSec: row.transcript?.durationSec ?? null,
          progressPercent: progressOf(row)?.percent ?? null,
          revising: flags.revising.has(row.id),
          reopened: row.stage === 'draft' && flags.versioned.has(row.id),
        })),
    };
  });

  // ---- uploading a recording in pieces (the reverse proxy takes at most 17 MB per request; a long recording is
  // hundreds of MB). POST /api/minutes/uploads opens an upload, PUT .../uploads/<id>?offset=<n> appends one piece
  // (a lost piece is sent again from the offset the server answers), POST /api/minutes makes the meeting from it.
  //
  // 2026-11-07: an upload outlives a restart of the app (a note beside its part on disk), and the sender can come back
  // to it after reloading the page: GET .../uploads lists the sender's own, and POST .../uploads/<id>/resume checks
  // that the file chosen again is the same (its size and the first bytes the server holds) before going on.

  const uploads = new Map<string, Upload>();
  const uploadPath = (id: string) => path.join(store.audioDir, `${id}.uploading`);
  const notePath = (id: string) => `${uploadPath(id)}.json`;
  /** Written whole or not at all (a note cut off by a stop would lose the part with it). */
  const saveUpload = (u: Upload) => {
    const next = `${notePath(u.id)}.next`;
    writeFileSync(next, JSON.stringify({ id: u.id, userId: u.userId, ext: u.ext, bytes: u.bytes, name: u.name, openedAt: u.openedAt, touchedAt: u.touchedAt }), { mode: 0o600 });
    renameSync(next, notePath(u.id));
  };
  const dropUpload = (u: Upload) => {
    if (u.finalizing) return;
    uploads.delete(u.id);
    rmSync(u.tmp, { force: true });
    rmSync(notePath(u.id), { force: true });
  };
  // What was being sent when the app stopped: taken back with as many bytes as its part holds (a piece cut off by the
  // stop is sent again from there). A part without a readable note, or untouched too long, is removed as before.
  for (const name of readdirSync(store.audioDir)) {
    if (!name.endsWith('.uploading.json')) continue;
    let restored: Upload | null = null;
    try {
      const saved = storedUpload.parse(JSON.parse(readFileSync(path.join(store.audioDir, name), 'utf8')));
      const tmp = uploadPath(saved.id);
      const size = name === `${saved.id}.uploading.json` && existsSync(tmp) ? statSync(tmp).size : -1;
      if (size >= 0 && size <= saved.bytes && now() - saved.touchedAt <= UPLOAD_IDLE_MS) restored = { ...saved, received: size, tmp };
    } catch {
      // unreadable: removed below
    }
    if (restored) uploads.set(restored.id, restored);
    else rmSync(path.join(store.audioDir, name), { force: true });
  }
  for (const name of readdirSync(store.audioDir)) {
    const orphan = (name.endsWith('.uploading') && !uploads.has(name.slice(0, -'.uploading'.length))) || name.endsWith('.uploading.json.next');
    if (orphan) rmSync(path.join(store.audioDir, name), { force: true });
  }

  /** SHA-256 of the first `bytes` bytes of a part on disk. */
  const headOf = (file: string, bytes: number) => {
    const buf = Buffer.alloc(bytes);
    if (bytes > 0) {
      const fd = openSync(file, 'r');
      try {
        let got = 0;
        while (got < bytes) {
          const n = readSync(fd, buf, got, bytes - got, got);
          if (n === 0) break;
          got += n;
        }
      } finally {
        closeSync(fd);
      }
    }
    return createHash('sha256').update(buf).digest('hex');
  };

  function ownUpload(uploadId: string, user: User): Upload {
    const u = uploads.get(uploadId);
    if (!u || u.userId !== user.id) throw new DomainError('not_found', 'この取り込みは見つかりません（時間がたって取り消された可能性があります）。最初から取り込み直してください。');
    return u;
  }

  app.post('/api/minutes/uploads', async (request, reply) => {
    const user = member(request);
    const body = deps.parse(uploadOpen, request.body);
    const ext = audioExtension(body.filename, body.type);
    if (!ext) throw new DomainError('validation', `録音ファイルは ${MINUTES_AUDIO_EXTENSIONS.join('・')} のどれかにしてください。`, { field: 'audio' });
    if (body.bytes > MINUTES_LIMITS.audioBytes) throw new DomainError('validation', `録音ファイルは ${sizeLabel(MINUTES_LIMITS.audioBytes)} までです。`, { field: 'audio' });
    const unconfirmed = store.all().filter((m) => m.createdBy === user.id && m.stage !== 'confirmed' && !m.audioDeletedAt).length;
    if (unconfirmed >= UNCONFIRMED_PER_PERSON) throw new DomainError('conflict', `確定していない議事録が ${UNCONFIRMED_PER_PERSON} 件あります。確定するか、要らないものを消してから取り込んでください。`);
    const pending = [...uploads.values()].reduce((sum, u) => sum + (u.bytes - u.received), 0);
    let free = Number.POSITIVE_INFINITY;
    try {
      const fs = statfsSync(store.audioDir);
      free = fs.bavail * fs.bsize;
    } catch {
      // unknown: not refused for that alone
    }
    if (free - pending - body.bytes < DISK_RESERVE_BYTES) throw new DomainError('conflict', 'サーバーの空き容量が足りないため、いまは取り込めません。システム課に連絡してください。');
    const mine = [...uploads.values()].filter((u) => u.userId === user.id && !u.finalizing);
    if (mine.length >= UPLOADS_PER_PERSON) dropUpload(mine.sort((a, b) => a.openedAt - b.openedAt)[0]!);
    const id = newMeetingId();
    const at = now();
    const u: Upload = { id, userId: user.id, ext, bytes: body.bytes, received: 0, tmp: uploadPath(id), name: oneLine(body.filename).slice(0, 255), openedAt: at, touchedAt: at };
    writeFileSync(u.tmp, '', { mode: 0o600 });
    saveUpload(u);
    uploads.set(id, u);
    return reply.code(201).send({ uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES });
  });

  app.get('/api/minutes/uploads', async (request): Promise<MinutesUploadsResponse> => {
    const user = member(request);
    const items = [...uploads.values()]
      .filter((u) => u.userId === user.id && !u.finalizing)
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .map((u) => ({
        uploadId: u.id,
        filename: u.name,
        bytes: u.bytes,
        received: u.received,
        openedAt: new Date(u.openedAt).toISOString(),
        expiresAt: new Date(u.touchedAt + UPLOAD_IDLE_MS).toISOString(),
      }));
    return { items };
  });

  // Going on with an upload: the same size, and the first bytes the server holds (up to 1 MB) are the same. A sender
  // that measured fewer or more bytes than the server now holds is told how many, and measures again.
  app.post('/api/minutes/uploads/:uploadId/resume', async (request, reply) => {
    const user = member(request);
    const u = ownUpload(deps.parse(uploadParams, request.params).uploadId, user);
    const body = deps.parse(resumeBody, request.body);
    if (u.finalizing) throw new DomainError('conflict', 'この録音はもう取り込み中です。');
    const headBytes = Math.min(u.received, MINUTES_UPLOAD_HEAD_BYTES);
    if (body.headBytes !== headBytes) return reply.code(409).send({ error: 'offset', message: '続きの位置が合いません。', received: u.received });
    if (body.bytes !== u.bytes || body.headSha256 !== headOf(u.tmp, headBytes)) {
      throw new DomainError('conflict', '選んだファイルは、送りかけの録音と違います。同じファイルを選ぶか、新しく取り込んでください。');
    }
    u.touchedAt = now();
    saveUpload(u);
    return { uploadId: u.id, chunkBytes: UPLOAD_CHUNK_BYTES, received: u.received };
  });

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_CHUNK_BYTES }, (_request, body, done) => done(null, body));
    // A request without the sign-in cookie is refused before the piece is read, so a stranger cannot make the server
    // hold 8 MB bodies (the sign-in itself is resolved after the body, and checked in the handler as everywhere).
    const signedIn = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!String(request.headers.cookie ?? '').includes(`${SESSION_COOKIE}=`)) return reply.code(401).send({ error: 'unauthenticated', message: 'ログインしてください。' });
    };
    scope.put('/api/minutes/uploads/:uploadId', { bodyLimit: UPLOAD_CHUNK_BYTES, onRequest: signedIn }, async (request, reply) => {
      const user = member(request);
      const u = ownUpload(deps.parse(uploadParams, request.params).uploadId, user);
      const { offset } = deps.parse(chunkQuery, request.query);
      const piece = request.body;
      if (!Buffer.isBuffer(piece) || piece.length === 0) throw new DomainError('validation', '送られた部分が空です。');
      // A piece sent twice or out of order: the answer says where to go on from.
      if (u.finalizing) throw new DomainError('conflict', 'この録音はもう取り込み中です。');
      if (offset !== u.received) return reply.code(409).send({ error: 'offset', message: '続きの位置が合いません。', received: u.received });
      if (u.received + piece.length > u.bytes) throw new DomainError('validation', '録音ファイルが最初に伝えた大きさを超えました。');
      appendFileSync(u.tmp, piece);
      u.received += piece.length;
      u.touchedAt = now();
      saveUpload(u);
      return { received: u.received };
    });
  });

  app.delete('/api/minutes/uploads/:uploadId', async (request, reply) => {
    const user = member(request);
    const u = ownUpload(deps.parse(uploadParams, request.params).uploadId, user);
    if (u.finalizing) throw new DomainError('conflict', 'この録音はもう取り込み中です。');
    dropUpload(u);
    return reply.code(204).send();
  });

  app.post('/api/minutes', async (request, reply) => {
    const user = member(request);
    const fields = deps.parse(createBody, request.body);
    const u = ownUpload(fields.uploadId, user);
    if (u.received !== u.bytes) throw new DomainError('validation', '録音ファイルがまだ全部届いていません。');
    const viewers = checkedViewers(fields.viewers, user.id);
    if (u.finalizing) throw new DomainError('conflict', 'この録音はもう取り込み中です。');
    u.finalizing = true;
    const hash = createHash('sha256');
    const finalPath = store.audioPath({ id: u.id, audioExt: u.ext });
    try {
      await pipeline(createReadStream(u.tmp), new Writable({ write: (chunk: Buffer, _enc, done) => { hash.update(chunk); done(); } }));
      renameSync(u.tmp, finalPath);
      rmSync(notePath(u.id), { force: true });
    } catch (err) {
      u.finalizing = false;
      throw err;
    }
    uploads.delete(u.id);
    try {
      const row = store.create(u.id, { title: fields.title, heldOn: fields.heldOn, visibility: fields.visibility, viewers, audioExt: u.ext, audioBytes: u.bytes, audioSha256: hash.digest('hex') }, user.id, deps.clock());
      return reply.code(201).send(detail(row, user));
    } catch (err) {
      rmSync(finalPath, { force: true });
      throw err;
    }
  });

  app.get('/api/minutes/:meetingId', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    return detail(row, user);
  });

  // Registers chosen decision items of a confirmed meeting into the decision register (2026-11-03). The server reads
  // the items and builds the text, so the screen only names them. Only a meeting that every committee member may read
  // (visibility "members") and that is confirmed can be registered: the register and the Bot's answer show the text to
  // all members, so a meeting limited to chosen people never reaches them. A registered item is one decision: its
  // token names the meeting and the item, so a second registration answers the decision already made.
  app.post('/api/minutes/:meetingId/decisions', async (request): Promise<MinutesRegisterResponse> => {
    const { user, row } = visible(request);
    const decisions = deps.decisions ?? null;
    if (!decisions) throw notFound();
    const body = deps.parse(decisionsRegisterBody, request.body);
    if (row.visibility !== 'members') throw new DomainError('forbidden', 'この議事録は一部の人にだけ見せているため、決定事項の台帳には登録できません。');
    if (row.stage !== 'confirmed') throw new DomainError('conflict', '議事録を確定してから、決定事項を登録してください。');
    if (!isDecisionDate(row.heldOn)) throw new DomainError('validation', '会議の日が実在する日付ではないため、決定事項に登録できません。');
    const items = row.draft?.decisions ?? [];
    const picked = [...new Set(body.items)].sort((a, b) => a - b);
    if (picked.some((i) => i >= items.length)) throw new DomainError('validation', '選んだ項目が議事録にありません。画面を読み直してください。', { field: 'items' });
    const departments = [...new Set(body.departments)];
    const results = picked.map((index) => {
      const input = decisionInputOfMinutesItem(row, items[index]!.text, departments, body.venue);
      if (!input.title) throw new DomainError('validation', '空の項目は登録できません。', { field: 'items' });
      const made = decisions.create(input, user.id, deps.clock(), minutesItemToken(row.id, index, row.draftRound), 'first');
      return { index, decisionId: made.row.id, replayed: made.replayed };
    });
    return { results };
  });

  // The recording, with byte ranges so the player can jump to a time.
  app.get('/api/minutes/:meetingId/audio', async (request, reply) => {
    const { user, row } = visible(request);
    if (!canListen(row, user)) throw new DomainError('forbidden', row.audioDeletedAt ? '音声はすでに消去されています。' : '音声を聞けるのは、録音した人と権限管理者だけです。');
    const file = store.audioPath(row);
    if (!existsSync(file)) throw notFound();
    const size = statSync(file).size;
    reply.header('Content-Type', MINUTES_AUDIO_TYPES[row.audioExt]);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Disposition', 'inline');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!range[1]) end = size - 1;
      if (start >= size || start > end) {
        reply.header('Content-Range', `bytes */${size}`);
        return reply.code(416).send();
      }
      start = Math.max(0, start);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', String(end - start + 1));
      return reply.code(206).send(createReadStream(file, { start, end }));
    }
    reply.header('Content-Length', String(size));
    return reply.send(createReadStream(file));
  });

  // The title, the date and who may read it, changed afterwards (2026-11-05), at any stage: by the recorder or an
  // access administrator. The last change wins (the history keeps the settings before it). Someone taken off the
  // readers loses the meeting at once; items already registered stay in the decision register.
  app.put('/api/minutes/:meetingId/settings', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    if (!canManage(row, user)) throw new DomainError('forbidden', '会議名・日付・見られる人を変えられるのは、録音した人と権限管理者だけです。');
    const body = deps.parse(settingsBody, request.body);
    const viewers = checkedViewers(body.viewers, row.createdBy, row.viewers);
    const result = store.updateSettings(row.id, { title: body.title, heldOn: body.heldOn, visibility: body.visibility, viewers }, user.id, deps.clock());
    if (result === null) throw notFound();
    return detail(result, user);
  });

  app.put('/api/minutes/:meetingId/body', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const body = deps.parse(bodyUpdate, request.body);
    const result = store.updateBody(row.id, body.expectedVersion, body.body, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', row.stage === 'confirmed' ? '確定した議事録は直せません。' : '下書きができてから直せます。');
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの議事録を直しました。読み込み直してから、もう一度直してください。');
    return detail(result, user);
  });

  // Confirming makes the next version (2026-11-06): the first confirmation is version 1, and a correction of confirmed
  // minutes needs a note of what it changed (kept in the history of versions).
  app.post('/api/minutes/:meetingId/confirm', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const body = deps.parse(confirmBody, request.body);
    const note = oneLine(body.note ?? '').slice(0, MINUTES_LIMITS.note);
    const result = store.confirm(row.id, body.expectedVersion, note, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', '確定できるのは下書きの議事録だけです。');
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの議事録を直しました。読み込み直して内容を確かめてから確定してください。');
    if (result === 'note') throw new DomainError('validation', '訂正した内容を書いてください（確定の履歴に残ります）。', { field: 'note' });
    return detail(result, user);
  });

  // Sends the draft back to the AI with a comment (2026-11-06): the worker reworks the draft with the transcript (as
  // people corrected it), the body (as people corrected it) and the comment, and writes the body anew. The body
  // before is kept with the comment. Unsaved changes on someone's screen are refused by the version, as for an edit.
  app.post('/api/minutes/:meetingId/review', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const body = deps.parse(reviewBody, request.body);
    const result = store.sendBack(row.id, body.expectedVersion, body.comment, MINUTES_LIMITS.reviews, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') {
      throw new DomainError('conflict', store.pendingReview(row.id) ? 'AI が手直し中です。終わってから差し戻してください。' : '差し戻せるのは下書きの議事録だけです（確定した議事録は、先に「訂正する」を押してください）。');
    }
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの議事録を直しました。読み込み直して内容を確かめてから差し戻してください。');
    if (result === 'no-draft') throw new DomainError('conflict', 'AI の下書きが無いので差し戻せません。');
    if (result === 'limit') throw new DomainError('conflict', `差し戻しは 1 件の議事録につき ${MINUTES_LIMITS.reviews} 回までです。ここからは本文を直接直してください。`);
    return detail(result, user);
  });

  /** The body as it was when a comment was sent back (the AI then wrote it anew). */
  app.get('/api/minutes/:meetingId/reviews/:reviewId/body', async (request): Promise<MinutesReviewBodyResponse> => {
    const user = member(request);
    const { meetingId, reviewId } = deps.parse(reviewParams, request.params);
    const row = store.get(meetingId);
    if (!row || !canView(row, user)) throw notFound();
    const review = store.reviews(row.id).find((r) => r.id === reviewId);
    if (!review) throw notFound();
    return { id: review.id, body: review.beforeBody };
  });

  // A segment of the transcript corrected after listening again, or confirmed as it was (2026-11-06). The text as the
  // speech model heard it is kept with the segment.
  app.put('/api/minutes/:meetingId/segments/:index', async (request): Promise<MinutesDetail> => {
    const user = member(request);
    const { meetingId, index } = deps.parse(segmentParams, request.params);
    const row = store.get(meetingId);
    if (!row || !canView(row, user)) throw notFound();
    const body = deps.parse(segmentBody, request.body);
    const text = oneLine(body.text).slice(0, MINUTES_LIMITS.segmentText);
    const result = store.checkSegment(row.id, index, body.expectedText, text, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', '文字起こしを直せるのは、下書き（訂正中を含む）の間だけです。');
    if (result === 'no-segment') throw new DomainError('not_found', 'その発言は文字起こしにありません。画面を読み込み直してください。');
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの発言を直しました。読み込み直して確かめてください。');
    return detail(result, user);
  });

  // The AI guesses again what was said in the segments still to be checked (2026-11-10), or goes on after it stopped.
  // Whoever may correct the transcript may ask; one run at a time per meeting.
  app.post('/api/minutes/:meetingId/suggest', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const targets = row.transcript ? suggestTargets(row.transcript.segments, unclearTimes(row.draft)) : [];
    const result = store.requestSuggestions(row.id, targets, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', 'AI の案を作れるのは、下書き（訂正中を含む）の間だけです。');
    if (result === 'busy') throw new DomainError('conflict', 'AI の案はいま作っているところです。終わるまでお待ちください。');
    if (result === 'none') throw new DomainError('conflict', '聞き直す文が残っていないので、AI の案は作りません。');
    return detail(result, user);
  });

  // A correction of confirmed minutes (2026-11-06): the minutes are a draft again while the last confirmed version
  // still stands; confirming makes the next version, and dropping the correction goes back to the last version.
  app.post('/api/minutes/:meetingId/reopen', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const body = deps.parse(versionOnly, request.body);
    const result = store.reopen(row.id, body.expectedVersion, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', '訂正できるのは確定した議事録だけです。');
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの議事録を変更しました。読み込み直してください。');
    return detail(result, user);
  });

  app.post('/api/minutes/:meetingId/discard', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const body = deps.parse(versionOnly, request.body);
    const result = store.discard(row.id, body.expectedVersion, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', 'やめられるのは、確定した議事録の訂正中だけです。');
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの議事録を直しました。読み込み直してください。');
    return detail(result, user);
  });

  app.get('/api/minutes/:meetingId/versions/:no', async (request): Promise<MinutesVersionResponse> => {
    const user = member(request);
    const { meetingId, no } = deps.parse(versionParams, request.params);
    const row = store.get(meetingId);
    if (!row || !canView(row, user)) throw notFound();
    const versions = store.versions(row.id);
    const v = versions.find((x) => x.no === no);
    if (!v) throw notFound();
    const previous = versions.filter((x) => x.no < no).at(-1) ?? null;
    return { no: v.no, confirmedByName: nameOf(v.confirmedBy), confirmedAt: v.confirmedAt, note: v.note, body: v.body, previousBody: previous?.body ?? null };
  });

  app.post('/api/minutes/:meetingId/retry', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const result = store.retry(row.id, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'not-failed') throw new DomainError('conflict', 'やり直せるのは失敗した議事録だけです。');
    if (result === 'no-audio') throw new DomainError('conflict', '音声が消去されているので、文字起こしはやり直せません。');
    return detail(result, user);
  });

  app.delete('/api/minutes/:meetingId', async (request, reply) => {
    const { user, row } = visible(request);
    if (!canDelete(row, user)) throw new DomainError('forbidden', '議事録を消せるのは、録音した人と権限管理者だけです。');
    const { expectedVersion } = deps.parse(deleteQuery, request.query);
    if (row.version !== expectedVersion) throw new DomainError('conflict', 'ほかの人が先にこの議事録を変更しました。内容を確かめてから消してください。');
    store.delete(row.id, user.id, deps.clock());
    reported.delete(row.id);
    rmSync(store.audioPath(row), { force: true });
    return reply.code(204).send();
  });

  // The minutes as they are now, or (?version=n) a confirmed version as it was confirmed.
  app.get('/api/minutes/:meetingId/export.md', async (request, reply) => {
    const { row } = visible(request);
    const { version } = deps.parse(exportQuery, request.query);
    const versions = store.versions(row.id);
    const chosen = version === undefined ? null : versions.find((v) => v.no === version);
    if (chosen === undefined) throw notFound();
    // Names and notes go into HTML comments: a run of hyphens would end the comment.
    const safe = (s: string) => s.replace(/-{2,}/g, '-');
    const last = versions.at(-1);
    const state = chosen
      ? `<!-- 確定: ${safe(nameOf(chosen.confirmedBy))} ${chosen.confirmedAt}（第${chosen.no}版${chosen.note ? `・訂正: ${safe(chosen.note)}` : ''}） -->`
      : row.stage === 'confirmed' && last
        ? `<!-- 確定: ${safe(nameOf(last.confirmedBy))} ${last.confirmedAt}（第${last.no}版） -->`
        : last
          ? `<!-- 訂正中（未確定）。確定している最新は第${last.no}版 -->`
          : '<!-- 未確定（下書き） -->';
    const head = [`<!-- 医薬祭 委員会アプリの議事録（AI の下書きを人が確認） 会議ID ${row.id} -->`, state, ''].join('\n');
    const text = head + (chosen ? chosen.body : row.body || (row.draft ? draftToMarkdown(row.title, row.heldOn, row.draft) : ''));
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    const suffix = chosen ? `_第${chosen.no}版` : '';
    reply.header('Content-Disposition', attachmentDisposition(`【AI】議事録_${row.heldOn.replaceAll('-', '')}_${row.title}${suffix}.md`.replace(/[\\/:*?"<>|]/g, '_'), 'minutes.md'));
    reply.header('Cache-Control', 'no-store');
    return reply.send(text);
  });

  // ---- the worker (signed; same checks as the Bot's data source)

  const nonces = new Map<string, number>();
  function spend(nonce: string, timestamp: number, at: number): boolean {
    for (const [seen, expires] of nonces) if (expires <= at) nonces.delete(seen);
    if (nonces.has(nonce) || nonces.size >= MAX_NONCES) return false;
    nonces.set(nonce, Math.max(at + 60_001, timestamp + MAX_SKEW_MS + 1));
    return true;
  }

  function verified(request: FastifyRequest, expectedPath: string): unknown {
    if (request.headers.origin !== undefined || request.url !== expectedPath || !Buffer.isBuffer(request.body)) throw new Error('REJECTED');
    const raw = request.raw.rawHeaders;
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i]!.toLowerCase();
      if (k.startsWith('x-svc-')) {
        if (seen.has(k)) throw new Error('REJECTED');
        seen.add(k);
      }
    }
    const read = (name: string) => {
      const v = request.headers[name];
      if (typeof v !== 'string') throw new Error('REJECTED');
      return v;
    };
    const client = read('x-svc-client');
    const timestamp = read('x-svc-timestamp');
    const nonce = read('x-svc-nonce');
    const signature = read('x-svc-signature');
    const actor = request.headers['x-svc-actor'] ?? '';
    const allowed = ['x-svc-client', 'x-svc-timestamp', 'x-svc-nonce', 'x-svc-actor', 'x-svc-signature'];
    const at = now();
    if (client !== WORKER_CLIENT || actor !== '' || !/^\d{13}$/.test(timestamp) || Math.abs(at - Number(timestamp)) > MAX_SKEW_MS || !/^[-_A-Za-z0-9]{24,128}$/.test(nonce) || [...seen].some((k) => !allowed.includes(k))) {
      throw new Error('REJECTED');
    }
    const body = request.body;
    const text = body.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(body) || !verifySignature(config.workerKey, { client, method: 'POST', path: expectedPath, timestamp, nonce, actor: '', body: text }, signature)) throw new Error('REJECTED');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('REJECTED');
    }
    if (!spend(nonce, Number(timestamp), at)) throw new Error('REJECTED');
    return json;
  }

  const glossary = () => {
    const words = new Set<string>(FIXED_GLOSSARY);
    for (const u of deps.people.list()) {
      if (u.disabled || temporaryStaff(u)) continue;
      words.add(u.displayName);
      for (const d of departmentsOfLabel(u.roleLabel)) words.add(d);
    }
    return [...words].filter((w) => w && w.length <= 40).slice(0, 300);
  };

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WORKER_BODY_MAX }, (_request, body, done) => done(null, body));
    // Before the body is read: only requests that name the worker and a current time go on (the signature itself
    // is checked on the body), so a stranger cannot make the server hold 16 MB bodies.
    scope.addHook('onRequest', async (request, reply) => {
      const ts = request.headers['x-svc-timestamp'];
      if (request.headers['x-svc-client'] !== WORKER_CLIENT || typeof ts !== 'string' || !/^\d{13}$/.test(ts) || Math.abs(now() - Number(ts)) > MAX_SKEW_MS) return reply.code(401).send(REJECTED);
    });
    scope.setErrorHandler((error, _request, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      // Too large: said as it is, so the worker can report a failure instead of retrying the same answer.
      if (status === 413) return reply.code(413).send({ error: 'too_large' });
      if (status !== undefined && status >= 400 && status < 500) return reply.code(401).send(REJECTED);
      return reply.code(500).send({ error: 'internal', message: 'サーバー内部でエラーが発生しました。' });
    });

    scope.post(WORKER_PATHS.claim, { bodyLimit: 1024 }, async (request, reply) => {
      let stages: WorkerStage[];
      try {
        const parsed = claimBody.safeParse(verified(request, WORKER_PATHS.claim));
        if (!parsed.success) throw new Error('REJECTED');
        stages = parsed.data.stages;
      } catch {
        return reply.code(401).send(REJECTED);
      }
      // A meeting's own stages first: the guesses never hold up a transcription or a summary waiting meanwhile.
      const meetingStages = stages.filter((s): s is MeetingWorkStage => s !== 'suggest');
      const job = meetingStages.length > 0 ? store.claim(meetingStages, now(), deps.clock()) : null;
      if (!job && stages.includes('suggest')) {
        const part = store.claimSuggestion(now(), deps.clock());
        if (part) {
          const { row } = part;
          return reply.header('Cache-Control', 'no-store').send({
            job: {
              id: row.id,
              stage: 'suggest',
              leaseToken: part.leaseToken,
              title: row.title,
              heldOn: row.heldOn,
              audio: null,
              glossary: glossary(),
              transcript: row.transcript && {
                ...row.transcript,
                segments: row.transcript.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, ...(s.checked ? { checked: true } : {}) })),
              },
              // The AI's "要確認" items: free text, a time near the place (not always on the segment).
              suggest: { targets: part.targets, hints: (row.draft?.unclear ?? []).map((u) => ({ text: u.text, at: u.at })), done: part.done, total: part.total },
            },
          });
        }
      }
      if (!job) return reply.header('Cache-Control', 'no-store').send({ job: null });
      const { row } = job;
      const pending = job.stage === 'summarize' ? store.pendingReview(row.id) : null;
      return reply.header('Cache-Control', 'no-store').send({
        job: {
          id: row.id,
          stage: job.stage,
          leaseToken: job.leaseToken,
          title: row.title,
          heldOn: row.heldOn,
          audio: job.stage === 'transcribe' ? { ext: row.audioExt, bytes: row.audioBytes, sha256: row.audioSha256 } : null,
          glossary: glossary(),
          // The text people corrected stands; the worker is told which segments a person checked (not who).
          transcript:
            job.stage === 'summarize' && row.transcript
              ? { ...row.transcript, segments: row.transcript.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, ...(s.checked ? { checked: true } : {}) })) }
              : null,
          // A rework of the draft after a comment (2026-11-06): the draft and the body as they are, the comment, and the
          // comments answered before (so the AI does not undo them). A worker of before ignores it and writes a new
          // draft; the result then has no reviewId, and the comment is marked failed.
          review: pending && {
            id: pending.id,
            comment: pending.comment,
            draft: row.draft,
            body: row.body,
            earlier: store
              .reviews(row.id)
              .filter((r) => r.status === 'done')
              .slice(-5)
              .map((r) => ({ comment: r.comment, reply: r.reply ?? '' })),
          },
        },
      });
    });

    scope.post(WORKER_PATHS.audio, { bodyLimit: 1024 }, async (request, reply) => {
      let id: string;
      let token: string;
      try {
        const parsed = audioBody.safeParse(verified(request, WORKER_PATHS.audio));
        if (!parsed.success) throw new Error('REJECTED');
        ({ id, leaseToken: token } = parsed.data);
      } catch {
        return reply.code(401).send(REJECTED);
      }
      const row = store.get(id);
      // Only while the worker holds this meeting's transcription.
      if (!row || row.stage !== 'transcribe_run' || row.leaseToken !== token || row.audioDeletedAt) return reply.code(409).send({ error: 'not_held' });
      const file = store.audioPath(row);
      if (!existsSync(file)) return reply.code(409).send({ error: 'no_audio' });
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(statSync(file).size));
      reply.header('Cache-Control', 'no-store');
      return reply.send(createReadStream(file));
    });

    scope.post(WORKER_PATHS.result, { bodyLimit: WORKER_BODY_MAX }, async (request, reply) => {
      let body: z.infer<typeof resultBody>;
      try {
        const parsed = resultBody.safeParse(verified(request, WORKER_PATHS.result));
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
        body = parsed.data;
      } catch {
        return reply.code(401).send(REJECTED);
      }
      const at = deps.clock();
      let ok: boolean;
      if (body.stage === 'suggest') {
        if (body.error !== undefined) {
          ok = store.failSuggestions(body.id, body.leaseToken, body.error.replace(/\s+/g, ' ').trim() || 'AI の案づくりに失敗しました。', at);
        } else if (body.suggestions) {
          // One line, as a corrected segment is kept; the fixed misreadings (共産→協賛 …) apply to a guess too.
          const guesses = body.suggestions.map((g) => ({ index: g.index, heard: g.heard, text: fixTranscriptText(g.text.replace(/\s+/g, ' ').trim()).slice(0, MINUTES_LIMITS.segmentText) }));
          ok = store.completeSuggestions(body.id, body.leaseToken, guesses, at);
        } else {
          return reply.code(400).send({ error: 'invalid', issues: ['suggestions or error is required for the stage'] });
        }
        if (!ok) return reply.code(409).send({ error: 'not_held' });
        return reply.header('Cache-Control', 'no-store').send({ ok: true });
      }
      if (body.error !== undefined) {
        ok = store.fail(body.id, body.leaseToken, body.stage, body.error.replace(/\s+/g, ' ').trim() || '処理に失敗しました。', at);
      } else if (body.stage === 'transcribe' && body.transcript) {
        const segments = body.transcript.segments
          .map((s) => fixedSegment({ start: s.start, end: Math.max(s.start, s.end), text: s.text.trim(), ...(s.confidence ? { confidence: s.confidence } : {}) }))
          .filter((s) => s.text);
        ok = store.completeTranscript(body.id, body.leaseToken, { ...body.transcript, segments }, at);
      } else if (body.stage === 'summarize' && body.draft) {
        const row = store.get(body.id);
        if (!row?.transcript) return reply.code(409).send({ error: 'not_held' });
        const draft = checkedDraft(row.transcript, body.draft);
        const pending = store.pendingReview(row.id);
        if (!pending) {
          // The AI's guesses for the segments to listen to again follow the first draft (2026-11-10).
          const targets = suggestTargets(row.transcript.segments, unclearTimes(draft));
          ok = store.completeDraft(body.id, body.leaseToken, draft, draftToMarkdown(row.title, row.heldOn, draft), at, targets);
        } else if (body.reviewId === pending.id) {
          // The body is written anew from the reworked draft; the attendees a person wrote are carried over.
          const next = carryOverAttendees(row.body, draftToMarkdown(row.title, row.heldOn, draft));
          const answer = (body.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, MINUTES_LIMITS.reply) || '（AI からの説明はありませんでした）';
          ok = store.completeRevision(body.id, body.leaseToken, pending.id, draft, next, answer, at);
        } else {
          // A worker of before wrote a new draft without reading the comment: the draft is left as it was.
          ok = store.fail(body.id, body.leaseToken, 'summarize', '処理役が古い版のため、コメントに沿った手直しができませんでした。システム課に連絡してください。', at);
        }
      } else {
        return reply.code(400).send({ error: 'invalid', issues: ['transcript, draft or error is required for the stage'] });
      }
      if (!ok) return reply.code(409).send({ error: 'not_held' });
      reported.delete(body.id);
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    });

    // How far the running stage has got (2026-11-05). Only while the worker holds the stage with this lease; a worker of
    // an older app gets 404 here and stops reporting.
    scope.post(WORKER_PATHS.progress, { bodyLimit: 1024 }, async (request, reply) => {
      let body: z.infer<typeof progressBody>;
      try {
        const parsed = progressBody.safeParse(verified(request, WORKER_PATHS.progress));
        if (!parsed.success) return reply.code(400).send({ error: 'invalid', issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
        body = parsed.data;
      } catch {
        return reply.code(401).send(REJECTED);
      }
      // A part of the guesses is one call of the AI: its report only keeps the lease (the screen counts the parts done).
      if (body.stage === 'suggest') {
        if (!store.renewSuggestionLease(body.id, body.leaseToken, now() + LEASE_RENEW_MS.suggest)) return reply.code(409).send({ error: 'not_held' });
        return reply.header('Cache-Control', 'no-store').send({ ok: true });
      }
      const stage = body.stage;
      const row = store.get(body.id);
      if (!row || !holds(row, { stage, leaseToken: body.leaseToken })) return reply.code(409).send({ error: 'not_held' });
      // A worker that reports is still at it: its lease is pushed out (2026-11-07), so a slow machine is never
      // overtaken by its own lease; one that stops reporting loses the stage as before.
      store.renewLease(row.id, stage, body.leaseToken, now() + LEASE_RENEW_MS[stage]);
      if (!reported.has(row.id) && reported.size >= MAX_REPORTED) {
        for (const [id, p] of reported) {
          const r = store.get(id);
          if (!r || !holds(r, p)) reported.delete(id);
        }
        if (reported.size >= MAX_REPORTED) return reply.header('Cache-Control', 'no-store').send({ ok: true });
      }
      const at = now();
      const prev = reported.get(row.id);
      const same = prev && prev.stage === stage && prev.leaseToken === body.leaseToken && body.done >= prev.firstDone;
      reported.set(row.id, {
        stage,
        leaseToken: body.leaseToken,
        done: body.done,
        total: body.total,
        firstAt: same ? prev.firstAt : at,
        firstDone: same ? prev.firstDone : body.done,
        at,
      });
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    });
  });

  // ---- deleting the audio a fixed number of days after confirmation (設計書 §4-2)

  const sweep = () => {
    for (const u of [...uploads.values()]) if (now() - u.touchedAt > UPLOAD_IDLE_MS) dropUpload(u);
    try {
      const cutoff = new Date(now() - config.audioRetentionDays * 86_400_000).toISOString();
      for (const row of store.audioDue(cutoff)) {
        rmSync(store.audioPath(row), { force: true });
        store.markAudioDeleted(row.id, deps.clock());
      }
    } catch (err) {
      console.error(`議事録の音声の消去に失敗しました: ${(err as Error).message}`);
    }
  };
  sweep();
  const timer = setInterval(sweep, RETENTION_CHECK_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
