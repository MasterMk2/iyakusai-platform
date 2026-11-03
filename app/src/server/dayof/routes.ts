import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CALENDAR_KIND_LABELS, jstDate, occurrenceInYear, sortByDateTime } from '../../shared/calendar.js';
import {
  DAYOF_LIMITS,
  DAYOF_PRIORITIES,
  DAYOF_STAFF_AUTHOR,
  DAYOF_TOKEN,
  DAYOF_VENUE_NAME,
  dayOfPeriodDay,
  jstDayStartIso,
  periodProblem,
  sortDayOfPosts,
  type DayOfAdminResponse,
  type DayOfBoardResponse,
  type DayOfDecisionItem,
  type DayOfEventItem,
  type DayOfNoticesResponse,
  type DayOfPeriod,
  type DayOfPostInput,
  type DayOfPostView,
  type DayOfSupplies,
} from '../../shared/dayof.js';
import { DECISION_DEPARTMENT_KEY, DECISION_LIMITS, DECISION_VENUE_LABELS } from '../../shared/decisions.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import type { CalendarStore } from '../calendar/store.js';
import { normalizeDecisionInput } from '../decisions/routes.js';
import type { DecisionsStore } from '../decisions/store.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { RentalAccess } from '../rental/access.js';
import type { RentalRuntime } from '../rental/routes.js';
import { SupplyStore } from '../rental/supplies/store.js';
import { DayOfStore, type DayOfPostRow, type PostOutcome, type StatusChange } from './store.js';

// Browser routes of the festival-day board. Committee members read the board; the posters (the access
// administrators, and the people and departments they chose) write notices; every committee member may record a
// decision on the spot (it goes to the decision register, whose rules are the same). Temporary staff read only the
// notices marked for them, through /api/dayof/notices (the one route of this module the Discord login lets them
// call), without the posters' names. Every check is made here, not only on the screen. Without the store (no
// mailbox folder and not the demo) every route answers 404.

export interface DayOfRouteDeps {
  /**
   * The signed-in person, and whether they are temporary staff; null for a person who may not read the board (a
   * disabled account, or an account without a Discord identity). Throws when nobody is signed in.
   */
  viewer: (request: FastifyRequest) => { user: User; staff: boolean } | null;
  listUsers: () => User[];
  /** The roster name of an account, or a placeholder (never an ID). */
  nameOf: (userId: string) => string;
  decisions: DecisionsStore | null;
  calendar: CalendarStore | null;
  rental: RentalRuntime | null;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_TEXT = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

const oneLine = (max: number) => z.string().max(max).refine((s) => !CONTROL_LINE.test(s), { message: '1行で、使えない文字を入れないでください。' });
const postParams = z.strictObject({ postId: z.string().regex(/^dp_[0-9a-f]{16}$/) });
const statusParams = z.strictObject({ postId: z.string().regex(/^dp_[0-9a-f]{16}$/), change: z.enum(['resolve', 'reopen', 'withdraw', 'restore']) });
const postShape = {
  body: z.string().max(DAYOF_LIMITS.body * 2).refine((s) => !CONTROL_TEXT.test(s), { message: '使えない文字が入っています。' }),
  priority: z.enum(DAYOF_PRIORITIES),
  place: oneLine(DAYOF_LIMITS.place),
  departments: z.array(oneLine(DAYOF_LIMITS.department)).max(DAYOF_LIMITS.departments),
  staffVisible: z.boolean(),
};
const createPostBody = z.strictObject({ ...postShape, clientToken: z.string().regex(DAYOF_TOKEN) });
const updatePostBody = z.strictObject({ ...postShape, expectedVersion: z.number().int().min(1) });
const versionBody = z.strictObject({ expectedVersion: z.number().int().min(1) });
const decisionBody = z.strictObject({
  title: oneLine(DECISION_LIMITS.title),
  place: oneLine(DAYOF_LIMITS.decisionPlace),
  departments: z.array(z.string().regex(DECISION_DEPARTMENT_KEY)).min(1).max(DECISION_LIMITS.departments),
  clientToken: z.string().regex(DAYOF_TOKEN),
});
const settingsBody = z.strictObject({
  startDate: z.string().max(10).nullable(),
  endDate: z.string().max(10).nullable(),
  rules: z.string().max(DAYOF_LIMITS.rules * 2),
  expectedVersion: z.number().int().min(1),
});
const posterBody = z.union([
  z.strictObject({ userId: z.string().min(1).max(200), on: z.boolean() }),
  z.strictObject({ department: oneLine(DAYOF_LIMITS.department).refine((s) => s.trim().length > 0), on: z.boolean() }),
]);

const invalid = (message: string, field: string): never => {
  throw new DomainError('validation', message, { field });
};

/** A notice as sent, trimmed and checked for what zod cannot state (lengths after trimming, lines, duplicates). */
export function normalizePostInput(raw: z.infer<z.ZodObject<typeof postShape>>): DayOfPostInput {
  const body = raw.body.replace(/\r\n?/g, '\n').trim();
  if (!body) invalid('連絡の本文を入れてください。', 'body');
  if ([...body].length > DAYOF_LIMITS.body) invalid(`本文は ${DAYOF_LIMITS.body} 字までにしてください。`, 'body');
  if (body.split('\n').length > DAYOF_LIMITS.bodyLines) invalid(`本文は ${DAYOF_LIMITS.bodyLines} 行までにしてください。`, 'body');
  const departments = [...new Set(raw.departments.map((d) => d.trim()).filter(Boolean))];
  return { body, priority: raw.priority, place: raw.place.trim(), departments, staffVisible: raw.staffVisible };
}

/** The rules text: line breaks kept (no other control characters), at most DAYOF_LIMITS.rules characters. */
function normalizeRules(text: string): string {
  const rules = text.replace(/\r\n?/g, '\n').trimEnd();
  if (CONTROL_TEXT.test(rules)) invalid('決め方の文に使えない文字が入っています。', 'rules');
  if ([...rules].length > DAYOF_LIMITS.rules) invalid(`決め方の文は ${DAYOF_LIMITS.rules} 字までにしてください。`, 'rules');
  return rules;
}

const REFUSED = {
  conflict: 'ほかの人が先にこの連絡を変更しました。最新の内容を読み込み直してから、もう一度操作してください。',
  not_allowed: 'この連絡は今の状態では、その操作ができません。最新の内容を読み込み直してください。',
} as const;

function settled(outcome: PostOutcome): DayOfPostRow {
  if (outcome === null) throw notFound();
  if (typeof outcome === 'string') throw new DomainError('conflict', REFUSED[outcome]);
  return outcome;
}

const isStaffUser = (u: User) => isTemporaryStaffLoginId(u.id) || departmentsOfLabel(u.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT);

export function registerDayOfRoutes(app: FastifyInstance, store: DayOfStore | null, deps: DayOfRouteDeps): void {
  if (!store) return;
  const supplies = deps.rental ? new SupplyStore(deps.rental.store) : null;
  const rentalAccess = deps.rental ? new RentalAccess(deps.rental.store, deps.rental.allMembersAdmin === true) : null;

  /** A committee member (temporary staff and others are refused). */
  function member(request: FastifyRequest): User {
    const v = deps.viewer(request);
    if (!v || v.staff) throw new DomainError('forbidden', '当日の欄は委員だけが使えます。');
    return v.user;
  }

  function admin(request: FastifyRequest): User {
    const user = member(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', '当日の設定は権限の管理者だけが変えられます。');
    return user;
  }

  /** Access administrators always; otherwise a grant to the person or to one of their departments. */
  function canPost(user: User): boolean {
    if (user.disabled || isStaffUser(user)) return false;
    if (user.canManageAccess) return true;
    const grants = store!.posterGrants();
    if (grants.users.includes(user.id)) return true;
    const mine = departmentsOfLabel(user.roleLabel).filter((d) => d !== TEMPORARY_STAFF_DEPARTMENT);
    return mine.some((d) => grants.departments.includes(d));
  }

  function poster(request: FastifyRequest): User {
    const user = member(request);
    if (!canPost(user)) throw new DomainError('forbidden', '当日の連絡を書けるのは、権限の管理者が選んだ発信者だけです。');
    return user;
  }

  const canEdit = (user: User, row: DayOfPostRow) => canPost(user) && (user.canManageAccess || row.createdBy === user.id);

  const now = () => deps.clock();
  const todayOf = (iso: string) => jstDate(new Date(iso));

  function period(): DayOfPeriod | null {
    const s = store!.settings();
    return s.startDate && s.endDate ? { startDate: s.startDate, endDate: s.endDate } : null;
  }

  function activeToday(): { today: string; period: DayOfPeriod | null; day: { index: number; total: number } | null } {
    const today = todayOf(now());
    const p = period();
    return { today, period: p, day: dayOfPeriodDay(today, p) };
  }

  /** The notices of today's board: those written since the period began (open, and today's resolved and withdrawn). */
  function boardRows(today: string, p: DayOfPeriod) {
    return store!.board({ dayStart: jstDayStartIso(today), periodStart: jstDayStartIso(p.startDate) }, DAYOF_LIMITS.closedShown);
  }

  function requireActive(): string {
    const { today, day } = activeToday();
    if (!day) throw new DomainError('conflict', '今日は当日の期間ではないため、書き込めません。期間は設定タブで権限の管理者が決めます。');
    return today;
  }

  const view = (row: DayOfPostRow, user: User | null, staff: boolean): DayOfPostView => ({
    ...row.input,
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    authorName: staff ? DAYOF_STAFF_AUTHOR : deps.nameOf(row.createdBy),
    updatedAt: row.updatedAt,
    edited: row.edited,
    resolvedAt: row.resolvedAt,
    resolvedByName: row.resolvedBy === null ? null : staff ? DAYOF_STAFF_AUTHOR : deps.nameOf(row.resolvedBy),
    version: row.version,
    canEdit: !!user && !staff && canEdit(user, row),
  });

  /** Department names of the committee members (the choices of the notice form and of the poster grants). */
  function departmentChoices(): string[] {
    const all = new Set(deps.listUsers().filter((u) => !u.disabled && !isStaffUser(u)).flatMap((u) => departmentsOfLabel(u.roleLabel)));
    all.delete(TEMPORARY_STAFF_DEPARTMENT);
    return [...all].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  function todaysDecisions(today: string): DayOfDecisionItem[] | null {
    if (!deps.decisions) return null;
    return deps.decisions.page({ terms: [], from: today, to: today }, 'decided', DAYOF_LIMITS.decisionsShown, 0).rows.map((r) => ({
      id: r.id,
      title: r.input.title,
      status: r.status,
      venueLabel: r.input.venue === 'other' ? r.input.venueOther : DECISION_VENUE_LABELS[r.input.venue],
      departments: r.input.departments,
      changeNote: r.changeNote,
      supersedes: r.supersedes,
      body: r.input.body,
      createdAt: r.createdAt,
    }));
  }

  /** Today's events from the calendar file alone (the Task service is not asked: the board is read every 30 seconds). */
  function todaysEvents(today: string): DayOfEventItem[] | null {
    if (!deps.calendar) return null;
    try {
      const rows = deps.calendar.range(today, today).map((r) => ({ row: r, date: r.data.date }));
      for (const r of deps.calendar.yearly()) {
        const occurrence = occurrenceInYear(r.data.date, Number(today.slice(0, 4)));
        if (occurrence === today && r.data.date !== today) rows.push({ row: r, date: occurrence });
      }
      const items = rows.map(({ row, date }) => ({ id: row.id, title: row.data.title, time: row.data.time, date, kindLabel: CALENDAR_KIND_LABELS[row.data.kind], departments: row.data.departments }));
      return sortByDateTime(items).map((e) => ({ id: e.id, title: e.title, time: e.time, kindLabel: e.kindLabel, departments: e.departments }));
    } catch {
      return null;
    }
  }

  /** Cards and units out and the groups not collected yet, for a person with a rental permission. */
  function suppliesOf(user: User): DayOfSupplies | null {
    if (!supplies || !rentalAccess) return null;
    try {
      const permissions = rentalAccess.permissions(user.id);
      if (!permissions.includes('rental.loan') && !permissions.includes('rental.issue')) return null;
      const groups = supplies.collection();
      return {
        cardsOut: groups.reduce((n, g) => n + g.cards_out, 0),
        unitsOut: groups.reduce((n, g) => n + g.units_out, 0),
        groupsOpen: groups.filter((g) => !g.collected).length,
      };
    } catch {
      return null;
    }
  }

  // ---- reading

  app.get('/api/dayof/board', async (request): Promise<DayOfBoardResponse> => {
    const user = member(request);
    const { today, period: p, day } = activeToday();
    const s = store.settings();
    const mayPost = canPost(user);
    const base: DayOfBoardResponse = {
      active: day !== null,
      today,
      period: p,
      day,
      revision: store.revision(),
      rules: '',
      canPost: mayPost,
      canDecide: deps.decisions !== null,
      posts: [],
      withdrawn: [],
      decisions: null,
      events: null,
      supplies: null,
      departmentChoices: [],
      decisionDepartments: [],
      generatedAt: now(),
    };
    // Outside the period the home screen shows nothing: only the period is answered.
    if (!day || !p) return base;
    const notices = boardRows(today, p);
    return {
      ...base,
      rules: s.rules,
      posts: sortDayOfPosts(notices.posts.map((r) => view(r, user, false))),
      withdrawn: mayPost ? notices.withdrawn.map((r) => view(r, user, false)) : [],
      decisions: todaysDecisions(today),
      events: todaysEvents(today),
      supplies: suppliesOf(user),
      departmentChoices: mayPost ? departmentChoices() : [],
      decisionDepartments: deps.decisions ? deps.decisions.departmentKeys() : [],
    };
  });

  // The notices alone, for the rental screen. Temporary staff see the open ones marked for them, without names.
  app.get('/api/dayof/notices', async (request): Promise<DayOfNoticesResponse> => {
    const v = deps.viewer(request);
    if (!v) throw new DomainError('forbidden', '当日の連絡は委員と臨時スタッフだけが読めます。');
    const { today, period: p, day } = activeToday();
    const answer: DayOfNoticesResponse = { active: day !== null, today, day, revision: store.revision(), staff: v.staff, posts: [] };
    if (!day || !p) return answer;
    const rows = boardRows(today, p).posts.filter((r) => r.status === 'open' && (!v.staff || r.input.staffVisible));
    return { ...answer, posts: sortDayOfPosts(rows.map((r) => view(r, v.staff ? null : v.user, v.staff))) };
  });

  // ---- notices (the posters)

  app.post('/api/dayof/posts', async (request, reply) => {
    const user = poster(request);
    const body = deps.parse(createPostBody, request.body);
    const { clientToken, ...rest } = body;
    const input = normalizePostInput(rest);
    requireActive();
    const result = store.create(input, user.id, now(), clientToken);
    return reply.code(result.replayed ? 200 : 201).send({ post: view(result.row, user, false), replayed: result.replayed, revision: store.revision() });
  });

  app.put('/api/dayof/posts/:postId', async (request) => {
    const user = poster(request);
    const { postId } = deps.parse(postParams, request.params);
    const { expectedVersion, ...rest } = deps.parse(updatePostBody, request.body);
    const current = store.get(postId);
    if (!current) throw notFound();
    if (!canEdit(user, current)) throw new DomainError('forbidden', '連絡を直せるのは、書いた人と権限の管理者だけです。');
    const row = settled(store.update(postId, expectedVersion, normalizePostInput(rest), user.id, now()));
    return { post: view(row, user, false), revision: store.revision() };
  });

  // 済 and back are for every poster (the headquarters share the board); withdrawing and restoring for its poster and the administrators.
  app.post('/api/dayof/posts/:postId/:change', async (request) => {
    const user = poster(request);
    const { postId, change } = deps.parse(statusParams, request.params);
    const { expectedVersion } = deps.parse(versionBody, request.body);
    const current = store.get(postId);
    if (!current) throw notFound();
    if ((change === 'withdraw' || change === 'restore') && !canEdit(user, current)) throw new DomainError('forbidden', '連絡を取り下げる・戻すのは、書いた人と権限の管理者だけです。');
    const row = settled(store.changeStatus(postId, change as StatusChange, expectedVersion, user.id, now()));
    return { post: view(row, user, false), revision: store.revision() };
  });

  // ---- a decision on the spot: into the decision register, as decided today at 当日本部

  app.post('/api/dayof/decisions', async (request, reply) => {
    const user = member(request);
    if (!deps.decisions) throw new DomainError('not_found', '決定事項の台帳はこのサーバーでは使えません。');
    const body = deps.parse(decisionBody, request.body);
    const today = requireActive();
    const place = body.place.trim();
    const input = normalizeDecisionInput({
      title: body.title,
      body: place ? `関係する場所・人：${place}` : '',
      departments: body.departments,
      decidedOn: today,
      venue: 'other',
      venueOther: DAYOF_VENUE_NAME,
      sources: [{ kind: 'manual', refId: null, label: `当日の画面（${DAYOF_VENUE_NAME}）`, link: '#/home' }],
      taskIds: [],
    });
    const result = deps.decisions.create(input, user.id, now(), `dayof-${body.clientToken}`.slice(0, 64));
    return reply.code(result.replayed ? 200 : 201).send({ decisionId: result.row.id, replayed: result.replayed });
  });

  // ---- settings (the access administrators)

  function adminView(): DayOfAdminResponse {
    const s = store!.settings();
    const people = deps
      .listUsers()
      .filter((u) => !u.disabled && !isStaffUser(u))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'))
      .map((u) => ({ id: u.id, displayName: u.displayName, roleLabel: u.roleLabel, canManageAccess: u.canManageAccess }));
    const names = new Map(people.map((p) => [p.id, p.displayName]));
    return {
      settings: { ...s, updatedByName: s.updatedBy ? deps.nameOf(s.updatedBy) : null },
      posters: store!.posterGrants(),
      people,
      departments: departmentChoices(),
      history: store!.adminHistory().map((h) => ({ at: h.at, actorName: deps.nameOf(h.actorId), action: h.action, detail: historyDetail(h.action, h.target, h.after, names) })),
      today: todayOf(now()),
    };
  }

  app.get('/api/dayof/admin', async (request): Promise<DayOfAdminResponse> => {
    admin(request);
    return adminView();
  });

  app.put('/api/dayof/admin/settings', async (request): Promise<DayOfAdminResponse> => {
    const user = admin(request);
    const body = deps.parse(settingsBody, request.body);
    const startDate = body.startDate?.trim() ? body.startDate.trim() : null;
    const endDate = body.endDate?.trim() ? body.endDate.trim() : null;
    const problem = periodProblem(startDate, endDate);
    if (problem) invalid(problem, 'period');
    const saved = store.saveSettings({ startDate, endDate, rules: normalizeRules(body.rules) }, body.expectedVersion, user.id, now());
    if (saved === 'conflict') throw new DomainError('conflict', 'ほかの管理者が先に当日の設定を変えました。最新の設定を読み込み直してから保存してください。');
    return adminView();
  });

  app.put('/api/dayof/admin/posters', async (request): Promise<DayOfAdminResponse> => {
    const user = admin(request);
    const body = deps.parse(posterBody, request.body);
    if ('userId' in body) {
      // Taking a grant away needs no current account (someone who left the roster can still lose it).
      if (body.on && !deps.listUsers().some((u) => u.id === body.userId && !u.disabled && !isStaffUser(u))) invalid('このアカウントは見つからないか、発信者にできません。', 'userId');
      store.setPosterGrant('user', body.userId, body.on, user.id, now());
    } else {
      const department = body.department.trim();
      if (body.on && !departmentChoices().includes(department)) invalid('この部局には今、委員がいません（Discord のロールで部局が決まります）。', 'department');
      store.setPosterGrant('department', department, body.on, user.id, now());
    }
    return adminView();
  });
}

/** One line of the administrators' history, in words. */
function historyDetail(action: string, target: string, after: unknown, names: Map<string, string>): string {
  if (action === 'settings') {
    const a = after as { startDate: string | null; endDate: string | null; rules: string };
    const range = a.startDate && a.endDate ? `期間 ${a.startDate}〜${a.endDate}` : '期間なし';
    return `${range}・決め方 ${a.rules ? `${[...a.rules].length} 字` : 'なし'}`;
  }
  const who = action.endsWith('_department') ? `${target}（部局）` : (names.get(target) ?? '利用できなくなったアカウント');
  return `${who}を発信者${action.startsWith('grant') ? 'にした' : 'から外した'}`;
}
