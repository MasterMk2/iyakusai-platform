import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON } from '../../src/server/tasks/bridge.js';
import { TaskServiceClient } from '../../src/server/tasks/client.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import { EDITOR_A, VIEWER_B, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { startTaskFake, type TaskFake } from '../task-fake.js';
let fake: TaskFake, app: FastifyInstance;
beforeEach(async () => {
  fake = await startTaskFake({ departments: true });
  app = await buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT,
    tasks: { client: new TaskServiceClient({ baseUrl: fake.url, key: fake.key }), bridge: parseTaskBridge(SYNTHETIC_TASK_BRIDGE_JSON), links: new TaskLinkStore(emptyLinkState(), null) } });
});
afterEach(async () => { await app.close(); await fake.close(); });
const call = (cookie: string | null = EDITOR_A) => app.inject({ method: 'GET', url: '/api/tasks/summary', headers: { host: TEST_HOST, ...(cookie ? { cookie: SESSION_COOKIE + '=' + cookie } : {}) } });
describe('task summary gateway', () => {
  it('uses one signed summary request and never fans out to workspace lists', async () => {
    const result = await call();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ total: 0, departments: [{ workspaceId: 'dept-planning', remaining: 0 }, { workspaceId: 'dept-publicity', remaining: 0 }] });
    expect(fake.summaryCalls).toBe(1);
    expect(fake.listCalls).toBe(0);
  });
  it('does not reveal counts to anonymous or unbound accounts', async () => {
    expect((await call(null)).statusCode).toBe(401);
    expect((await call(VIEWER_B)).statusCode).toBe(403);
    expect(fake.summaryCalls).toBe(0);
  });
  it('returns unavailable on an upstream failure, never fabricated zeros', async () => {
    fake.faults.push('unavailable');
    const result = await call();
    expect(result.statusCode).toBe(503);
    expect(result.json()).not.toHaveProperty('total');
    expect(fake.listCalls).toBe(0);
  });
});
