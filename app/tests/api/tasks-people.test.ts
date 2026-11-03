import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON } from '../../src/server/tasks/bridge.js';
import { InProcessTaskBackend } from '../../src/server/tasks/in-process.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import { TaskService } from '../../src/task-service/server/domain/taskService.js';
import { FaultInjector } from '../../src/task-service/server/storage/faults.js';
import { MemoryStore } from '../../src/task-service/server/storage/memoryStore.js';
import { EDITOR_A, EDITOR_C, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// The people view (2026-11-03) and the viewer's own tasks (自分の持ち) against the in-process Task service,
// which the demo runs. The seed is synthetic: EDITOR_A is the task user member-a1, who leads two open tasks
// in the planning committee and is only a viewer in the publicity committee.

let app: FastifyInstance;
let service: TaskService;

beforeEach(async () => {
  service = await TaskService.open({ store: new MemoryStore(), faults: new FaultInjector() });
  app = await buildApp({
    store: new StateStore(await seedState(), null),
    listenPort: TEST_PORT,
    clock: () => new Date().toISOString(),
    tasks: { client: new InProcessTaskBackend(service), bridge: parseTaskBridge(SYNTHETIC_TASK_BRIDGE_JSON), links: new TaskLinkStore(emptyLinkState(), null) },
  });
});
afterEach(async () => {
  await app.close();
});

async function call(userId: string, method: 'GET' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${userId}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: res.json() as any };
}

describe('the viewer’s own tasks in the summary', () => {
  it('counts the open tasks this person leads, once each, from the same read', async () => {
    const summary = await call(EDITOR_A, 'GET', '/api/tasks/summary');
    expect(summary.status).toBe(200);
    expect(summary.json.mine).toEqual({ remaining: 2, lead: 2, helper: 0, overdue: 0, today: 0 });
  });

  it('gives a real zero for someone who holds nothing', async () => {
    const summary = await call(EDITOR_C, 'GET', '/api/tasks/summary');
    expect(summary.json.mine).toEqual({ remaining: 0, lead: 0, helper: 0, overdue: 0, today: 0 });
  });
});

describe('giving an unassigned task its main assignee', () => {
  it('lets an editor assign it through the existing update API, and the list then shows the new assignee', async () => {
    const before = await call(EDITOR_A, 'GET', '/api/tasks/workspaces/ws-planning/tasks?assignee=none');
    const target = before.json.find((t: { title: string }) => t.title === '配布資料のひな形を作る');
    expect(target).toBeDefined();
    const updated = await call(EDITOR_A, 'PATCH', `/api/tasks/${target.id}`, {
      expectedVersion: target.version,
      operationId: 'people-assign-0001',
      changes: { assigneeId: 'user-member-a2' },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.task).toMatchObject({ id: target.id, assigneeId: 'user-member-a2', version: target.version + 1 });
    const after = await call(EDITOR_A, 'GET', '/api/tasks/workspaces/ws-planning/tasks?assignee=none');
    expect(after.json.some((t: { id: string }) => t.id === target.id)).toBe(false);
  });

  it('refuses the assignment from a viewer of that committee, leaving the task unassigned', async () => {
    // EDITOR_A only views ws-publicity, where task-7 is unassigned.
    const denied = await call(EDITOR_A, 'PATCH', '/api/tasks/task-7', {
      expectedVersion: 1,
      operationId: 'people-assign-0002',
      changes: { assigneeId: 'user-member-a1' },
    });
    expect(denied.status).toBe(403);
    const listed = await call(EDITOR_C, 'GET', '/api/tasks/workspaces/ws-publicity/tasks?assignee=none');
    expect(listed.json.some((t: { id: string }) => t.id === 'task-7')).toBe(true);
  });

  it('answers a stale version with a conflict and changes nothing', async () => {
    const stale = await call(EDITOR_A, 'PATCH', '/api/tasks/task-3', {
      expectedVersion: 99,
      operationId: 'people-assign-0003',
      changes: { assigneeId: 'user-member-a2' },
    });
    expect(stale.status).toBe(409);
    const task = await call(EDITOR_A, 'GET', '/api/tasks/task-3');
    expect(task.json.task.assigneeId).toBeNull();
  });
});
