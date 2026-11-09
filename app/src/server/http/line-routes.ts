import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HANDLING_STATUSES, LIMITS, type ApiError } from '../../shared/api.js';
import { LINE_ATTACH_LIMITS, MOCK_PUSH_OUTCOMES, type BroadcastSendResponse, type LineFileResponse, type LineIngestReport, type LineMediaResponse, type LineSendResponse, type OutboxView } from '../../shared/line.js';
import { DomainError, type User } from '../domain/types.js';
import { readableConversation, replyableConversation } from '../line/access.js';
import { beginBroadcast, broadcastOptions, broadcastSummary, previewBroadcast, recordBroadcastAttempt } from '../line/broadcast.js';
import { lineCommitteeAccess, setLineCommitteeGrant } from '../line/committee.js';
import { MockLinePushConnector, type LinePushConnector, type LinePushOutcome } from '../line/connector.js';
import { registerDiscordLineRoutes, type DiscordLineOptions } from '../line/discord.js';
import { MAX_LINE_BATCH } from '../line/fixtures.js';
import {
  attachmentGone,
  attachmentOfFile,
  attachmentPublic,
  checkFileUploader,
  expireAttachments,
  FILE_MAX_BYTES,
  FILE_NAME,
  FILES_PATH,
  fileView,
  registerAttachment,
  storeAttachment,
  type LineAttachmentFiles,
} from '../line/files.js';
import { isInboundImage, type InboundImageSource } from '../line/inbound-media.js';
import { attachmentDisposition } from './content-disposition.js';
import { expireMedia, MEDIA_FILE, MEDIA_PATH, mediaExpired, mediaExpiresAt, mediaOfFile, ORIGINAL_MAX_BYTES, registerMedia, checkUploader, storeUpload, type LineMediaFiles } from '../line/media.js';
import { sha256 } from '../line/normalize.js';
import { lineAccountSummaries, lineConversationDetail, type LinePeople } from '../line/queries.js';
import { beginRetry, beginSend, checkLineQuota, discardDraft, evaluateTarget, observeMemberCount, observeProfile, previewReply, pushRequestOf, recordAttempt, saveDraft, type PreviewQuota, type SendContext } from '../line/reply.js';
import { releaseLineBatches } from '../line/seed.js';
import type { LineStore } from '../line/store.js';
import { addLineNote, getOutbox, lineAccessMatrix, lineAssigneeCandidates, lineAuditLog, setLineGrant, updateLineTriage } from '../line/triage.js';
import type { LineState } from '../line/types.js';

/** LINE runtime. Absent => no LINE routes at all (404), e.g. trusted-proxy mode by default. */
export interface LineRuntime {
  store: LineStore;
  /** The mock connector, or the Messaging API (committee, 2026-10-28). */
  connector: LinePushConnector;
  /** Fresh synthetic state for the demo sample reset. */
  seed: (now: string) => LineState;
  /** Received images (2026-11-04). Absent: shown as not imported. */
  inboundImages?: InboundImageSource;
}

export interface LineRouteContext {
  line: LineRuntime;
  /** Who can be named and assigned: the mail state, or the committee's Discord people. */
  mail: { readonly current: LinePeople };
  clock: () => string;
  /** Demo persona mode: registers the demo-only feed release and connector script controls. */
  demo: boolean;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
  requireUser: (request: FastifyRequest) => User;
  requireDemoAdmin: (request: FastifyRequest, action: string) => User;
  /**
   * The committee's official LINE account (2026-10-28): grants like the committee mailbox's under
   * /api/line/admin/access instead of the synthetic /api/admin/line routes, and LINE's own facts (member count,
   * this month's messages) read just before a preview.
   */
  committee?: {
    people: () => User[];
    /** Where LINE fetches sent images (send.publicBaseUrl or SMM_PUBLIC_ORIGIN, https only); null: no images. */
    imageBaseUrl?: string | null;
    /** The image files (line-media/ in the mail folder). Absent: no images. */
    media?: LineMediaFiles;
    /** The files sent as links (line-files/ in the mail folder), 2026-11-10. Absent: no files. */
    files?: LineAttachmentFiles;
    /** Replies from Discord threads through the Bot (contract C). Absent: no internal routes. */
    discord?: DiscordLineOptions | null;
  };
}

const convParams = z.strictObject({ conversationId: z.string().regex(/^lc_[0-9a-f]{16}$/) });
const messageParams = z.strictObject({ conversationId: z.string().regex(/^lc_[0-9a-f]{16}$/), messageId: z.string().regex(/^lm_[0-9a-f]{16}$/) });
const intentParams = z.strictObject({ intentId: z.string().regex(/^lo_[0-9a-f]{16}$/) });
const shortId = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/);
const draftId = z.string().regex(/^ld_[0-9a-f]{16}$/);
const version = z.number().int().min(1).max(1_000_000);
const bodyText = z.string().max(LIMITS.noteMaxLength * 5);

const triageBody = z
  .strictObject({
    expectedVersion: version,
    status: z.enum(HANDLING_STATUSES).optional(),
    assigneeId: shortId.nullable().optional(),
    labels: z.array(z.string().max(200)).max(50).optional(),
  })
  .refine((b) => b.status !== undefined || b.assigneeId !== undefined || b.labels !== undefined, { message: '変更内容がありません' });
const noteBody = z.strictObject({ body: z.string().max(LIMITS.noteMaxLength * 2) });
const previewBody = z.strictObject({ draftId, draftVersion: version, publicDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional() });
// No recipient, method or "confirmed" flag is accepted from the client: strict schemas reject them.
const sendBody = z.strictObject({
  consentId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  operationId: z.uuid(),
  draftId,
  draftVersion: version,
  body: bodyText,
});
const retryBody = z.strictObject({ expectedAttempts: z.number().int().min(1).max(100) });
const mediaId = z.string().regex(/^lmd_[0-9a-f]{16}$/);
const fileId = z.string().regex(/^lfl_[0-9a-f]{16}$/);
const imageIds = z.array(mediaId).max(LINE_ATTACH_LIMITS.imagesMax);
const fileIds = z.array(fileId).max(LINE_ATTACH_LIMITS.filesMax);
const publicDays = z.union([z.literal(1), z.literal(7), z.literal(30)]);
const draftBodyWithImage = z.strictObject({
  body: bodyText,
  expectedVersion: version.nullable(),
  imageId: mediaId.nullable().optional(),
  imageIds: imageIds.optional(),
  fileIds: fileIds.optional(),
});
const accountParams = z.strictObject({ accountId: shortId });
const mediaParams = z.strictObject({ file: z.string().regex(MEDIA_FILE) });
const fileParams = z.strictObject({ file: z.string().regex(FILE_NAME) });
const broadcastPreviewBody = z.strictObject({
  recipients: z.union([z.literal('all'), z.array(z.string().regex(/^lc_[0-9a-f]{16}$/)).min(1).max(5000)]),
  body: bodyText,
  imageId: mediaId.nullable().optional(),
  imageIds: imageIds.optional(),
  fileIds: fileIds.optional(),
  publicDays: publicDays.optional(),
});
const broadcastSendBody = z.strictObject({ consentId: z.string().regex(/^[A-Za-z0-9_-]{43}$/), operationId: z.uuid(), body: bodyText });
const lineGrantBody = z.strictObject({
  userId: shortId,
  accountId: shortId,
  level: z.enum(['none', 'read', 'edit']),
  reply: z.boolean(),
  expectedVersion: version,
});
const scriptBody = z.strictObject({ next: z.array(z.enum(MOCK_PUSH_OUTCOMES)).max(5) });
// eslint-disable-next-line no-control-regex
const department = z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f・]+$/);
const committeeGrantBody = z
  .strictObject({ userId: shortId.optional(), department: department.optional(), mailboxId: shortId, edit: z.boolean().optional(), send: z.boolean().optional() })
  .refine((b) => (b.edit === undefined) !== (b.send === undefined), { message: 'edit か send のどちらか 1 つを指定してください' })
  .refine((b) => (b.userId === undefined) !== (b.department === undefined), { message: 'userId か department のどちらか 1 つを指定してください' });

export interface LineRoutesHandle {
  busy: () => boolean;
  reset: (now: string) => void;
  /** Removes expired images (7 days) and stray files; the committee calls it every hour. */
  sweepMedia: () => void;
}

const RESULT_NOT_SAVED = '送信要求の結果を保存できませんでした。結果不明として扱います。再試行は同じ再送キーを使うため二重には送られません。';

export function registerLineRoutes(app: FastifyInstance, ctx: LineRouteContext): LineRoutesHandle {
  const { line, mail, clock, parse, requireUser } = ctx;
  const store = line.store;
  // Intents whose connector call is running in this process.
  const inFlight = new Set<string>();
  const imageBaseUrl = ctx.committee?.media ? (ctx.committee.imageBaseUrl ?? null) : null;
  const attachmentFiles = imageBaseUrl ? (ctx.committee?.files ?? null) : null;
  const sendContext = (via: SendContext['via'] = 'app'): SendContext => ({ imageBaseUrl, filesEnabled: attachmentFiles !== null, via });

  const view = (user: User, intentId: string) => getOutbox(store.current, mail.current, user, intentId, clock(), inFlight.has(intentId));

  /**
   * Calls the connector for an attempt that is already persisted, then records the result. The same for the
   * screen and for Discord (contract C): `saved: false` when the result could not be stored (shown as unknown).
   */
  async function attempt(user: User, intentId: string, attemptNo: number): Promise<{ saved: true; outbox: OutboxView } | { saved: false; intentId: string }> {
    const intent = store.current.outbox.find((o) => o.id === intentId);
    if (!intent) throw new DomainError('not_found', '対象が見つからないか、閲覧権限がありません。');
    inFlight.add(intentId);
    try {
      let result: LinePushOutcome;
      try {
        result = await line.connector.push(pushRequestOf(intent));
      } catch {
        result = { kind: 'unknown', reason: 'server_error' };
      }
      try {
        store.transact((s) => recordAttempt(s, intentId, attemptNo, result, clock()));
      } catch {
        // The intent stays persisted as pending (shown as unknown); only an explicit
        // retry with the same retry key is possible, which the platform deduplicates.
        return { saved: false, intentId };
      }
    } finally {
      inFlight.delete(intentId);
    }
    return { saved: true, outbox: view(user, intentId) };
  }

  async function runAttempt(user: User, intentId: string, attemptNo: number, reply: FastifyReply): Promise<LineSendResponse | FastifyReply> {
    const r = await attempt(user, intentId, attemptNo);
    if (!r.saved) return reply.code(503).send({ error: 'result_not_saved', message: RESULT_NOT_SAVED, details: { intentId } } satisfies ApiError);
    return { replayed: false, outbox: r.outbox };
  }

  app.get('/api/line/accounts', async (request) => {
    const user = requireUser(request);
    return store.read((s) => lineAccountSummaries(s, user));
  });

  app.get('/api/line/conversations/:conversationId', async (request) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    return lineConversationDetail(store.current, mail.current, user, conversationId, clock(), inFlight, imageBaseUrl !== null, line.inboundImages !== undefined, attachmentFiles !== null);
  });

  // A received image, for those who may read the conversation (never public; see inbound-media.ts).
  app.get('/api/line/conversations/:conversationId/messages/:messageId/image', async (request, reply) => {
    const user = requireUser(request);
    const { conversationId, messageId } = parse(messageParams, request.params);
    const conv = readableConversation(store.current, user, conversationId);
    const message = store.current.messages.find((m) => m.id === messageId && m.conversationId === conv.id);
    const image = message && isInboundImage(message) && line.inboundImages ? await line.inboundImages.get(message.externalMessageId) : null;
    if (!image) throw new DomainError('not_found', '画像を取得できませんでした（受け取った側に残っていないか、画像ではありません）。');
    return reply
      .header('Content-Type', image.type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .send(image.data);
  });

  app.get('/api/line/conversations/:conversationId/assignees', async (request) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    return lineAssigneeCandidates(store.current, mail.current, user, conversationId);
  });

  app.patch('/api/line/conversations/:conversationId/triage', async (request) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    const body = parse(triageBody, request.body);
    return store.transact((s) => updateLineTriage(s, mail.current, user, conversationId, body, clock()));
  });

  app.post('/api/line/conversations/:conversationId/notes', async (request, reply) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    const { body } = parse(noteBody, request.body);
    return reply.code(201).send(store.transact((s) => addLineNote(s, user, conversationId, body, clock())));
  });

  app.put('/api/line/conversations/:conversationId/reply/draft', async (request) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    const body = parse(draftBodyWithImage, request.body);
    return store.transact((s) => saveDraft(s, user, conversationId, body, clock(), sendContext()));
  });

  app.delete('/api/line/conversations/:conversationId/reply/draft', async (request) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    store.transact((s) => discardDraft(s, user, conversationId));
    return { ok: true };
  });

  app.post('/api/line/conversations/:conversationId/reply/preview', async (request) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    const body = parse(previewBody, request.body);
    const quota = ctx.committee ? await observeBeforePreview(user, conversationId) : null;
    return store.transact((s) => previewReply(s, user, conversationId, body, clock(), quota, sendContext()));
  });

  app.post('/api/line/conversations/:conversationId/reply/send', async (request, reply) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    const body = parse(sendBody, request.body);
    // Persist the immutable intent first. If this throws (validation or save failure), nothing is sent.
    const started = store.transact((s) => beginSend(s, user, conversationId, body, clock(), sendContext()));
    if (started.replay) return { replayed: true, outbox: view(user, started.intentId) } satisfies LineSendResponse;
    return runAttempt(user, started.intentId, started.attemptNo, reply);
  });

  app.get('/api/line/outbox/:intentId', async (request) => {
    const user = requireUser(request);
    const { intentId } = parse(intentParams, request.params);
    return view(user, intentId);
  });

  app.post('/api/line/outbox/:intentId/retry', async (request, reply) => {
    const user = requireUser(request);
    const { intentId } = parse(intentParams, request.params);
    const { expectedAttempts } = parse(retryBody, request.body);
    const started = store.transact((s) => beginRetry(s, user, intentId, expectedAttempts, clock(), inFlight.has(intentId)));
    if (started.kind === 'blocked') throw new DomainError('conflict', started.message, { outbox: view(user, intentId) });
    return runAttempt(user, started.intentId, started.attemptNo, reply);
  });

  // ---- broadcast (2026-11-02): several 1:1 conversations at once, through multicast

  /** LINE's own count of the month, read just before a confirmation (live push only). */
  async function lineQuota(accountId: string): Promise<PreviewQuota | null> {
    const account = store.current.accounts.find((a) => a.id === accountId);
    if (line.connector.kind !== 'messaging_api' || account?.outbound !== 'push') return null;
    return (await line.connector.quota?.()) ?? null;
  }

  app.get('/api/line/accounts/:accountId/broadcast', async (request) => {
    const user = requireUser(request);
    const { accountId } = parse(accountParams, request.params);
    return broadcastOptions(store.current, user, accountId, Date.parse(clock()), sendContext());
  });

  app.post('/api/line/accounts/:accountId/broadcast/preview', async (request) => {
    const user = requireUser(request);
    const { accountId } = parse(accountParams, request.params);
    const body = parse(broadcastPreviewBody, request.body);
    if (!line.connector.multicast) throw new DomainError('validation', 'このサーバーでは一斉送信ができません。');
    // Permission first (nothing is asked of LINE for someone who may not send), then LINE's count.
    broadcastOptions(store.current, user, accountId, Date.parse(clock()), sendContext());
    const quota = await lineQuota(accountId);
    return store.transact((s) => previewBroadcast(s, user, accountId, body, clock(), quota, sendContext()));
  });

  app.post('/api/line/broadcast/send', async (request, reply) => {
    const user = requireUser(request);
    const body = parse(broadcastSendBody, request.body);
    const multicast = line.connector.multicast?.bind(line.connector);
    if (!multicast) throw new DomainError('validation', 'このサーバーでは一斉送信ができません。');
    // LINE's count again: a broadcast is many messages, and the admin screen or the Bot may have sent meanwhile.
    const pending = (store.current.broadcastConsents ?? []).find((c) => c.tokenHash === sha256(body.consentId) && c.actorId === user.id && c.consumedByBroadcastId === null);
    if (pending) checkLineQuota(await lineQuota(pending.accountId), pending.conversationIds.length);
    const started = store.transact((s) => beginBroadcast(s, user, body, clock(), sendContext()));
    const b = store.current.broadcasts!.find((x) => x.id === started.broadcastId)!;
    let saved = true;
    for (const r of started.requests) {
      for (const id of r.intentIds) inFlight.add(id);
      try {
        let result: LinePushOutcome;
        try {
          const images = b.images ?? (b.image ? [b.image] : []);
          result = await multicast({ retryKey: r.retryKey, accountId: b.accountId, to: r.to, text: b.body, ...(images.length > 0 ? { images: images.map((i) => ({ originalUrl: i.originalUrl, previewUrl: i.previewUrl })) } : {}) });
        } catch {
          result = { kind: 'unknown', reason: 'server_error' };
        }
        try {
          store.transact((s) => recordBroadcastAttempt(s, r.intentIds, result, clock()));
        } catch {
          saved = false;
        }
      } finally {
        for (const id of r.intentIds) inFlight.delete(id);
      }
    }
    const summary = broadcastSummary(store.current, started.broadcastId, inFlight);
    if (!saved) return reply.code(503).send({ error: 'result_not_saved', message: RESULT_NOT_SAVED, details: { broadcastId: started.broadcastId } } satisfies ApiError);
    const parts = (Object.entries(summary.statuses) as [keyof typeof summary.statuses, number][]).filter(([, n]) => n > 0);
    const label = { pending: '処理中', accepted: '受付済み', failed: '失敗', unknown: '結果不明', manual_review: '要確認' } as const;
    return {
      broadcastId: started.broadcastId,
      replayed: started.replay,
      count: summary.count,
      statuses: summary.statuses,
      message: `${summary.count} 人への一斉送信：${parts.map(([k, n]) => `${label[k]} ${n} 人`).join('・')}。「受付済み」は LINE が受け付けたという意味で、届いた・読まれたの意味ではありません。`,
    } satisfies BroadcastSendResponse;
  });

  // ---- images (2026-11-02): uploaded by a sender, public without sign-in for 7 days under a random name

  const mediaFiles = ctx.committee?.media ?? null;
  function sweepMedia(): void {
    sweepFiles();
    if (!mediaFiles) return;
    const nowMs = Date.parse(clock());
    let gone: string[] = [];
    if ((store.current.media ?? []).some((m) => mediaExpired(m, nowMs))) {
      try {
        gone = store.transact((s) => expireMedia(s, nowMs));
      } catch {
        return;
      }
    }
    mediaFiles.remove(gone);
    mediaFiles.sweep(new Set((store.current.media ?? []).flatMap((m) => [m.original.file, m.preview.file])), nowMs);
  }

  // ---- files (2026-11-10): sent as links in the text; answered without sign-in only after a send, until its date
  function sweepFiles(): void {
    if (!attachmentFiles) return;
    const nowMs = Date.parse(clock());
    let gone: string[] = [];
    if ((store.current.attachments ?? []).some((a) => attachmentGone(a, nowMs))) {
      try {
        gone = store.transact((s) => expireAttachments(s, nowMs));
      } catch {
        return;
      }
    }
    attachmentFiles.remove(gone);
    attachmentFiles.sweep(new Set((store.current.attachments ?? []).map((a) => a.file)), nowMs);
  }

  if (attachmentFiles) {
    const files = attachmentFiles;
    void app.register(async (scope) => {
      await scope.register(multipart, { limits: { fileSize: FILE_MAX_BYTES, files: 1, fields: 1, fieldSize: 100, parts: 2 } });
      // One file ("file") and the account ("accountId").
      scope.post('/api/line/files', { bodyLimit: FILE_MAX_BYTES + 1024 * 1024 }, async (request, reply) => {
        const user = requireUser(request);
        if (!request.isMultipart()) throw new DomainError('validation', 'multipart/form-data 形式で送信してください。');
        let accountId: string | null = null;
        let upload: { name: string; data: Buffer } | null = null;
        try {
          for await (const part of request.parts()) {
            if (part.type === 'field' && part.fieldname === 'accountId' && typeof part.value === 'string') accountId = part.value;
            else if (part.type === 'file' && part.fieldname === 'file' && !upload) upload = { name: part.filename ?? '', data: await part.toBuffer() };
            else if (part.type === 'file') await part.toBuffer();
          }
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
            throw new DomainError('validation', `ファイルが大きすぎます（${Math.round(FILE_MAX_BYTES / 1024 / 1024)} MB まで）。`, { field: 'file' });
          }
          throw new DomainError('validation', 'ファイルを読み取れませんでした。もう一度選んでください。', { field: 'file' });
        }
        const account = parse(shortId, accountId);
        // The sender's right first, so a stranger cannot fill the disk; the file is kept only after the checks.
        checkFileUploader(store.current, user, account, Date.parse(clock()), upload?.data.length ?? 0);
        const stored = storeAttachment(files, upload?.data ?? Buffer.alloc(0), upload?.name ?? '');
        let attachment;
        try {
          attachment = store.transact((s) => registerAttachment(s, user, account, stored, clock()));
        } catch (err) {
          files.remove([stored.file]);
          throw err;
        }
        return reply.code(201).send({ ...fileView(attachment), expiresAt: attachment.keepUntil } satisfies LineFileResponse);
      });
    });

    // Public: the people the message went to open the link with no sign-in. The name is the secret; the link
    // answers only after the file was sent and until the date the sender chose. Always a download in a sandbox.
    app.get(`${FILES_PATH}/:file`, async (request, reply) => {
      const parsed = fileParams.safeParse(request.params);
      const notFoundReply = () => reply.code(404).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Not Found');
      if (!parsed.success) return notFoundReply();
      const attachment = attachmentOfFile(store.current, parsed.data.file);
      const nowMs = Date.parse(clock());
      if (!attachment || !attachmentPublic(attachment, nowMs)) {
        if (attachment && attachmentGone(attachment, nowMs)) sweepFiles();
        return notFoundReply();
      }
      const data = files.read(attachment.file);
      if (!data) return notFoundReply();
      const left = Math.max(0, Math.floor((Date.parse(attachment.sentUntil!) - nowMs) / 1000));
      return reply
        .header('Content-Type', attachment.type)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', attachmentDisposition(attachment.name, `file.${attachment.file.split('.').pop()}`))
        .header('Cache-Control', `private, max-age=${Math.min(left, 3600)}`)
        .header('X-Robots-Tag', 'noindex, nofollow')
        .header('Referrer-Policy', 'no-referrer')
        .send(data);
    });
  }

  if (mediaFiles && imageBaseUrl) {
    const files = mediaFiles;
    void app.register(async (scope) => {
      await scope.register(multipart, { limits: { fileSize: ORIGINAL_MAX_BYTES, files: 2, fields: 1, fieldSize: 100, parts: 3 } });
      // Two files ("original" and "preview") and the account ("accountId").
      scope.post('/api/line/media', { bodyLimit: ORIGINAL_MAX_BYTES + 2 * 1024 * 1024 }, async (request, reply) => {
        const user = requireUser(request);
        if (!request.isMultipart()) throw new DomainError('validation', 'multipart/form-data 形式で送信してください。');
        let accountId: string | null = null;
        const parts: Record<string, Buffer> = {};
        try {
          for await (const part of request.parts()) {
            if (part.type === 'field' && part.fieldname === 'accountId' && typeof part.value === 'string') accountId = part.value;
            else if (part.type === 'file' && (part.fieldname === 'original' || part.fieldname === 'preview') && !parts[part.fieldname]) {
              parts[part.fieldname] = await part.toBuffer();
            } else if (part.type === 'file') {
              await part.toBuffer();
            }
          }
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') throw new DomainError('validation', '画像が大きすぎます（原寸 10 MB・プレビュー 1 MB まで）。', { field: 'image' });
          throw new DomainError('validation', '画像を読み取れませんでした。もう一度選んでください。', { field: 'image' });
        }
        const account = parse(shortId, accountId);
        // The sender's right first, so a stranger cannot fill the disk; the files are kept only after the checks.
        checkUploader(store.current, user, account, Date.parse(clock()));
        const stored = storeUpload(files, parts.original ?? Buffer.alloc(0), parts.preview ?? Buffer.alloc(0));
        let media;
        try {
          media = store.transact((s) => registerMedia(s, user, account, stored, clock()));
        } catch (err) {
          files.remove([stored.original.file, stored.preview.file]);
          throw err;
        }
        return reply.code(201).send({ id: media.id, previewUrl: `${MEDIA_PATH}/${media.preview.file}`, expiresAt: mediaExpiresAt(media) } satisfies LineMediaResponse);
      });
    });

    // Public: LINE's servers fetch the files with no sign-in. The name is the secret; the type is the checked one.
    app.get(`${MEDIA_PATH}/:file`, async (request, reply) => {
      const parsed = mediaParams.safeParse(request.params);
      const notFoundReply = () => reply.code(404).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Not Found');
      if (!parsed.success) return notFoundReply();
      const media = mediaOfFile(store.current, parsed.data.file);
      const nowMs = Date.parse(clock());
      if (!media) return notFoundReply();
      if (mediaExpired(media, nowMs)) {
        sweepMedia();
        return notFoundReply();
      }
      const entry = media.original.file === parsed.data.file ? media.original : media.preview;
      const data = files.read(entry.file);
      if (!data) return notFoundReply();
      const left = Math.max(0, Math.floor((Date.parse(mediaExpiresAt(media)) - nowMs) / 1000));
      return reply
        .header('Content-Type', entry.type)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', `public, max-age=${Math.min(left, 86_400)}, immutable`)
        .header('Content-Disposition', 'inline')
        .send(data);
    });
  }

  // ---- Discord (contract C): the Bot's internal routes, the same draft/confirm/send as the screen
  if (ctx.committee?.discord) {
    registerDiscordLineRoutes(app, {
      options: ctx.committee.discord,
      store,
      clock,
      sendContext: () => sendContext('discord'),
      observeBeforePreview: (user, conversationId) => observeBeforePreview(user, conversationId),
      attempt,
    });
  }

  /**
   * LINE's own facts just before a preview: whether the account is in the group and how many members it has (the
   * message counts once per member), whether a 1:1 user not known as a friend blocked the account, and this month's
   * messages. Asked only for someone who may send here.
   */
  async function observeBeforePreview(user: User, conversationId: string): Promise<PreviewQuota | null> {
    const conv = replyableConversation(store.current, user, conversationId);
    const account = store.current.accounts.find((a) => a.id === conv.accountId);
    const connector = line.connector;
    if (connector.kind !== 'messaging_api' || account?.outbound !== 'push') return null;
    if (conv.target.kind === 'messaging_api' && conv.target.type !== 'user' && account.allowGroups !== false && connector.memberCount) {
      const count = await connector.memberCount({ type: conv.target.type, id: conv.target.id });
      if (count !== null) store.transact((s) => observeMemberCount(s, conv.id, count, clock()));
    }
    // A 1:1 user who is not a known friend nor a recent sender: ask LINE whether they blocked the account.
    if (conv.target.kind === 'messaging_api' && conv.target.type === 'user' && connector.profileReachable) {
      const check = evaluateTarget(store.current, conv, Date.parse(clock()));
      if (check.ok && check.unconfirmed) {
        const reachable = await connector.profileReachable(conv.target.id);
        if (reachable !== null) store.transact((s) => observeProfile(s, conv.id, reachable, clock()));
      }
    }
    return (await connector.quota?.()) ?? null;
  }

  // ---- administration (grants and audit; never conversation contents)
  if (ctx.committee) {
    const committee = ctx.committee;
    app.get('/api/line/admin/access', async (request) => {
      const user = requireUser(request);
      return lineCommitteeAccess(store.current, committee.people(), user);
    });
    app.put('/api/line/admin/access', async (request) => {
      const user = requireUser(request);
      const body = parse(committeeGrantBody, request.body);
      const kind = body.send !== undefined ? 'send' : 'edit';
      const change = { userId: body.userId, department: body.department, accountId: body.mailboxId, kind, on: (body.send ?? body.edit)! } as const;
      return store.transact((s) => setLineCommitteeGrant(s, committee.people(), user, change, clock()));
    });
  } else {
    app.get('/api/admin/line/access', async (request) => {
      const user = requireUser(request);
      return lineAccessMatrix(store.current, mail.current, user);
    });

    app.put('/api/admin/line/access', async (request) => {
      const user = requireUser(request);
      const body = parse(lineGrantBody, request.body);
      return store.transact((s) => setLineGrant(s, mail.current, user, body, clock()));
    });

    app.get('/api/admin/line/audit', async (request) => {
      const user = requireUser(request);
      return lineAuditLog(store.current, mail.current, user);
    });
  }

  // ---- demo-only synthetic controls. Never registered outside demo persona mode,
  // and never a receiver: the release applies fixture batches from the repository only.
  if (ctx.demo) {
    app.post('/api/demo/line/release', async (request): Promise<{ releasedBatch: number; report: LineIngestReport }> => {
      ctx.requireDemoAdmin(request, 'LINE の模擬イベント取り込み');
      return store.transact((s) => {
        if (s.feed.releasedBatch >= MAX_LINE_BATCH) {
          throw new DomainError('conflict', 'LINE の模擬イベントはすべて取り込み済みです。サンプルをリセットすると最初からやり直せます。');
        }
        const report = releaseLineBatches(s, s.feed.releasedBatch + 1, clock());
        return { releasedBatch: s.feed.releasedBatch, report };
      });
    });

    const mock = line.connector;
    if (mock instanceof MockLinePushConnector) {
      app.get('/api/demo/line/connector', async (request) => {
        ctx.requireDemoAdmin(request, 'LINE 模擬送信の設定');
        return mock.state();
      });
      app.put('/api/demo/line/connector', async (request) => {
        ctx.requireDemoAdmin(request, 'LINE 模擬送信の設定');
        const { next } = parse(scriptBody, request.body);
        mock.script(next);
        return mock.state();
      });
    }
  }

  return {
    busy: () => inFlight.size > 0,
    reset: (now) => {
      store.replace(line.seed(now));
      if (line.connector instanceof MockLinePushConnector) line.connector.reset();
    },
    sweepMedia,
  };
}
