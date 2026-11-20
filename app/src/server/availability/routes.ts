import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  audienceIncludes,
  AVAILABILITY_LIMITS,
  availabilityDays,
  AvailabilityValidationError,
  busyMinutesByDay,
  jstMidnight,
  normalizeCalendarId,
  showsBusy,
  validateAudience,
  validateDetail,
  type AvailabilityAudience,
  type AvailabilityChallengeView,
  type AvailabilityConnectionView,
  type AvailabilityListResponse,
  type AvailabilityMeResponse,
  type AvailabilityPerson,
} from '../../shared/availability.js';
import { addDays, daysBetween, isDateOnly, jstDate } from '../../shared/calendar.js';
import { compareDepartments } from '../../shared/departments.js';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import { DomainError, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { FreeBusySource } from './google.js';
import type { AvailabilityService } from './service.js';
import type { AvailabilityStore, ChallengeRow, ConnectionRow } from './store.js';

// Free/busy routes (2026-11-20). Every route needs a signed-in committee member (temporary staff and disabled
// accounts are refused). A member connects their own calendar only: the screen gives a time, the member puts an
// event there in Google Calendar, and the server sees that time turn busy (only someone who can write to the
// calendar can do that). Who may see a member's busy periods is the member's choice, checked here on every read;
// the calendar's ID is shown to its owner only. How coarse is the owner's choice too, and it is applied here: a
// member who shares parts of the day (午前・午後・夜) has no times in any answer.

export interface AvailabilityRuntime {
  store: AvailabilityStore;
  service: AvailabilityService;
}

/** What the composition gives buildApp: the store and Google (or the demo's stand-in); buildApp makes the service. */
export interface AvailabilityOptions {
  store: AvailabilityStore;
  source: FreeBusySource;
  serviceAccount: string;
  refreshMinutes: number;
  horizonDays: number;
  /** Read Google every refreshMinutes (default true; tests call refreshAll themselves). */
  autoRefresh?: boolean;
  /** Given the service once it is made (tests read Google through it at the moment they choose). */
  onService?: (service: AvailabilityService) => void;
}

export interface AvailabilityRouteDeps {
  requireUser: (request: FastifyRequest) => User;
  /** Temporary staff (the Discord login names them). The request is null when the person is not the one asking. */
  isTemporary: (user: User, request: FastifyRequest | null) => boolean;
  lookupUser: (userId: string) => User | undefined;
  listUsers: () => User[];
  /** The person's ID in the Task service (what a task's assignee holds), or null. */
  taskUserFor: (userId: string) => string | null;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

const rangeQuery = z.strictObject({ from: z.string().max(10), to: z.string().max(10) });
const challengeBody = z.strictObject({ calendarId: z.unknown(), audience: z.unknown(), detail: z.unknown() });
const settingsBody = z.strictObject({ audience: z.unknown(), detail: z.unknown() });

/** The check's event: two days ahead, starting between 03:00 and 04:59, for 25 minutes (an hour nobody books). */
const SLOT_DAYS_AHEAD = 2;
const SLOT_MINUTES = 25;
/** A check not finished within this time is dropped (start again). */
const CHALLENGE_TTL_MS = 7 * 86_400_000;

const OFF = { error: 'not_found', message: 'API が見つかりません。' } as const;

/** A per-person limit on the requests that ask Google (a mistake loop must not spend the account's quota). */
class Budget {
  private readonly uses = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string, now: number): boolean {
    const recent = (this.uses.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.uses.set(key, recent);
      return false;
    }
    recent.push(now);
    this.uses.set(key, recent);
    return true;
  }
}

function checkedInput<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AvailabilityValidationError) throw new DomainError('validation', err.message, { field: err.field });
    throw err;
  }
}

const hhmm = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16);

export function registerAvailabilityRoutes(app: FastifyInstance, runtime: AvailabilityRuntime | null, deps: AvailabilityRouteDeps): void {
  const challenges = new Budget(10, 3600_000);
  const verifies = new Budget(30, 3600_000);

  function member(request: FastifyRequest): User {
    const user = deps.requireUser(request);
    if (user.disabled || deps.isTemporary(user, request)) throw new DomainError('forbidden', '空き具合は委員だけが使えます。');
    return user;
  }

  /** The current committee members (whose calendars may be read and who may be chosen as viewers). */
  const members = (): User[] => deps.listUsers().filter((u) => !u.disabled && !deps.isTemporary(u, null));

  const departmentChoices = (): string[] => {
    const names = new Set<string>();
    for (const u of members()) for (const d of departmentsOfLabel(u.roleLabel)) names.add(d);
    names.delete(TEMPORARY_STAFF_DEPARTMENT);
    return [...names].sort(compareDepartments);
  };

  /** The audience as chosen, kept to departments and people that exist (the owner is never listed). */
  const sanitized = (audience: AvailabilityAudience, ownerId: string): AvailabilityAudience => {
    const departments = new Set(departmentChoices());
    const people = new Set(members().map((u) => u.id));
    return { everyone: audience.everyone, departments: audience.departments.filter((d) => departments.has(d)), people: audience.people.filter((p) => p !== ownerId && people.has(p)) };
  };

  if (!runtime) {
    app.get('/api/availability/me', async (request): Promise<AvailabilityMeResponse> => {
      member(request);
      return { enabled: false, serviceAccount: null, connection: null, challenge: null, choices: { departments: [], people: [] }, horizonDays: 0, refreshMinutes: 0 };
    });
    app.get('/api/availability', async (request): Promise<AvailabilityListResponse> => {
      member(request);
      const today = jstDate(new Date(deps.clock()));
      return { enabled: false, from: today, to: today, coveredTo: today, people: [] };
    });
    const off = async (request: FastifyRequest) => {
      member(request);
      throw new HttpError(404, OFF);
    };
    app.all('/api/availability/me/*', off);
    app.put('/api/availability/me', off);
    app.delete('/api/availability/me', off);
    return;
  }
  const { store, service } = runtime;

  const connectionView = (c: ConnectionRow): AvailabilityConnectionView => {
    const b = service.busyOf(c.userId);
    return { calendarId: c.calendarId, audience: c.audience, detail: c.detail, connectedAt: c.connectedAt, updatedAt: c.updatedAt, state: b.state, fetchedAt: b.fetchedAt };
  };
  const challengeView = (ch: ChallengeRow): AvailabilityChallengeView => ({
    calendarId: ch.calendarId,
    date: jstDate(new Date(ch.slotStart)),
    start: hhmm(ch.slotStart),
    end: hhmm(ch.slotEnd),
    createdAt: ch.createdAt,
  });
  /** The member's pending check, dropped when it is too old. */
  const liveChallenge = (userId: string): ChallengeRow | null => {
    const ch = store.challenge(userId);
    if (ch && Date.parse(deps.clock()) - Date.parse(ch.createdAt) > CHALLENGE_TTL_MS) {
      store.removeChallenge(userId);
      return null;
    }
    return ch;
  };

  const me = (user: User): AvailabilityMeResponse => {
    const c = store.connection(user.id);
    const ch = liveChallenge(user.id);
    return {
      enabled: true,
      serviceAccount: service.serviceAccount,
      connection: c ? connectionView(c) : null,
      challenge: ch ? challengeView(ch) : null,
      choices: {
        departments: departmentChoices(),
        people: members()
          .filter((u) => u.id !== user.id)
          .map((u) => ({ id: u.id, displayName: u.displayName }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja')),
      },
      horizonDays: service.options.horizonDays,
      refreshMinutes: service.options.refreshMinutes,
    };
  };

  app.get('/api/availability/me', async (request): Promise<AvailabilityMeResponse> => me(member(request)));

  // Step 1: the calendar's ID and the choices. The server checks the calendar is shared with the account, then
  // gives a free time to put an event at. Nothing is connected yet.
  app.post('/api/availability/me/challenge', async (request): Promise<AvailabilityMeResponse> => {
    const user = member(request);
    const body = deps.parse(challengeBody, request.body);
    const calendarId = checkedInput(() => normalizeCalendarId(body.calendarId));
    const audience = sanitized(checkedInput(() => validateAudience(body.audience)), user.id);
    const detail = checkedInput(() => validateDetail(body.detail));
    const owner = store.ownerOfCalendar(calendarId);
    if (owner !== null && owner !== user.id) throw new DomainError('conflict', 'このカレンダーは、ほかの委員がすでにつないでいます。自分のカレンダーの ID か確かめてください。');
    if (!challenges.take(user.id, Date.parse(deps.clock()))) throw new HttpError(429, { error: 'rate_limited', message: '確かめる手続きを何度も始めています。1 時間ほど待ってから、もう一度始めてください。' });
    const day = addDays(jstDate(new Date(deps.clock())), SLOT_DAYS_AHEAD);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const startMs = Date.parse(jstMidnight(day)) + (3 * 60 + randomInt(0, 120)) * 60_000;
      const slotStart = new Date(startMs).toISOString();
      const slotEnd = new Date(startMs + SLOT_MINUTES * 60_000).toISOString();
      const check = await service.checkSlot(calendarId, slotStart, slotEnd);
      if (check.kind === 'not_shared') {
        throw new DomainError('validation', `このカレンダーは、まだ委員会のアカウント（${service.serviceAccount}）に共有されていません。Google カレンダーの「設定と共有」→「特定のユーザーまたはグループと共有する」で、このアドレスを「予定の表示（時間枠のみ、詳細は非表示）」で追加してから、もう一度押してください。`, { field: 'calendarId' });
      }
      if (check.kind === 'error') throw new HttpError(503, { error: 'google_unavailable', message: 'Google カレンダーを読めませんでした。少し待ってから、もう一度押してください。' });
      if (check.overlapped) continue;
      store.putChallenge({ userId: user.id, calendarId, slotStart, slotEnd, audience, detail, createdAt: deps.clock() });
      return me(user);
    }
    throw new HttpError(503, { error: 'no_free_slot', message: '確かめに使える空いた時間が見つかりませんでした。少し待ってから、もう一度押してください。' });
  });

  // Step 2: the member has put the event. The time is busy now → the calendar is connected with the choices of step 1.
  app.post('/api/availability/me/verify', async (request): Promise<AvailabilityMeResponse> => {
    const user = member(request);
    const ch = liveChallenge(user.id);
    if (!ch) throw new DomainError('not_found', '確かめる手続きがありません。最初からやり直してください。');
    if (!verifies.take(user.id, Date.parse(deps.clock()))) throw new HttpError(429, { error: 'rate_limited', message: '何度も確かめています。少し待ってから、もう一度押してください。' });
    const check = await service.checkSlot(ch.calendarId, ch.slotStart, ch.slotEnd);
    if (check.kind === 'not_shared') throw new DomainError('validation', `このカレンダーが委員会のアカウント（${service.serviceAccount}）に共有されていません。共有を確かめてください。`);
    if (check.kind === 'error') throw new HttpError(503, { error: 'google_unavailable', message: 'Google カレンダーを読めませんでした。少し待ってから、もう一度押してください。' });
    if (!check.covered) {
      throw new DomainError('validation', `まだ ${challengeView(ch).date} ${challengeView(ch).start}〜${challengeView(ch).end} に予定が見つかりません。その時間に予定を入れて（「予定あり」のまま）、1 分ほど待ってからもう一度押してください。`);
    }
    const result = store.connect({ ...ch, audience: sanitized(ch.audience, user.id) }, deps.clock());
    if (result === 'taken') throw new DomainError('conflict', 'このカレンダーは、ほかの委員がすでにつないでいます。');
    await service.refreshOne(user.id);
    return me(user);
  });

  app.delete('/api/availability/me/challenge', async (request): Promise<AvailabilityMeResponse> => {
    const user = member(request);
    store.removeChallenge(user.id);
    return me(user);
  });

  app.put('/api/availability/me', async (request): Promise<AvailabilityMeResponse> => {
    const user = member(request);
    const body = deps.parse(settingsBody, request.body);
    const audience = sanitized(checkedInput(() => validateAudience(body.audience)), user.id);
    const detail = checkedInput(() => validateDetail(body.detail));
    if (!store.updateSettings(user.id, audience, detail, deps.clock())) throw new DomainError('not_found', 'つないでいるカレンダーがありません。');
    return me(user);
  });

  // Stopping: the connection and what is kept in memory go at once. The member also removes the sharing in Google.
  app.delete('/api/availability/me', async (request): Promise<AvailabilityMeResponse> => {
    const user = member(request);
    store.disconnect(user.id);
    service.forget(user.id);
    return me(user);
  });

  app.get('/api/availability', async (request): Promise<AvailabilityListResponse> => {
    const viewer = member(request);
    const q = deps.parse(rangeQuery, request.query);
    if (!isDateOnly(q.from) || !isDateOnly(q.to) || q.from > q.to) throw new DomainError('validation', '期間の日付は 2026-04-01 のように入れてください。');
    if (daysBetween(q.from, q.to) > AVAILABILITY_LIMITS.rangeDaysMax) throw new DomainError('validation', `一度に見られる期間は ${AVAILABILITY_LIMITS.rangeDaysMax} 日までです。`);
    const window = service.window();
    const viewerDepartments = departmentsOfLabel(viewer.roleLabel);
    const current = new Map(members().map((u) => [u.id, u]));
    const people: AvailabilityPerson[] = [];
    for (const c of store.connections()) {
      const owner = current.get(c.userId);
      if (!owner || !audienceIncludes(c.audience, owner.id, { id: viewer.id, departments: viewerDepartments })) continue;
      const b = service.busyOf(owner.id);
      // Only the asked days that were read: earlier days than today and later than the horizon are not known.
      const from = q.from > b.from ? q.from : b.from;
      const to = q.to < b.to ? q.to : b.to;
      const days = showsBusy(b.state) && from <= to ? availabilityDays(busyMinutesByDay(b.busy, from, to), c.detail) : [];
      people.push({ userId: owner.id, taskUserId: deps.taskUserFor(owner.id), displayName: owner.displayName, self: owner.id === viewer.id, detail: c.detail, state: b.state, fetchedAt: b.fetchedAt, days });
    }
    people.sort((a, b) => Number(b.self) - Number(a.self) || a.displayName.localeCompare(b.displayName, 'ja'));
    return { enabled: true, from: q.from, to: q.to, coveredTo: window.to, people };
  });
}
