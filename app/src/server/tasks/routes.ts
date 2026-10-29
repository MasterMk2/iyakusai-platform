import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  departmentKey,
  REQUIREMENT_FIELDS,
  TASK_LIMITS,
  TASK_STATUSES,
  type CaseKind,
  type CaseTaskFields,
  type CaseTaskResponse,
  type CaseTasksResponse,
  type TaskContextResponse,
  type TaskDetailResponse,
  type TaskHistoryEntry,
  type TaskMutationResponse,
  type TaskProvenance,
  type TaskView,
} from '../../shared/tasks.js';
import { canRead } from '../domain/access.js';
import type { StateStore } from '../domain/store.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { LineRuntime } from '../http/line-routes.js';
import { canReadLine } from '../line/access.js';
import type { TaskIdentityBridge } from './bridge.js';
import { TaskServiceError, type TaskBackend } from './client.js';
import type { CaseTaskOperation, TaskLinkStore } from './links.js';
import type { MailCaseSource } from '../mailbox/routes.js';

// Task gateway for the common Web entry. Identity comes only from the server-verified
// session (requireUser); the bridge maps it to a Task user; the Task service decides
// committee authorization. Source (mail/LINE) ACL is evaluated here, before anything about a
// case or its links is computed, and again on every provenance read.

export interface TaskRuntime {
  client: TaskBackend;
  bridge: TaskIdentityBridge;
  links: TaskLinkStore;
}

export interface TaskRouteContext {
  tasks: TaskRuntime | null;
  mail: StateStore;
  /** The committee mailbox, when it replaces the synthetic inbox. */
  mailCases?: MailCaseSource | null;
  line: LineRuntime | undefined;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
  requireUser: (request: FastifyRequest) => User;
}

const id = z.string().regex(/^[a-z0-9-]{1,64}$/);
const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string().max(TASK_LIMITS.textMax * 2);
const title = z.string().max(TASK_LIMITS.titleMax * 2);
const requirements = z.strictObject(Object.fromEntries(REQUIREMENT_FIELDS.map((f) => [f, text])) as Record<(typeof REQUIREMENT_FIELDS)[number], typeof text>);
const partialRequirements = requirements.partial();

const listQuery = z.strictObject({
  status: z.enum(TASK_STATUSES).optional(),
  assignee: z.union([z.literal('none'), id]).optional(),
  deadline: z.enum(['overdue', 'set', 'none']).optional(),
});
// Department tags (2026-10-14): one or more department keys. The Task service checks they exist.
const tags = z.array(z.string().regex(/^[a-z]{2,16}$/)).min(1).max(TASK_LIMITS.tagsMax);
const helperIds = z.array(id).max(TASK_LIMITS.helpersMax);
const createBody = z.strictObject({
  operationId,
  title,
  description: text.optional(),
  assigneeId: id.nullable().optional(),
  deadline: dateOnly.nullable().optional(),
  requirements: partialRequirements.optional(),
  tags: tags.optional(),
  // Parent tasks (2026-10-25): the Task service checks the parent exists and the one-level rule.
  parentId: id.nullable().optional(),
  // Helpers (2026-10-28): the Task service checks they are members, not the assignee, and only with one.
  helperIds: helperIds.optional(),
});
const changes = z.strictObject({
  title: title.optional(),
  description: text.optional(),
  assigneeId: id.nullable().optional(),
  deadline: dateOnly.nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  tags: tags.optional(),
  parentId: id.nullable().optional(),
  helperIds: helperIds.optional(),
  ...Object.fromEntries(REQUIREMENT_FIELDS.map((f) => [f, text.optional()])),
});
const updateBody = z.strictObject({ expectedVersion: z.number().int().min(1), operationId: operationId.optional(), changes });
const reopenBody = z.strictObject({ expectedVersion: z.number().int().min(1), operationId: operationId.optional() });
const caseParams = z.strictObject({
  kind: z.enum(['mail', 'line']),
  sourceId: z.string().regex(/^(rc|lc)_[0-9a-f]{16}$/),
});
const caseBody = z.strictObject({
  clientOperationId: z.uuid(),
  workspaceId: id,
  title,
  assigneeId: id.nullable(),
  deadline: dateOnly.nullable(),
  requirements,
});

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const UNAVAILABLE = (message = 'タスクサービスに接続できません。しばらくしてから再試行してください。') =>
  new HttpError(503, { error: 'task_service_unavailable', message });

/** Maps a Task-service failure to a safe response. Only Task-owned messages and task data pass through. */
function toHttp(err: unknown): never {
  if (err instanceof TaskServiceError) {
    if (err.kind === 'unavailable' || !err.body) throw UNAVAILABLE();
    const body = err.body;
    throw new HttpError(err.status, {
      error: body.code.toLowerCase(),
      message: body.message,
      ...(body.details ? { details: body.details } : {}),
      ...(body.current ? { current: body.current as never } : {}),
    });
  }
  throw err;
}

function historyView(entries: TaskHistoryEntry[]): TaskHistoryEntry[] {
  return entries.map(({ id: entryId, version, action, actorName, at, source, displayChanges }) => ({ id: entryId, version, action, actorName, at, source, displayChanges }));
}

export function registerTaskRoutes(app: FastifyInstance, ctx: TaskRouteContext): { reset: () => void } {
  const { parse, requireUser, clock } = ctx;
  const inFlight = new Map<string, Promise<unknown>>();

  function runtime(): TaskRuntime {
    if (!ctx.tasks) throw new DomainError('not_found', 'タスク機能はこのサーバーでは設定されていません。');
    return ctx.tasks;
  }

  function taskActor(request: FastifyRequest): { user: User; actor: string; rt: TaskRuntime } {
    const user = requireUser(request);
    const rt = runtime();
    const actor = user.disabled ? null : rt.bridge.taskUserFor(user.id);
    if (!actor) throw new DomainError('forbidden', 'タスク機能を利用する権限がありません。');
    return { user, actor, rt };
  }

  /** Current source ACL. Unknown and unpermitted sources are the same 404. */
  function sourceReadable(user: User, kind: CaseKind, sourceId: string): boolean {
    if (user.disabled) return false;
    if (kind === 'mail' && ctx.mailCases) return ctx.mailCases.readable(user, sourceId);
    if (kind === 'mail') {
      const receipt = ctx.mail.current.receipts.find((r) => r.id === sourceId);
      return !!receipt && canRead(ctx.mail.current, user.id, receipt.mailboxId);
    }
    const line = ctx.line?.store.current;
    const conv = line?.conversations.find((c) => c.id === sourceId);
    return !!line && !!conv && canReadLine(line, user, conv.accountId);
  }

  function provenanceFor(user: User, kind: CaseKind, sourceId: string): TaskProvenance | null {
    if (!sourceReadable(user, kind, sourceId)) return null;
    if (kind === 'mail' && ctx.mailCases) {
      const p = ctx.mailCases.provenance(user, sourceId);
      return p ? { kind, ...p } : null;
    }
    if (kind === 'mail') {
      const state = ctx.mail.current;
      const receipt = state.receipts.find((r) => r.id === sourceId)!;
      const message = state.messages.find((m) => m.id === receipt.messageId);
      return { kind, label: message?.subject || '（件名なし）', href: `#/mailbox/${encodeURIComponent(receipt.mailboxId)}?thread=${encodeURIComponent(receipt.threadId)}` };
    }
    const conv = ctx.line!.store.current.conversations.find((c) => c.id === sourceId)!;
    return { kind, label: conv.title, href: `#/line/${encodeURIComponent(conv.accountId)}?conv=${encodeURIComponent(conv.id)}` };
  }

  // ---- context and plain task operations

  app.get('/api/tasks/context', async (request): Promise<TaskContextResponse> => {
    const user = requireUser(request);
    if (!ctx.tasks) return { enabled: false, bound: false, memberships: [] };
    const actor = user.disabled ? null : ctx.tasks.bridge.taskUserFor(user.id);
    if (!actor) return { enabled: true, bound: false, memberships: [] };
    const me = await ctx.tasks.client.me(actor).catch(toHttp);
    // The Bot-host Task API answers with departments as workspaces; only then can tasks be tagged.
    const tagging = me.memberships.length > 0 && me.memberships.every((m) => departmentKey(m.workspace.id) !== null);
    return { enabled: true, bound: true, self: me.user.id, memberships: me.memberships, ...(tagging ? { tagging: true } : {}) };
  });

  // One signed request. Never fan out into a request for each department.
  app.get('/api/tasks/summary', async (request) => {
    const { actor, rt } = taskActor(request);
    return rt.client.summary(actor).catch(toHttp);
  });

  // Every department in one signed request (2026-10-25): the list screen selects several departments
  // and filters this one list, so choosing departments never sends a request per department.
  app.get('/api/tasks/all', async (request): Promise<TaskView[]> => {
    const { actor, rt } = taskActor(request);
    parse(z.strictObject({}), request.query);
    return rt.client.listAllTasks(actor).catch(toHttp);
  });

  app.get('/api/tasks/workspaces/:workspaceId/tasks', async (request): Promise<TaskView[]> => {
    const { actor, rt } = taskActor(request);
    const { workspaceId } = parse(z.strictObject({ workspaceId: id }), request.params);
    const query = parse(listQuery, request.query);
    return rt.client.listTasks(actor, workspaceId, query).catch(toHttp);
  });

  app.get('/api/tasks/workspaces/:workspaceId/members', async (request) => {
    const { actor, rt } = taskActor(request);
    const { workspaceId } = parse(z.strictObject({ workspaceId: id }), request.params);
    return rt.client.members(actor, workspaceId).catch(toHttp);
  });

  app.post('/api/tasks/workspaces/:workspaceId/tasks', async (request, reply) => {
    const { actor, rt } = taskActor(request);
    const { workspaceId } = parse(z.strictObject({ workspaceId: id }), request.params);
    const body = parse(createBody, request.body);
    // Browser operation IDs live in their own namespace so they never collide with case-derived ones.
    const result = await rt.client.createTask(actor, workspaceId, { ...body, operationId: `ui-${body.operationId}` }).catch(toHttp);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get('/api/tasks/:taskId', async (request): Promise<TaskDetailResponse> => {
    const { user, actor, rt } = taskActor(request);
    const { taskId } = parse(z.strictObject({ taskId: id }), request.params);
    const task = await rt.client.getTask(actor, taskId).catch(toHttp);
    // Provenance is computed per viewer and per read; a task-only reader gets an empty list,
    // indistinguishable from a task that was never linked.
    const provenance = rt.links.current.links
      .filter((l) => l.taskId === task.id)
      .map((l) => provenanceFor(user, l.source.kind, l.source.id))
      .filter((p): p is TaskProvenance => p !== null);
    return { task, provenance };
  });

  app.patch('/api/tasks/:taskId', async (request): Promise<TaskMutationResponse> => {
    const { actor, rt } = taskActor(request);
    const { taskId } = parse(z.strictObject({ taskId: id }), request.params);
    const body = parse(updateBody, request.body);
    return rt.client.updateTask(actor, taskId, { ...body, ...(body.operationId ? { operationId: `ui-${body.operationId}` } : {}) }).catch(toHttp);
  });

  app.post('/api/tasks/:taskId/reopen', async (request): Promise<TaskMutationResponse> => {
    const { actor, rt } = taskActor(request);
    const { taskId } = parse(z.strictObject({ taskId: id }), request.params);
    const body = parse(reopenBody, request.body);
    return rt.client.reopenTask(actor, taskId, { ...body, ...(body.operationId ? { operationId: `ui-${body.operationId}` } : {}) }).catch(toHttp);
  });

  app.get('/api/tasks/:taskId/history', async (request): Promise<TaskHistoryEntry[]> => {
    const { actor, rt } = taskActor(request);
    const { taskId } = parse(z.strictObject({ taskId: id }), request.params);
    return historyView(await rt.client.history(actor, taskId).catch(toHttp));
  });

  // ---- received case -> task

  app.get('/api/cases/:kind/:sourceId/tasks', async (request): Promise<CaseTasksResponse> => {
    const user = requireUser(request);
    const { kind, sourceId } = parse(caseParams, request.params);
    if (!sourceReadable(user, kind, sourceId)) throw notFound();
    const rt = ctx.tasks;
    const actor = rt && !user.disabled ? rt.bridge.taskUserFor(user.id) : null;
    if (!rt || !actor) return { canCreate: false, tasks: [], unavailable: false, pending: [] };
    const links = rt.links.current.links.filter((l) => l.source.kind === kind && l.source.id === sourceId);
    let unavailable = false;
    const tasks: CaseTasksResponse['tasks'] = [];
    for (const link of links) {
      try {
        const task = await rt.client.getTask(actor, link.taskId);
        tasks.push({ id: task.id, title: task.title, status: task.status, workspaceId: task.workspaceId });
      } catch (err) {
        // A task the viewer may not read is simply absent.
        if (!(err instanceof TaskServiceError) || err.kind === 'unavailable') unavailable = true;
      }
    }
    const pending = rt.links.current.operations
      .filter((op) => op.state === 'pending' && op.principalId === user.id && op.source.kind === kind && op.source.id === sourceId)
      .map((op) => ({ clientOperationId: op.clientOperationId, requestedAt: op.createdAt, input: op.input }));
    return { canCreate: true, tasks, unavailable, pending };
  });

  app.post('/api/cases/:kind/:sourceId/tasks', async (request, reply) => {
    const { user, actor, rt } = taskActor(request);
    const { kind, sourceId } = parse(caseParams, request.params);
    // Source authorization first: no task is ever created for a case the user cannot read now.
    if (!sourceReadable(user, kind, sourceId)) throw notFound();
    const body = parse(caseBody, request.body);
    const input: CaseTaskFields = { workspaceId: body.workspaceId, title: body.title, assigneeId: body.assigneeId, deadline: body.deadline, requirements: body.requirements };
    const key = sha256(`${user.id}\u0000${body.clientOperationId}`);
    const fingerprint = sha256(stable({ principalId: user.id, kind, sourceId, input }));

    // Concurrent submissions of the same operation run one after another.
    while (inFlight.has(key)) await inFlight.get(key)!.catch(() => undefined);
    const run = createFromCase(user.id, actor, rt, { kind, sourceId, key, fingerprint, clientOperationId: body.clientOperationId, input });
    inFlight.set(key, run);
    try {
      const result = await run;
      return reply.code(result.replayed ? 200 : 201).send(result);
    } finally {
      inFlight.delete(key);
    }
  });

  async function createFromCase(
    principalId: string,
    actor: string,
    rt: TaskRuntime,
    op: { kind: CaseKind; sourceId: string; key: string; fingerprint: string; clientOperationId: string; input: CaseTaskFields },
  ): Promise<CaseTaskResponse> {
    const existing = rt.links.current.operations.find((o) => o.key === op.key);
    if (existing && existing.fingerprint !== op.fingerprint) {
      // Never return the earlier result for a different request.
      throw new DomainError('conflict', '同じ操作で異なる内容が送信されました。フォームを開き直して、新しい作成として送信してください。');
    }
    if (existing?.state === 'complete' && existing.taskId) {
      const task = await rt.client.getTask(actor, existing.taskId).catch(toHttp);
      return { task, replayed: true, linked: true };
    }
    const taskOperationId = existing?.taskOperationId ?? `cg-${createHash('sha256').update(op.key).digest('base64url').slice(0, 40)}`;
    const now = clock();
    if (!existing) {
      // Recorded before the remote call, so a lost response can be resolved by a retry.
      const record: CaseTaskOperation = {
        key: op.key,
        principalId,
        clientOperationId: op.clientOperationId,
        fingerprint: op.fingerprint,
        source: { kind: op.kind, id: op.sourceId },
        input: op.input,
        taskOperationId,
        state: 'pending',
        taskId: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        rt.links.transact((s) => void s.operations.push(record));
      } catch {
        throw new HttpError(503, { error: 'storage_unavailable', message: '作成の記録を保存できなかったため、タスクは作成していません。再試行してください。' });
      }
    }

    let result: TaskMutationResponse;
    try {
      result = await rt.client.createTask(actor, op.input.workspaceId, {
        operationId: taskOperationId,
        title: op.input.title,
        assigneeId: op.input.assigneeId,
        deadline: op.input.deadline,
        requirements: op.input.requirements,
      });
    } catch (err) {
      if (err instanceof TaskServiceError && err.kind === 'definitive') {
        // The Task service applied nothing: forget the pending record so the user can correct and resend.
        try {
          rt.links.transact((s) => {
            s.operations = s.operations.filter((o) => !(o.key === op.key && o.state === 'pending'));
          });
        } catch {
          // Leaving the pending record is safe: a retry with the same operation replays deterministically.
        }
        toHttp(err);
      }
      throw UNAVAILABLE('タスクサービスから応答がなく、作成されたかどうかを確認できません。同じ内容のまま「再試行」すると、重複せずに確定します。');
    }

    try {
      rt.links.transact((s) => {
        const record = s.operations.find((o) => o.key === op.key);
        if (record) {
          record.state = 'complete';
          record.taskId = result.task.id;
          record.updatedAt = clock();
        }
        if (!s.links.some((l) => l.taskId === result.task.id && l.source.kind === op.kind && l.source.id === op.sourceId)) {
          s.seq += 1;
          s.links.push({
            id: `tl_${s.seq.toString(36).padStart(6, '0')}`,
            taskId: result.task.id,
            workspaceId: result.task.workspaceId,
            source: { kind: op.kind, id: op.sourceId },
            createdBy: principalId,
            createdAt: clock(),
          });
        }
      });
    } catch {
      throw new HttpError(503, {
        error: 'link_pending',
        message: 'タスクは作成されましたが、受信案件との関連付けを保存できませんでした。同じ内容のまま「再試行」すると、重複せずに関連付けます。',
      });
    }
    return { task: result.task, replayed: result.replayed, linked: true };
  }

  return {
    /** Demo reset: links point at sample cases; clearing them avoids stale provenance. */
    reset: () => {
      if (ctx.tasks) ctx.tasks.links.replace({ ...ctx.tasks.links.current, links: [], operations: [] });
    },
  };
}
