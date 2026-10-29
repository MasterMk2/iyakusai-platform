import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { MockLinePushConnector } from '../../src/server/line/connector.js';
import { createLineSeedState } from '../../src/server/line/seed.js';
import { LineStore } from '../../src/server/line/store.js';
import { composeServer, StartupRefusal } from '../../src/server/runtime.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON } from '../../src/server/tasks/bridge.js';
import { InProcessTaskBackend } from '../../src/server/tasks/in-process.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import { TaskService } from '../../src/task-service/server/domain/taskService.js';
import { FaultInjector } from '../../src/task-service/server/storage/faults.js';
import { MemoryStore } from '../../src/task-service/server/storage/memoryStore.js';
import { EDITOR_A, NOACCESS_D, R, seedState, T0, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';

// The unified app runs the Task service in its own process. These tests drive the same /api/tasks and
// /api/cases routes as tasks-gateway.test.ts, but against the real TaskService instead of the signed-HTTP
// contract double, so committee rules, versions and idempotency are the service's own.

type Method = 'GET' | 'POST' | 'PATCH';

let app: FastifyInstance;
let service: TaskService;
let faults: FaultInjector;
let links: TaskLinkStore;

beforeEach(async () => {
  faults = new FaultInjector();
  service = await TaskService.open({ store: new MemoryStore(), faults });
  const lineStore = new LineStore(createLineSeedState(T0, { replyGrants: true }), null);
  links = new TaskLinkStore(emptyLinkState(), null);
  app = await buildApp({
    store: new StateStore(await seedState(), null),
    listenPort: TEST_PORT,
    clock: () => new Date().toISOString(),
    line: { store: lineStore, connector: new MockLinePushConnector(), seed: (at) => createLineSeedState(at, { replyGrants: true }) },
    tasks: { client: new InProcessTaskBackend(service), bridge: parseTaskBridge(SYNTHETIC_TASK_BRIDGE_JSON), links },
  });
});
afterEach(async () => {
  await app.close();
});

async function call(userId: string | null, method: Method, url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { host: TEST_HOST, ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}) },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: res.json() as any };
}

const caseInput = (extra: Record<string, unknown> = {}) => ({
  clientOperationId: randomUUID(),
  workspaceId: 'ws-planning',
  title: '受信案件の対応',
  assigneeId: 'user-member-a2',
  deadline: '2026-10-20',
  requirements: { purpose: '返信方針を決める', deliverable: '返信案', completionCriteria: '担当者が確認済み', openQuestions: '' },
  ...extra,
});

describe('in-process Task service behind the common routes', () => {
  it("summarizes only this user's currently permitted workspaces", async () => {
    const summary = await call(EDITOR_A, 'GET', '/api/tasks/summary');
    expect(summary.status).toBe(200);
    expect(summary.json.departments.map((d: {workspaceId: string}) => d.workspaceId).sort()).toEqual(['ws-planning', 'ws-publicity']);
    expect(summary.json.total).toBe(summary.json.departments.reduce((n: number, d: {remaining: number}) => n + d.remaining, 0));
    expect((await call(VIEWER_B, 'GET', '/api/tasks/summary')).status).toBe(403);
  });

  it('answers the task context from the real committee memberships', async () => {
    const both = await call(EDITOR_A, 'GET', '/api/tasks/context');
    expect(both.json).toMatchObject({ enabled: true, bound: true });
    const roles = Object.fromEntries(both.json.memberships.map((m: { workspace: { id: string }; role: string }) => [m.workspace.id, m.role]));
    expect(roles).toEqual({ 'ws-planning': 'editor', 'ws-publicity': 'viewer' });
    expect((await call(VIEWER_B, 'GET', '/api/tasks/context')).json).toEqual({ enabled: true, bound: false, memberships: [] });
    expect((await call(VIEWER_B, 'GET', '/api/tasks/workspaces/ws-planning/tasks')).status).toBe(403);
  });

  it('has no department tags: no tagging in the context, tags refused without a change', async () => {
    const context = await call(NOACCESS_D, 'GET', '/api/tasks/context');
    expect(context.json).not.toHaveProperty('tagging');
    const refused = await call(NOACCESS_D, 'POST', '/api/tasks/workspaces/ws-planning/tasks', { operationId: 'op-inproc-tags1', title: '看板', tags: ['planning'] });
    expect(refused.status).toBe(400);
    const created = await call(NOACCESS_D, 'POST', '/api/tasks/workspaces/ws-planning/tasks', { operationId: 'op-inproc-tags2', title: '看板' });
    const patch = await call(NOACCESS_D, 'PATCH', `/api/tasks/${created.json.task.id}`, { expectedVersion: 1, changes: { tags: ['planning'] } });
    expect(patch.status).toBe(400);
    expect((await call(NOACCESS_D, 'GET', `/api/tasks/${created.json.task.id}`)).json.task.version).toBe(1);
    // Nor the all-department read the department list uses, nor parent tasks (2026-10-25).
    expect((await call(NOACCESS_D, 'GET', '/api/tasks/all')).status).toBe(404);
    const child = await call(NOACCESS_D, 'POST', '/api/tasks/workspaces/ws-planning/tasks', { operationId: 'op-inproc-tags3', title: '子', parentId: created.json.task.id });
    expect(child.status).toBe(400);
    const moved = await call(NOACCESS_D, 'PATCH', `/api/tasks/${created.json.task.id}`, { expectedVersion: 1, changes: { parentId: null } });
    expect(moved.status).toBe(400);
    expect((await call(NOACCESS_D, 'GET', `/api/tasks/${created.json.task.id}`)).json.task.version).toBe(1);
    expect((await call(NOACCESS_D, 'GET', `/api/tasks/${created.json.task.id}`)).json.task).not.toHaveProperty('parentId');
    // Nor helpers (2026-10-28).
    expect((await call(NOACCESS_D, 'POST', '/api/tasks/workspaces/ws-planning/tasks', { operationId: 'op-inproc-tags4', title: '副', helperIds: [] })).status).toBe(400);
    expect((await call(NOACCESS_D, 'PATCH', `/api/tasks/${created.json.task.id}`, { expectedVersion: 1, changes: { helperIds: [] } })).status).toBe(400);
    expect((await call(NOACCESS_D, 'GET', `/api/tasks/${created.json.task.id}`)).json.task).not.toHaveProperty('helperIds');
  });

  it('creates once per operation ID and replays the same task', async () => {
    const body = { operationId: 'op-inproc-0001', title: '会場の確認' };
    const first = await call(NOACCESS_D, 'POST', '/api/tasks/workspaces/ws-planning/tasks', body);
    expect(first.status).toBe(201);
    const again = await call(NOACCESS_D, 'POST', '/api/tasks/workspaces/ws-planning/tasks', body);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ replayed: true, task: { id: first.json.task.id } });
    const list = await call(NOACCESS_D, 'GET', '/api/tasks/workspaces/ws-planning/tasks');
    expect(list.json.filter((t: { title: string }) => t.title === '会場の確認')).toHaveLength(1);
  });

  it('passes the service decisions through: viewer role, stale version, invalid date', async () => {
    // EDITOR_A is only a viewer of the publicity committee.
    const viewer = await call(EDITOR_A, 'POST', '/api/tasks/workspaces/ws-publicity/tasks', { operationId: 'op-inproc-0002', title: '告知文' });
    expect(viewer.status).toBe(403);

    const created = await call(EDITOR_A, 'POST', '/api/tasks/workspaces/ws-planning/tasks', { operationId: 'op-inproc-0003', title: '備品の確認' });
    const taskId = created.json.task.id as string;
    const moved = await call(EDITOR_A, 'PATCH', `/api/tasks/${taskId}`, { expectedVersion: 1, changes: { status: 'in_progress' } });
    expect(moved.status).toBe(200);
    const stale = await call(EDITOR_A, 'PATCH', `/api/tasks/${taskId}`, { expectedVersion: 1, changes: { title: '古い版からの変更' } });
    expect(stale.status).toBe(409);
    expect(stale.json.current).toMatchObject({ id: taskId, version: 2, status: 'in_progress' });

    const badDate = await call(EDITOR_A, 'PATCH', `/api/tasks/${taskId}`, { expectedVersion: 2, changes: { deadline: '2026-13-40' } });
    expect(badDate.status).toBe(400);
    expect(badDate.json.error).toBe('validation');

    const history = await call(EDITOR_A, 'GET', `/api/tasks/${taskId}/history`);
    expect(history.json.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['created', 'updated']));
  });

  it('never returns member e-mail addresses', async () => {
    const members = await call(EDITOR_A, 'GET', '/api/tasks/workspaces/ws-planning/members');
    expect(members.status).toBe(200);
    for (const m of members.json) expect(Object.keys(m).sort()).toEqual(['active', 'displayName', 'role', 'userId']);
  });

  it('reports a failed save as unavailable and converges on retry without a duplicate', async () => {
    faults.set({ failNextLoads: 0, failNextSaves: 1, delayMs: 0 });
    const body = { operationId: 'op-inproc-0004', title: '保存失敗からの再試行' };
    const failed = await call(EDITOR_A, 'POST', '/api/tasks/workspaces/ws-planning/tasks', body);
    expect(failed.status).toBe(503);
    expect(failed.json.error).toBe('task_service_unavailable');
    const retried = await call(EDITOR_A, 'POST', '/api/tasks/workspaces/ws-planning/tasks', body);
    expect(retried.status).toBe(201);
    const list = await call(EDITOR_A, 'GET', '/api/tasks/workspaces/ws-planning/tasks');
    expect(list.json.filter((t: { title: string }) => t.title === body.title)).toHaveLength(1);
  });

  it('creates a task from a readable mail case, links it and replays the same operation', async () => {
    const input = caseInput();
    const res = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ linked: true, replayed: false, task: { workspaceId: 'ws-planning', assigneeId: 'user-member-a2' } });
    const again = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(again.status).toBe(200);
    expect(again.json.task.id).toBe(res.json.task.id);
    const caseTasks = await call(EDITOR_A, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`);
    expect(caseTasks.json.tasks.map((t: { id: string }) => t.id)).toEqual([res.json.task.id]);
    const detail = await call(EDITOR_A, 'GET', `/api/tasks/${res.json.task.id}`);
    expect(detail.json.provenance).toHaveLength(1);
    // The task-only user sees the task itself but nothing about the case it came from.
    const taskOnly = await call(NOACCESS_D, 'GET', `/api/tasks/${res.json.task.id}`);
    expect(taskOnly.status).toBe(200);
    expect(taskOnly.json.provenance).toEqual([]);
  });
});

describe('in-process Task composition', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'iyakusai-tasks-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('seeds the demo composition and serves tasks from the same process', async () => {
    const config = loadConfig({ SMM_DATA_FILE: path.join(dir, 'mail.json'), SMM_TASK_DATA_FILE: path.join(dir, 'tasks.json') });
    expect(config.tasks.mode).toBe('in-process');
    const runtime = await composeServer(config);
    try {
      const login = await runtime.app.inject({ method: 'POST', url: '/api/session', headers: { host: `127.0.0.1:${config.port}`, origin: `http://127.0.0.1:${config.port}`, 'content-type': 'application/json', 'x-smm-csrf': '1' }, payload: { userId: EDITOR_A } });
      expect(login.statusCode).toBeLessThan(300);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const ctx = await runtime.app.inject({ method: 'GET', url: '/api/tasks/context', headers: { host: `127.0.0.1:${config.port}`, cookie } });
      expect(ctx.json()).toMatchObject({ enabled: true, bound: true });
    } finally {
      await runtime.app.close();
    }
  });

  it('refuses mixed in-process and remote settings', () => {
    expect(() => loadConfig({ SMM_TASK_DATA_FILE: path.join(dir, 'tasks.json'), SMM_TASK_SERVICE_URL: 'http://127.0.0.1:17631' })).toThrow(/同時に指定できません/);
  });

  it('refuses a bridge that names a user the task data does not have', async () => {
    const bridge = path.join(dir, 'bridge.json');
    await writeFile(bridge, JSON.stringify({ version: 1, bindings: [{ principalId: 'u-editor-a', taskUserId: 'user-not-in-tasks' }] }));
    const config = loadConfig({ SMM_DATA_FILE: path.join(dir, 'mail.json'), SMM_TASK_DATA_FILE: path.join(dir, 'tasks.json'), SMM_TASK_BRIDGE_FILE: bridge });
    await expect(composeServer(config)).rejects.toBeInstanceOf(StartupRefusal);
  });
});
