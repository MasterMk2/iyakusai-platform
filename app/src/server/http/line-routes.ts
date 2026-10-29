import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HANDLING_STATUSES, LIMITS, type ApiError } from '../../shared/api.js';
import { MOCK_PUSH_OUTCOMES, type LineIngestReport, type LineSendResponse } from '../../shared/line.js';
import { DomainError, type User } from '../domain/types.js';
import { replyableConversation } from '../line/access.js';
import { lineCommitteeAccess, setLineCommitteeGrant } from '../line/committee.js';
import { MockLinePushConnector, type LinePushConnector, type LinePushOutcome } from '../line/connector.js';
import { MAX_LINE_BATCH } from '../line/fixtures.js';
import { lineAccountSummaries, lineConversationDetail, type LinePeople } from '../line/queries.js';
import { beginRetry, beginSend, discardDraft, observeMemberCount, previewReply, pushRequestOf, recordAttempt, saveDraft, type PreviewQuota } from '../line/reply.js';
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
  committee?: { people: () => User[] };
}

const convParams = z.strictObject({ conversationId: z.string().regex(/^lc_[0-9a-f]{16}$/) });
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
const draftBody = z.strictObject({ body: bodyText, expectedVersion: version.nullable() });
const previewBody = z.strictObject({ draftId, draftVersion: version });
// No recipient, method or "confirmed" flag is accepted from the client: strict schemas reject them.
const sendBody = z.strictObject({
  consentId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  operationId: z.uuid(),
  draftId,
  draftVersion: version,
  body: bodyText,
});
const retryBody = z.strictObject({ expectedAttempts: z.number().int().min(1).max(100) });
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

export function registerLineRoutes(app: FastifyInstance, ctx: LineRouteContext): { busy: () => boolean; reset: (now: string) => void } {
  const { line, mail, clock, parse, requireUser } = ctx;
  const store = line.store;
  // Intents whose connector call is running in this process.
  const inFlight = new Set<string>();

  const view = (user: User, intentId: string) => getOutbox(store.current, mail.current, user, intentId, clock(), inFlight.has(intentId));

  /** Calls the connector for an attempt that is already persisted, then records the result. */
  async function runAttempt(user: User, intentId: string, attemptNo: number, reply: FastifyReply): Promise<LineSendResponse | FastifyReply> {
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
        inFlight.delete(intentId);
        return reply.code(503).send({
          error: 'result_not_saved',
          message: '送信要求の結果を保存できませんでした。結果不明として扱います。再試行は同じ再送キーを使うため二重には送られません。',
          details: { intentId },
        } satisfies ApiError);
      }
    } finally {
      inFlight.delete(intentId);
    }
    return { replayed: false, outbox: view(user, intentId) };
  }

  app.get('/api/line/accounts', async (request) => {
    const user = requireUser(request);
    return store.read((s) => lineAccountSummaries(s, user));
  });

  app.get('/api/line/conversations/:conversationId', async (request) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    return lineConversationDetail(store.current, mail.current, user, conversationId, clock(), inFlight);
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
    const body = parse(draftBody, request.body);
    return store.transact((s) => saveDraft(s, user, conversationId, body, clock()));
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
    return store.transact((s) => previewReply(s, user, conversationId, body, clock(), quota));
  });

  app.post('/api/line/conversations/:conversationId/reply/send', async (request, reply) => {
    const user = requireUser(request);
    const { conversationId } = parse(convParams, request.params);
    const body = parse(sendBody, request.body);
    // Persist the immutable intent first. If this throws (validation or save failure), nothing is sent.
    const started = store.transact((s) => beginSend(s, user, conversationId, body, clock()));
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

  /**
   * LINE's own facts just before a preview: whether the account is in the group and how many members it has (the
   * message counts once per member), and this month's messages. Asked only for someone who may send here.
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
  };
}
