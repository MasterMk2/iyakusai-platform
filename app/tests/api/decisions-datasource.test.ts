import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOT_DATASOURCE_PATH } from '../../src/server/datasource/bot-datasource.js';
import { DecisionsStore } from '../../src/server/decisions/store.js';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { signRequest } from '../../src/server/tasks/signing.js';
import { CHAIR, MEMBER, setup } from '../discord-auth/helpers.js';
import { EDITOR_A, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// The Bot's signed datasource with the decision register (docs/contracts/bot-datasource.md §2–§3): `decisions` is
// answered only when asked for; the answer carries no IDs of people. Synthetic text only.

const CLIENT = 'iyakusai-bot-datasource';
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));

let dir: string;
let ctx: ReturnType<typeof setup>;
let decisions: DecisionsStore;
let app: FastifyInstance;

async function build(register: DecisionsStore | null) {
  app = await buildApp({
    store: new StateStore({ ...(await seedState()), users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    staticDir: dir,
    clock: () => new Date(ctx.clock.now).toISOString(),
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    botDatasourceKey: KEY,
    decisions: register,
  });
}

async function post(body: string) {
  const timestamp = String(ctx.clock.now);
  const nonce = randomBytes(18).toString('base64url');
  const signature = signRequest(KEY, { client: CLIENT, method: 'POST', path: BOT_DATASOURCE_PATH, timestamp, nonce, actor: '', body });
  const res = await app.inject({
    method: 'POST',
    url: BOT_DATASOURCE_PATH,
    headers: { host: TEST_HOST, 'content-type': 'application/json', 'x-svc-client': CLIENT, 'x-svc-timestamp': timestamp, 'x-svc-nonce': nonce, 'x-svc-signature': signature },
    payload: body,
  });
  return { status: res.statusCode, json: res.statusCode === 200 ? res.json() : null, raw: res.body };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-decisions-datasource-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 太郎' } }));
  ctx = setup();
  decisions = new DecisionsStore(path.join(dir, 'decisions'));
});
afterEach(async () => {
  await app?.close();
  decisions.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Bot datasource with the decision register', () => {
  it('leaves the answer as it was when decisions are not asked for', async () => {
    decisions.create({ title: '合成の決定', body: '', departments: ['planning'], decidedOn: '2026-10-01', venue: 'board', venueOther: '', sources: [], taskIds: [] }, EDITOR_A, '2026-10-02T00:00:00.000Z', null);
    await build(decisions);
    const res = await post('{"sources":["rental","mailbox"]}');
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(['version', 'generatedAt', 'rental', 'mailbox']);
  });

  it('answers the register when asked, with the newest change first and no IDs of people', async () => {
    const first = decisions.create({ title: '古い決定', body: '', departments: ['planning'], decidedOn: '2026-09-01', venue: 'board', venueOther: '', sources: [], taskIds: [] }, EDITOR_A, '2026-10-01T00:00:00.000Z', null).row;
    decisions.create({ title: '新しい決定', body: '本文', departments: ['gaimu'], decidedOn: '2026-10-20', venue: 'other', venueOther: '合成の会議', sources: [], taskIds: [] }, EDITOR_A, '2026-10-21T00:00:00.000Z', null);
    await build(decisions);
    const res = await post('{"sources":["decisions"]}');
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(['version', 'generatedAt', 'rental', 'mailbox', 'decisions']);
    expect(res.json.decisions.items.map((i: { title: string }) => i.title)).toEqual(['新しい決定', '古い決定']);
    expect(res.json.decisions.items[0]).toMatchObject({ body: '本文', departments: ['gaimu'], decidedAt: '2026-10-20', venue: '合成の会議', status: 'active', supersededBy: null, changeNote: '', changedAt: '2026-10-21T00:00:00.000Z' });
    expect(res.json.decisions.items[1].url).toBe(`https://app.example.invalid/#/decisions?d=${first.id}`);
    expect(res.raw).not.toContain(EDITOR_A);
    expect(res.raw).not.toContain(CHAIR);
    expect(res.raw).not.toContain(MEMBER);
  });

  it('accepts all three sources at once, and answers null for the register when it is off', async () => {
    await build(null);
    const res = await post('{"sources":["rental","mailbox","decisions"]}');
    expect(res.status).toBe(200);
    expect(res.json.decisions).toBeNull();
  });

  it('refuses a duplicate source or an unknown one like any other bad request', async () => {
    await build(decisions);
    expect((await post('{"sources":["decisions","decisions"]}')).status).toBe(401);
    expect((await post('{"sources":["decision"]}')).status).toBe(401);
  });
});
