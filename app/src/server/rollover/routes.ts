import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dateLabel, jstDate } from '../../shared/calendar.js';
import { ORG_KINDS } from '../../shared/organizations.js';
import {
  defaultSourceYear,
  ONCE_PER_YEAR_STEPS,
  ROLLOVER_LIMITS,
  ROLLOVER_STEP_LABELS,
  ROLLOVER_STEPS,
  type CalendarPreviewResponse,
  type GrantApplyResponse,
  type GrantPreviewResponse,
  type GrantsResponse,
  type HandoverSummary,
  type OrgPreviewResponse,
  type RolloverApplyResponse,
  type RolloverMetaResponse,
  type RolloverRunView,
  type RolloverStep,
  type RolloverTasksResponse,
  type RolloverUndoResponse,
} from '../../shared/rollover.js';
import type { CalendarStore } from '../calendar/store.js';
import type { DecisionsStore } from '../decisions/store.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { attachmentDisposition } from '../http/content-disposition.js';
import { HttpError } from '../http/http-error.js';
import type { OrganizationsStore } from '../organizations/store.js';
import type { TaskRuntime } from '../tasks/routes.js';
import { applyCalendar, planCalendar, undoCalendar } from './calendar.js';
import { grantInventory, planGrantRemoval, type GrantPeople, type GrantSource } from './grants.js';
import { handoverDocument, handoverMarkdown } from './handover.js';
import { applyOrganizations, orgChoices, planOrganizations, undoOrganizations } from './organizations.js';
import { isStale, type RolloverStore, type RunRow } from './store.js';
import { departmentLabels, openTasksByDepartment, TASK_MESSAGES, tasksCsv } from './tasks.js';

// Year rollover routes (settings screen, access administrators only; checked here on every request, not only by
// hiding the screen). Each step has a preview and a confirm: the confirm sends the preview's token and goes ahead only
// when the plan made again at that moment is the same. The copy steps run once per target year (the store refuses a
// second run, and the answer names the run that stands); a run of them can be taken back while its copies are unchanged.

export interface RolloverRuntime {
  store: RolloverStore;
  organizations: OrganizationsStore | null;
  calendar: CalendarStore | null;
  decisions: DecisionsStore | null;
  tasks: TaskRuntime | null;
  grants: GrantSource[];
  /** Said once on the grants screen: permissions this app does not hold, and settings that are not grants. */
  grantNotes: () => string[];
  people: GrantPeople;
}

export interface RolloverRouteDeps {
  requireUser: (request: FastifyRequest) => User;
  /** Temporary staff (the Discord login names them) never reach the rollover. */
  isTemporary: (user: User, request: FastifyRequest) => boolean;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

const year = z.number().int().min(ROLLOVER_LIMITS.yearMin).max(ROLLOVER_LIMITS.yearMax);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{16}$`));
const metaQuery = z.strictObject({ year: z.coerce.number().int().min(ROLLOVER_LIMITS.yearMin).max(ROLLOVER_LIMITS.yearMax).optional() });
const status = z.string().min(1).max(40);
const orgBody = z.strictObject({
  sourceYear: year,
  selection: z.array(z.strictObject({ kind: z.enum(ORG_KINDS), statuses: z.array(status).max(40) })).max(ORG_KINDS.length),
  excludeIds: z.array(id('og')).max(ROLLOVER_LIMITS.itemsMax),
});
const orgApplyBody = orgBody.extend({ planToken: z.string().min(16).max(64) });
const calendarBody = z.strictObject({ sourceYear: year, weekdayIds: z.array(id('ev')).max(ROLLOVER_LIMITS.itemsMax), skipIds: z.array(id('ev')).max(ROLLOVER_LIMITS.itemsMax) });
const calendarApplyBody = calendarBody.extend({ planToken: z.string().min(16).max(64) });
const grantKey = z.string().min(5).max(400);
const grantBody = z.strictObject({ sourceYear: year, keys: z.array(grantKey).max(ROLLOVER_LIMITS.grantsMax) });
const grantApplyBody = grantBody.extend({ planToken: z.string().min(16).max(64), requestId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
const exportBody = z.strictObject({ sourceYear: year });
const handoverExportBody = z.strictObject({ sourceYear: year, format: z.enum(['markdown', 'json']) });
const runParams = z.strictObject({ runId: id('ro') });

const PLAN_CHANGED = (what: string) => new HttpError(409, { error: 'plan_changed', message: `下見のあとに${what}が変わりました。下見を作り直して、内容を確かめてから確定してください。` });

export function registerRolloverRoutes(app: FastifyInstance, rt: RolloverRuntime, deps: RolloverRouteDeps): void {
  const { store } = rt;
  // One confirm or undo at a time in this process (the store's unique index also stops a second copy for the year).
  let busy = false;

  function administrator(request: FastifyRequest): User {
    const user = deps.requireUser(request);
    if (user.disabled || !user.canManageAccess || deps.isTemporary(user, request)) throw new DomainError('forbidden', '年度の切り替えは、権限の管理者だけが使えます。');
    return user;
  }

  async function exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (busy) throw new DomainError('conflict', 'ほかの確定か取り消しを処理中です。終わってから、もう一度押してください。');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }

  const nameOf = (userId: string) => rt.people.nameOf(userId) ?? '（不明な利用者）';
  const today = () => jstDate(new Date(deps.clock()));

  function view(run: RunRow): RolloverRunView {
    const stale = ONCE_PER_YEAR_STEPS.includes(run.step) && isStale(run, deps.clock());
    // A run being taken back is 'running' with the claim time in undone_at; it keeps the summary of the copy, so say so.
    const undoing = run.status === 'running' && run.undoneAt !== null;
    const running = undoing
      ? stale
        ? '取り消しが途中で止まりました（「この写しを取り消す」で続きを取り消せます）'
        : '取り消しの途中です'
      : stale
        ? `途中で止まりました（${store.items(run.id).length} 件まで記録があります）`
        : '実行中（または途中で止まった）';
    return {
      id: run.id,
      step: run.step,
      sourceYear: run.sourceYear,
      targetYear: run.targetYear,
      status: run.status,
      actorName: nameOf(run.actorId),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summary: undoing ? running : run.summary || (run.status === 'running' ? running : ''),
      counts: run.counts,
      undoneAt: run.undoneAt,
      undoneByName: run.undoneBy ? nameOf(run.undoneBy) : null,
      stale,
      canUndo: ONCE_PER_YEAR_STEPS.includes(run.step) && (run.status === 'done' || stale),
    };
  }

  /** The 409 of a second copy for the same year: who did it, when, what, and how to start again. */
  function alreadyDone(run: RunRow): HttpError {
    const when = dateLabel(jstDate(new Date(run.finishedAt ?? run.startedAt)));
    const message =
      run.status === 'running' && run.undoneAt !== null
        ? `${run.targetYear}年度への「${ROLLOVER_STEP_LABELS[run.step]}」は、取り消しの途中です。写し直すときは、取り消しを終えてから確定してください（途中で止まった取り消しは「この写しを取り消す」で続けられます）。`
        : run.status === 'running'
          ? `${run.targetYear}年度への「${ROLLOVER_STEP_LABELS[run.step]}」は、${nameOf(run.actorId)}さんが実行中です（${when}に開始）。終わってから、記録を確かめてください。`
          : `${run.targetYear}年度への「${ROLLOVER_STEP_LABELS[run.step]}」は、${when}に${nameOf(run.actorId)}さんが済ませています（${run.summary}）。やり直すときは、その記録を取り消してから確定してください。`;
    return new HttpError(409, { error: 'already_done', message, run: view(run) });
  }

  /**
   * A confirm with nothing left to copy: it goes on only to close a run cut off after its last copy (the plan then
   * skips what that run made). Otherwise it names the run that stands, or says there is nothing to copy.
   */
  function nothingToCopy(step: RolloverStep, targetYear: number, now: string, message: string): void {
    const standing = store.standing(step, targetYear);
    if (standing && isStale(standing, now) && standing.undoneAt === null) return;
    if (standing) throw alreadyDone(standing);
    throw new DomainError('validation', message);
  }

  function requireOrganizations(): OrganizationsStore {
    if (!rt.organizations) throw new HttpError(404, { error: 'not_available', message: '団体の台帳はこのサーバーにありません。' });
    return rt.organizations;
  }
  function requireCalendar(): CalendarStore {
    if (!rt.calendar) throw new HttpError(404, { error: 'not_available', message: 'カレンダーの保存ファイルを開けませんでした。' });
    return rt.calendar;
  }

  /** The years worth offering: those the organizations hold, and the default one with its neighbours. */
  function years(defaultYear: number): number[] {
    const set = new Set([defaultYear - 1, defaultYear, defaultYear + 1]);
    if (rt.organizations) {
      // A read of the organizations' own table: the store has no list of its years.
      for (const r of rt.organizations.db.prepare('SELECT DISTINCT fiscal_year AS y FROM organizations').all() as { y: number }[]) set.add(Number(r.y));
    }
    return [...set].filter((y) => y >= ROLLOVER_LIMITS.yearMin && y <= ROLLOVER_LIMITS.yearMax).sort((a, b) => b - a);
  }

  // Why a step cannot be used here (the screen shows the step without its 「開く」), or null.
  const reasons: Record<RolloverStep, (user: User) => string | null> = {
    organizations: () => (rt.organizations ? null : '団体の台帳はこのサーバーにありません（委員会の受信箱を設定すると使えます）。'),
    calendar: () => (rt.calendar ? null : 'カレンダーの保存ファイルを開けませんでした。システム課に連絡してください。'),
    tasks: (user) => (!rt.tasks ? TASK_MESSAGES.off : rt.tasks.bridge.taskUserFor(user.id) === null ? TASK_MESSAGES.unbound : null),
    grants: () => (rt.grants.length > 0 ? null : 'このサーバーには、棚卸しできる権限の保存がありません。'),
    handover: () => null,
  };

  app.get('/api/rollover/meta', async (request): Promise<RolloverMetaResponse> => {
    const user = administrator(request);
    const q = deps.parse(metaQuery, request.query);
    const fallback = defaultSourceYear(today());
    const sourceYear = q.year ?? fallback;
    const targetYear = sourceYear + 1;
    return {
      sourceYear,
      targetYear,
      years: years(fallback),
      steps: ROLLOVER_STEPS.map((step) => {
        const reason = reasons[step](user);
        const last = store.lastOf(step, targetYear);
        return { step, label: ROLLOVER_STEP_LABELS[step], available: reason === null, reason, last: last ? view(last) : null };
      }),
      runs: store.list(30).map(view),
    };
  });

  // ---- step 1: organizations

  app.post('/api/rollover/organizations/preview', async (request): Promise<OrgPreviewResponse> => {
    administrator(request);
    const orgs = requireOrganizations();
    const body = deps.parse(orgBody, request.body);
    const plan = planOrganizations(orgs, body, rt.people.nameOf);
    const standing = store.standing('organizations', plan.targetYear);
    return { sourceYear: plan.sourceYear, targetYear: plan.targetYear, choices: orgChoices(orgs, body.sourceYear), items: plan.items, counts: plan.counts, planToken: plan.planToken, done: standing ? view(standing) : null };
  });

  app.post('/api/rollover/organizations/apply', async (request): Promise<RolloverApplyResponse> => {
    const user = administrator(request);
    const orgs = requireOrganizations();
    const body = deps.parse(orgApplyBody, request.body);
    return exclusive(() => {
      const plan = planOrganizations(orgs, body, rt.people.nameOf);
      if (plan.planToken !== body.planToken) throw PLAN_CHANGED('団体の内容');
      const now = deps.clock();
      if (plan.copies.length === 0) nothingToCopy('organizations', plan.targetYear, now, '写す団体がありません。種別と段階を選び直してください。');
      const begun = store.begin({ step: 'organizations', sourceYear: plan.sourceYear, targetYear: plan.targetYear, planToken: plan.planToken, actorId: user.id, now });
      if (begun.kind === 'exists') throw alreadyDone(begun.run);
      const { run, response } = applyOrganizations(orgs, store, begun.run, plan, user.id, now);
      return { run: view(run), ...response };
    });
  });

  // ---- step 2: the yearly schedule

  app.post('/api/rollover/calendar/preview', async (request): Promise<CalendarPreviewResponse> => {
    administrator(request);
    const calendar = requireCalendar();
    const body = deps.parse(calendarBody, request.body);
    const plan = planCalendar(calendar, body, today());
    const standing = store.standing('calendar', plan.targetYear);
    return { sourceYear: plan.sourceYear, targetYear: plan.targetYear, items: plan.items, counts: plan.counts, planToken: plan.planToken, done: standing ? view(standing) : null };
  });

  app.post('/api/rollover/calendar/apply', async (request): Promise<RolloverApplyResponse> => {
    const user = administrator(request);
    const calendar = requireCalendar();
    const body = deps.parse(calendarApplyBody, request.body);
    return exclusive(() => {
      const plan = planCalendar(calendar, body, today());
      if (plan.planToken !== body.planToken) throw PLAN_CHANGED('予定の内容');
      const now = deps.clock();
      if (plan.copies.length === 0) nothingToCopy('calendar', plan.targetYear, now, '写す予定がありません。');
      const begun = store.begin({ step: 'calendar', sourceYear: plan.sourceYear, targetYear: plan.targetYear, planToken: plan.planToken, actorId: user.id, now });
      if (begun.kind === 'exists') throw alreadyDone(begun.run);
      const { run, response } = applyCalendar(calendar, store, begun.run, plan, user.id, now);
      return { run: view(run), ...response };
    });
  });

  // ---- taking a copy back (steps 1 and 2)

  app.post('/api/rollover/runs/:runId/undo', async (request): Promise<RolloverUndoResponse> => {
    const user = administrator(request);
    const { runId } = deps.parse(runParams, request.params);
    return exclusive(() => {
      const run = store.get(runId);
      if (!run) throw notFound();
      if (!ONCE_PER_YEAR_STEPS.includes(run.step)) throw new DomainError('validation', 'この記録は取り消せません（書き出しと権限の棚卸しは、記録だけです）。');
      const now = deps.clock();
      // A completed run, or one cut off half way (its record holds what it made so far).
      const claimed = run.status === 'undone' ? null : store.claimUndo(run.id, now);
      if (!claimed) throw new HttpError(409, { error: 'not_done', message: run.status === 'undone' ? 'この記録はすでに取り消されています。' : 'この記録は実行中のため、取り消せません。', run: view(run) });
      let result: ReturnType<typeof undoOrganizations>;
      try {
        result = run.step === 'organizations' ? undoOrganizations(requireOrganizations(), store, run, user.id, now) : undoCalendar(requireCalendar(), store, run, user.id, now);
      } catch (err) {
        store.releaseUndo(run.id, claimed, run.undoneAt);
        throw err;
      }
      const undone = store.markUndone(run.id, user.id, now, result.undo);
      return { run: view(undone), removed: result.removed, kept: result.kept };
    });
  });

  // ---- step 3: open tasks (read only; the Task service keeps the tasks)

  app.get('/api/rollover/tasks', async (request): Promise<RolloverTasksResponse> => {
    const user = administrator(request);
    return openTasksByDepartment(rt.tasks, user);
  });

  app.post('/api/rollover/tasks/export', async (request, reply) => {
    const user = administrator(request);
    const { sourceYear } = deps.parse(exportBody, request.body);
    const result = await openTasksByDepartment(rt.tasks, user);
    if (result.state !== 'ok') throw new HttpError(result.state === 'unavailable' ? 503 : 409, { error: `tasks_${result.state}`, message: result.message ?? 'タスクを読めませんでした。' });
    const csv = tasksCsv(result);
    store.record({ step: 'tasks', sourceYear, targetYear: sourceYear + 1, actorId: user.id, now: deps.clock(), summary: `未完了のタスク ${result.total} 件を CSV に書き出した`, counts: { tasks: result.total, departments: result.groups.length } });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', attachmentDisposition(`未完了のタスク_${sourceYear}年度.csv`, `open-tasks-${sourceYear}.csv`))
      .send(csv);
  });

  // ---- step 4: grants

  app.get('/api/rollover/grants', async (request): Promise<GrantsResponse> => {
    administrator(request);
    return grantInventory(rt.grants, rt.people, rt.grantNotes());
  });

  app.post('/api/rollover/grants/preview', async (request): Promise<GrantPreviewResponse> => {
    administrator(request);
    const body = deps.parse(grantBody, request.body);
    const plan = planGrantRemoval(rt.grants, rt.people, body.keys);
    return { items: plan.items, counts: plan.counts, planToken: plan.planToken };
  });

  app.post('/api/rollover/grants/apply', async (request): Promise<GrantApplyResponse> => {
    const user = administrator(request);
    const body = deps.parse(grantApplyBody, request.body);
    // The same confirm sent again (a double click, a resend) is answered with its run before the plan is looked at:
    // the grants it removed are gone, so the plan would no longer match.
    const grantsDone = (run: RunRow) =>
      new HttpError(409, { error: 'already_done', message: `この確定は、${dateLabel(jstDate(new Date(run.startedAt)))}に済んでいます（${run.summary || '実行中'}）。続けて外すときは、下見を作り直してください。`, run: view(run) });
    const token = `${body.planToken}:${body.requestId}`;
    return exclusive(() => {
      const earlier = store.byPlan('grants', token);
      if (earlier) throw grantsDone(earlier);
      const plan = planGrantRemoval(rt.grants, rt.people, body.keys);
      if (plan.planToken !== body.planToken) throw PLAN_CHANGED('権限');
      if (plan.removals.length === 0) throw new DomainError('validation', '外す権限がありません。');
      const now = deps.clock();
      const begun = store.begin({ step: 'grants', sourceYear: body.sourceYear, targetYear: body.sourceYear + 1, planToken: token, actorId: user.id, now });
      if (begun.kind === 'exists') throw grantsDone(begun.run);
      const removed: GrantApplyResponse['removed'] = [];
      const failed: GrantApplyResponse['failed'] = [];
      for (const { item, entry } of plan.removals) {
        try {
          entry.revoke!(user, now);
          removed.push(item);
          store.addItem(begun.run.id, { kind: 'grant', sourceId: null, madeId: null, name: item.holderName, data: { key: item.key, source: item.sourceLabel, target: item.target, permission: item.permission } });
        } catch (err) {
          failed.push({ item, message: err instanceof Error ? err.message : '外せませんでした。' });
        }
      }
      const run = store.finish(begun.run.id, `権限 ${removed.length} 件を外した${failed.length > 0 ? `（${failed.length} 件は外せなかった）` : ''}`, { removed: removed.length, failed: failed.length }, now);
      return { run: view(run), removed, failed };
    });
  });

  // ---- step 5: the handover draft (made on request, not kept on the server)

  async function handover(user: User, sourceYear: number) {
    const tasks = rt.tasks ? await openTasksByDepartment(rt.tasks, user) : null;
    // The departments of the Task service name the decisions' keys; the open tasks' groups fill in any it lacks.
    const labels = await departmentLabels(rt.tasks, user);
    for (const g of tasks?.groups ?? []) if (!labels.has(g.key)) labels.set(g.key, g.label);
    const doc = handoverDocument(
      { decisions: rt.decisions, organizations: rt.organizations, calendar: rt.calendar, departmentLabel: (key) => labels.get(key) ?? key },
      sourceYear,
      tasks,
      store.list(200),
      deps.clock(),
    );
    return { doc, markdown: handoverMarkdown(doc) };
  }

  app.get('/api/rollover/handover', async (request): Promise<HandoverSummary> => {
    const user = administrator(request);
    const q = deps.parse(metaQuery, request.query);
    const sourceYear = q.year ?? defaultSourceYear(today());
    const { doc, markdown } = await handover(user, sourceYear);
    return { sourceYear, counts: { decisions: doc.decisions.length, organizations: doc.organizations.length, events: doc.events.length, openTasks: doc.tasks.total }, markdown, missing: doc.missing };
  });

  app.post('/api/rollover/handover/export', async (request, reply) => {
    const user = administrator(request);
    const { sourceYear, format } = deps.parse(handoverExportBody, request.body);
    const { doc, markdown } = await handover(user, sourceYear);
    store.record({
      step: 'handover',
      sourceYear,
      targetYear: sourceYear + 1,
      actorId: user.id,
      now: deps.clock(),
      summary: `引き継ぎの資料（${format === 'json' ? 'JSON' : 'Markdown'}）を書き出した`,
      counts: { decisions: doc.decisions.length, organizations: doc.organizations.length, events: doc.events.length },
    });
    const name = `引き継ぎ_${sourceYear}年度_下書き.${format === 'json' ? 'json' : 'md'}`;
    return reply
      .header('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8')
      .header('Content-Disposition', attachmentDisposition(name, `handover-${sourceYear}.${format === 'json' ? 'json' : 'md'}`))
      .send(format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : markdown);
  });
}
