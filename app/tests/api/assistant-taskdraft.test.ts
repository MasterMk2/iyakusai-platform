import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssistantServiceClient } from '../../src/server/assistant/client.js';
import { browserDraft, buildRoster, openTasksFor } from '../../src/server/assistant/taskdraft.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { parseTaskBridge } from '../../src/server/tasks/bridge.js';
import { InProcessTaskBackend } from '../../src/server/tasks/in-process.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import type { TaskDraft, TaskDraftItem } from '../../src/shared/assistant.js';
import type { TaskMember, TaskView } from '../../src/shared/tasks.js';
import { TaskService } from '../../src/task-service/server/domain/taskService.js';
import { FaultInjector } from '../../src/task-service/server/storage/faults.js';
import { MemoryStore } from '../../src/task-service/server/storage/memoryStore.js';
import { startAssistantFake, type AssistantFake } from '../assistant-fake.js';
import { EDITOR_A, EDITOR_C, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// Task drafting (taskdraft, 2026-11-09, contract §9) against the in-process Task service of the demo and the
// synthetic Bot-host double: the server adds the roster and the open tasks to the outline, and a draft reaches the
// browser only in the expected shape.

const BRIDGE = parseTaskBridge(
  JSON.stringify({
    version: 1,
    bindings: [
      { principalId: EDITOR_A, taskUserId: 'user-member-a1' },
      // A viewer of the planning committee (may read tasks, not create them).
      { principalId: EDITOR_C, taskUserId: 'user-observer-a' },
    ],
  }),
);

let fake: AssistantFake;
let app: FastifyInstance;

async function start(options: { tasks?: boolean } = {}) {
  fake = await startAssistantFake();
  const service = await TaskService.open({ store: new MemoryStore(), faults: new FaultInjector() });
  const client = new AssistantServiceClient({ baseUrl: fake.url, key: fake.key, timeoutMs: 2_000, longTimeoutMs: 3_000 });
  app = await buildApp({
    store: new StateStore(await seedState(), null),
    listenPort: TEST_PORT,
    clock: () => new Date().toISOString(),
    assistant: { client, bridge: BRIDGE },
    ...(options.tasks === false ? {} : { tasks: { client: new InProcessTaskBackend(service), bridge: BRIDGE, links: new TaskLinkStore(emptyLinkState(), null) } }),
  });
}

beforeEach(async () => {
  await start();
});
afterEach(async () => {
  await app.close().catch(() => undefined);
  await fake.close().catch(() => undefined);
});

async function call(userId: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${userId}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: res.json() as any };
}

const draftItem = (over: Partial<TaskDraftItem> = {}): TaskDraftItem => ({
  title: '配布資料を印刷する',
  tags: ['kikaku'],
  deadline: '2026-11-20',
  purpose: '',
  deliverable: '',
  completionCriteria: '',
  openQuestions: '',
  assigneeId: 'user-member-a2',
  assigneeName: '委員 A2',
  assigneeBy: 'ai',
  assigneeFacts: '企画課｜主担当 0・副担当 0',
  reason: '持ちが少ないため',
  helperIds: [],
  helperNames: [],
  alternatives: [{ id: 'user-chair-a', name: '管理役 A', facts: '所属不明｜主担当 1・副担当 0' }],
  ...over,
});
const draft = (over: Partial<TaskDraft> = {}): TaskDraft => ({
  parent: null,
  items: [draftItem()],
  notes: '',
  questions: [],
  parentTask: null,
  sources: [],
  ...over,
});

describe('POST /api/assistant/taskdraft', () => {
  it('sends the outline with the roster and the open tasks the Task service shows this person', async () => {
    const res = await call(EDITOR_A, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '  秋の定例会の準備\n会場と資料  ', deadline: '2026-11-30', useSources: false });
    expect(res.status).toBe(202);
    expect(res.json.job.kind).toBe('taskdraft');
    const sent = fake.calls.find((c) => c.path.endsWith('/jobs') && c.method === 'POST')!;
    expect(sent.actor).toBe('user-member-a1');
    const body = sent.body as { clientOperationId: string; kind: string; input: Record<string, unknown> };
    expect(body.clientOperationId).toMatch(/^ui-/);
    expect(body.kind).toBe('taskdraft');
    const input = body.input as { overview: string; deadline: string; useSources: boolean; parent: unknown; tags: string[]; roster: { id: string; lead: number }[]; openTasks: { title: string }[] };
    expect(input.overview).toBe('秋の定例会の準備\n会場と資料');
    expect(input).toMatchObject({ deadline: '2026-11-30', useSources: false, parent: null, tags: [] });
    // Active editors and officers of the committee only: not the viewer, not the former member.
    expect(input.roster.map((p) => p.id).sort()).toEqual(['user-chair-a', 'user-member-a1', 'user-member-a2']);
    expect(input.roster.find((p) => p.id === 'user-member-a1')!.lead).toBe(2);
    expect(input.openTasks.length).toBeGreaterThan(0);
    expect(input.openTasks.some((t) => t.title === '秋の定例会の議題案をまとめる')).toBe(true);
  });

  it('checks the outline and the parent before anything is sent', async () => {
    const empty = await call(EDITOR_A, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '   ' });
    expect(empty.status).toBe(400);
    const missing = await call(EDITOR_A, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '準備', parentId: 'task-999' });
    expect(missing.status).toBe(400);
    expect(missing.json.message).toBe('親タスクが見つかりません。');
    expect(fake.calls.some((c) => c.path.endsWith('/jobs'))).toBe(false);
  });

  it('drafts under an existing parent', async () => {
    const list = await call(EDITOR_A, 'GET', '/api/tasks/workspaces/ws-planning/tasks');
    const parent = list.json.find((t: TaskView) => !t.parentId);
    const res = await call(EDITOR_A, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '準備', parentId: parent.id });
    expect(res.status).toBe(202);
    const sent = fake.calls.find((c) => c.path.endsWith('/jobs'))!.body as { input: { parent: { id: string; title: string } } };
    expect(sent.input.parent).toEqual({ id: parent.id, title: parent.title });
  });

  it('refuses someone who can only view the tasks, before anything is sent', async () => {
    const res = await call(EDITOR_C, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '準備' });
    expect(res.status).toBe(403);
    expect(res.json.message).toBe('タスクを登録できる人だけが使えます。');
    expect(fake.calls.some((c) => c.path.endsWith('/jobs'))).toBe(false);
  });

  it('answers 404 without a Task service', async () => {
    await app.close();
    await fake.close();
    await start({ tasks: false });
    const res = await call(EDITOR_A, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '準備' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('TASKDRAFT_DISABLED');
  });
});

describe('the draft in a job result', () => {
  it('passes a draft in the expected shape and drops anything else', async () => {
    const created = await call(EDITOR_A, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '準備' });
    const id = created.json.job.id as string;
    fake.complete(id, { text: '📝', files: [], draft: { ...draft(), extra: 'x' } as unknown as TaskDraft });
    const done = await call(EDITOR_A, 'GET', `/api/assistant/jobs/${id}`);
    expect(done.json.job.result.draft.items[0].title).toBe('配布資料を印刷する');
    expect(done.json.job.result.draft.extra).toBeUndefined();

    const broken = await call(EDITOR_A, 'POST', '/api/assistant/taskdraft', { clientOperationId: randomUUID(), overview: '準備2' });
    fake.complete(broken.json.job.id, { text: '📝', files: [], draft: draft({ items: [] }) });
    const dropped = await call(EDITOR_A, 'GET', `/api/assistant/jobs/${broken.json.job.id}`);
    expect(dropped.json.job.result.draft).toBeUndefined();
    expect(dropped.json.job.result.text).toBe('📝');
  });

  it('never passes a draft on another kind of job', async () => {
    const ask = await call(EDITOR_A, 'POST', '/api/assistant/jobs', { clientOperationId: randomUUID(), kind: 'ask', input: { question: '質問' } });
    fake.complete(ask.json.job.id, { text: '答え', files: [], draft: draft() });
    const done = await call(EDITOR_A, 'GET', `/api/assistant/jobs/${ask.json.job.id}`);
    expect(done.json.job.result.draft).toBeUndefined();
  });

  it('checks the fields', () => {
    expect(browserDraft(draft())).not.toBeNull();
    expect(browserDraft(draft({ items: [draftItem({ assigneeId: 'Not An Id' })] }))).toBeNull();
    expect(browserDraft(draft({ items: [draftItem({ tags: [] })] }))).toBeNull();
    expect(browserDraft(draft({ items: [draftItem({ title: 'x'.repeat(121) })] }))).toBeNull();
    expect(browserDraft(null)).toBeNull();
  });
});

describe('the roster and the open tasks', () => {
  const task = (over: Partial<TaskView>): TaskView => ({
    id: 'task-1',
    workspaceId: 'dept-kikaku',
    title: 't',
    description: '',
    assigneeId: null,
    deadline: null,
    status: 'todo',
    requirements: { purpose: '', deliverable: '', completionCriteria: '', openQuestions: '' },
    version: 1,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
    updatedBy: '',
    assignee: null,
    overdue: false,
    missingRequirements: [],
    tags: ['kikaku'],
    ...over,
  });
  const member = (userId: string, role: TaskMember['role'] = 'editor', active = true): TaskMember => ({ userId, displayName: userId, role, active });

  it('counts open tasks as lead and helper, takes departments from the people, and leaves out viewers', () => {
    const tasks = [
      task({ id: 'task-1', assigneeId: 'discord-1', deadline: '2026-11-01', tags: ['kikaku'] }),
      task({ id: 'task-2', assigneeId: 'discord-2', helperIds: ['discord-1'], tags: ['kaijo'] }),
      task({ id: 'task-3', assigneeId: 'discord-1', status: 'done', tags: ['koho'] }),
    ];
    const roster = buildRoster({
      members: [member('discord-1'), member('discord-2', 'admin'), member('discord-3', 'viewer'), member('discord-4', 'editor', false)],
      tasks,
      people: [
        { id: 'u1', displayName: 'a', roleLabel: '内務部・企画課', email: '', canManageAccess: false },
        { id: 'u2', displayName: 'b', roleLabel: '委員', email: '', canManageAccess: false },
      ],
      taskUserFor: (p) => ({ u1: 'discord-1', u2: 'discord-2' })[p] ?? null,
      labels: new Map([
        ['内務部', 'naimu'],
        ['企画課', 'kikaku'],
      ]),
      today: '2026-11-09',
    });
    expect(roster.map((r) => r.id)).toEqual(['discord-1', 'discord-2']);
    expect(roster[0]).toEqual({ id: 'discord-1', name: 'discord-1', departments: ['naimu', 'kikaku'], lead: 1, helper: 1, overdue: 1, history: ['kikaku', 'kaijo', 'koho'] });
    expect(roster[1]).toMatchObject({ departments: [], lead: 1, helper: 0, overdue: 0 });
  });

  it('puts the hinted departments first and hides assignees outside the roster', () => {
    const tasks = [
      task({ id: 'task-1', title: 'a', tags: ['koho'], deadline: '2026-11-10', assigneeId: 'discord-9' }),
      task({ id: 'task-2', title: 'b', tags: ['kaijo'], deadline: '2026-11-30', assigneeId: 'discord-1' }),
      task({ id: 'task-3', title: 'c', tags: ['kaijo'], status: 'done' }),
    ];
    const open = openTasksFor(tasks, ['kaijo'], new Set(['discord-1']));
    expect(open.map((t) => t.title)).toEqual(['b', 'a']);
    expect(open[1]!.assigneeId).toBeNull();
    expect(open[0]!.assigneeId).toBe('discord-1');
  });
});
