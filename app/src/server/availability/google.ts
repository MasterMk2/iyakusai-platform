import { acceptedToken, GOOGLE_TOKEN_URL, signServiceAccountAssertion, type ServiceAccountKey } from '../google/service-account.js';

// Google Calendar's free/busy query (freebusy.query, Calendar API v3) as the committee's service account, with the
// narrowest scope that allows it (calendar.freebusy). The answer holds busy periods only; a calendar that is not
// shared with the account comes back with an error of its own. Neither the token, the key nor a response body is
// logged or put in an error: a failure carries its kind only.

export const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
const TIMEOUT_MS = 20_000;
const MAX_BODY = 4_000_000;
/** Google's limit of calendars in one query. */
export const FREEBUSY_BATCH = 50;
/** The most busy periods kept for one calendar in one answer (more is cut, not trusted to be complete). */
const MAX_PERIODS = 2000;

export type FreeBusyFailure = 'credential' | 'token' | 'forbidden' | 'rate_limited' | 'server' | 'network' | 'timeout' | 'invalid';

export class FreeBusyError extends Error {
  constructor(readonly failure: FreeBusyFailure) {
    super(`freebusy failed: ${failure}`);
  }
}

/** One calendar's answer: its busy periods (epoch ms, end excluded), or why Google gave none. */
export type CalendarFreeBusy = { kind: 'ok'; busy: { start: number; end: number }[] } | { kind: 'not_shared' } | { kind: 'error' };

export interface FreeBusySource {
  /** Busy periods of these calendars between the two instants (ISO). Throws FreeBusyError when the query failed as a whole. */
  query(calendarIds: readonly string[], timeMin: string, timeMax: string): Promise<Map<string, CalendarFreeBusy>>;
}

const failureOf = (status: number): FreeBusyFailure => (status === 401 ? 'token' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : status >= 500 ? 'server' : 'invalid');

/** Reasons Google gives for a calendar it will not answer for that mean "not shared with this account" (or gone). */
const NOT_SHARED = new Set(['notFound', 'forbidden', 'notACalendarUser', 'accessDenied']);

/** One calendar's part of Google's answer, checked. */
export function calendarAnswer(raw: unknown): CalendarFreeBusy {
  const o = raw as { errors?: unknown; busy?: unknown } | null;
  if (!o || typeof o !== 'object') return { kind: 'error' };
  if (Array.isArray(o.errors) && o.errors.length > 0) {
    const reasons = o.errors.map((e) => (e && typeof e === 'object' ? (e as { reason?: unknown }).reason : undefined));
    return reasons.some((r) => typeof r === 'string' && NOT_SHARED.has(r)) ? { kind: 'not_shared' } : { kind: 'error' };
  }
  if (!Array.isArray(o.busy) || o.busy.length > MAX_PERIODS) return { kind: 'error' };
  const busy: { start: number; end: number }[] = [];
  for (const p of o.busy) {
    const start = p && typeof p === 'object' ? Date.parse(String((p as { start?: unknown }).start)) : NaN;
    const end = p && typeof p === 'object' ? Date.parse(String((p as { end?: unknown }).end)) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { kind: 'error' };
    if (end > start) busy.push({ start, end });
  }
  return { kind: 'ok', busy };
}

export class GoogleFreeBusy implements FreeBusySource {
  private token: { value: string; until: number } | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new FreeBusyError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new FreeBusyError(url === GOOGLE_TOKEN_URL && res.status === 400 ? 'token' : failureOf(res.status));
    if (text.length > MAX_BODY) throw new FreeBusyError('invalid');
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new FreeBusyError('invalid');
    }
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.until > now) return this.token.value;
    let assertion: string;
    try {
      assertion = signServiceAccountAssertion(this.key, SCOPE, Math.floor(now / 1000));
    } catch {
      throw new FreeBusyError('credential');
    }
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const out = await this.call(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const token = acceptedToken(out, now);
    if (!token) throw new FreeBusyError('invalid');
    this.token = token;
    return token.value;
  }

  async query(calendarIds: readonly string[], timeMin: string, timeMax: string): Promise<Map<string, CalendarFreeBusy>> {
    const out = new Map<string, CalendarFreeBusy>();
    for (let i = 0; i < calendarIds.length; i += FREEBUSY_BATCH) {
      const ids = calendarIds.slice(i, i + FREEBUSY_BATCH);
      const token = await this.accessToken();
      let answer: unknown;
      try {
        answer = await this.call(FREEBUSY_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ timeMin, timeMax, timeZone: 'UTC', items: ids.map((id) => ({ id })) }),
        });
      } catch (err) {
        // A token Google no longer takes is minted again on the next query.
        if (err instanceof FreeBusyError && err.failure === 'token') this.token = null;
        throw err;
      }
      const calendars = (answer as { calendars?: unknown } | null)?.calendars;
      if (!calendars || typeof calendars !== 'object' || Array.isArray(calendars)) throw new FreeBusyError('invalid');
      // Google keys the answer by the ID as asked; one missing from the answer is not known (an error, never free).
      const byId = new Map(Object.entries(calendars as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]));
      for (const id of ids) out.set(id, byId.has(id) ? calendarAnswer(byId.get(id)) : { kind: 'error' });
    }
    return out;
  }
}
