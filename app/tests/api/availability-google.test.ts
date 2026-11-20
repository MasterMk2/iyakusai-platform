import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { calendarAnswer, FREEBUSY_URL, FreeBusyError, GoogleFreeBusy } from '../../src/server/availability/google.js';
import { GOOGLE_TOKEN_URL } from '../../src/server/google/service-account.js';

// The free/busy client against a stand-in for Google (no network): the token, the scope, the request, the batches of
// 50, a calendar that is not shared, and the failures. Synthetic addresses only.

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { clientEmail: 'iyakusai-test@test-project.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const MIN = '2026-11-19T15:00:00.000Z';
const MAX = '2026-12-31T15:00:00.000Z';

type Call = { url: string; body: string; auth: string | null };

function google(answer: (ids: string[]) => { status?: number; body: unknown }, token: { status?: number; body?: unknown } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = String(init?.body ?? '');
    calls.push({ url: u, body, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
    if (u === GOOGLE_TOKEN_URL) return new Response(JSON.stringify(token.body ?? { access_token: 'ya29.synthetic-token-0123456789', expires_in: 3600 }), { status: token.status ?? 200 });
    if (u === FREEBUSY_URL) {
      const ids = (JSON.parse(body) as { items: { id: string }[] }).items.map((i) => i.id);
      const a = answer(ids);
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const busyFor = (ids: string[]) => ({ body: { kind: 'calendar#freeBusy', calendars: Object.fromEntries(ids.map((id) => [id, { busy: [{ start: '2026-11-21T05:00:00Z', end: '2026-11-21T07:00:00Z' }] }])) } });

describe('GoogleFreeBusy', () => {
  it('signs for the free/busy scope only and asks for the calendars in UTC', async () => {
    const g = google(busyFor);
    const client = new GoogleFreeBusy(KEY, g.fetchImpl, () => Date.parse('2026-11-20T00:00:00Z'));
    const out = await client.query(['a@example.invalid'], MIN, MAX);
    expect(out.get('a@example.invalid')).toEqual({ kind: 'ok', busy: [{ start: Date.parse('2026-11-21T05:00:00Z'), end: Date.parse('2026-11-21T07:00:00Z') }] });
    const assertion = new URLSearchParams(g.calls[0]!.body).get('assertion')!;
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString()) as { scope: string; iss: string };
    expect(claims).toMatchObject({ scope: 'https://www.googleapis.com/auth/calendar.freebusy', iss: KEY.clientEmail });
    expect(JSON.parse(g.calls[1]!.body)).toEqual({ timeMin: MIN, timeMax: MAX, timeZone: 'UTC', items: [{ id: 'a@example.invalid' }] });
    expect(g.calls[1]!.auth).toBe('Bearer ya29.synthetic-token-0123456789');
  });

  it('keeps the token for later queries and asks in batches of 50', async () => {
    const g = google(busyFor);
    const client = new GoogleFreeBusy(KEY, g.fetchImpl, () => Date.parse('2026-11-20T00:00:00Z'));
    const ids = Array.from({ length: 120 }, (_, i) => `p${i}@example.invalid`);
    const out = await client.query(ids, MIN, MAX);
    expect(out.size).toBe(120);
    const freebusy = g.calls.filter((c) => c.url === FREEBUSY_URL);
    expect(freebusy.map((c) => (JSON.parse(c.body) as { items: unknown[] }).items.length)).toEqual([50, 50, 20]);
    expect(g.calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  it('tells a calendar that is not shared from one that failed, and never makes either free', async () => {
    const g = google((ids) => ({
      body: {
        calendars: {
          [ids[0]!]: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
          [ids[1]!]: { errors: [{ domain: 'global', reason: 'internalError' }], busy: [] },
          // ids[2] is missing from the answer
        },
      },
    }));
    const client = new GoogleFreeBusy(KEY, g.fetchImpl);
    const out = await client.query(['a@example.invalid', 'b@example.invalid', 'c@example.invalid'], MIN, MAX);
    expect(out.get('a@example.invalid')).toEqual({ kind: 'not_shared' });
    expect(out.get('b@example.invalid')).toEqual({ kind: 'error' });
    expect(out.get('c@example.invalid')).toEqual({ kind: 'error' });
  });

  it('fails as a whole with a kind only (never the body)', async () => {
    const forbidden = google(() => ({ status: 403, body: { error: { message: 'Calendar API has not been used in project synthetic' } } }));
    await expect(new GoogleFreeBusy(KEY, forbidden.fetchImpl).query(['a@example.invalid'], MIN, MAX)).rejects.toMatchObject({ failure: 'forbidden', message: 'freebusy failed: forbidden' });
    const badKey = google(busyFor, { status: 400, body: { error: 'invalid_grant' } });
    await expect(new GoogleFreeBusy(KEY, badKey.fetchImpl).query(['a@example.invalid'], MIN, MAX)).rejects.toMatchObject({ failure: 'token' });
    const garbage = google(() => ({ body: { nothing: true } }));
    await expect(new GoogleFreeBusy(KEY, garbage.fetchImpl).query(['a@example.invalid'], MIN, MAX)).rejects.toBeInstanceOf(FreeBusyError);
    const unsigned = new GoogleFreeBusy({ clientEmail: KEY.clientEmail, privateKey: 'not a key' }, google(busyFor).fetchImpl);
    await expect(unsigned.query(['a@example.invalid'], MIN, MAX)).rejects.toMatchObject({ failure: 'credential' });
  });

  it('mints a new token after Google refused the old one', async () => {
    let refuse = true;
    const g = google(() => (refuse ? { status: 401, body: {} } : busyFor(['a@example.invalid'])));
    const client = new GoogleFreeBusy(KEY, g.fetchImpl);
    await expect(client.query(['a@example.invalid'], MIN, MAX)).rejects.toMatchObject({ failure: 'token' });
    refuse = false;
    await client.query(['a@example.invalid'], MIN, MAX);
    expect(g.calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toHaveLength(2);
  });
});

describe('calendarAnswer', () => {
  it('refuses periods it cannot read rather than guessing', () => {
    expect(calendarAnswer({ busy: [{ start: 'yesterday', end: '2026-11-21T07:00:00Z' }] })).toEqual({ kind: 'error' });
    expect(calendarAnswer({ busy: [{ start: '2026-11-21T07:00:00Z', end: '2026-11-21T05:00:00Z' }] })).toEqual({ kind: 'error' });
    expect(calendarAnswer({ busy: 'none' })).toEqual({ kind: 'error' });
    expect(calendarAnswer({ busy: [] })).toEqual({ kind: 'ok', busy: [] });
  });
});
