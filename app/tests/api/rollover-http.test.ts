import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalendarStore } from '../../src/server/calendar/store.js';
import { DecisionsStore } from '../../src/server/decisions/store.js';
import { StateStore } from '../../src/server/domain/store.js';
import type { AppState } from '../../src/server/domain/types.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { OrganizationsStore } from '../../src/server/organizations/store.js';
import { markedMemo } from '../../src/server/rollover/calendar.js';
import { nextYearOrg } from '../../src/server/rollover/organizations.js';
import { RolloverStore } from '../../src/server/rollover/store.js';
import { parseTaskBridge } from '../../src/server/tasks/bridge.js';
import { InProcessTaskBackend } from '../../src/server/tasks/in-process.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';
import type { TaskRuntime } from '../../src/server/tasks/routes.js';
import { TaskService } from '../../src/task-service/server/domain/taskService.js';
import { FaultInjector } from '../../src/task-service/server/storage/faults.js';
import { MemoryStore } from '../../src/task-service/server/storage/memoryStore.js';
import { validateCalendarEvent, type CalendarEventInput } from '../../src/shared/calendar.js';
import { validateOrg, type OrgInput } from '../../src/shared/organizations.js';
import { DATE_CHECK_MARK } from '../../src/shared/rollover.js';
import { ADMIN, EDITOR_A, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// The year rollover over HTTP in the demo composition (persona cookie), with every store in a temporary folder.
// Synthetic organizations, events, people and contacts only (the addresses and numbers are reserved or made up).

const NOW = '2026-11-04T03:00:00.000Z';
const TEMP_ADMIN = 'u-temp-admin';
const FORMER = 'u-former-e';
const CONTACT = 'ct_0123456789abcdef';

let dir: string;
let orgs: OrganizationsStore;
let calendar: CalendarStore;
let decisions: DecisionsStore;
let rollover: RolloverStore;
let state: StateStore;
let app: FastifyInstance;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = { status: number; json: any; raw: string; headers: Record<string, unknown> };

async function build(options: { tasksBoundTo?: string | null; tasks?: TaskRuntime; edit?: (s: AppState) => void } = {}) {
  const seed = await seedState();
  seed.users.push({ id: TEMP_ADMIN, displayName: '合成 臨時', roleLabel: '臨時スタッフ', email: 'temp@example.invalid', canManageAccess: true });
  options.edit?.(seed);
  state = new StateStore(seed, null);
  let tick = 0;
  let tasks: TaskRuntime | null = options.tasks ?? null;
  if (options.tasksBoundTo !== undefined) {
    const service = await TaskService.open({ store: new MemoryStore(), faults: new FaultInjector() });
    const bindings = options.tasksBoundTo ? [{ principalId: ADMIN, taskUserId: options.tasksBoundTo }] : [];
    tasks = { client: new InProcessTaskBackend(service), bridge: parseTaskBridge(JSON.stringify({ version: 1, bindings })), links: new TaskLinkStore(emptyLinkState(), null) };
  }
  app = await buildApp({
    store: state,
    listenPort: TEST_PORT,
    clock: () => new Date(Date.parse(NOW) + ++tick * 1000).toISOString(),
    calendar: { store: calendar, icalEnabled: false },
    decisions,
    tasks,
    rollover: { store: rollover, organizations: orgs },
  });
}

async function call(userId: string | null, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: `http://${TEST_HOST}`, 'x-smm-csrf': '1' } : {}),
      ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}),
    },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON (the downloads)
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers as Record<string, unknown> };
}

const org = (over: Partial<OrgInput> & Pick<OrgInput, 'kind' | 'name' | 'status'>): OrgInput =>
  validateOrg({ fiscalYear: 2026, department: '渉外部', ownerId: null, contactId: null, amountYen: null, content: '', nextAction: '', nextDue: null, notes: '', ...over });
const event = (over: Partial<CalendarEventInput>): CalendarEventInput =>
  validateCalendarEvent({ title: '合成の予定', kind: 'procedure', date: '2026-04-10', time: null, departments: [], memo: '', yearly: true, remindDays: [], ...over });

function seedOrgs() {
  orgs.create(org({ kind: 'sponsor', name: '合成薬局', status: 'お礼状を送った', amountYen: 30000, content: '広告（半ページ）', ownerId: EDITOR_A, contactId: CONTACT, nextAction: '請求書を送る', notes: '担当は合成さん' }), 'seed', NOW);
  orgs.create(org({ kind: 'sponsor', name: '合成医療', status: '入金済み', amountYen: 50000, content: '広告（1ページ）' }), 'seed', NOW);
  orgs.create(org({ kind: 'sponsor', name: '合成書店', status: '依頼済み' }), 'seed', NOW);
  orgs.create(org({ kind: 'exhibitor', name: '合成サークル', status: '完了', amountYen: 3000 }), 'seed', NOW);
  orgs.create(org({ kind: 'donor', name: '合成同窓会', status: '受領済み', amountYen: 100000 }), 'seed', NOW);
}

const SPONSORS_DONE = [{ kind: 'sponsor', statuses: ['お礼状を送った', '入金済み'] }];

/** Eleven minutes before the app's clock: a run started then and never closed was cut off. */
const CUT_OFF_AT = new Date(Date.parse(NOW) - 11 * 60_000).toISOString();

/** A copy of organizations cut off before its record was closed, with these copies already made and recorded. */
function cutOffOrgRun(names: string[]) {
  const begun = rollover.begin({ step: 'organizations', sourceYear: 2026, targetYear: 2027, planToken: 'cut-off-plan-token-0001', actorId: ADMIN, now: CUT_OFF_AT });
  if (begun.kind !== 'started') throw new Error('the run did not start');
  for (const name of names) {
    const source = orgs.allOfYear(2026).find((r) => r.data.name === name)!;
    const made = orgs.create(nextYearOrg(source.data, 2027, null), ADMIN, CUT_OFF_AT);
    rollover.addItem(begun.run.id, { kind: 'organization', sourceId: source.id, madeId: made.id, name, data: {} });
  }
  return begun.run;
}
const orgPreview = (over: Record<string, unknown> = {}) => call(ADMIN, 'POST', '/api/rollover/organizations/preview', { sourceYear: 2026, selection: SPONSORS_DONE, excludeIds: [], ...over });
async function orgApply(over: Record<string, unknown> = {}) {
  const preview = await orgPreview(over);
  expect(preview.status).toBe(200);
  return call(ADMIN, 'POST', '/api/rollover/organizations/apply', { sourceYear: 2026, selection: SPONSORS_DONE, excludeIds: [], ...over, planToken: preview.json.planToken });
}
const calPreview = (over: Record<string, unknown> = {}) => call(ADMIN, 'POST', '/api/rollover/calendar/preview', { sourceYear: 2026, weekdayIds: [], skipIds: [], ...over });
async function calApply(over: Record<string, unknown> = {}) {
  const preview = await calPreview(over);
  expect(preview.status).toBe(200);
  return call(ADMIN, 'POST', '/api/rollover/calendar/apply', { sourceYear: 2026, weekdayIds: [], skipIds: [], ...over, planToken: preview.json.planToken });
}
const titlesIn = async (from: string, to: string) => ((await call(EDITOR_A, 'GET', `/api/calendar/events?from=${from}&to=${to}`)).json.events as { title: string; date: string }[]).map((e) => `${e.date} ${e.title}`);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rollover-http-'));
  orgs = new OrganizationsStore(dir);
  calendar = new CalendarStore(dir);
  decisions = new DecisionsStore(dir);
  rollover = new RolloverStore(dir);
});
afterEach(async () => {
  await app?.close();
  orgs.close();
  calendar.close();
  decisions.close();
  rollover.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('who may use it', () => {
  it('is for access administrators only, checked on every route; temporary staff are refused even with the flag', async () => {
    await build();
    expect((await call(null, 'GET', '/api/rollover/meta')).status).toBe(401);
    const routes: [string, 'GET' | 'POST', unknown?][] = [
      ['/api/rollover/meta', 'GET'],
      ['/api/rollover/organizations/preview', 'POST', { sourceYear: 2026, selection: [], excludeIds: [] }],
      ['/api/rollover/calendar/preview', 'POST', { sourceYear: 2026, weekdayIds: [], skipIds: [] }],
      ['/api/rollover/tasks', 'GET'],
      ['/api/rollover/grants', 'GET'],
      ['/api/rollover/grants/preview', 'POST', { sourceYear: 2026, keys: [] }],
      ['/api/rollover/handover', 'GET'],
      ['/api/rollover/handover/export', 'POST', { sourceYear: 2026, format: 'markdown' }],
      // The writes: refused before the body is read, so no plan or run is ever looked at.
      ['/api/rollover/organizations/apply', 'POST', { sourceYear: 2026, selection: [], excludeIds: [], planToken: 'x'.repeat(32) }],
      ['/api/rollover/calendar/apply', 'POST', { sourceYear: 2026, weekdayIds: [], skipIds: [], planToken: 'x'.repeat(32) }],
      ['/api/rollover/runs/ro_0123456789abcdef/undo', 'POST', {}],
      ['/api/rollover/tasks/export', 'POST', { sourceYear: 2026 }],
      ['/api/rollover/grants/apply', 'POST', { sourceYear: 2026, keys: [], planToken: 'x'.repeat(32), requestId: 'req-0123456789abcdef' }],
    ];
    for (const [url, method, body] of routes) {
      expect((await call(EDITOR_A, method, url, body)).status, url).toBe(403);
      expect((await call(TEMP_ADMIN, method, url, body)).status, url).toBe(403);
    }
    expect(rollover.count()).toBe(0);
    const meta = await call(ADMIN, 'GET', '/api/rollover/meta');
    expect(meta.status).toBe(200);
    expect(meta.json.sourceYear).toBe(2026);
    expect(meta.json.targetYear).toBe(2027);
    expect(meta.json.steps.map((s: { step: string; available: boolean }) => [s.step, s.available])).toEqual([
      ['organizations', true],
      ['calendar', true],
      ['tasks', false],
      ['grants', true],
      ['handover', true],
    ]);
  });

  it('has no routes when the composition has no rollover', async () => {
    const seed = await seedState();
    app = await buildApp({ store: new StateStore(seed, null), listenPort: TEST_PORT, clock: () => NOW });
    expect((await call(ADMIN, 'GET', '/api/rollover/meta')).status).toBe(404);
  });
});

describe('step 1: organizations', () => {
  beforeEach(() => seedOrgs());

  it('lists only the chosen kinds and stages, and offers the counts of each stage', async () => {
    await build();
    const preview = await orgPreview();
    expect(preview.status).toBe(200);
    expect(preview.json.items.map((i: { name: string; action: string }) => [i.name, i.action])).toEqual([
      ['合成医療', 'copy'],
      ['合成薬局', 'copy'],
    ]);
    expect(preview.json.items[0]).toMatchObject({ fromStatus: '入金済み', toStatus: '依頼前', amountYen: 50000 });
    const sponsor = preview.json.choices.find((c: { kind: string }) => c.kind === 'sponsor');
    expect(sponsor.statuses).toEqual([
      { status: '依頼済み', count: 1 },
      { status: '入金済み', count: 1 },
      { status: 'お礼状を送った', count: 1 },
    ]);
    const exhibitors = await orgPreview({ selection: [{ kind: 'exhibitor', statuses: ['完了'] }, { kind: 'donor', statuses: ['受領済み'] }] });
    // In the kinds' order (寄付 before 出展団体).
    expect(exhibitors.json.items.map((i: { name: string }) => i.name)).toEqual(['合成同窓会', '合成サークル']);
  });

  it('copies to the next year at the first stage with no amount, keeps the year as 前年度の実績, and leaves the source year unchanged', async () => {
    await build();
    const before = orgs.allOfYear(2026);
    const applied = await orgApply();
    expect(applied.status).toBe(200);
    expect(applied.json.made).toEqual(['合成医療', '合成薬局']);
    expect(applied.json.run).toMatchObject({ step: 'organizations', sourceYear: 2026, targetYear: 2027, status: 'done', actorName: 'デモ管理者', canUndo: true });
    expect(orgs.allOfYear(2026)).toEqual(before);

    const copy = orgs.allOfYear(2027).find((r) => r.data.name === '合成薬局')!;
    expect(copy.version).toBe(1);
    expect(copy.data).toMatchObject({ kind: 'sponsor', fiscalYear: 2027, status: '依頼前', amountYen: null, content: '', nextAction: '', nextDue: null, ownerId: null, contactId: CONTACT, department: '渉外部' });
    expect(copy.data.notes).toContain('【前年度（2026年度）の実績】');
    expect(copy.data.notes).toContain('最終の段階：お礼状を送った');
    expect(copy.data.notes).toContain('金額：30,000 円');
    expect(copy.data.notes).toContain('協賛の内容：広告（半ページ）');
    expect(copy.data.notes).toContain('担当 編集担当A');
    expect(copy.data.notes).toContain('前年度のメモ：\n担当は合成さん');
    expect(orgs.history(copy.id).map((h) => h.action)).toEqual(['created']);
  });

  it('leaves out the organizations chosen by hand, and one whose name the next year already has', async () => {
    orgs.create(org({ kind: 'sponsor', fiscalYear: 2027, name: '合成医療', status: '依頼前' }), 'seed', NOW);
    await build();
    const first = await orgPreview();
    const pharmacy = first.json.items.find((i: { name: string }) => i.name === '合成薬局').sourceId;
    expect(first.json.items.find((i: { name: string }) => i.name === '合成医療')).toMatchObject({ action: 'skip', reason: '2027年度に同じ名前の団体があります' });
    const preview = await orgPreview({ excludeIds: [pharmacy] });
    expect(preview.json.counts).toEqual({ copy: 0, skip: 1, excluded: 1 });
    const applied = await call(ADMIN, 'POST', '/api/rollover/organizations/apply', { sourceYear: 2026, selection: SPONSORS_DONE, excludeIds: [pharmacy], planToken: preview.json.planToken });
    expect(applied.status).toBe(422);
    expect(orgs.allOfYear(2027)).toHaveLength(1);
  });

  it('refuses a second copy for the same year, naming the first run; after an undo it can run again', async () => {
    await build();
    const first = await orgApply();
    expect(first.status).toBe(200);
    // Another organization reaches a chosen stage: the next preview has something to copy, and is still refused.
    const bookstore = orgs.allOfYear(2026).find((r) => r.data.name === '合成書店')!;
    orgs.update(bookstore.id, bookstore.version, { ...bookstore.data, status: '入金済み' }, 'seed', NOW);
    const preview = await orgPreview();
    expect(preview.json.done.id).toBe(first.json.run.id);
    const second = await orgApply();
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('already_done');
    expect(second.json.run.id).toBe(first.json.run.id);
    expect(second.json.message).toContain('デモ管理者さんが済ませています');
    expect(orgs.allOfYear(2027)).toHaveLength(2);

    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${first.json.run.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.json.removed.sort()).toEqual(['合成医療', '合成薬局']);
    expect(undo.json.run).toMatchObject({ status: 'undone', undoneByName: 'デモ管理者', canUndo: false });
    expect(orgs.allOfYear(2027)).toHaveLength(0);
    expect((await call(ADMIN, 'POST', `/api/rollover/runs/${first.json.run.id}/undo`, {})).status).toBe(409);

    const again = await orgApply();
    expect(again.status).toBe(200);
    expect(again.json.made).toEqual(['合成医療', '合成書店', '合成薬局']);
  });

  it('keeps a copy changed since, when the run is taken back', async () => {
    await build();
    const first = await orgApply();
    const copy = orgs.allOfYear(2027).find((r) => r.data.name === '合成医療')!;
    orgs.update(copy.id, 1, { ...copy.data, status: '依頼済み' }, EDITOR_A, NOW);
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${first.json.run.id}/undo`, {});
    expect(undo.json.removed).toEqual(['合成薬局']);
    expect(undo.json.kept).toEqual([{ name: '合成医療', reason: '写したあとに変更があったため残しました' }]);
    expect(orgs.allOfYear(2027).map((r) => r.data.name)).toEqual(['合成医療']);
  });

  it('keeps a copy that was sent a mail (the February greeting) when the run is taken back', async () => {
    await build();
    const first = await orgApply();
    const copy = orgs.allOfYear(2027).find((r) => r.data.name === '合成薬局')!;
    // A sent mail adds a history row and leaves the version at 1.
    orgs.recordMail(copy.id, ADMIN, NOW, { subject: '合成の挨拶', sent: 1, batchId: 'mb_0123456789abcdef' });
    expect(orgs.get(copy.id)!.version).toBe(1);
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${first.json.run.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.json.removed).toEqual(['合成医療']);
    expect(undo.json.kept).toEqual([{ name: '合成薬局', reason: expect.stringContaining('メールを送った記録がある') }]);
    expect(orgs.allOfYear(2027).map((r) => r.data.name)).toEqual(['合成薬局']);
    expect(orgs.history(copy.id).map((h) => h.action)).toEqual(['mail_sent', 'created']);
  });

  it('takes over a run cut off after its last copy: the confirm closes it, counting the earlier copies as made', async () => {
    const cut = cutOffOrgRun(['合成医療', '合成薬局']);
    await build();
    const preview = await orgPreview();
    expect(preview.json.counts).toEqual({ copy: 0, skip: 2, excluded: 0 });
    expect(preview.json.done).toMatchObject({ id: cut.id, status: 'running', stale: true, canUndo: true });
    expect(preview.json.done.summary).toContain('途中で止まりました');
    const applied = await call(ADMIN, 'POST', '/api/rollover/organizations/apply', { sourceYear: 2026, selection: SPONSORS_DONE, excludeIds: [], planToken: preview.json.planToken });
    expect(applied.status).toBe(200);
    expect(applied.json.run).toMatchObject({ id: cut.id, status: 'done', stale: false, canUndo: true });
    expect(applied.json.made.sort()).toEqual(['合成医療', '合成薬局']);
    expect(applied.json.skipped).toEqual([]);
    expect(orgs.allOfYear(2027)).toHaveLength(2);
    // Closed: a second copy is refused as for any completed run.
    expect((await orgApply()).status).toBe(409);
  });

  it('takes over a run cut off half way: the rest is copied once, and the whole run can be taken back', async () => {
    const cut = cutOffOrgRun(['合成医療']);
    await build();
    const preview = await orgPreview();
    expect(preview.json.items.map((i: { name: string; action: string }) => [i.name, i.action])).toEqual([
      ['合成医療', 'skip'],
      ['合成薬局', 'copy'],
    ]);
    const applied = await call(ADMIN, 'POST', '/api/rollover/organizations/apply', { sourceYear: 2026, selection: SPONSORS_DONE, excludeIds: [], planToken: preview.json.planToken });
    expect(applied.status).toBe(200);
    expect(applied.json.made.sort()).toEqual(['合成医療', '合成薬局']);
    expect(applied.json.run.summary).toBe('団体 2 件を 2027年度に写した');
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${cut.id}/undo`, {});
    expect(undo.json.removed.sort()).toEqual(['合成医療', '合成薬局']);
    expect(orgs.allOfYear(2027)).toHaveLength(0);
  });

  it('takes back a run cut off half way, but not one still running', async () => {
    const cut = cutOffOrgRun(['合成医療']);
    await build();
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${cut.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.json).toMatchObject({ removed: ['合成医療'], kept: [], run: { status: 'undone' } });
    expect(orgs.allOfYear(2027)).toHaveLength(0);

    // A run started a moment ago is another administrator's, still at work.
    const running = rollover.begin({ step: 'organizations', sourceYear: 2026, targetYear: 2027, planToken: 'running-plan-token-0001', actorId: ADMIN, now: NOW });
    expect(running.kind).toBe('started');
    const refused = await call(ADMIN, 'POST', `/api/rollover/runs/${running.run.id}/undo`, {});
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('not_done');
    expect(rollover.get(running.run.id)!.status).toBe('running');
    const preview = await orgPreview();
    expect(preview.json.done).toMatchObject({ id: running.run.id, stale: false, canUndo: false });
  });

  it('says when a run is being taken back, and takes over an undo cut off part way', async () => {
    await build();
    const first = await orgApply();
    const id = first.json.run.id as string;
    // Another administrator's undo, just begun: named as such, and not taken back twice.
    expect(rollover.claimUndo(id, NOW)).toBe('done');
    expect((await orgPreview()).json.done).toMatchObject({ id, status: 'running', summary: '取り消しの途中です', stale: false, canUndo: false });
    expect((await call(ADMIN, 'POST', `/api/rollover/runs/${id}/undo`, {})).status).toBe(409);
    // The same undo, begun long ago and never finished: it can be taken back again.
    rollover.releaseUndo(id, 'done');
    expect(rollover.claimUndo(id, CUT_OFF_AT)).toBe('done');
    const preview = await orgPreview();
    expect(preview.json.done).toMatchObject({ id, status: 'running', stale: true, canUndo: true });
    expect(preview.json.done.summary).toContain('取り消しが途中で止まりました');
    // The undo had removed one copy when it stopped. A copy does not take the run over (there is one to copy again):
    // the half-undone run is finished only by the undo.
    const medical = orgs.allOfYear(2027).find((r) => r.data.name === '合成医療')!;
    expect(orgs.delete(medical.id, 1, ADMIN, CUT_OFF_AT)).toBe('deleted');
    const refused = await orgApply();
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('already_done');
    expect(refused.json.message).toContain('取り消しの途中です');
    expect(rollover.get(id)).toMatchObject({ status: 'running', undoneAt: CUT_OFF_AT });
    expect(orgs.allOfYear(2027).map((r) => r.data.name)).toEqual(['合成薬局']);
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.json.removed).toEqual(['合成薬局']);
    expect(orgs.allOfYear(2027)).toHaveLength(0);
    expect(undo.json.run).toMatchObject({ status: 'undone', stale: false, canUndo: false });
  });

  it('refuses a confirm whose preview is out of date', async () => {
    await build();
    const preview = await orgPreview();
    const pharmacy = orgs.allOfYear(2026).find((r) => r.data.name === '合成薬局')!;
    orgs.update(pharmacy.id, pharmacy.version, { ...pharmacy.data, amountYen: 35000 }, 'seed', NOW);
    const applied = await call(ADMIN, 'POST', '/api/rollover/organizations/apply', { sourceYear: 2026, selection: SPONSORS_DONE, excludeIds: [], planToken: preview.json.planToken });
    expect(applied.status).toBe(409);
    expect(applied.json.error).toBe('plan_changed');
    expect(orgs.allOfYear(2027)).toHaveLength(0);
    expect(rollover.count()).toBe(0);
  });
});

describe('step 2: the yearly schedule', () => {
  it('copies a yearly event once to the next year, marks the copy, and the original keeps its date, title and memo', async () => {
    const original = calendar.create(event({ title: '合成の会場予約', memo: '学務に出す' }), 'seed', NOW);
    calendar.create(event({ title: '合成の単発', yearly: false, date: '2026-05-01' }), 'seed', NOW);
    calendar.create(event({ title: '合成の昔から', date: '2024-06-01' }), 'seed', NOW);
    await build();
    const before2026 = await titlesIn('2026-01-01', '2026-12-31');
    const preview = await calPreview();
    expect(preview.json.items.map((i: { title: string; action: string; toDate: string }) => [i.title, i.action, i.toDate])).toEqual([
      ['合成の会場予約', 'copy', '2027-04-10'],
      ['合成の昔から', 'skip', '2024-06-01'],
    ]);
    const applied = await calApply();
    expect(applied.status).toBe(200);
    expect(applied.json.made).toEqual(['合成の会場予約']);

    const after = calendar.get(original.id)!;
    expect(after.data).toEqual({ ...original.data, yearly: false });
    expect(calendar.history(original.id)[0]).toMatchObject({ action: 'updated', changed: ['yearly'] });
    const copy = calendar.range('2027-01-01', '2027-12-31').find((r) => r.copiedFrom === original.id)!;
    expect(copy.data).toMatchObject({ title: '合成の会場予約', date: '2027-04-10', yearly: true, kind: 'procedure' });
    expect(copy.data.memo.startsWith(DATE_CHECK_MARK)).toBe(true);
    expect(copy.data.memo).toContain('学務に出す');

    // Each year shows it once: the source year by the original, the next years by the copy.
    expect(await titlesIn('2026-01-01', '2026-12-31')).toEqual(before2026);
    expect((await titlesIn('2027-01-01', '2027-12-31')).filter((t) => t.endsWith('合成の会場予約'))).toEqual(['2027-04-10 合成の会場予約']);
    expect((await titlesIn('2028-01-01', '2028-12-31')).filter((t) => t.endsWith('合成の会場予約'))).toEqual(['2028-04-10 合成の会場予約']);
    // Deleting the copy leaves nothing behind in the later years.
    calendar.delete(copy.id, copy.version, ADMIN, NOW);
    expect((await titlesIn('2028-01-01', '2028-12-31')).filter((t) => t.endsWith('合成の会場予約'))).toEqual([]);
    expect((await titlesIn('2026-01-01', '2026-12-31')).filter((t) => t.endsWith('合成の会場予約'))).toEqual(['2026-04-10 合成の会場予約']);
  });

  it('takes a run back: the copy goes and the original is 毎年 again; a second copy is refused until then', async () => {
    const original = calendar.create(event({ title: '合成の会場予約' }), 'seed', NOW);
    await build();
    const first = await calApply();
    const second = await call(ADMIN, 'POST', '/api/rollover/calendar/apply', { sourceYear: 2026, weekdayIds: [], skipIds: [], planToken: 'x'.repeat(32) });
    expect(second.status).toBe(409);
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${first.json.run.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.json.removed).toEqual(['合成の会場予約']);
    expect(calendar.range('2027-01-01', '2027-12-31')).toHaveLength(0);
    expect(calendar.get(original.id)!.data.yearly).toBe(true);
    expect((await titlesIn('2027-01-01', '2027-12-31')).filter((t) => t.endsWith('合成の会場予約'))).toEqual(['2027-04-10 合成の会場予約']);
    expect((await calApply()).status).toBe(200);
  });

  it('keeps the copy (with its 毎年) when the original changed since, so the event stays in the later years', async () => {
    const original = calendar.create(event({ title: '合成の会場予約', memo: '学務に出す' }), 'seed', NOW);
    await build();
    const first = await calApply();
    const moved = calendar.get(original.id)!;
    calendar.update(moved.id, moved.version, { ...moved.data, memo: '学務に出した' }, EDITOR_A, NOW);
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${first.json.run.id}/undo`, {});
    expect(undo.status).toBe(200);
    // Listed once, as kept; nothing was deleted.
    expect(undo.json.removed).toEqual([]);
    expect(undo.json.kept).toEqual([{ name: '合成の会場予約', reason: expect.stringContaining('変更されていたため、写した予定を残しました') }]);
    const copy = calendar.range('2027-01-01', '2027-12-31').find((r) => r.copiedFrom === original.id)!;
    expect(copy.data.yearly).toBe(true);
    expect(calendar.get(original.id)!.data.yearly).toBe(false);
    expect((await titlesIn('2028-01-01', '2028-12-31')).filter((t) => t.endsWith('合成の会場予約'))).toEqual(['2028-04-10 合成の会場予約']);
  });

  it('deletes the copy without touching the original when someone already put 毎年 back on it', async () => {
    const original = calendar.create(event({ title: '合成の会場予約' }), 'seed', NOW);
    await build();
    const first = await calApply();
    const moved = calendar.get(original.id)!;
    calendar.update(moved.id, moved.version, { ...moved.data, yearly: true }, EDITOR_A, NOW);
    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${first.json.run.id}/undo`, {});
    expect(undo.json).toMatchObject({ removed: ['合成の会場予約'], kept: [] });
    expect(calendar.range('2027-01-01', '2027-12-31')).toHaveLength(0);
    expect((await titlesIn('2027-01-01', '2027-12-31')).filter((t) => t.endsWith('合成の会場予約'))).toEqual(['2027-04-10 合成の会場予約']);
  });

  it('takes over a run cut off after the last mark moved: the confirm closes it, and it can be taken back', async () => {
    const original = calendar.create(event({ title: '合成の会場予約' }), 'seed', NOW);
    const begun = rollover.begin({ step: 'calendar', sourceYear: 2026, targetYear: 2027, planToken: 'cut-off-plan-token-0002', actorId: ADMIN, now: CUT_OFF_AT });
    if (begun.kind !== 'started') throw new Error('the run did not start');
    const copy = calendar.create(validateCalendarEvent({ ...original.data, date: '2027-04-10', memo: markedMemo(original.data.memo, original.data.date), yearly: true }), ADMIN, CUT_OFF_AT, original.id);
    const flipped = calendar.update(original.id, original.version, { ...original.data, yearly: false }, ADMIN, CUT_OFF_AT);
    if (flipped === null || flipped === 'conflict') throw new Error('the mark did not move');
    rollover.addItem(begun.run.id, { kind: 'event', sourceId: original.id, madeId: copy.id, name: '合成の会場予約', data: { sourceVersionAfter: flipped.version } });
    await build();

    // The original is no longer 毎年: before the fix the plan was empty and the run could never be closed.
    const preview = await calPreview();
    expect(preview.json.items).toEqual([]);
    expect(preview.json.done).toMatchObject({ id: begun.run.id, stale: true, canUndo: true });
    const applied = await call(ADMIN, 'POST', '/api/rollover/calendar/apply', { sourceYear: 2026, weekdayIds: [], skipIds: [], planToken: preview.json.planToken });
    expect(applied.status).toBe(200);
    expect(applied.json).toMatchObject({ made: ['合成の会場予約'], skipped: [], run: { status: 'done', summary: '毎年の予定 1 件を 2027年に写した' } });
    expect(calendar.range('2027-01-01', '2027-12-31')).toHaveLength(1);

    const undo = await call(ADMIN, 'POST', `/api/rollover/runs/${begun.run.id}/undo`, {});
    expect(undo.json).toMatchObject({ removed: ['合成の会場予約'], kept: [] });
    expect(calendar.get(original.id)!.data.yearly).toBe(true);
  });

  it('moves an event by the same week and weekday when chosen, and notes 2/29', async () => {
    const festival = calendar.create(event({ title: '合成の医薬祭', date: '2026-11-14' }), 'seed', NOW);
    calendar.create(event({ title: '合成の閏日', date: '2028-02-29' }), 'seed', NOW);
    await build();
    const preview = await calPreview({ weekdayIds: [festival.id] });
    expect(preview.json.items.find((i: { title: string }) => i.title === '合成の医薬祭')).toMatchObject({ rule: 'same-weekday', weekdayLabel: '第2土曜日', fromDate: '2026-11-14', toDate: '2027-11-13' });
    expect((await calApply({ weekdayIds: [festival.id] })).status).toBe(200);
    expect(calendar.range('2027-11-01', '2027-11-30').map((r) => r.data.date)).toEqual(['2027-11-13']);

    const leap = await call(ADMIN, 'POST', '/api/rollover/calendar/preview', { sourceYear: 2028, weekdayIds: [], skipIds: [] });
    expect(leap.json.items.find((i: { title: string }) => i.title === '合成の閏日')).toMatchObject({ action: 'copy', toDate: '2029-02-28', notes: ['2月29日は、この年にないので2月28日にしました'] });
  });
});

describe('step 3: open tasks', () => {
  it('lists the open tasks by department and writes them as CSV (read only)', async () => {
    await build({ tasksBoundTo: 'user-chair-b' });
    const list = await call(ADMIN, 'GET', '/api/rollover/tasks');
    expect(list.status).toBe(200);
    expect(list.json.state).toBe('ok');
    expect(list.json.total).toBeGreaterThan(0);
    expect(list.json.groups.length).toBeGreaterThan(0);
    for (const g of list.json.groups) for (const t of g.tasks) expect(t.status).not.toBe('完了');

    const csv = await call(ADMIN, 'POST', '/api/rollover/tasks/export', { sourceYear: 2026 });
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(String(csv.headers['content-disposition'])).toContain('attachment');
    expect(csv.raw.startsWith('\uFEFF部局,タスク番号,題名,状態,担当,期限,期限超過,持ち越す（記入用）\r\n')).toBe(true);
    const meta = await call(ADMIN, 'GET', '/api/rollover/meta');
    expect(meta.json.steps.find((s: { step: string }) => s.step === 'tasks')).toMatchObject({ available: true, reason: null, last: { status: 'done', canUndo: false } });
  });

  it('says so when the administrator is not a task user', async () => {
    await build({ tasksBoundTo: null });
    const list = await call(ADMIN, 'GET', '/api/rollover/tasks');
    expect(list.json).toMatchObject({ state: 'unbound', total: 0, groups: [] });
    // The step is not offered at all (no 「開く」 into something that cannot be used).
    const meta = await call(ADMIN, 'GET', '/api/rollover/meta');
    expect(meta.json.steps.find((s: { step: string }) => s.step === 'tasks')).toMatchObject({ available: false, reason: list.json.message });
    expect((await call(ADMIN, 'POST', '/api/rollover/tasks/export', { sourceYear: 2026 })).status).toBe(409);
  });
});

describe('step 4: grants', () => {
  const formerGrant = `mail|edit|p:${FORMER}|mbx-support`;
  const withFormer = (s: AppState) => {
    s.users.push({ id: FORMER, displayName: '合成 退任者', roleLabel: '委員', email: 'former@example.invalid', canManageAccess: false, disabled: true });
    s.grants.push({ userId: FORMER, mailboxId: 'mbx-support', level: 'edit' });
    s.grants.push({ userId: 'u-gone-f', mailboxId: 'mbx-sales', level: 'read' });
  };

  it('lists every grant by holder, with people who left or are unknown first', async () => {
    await build({ edit: withFormer });
    const grants = await call(ADMIN, 'GET', '/api/rollover/grants');
    expect(grants.status).toBe(200);
    expect(grants.json.holders.slice(0, 2).map((h: { id: string; status: string; attention: boolean }) => [h.id, h.status, h.attention])).toEqual([
      ['u-gone-f', 'no_account', true],
      [FORMER, 'inactive', true],
    ]);
    expect(grants.json.counts.attention).toBe(2);
    expect(grants.json.sources).toEqual(['メールの受信箱', '権限の管理者']);
    const admin = grants.json.holders.find((h: { id: string }) => h.id === ADMIN);
    expect(admin.grants).toEqual([expect.objectContaining({ permission: '権限の管理者', removable: false })]);
    expect(grants.json.notes.join('\n')).toContain('会計');
  });

  it('removes the chosen grants through the inbox’s own change (with its audit row), once per confirm', async () => {
    await build({ edit: withFormer });
    const keys = [formerGrant, `admin|all|p:${ADMIN}|app`];
    const preview = await call(ADMIN, 'POST', '/api/rollover/grants/preview', { sourceYear: 2026, keys });
    expect(preview.json.counts).toEqual({ remove: 1, gone: 0, kept: 1 });
    const body = { sourceYear: 2026, keys, planToken: preview.json.planToken, requestId: 'req-0123456789abcdef' };
    const applied = await call(ADMIN, 'POST', '/api/rollover/grants/apply', body);
    expect(applied.status).toBe(200);
    expect(applied.json.removed.map((i: { key: string }) => i.key)).toEqual([formerGrant]);
    expect(state.current.grants.some((g) => g.userId === FORMER)).toBe(false);
    expect(state.current.audit.at(-1)).toMatchObject({ actorId: ADMIN, action: 'grant_changed' });
    expect(state.current.audit.at(-1)!.detail).toContain('合成 退任者');

    const again = await call(ADMIN, 'POST', '/api/rollover/grants/apply', body);
    expect(again.status).toBe(409);
    expect(again.json.run.id).toBe(applied.json.run.id);
    const stale = await call(ADMIN, 'POST', '/api/rollover/grants/apply', { ...body, requestId: 'req-fedcba9876543210' });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('plan_changed');
  });
});

describe('step 5: the handover draft', () => {
  it('has the year’s decisions, organizations, schedule and runs, and no personal contact details', async () => {
    seedOrgs();
    orgs.create(org({ kind: 'vendor', name: '合成印刷', status: '発注済み', content: '電話 090-0000-0000 まで', notes: 'x@example.invalid に連絡' }), 'seed', NOW);
    decisions.create({ title: '合成の決定', body: '問い合わせは x@example.invalid か 090-0000-0000（合成）', departments: ['planning'], decidedOn: '2026-09-20', venue: 'regular', venueOther: '', sources: [], taskIds: [] }, ADMIN, NOW, null);
    calendar.create(event({ title: '合成の会場予約', memo: 'x@example.invalid' }), 'seed', NOW);
    await build();
    const summary = await call(ADMIN, 'GET', '/api/rollover/handover?year=2026');
    expect(summary.status).toBe(200);
    expect(summary.json.counts).toMatchObject({ decisions: 1, organizations: 6, events: 1 });
    const md: string = summary.json.markdown;
    expect(md).toContain('# 2026年度の引き継ぎ（下書き）');
    expect(md).toContain('合成の決定');
    expect(md).toContain('最終の段階：依頼済み 1 件・入金済み 1 件・お礼状を送った 1 件');
    expect(md).toContain('連絡先に登録あり');
    expect(md).toContain('（連絡先を省略）');
    for (const format of ['markdown', 'json'] as const) {
      const file = await call(ADMIN, 'POST', '/api/rollover/handover/export', { sourceYear: 2026, format });
      expect(file.status).toBe(200);
      expect(String(file.headers['content-disposition'])).toContain('attachment');
      for (const text of [file.raw, md]) {
        expect(text).not.toContain('x@example.invalid');
        expect(text).not.toContain('090-0000-0000');
        expect(text).not.toContain(CONTACT);
        expect(text).not.toContain('編集担当A');
        expect(text).not.toContain('担当は合成さん');
      }
    }
    const json = JSON.parse((await call(ADMIN, 'POST', '/api/rollover/handover/export', { sourceYear: 2026, format: 'json' })).raw);
    expect(json).toMatchObject({ format: 'iyakusai-handover', version: 1, fiscalYear: 2026 });
    expect(json.organizations.find((o: { name: string }) => o.name === '合成薬局')).toEqual({ kind: '協賛', name: '合成薬局', status: 'お礼状を送った', amountYen: 30000, content: '広告（半ページ）', department: '渉外部', hasContact: true });
    const meta = await call(ADMIN, 'GET', '/api/rollover/meta');
    expect(meta.json.runs.filter((r: { step: string }) => r.step === 'handover')).toHaveLength(3);
    // No Task service here: the note the task section points to is there.
    const note = 'このサーバーではタスク機能が設定されていないため、未完了のタスクの件数は入っていません。';
    expect(summary.json.missing).toContain(note);
    expect(md).toContain(`- ${note}`);
    // The promise is what is actually done: names inside a title or body are not taken out.
    expect(md).toContain('題名や本文に書かれた名前は残る');
    expect(md).not.toContain('委員の名前は入れていません');
  });

  it('names the decisions’ departments from the Task service’s departments, open tasks or not', async () => {
    decisions.create({ title: '合成の決定', body: '', departments: ['planning', 'gaimu'], decidedOn: '2026-09-20', venue: 'regular', venueOther: '', sources: [], taskIds: [] }, ADMIN, NOW, null);
    // A Bot-host-like Task service: departments as dept-<key> workspaces, no open task at all.
    const tasks = {
      client: {
        me: async () => ({ user: { id: 'discord-1000000000000000001', displayName: '合成 管理者' }, memberships: [{ workspace: { id: 'dept-planning', name: '企画部', description: '' }, role: 'member' }] }),
        listAllTasks: async () => [],
      },
      bridge: parseTaskBridge(JSON.stringify({ version: 1, bindings: [{ principalId: ADMIN, taskUserId: 'discord-1000000000000000001' }] })),
      links: new TaskLinkStore(emptyLinkState(), null),
    } as unknown as TaskRuntime;
    await build({ tasks });
    const summary = await call(ADMIN, 'GET', '/api/rollover/handover?year=2026');
    expect(summary.status).toBe(200);
    expect(summary.json.counts.openTasks).toBe(0);
    // A key the Task service does not name stays as it is (as on the decisions screen).
    expect(summary.json.markdown).toContain('合成の決定（企画部・gaimu）');
  });
});
