import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON } from '../../src/server/tasks/bridge.js';
import { TaskServiceClient } from '../../src/server/tasks/client.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import { EDITOR_A, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { startTaskFake, type TaskFake } from '../task-fake.js';

// Department tags (2026-10-14): with the Bot-host Task API the workspaces are departments and a
// task carries one or more department keys. The common Web passes tags through unchanged.

let fake: TaskFake;
let app: FastifyInstance;

async function setup(departments: boolean) {
  fake = await startTaskFake({ departments });
  app = await buildApp({
    store: new StateStore(await seedState(), null),
    listenPort: TEST_PORT,
    clock: () => new Date().toISOString(),
    tasks: { client: new TaskServiceClient({ baseUrl: fake.url, key: fake.key, timeoutMs: 2_000 }), bridge: parseTaskBridge(SYNTHETIC_TASK_BRIDGE_JSON), links: new TaskLinkStore(emptyLinkState(), null) },
  });
}
afterEach(async () => {
  await app.close();
  await fake.close();
});

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({ method, url, headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${EDITOR_A}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: res.json() as any };
}

describe('department tags', () => {
  it('reports tagging only when every workspace is a department', async () => {
    await setup(true);
    const context = await call('GET', '/api/tasks/context');
    expect(context.json.tagging).toBe(true);
    expect(context.json.memberships.map((m: { workspace: { id: string } }) => m.workspace.id).sort()).toEqual(['dept-planning', 'dept-publicity']);
  });

  it('has no tagging with committee workspaces', async () => {
    await setup(false);
    const context = await call('GET', '/api/tasks/context');
    expect(context.json).toMatchObject({ enabled: true, bound: true });
    expect(context.json).not.toHaveProperty('tagging');
  });

  it('passes tags through on create and edit', async () => {
    await setup(true);
    const created = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0001', title: '看板の発注', tags: ['planning', 'publicity'] });
    expect(created.status).toBe(201);
    expect(fake.lastCreateBody?.tags).toEqual(['planning', 'publicity']);
    expect(created.json.task.tags).toEqual(['planning', 'publicity']);
    const updated = await call('PATCH', `/api/tasks/${created.json.task.id}`, { expectedVersion: 1, operationId: 'op-tags-0002', changes: { tags: ['publicity'] } });
    expect(updated.status).toBe(200);
    expect(updated.json.task.tags).toEqual(['publicity']);
    // Without tags the Task service decides (the Bot-host API uses the department of the URL).
    const plain = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0003', title: '会場図' });
    expect(fake.lastCreateBody).not.toHaveProperty('tags');
    expect(plain.json.task.tags).toEqual(['planning']);
  });

  it('refuses malformed tags before reaching the Task service', async () => {
    await setup(true);
    for (const tags of [[], ['Planning'], ['a'], ['planning', 'publicity', 'x1', 'yy', 'zz', 'ww'], 'planning']) {
      const res = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0009', title: 'x', tags });
      expect(res.status).toBe(400);
    }
    expect(fake.createCalls).toBe(0);
  });

  it('lists every department in one read, and names the part of each section in the context', async () => {
    await setup(true);
    const context = await call('GET', '/api/tasks/context');
    expect(context.json.memberships.map((m: { workspace: { parentId?: string | null } }) => m.workspace.parentId)).toEqual([null, null]);
    await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0101', title: '看板の発注' });
    await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0102', title: 'ポスター', tags: ['publicity'] });
    const all = await call('GET', '/api/tasks/all');
    expect(all.status).toBe(200);
    expect(all.json.map((t: { title: string; tags: string[] }) => [t.title, t.tags])).toEqual([['看板の発注', ['planning']], ['ポスター', ['publicity']]]);
    expect([fake.allCalls, fake.listCalls]).toEqual([1, 0]);
    // The read takes no query; anything else is refused before it reaches the Task service.
    expect((await call('GET', '/api/tasks/all?status=todo')).status).toBe(400);
    expect(fake.allCalls).toBe(1);
  });

  it('passes parent tasks through, and the one-level refusal as its own code', async () => {
    await setup(true);
    const project = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0201', title: 'ステージ企画' });
    expect(project.json.task.parentId).toBeNull();
    const child = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0202', title: '出演者に連絡', parentId: project.json.task.id });
    expect(child.status).toBe(201);
    expect(fake.lastCreateBody?.parentId).toBe(project.json.task.id);
    expect(child.json.task.parentId).toBe(project.json.task.id);
    // Without a parent the create body is as before (no parentId), so a retry of an older form matches.
    await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0203', title: '看板' });
    expect(fake.lastCreateBody).not.toHaveProperty('parentId');
    const grandchild = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0204', title: '孫', parentId: child.json.task.id });
    expect([grandchild.status, grandchild.json.error]).toEqual([400, 'invalid_parent']);
    const cleared = await call('PATCH', `/api/tasks/${child.json.task.id}`, { expectedVersion: 1, operationId: 'op-tags-0205', changes: { parentId: null } });
    expect([cleared.status, cleared.json.task.parentId]).toEqual([200, null]);
    // A malformed ID never reaches the Task service.
    const before = fake.createCalls;
    expect((await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0206', title: 'x', parentId: 'Task 1' })).status).toBe(400);
    expect(fake.createCalls).toBe(before);
  });

  it('passes helpers through, and the assignee rule refusal as its own code', async () => {
    await setup(true);
    const task = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0301', title: '受付', assigneeId: 'user-member-a1', helperIds: ['user-member-a2', 'user-chair-a'] });
    expect(task.status).toBe(201);
    expect(fake.lastCreateBody?.helperIds).toEqual(['user-member-a2', 'user-chair-a']);
    expect(task.json.task.helperIds).toEqual(['user-member-a2', 'user-chair-a']);
    expect(task.json.task.helpers.map((h: { id: string }) => h.id)).toEqual(['user-member-a2', 'user-chair-a']);
    // Without helpers the create body is as before (no helperIds), so a retry of an older form matches.
    await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0302', title: '看板' });
    expect(fake.lastCreateBody).not.toHaveProperty('helperIds');
    // Helpers need an assignee.
    const lone = await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0303', title: '単独', helperIds: ['user-member-a2'] });
    expect([lone.status, lone.json.error]).toEqual([400, 'invalid_assignees']);
    const swapped = await call('PATCH', `/api/tasks/${task.json.task.id}`, { expectedVersion: 1, operationId: 'op-tags-0304', changes: { assigneeId: 'user-member-a2', helperIds: ['user-member-a1'] } });
    expect([swapped.status, swapped.json.task.assigneeId, swapped.json.task.helperIds]).toEqual([200, 'user-member-a2', ['user-member-a1']]);
    // Malformed or too many helpers never reach the Task service.
    const before = fake.createCalls;
    expect((await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0305', title: 'x', assigneeId: 'user-member-a1', helperIds: ['User A'] })).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => `user-${i}`);
    expect((await call('POST', '/api/tasks/workspaces/dept-planning/tasks', { operationId: 'op-tags-0306', title: 'x', assigneeId: 'user-member-a1', helperIds: many })).status).toBe(400);
    expect(fake.createCalls).toBe(before);
  });

  it('reports a Task service without the all-department read as a definitive not found', async () => {
    await setup(false);
    expect((await call('GET', '/api/tasks/all')).status).toBe(404);
  });
});
