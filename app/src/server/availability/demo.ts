import { createHash } from 'node:crypto';
import { addDays, jstDate } from '../../shared/calendar.js';
import { jstMidnight } from '../../shared/availability.js';
import type { CalendarFreeBusy, FreeBusySource } from './google.js';
import type { AvailabilityStore } from './store.js';

// The demo's stand-in for Google (2026-11-20): synthetic busy periods made from each calendar's ID, so the screens can
// be tried without a Google account. The connecting check works too: the check time is found in the synthetic
// periods (a long window), and a short window (the check itself) is always busy, as if the member had put the event.
// Only `.invalid` IDs answer (the documentation domain), others are "not shared".

const HOUR = 3600_000;

/** Synthetic busy periods of one calendar over the days from `from` to `to` (Japan dates). */
function synthetic(calendarId: string, from: string, to: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i += 1) {
    const h = createHash('sha256').update(`${calendarId}|${d}`).digest();
    const midnight = Date.parse(jstMidnight(d));
    // Roughly: classes on weekday daytimes, something in the evening some days, a whole day now and then.
    if (h[0]! % 9 === 0) {
      out.push({ start: midnight, end: midnight + 24 * HOUR });
      continue;
    }
    const weekday = new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay();
    if (weekday >= 1 && weekday <= 5 && h[1]! % 3 !== 0) out.push({ start: midnight + (9 + (h[2]! % 3)) * HOUR, end: midnight + (12 + (h[3]! % 5)) * HOUR });
    if (h[4]! % 4 === 0) out.push({ start: midnight + (18 + (h[5]! % 2)) * HOUR, end: midnight + (20 + (h[6]! % 3)) * HOUR + 30 * 60_000 });
  }
  return out;
}

export class DemoFreeBusy implements FreeBusySource {
  async query(calendarIds: readonly string[], timeMin: string, timeMax: string): Promise<Map<string, CalendarFreeBusy>> {
    const lo = Date.parse(timeMin);
    const hi = Date.parse(timeMax);
    const out = new Map<string, CalendarFreeBusy>();
    for (const id of calendarIds) {
      if (!id.endsWith('.invalid')) {
        out.set(id, { kind: 'not_shared' });
        continue;
      }
      if (hi - lo <= HOUR) {
        out.set(id, { kind: 'ok', busy: [{ start: lo, end: hi }] });
        continue;
      }
      const from = jstDate(new Date(lo));
      const to = jstDate(new Date(hi - 1));
      out.set(id, { kind: 'ok', busy: synthetic(id, from, to).filter((p) => p.end > lo && p.start < hi) });
    }
    return out;
  }
}

/**
 * Connects the first three demo people (once): everyone sees the first one's time ranges, the 役員会 sees the second
 * one's parts of the day, and only the first person sees the third one's.
 */
export function seedAvailabilityDemo(store: AvailabilityStore, people: { id: string; roleLabel: string }[], now: string): void {
  if (store.connections().length > 0) return;
  const chosen = people.slice(0, 3);
  chosen.forEach((p, i) => {
    const calendarId = `demo-${i + 1}@example.invalid`;
    store.putChallenge({
      userId: p.id,
      calendarId,
      slotStart: now,
      slotEnd: now,
      audience: i === 0 ? { everyone: true, departments: [], people: [] } : { everyone: false, departments: i === 1 ? ['役員会'] : [], people: i === 2 ? chosen.slice(0, 1).map((c) => c.id) : [] },
      detail: i === 0 ? 'blocks' : 'parts',
      createdAt: now,
    });
    store.connect(store.challenge(p.id)!, now);
  });
}
