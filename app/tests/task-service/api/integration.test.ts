import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryView, TaskView } from '../../../src/task-service/shared/types.js';
import type { TaskService } from '../../../src/task-service/server/domain/taskService.js';
import { buildIntegrationApp, INTEGRATION_PREFIX } from '../../../src/task-service/server/integration/app.js';
import { parseDiscordBindings } from '../../../src/task-service/server/integration/config.js';
import { discordCommandSchema, type DiscordCommand } from '../../../src/task-service/server/integration/discordBridge.js';
import { signedHeaders, SVC_HEADERS, type ClientId } from '../../../src/task-service/server/integration/signing.js';
import { readFileSync } from 'node:fs';
import { FIXED_NOW, setup } from '../helpers.js';

const GUILD = '1000000000000000001';
const PLANNING_CHANNEL = '1000000000000000101';
const PUBLICITY_CHANNEL = '1000000000000000102';
const D = {
  chairA: '1000000000000001001',
  memberA1: '1000000000000001002',
  memberA2: '1000000000000001003',
  observerA: '1000000000000001004',
  memberB1: '1000000000000001007',
};

const gatewayKey = randomBytes(32);
const bridgeKey = randomBytes(32);
const keys = new Map<ClientId, Buffer>([
  ['web-gateway', gatewayKey],
  ['discord-bridge', bridgeKey],
]);
const bindings = parseDiscordBindings(readFileSync('deploy/task-service/discord-bindings.synthetic.json', 'utf8'));

let app: FastifyInstance;
let service: TaskService;
let clock = FIXED_NOW.getTime();

beforeEach(async () => {
  clock = FIXED_NOW.getTime();
  ({ service } = await setup());
  app = await buildIntegrationApp({ service, keys, trustedClients: new Set(['127.0.0.1']), discord: bindings, now: () => clock });
});
afterEach(async () => {
  await app.close();
});

interface Call {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  actor?: string;
  client?: ClientId;
  key?: Buffer;
  headers?: Record<string, string>;
}

function signed(call: Call) {
  const body = call.body === undefined ? '' : JSON.stringify(call.body);
  const client = call.client ?? 'web-gateway';
  const headers = signedHeaders(call.key ?? keys.get(client)!, { client, method: call.method, path: call.path, body, actor: call.actor ?? null, now: clock });
  return app.inject({
    method: call.method,
    url: call.path,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers, ...call.headers },
    ...(body ? { payload: body } : {}),
  });
}

const gw = (actor: string, method: Call['method'], path: string, body?: unknown) => signed({ method, path: `${INTEGRATION_PREFIX}${path}`, actor, body });

const discord = (userId: string, channelId: string, interactionId: string, command: Record<string, unknown>, guildId = GUILD) =>
  signed({ method: 'POST', path: `${INTEGRATION_PREFIX}/discord/commands`, client: 'discord-bridge', body: { interactionId, guildId, channelId, userId, command } });

async function createViaGateway(actor = 'user-member-a1', operationId = 'gw-create-0001', extra: Record<string, unknown> = {}) {
  const res = await gw(actor, 'POST', '/workspaces/ws-planning/tasks', { title: '受信案件の対応', operationId, ...extra });
  return res;
}

describe('service-to-service authentication', () => {
  it('rejects unsigned, wrongly signed, tampered, replayed and stale requests', async () => {
    const path = `${INTEGRATION_PREFIX}/me`;
    expect((await app.inject({ method: 'GET', url: path, headers: { 'x-demo-user': 'user-chair-a', [SVC_HEADERS.actor]: 'user-chair-a' } })).statusCode).toBe(401);
    expect((await signed({ method: 'GET', path, actor: 'user-chair-a', key: randomBytes(32) })).statusCode).toBe(401);

    // Signature over one body, a different body sent.
    const body = JSON.stringify({ title: 'A', operationId: 'gw-tamper-01' });
    const headers = signedHeaders(gatewayKey, { client: 'web-gateway', method: 'POST', path: `${INTEGRATION_PREFIX}/workspaces/ws-planning/tasks`, body, actor: 'user-member-a1', now: clock });
    const tampered = await app.inject({
      method: 'POST',
      url: `${INTEGRATION_PREFIX}/workspaces/ws-planning/tasks`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({ title: 'B', operationId: 'gw-tamper-01' }),
    });
    expect(tampered.statusCode).toBe(401);
    // Actor swapped after signing.
    const swapped = await app.inject({ method: 'GET', url: path, headers: { ...signedHeaders(gatewayKey, { client: 'web-gateway', method: 'GET', path, body: '', actor: 'user-member-a1', now: clock }), [SVC_HEADERS.actor]: 'user-chair-a' } });
    expect(swapped.statusCode).toBe(401);

    const once = signedHeaders(gatewayKey, { client: 'web-gateway', method: 'GET', path, body: '', actor: 'user-member-a1', now: clock });
    expect((await app.inject({ method: 'GET', url: path, headers: once })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: path, headers: once })).statusCode).toBe(401);

    const stale = signedHeaders(gatewayKey, { client: 'web-gateway', method: 'GET', path, body: '', actor: 'user-member-a1', now: clock - 31_000 });
    expect((await app.inject({ method: 'GET', url: path, headers: stale })).statusCode).toBe(401);
  });

  it('accepts only allowlisted socket addresses, including for health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '192.0.2.10' });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/api/health' });
    expect(ok.json()).toEqual({ ok: true });
  });

  it('has no demo login, personas, mock bot, fault or reset endpoints', async () => {
    for (const [method, url] of [
      ['GET', '/api/personas'],
      ['GET', '/api/me'],
      ['POST', '/api/mock-bot/messages'],
      ['PUT', '/api/demo/faults'],
      ['POST', '/api/demo/reset'],
      ['GET', '/'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { 'x-demo-user': 'user-chair-a' } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('separates the gateway and the Discord bridge clients', async () => {
    // Bridge key cannot act as the gateway; gateway cannot drive Discord commands.
    expect((await signed({ method: 'GET', path: `${INTEGRATION_PREFIX}/me`, client: 'discord-bridge', actor: 'user-chair-a' })).statusCode).toBe(403);
    const asGateway = await signed({
      method: 'POST',
      path: `${INTEGRATION_PREFIX}/discord/commands`,
      actor: 'user-chair-a',
      body: { interactionId: 'x1234567', guildId: GUILD, channelId: PLANNING_CHANNEL, userId: D.chairA, command: { name: 'list' } },
    });
    expect(asGateway.statusCode).toBe(403);
    // A bridge request may not carry an actor header.
    const withActor = await signed({
      method: 'POST',
      path: `${INTEGRATION_PREFIX}/discord/commands`,
      client: 'discord-bridge',
      actor: 'user-chair-a',
      body: { interactionId: 'x1234568', guildId: GUILD, channelId: PLANNING_CHANNEL, userId: D.chairA, command: { name: 'list' } },
    });
    expect(withActor.statusCode).toBe(403);
  });
});

describe('gateway task operations use the same domain rules', () => {
  it('returns only the actor memberships and member lists without email', async () => {
    const me = await gw('user-member-a1', 'GET', '/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().memberships.map((m: { workspace: { id: string } }) => m.workspace.id).sort()).toEqual(['ws-planning', 'ws-publicity']);
    expect(JSON.stringify(me.json())).not.toContain('@');
    const members = await gw('user-member-a1', 'GET', '/workspaces/ws-planning/members');
    expect(members.statusCode).toBe(200);
    expect(JSON.stringify(members.json())).not.toContain('@');
    expect((await gw('user-member-b1', 'GET', '/workspaces/ws-planning/members')).statusCode).toBe(403);
    expect((await gw('nobody', 'GET', '/me')).statusCode).toBe(401);
  });

  it('requires an operation ID and creates exactly one task per ID', async () => {
    expect((await gw('user-member-a1', 'POST', '/workspaces/ws-planning/tasks', { title: '受信案件の対応' })).statusCode).toBe(400);
    const first = await createViaGateway('user-member-a1', 'gw-create-0001', { assigneeId: 'user-member-a2', deadline: '2026-10-20', requirements: { purpose: '目的' } });
    expect(first.statusCode).toBe(201);
    const again = await createViaGateway('user-member-a1', 'gw-create-0001', { assigneeId: 'user-member-a2', deadline: '2026-10-20', requirements: { purpose: '目的' } });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(again.json().task.id).toBe(first.json().task.id);
    const conflict = await createViaGateway('user-member-a1', 'gw-create-0001', { assigneeId: null });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(conflict.json().error).not.toHaveProperty('current');
    const list = (await gw('user-member-a1', 'GET', '/workspaces/ws-planning/tasks')).json() as TaskView[];
    expect(list.filter((t) => t.title === '受信案件の対応')).toHaveLength(1);
  });

  it('rejects viewers, other committees and ineligible assignees', async () => {
    expect((await createViaGateway('user-observer-a', 'gw-viewer-01')).statusCode).toBe(403);
    expect((await gw('user-member-b1', 'POST', '/workspaces/ws-planning/tasks', { title: 'x', operationId: 'gw-other-001' })).statusCode).toBe(403);
    const otherCommittee = await createViaGateway('user-member-a1', 'gw-assign-01', { assigneeId: 'user-member-b1' });
    expect(otherCommittee.statusCode).toBe(400);
    expect(otherCommittee.json().error.details[0].path).toBe('assigneeId');
    expect((await createViaGateway('user-member-a1', 'gw-assign-02', { assigneeId: 'user-former-a3' })).statusCode).toBe(400);
    // Direct ID of another committee's task is indistinguishable from a missing one.
    expect((await gw('user-member-b1', 'GET', '/tasks/task-1')).statusCode).toBe(404);
    expect((await gw('user-member-b1', 'GET', '/tasks/task-1/history')).statusCode).toBe(404);
    expect((await gw('user-member-b1', 'GET', '/tasks/task-999')).statusCode).toBe(404);
  });
});

describe('Discord bridge (mock transport over the production contract)', () => {
  it('changes the task created through the gateway; both sides see the same ID, version and history', async () => {
    const created = (await createViaGateway()).json().task as TaskView;
    const res = await discord(D.memberA2, PLANNING_CHANNEL, '1100000000000000001', { name: 'status', taskId: created.id, to: 'in_progress', version: created.version });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, replayed: false, task: { id: created.id, status: 'in_progress', version: 2 } });
    const assigned = await discord(D.memberA2, PLANNING_CHANNEL, '1100000000000000002', { name: 'assign', taskId: created.id, assignee: 'me', version: 2 });
    expect(assigned.json().task).toMatchObject({ assigneeId: 'user-member-a2', version: 3 });

    const viaWeb = (await gw('user-member-a1', 'GET', `/tasks/${created.id}`)).json() as TaskView;
    expect(viaWeb).toMatchObject({ id: created.id, status: 'in_progress', assigneeId: 'user-member-a2', version: 3 });
    const history = (await gw('user-member-a1', 'GET', `/tasks/${created.id}/history`)).json() as HistoryView[];
    expect(history.map((h) => [h.version, h.source])).toEqual([
      [3, 'discord'],
      [2, 'discord'],
      [1, 'web'],
    ]);

    // Web then edits on top of the Discord change with the current version.
    const patched = await gw('user-member-a1', 'PATCH', `/tasks/${created.id}`, { expectedVersion: 3, operationId: 'gw-patch-0001', changes: { deadline: '2026-10-30' } });
    expect(patched.statusCode).toBe(200);
    const shown = await discord(D.observerA, PLANNING_CHANNEL, '1100000000000000003', { name: 'show', taskId: created.id });
    expect(shown.json().task).toMatchObject({ deadline: '2026-10-30', version: 4 });
  });

  it('treats a redelivered interaction as a replay only in the same guild/channel', async () => {
    const command = { name: 'status', taskId: 'task-1', to: 'blocked', version: 1 };
    const first = await discord(D.memberA1, PLANNING_CHANNEL, '1100000000000000010', command);
    expect(first.json()).toMatchObject({ ok: true, replayed: false });
    const again = await discord(D.memberA1, PLANNING_CHANNEL, '1100000000000000010', command);
    expect(again.json()).toMatchObject({ ok: true, replayed: true, task: { version: 2 } });
    const historyBefore = await service.getHistory('user-chair-a', 'task-1');

    // Same actor + interaction ID from another channel: refused, task-1 not returned, no history change.
    const crossChannel = await discord(D.memberA1, PUBLICITY_CHANNEL, '1100000000000000010', command);
    expect(crossChannel.statusCode).toBe(409);
    expect(JSON.stringify(crossChannel.json())).not.toContain('task-1');
    expect(await service.getHistory('user-chair-a', 'task-1')).toEqual(historyBefore);
  });

  it('denies unbound guilds, channels and users without revealing which', async () => {
    const unknownGuild = await discord(D.memberA1, PLANNING_CHANNEL, '1100000000000000020', { name: 'list' }, '1000000000000000999');
    const unknownChannel = await discord(D.memberA1, '1000000000000000999', '1100000000000000021', { name: 'list' });
    const unknownUser = await discord('1000000000000009999', PLANNING_CHANNEL, '1100000000000000022', { name: 'list' });
    for (const res of [unknownGuild, unknownChannel, unknownUser]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(unknownGuild.json().error.message);
    }
  });

  it('applies committee roles and channel scope', async () => {
    // Viewer cannot change; another committee's task via this channel is not found.
    expect((await discord(D.observerA, PLANNING_CHANNEL, '1100000000000000030', { name: 'status', taskId: 'task-1', to: 'done', version: 1 })).statusCode).toBe(403);
    expect((await discord(D.memberB1, PUBLICITY_CHANNEL, '1100000000000000031', { name: 'show', taskId: 'task-1' })).statusCode).toBe(404);
    // A member of another committee in this channel has no membership here.
    expect((await discord(D.memberB1, PLANNING_CHANNEL, '1100000000000000032', { name: 'list' })).statusCode).toBe(403);
    // Assigning someone from another committee is rejected.
    const bad = await discord(D.memberA1, PLANNING_CHANNEL, '1100000000000000033', { name: 'assign', taskId: 'task-1', assignee: D.memberB1, version: 1 });
    expect(bad.statusCode).toBe(400);
    // Malformed commands (free text, unknown names, display names) are rejected.
    expect((await discord(D.memberA1, PLANNING_CHANNEL, '1100000000000000034', { name: 'delete', taskId: 'task-1' })).statusCode).toBe(400);
    expect((await discord(D.memberA1, PLANNING_CHANNEL, '1100000000000000035', { name: 'assign', taskId: 'task-1', assignee: '委員 A2', version: 1 })).statusCode).toBe(400);
  });

  it('makes version a required field of the typed mutation contract', () => {
    type Mutation = Extract<DiscordCommand['command'], { name: 'assign' | 'status' | 'deadline' | 'require' | 'reopen' }>;
    // Compile-time: every mutation variant carries a required numeric version (typecheck gate).
    const versionOf = (m: Mutation): number => m.version;
    // @ts-expect-error a reopen without version is not a valid typed command
    const missing: Mutation = { name: 'reopen', taskId: 'task-1' };
    expect(versionOf({ name: 'reopen', taskId: 'task-1', version: 3 })).toBe(3);
    expect(discordCommandSchema.safeParse({ interactionId: '1100000000000000099', guildId: GUILD, channelId: PLANNING_CHANNEL, userId: D.memberA1, command: missing }).success).toBe(false);
  });

  it('requires a valid version on every mutation of an existing task, before reading it', async () => {
    const created = (await createViaGateway()).json().task as TaskView;
    const historyBefore = await service.getHistory('user-member-a1', created.id);
    const mutations: Record<string, unknown>[] = [
      { name: 'assign', taskId: created.id, assignee: 'me' },
      { name: 'status', taskId: created.id, to: 'in_progress' },
      { name: 'deadline', taskId: created.id, date: '2026-11-30' },
      { name: 'require', taskId: created.id, field: 'purpose', text: '版なしの変更' },
      { name: 'reopen', taskId: created.id },
    ];
    const invalid: [string, Record<string, unknown>][] = [
      ['omitted', {}],
      ['null', { version: null }],
      ['string', { version: '1' }],
      ['fraction', { version: 1.5 }],
      ['zero', { version: 0 }],
      ['negative', { version: -1 }],
      ['unsafe integer', { version: 2 ** 60 }],
    ];
    let seq = 100;
    const messages = new Set<string>();
    for (const command of mutations) {
      for (const [, version] of invalid) {
        // Also against a task that does not exist: the answer must not reveal which one exists.
        for (const taskId of [created.id, 'task-999']) {
          const res = await discord(D.memberA2, PLANNING_CHANNEL, `11000000000000${seq++}`, { ...command, taskId, ...version });
          expect(res.statusCode).toBe(400);
          const body = res.json();
          expect(body.error.code).toBe('VALIDATION');
          expect(body.task).toBeUndefined();
          expect(JSON.stringify(body)).not.toContain(created.title);
          messages.add(JSON.stringify(body.error));
        }
      }
    }
    // One uniform validation answer for every command, every invalid version and either task.
    expect(messages.size).toBe(1);
    expect([...messages].every((m) => m.includes('version'))).toBe(true);
    const viaWeb = (await gw('user-member-a1', 'GET', `/tasks/${created.id}`)).json() as TaskView;
    expect(viaWeb).toMatchObject({ version: 1, status: 'todo', assigneeId: created.assigneeId, deadline: created.deadline });
    expect(await service.getHistory('user-member-a1', created.id)).toEqual(historyBefore);
    // Interaction IDs refused for validation are not consumed: the same ID with a valid version works once.
    const ok = await discord(D.memberA2, PLANNING_CHANNEL, '11000000000000100', { name: 'status', taskId: created.id, to: 'in_progress', version: 1 });
    expect(ok.json()).toMatchObject({ ok: true, replayed: false, task: { version: 2 } });
  });

  it('keeps stale-version conflicts for Discord mutations', async () => {
    const created = (await createViaGateway()).json().task as TaskView;
    expect((await discord(D.memberA1, PLANNING_CHANNEL, '1100000000000000050', { name: 'deadline', taskId: created.id, date: '2026-11-01', version: 1 })).statusCode).toBe(200);
    const stale = await discord(D.memberA2, PLANNING_CHANNEL, '1100000000000000051', { name: 'status', taskId: created.id, to: 'blocked', version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const current = (await gw('user-member-a1', 'GET', `/tasks/${created.id}`)).json() as TaskView;
    expect(current).toMatchObject({ status: 'todo', deadline: '2026-11-01', version: 2 });
  });

  it('lets exactly one of a concurrent Web and Discord update at the same version succeed', async () => {
    const created = (await createViaGateway()).json().task as TaskView;
    const [web, bot] = await Promise.all([
      gw('user-member-a1', 'PATCH', `/tasks/${created.id}`, { expectedVersion: 1, operationId: 'gw-race-0001', changes: { status: 'blocked' } }),
      discord(D.memberA2, PLANNING_CHANNEL, '1100000000000000040', { name: 'status', taskId: created.id, to: 'in_progress', version: 1 }),
    ]);
    const codes = [web.statusCode, bot.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = web.statusCode === 409 ? web : bot;
    expect(loser.json().error.code).toBe('VERSION_CONFLICT');
    const history = await service.getHistory('user-member-a1', created.id);
    expect(history).toHaveLength(2);
  });
});
