import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ASK_EFFORTS,
  ASK_FORMATS,
  ASK_MODELS,
  ASSISTANT_LIMITS,
  CANDIDATE_ACTIONS,
  cleanText,
  DOC_FORMATS,
  DOC_TYPES,
  IMAGE_ASPECTS,
  REMINDER_REPEATS,
  type AssistantCandidate,
  type AssistantJob,
  type AssistantJobResult,
} from '../../shared/assistant.js';
import { DomainError, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { TaskIdentityBridge } from '../tasks/bridge.js';
import { ALLOWED_FILE_TYPES, AssistantServiceError, type AssistantAnswer, type AssistantServiceClient } from './client.js';

// Browser API of the Bot tab (contract §4). Identity comes only from the server-verified session; the
// task bridge maps it to the Discord actor (discord-<ID>); the Bot host decides committee membership
// (403 FORBIDDEN). Input is checked here with the contract's limits before anything leaves the server.
// The Bot host's file URLs are never passed on: every file link is rebuilt from the job ID and file name.

export interface AssistantRuntime {
  client: AssistantServiceClient;
  bridge: TaskIdentityBridge;
}

export interface AssistantRouteContext {
  assistant: AssistantRuntime | null;
  /** From the mailbox settings (draftBccAddress); sent with the meta so the mail screen does not hard-code it. */
  mailDraftBcc: string | null;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
  requireUser: (request: FastifyRequest) => User;
}

const jobId = z.string().regex(/^j_[a-z0-9]{20}$/);
/** The browser's operation ID; the server sends it to the Bot host as `ui-<id>` (its own namespace). */
const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,60}$/);
const numericId = z.string().regex(/^\d{1,12}$/);
const discordId = z.string().regex(/^\d{1,25}$/);
const memberId = z.string().regex(/^discord-\d{1,25}$/);
const fileName = z
  .string()
  .min(1)
  .max(160)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^/\\\u0000-\u001f\u007f"]+$/)
  .refine((name) => name !== '.' && name !== '..');
/** Text as the Bot host reads it: control characters removed and surrounding spaces trimmed, then the length. */
const text = (max: number, min = 1) => z.string().max(max * 4).transform(cleanText).pipe(z.string().min(min).max(max));

const askInput = z.strictObject({
  question: text(ASSISTANT_LIMITS.questionMax),
  model: z.enum(ASK_MODELS).optional(),
  effort: z.enum(ASK_EFFORTS).optional(),
  tone: text(ASSISTANT_LIMITS.toneMax, 0).optional(),
  format: z.enum(ASK_FORMATS).nullable().optional(),
});
const docInput = z.strictObject({
  docType: z.enum(DOC_TYPES),
  content: text(ASSISTANT_LIMITS.docContentMax),
  format: z.enum(DOC_FORMATS),
  useSources: z.boolean(),
  model: z.enum(ASK_MODELS).optional(),
});
const imageInput = z.strictObject({
  prompt: text(ASSISTANT_LIMITS.imagePromptMax),
  aspect: z.enum(IMAGE_ASPECTS).optional(),
});
const jobBody = z.discriminatedUnion('kind', [
  z.strictObject({ clientOperationId: operationId, kind: z.literal('ask'), input: askInput }),
  z.strictObject({ clientOperationId: operationId, kind: z.literal('doc'), input: docInput }),
  z.strictObject({ clientOperationId: operationId, kind: z.literal('image'), input: imageInput }),
]);
const reminderBody = z.strictObject({
  clientOperationId: operationId,
  text: text(ASSISTANT_LIMITS.reminderTextMax),
  due: text(64),
  targetId: memberId.optional(),
  repeat: z.enum(REMINDER_REPEATS).optional(),
  channelId: discordId.optional(),
});
const operationOnly = z.strictObject({ clientOperationId: operationId });
const candidatePlainBody = z.strictObject({ clientOperationId: operationId, comment: text(ASSISTANT_LIMITS.returnCommentMax, 0).optional() });
const candidateReturnBody = z.strictObject({ clientOperationId: operationId, comment: text(ASSISTANT_LIMITS.returnCommentMax) });
const jobsQuery = z.strictObject({
  kind: z.enum(['ask', 'doc', 'image']).optional(),
  mine: z.enum(['0', '1']).optional(),
  limit: z.string().regex(/^\d{1,2}$/).optional(),
  before: jobId.optional(),
});
const similarQuery = z.strictObject({ q: text(ASSISTANT_LIMITS.questionMax) });
const remindersQuery = z.strictObject({ scope: z.enum(['mine', 'all']).optional() });
const candidatesQuery = z.strictObject({ state: z.enum(['open', 'recent']).optional() });

const DISCORD_LINK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/[0-9a-zA-Z@/]{1,120}$/;

const UNAVAILABLE = () => new HttpError(503, { error: 'ASSISTANT_UNAVAILABLE', message: 'Bot に接続できません。しばらくしてから再試行してください。' });

/** Maps a Bot-host failure to a safe answer. 4xx with the Bot's own code and message passes; everything else is unavailable. */
function toHttp(err: unknown): never {
  if (err instanceof AssistantServiceError) {
    if (err.kind === 'definitive' && err.body) {
      throw new HttpError(err.status, { error: err.body.code, message: err.body.message, ...(err.body.details !== undefined ? { details: err.body.details } : {}) });
    }
    if (err.kind === 'rejected' && err.body) throw new HttpError(502, { error: err.body.code, message: err.body.message });
    throw UNAVAILABLE();
  }
  throw err;
}

/** The browser's link to a Discord message: only https links to Discord pass. */
export function safeDiscordUrl(value: string | null): string | null {
  return value !== null && DISCORD_LINK.test(value) ? value : null;
}

/** Keeps only files of an allowed type, with the browser URL rebuilt from the job ID and the file name. */
export function browserResult(job: AssistantJob): AssistantJobResult | null {
  if (!job.result) return null;
  const files = job.result.files
    .map((file) => {
      const mime = ALLOWED_FILE_TYPES[String(file.mime).split(';')[0]!.trim().toLowerCase()];
      if (!mime || !fileName.safeParse(file.name).success) return null;
      return { name: file.name, mime, size: file.size, url: `/api/assistant/files/${encodeURIComponent(job.id)}/${encodeURIComponent(file.name)}` };
    })
    .filter((file): file is NonNullable<typeof file> => file !== null);
  return { ...job.result, files };
}

/** A job as the browser may see it. */
export function browserJob(job: AssistantJob): AssistantJob {
  return { ...job, result: browserResult(job), discordUrl: safeDiscordUrl(job.discordUrl) };
}

function browserCandidate(candidate: AssistantCandidate): AssistantCandidate {
  return { ...candidate, discordUrl: safeDiscordUrl(candidate.discordUrl) };
}

/** Content-Disposition for a download: an ASCII fallback plus the RFC 5987 name. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function registerAssistantRoutes(app: FastifyInstance, ctx: AssistantRouteContext): void {
  const { parse, requireUser } = ctx;

  /** Order: sign-in (401), then the feature is on (404), then the person is bound to a Discord actor (403). */
  function actorOf(request: FastifyRequest): { actor: string; rt: AssistantRuntime } {
    const user = requireUser(request);
    if (!ctx.assistant) throw new HttpError(404, { error: 'ASSISTANT_DISABLED', message: 'Bot 機能はこのサーバーでは有効になっていません。' });
    const actor = user.disabled ? null : ctx.assistant.bridge.taskUserFor(user.id);
    if (!actor) throw new DomainError('forbidden', 'Bot 機能を利用する権限がありません。');
    return { actor, rt: ctx.assistant };
  }

  /** Sends a Bot answer that carries a job, with its status (200 done, 202 still working). */
  function sendJob(reply: FastifyReply, answer: AssistantAnswer<{ job: AssistantJob }>) {
    if (!answer.body || typeof answer.body !== 'object' || !answer.body.job) throw UNAVAILABLE();
    return reply.code(answer.status).send({ job: browserJob(answer.body.job) });
  }

  app.get('/api/assistant/meta', async (request) => {
    const { actor, rt } = actorOf(request);
    const meta = await rt.client.meta(actor).catch(toHttp);
    return ctx.mailDraftBcc ? { ...meta, mailBcc: ctx.mailDraftBcc } : meta;
  });

  // One signed request, for the home card.
  app.get('/api/assistant/summary', async (request) => {
    const { actor, rt } = actorOf(request);
    return rt.client.summary(actor).catch(toHttp);
  });

  app.get('/api/assistant/members', async (request) => {
    const { actor, rt } = actorOf(request);
    return rt.client.members(actor).catch(toHttp);
  });

  app.post('/api/assistant/jobs', async (request, reply) => {
    const { actor, rt } = actorOf(request);
    const body = parse(jobBody, request.body);
    const answer = await rt.client
      .createJob(actor, { clientOperationId: `ui-${body.clientOperationId}`, kind: body.kind, input: body.input })
      .catch(toHttp);
    return sendJob(reply, answer);
  });

  app.get('/api/assistant/jobs/:jobId', async (request) => {
    const { actor, rt } = actorOf(request);
    const { jobId: id } = parse(z.strictObject({ jobId }), request.params);
    const answer = await rt.client.getJob(actor, id).catch(toHttp);
    return { job: browserJob(answer.body.job) };
  });

  app.get('/api/assistant/jobs', async (request) => {
    const { actor, rt } = actorOf(request);
    const query = parse(jobsQuery, request.query);
    const page = await rt.client.listJobs(actor, { kind: query.kind, mine: query.mine, limit: query.limit, before: query.before }).catch(toHttp);
    return { jobs: page.jobs.map(browserJob), next: page.next };
  });

  app.get('/api/assistant/similar', async (request) => {
    const { actor, rt } = actorOf(request);
    const query = parse(similarQuery, request.query);
    const found = await rt.client.similar(actor, query.q).catch(toHttp);
    return { jobs: found.jobs.map((entry) => ({ job: browserJob(entry.job), score: entry.score })) };
  });

  app.post('/api/assistant/jobs/:jobId/cancel', async (request) => {
    const { actor, rt } = actorOf(request);
    const { jobId: id } = parse(z.strictObject({ jobId }), request.params);
    parse(z.strictObject({}), request.body);
    const job = await rt.client.cancelJob(actor, id).catch(toHttp);
    return { job: browserJob(job.job) };
  });

  app.get('/api/assistant/files/:jobId/:name', async (request, reply) => {
    const { actor, rt } = actorOf(request);
    const { jobId: id, name } = parse(z.strictObject({ jobId, name: fileName }), request.params);
    const file = await rt.client.file(actor, id, name).catch(toHttp);
    reply.header('Content-Type', file.mime);
    reply.header('Content-Disposition', attachmentDisposition(name));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(file.body);
  });

  app.get('/api/assistant/reminders', async (request) => {
    const { actor, rt } = actorOf(request);
    const query = parse(remindersQuery, request.query);
    return rt.client.reminders(actor, query.scope ?? 'mine').catch(toHttp);
  });

  app.post('/api/assistant/reminders', async (request, reply) => {
    const { actor, rt } = actorOf(request);
    const body = parse(reminderBody, request.body);
    const answer = await rt.client
      .createReminder(actor, {
        clientOperationId: `ui-${body.clientOperationId}`,
        text: body.text,
        due: body.due,
        ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
        ...(body.repeat !== undefined ? { repeat: body.repeat } : {}),
        ...(body.channelId !== undefined ? { channelId: body.channelId } : {}),
      })
      .catch(toHttp);
    return sendJob(reply, answer);
  });

  for (const action of ['done', 'delete'] as const) {
    app.post(`/api/assistant/reminders/:reminderId/${action}`, async (request, reply) => {
      const { actor, rt } = actorOf(request);
      const { reminderId } = parse(z.strictObject({ reminderId: numericId }), request.params);
      const body = parse(operationOnly, request.body);
      const answer = await rt.client.reminderAction(actor, reminderId, action, { clientOperationId: `ui-${body.clientOperationId}` }).catch(toHttp);
      return sendJob(reply, answer);
    });
  }

  app.get('/api/assistant/candidates', async (request) => {
    const { actor, rt } = actorOf(request);
    const query = parse(candidatesQuery, request.query);
    const found = await rt.client.candidates(actor, query.state ?? 'open').catch(toHttp);
    return { candidates: found.candidates.map(browserCandidate) };
  });

  app.post('/api/assistant/candidates/:candidateId/:action', async (request, reply) => {
    const { actor, rt } = actorOf(request);
    const params = parse(z.strictObject({ candidateId: numericId, action: z.enum(CANDIDATE_ACTIONS) }), request.params);
    // Returning a candidate needs the comment that the task owner reads; the other actions take none.
    const body =
      params.action === 'return'
        ? parse(candidateReturnBody, request.body)
        : parse(candidatePlainBody, request.body);
    const answer = await rt.client
      .candidateAction(actor, params.candidateId, params.action, {
        clientOperationId: `ui-${body.clientOperationId}`,
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
      })
      .catch(toHttp);
    return sendJob(reply, answer);
  });
}
