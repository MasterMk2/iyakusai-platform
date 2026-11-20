import { useCallback, useState } from 'react';
import type { AvailabilityListResponse } from '../../../shared/availability';
import { api } from '../../api';
import { useLoader } from '../../useLoader';

// The members' busy periods the signed-in person may see (GET /api/availability). Several assignee fields on one
// screen (the task drafting rows) ask for the same days: one answer is shared for a minute. The server reads them
// from memory, so a request is cheap, but there is no reason to send the same one ten times.

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; answer: Promise<AvailabilityListResponse> }>();

function cached(from: string, to: string): Promise<AvailabilityListResponse> {
  const key = `${from}|${to}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.answer;
  const answer = api<AvailabilityListResponse>('GET', `/api/availability?from=${from}&to=${to}`);
  // A failed answer is not kept: the next field asks again.
  answer.catch(() => cache.delete(key));
  cache.set(key, { at: now, answer });
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return answer;
}

/** Drops the shared answers (after the person changed their own sharing). */
export function forgetAvailability(): void {
  cache.clear();
}

export function useAvailability(from: string, to: string, enabled = true) {
  const load = useCallback(
    (signal: AbortSignal) =>
      enabled
        ? cached(from, to).then((a) => {
            if (signal.aborted) throw new DOMException('aborted', 'AbortError');
            return a;
          })
        : Promise.resolve(null),
    [from, to, enabled],
  );
  return useLoader(load);
}

/** A choice kept in this browser (shown or hidden); the screen works the same when the storage is not there. */
export function useRemembered(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next ? '1' : '0');
    } catch {
      // not kept: the choice lasts until the screen is closed
    }
  };
  return [value, set];
}
