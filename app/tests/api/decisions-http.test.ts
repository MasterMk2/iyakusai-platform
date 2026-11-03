import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { botDecisions } from '../../src/server/decisions/bot.js';
import { DecisionsStore } from '../../src/server/decisions/store.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { ADMIN, EDITOR_A, seedState, T0, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';

// The decision register over HTTP in the demo composition (persona cookie). Synthetic people and text only. The
// temporary-staff persona is added to the state for these tests.

const TEMP = 'u-temp-staff';
const CLIENT_TOKEN = 'tok-0123456789abcdef';

let dir: string;
let decisions: DecisionsStore;
let app: FastifyInstance;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any; raw: string };

async function build(register: DecisionsStore | null = decisions) {
  const seed = await seedState();
  seed.users.push({ id: TEMP, displayName: '合成 臨時', roleLabel: '臨時スタッフ', email: 'temp@example.invalid', canManageAccess: false });
  let tick = 0;
  app = await buildApp({
    store: new StateStore(seed, null),
    listenPort: TEST_PORT,
    clock: () => new Date(Date.parse(T0) + ++tick * 1000).toISOString(),
    decisions: register,
  });
}

async function call(userId: string | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: { host: TEST_HOST, ...(method !== 'GET' ? { origin: `http://${TEST_HOST}`, 'x-smm-csrf': '1' } : {}), ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}) },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  return { status: res.statusCode, json, raw: res.body };
}

const draft = (over: Record<string, unknown> = {}) => ({
  title: '合成の決定',
  body: '',
  departments: ['planning'],
  decidedOn: '2026-10-01',
  venue: 'board',
  venueOther: '',
  sources: [],
  taskIds: [],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-decisions-http-'));
  decisions = new DecisionsStore(dir);
});
afterEach(async () => {
  await app?.close();
  decisions.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('access', () => {
  it('needs a sign-in, and temporary staff are refused even for reading', async () => {
    await build();
    expect((await call(null, 'GET', '/api/decisions')).status).toBe(401);
    expect((await call(null, 'GET', '/api/decisions/meta')).status).toBe(401);
    expect((await call(TEMP, 'GET', '/api/decisions')).status).toBe(403);
    expect((await call(TEMP, 'POST', '/api/decisions', { ...draft(), clientToken: CLIENT_TOKEN })).status).toBe(403);
    expect((await call(TEMP, 'GET', '/api/decisions/meta')).json).toMatchObject({ enabled: false, canRegister: false });
  });

  it('tells a committee member what they may do; only the access administrator may administer', async () => {
    await build();
    expect((await call(EDITOR_A, 'GET', '/api/decisions/meta')).json).toMatchObject({ enabled: true, canRegister: true, canAdminister: false });
    expect((await call(ADMIN, 'GET', '/api/decisions/meta')).json).toMatchObject({ enabled: true, canAdminister: true });
  });

  it('answers 404 for the register itself when it is off, and the meta route says so', async () => {
    await build(null);
    expect((await call(EDITOR_A, 'GET', '/api/decisions')).status).toBe(404);
    expect((await call(EDITOR_A, 'GET', '/api/decisions/meta')).json).toMatchObject({ enabled: false, canRegister: false, departments: [] });
  });
});

describe('registration', () => {
  it('registers a decision, answers a retry with the same token from the first one, and keeps the names out of IDs', async () => {
    await build();
    const sources = [{ kind: 'mail', refId: 'th_0123456789abcdef', label: '合成の案内メール', link: '#/all?thread=th_0123456789abcdef' }];
    const created = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: '案内図は 3 色刷りにする', sources }), clientToken: CLIENT_TOKEN });
    expect(created.status).toBe(201);
    expect(created.json.decision).toMatchObject({ title: '案内図は 3 色刷りにする', status: 'active', editable: true, canRevoke: true, sources: [expect.objectContaining({ link: '#/all?thread=th_0123456789abcdef' })] });
    expect(created.raw).not.toContain(EDITOR_A);
    const retry = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: '案内図は 3 色刷りにする', sources }), clientToken: CLIENT_TOKEN });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ replayed: true, decision: { id: created.json.decision.id, title: '案内図は 3 色刷りにする' } });
    expect(decisions.count()).toBe(1);
  });

  it('refuses a retry with the same token and other content (409), and keeps the first decision as it was', async () => {
    await build();
    const first = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: '最初の内容' }), clientToken: CLIENT_TOKEN });
    expect(first.status).toBe(201);
    const other = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: '直した内容' }), clientToken: CLIENT_TOKEN });
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('conflict');
    expect(decisions.count()).toBe(1);
    expect(decisions.get(first.json.decision.id)!.input.title).toBe('最初の内容');
  });

  it('reserves the tokens of the minutes items for the server (a form cannot take one)', async () => {
    await build();
    const res = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft(), clientToken: 'minutes-mt_0123456789abcdef-0' });
    expect(res.status).toBe(400);
    expect(decisions.count()).toBe(0);
  });

  it('refuses bad input (400 for the shape, 422 for the rules), and nothing is stored', async () => {
    await build();
    // Schema problems answer 400 (the app's request error); the register's own rules answer 422 (a validation error).
    const bad: [string, Record<string, unknown>, number][] = [
      ['empty title', { title: '   ' }, 422],
      ['two-line title', { title: 'a\nb' }, 400],
      ['impossible day', { decidedOn: '2026-02-30' }, 422],
      ['other venue without text', { venue: 'other', venueOther: '' }, 422],
      ['capital department key', { departments: ['Planning'] }, 400],
      ['no department', { departments: [] }, 400],
      ['outside link', { sources: [{ kind: 'manual', refId: null, label: 'x', link: 'https://example.invalid/x' }] }, 422],
      ['script link', { sources: [{ kind: 'manual', refId: null, label: 'x', link: 'javascript:alert(1)' }] }, 422],
      ['unknown field', { status: 'revoked' }, 400],
      ['control character in body', { body: 'a\u0001b' }, 400],
    ];
    for (const [label, over, status] of bad) {
      const res = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft(over), clientToken: `${label.replace(/[^A-Za-z]/g, '-')}-0123456789` });
      expect(res.status, label).toBe(status);
    }
    expect(decisions.count()).toBe(0);
  });
});

describe('lists and details', () => {
  it('filters by department and period, and rejects a period that ends before it starts', async () => {
    await build();
    await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: 'A', departments: ['naimu'], decidedOn: '2026-09-02' }), clientToken: 'tok-aaaaaaaaaaaaaaaa' });
    await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: 'B', departments: ['gaimu'], decidedOn: '2026-10-08' }), clientToken: 'tok-bbbbbbbbbbbbbbbb' });
    const naimu = await call(VIEWER_B, 'GET', '/api/decisions?department=naimu');
    expect(naimu.json.items.map((i: { title: string }) => i.title)).toEqual(['A']);
    const period = await call(VIEWER_B, 'GET', '/api/decisions?from=2026-10-01&to=2026-10-31');
    expect(period.json.total).toBe(1);
    expect((await call(VIEWER_B, 'GET', '/api/decisions?from=2026-10-31&to=2026-10-01')).status).toBe(422);
    // A day that does not exist is refused, not answered with nothing.
    const impossible = await call(VIEWER_B, 'GET', '/api/decisions?from=2026-02-30');
    expect(impossible.status).toBe(422);
    expect(impossible.json.error).toBe('validation');
  });

  it('shows the chain, the history and who may act, without any user ID', async () => {
    await build();
    const first = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: 'A' }), clientToken: 'tok-cccccccccccccccc' });
    const id = first.json.decision.id as string;
    const changed = await call(VIEWER_B, 'POST', `/api/decisions/${id}/change`, { ...draft({ title: 'B' }), expectedVersion: 1, changeNote: '部数を増やした' });
    expect(changed.status).toBe(201);
    expect(changed.json.chain.map((c: { title: string }) => c.title)).toEqual(['A', 'B']);
    expect(changed.json.decision).toMatchObject({ title: 'B', supersedes: id, changeNote: '部数を増やした', canRevoke: true });
    const old = await call(EDITOR_A, 'GET', `/api/decisions/${id}`);
    expect(old.json.decision).toMatchObject({ status: 'changed', editable: false, canRevoke: true });
    expect(old.json.decision.supersededBy).toBe(changed.json.decision.id);
    expect(old.json.history[0]).toMatchObject({ action: 'replaced' });
    expect((await call(VIEWER_B, 'GET', `/api/decisions/${id}`)).json.decision.canRevoke).toBe(false);
    expect(old.raw).not.toMatch(/u-editor|u-viewer|u-admin/);
  });
});

describe('changes, revokes and restores', () => {
  it('replaces an active decision with a new one, refuses a second change or a stale edit, and says why', async () => {
    await build();
    const first = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: 'A' }), clientToken: 'tok-dddddddddddddddd' });
    const id = first.json.decision.id as string;
    expect((await call(EDITOR_A, 'POST', `/api/decisions/${id}/change`, { ...draft({ title: 'B' }), expectedVersion: 1, changeNote: '  ' })).status).toBe(422);
    expect((await call(EDITOR_A, 'POST', `/api/decisions/${id}/change`, { ...draft({ title: 'B' }), expectedVersion: 1, changeNote: '直した' })).status).toBe(201);
    const again = await call(EDITOR_A, 'POST', `/api/decisions/${id}/change`, { ...draft({ title: 'C' }), expectedVersion: 2, changeNote: '二度目' });
    expect(again.status).toBe(409);
    expect(again.json.message).toContain('すでに変更');
    const stale = await call(EDITOR_A, 'PUT', `/api/decisions/${id}`, { ...draft({ title: 'A2' }), expectedVersion: 1 });
    expect(stale.status).toBe(409);
  });

  it('lets only the registrant and the access administrator revoke, and restore the decision it replaced', async () => {
    await build();
    const first = await call(EDITOR_A, 'POST', '/api/decisions', { ...draft({ title: 'A' }), clientToken: 'tok-eeeeeeeeeeeeeeee' });
    const id = first.json.decision.id as string;
    const changed = await call(EDITOR_A, 'POST', `/api/decisions/${id}/change`, { ...draft({ title: 'B' }), expectedVersion: 1, changeNote: 'A→B' });
    const newId = changed.json.decision.id as string;
    expect((await call(VIEWER_B, 'POST', `/api/decisions/${newId}/revoke`, { expectedVersion: 1, note: '' })).status).toBe(403);
    const revoked = await call(EDITOR_A, 'POST', `/api/decisions/${newId}/revoke`, { expectedVersion: 1, note: '違っていた' });
    expect(revoked.status).toBe(200);
    expect(revoked.json.decision).toMatchObject({ status: 'revoked', revokeNote: '違っていた' });
    expect((await call(EDITOR_A, 'GET', `/api/decisions/${id}`)).json.decision).toMatchObject({ status: 'active', editable: true });
    expect((await call(EDITOR_A, 'POST', `/api/decisions/${newId}/restore`, { expectedVersion: 2 })).status).toBe(200);
    expect((await call(EDITOR_A, 'GET', `/api/decisions/${id}`)).json.decision.status).toBe('changed');
    expect((await call(EDITOR_A, 'POST', `/api/decisions/${newId}/restore`, { expectedVersion: 3 })).status).toBe(409);
  });
});

describe('the Bot view of the register', () => {
  it('lists the newest changes with a link and no names (the datasource answers it only when asked)', async () => {
    const one = decisions.create(
      { title: '合成', body: '本文', departments: ['planning'], decidedOn: '2026-10-01', venue: 'board', venueOther: '', sources: [], taskIds: [] },
      EDITOR_A,
      '2026-11-01T00:00:00.000Z',
      null,
    ).row;
    const view = botDecisions(decisions, 'https://app.example.invalid');
    expect(view.items).toEqual([
      {
        id: one.id,
        title: '合成',
        body: '本文',
        departments: ['planning'],
        decidedAt: '2026-10-01',
        venue: '役員会',
        status: 'active',
        supersededBy: null,
        changeNote: '',
        changedAt: '2026-11-01T00:00:00.000Z',
        url: `https://app.example.invalid/#/decisions?d=${one.id}`,
      },
    ]);
    expect(JSON.stringify(view)).not.toContain(EDITOR_A);
    expect(botDecisions(decisions, null).items[0]!.url).toBeNull();
  });
});
