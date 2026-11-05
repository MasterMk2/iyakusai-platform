import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addDays,
  CALENDAR_KIND_LABELS,
  CALENDAR_LIMITS,
  CALENDAR_UNAVAILABLE,
  CalendarValidationError,
  daysBetween,
  isDateOnly,
  jstDate,
  occurrenceInYear,
  reminderLeft,
  sortByDateTime,
  TASK_REMIND_DAYS,
  validateCalendarEvent,
  type CalendarDetailResponse,
  type CalendarEventInput,
  type CalendarEventView,
  type CalendarListResponse,
  type CalendarYearlyResponse,
  type SubscriptionIssued,
  type SubscriptionResponse,
  type UpcomingItem,
  type UpcomingResponse,
  type UpcomingTasksState,
} from '../../shared/calendar.js';
import { compareDepartments } from '../../shared/departments.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import { isAssignedTo, type TaskView } from '../../shared/tasks.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { TaskRuntime } from '../tasks/routes.js';
import { buildIcs, clientAddress, FailureCounter, FeedCache, icalPath, newIcalToken, tokenFromFile, tokenHash, type IcsItem } from './ical.js';
import { CalendarStore, type CalendarEventRow } from './store.js';

// Committee calendar routes. Every screen route needs a signed-in committee member (temporary staff and disabled
// accounts are refused here, not only on the screen). Anyone may add or change an event; deleting needs to have
// made it or to be an access administrator. Each change keeps a history row and a version: a save with an old
// version is refused (409), so two people never overwrite each other silently.
//
// The iCal feed is the one route without a sign-in: the secret token in its URL is the only key. Every failure
// answers the same 404 as an unknown API path (the answer must not tell an unknown token from a switched-off feed
// or an owner who has left). Only unknown tokens count against the limit, so a feed in use is never refused.

export interface CalendarRuntime {
  store: CalendarStore;
  /** SMM_CALENDAR_ICAL: whether the subscription URL answers at all. */
  icalEnabled: boolean;
}

export interface CalendarRouteDeps {
  requireUser: (request: FastifyRequest) => User;
  /** Temporary staff (the Discord login names them): no committee calendar. The request is null for the feed. */
  isTemporary: (user: User, request: FastifyRequest | null) => boolean;
  lookupUser: (userId: string) => User | undefined;
  listUsers: () => User[];
  /** The Task service for deadlines, or null when tasks are off. */
  tasks: TaskRuntime | null;
  /** Whether a request came through the committee's own proxy (its X-Forwarded-For then names the client). */
  fromTrustedProxy: (request: FastifyRequest) => boolean;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

const NOT_FOUND = { error: 'not_found', message: 'API が見つかりません。' } as const;
const UNAVAILABLE = { error: CALENDAR_UNAVAILABLE, message: 'カレンダーの保存ファイルを開けませんでした。システム課に連絡してください（メールなどほかの機能は使えます）。' } as const;
const eventParams = z.strictObject({ eventId: z.string().regex(/^ev_[0-9a-f]{16}$/) });
const rangeQuery = z.strictObject({ from: z.string().max(10), to: z.string().max(10) });
const yearQuery = z.strictObject({ year: z.coerce.number().int().min(2000).max(2100).optional() });
const updateBody = z.strictObject({ expectedVersion: z.number().int().min(1), event: z.unknown() });
const deleteQuery = z.strictObject({ expectedVersion: z.coerce.number().int().min(1) });
/** The screen's ID for one create (kept for a resend of the same form). Letters, digits, - and _ only. */
const createQuery = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional() });
/** The home screen looks this many days ahead (the largest reminder choice is 14 days). */
const HOME_HORIZON_DAYS = 60;
/** The feed covers this many days back and forward from today. */
const FEED_BACK_DAYS = 30;
const FEED_FORWARD_DAYS = 400;
const FEED_TTL_MS = 10 * 60_000;

/** Two dates of a list request, checked and kept within the range the screen may ask for. */
function checkedRange(from: string, to: string): { from: string; to: string } {
  if (!isDateOnly(from) || !isDateOnly(to)) throw new DomainError('validation', '期間の日付は 2026-04-01 のように入れてください。');
  if (from > to) throw new DomainError('validation', '期間は、始まりより後の日を終わりにしてください。');
  if (daysBetween(from, to) > CALENDAR_LIMITS.rangeDaysMax) throw new DomainError('validation', `一度に表示できる期間は ${CALENDAR_LIMITS.rangeDaysMax} 日までです。`);
  return { from, to };
}

function checked(input: unknown): CalendarEventInput {
  try {
    return validateCalendarEvent(input);
  } catch (err) {
    if (err instanceof CalendarValidationError) throw new DomainError('validation', err.message, { field: err.field });
    throw err;
  }
}

/** Departments of a person, from the role label (the same rule as the mailbox's). */
const myDepartmentsOf = (user: User): string[] => departmentsOfLabel(user.roleLabel);

/** An event is for a person when it names one of their departments, or names none (committee-wide). */
const isForDepartments = (departments: string[], mine: string[]) => departments.length === 0 || departments.some((d) => mine.includes(d));
/** A yearly event copied by the year rollover shows from its own year on; the years before have its original. */
const projectsInto = (row: CalendarEventRow, year: number) => row.copiedFrom === null || year >= Number(row.data.date.slice(0, 4));

/**
 * `runtime` null: the calendar file could not be opened. The screen routes then answer 503 and the rest of the app
 * works as usual; the feed answers the generic 404.
 */
export function registerCalendarRoutes(app: FastifyInstance, runtime: CalendarRuntime | null, deps: CalendarRouteDeps): void {
  const hidden = (reply: FastifyReply) => reply.code(404).send(NOT_FOUND);
  const feeds = new FeedCache(FEED_TTL_MS);
  const perAddress = new FailureCounter(20, 10 * 60_000);
  const everyone = new FailureCounter(300, 10 * 60_000);

  function member(request: FastifyRequest): User {
    const user = deps.requireUser(request);
    if (user.disabled || deps.isTemporary(user, request)) throw new DomainError('forbidden', 'カレンダーは委員だけが使えます。');
    return user;
  }

  /** This person's open tasks from the Task service, or null when there is no task identity or the service is down. */
  async function ownTasks(user: User): Promise<TaskView[] | null> {
    if (!deps.tasks) return null;
    const actor = deps.tasks.bridge.taskUserFor(user.id);
    if (!actor) return null;
    try {
      return (await deps.tasks.client.listAllTasks(actor)).filter((t) => isAssignedTo(t, actor));
    } catch {
      return null;
    }
  }

  // ---- the iCal feed: public (no sign-in), reached through the proxy, the same 404 for every failure

  app.get('/api/calendar/ical/:file', async (request, reply) => {
    const file = (request.params as { file?: unknown }).file;
    const store = runtime?.store ?? null;
    if (!runtime || !runtime.icalEnabled || !store || typeof file !== 'string') return hidden(reply);
    const token = tokenFromFile(file);
    const userId = token ? store.subscriptionUser(tokenHash(token)) : null;
    if (userId === null) {
      // Only failures count, per address and for all addresses together: guessing is slowed, a valid feed never waits.
      const now = Date.now();
      const address = clientAddress(request, deps.fromTrustedProxy(request));
      if (!perAddress.allow(address, now) || !everyone.allow('*', now)) {
        return reply.code(429).header('Retry-After', '600').header('Cache-Control', 'no-store').send({ error: 'rate_limited', message: 'しばらく待ってから、もう一度読み込んでください。' });
      }
      return hidden(reply);
    }
    // The owner is checked on every fetch: someone who has left the committee stops receiving the feed at once.
    const owner = deps.lookupUser(userId);
    if (!owner || owner.disabled || deps.listUsers().every((u) => u.id !== userId) || deps.isTemporary(owner, null)) return hidden(reply);
    const nowMs = Date.parse(deps.clock());
    let body = feeds.get(userId, nowMs);
    if (body === null) {
      const built = await buildFeed(store, owner, nowMs);
      body = built.text;
      // A feed without the tasks (the Task service did not answer) is not kept: the next poll asks again.
      if (built.complete) feeds.set(userId, body, nowMs);
    }
    reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff');
    return reply.send(body);
  });

  /**
   * The feed of one owner: the events of their departments and the committee-wide ones, and their own tasks' deadlines.
   * Title and date only (all day): no time, memo, assignee or other person's details.
   */
  async function buildFeed(store: CalendarStore, owner: User, nowMs: number): Promise<{ text: string; complete: boolean }> {
    const today = jstDate(new Date(nowMs));
    const from = addDays(today, -FEED_BACK_DAYS);
    const to = addDays(today, FEED_FORWARD_DAYS);
    const mine = myDepartmentsOf(owner);
    const items: IcsItem[] = [];
    const seen = new Set<string>();
    const push = (key: string, title: string, date: string) => {
      if (seen.has(`${key}|${date}`)) return;
      seen.add(`${key}|${date}`);
      items.push({ key: `${key}-${date.replaceAll('-', '')}`, title, date });
    };
    for (const row of store.range(from, to)) {
      if (isForDepartments(row.data.departments, mine)) push(row.id, row.data.title, row.data.date);
    }
    for (const row of store.yearly()) {
      if (!isForDepartments(row.data.departments, mine)) continue;
      for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
        const occurrence = occurrenceInYear(row.data.date, y);
        if (occurrence >= from && occurrence <= to && projectsInto(row, y)) push(row.id, row.data.title, occurrence);
      }
    }
    const own = await ownTasks(owner);
    const hasTasks = deps.tasks !== null && deps.tasks.bridge.taskUserFor(owner.id) !== null;
    for (const task of own ?? []) {
      if (task.status === 'done' || !task.deadline || !isDateOnly(task.deadline.slice(0, 10))) continue;
      const date = task.deadline.slice(0, 10);
      if (date >= from && date <= to) push(`task-${task.id}`, `タスク: ${task.title}`, date);
    }
    const ordered = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'ja'));
    return { text: buildIcs(ordered, new Date(nowMs).toISOString()), complete: !hasTasks || own !== null };
  }

  if (!runtime || !runtime.store) {
    const unavailable = async (request: FastifyRequest) => {
      member(request);
      throw new HttpError(503, UNAVAILABLE);
    };
    app.all('/api/calendar', unavailable);
    app.all('/api/calendar/*', unavailable);
    return;
  }
  const store = runtime.store;
  const icalEnabled = runtime.icalEnabled;

  const nameOf = (userId: string) => deps.lookupUser(userId)?.displayName ?? '（不明な利用者）';

  // `date` is the day shown (another year's day for an occurrence); `baseDate` is the day the record holds.
  const view = (row: CalendarEventRow, user: User, date = row.data.date, occurrence = false): CalendarEventView => ({
    ...row.data,
    date,
    baseDate: row.data.date,
    id: row.id,
    version: row.version,
    copiedFrom: row.copiedFrom,
    occurrence,
    createdByName: nameOf(row.createdBy),
    updatedAt: row.updatedAt,
    updatedByName: nameOf(row.updatedBy),
    canDelete: user.canManageAccess || row.createdBy === user.id,
  });

  const historyOf = (id: string) => store.history(id).map((h) => ({ at: h.at, actorName: nameOf(h.actorId), action: h.action, changed: h.changed }));

  /** Every department name in use: the events' and the people's roles' (the vocabulary of the filter and the form). */
  const departmentChoices = (): string[] => {
    const names = new Set(store.departmentNames());
    for (const u of deps.listUsers()) for (const d of myDepartmentsOf(u)) names.add(d);
    names.delete(TEMPORARY_STAFF_DEPARTMENT);
    return [...names].sort(compareDepartments);
  };

  app.get('/api/calendar/events', async (request): Promise<CalendarListResponse> => {
    const user = member(request);
    const q = deps.parse(rangeQuery, request.query);
    const { from, to } = checkedRange(q.from, q.to);
    const events: CalendarEventView[] = store.range(from, to).map((row) => view(row, user));
    // A yearly event also shows on the same month and day of each year in range (its stored date is listed above).
    for (const row of store.yearly()) {
      for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
        const occurrence = occurrenceInYear(row.data.date, y);
        if (occurrence >= from && occurrence <= to && occurrence !== row.data.date && projectsInto(row, y)) events.push(view(row, user, occurrence, true));
      }
    }
    return { events: sortByDateTime(events), departments: departmentChoices(), myDepartments: myDepartmentsOf(user), canAdminister: user.canManageAccess };
  });

  // The yearly schedule (毎年): every marked event on the date it falls on in the chosen year. Copying it to the
  // next year is the year-rollover owner's job; the dates here are shifted by the same rule (shared/calendar.ts).
  app.get('/api/calendar/yearly', async (request): Promise<CalendarYearlyResponse> => {
    const user = member(request);
    const q = deps.parse(yearQuery, request.query);
    const year = q.year ?? Number(jstDate(new Date(deps.clock())).slice(0, 4));
    const items = store.yearly().map((row) => ({ event: view(row, user), occurrence: occurrenceInYear(row.data.date, year) }));
    items.sort((a, b) => a.occurrence.slice(5).localeCompare(b.occurrence.slice(5)) || (a.event.time ?? '').localeCompare(b.event.time ?? '') || a.event.title.localeCompare(b.event.title, 'ja'));
    return { year, items };
  });

  // Near deadlines for the home screen: events whose reminder days have begun, and the person's own open tasks due soon.
  app.get('/api/calendar/upcoming', async (request): Promise<UpcomingResponse> => {
    const user = member(request);
    const today = jstDate(new Date(deps.clock()));
    const horizon = addDays(today, HOME_HORIZON_DAYS);
    const mine = myDepartmentsOf(user);
    const items: UpcomingItem[] = [];
    const consider = (row: CalendarEventRow, date: string) => {
      if (!isForDepartments(row.data.departments, mine)) return;
      const left = reminderLeft(row.data, date, today);
      if (left !== null) items.push({ kind: 'event', id: row.id, title: row.data.title, date, daysLeft: left, label: CALENDAR_KIND_LABELS[row.data.kind] });
    };
    for (const row of store.range(today, horizon)) consider(row, row.data.date);
    // The window can cross the year end (December to January): the yearly events of both years are looked at.
    for (const row of store.yearly()) {
      for (let y = Number(today.slice(0, 4)); y <= Number(horizon.slice(0, 4)); y += 1) {
        const occurrence = occurrenceInYear(row.data.date, y);
        if (occurrence >= today && occurrence <= horizon && occurrence !== row.data.date && projectsInto(row, y)) consider(row, occurrence);
      }
    }
    let tasks: UpcomingTasksState = 'ok';
    if (!deps.tasks) tasks = 'off';
    else if (!deps.tasks.bridge.taskUserFor(user.id)) tasks = 'unbound';
    else {
      // One call to the Task service for the whole answer (the home screen shows the list, not a count per task).
      const own = await ownTasks(user);
      if (own === null) tasks = 'unavailable';
      else {
        for (const task of own) {
          if (task.status === 'done' || !task.deadline || !isDateOnly(task.deadline.slice(0, 10))) continue;
          const date = task.deadline.slice(0, 10);
          const left = daysBetween(today, date);
          if (left >= 0 && left <= TASK_REMIND_DAYS) items.push({ kind: 'task', id: task.id, title: task.title, date, daysLeft: left, label: `タスク・${TASK_LABEL[task.status]}` });
        }
      }
    }
    items.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title, 'ja'));
    return { items, tasks };
  });

  app.get('/api/calendar/events/:eventId', async (request): Promise<CalendarDetailResponse> => {
    const user = member(request);
    const { eventId } = deps.parse(eventParams, request.params);
    const row = store.get(eventId);
    if (!row) throw notFound();
    return { event: view(row, user), history: historyOf(row.id) };
  });

  // A create with ?requestId= is idempotent: a resend of the same ID answers the event the first send made (200),
  // and an event deleted since then is not made again (404). Without the ID every send makes a new event (201).
  app.post('/api/calendar/events', async (request, reply) => {
    const user = member(request);
    const { requestId } = deps.parse(createQuery, request.query);
    const data = checked(request.body);
    if (requestId === undefined) {
      const row = store.create(data, user.id, deps.clock());
      return reply.code(201).send({ event: view(row, user), history: historyOf(row.id) } satisfies CalendarDetailResponse);
    }
    const outcome = store.createOnce(requestId, user.id, data, deps.clock());
    if (outcome.kind === 'gone') throw notFound();
    const status = outcome.kind === 'created' ? 201 : 200;
    return reply.code(status).send({ event: view(outcome.row, user), history: historyOf(outcome.row.id) } satisfies CalendarDetailResponse);
  });

  app.put('/api/calendar/events/:eventId', async (request): Promise<CalendarDetailResponse> => {
    const user = member(request);
    const { eventId } = deps.parse(eventParams, request.params);
    const body = deps.parse(updateBody, request.body);
    const result = store.update(eventId, body.expectedVersion, checked(body.event), user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの予定を変更しました。最新の内容を読み込み直してから、もう一度変更してください。');
    return { event: view(result, user), history: historyOf(result.id) };
  });

  app.delete('/api/calendar/events/:eventId', async (request, reply) => {
    const user = member(request);
    const { eventId } = deps.parse(eventParams, request.params);
    const { expectedVersion } = deps.parse(deleteQuery, request.query);
    const row = store.get(eventId);
    if (!row) throw notFound();
    if (!(user.canManageAccess || row.createdBy === user.id)) throw new DomainError('forbidden', '予定を削除できるのは、登録した人と権限の管理者だけです。');
    const result = store.delete(eventId, expectedVersion, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの予定を変更しました。最新の内容を確かめてから削除してください。');
    return reply.code(204).send();
  });

  // ---- the personal subscription URL (one per person; a new one stops the old one at once)

  app.get('/api/calendar/subscription', async (request): Promise<SubscriptionResponse> => {
    const user = member(request);
    const row = store.subscription(user.id);
    return { available: icalEnabled, subscribed: row !== null, createdAt: row?.createdAt ?? null, rotatedAt: row?.rotatedAt ?? null };
  });

  app.post('/api/calendar/subscription', async (request): Promise<SubscriptionIssued> => {
    const user = member(request);
    if (!icalEnabled) throw new HttpError(404, NOT_FOUND);
    const token = newIcalToken();
    const now = deps.clock();
    const before = store.subscription(user.id);
    store.putSubscription(user.id, tokenHash(token), now);
    return { path: icalPath(token), createdAt: before?.createdAt ?? now, rotatedAt: now };
  });

  app.delete('/api/calendar/subscription', async (request, reply) => {
    const user = member(request);
    if (!icalEnabled) throw new HttpError(404, NOT_FOUND);
    store.removeSubscription(user.id);
    return reply.code(204).send();
  });
}

const TASK_LABEL: Record<TaskView['status'], string> = { todo: '未着手', in_progress: '進行中', blocked: '保留', done: '完了' };
