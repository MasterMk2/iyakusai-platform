import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineReadStore } from '../../src/server/line/reads.js';
import { LINE_SUPPORT } from '../../src/server/line/fixtures.js';
import { ADMIN, EDITOR_C, NOACCESS_D, T0, VIEWER_B } from '../helpers.js';
import { CONV, makeLineApp, prepare, uuid, type LineTestApp } from '../line-helpers.js';

// Where each person last read each official LINE conversation, kept on the server so every device opens at the same
// place (2026-11-13). Only forward, never past the conversation's newest row, and only the person's own. The list
// counts the messages from the other side after the place; without a place, after the time counting began ("since").

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'line-reads-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let t: LineTestApp;
let reads: LineReadStore;
let n = 0;
/** Before the synthetic messages (September 2026), so a conversation nobody opened has unread messages. */
const SINCE = '2026-01-01T00:00:00.000Z';
beforeEach(async () => {
  n += 1;
  reads = new LineReadStore(join(dir, `case-${n}`), SINCE);
  t = await makeLineApp({ reads });
});
afterEach(async () => {
  await t.app.close();
  reads.close();
});

const detail = async (user: string, conv = CONV.l1) => (await t.call(user, 'GET', `/api/line/conversations/${conv}`)).json;
const markRead = (user: string, at: string, conv = CONV.l1) => t.call(user, 'PUT', `/api/line/conversations/${conv}/read`, { at });
const newestOf = (d: { messages: { sentAt: string }[] }) => d.messages.map((m) => m.sentAt).sort().at(-1)!;

describe('the place each person read up to', () => {
  it('starts empty, keeps the newest row shown, and is the person’s own', async () => {
    const before = await detail(EDITOR_C);
    expect(before.lastReadAt).toBeNull();
    expect(before.readSince).toBe(SINCE);
    const newest = newestOf(before);
    const res = await markRead(EDITOR_C, newest);
    expect(res.status, res.raw).toBe(200);
    expect(res.json).toEqual({ lastReadAt: newest });
    expect((await detail(EDITOR_C)).lastReadAt).toBe(newest);
    // Opening (GET) never moves it; someone else has their own.
    expect((await detail(EDITOR_C)).lastReadAt).toBe(newest);
    expect((await detail(VIEWER_B)).lastReadAt).toBeNull();
  });

  it('only moves forward', async () => {
    const d = await detail(EDITOR_C);
    const times = d.messages.map((m: { sentAt: string }) => m.sentAt).sort();
    const newest = times.at(-1)!;
    expect((await markRead(EDITOR_C, newest)).json.lastReadAt).toBe(newest);
    expect((await markRead(EDITOR_C, times[0]!)).json.lastReadAt).toBe(newest);
    expect((await detail(EDITOR_C)).lastReadAt).toBe(newest);
  });

  it('never goes past the conversation’s newest row (a wrong clock cannot hide later messages)', async () => {
    const newest = newestOf(await detail(EDITOR_C));
    expect((await markRead(EDITOR_C, '2099-01-01T00:00:00.000Z')).json.lastReadAt).toBe(newest);
  });

  it('counts a reply sent from the app as a row', async () => {
    const p = await prepare(t, EDITOR_C, CONV.l1, '合成の返信です。');
    expect((await p.send(uuid(1))).status).toBe(200);
    const d = await detail(EDITOR_C);
    const sentAt = d.outbox[0].createdAt;
    expect(sentAt > newestOf(d)).toBe(true);
    expect((await markRead(EDITOR_C, sentAt)).json.lastReadAt).toBe(new Date(sentAt).toISOString());
  });

  it('takes a time written the way an older history file writes it', async () => {
    const newest = newestOf(await detail(EDITOR_C));
    const d = new Date(Date.parse(newest) - 60_000);
    const loose = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 UTC`;
    expect((await markRead(EDITOR_C, loose)).json.lastReadAt).toBe(d.toISOString().replace(/\.\d{3}Z$/, '.000Z'));
  });

  it('keeps times in UTC whatever offset the screen sends', async () => {
    const newest = newestOf(await detail(EDITOR_C));
    const jst = new Date(Date.parse(newest) + 9 * 3600_000).toISOString().replace('Z', '+09:00');
    expect((await markRead(EDITOR_C, jst)).json.lastReadAt).toBe(newest);
  });

  it('refuses people who cannot read the conversation, and malformed times', async () => {
    const newest = newestOf(await detail(EDITOR_C));
    expect((await markRead(NOACCESS_D, newest)).status).toBe(404);
    expect((await markRead(VIEWER_B, newest, CONV.shopL1)).status).toBe(404);
    expect((await markRead(EDITOR_C, 'yesterday')).status).toBe(400);
    expect((await t.call(EDITOR_C, 'PUT', `/api/line/conversations/${CONV.l1}/read`, { at: newest, userId: VIEWER_B })).status).toBe(400);
    expect(reads.get(NOACCESS_D, CONV.l1)).toBeNull();
  });

  it('is forgotten by the demo’s sample reset', async () => {
    await markRead(EDITOR_C, newestOf(await detail(EDITOR_C)));
    expect((await t.call(ADMIN, 'POST', '/api/demo/reset')).status).toBe(200);
    expect((await detail(EDITOR_C)).lastReadAt).toBeNull();
    // Counting starts again from the reset.
    expect((await detail(EDITOR_C)).readSince).toBe(T0);
  });
});

describe('a server that does not keep places', () => {
  it('leaves lastReadAt out (the screen keeps it per device) and answers 404 to the write', async () => {
    const plain = await makeLineApp();
    try {
      const d = (await plain.call(EDITOR_C, 'GET', `/api/line/conversations/${CONV.l1}`)).json;
      expect('lastReadAt' in d).toBe(false);
      expect('readSince' in d).toBe(false);
      const list = (await plain.call(EDITOR_C, 'GET', `/api/inbox?lineAccountId=${LINE_SUPPORT}`)).json;
      expect(list.items.some((i: object) => 'unreadCount' in i)).toBe(false);
      const accounts = (await plain.call(EDITOR_C, 'GET', '/api/line/accounts')).json;
      expect(accounts.some((a: object) => 'unreadCount' in a)).toBe(false);
      expect((await plain.call(EDITOR_C, 'PUT', `/api/line/conversations/${CONV.l1}/read`, { at: newestOf(d) })).status).toBe(404);
    } finally {
      await plain.app.close();
    }
  });
});

describe('the file', () => {
  it('keeps places and the start of counting across a restart, and refuses a newer schema without touching it', () => {
    const root = join(dir, 'restart');
    const first = new LineReadStore(root, '2026-11-13T05:00:00+09:00');
    expect(first.since).toBe('2026-11-12T20:00:00.000Z');
    expect(first.advance('u-1', 'lc_0000000000000001', '2026-09-02T01:00:00.000Z', '2026-11-13T00:00:00.000Z')).toBe('2026-09-02T01:00:00.000Z');
    first.close();
    const again = new LineReadStore(root, '2026-12-01T00:00:00.000Z');
    expect(again.get('u-1', 'lc_0000000000000001')).toBe('2026-09-02T01:00:00.000Z');
    expect(again.since).toBe('2026-11-12T20:00:00.000Z');
    expect(again.placesOf('u-1')).toEqual(new Map([['lc_0000000000000001', '2026-09-02T01:00:00.000Z']]));
    expect(again.placeOf('u-1', 'lc_0000000000000002')).toBe('2026-11-12T20:00:00.000Z');
    again.db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run();
    again.close();
    expect(() => new LineReadStore(root, '2026-12-01T00:00:00.000Z')).toThrow();
  });

  it('gives a file from before counting began (version 1 without "since") the time of its first start, same version', () => {
    const root = join(dir, 'older');
    const older = new LineReadStore(root, '2026-11-13T04:23:00.000Z');
    older.db.prepare("DELETE FROM meta WHERE key='since'").run();
    older.close();
    const opened = new LineReadStore(root, '2026-11-13T05:10:00.000Z');
    expect(opened.since).toBe('2026-11-13T05:10:00.000Z');
    expect(opened.db.prepare("SELECT value FROM meta WHERE key='schema'").get()).toEqual({ value: '1' });
    opened.close();
  });
});

describe('unread counts in the LINE list', () => {
  const unread = async (user: string) => {
    const res = await t.call(user, 'GET', `/api/inbox?lineAccountId=${LINE_SUPPORT}`);
    expect(res.status, res.raw).toBe(200);
    return Object.fromEntries(res.json.items.map((i: { conversationId: string; unreadCount: number }) => [i.conversationId, i.unreadCount]));
  };

  it('counts the other side’s messages after the place, from "since" where there is none', async () => {
    const before = await unread(EDITOR_C);
    // L1 has three received messages (a text, a picture, a text), all after SINCE.
    expect(before[CONV.l1]).toBe(3);
    expect(Object.values(before).every((v) => typeof v === 'number')).toBe(true);
    await markRead(EDITOR_C, newestOf(await detail(EDITOR_C)));
    expect((await unread(EDITOR_C))[CONV.l1]).toBe(0);
    // Someone else's count is their own.
    expect((await unread(VIEWER_B))[CONV.l1]).toBe(3);

    // A new message arrives; the one the person withdrew does not count (it was before the place anyway).
    expect((await t.call(ADMIN, 'POST', '/api/demo/line/release')).status).toBe(200);
    expect((await unread(EDITOR_C))[CONV.l1]).toBe(1);
    expect((await unread(VIEWER_B))[CONV.l1]).toBe(3);
  });

  it('does not count the committee’s own sends', async () => {
    await markRead(EDITOR_C, newestOf(await detail(EDITOR_C)));
    const p = await prepare(t, EDITOR_C, CONV.l1, '合成の返信です。');
    expect((await p.send(uuid(3))).status).toBe(200);
    expect((await unread(EDITOR_C))[CONV.l1]).toBe(0);
    expect((await unread(VIEWER_B))[CONV.l1]).toBe(3);
  });

  it('starts at zero for messages from before counting began', async () => {
    await t.app.close();
    reads.close();
    reads = new LineReadStore(join(dir, `late-${n}`), '2026-12-01T00:00:00.000Z');
    t = await makeLineApp({ reads });
    expect(Object.values(await unread(EDITOR_C)).every((v) => v === 0)).toBe(true);
  });
});

describe('unread totals of the accounts (the sidebar)', () => {
  const totals = async (user: string) =>
    Object.fromEntries(((await t.call(user, 'GET', '/api/line/accounts')).json as { id: string; unreadCount: number }[]).map((a) => [a.id, a.unreadCount]));
  const listSum = async (user: string, accountId: string) =>
    ((await t.call(user, 'GET', `/api/inbox?lineAccountId=${accountId}&pageSize=100`)).json.items as { unreadCount: number }[]).reduce((n, i) => n + i.unreadCount, 0);

  it('are the sum of the rows, for each account the person can read', async () => {
    const before = await totals(EDITOR_C);
    expect(Object.keys(before).length).toBeGreaterThan(1);
    for (const id of Object.keys(before)) expect(before[id], id).toBe(await listSum(EDITOR_C, id));
    expect(before[LINE_SUPPORT]).toBeGreaterThanOrEqual(3);

    await markRead(EDITOR_C, newestOf(await detail(EDITOR_C)));
    expect((await totals(EDITOR_C))[LINE_SUPPORT]).toBe(before[LINE_SUPPORT]! - 3);
    // Someone else's totals are their own; an account they cannot read is not listed.
    expect((await totals(VIEWER_B))[LINE_SUPPORT]).toBe(await listSum(VIEWER_B, LINE_SUPPORT));
    expect(await totals(NOACCESS_D)).toEqual({});

    expect((await t.call(ADMIN, 'POST', '/api/demo/line/release')).status).toBe(200);
    const after = await totals(EDITOR_C);
    for (const id of Object.keys(after)) expect(after[id], id).toBe(await listSum(EDITOR_C, id));
  });
});
