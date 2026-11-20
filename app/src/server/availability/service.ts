import { addDays, jstDate } from '../../shared/calendar.js';
import { jstMidnight, type AvailabilityState } from '../../shared/availability.js';
import { FreeBusyError, type CalendarFreeBusy, type FreeBusySource } from './google.js';
import type { AvailabilityStore } from './store.js';

// The busy periods of the connected calendars, read from Google every few minutes and kept in memory only: they are
// never written to a file, so a restart starts empty (the first read runs at once) and nothing old survives a
// disconnect. A calendar Google says is not shared any more loses its periods at once. A read that fails keeps the
// last good periods for a while (shown as 'stale' with their time), then drops them: a failure never reads as free.

/** Periods older than this are dropped even if every later read failed. */
const DROP_AFTER_MS = 12 * 3600_000;

export interface AvailabilityServiceOptions {
  store: AvailabilityStore;
  source: FreeBusySource;
  refreshMinutes: number;
  horizonDays: number;
  /** The service account's address members share their calendars with. */
  serviceAccount: string;
  clock: () => string;
  /** Whether this person's calendar may be read at all (a current committee member). */
  isActiveMember: (userId: string) => boolean;
}

interface Entry {
  calendarId: string;
  /** The last good periods (epoch ms), or null when none has been read. */
  busy: { start: number; end: number }[] | null;
  fetchedAt: string | null;
  /** The days the periods cover (Japan dates, both included). */
  from: string;
  to: string;
  problem: 'not_shared' | 'error' | null;
}

export interface PersonBusy {
  state: AvailabilityState;
  fetchedAt: string | null;
  busy: { start: number; end: number }[];
  from: string;
  to: string;
}

export type SlotCheck = { kind: 'ok'; overlapped: boolean; covered: boolean } | { kind: 'not_shared' } | { kind: 'error' };

export class AvailabilityService {
  private readonly cache = new Map<string, Entry>();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private lastFailure: string | null = null;

  constructor(readonly options: AvailabilityServiceOptions) {}

  get serviceAccount(): string {
    return this.options.serviceAccount;
  }

  /** Today and the days read from Google (Japan dates, both included). */
  window(nowIso = this.options.clock()): { from: string; to: string } {
    const from = jstDate(new Date(nowIso));
    return { from, to: addDays(from, this.options.horizonDays - 1) };
  }

  start(): void {
    if (this.timer) return;
    this.first = setTimeout(() => this.timedRead(), 1000);
    this.first.unref?.();
    this.timer = setInterval(() => this.timedRead(), this.options.refreshMinutes * 60_000);
    this.timer.unref?.();
  }

  /** A read the timer starts: whatever goes wrong is one line in the log (its kind only), never an unhandled rejection. */
  private timedRead(): void {
    this.refreshAll().catch((err: unknown) => {
      console.error(`空き具合の読み込みを続けられませんでした: ${err instanceof Error ? err.name : 'error'}`);
    });
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** Reads every connected calendar of a current member; one run at a time (a second call joins the first). */
  refreshAll(): Promise<void> {
    if (!this.running) {
      this.running = this.readAll().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async readAll(): Promise<void> {
    const connections = this.options.store.connections().filter((c) => this.options.isActiveMember(c.userId));
    const keep = new Set(connections.map((c) => c.userId));
    for (const userId of [...this.cache.keys()]) if (!keep.has(userId)) this.cache.delete(userId);
    if (connections.length === 0) return;
    await this.read(connections.map((c) => ({ userId: c.userId, calendarId: c.calendarId })));
  }

  /** Reads one member's calendar now (after connecting or a change of settings). */
  async refreshOne(userId: string): Promise<void> {
    const c = this.options.store.connection(userId);
    if (!c || !this.options.isActiveMember(userId)) {
      this.cache.delete(userId);
      return;
    }
    await this.read([{ userId, calendarId: c.calendarId }]);
  }

  /** Drops what is kept for this member (a disconnect). */
  forget(userId: string): void {
    this.cache.delete(userId);
  }

  private async read(targets: { userId: string; calendarId: string }[]): Promise<void> {
    const nowIso = this.options.clock();
    const { from, to } = this.window(nowIso);
    let answers: Map<string, CalendarFreeBusy> | null = null;
    try {
      answers = await this.options.source.query([...new Set(targets.map((t) => t.calendarId))], jstMidnight(from), jstMidnight(addDays(to, 1)));
      this.lastFailure = null;
    } catch (err) {
      const kind = err instanceof FreeBusyError ? err.failure : 'error';
      // One line when the failure starts or changes; never a name, an address or a response.
      if (this.lastFailure !== kind) console.error(`空き具合（Google カレンダー）を読めませんでした: ${kind}`);
      this.lastFailure = kind;
    }
    for (const t of targets) {
      const before = this.cache.get(t.userId);
      const prev = before && before.calendarId === t.calendarId ? before : null;
      const answer = answers ? (answers.get(t.calendarId) ?? { kind: 'error' as const }) : { kind: 'error' as const };
      if (answer.kind === 'ok') this.cache.set(t.userId, { calendarId: t.calendarId, busy: answer.busy, fetchedAt: nowIso, from, to, problem: null });
      else if (answer.kind === 'not_shared') this.cache.set(t.userId, { calendarId: t.calendarId, busy: null, fetchedAt: null, from, to, problem: 'not_shared' });
      else this.cache.set(t.userId, prev && prev.busy ? { ...prev, problem: 'error' } : { calendarId: t.calendarId, busy: null, fetchedAt: null, from, to, problem: 'error' });
    }
  }

  /** What is known of one member now. */
  busyOf(userId: string): PersonBusy {
    const c = this.options.store.connection(userId);
    const e = this.cache.get(userId);
    const { from, to } = this.window();
    if (!c || !e || e.calendarId !== c.calendarId) return { state: 'pending', fetchedAt: null, busy: [], from, to };
    if (e.problem === 'not_shared') return { state: 'not_shared', fetchedAt: null, busy: [], from, to };
    if (!e.busy || !e.fetchedAt) return { state: e.problem === 'error' ? 'error' : 'pending', fetchedAt: null, busy: [], from, to };
    const age = Date.parse(this.options.clock()) - Date.parse(e.fetchedAt);
    if (age > DROP_AFTER_MS) return { state: 'error', fetchedAt: e.fetchedAt, busy: [], from, to };
    const stale = e.problem === 'error' || age > (this.options.refreshMinutes * 2 + 5) * 60_000;
    return { state: stale ? 'stale' : 'ok', fetchedAt: e.fetchedAt, busy: e.busy, from: e.from, to: e.to };
  }

  /** Whether the slot [start, end) is busy in the calendar: overlapped by a period, or wholly covered by one. */
  async checkSlot(calendarId: string, start: string, end: string): Promise<SlotCheck> {
    let answers: Map<string, CalendarFreeBusy>;
    try {
      answers = await this.options.source.query([calendarId], start, end);
    } catch {
      return { kind: 'error' };
    }
    const a = answers.get(calendarId) ?? { kind: 'error' as const };
    if (a.kind !== 'ok') return a;
    const s = Date.parse(start);
    const e = Date.parse(end);
    return { kind: 'ok', overlapped: a.busy.some((p) => p.start < e && p.end > s), covered: a.busy.some((p) => p.start <= s && p.end >= e) };
  }
}
