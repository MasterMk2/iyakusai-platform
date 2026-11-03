import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import {
  draftToMarkdown,
  MINUTES_AUDIO_EXTENSIONS,
  MINUTES_AUDIO_TYPES,
  MINUTES_CONSENT_TEXT,
  MINUTES_LIMITS,
  MINUTES_VISIBILITIES,
  type MinutesAudioExtension,
  type MinutesDetail,
  type MinutesListResponse,
  type MinutesMeta,
  type MinutesPerson,
} from '../../shared/minutes.js';
import { SESSION_COOKIE } from '../discord-auth/http.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { attachmentDisposition } from '../http/content-disposition.js';
import { HttpError } from '../http/http-error.js';
import type { MailSession } from '../mailbox/routes.js';
import type { People } from '../mailbox/service.js';
import { MAX_SKEW_MS, verifySignature } from '../tasks/signing.js';
import type { MinutesConfig } from './config.js';
import { MinutesStore, newMeetingId, type MeetingRow, type WorkerStage } from './store.js';
import { checkedDraft, draftSchema, transcriptSchema } from './validate.js';

// Meeting minutes (α, 2026-11-02). Browser routes under /api/minutes (Discord login, committee members only, like
// the contacts), and the signed routes of the minutes worker under /v1/minutes/worker (svc-auth/v1, client
// "iyakusai-minutes-worker", its own key from minutes.json). The worker runs on the server host and polls; the
// app never calls out, and the audio is only ever handed to the worker.
//
// Who sees what (設計書 §4-7): a meeting is read by its recorder, the people chosen for it (or every member), and
// the access administrators; its audio is played only by the recorder, the person who confirmed it and the
// access administrators; it is deleted by the recorder or an access administrator.

export const WORKER_CLIENT = 'iyakusai-minutes-worker';
export const WORKER_PATHS = { claim: '/v1/minutes/worker/claim', audio: '/v1/minutes/worker/audio', result: '/v1/minutes/worker/result' } as const;
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
/** An upload left unfinished this long is dropped. */
const UPLOAD_EXPIRES_MS = 12 * 3_600_000;
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
}

const meetingParams = z.strictObject({ meetingId: z.string().regex(/^mt_[0-9a-f]{16}$/) });
const bodyUpdate = z.strictObject({ expectedVersion: z.number().int().min(1), body: z.string().max(MINUTES_LIMITS.body) });
const confirmBody = z.strictObject({ expectedVersion: z.number().int().min(1) });
const deleteQuery = z.strictObject({ expectedVersion: z.coerce.number().int().min(1) });
/** One line of plain text: control characters and runs of spaces become one space. */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();

const uploadParams = z.strictObject({ uploadId: z.string().regex(/^mt_[0-9a-f]{16}$/) });
const uploadOpen = z.strictObject({ filename: z.string().max(255), type: z.string().max(100), bytes: z.number().int().min(1) });
const chunkQuery = z.strictObject({ offset: z.coerce.number().int().min(0) });
const createBody = z.strictObject({
  uploadId: z.string().regex(/^mt_[0-9a-f]{16}$/),
  title: z.string().max(MINUTES_LIMITS.title * 2).transform(oneLine).pipe(z.string().min(1, '会議名を入力してください。').max(MINUTES_LIMITS.title)),
  heldOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付を選んでください。'),
  visibility: z.enum(MINUTES_VISIBILITIES),
  viewers: z.array(z.string().min(1).max(100)).max(MINUTES_LIMITS.viewers),
});

interface Upload {
  id: string;
  userId: string;
  ext: MinutesAudioExtension;
  bytes: number;
  received: number;
  tmp: string;
  openedAt: number;
  /** Being hashed and moved into place: it can no longer be dropped. */
  finalizing?: boolean;
}

const claimBody = z.strictObject({ stages: z.array(z.enum(['transcribe', 'summarize'])).min(1).max(2) });
const audioBody = z.strictObject({ id: z.string().regex(/^mt_[0-9a-f]{16}$/), leaseToken: z.string().min(16).max(64) });
const resultBody = z.strictObject({
  id: z.string().regex(/^mt_[0-9a-f]{16}$/),
  leaseToken: z.string().min(16).max(64),
  stage: z.enum(['transcribe', 'summarize']),
  transcript: transcriptSchema.optional(),
  draft: draftSchema.optional(),
  error: z.string().max(500).optional(),
});

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
  const canDelete = (row: MeetingRow, user: User) => user.canManageAccess || row.createdBy === user.id;

  function visible(request: FastifyRequest): { user: User; row: MeetingRow } {
    const user = member(request);
    const { meetingId } = deps.parse(meetingParams, request.params);
    const row = store.get(meetingId);
    // Someone not chosen for a meeting learns nothing of it, not even that it exists.
    if (!row || !canView(row, user)) throw notFound();
    return { user, row };
  }

  const detail = (row: MeetingRow, user: User): MinutesDetail => {
    const keeps = row.confirmedAt && !row.audioDeletedAt ? dayAfter(row.confirmedAt, config.audioRetentionDays) : null;
    return {
      id: row.id,
      title: row.title,
      heldOn: row.heldOn,
      stage: row.stage,
      failedStage: row.stage === 'failed' ? row.failedStage : null,
      error: row.stage === 'failed' ? row.error : null,
      visibility: row.visibility,
      viewers: row.viewers.map((id) => ({ id, name: nameOf(id) })),
      createdByName: nameOf(row.createdBy),
      createdAt: row.createdAt,
      confirmedByName: row.confirmedBy ? nameOf(row.confirmedBy) : null,
      confirmedAt: row.confirmedAt,
      audio: { present: !row.audioDeletedAt, bytes: row.audioBytes, deletesAt: keeps, deletedAt: row.audioDeletedAt },
      transcript: row.transcript,
      draft: row.draft,
      body: row.body,
      version: row.version,
      can: {
        edit: row.stage === 'draft',
        confirm: row.stage === 'draft',
        listen: canListen(row, user),
        delete: canDelete(row, user),
        retry: row.stage === 'failed' && !(row.failedStage !== 'summarize' && row.audioDeletedAt),
      },
    };
  };

  app.get('/api/minutes/meta', async (request): Promise<MinutesMeta> => {
    const user = member(request);
    return { enabled: true, people: committee(), canAdminister: user.canManageAccess, audioRetentionDays: config.audioRetentionDays, maxAudioBytes: MINUTES_LIMITS.audioBytes, consentText: MINUTES_CONSENT_TEXT };
  });

  app.get('/api/minutes', async (request): Promise<MinutesListResponse> => {
    const user = member(request);
    return {
      items: store
        .all()
        .filter((row) => canView(row, user))
        .map((row) => ({ id: row.id, title: row.title, heldOn: row.heldOn, stage: row.stage, createdByName: nameOf(row.createdBy), createdAt: row.createdAt, confirmedAt: row.confirmedAt, durationSec: row.transcript?.durationSec ?? null })),
    };
  });

  // ---- uploading a recording in pieces (the reverse proxy takes at most 17 MB per request; a long recording is
  // hundreds of MB). POST /api/minutes/uploads opens an upload, PUT .../uploads/<id>?offset=<n> appends one piece
  // (a lost piece is sent again from the offset the server answers), POST /api/minutes makes the meeting from it.

  const uploads = new Map<string, Upload>();
  const uploadPath = (id: string) => path.join(store.audioDir, `${id}.uploading`);
  const dropUpload = (u: Upload) => {
    if (u.finalizing) return;
    uploads.delete(u.id);
    rmSync(u.tmp, { force: true });
  };
  // Leftovers of a restart in the middle of an upload.
  for (const name of readdirSync(store.audioDir)) if (name.endsWith('.uploading')) rmSync(path.join(store.audioDir, name), { force: true });

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
    if (body.bytes > MINUTES_LIMITS.audioBytes) throw new DomainError('validation', `録音ファイルは ${Math.floor(MINUTES_LIMITS.audioBytes / 1024 / 1024)} MB までです。`, { field: 'audio' });
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
    const u: Upload = { id, userId: user.id, ext, bytes: body.bytes, received: 0, tmp: uploadPath(id), openedAt: now() };
    writeFileSync(u.tmp, '', { mode: 0o600 });
    uploads.set(id, u);
    return reply.code(201).send({ uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES });
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
    const known = new Set(committee().map((p) => p.id));
    const viewers = [...new Set(fields.viewers)].filter((v) => v !== user.id);
    if (viewers.some((v) => !known.has(v))) throw new DomainError('validation', '見られる人に、委員でない人が含まれています。', { field: 'viewers' });
    if (u.finalizing) throw new DomainError('conflict', 'この録音はもう取り込み中です。');
    u.finalizing = true;
    const hash = createHash('sha256');
    const finalPath = store.audioPath({ id: u.id, audioExt: u.ext });
    try {
      await pipeline(createReadStream(u.tmp), new Writable({ write: (chunk: Buffer, _enc, done) => { hash.update(chunk); done(); } }));
      renameSync(u.tmp, finalPath);
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

  app.put('/api/minutes/:meetingId/body', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const body = deps.parse(bodyUpdate, request.body);
    const result = store.updateBody(row.id, body.expectedVersion, body.body, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', row.stage === 'confirmed' ? '確定した議事録は直せません。' : '下書きができてから直せます。');
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの議事録を直しました。読み込み直してから、もう一度直してください。');
    return detail(result, user);
  });

  app.post('/api/minutes/:meetingId/confirm', async (request): Promise<MinutesDetail> => {
    const { user, row } = visible(request);
    const body = deps.parse(confirmBody, request.body);
    const result = store.confirm(row.id, body.expectedVersion, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'locked') throw new DomainError('conflict', '確定できるのは下書きの議事録だけです。');
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの議事録を直しました。読み込み直して内容を確かめてから確定してください。');
    return detail(result, user);
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
    rmSync(store.audioPath(row), { force: true });
    return reply.code(204).send();
  });

  app.get('/api/minutes/:meetingId/export.md', async (request, reply) => {
    const { row } = visible(request);
    const head = [
      `<!-- 医薬祭 委員会アプリの議事録（AI の下書きを人が確認） 会議ID ${row.id} -->`,
      row.confirmedAt ? `<!-- 確定: ${nameOf(row.confirmedBy!).replace(/-{2,}/g, '-')} ${row.confirmedAt} -->` : '<!-- 未確定（下書き） -->',
      '',
    ].join('\n');
    const text = head + (row.body || (row.draft ? draftToMarkdown(row.title, row.heldOn, row.draft) : ''));
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', attachmentDisposition(`【AI】議事録_${row.heldOn.replaceAll('-', '')}_${row.title}.md`.replace(/[\\/:*?"<>|]/g, '_'), 'minutes.md'));
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
      const job = store.claim(stages, now(), deps.clock());
      if (!job) return reply.header('Cache-Control', 'no-store').send({ job: null });
      const { row } = job;
      return reply.header('Cache-Control', 'no-store').send({
        job: {
          id: row.id,
          stage: job.stage,
          leaseToken: job.leaseToken,
          title: row.title,
          heldOn: row.heldOn,
          audio: job.stage === 'transcribe' ? { ext: row.audioExt, bytes: row.audioBytes, sha256: row.audioSha256 } : null,
          glossary: glossary(),
          transcript: job.stage === 'summarize' ? row.transcript : null,
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
      if (body.error !== undefined) {
        ok = store.fail(body.id, body.leaseToken, body.stage, body.error.replace(/\s+/g, ' ').trim() || '処理に失敗しました。', at);
      } else if (body.stage === 'transcribe' && body.transcript) {
        const segments = body.transcript.segments.map((s) => ({ start: s.start, end: Math.max(s.start, s.end), text: s.text.trim() })).filter((s) => s.text);
        ok = store.completeTranscript(body.id, body.leaseToken, { ...body.transcript, segments }, at);
      } else if (body.stage === 'summarize' && body.draft) {
        const row = store.get(body.id);
        if (!row?.transcript) return reply.code(409).send({ error: 'not_held' });
        const draft = checkedDraft(row.transcript, body.draft);
        ok = store.completeDraft(body.id, body.leaseToken, draft, draftToMarkdown(row.title, row.heldOn, draft), at);
      } else {
        return reply.code(400).send({ error: 'invalid', issues: ['transcript, draft or error is required for the stage'] });
      }
      if (!ok) return reply.code(409).send({ error: 'not_held' });
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    });
  });

  // ---- deleting the audio a fixed number of days after confirmation (設計書 §4-2)

  const sweep = () => {
    for (const u of [...uploads.values()]) if (now() - u.openedAt > UPLOAD_EXPIRES_MS) dropUpload(u);
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
