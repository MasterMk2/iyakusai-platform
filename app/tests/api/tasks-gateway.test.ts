import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { MockLinePushConnector } from '../../src/server/line/connector.js';
import { createLineSeedState } from '../../src/server/line/seed.js';
import { LineStore } from '../../src/server/line/store.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON } from '../../src/server/tasks/bridge.js';
import { TaskServiceClient } from '../../src/server/tasks/client.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import { ADMIN, EDITOR_A, EDITOR_C, NOACCESS_D, R, seedState, T0, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';
import { CONV } from '../line-helpers.js';
import { startTaskFake, type TaskFake } from '../task-fake.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

let fake: TaskFake;
let app: FastifyInstance;
let mail: StateStore;
let links: TaskLinkStore;

beforeEach(async () => {
  fake = await startTaskFake();
  mail = new StateStore(await seedState(), null);
  const lineStore = new LineStore(createLineSeedState(T0, { replyGrants: true }), null);
  links = new TaskLinkStore(emptyLinkState(), null);
  app = await buildApp({
    store: mail,
    listenPort: TEST_PORT,
    clock: () => new Date().toISOString(),
    line: { store: lineStore, connector: new MockLinePushConnector(), seed: (at) => createLineSeedState(at, { replyGrants: true }) },
    tasks: { client: new TaskServiceClient({ baseUrl: fake.url, key: fake.key, timeoutMs: 2_000 }), bridge: parseTaskBridge(SYNTHETIC_TASK_BRIDGE_JSON), links },
  });
});
afterEach(async () => {
  await app.close();
  await fake.close();
});

async function call(userId: string | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method,
    url,
    headers: { host: TEST_HOST, ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}), ...headers },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  let json: unknown;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.statusCode, json: json as any, raw: res.body };
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

const subjectOf = (receiptId: string) => {
  const receipt = mail.current.receipts.find((r) => r.id === receiptId)!;
  return mail.current.messages.find((m) => m.id === receipt.messageId)!.subject;
};

describe('task context and identity bridge', () => {
  it('distinguishes bound, inbox-only and unbound users without trusting headers', async () => {
    const both = await call(EDITOR_A, 'GET', '/api/tasks/context');
    expect(both.json).toMatchObject({ enabled: true, bound: true });
    expect(both.json.memberships.map((m: { workspace: { id: string } }) => m.workspace.id).sort()).toEqual(['ws-planning', 'ws-publicity']);
    expect((await call(VIEWER_B, 'GET', '/api/tasks/context')).json).toEqual({ enabled: true, bound: false, memberships: [] });
    expect((await call(ADMIN, 'GET', '/api/tasks/context')).json).toEqual({ enabled: true, bound: false, memberships: [] });
    expect((await call(VIEWER_B, 'GET', '/api/tasks/workspaces/ws-planning/tasks')).status).toBe(403);
    expect((await call(null, 'GET', '/api/tasks/context')).status).toBe(401);
    // A forged service actor header from the browser changes nothing.
    const forged = await call(VIEWER_B, 'GET', '/api/tasks/workspaces/ws-planning/tasks', undefined, { 'x-svc-actor': 'user-member-a1', 'x-demo-user': 'user-member-a1' });
    expect(forged.status).toBe(403);
  });

  it('lets a task-only user work with tasks but not with any mailbox', async () => {
    expect((await call(NOACCESS_D, 'GET', '/api/tasks/workspaces/ws-planning/tasks')).status).toBe(200);
    const created = await call(NOACCESS_D, 'POST', '/api/tasks/workspaces/ws-planning/tasks', { operationId: 'op-only-0001', title: '会場の確認' });
    expect(created.status).toBe(201);
    expect((await call(NOACCESS_D, 'GET', '/api/mailboxes')).json).toEqual([]);
    expect((await call(NOACCESS_D, 'GET', `/api/receipts/${R.supportLogin}`)).status).toBe(404);
  });

  it('maps Task-service denials and hides the history operation IDs', async () => {
    expect((await call(EDITOR_C, 'GET', '/api/tasks/workspaces/ws-planning/tasks')).status).toBe(403);
    const created = await call(EDITOR_A, 'POST', '/api/tasks/workspaces/ws-planning/tasks', { operationId: 'op-hist-0001', title: '議題案' });
    expect((await call(EDITOR_C, 'GET', `/api/tasks/${created.json.task.id}`)).status).toBe(404);
    const history = await call(EDITOR_A, 'GET', `/api/tasks/${created.json.task.id}/history`);
    expect(history.status).toBe(200);
    expect(history.raw).not.toContain('secret-op');
    expect(history.json[0]).not.toHaveProperty('operationId');
  });
});

describe('create a task from a received mail case', () => {
  it('requires source read access and task permission, and creates one linked task', async () => {
    const res = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, caseInput());
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ linked: true, replayed: false, task: { workspaceId: 'ws-planning', assigneeId: 'user-member-a2', deadline: '2026-10-20' } });
    // No automatic copy of the subject or body into task fields.
    expect(JSON.stringify(fake.tasks.get(res.json.task.id))).not.toContain(subjectOf(R.supportLogin));
    const detail = await call(EDITOR_A, 'GET', `/api/tasks/${res.json.task.id}`);
    expect(detail.json.provenance).toEqual([{ kind: 'mail', label: subjectOf(R.supportLogin), href: expect.stringContaining('#/mailbox/mbx-support?thread=') }]);
    const caseTasks = await call(EDITOR_A, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`);
    expect(caseTasks.json).toMatchObject({ canCreate: true, unavailable: false, pending: [], tasks: [{ id: res.json.task.id }] });
  });

  it('never calls the Task service for a case the user cannot read, nor reveals it', async () => {
    const calls = fake.createCalls;
    const denied = await call(NOACCESS_D, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, caseInput());
    const missing = await call(NOACCESS_D, 'POST', `/api/cases/mail/rc_0000000000000000/tasks`, caseInput());
    expect(denied.status).toBe(404);
    expect(denied.json).toEqual(missing.json);
    expect(fake.createCalls).toBe(calls);
    expect((await call(NOACCESS_D, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`)).status).toBe(404);
    // Inbox-only reader (read access, no task identity): refused before anything is created.
    expect((await call(VIEWER_B, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, caseInput())).status).toBe(403);
    expect(fake.createCalls).toBe(calls);
  });

  it('rejects an assignee outside the committee and a viewer-only committee without leaving a pending record', async () => {
    const outsider = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, caseInput({ assigneeId: 'user-chair-b' }));
    expect(outsider.status).toBe(400);
    expect(outsider.json.details[0].path).toBe('assigneeId');
    const viewerCommittee = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, caseInput({ workspaceId: 'ws-publicity', assigneeId: null }));
    expect(viewerCommittee.status).toBe(403);
    expect(links.current.operations).toEqual([]);
    expect(links.current.links).toEqual([]);
    expect(fake.tasks.size).toBe(0);
    // Corrected resend with the same operation succeeds once.
    const fixed = caseInput({ assigneeId: null });
    expect((await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, fixed)).status).toBe(201);
    expect((await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, fixed)).status).toBe(200);
    expect(fake.tasks.size).toBe(1);
  });

  it('shows provenance only to viewers who may read the source now; revocation removes it even for the creator', async () => {
    const created = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, caseInput());
    const taskId = created.json.task.id as string;
    // Task-only reader in the same committee: task fields yes, provenance nothing at all.
    const taskOnly = await call(NOACCESS_D, 'GET', `/api/tasks/${taskId}`);
    expect(taskOnly.status).toBe(200);
    expect(taskOnly.json.provenance).toEqual([]);
    expect(taskOnly.raw).not.toContain(subjectOf(R.supportLogin));
    expect(taskOnly.raw).not.toContain(R.supportLogin);
    expect(taskOnly.raw).not.toContain('mbx-support');

    const before = mail.current.accessVersion;
    const revoke = await call(ADMIN, 'PUT', '/api/admin/access', { userId: EDITOR_A, mailboxId: 'mbx-support', level: 'none', expectedVersion: before });
    expect(revoke.status).toBe(200);
    const creator = await call(EDITOR_A, 'GET', `/api/tasks/${taskId}`);
    expect(creator.status).toBe(200);
    expect(creator.json.task.title).toBe('受信案件の対応');
    expect(creator.json.provenance).toEqual([]);
    expect(creator.raw).not.toContain(subjectOf(R.supportLogin));
    // The case itself and its link listing are gone for the revoked creator too.
    expect((await call(EDITOR_A, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`)).status).toBe(404);
    // A retry of the same submission after revocation is refused before the idempotency lookup.
    expect((await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, caseInput())).status).toBe(404);
  });

  it('deduplicates retries and concurrent clicks; a changed payload under the same operation is refused without data', async () => {
    const input = caseInput();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input)));
    expect([a!.status, b!.status, c!.status].sort()).toEqual([200, 200, 201]);
    expect(new Set([a!.json.task.id, b!.json.task.id, c!.json.task.id]).size).toBe(1);
    expect(fake.tasks.size).toBe(1);
    expect(links.current.links).toHaveLength(1);
    const changed = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, { ...input, title: '別のタイトル' });
    expect(changed.status).toBe(409);
    expect(changed.json).not.toHaveProperty('task');
    expect(changed.raw).not.toContain(a!.json.task.id);
    // Same client operation ID from another user is a different operation (no cross-user result).
    const other = await call(NOACCESS_D, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(other.status).toBe(404);
  });

  it('recovers a lost response after the task was applied, without a duplicate', async () => {
    fake.faults.push('lost-after-apply');
    const input = caseInput();
    const lost = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(lost.status).toBe(503);
    expect(lost.json.error).toBe('task_service_unavailable');
    expect(fake.tasks.size).toBe(1);
    expect(links.current.links).toHaveLength(0);
    const pending = await call(EDITOR_A, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`);
    expect(pending.json.pending).toHaveLength(1);
    expect(pending.json.pending[0].clientOperationId).toBe(input.clientOperationId);
    // Another user never sees someone else's pending submission.
    expect((await call(VIEWER_B, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`)).json.pending).toEqual([]);
    const retry = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(retry.status).toBe(200);
    expect(retry.json.replayed).toBe(true);
    expect(fake.tasks.size).toBe(1);
    expect(links.current.links).toHaveLength(1);
    expect((await call(EDITOR_A, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`)).json.pending).toEqual([]);
  });

  it('reports an unavailable Task service, keeps the submission pending and resolves it later', async () => {
    fake.faults.push('unavailable');
    const input = caseInput();
    const down = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(down.status).toBe(503);
    expect(fake.tasks.size).toBe(0);
    expect((await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input)).status).toBe(201);
    expect(fake.tasks.size).toBe(1);

    // Whole service gone: reads report unavailability, never a stale or guessed answer.
    await fake.close();
    expect((await call(EDITOR_A, 'GET', '/api/tasks/context')).status).toBe(503);
    const caseView = await call(EDITOR_A, 'GET', `/api/cases/mail/${R.supportLogin}/tasks`);
    expect(caseView.json).toMatchObject({ unavailable: true, tasks: [] });
  });

  it('reports a link-storage failure after the task was created and links on retry', async () => {
    const input = caseInput();
    const original = links.transact.bind(links);
    let calls = 0;
    links.transact = ((fn: Parameters<typeof original>[0]) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full (simulated)');
      return original(fn);
    }) as typeof links.transact;
    const first = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(first.status).toBe(503);
    expect(first.json.error).toBe('link_pending');
    expect(fake.tasks.size).toBe(1);
    const retry = await call(EDITOR_A, 'POST', `/api/cases/mail/${R.supportLogin}/tasks`, input);
    expect(retry.status).toBe(200);
    expect(fake.tasks.size).toBe(1);
    expect(links.current.links).toHaveLength(1);
  });
});

describe('create a task from a LINE case', () => {
  it('uses the per-account LINE ACL and shows LINE provenance only to LINE readers', async () => {
    const res = await call(EDITOR_C, 'POST', `/api/cases/line/${CONV.l1}/tasks`, caseInput({ workspaceId: 'ws-publicity', assigneeId: 'user-member-b1' }));
    expect(res.status).toBe(201);
    const detail = await call(EDITOR_C, 'GET', `/api/tasks/${res.json.task.id}`);
    expect(detail.json.provenance).toEqual([{ kind: 'line', label: expect.any(String), href: expect.stringContaining(`?conv=${CONV.l1}`) }]);
    // Editor A has no LINE access: cannot create from it, and as a publicity viewer sees the task without provenance.
    expect((await call(EDITOR_A, 'POST', `/api/cases/line/${CONV.l1}/tasks`, caseInput())).status).toBe(404);
    const otherReader = await call(EDITOR_A, 'GET', `/api/tasks/${res.json.task.id}`);
    expect(otherReader.status).toBe(200);
    expect(otherReader.json.provenance).toEqual([]);
    expect(otherReader.raw).not.toContain(CONV.l1);
  });
});
