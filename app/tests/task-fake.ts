import { createHash, randomBytes } from 'node:crypto';
import { summarizeTaskGroups } from '../src/shared/task-summary.js';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SVC_HEADERS, verifySignature } from '../src/server/tasks/signing.js';

// TEST-ONLY contract double of the Task service integration API (discord-task-manager
// /api/integration/v1), used by the standalone gateway tests. It verifies the gateway's
// svc-auth/v1 signature, keeps tasks in memory with the same idempotency rule (actor + operation
// ID + payload fingerprint) and committee checks, and can inject failures, including a lost
// response after the task was applied. The cross-system suite runs against the real service.

const BASE_MEMBERS: Record<string, Record<string, 'viewer' | 'editor' | 'admin'>> = {
  'ws-planning': { 'user-member-a1': 'editor', 'user-member-a2': 'editor', 'user-observer-a': 'viewer', 'user-chair-a': 'admin' },
  'ws-publicity': { 'user-chair-b': 'admin', 'user-member-a1': 'viewer', 'user-member-b1': 'editor' },
};
const BASE_NAMES: Record<string, string> = {
  'ws-planning': 'サンプル企画委員会',
  'ws-publicity': 'サンプル広報委員会',
};

export type FakeFault = 'unavailable' | 'lost-after-apply' | 'bad-signature-response';

interface FakeTask {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  deadline: string | null;
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  requirements: Record<string, string>;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  tags: string[];
  /** Departments only (2026-10-25): the parent task, one level. */
  parentId?: string | null;
  /** Departments only (2026-10-28): the helpers (副担当). */
  helperIds?: string[];
}

export interface TaskFakeOptions {
  /** Answer like the Bot-host Task API: departments as workspaces (dept-<key>) and tasks with tags. */
  departments?: boolean;
}

export interface TaskFake {
  url: string;
  key: Buffer;
  tasks: Map<string, FakeTask>;
  /** Number of create requests that reached the service (signed and routed). */
  createCalls: number;
  summaryCalls: number;
  listCalls: number;
  /** Reads of every task at once (GET /tasks, departments only). */
  allCalls: number;
  /** Body of the last create request (to check what the gateway passed on). */
  lastCreateBody: Record<string, unknown> | null;
  faults: FakeFault[];
  close: () => Promise<void>;
}

const view = ({ tags, ...t }: FakeTask) => ({
  ...t,
  ...(tags.length ? { tags, tagLabels: tags.map((k) => `部局${k}`) } : {}),
  assignee: t.assigneeId ? { id: t.assigneeId, displayName: t.assigneeId, active: true } : null,
  ...(t.helperIds ? { helpers: t.helperIds.map((id) => ({ id, displayName: id, active: true })) } : {}),
  overdue: false,
  missingRequirements: Object.entries(t.requirements)
    .filter(([, v]) => v === '')
    .map(([k]) => k),
});

const error = (code: string, message: string) => ({ error: { code, message } });

/** The Bot's rule: helpers only with an assignee, and never the assignee. */
const badAssignees = (assigneeId: string | null, helperIds: string[]) => helperIds.length > 0 && (assigneeId === null || helperIds.includes(assigneeId));

export async function startTaskFake(options: TaskFakeOptions = {}): Promise<TaskFake> {
  const key = randomBytes(32);
  const wsId = (ws: string) => (options.departments ? ws.replace(/^ws-/, 'dept-') : ws);
  const MEMBERS = Object.fromEntries(Object.entries(BASE_MEMBERS).map(([ws, m]) => [wsId(ws), m]));
  const NAMES = Object.fromEntries(Object.entries(BASE_NAMES).map(([ws, n]) => [wsId(ws), n]));
  const tasks = new Map<string, FakeTask>();
  const ops = new Map<string, { fp: string; taskId: string }>();
  const nonces = new Set<string>();
  const state = { summaryCalls: 0, listCalls: 0, allCalls: 0, createCalls: 0, faults: [] as FakeFault[], lastCreateBody: null as Record<string, unknown> | null };
  let seq = 0;
  const app: FastifyInstance = Fastify({ logger: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as FastifyRequest & { rawBody?: string }).rawBody = String(body);
    done(null, body ? JSON.parse(String(body)) : undefined);
  });

  app.addHook('preHandler', async (request, reply) => {
    const h = (n: string) => request.headers[n] as string | undefined;
    const sig = h(SVC_HEADERS.signature) ?? '';
    const nonce = h(SVC_HEADERS.nonce) ?? '';
    const ok =
      h(SVC_HEADERS.client) === 'web-gateway' &&
      !nonces.has(nonce) &&
      Math.abs(Date.now() - Number(h(SVC_HEADERS.timestamp))) < 30_000 &&
      verifySignature(
        key,
        {
          client: 'web-gateway',
          method: request.method,
          path: request.raw.url ?? '',
          timestamp: h(SVC_HEADERS.timestamp) ?? '',
          nonce,
          actor: h(SVC_HEADERS.actor) ?? '',
          body: (request as FastifyRequest & { rawBody?: string }).rawBody ?? '',
        },
        sig,
      );
    if (!ok) return reply.code(401).send(error('UNAUTHENTICATED', 'bad signature'));
    nonces.add(nonce);
    const fault = state.faults[0];
    if (fault === 'unavailable') {
      state.faults.shift();
      return reply.code(503).send(error('INTERNAL', 'down'));
    }
  });

  const actor = (request: FastifyRequest) => String(request.headers[SVC_HEADERS.actor] ?? '');
  const role = (ws: string, user: string) => MEMBERS[ws]?.[user];

  app.get('/api/integration/v1/me', async (request) => ({
    user: { id: actor(request), displayName: actor(request) },
    memberships: Object.entries(MEMBERS)
      .filter(([, m]) => m[actor(request)])
      // Departments name the part a section belongs to (2026-10-25); these two are both parts.
      .map(([ws, m]) => ({ workspace: { id: ws, name: NAMES[ws], description: '', ...(options.departments ? { parentId: null } : {}) }, role: m[actor(request)] })),
  }));

  app.get('/api/integration/v1/tasks', async (request, reply) => {
    if (!options.departments) return reply.code(404).send(error('NOT_FOUND', 'not found'));
    state.allCalls++;
    return [...tasks.values()].filter((t) => role(t.workspaceId, actor(request))).map(view);
  });

  app.get('/api/integration/v1/summary', async (request) => {
    state.summaryCalls++;
    const groups = Object.keys(MEMBERS).filter(ws => role(ws, actor(request))).map(ws => ({
      workspaceId: ws, name: NAMES[ws]!, tasks: [...tasks.values()].filter(t => t.workspaceId === ws).map(view),
    }));
    return summarizeTaskGroups(groups, new Date().toISOString());
  });

  app.get<{ Params: { ws: string } }>('/api/integration/v1/workspaces/:ws/tasks', async (request, reply) => {
    state.listCalls++;
    if (!role(request.params.ws, actor(request))) return reply.code(403).send(error('FORBIDDEN', 'no membership'));
    return [...tasks.values()].filter((t) => t.workspaceId === request.params.ws).map(view);
  });

  app.get<{ Params: { ws: string } }>('/api/integration/v1/workspaces/:ws/members', async (request, reply) => {
    if (!role(request.params.ws, actor(request))) return reply.code(403).send(error('FORBIDDEN', 'no membership'));
    return Object.entries(MEMBERS[request.params.ws]!).map(([userId, r]) => ({ userId, displayName: userId, role: r, active: true }));
  });

  app.post<{ Params: { ws: string }; Body: Record<string, unknown> }>('/api/integration/v1/workspaces/:ws/tasks', async (request, reply) => {
    state.createCalls += 1;
    state.lastCreateBody = request.body ?? null;
    const ws = request.params.ws;
    const who = actor(request);
    const body = request.body ?? {};
    const r = role(ws, who);
    if (!r) return reply.code(403).send(error('FORBIDDEN', 'この委員会を利用する権限がありません。'));
    if (r === 'viewer') return reply.code(403).send(error('FORBIDDEN', '閲覧者は変更できません。'));
    const { operationId, ...payload } = body;
    const fp = createHash('sha256').update(JSON.stringify({ ws, payload })).digest('hex');
    const opKey = `${who}:${String(operationId)}`;
    const prior = ops.get(opKey);
    if (prior) {
      if (prior.fp !== fp) return reply.code(409).send(error('IDEMPOTENCY_CONFLICT', '同じ操作 ID で異なる内容が送られました。'));
      return reply.code(200).send({ task: view(tasks.get(prior.taskId)!), replayed: true });
    }
    const title = String(payload.title ?? '').trim();
    if (!title) return reply.code(400).send({ error: { code: 'VALIDATION', message: '入力内容を確認してください。', details: [{ path: 'title', message: 'タイトルを入力してください' }] } });
    const parentId = (payload.parentId as string | null | undefined) ?? null;
    if (parentId !== null && (!options.departments || !tasks.has(parentId) || tasks.get(parentId)!.parentId)) {
      return reply.code(400).send(error(options.departments ? 'INVALID_PARENT' : 'VALIDATION', '操作を反映できませんでした。'));
    }
    const assigneeId = (payload.assigneeId as string | null | undefined) ?? null;
    if (assigneeId !== null && !role(ws, assigneeId)) {
      return reply.code(400).send({ error: { code: 'VALIDATION', message: '入力内容を確認してください。', details: [{ path: 'assigneeId', message: 'この委員会の有効なメンバーではありません' }] } });
    }
    const helperIds = (payload.helperIds as string[] | undefined) ?? [];
    if (helperIds.length && (!options.departments || badAssignees(assigneeId, helperIds))) {
      return reply.code(400).send(error(options.departments ? 'INVALID_ASSIGNEES' : 'VALIDATION', '操作を反映できませんでした。'));
    }
    seq += 1;
    const now = new Date().toISOString();
    const task: FakeTask = {
      id: `task-${100 + seq}`,
      workspaceId: ws,
      title,
      description: '',
      assigneeId,
      deadline: (payload.deadline as string | null | undefined) ?? null,
      status: 'todo',
      requirements: { purpose: '', deliverable: '', completionCriteria: '', openQuestions: '', ...((payload.requirements as Record<string, string>) ?? {}) },
      version: 1,
      createdAt: now,
      createdBy: who,
      updatedAt: now,
      updatedBy: who,
      tags: options.departments ? ((payload.tags as string[] | undefined) ?? [ws.replace(/^dept-/, '')]) : [],
      ...(options.departments ? { parentId, helperIds } : {}),
    };
    tasks.set(task.id, task);
    ops.set(opKey, { fp, taskId: task.id });
    if (state.faults[0] === 'lost-after-apply') {
      state.faults.shift();
      // Applied, but the answer never arrives intact.
      return reply.code(502).send('upstream reset');
    }
    return reply.code(201).send({ task: view(task), replayed: false });
  });

  const readable = (request: FastifyRequest, id: string) => {
    const t = tasks.get(id);
    return t && role(t.workspaceId, actor(request)) ? t : null;
  };

  app.get<{ Params: { id: string } }>('/api/integration/v1/tasks/:id', async (request, reply) => {
    const t = readable(request, request.params.id);
    return t ? view(t) : reply.code(404).send(error('NOT_FOUND', 'タスクが見つからないか、表示する権限がありません。'));
  });

  app.get<{ Params: { id: string } }>('/api/integration/v1/tasks/:id/history', async (request, reply) => {
    const t = readable(request, request.params.id);
    if (!t) return reply.code(404).send(error('NOT_FOUND', 'タスクが見つからないか、表示する権限がありません。'));
    return [{ id: 'h1', taskId: t.id, workspaceId: t.workspaceId, version: 1, action: 'created', actorId: t.createdBy, actorName: t.createdBy, at: t.createdAt, source: 'web', operationId: 'secret-op', changes: [], displayChanges: [] }];
  });

  app.patch<{ Params: { id: string }; Body: { expectedVersion: number; changes: Record<string, unknown> } }>('/api/integration/v1/tasks/:id', async (request, reply) => {
    const t = readable(request, request.params.id);
    if (!t) return reply.code(404).send(error('NOT_FOUND', 'not found'));
    if (role(t.workspaceId, actor(request)) === 'viewer') return reply.code(403).send(error('FORBIDDEN', '閲覧者は変更できません。'));
    if (request.body.expectedVersion !== t.version) return reply.code(409).send({ error: { code: 'VERSION_CONFLICT', message: '他の操作で先に更新されています。', current: view(t) } });
    const changes = { ...request.body.changes };
    if (t.helperIds) {
      const assigneeId = 'assigneeId' in changes ? ((changes.assigneeId as string | null) ?? null) : t.assigneeId;
      // A helper made the assignee leaves the helpers (unless the helpers are sent too).
      const helperIds = (changes.helperIds as string[] | undefined) ?? t.helperIds.filter((h) => h !== assigneeId);
      if (badAssignees(assigneeId, helperIds)) return reply.code(400).send(error('INVALID_ASSIGNEES', '操作を反映できませんでした。'));
      changes.helperIds = helperIds;
    } else if ('helperIds' in changes) {
      return reply.code(400).send(error('VALIDATION', '操作を反映できませんでした。'));
    }
    Object.assign(t, changes);
    t.version += 1;
    return { task: view(t), replayed: false };
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    key,
    tasks,
    get summaryCalls() { return state.summaryCalls; },
    get listCalls() { return state.listCalls; },
    get allCalls() { return state.allCalls; },
    get createCalls() {
      return state.createCalls;
    },
    get lastCreateBody() {
      return state.lastCreateBody;
    },
    faults: state.faults,
    close: () => app.close(),
  };
}
