import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineReadStore } from '../../src/server/line/reads.js';
import { ADMIN, EDITOR_C, NOACCESS_D, VIEWER_B } from '../helpers.js';
import { CONV, makeLineApp, prepare, uuid, type LineTestApp } from '../line-helpers.js';

// Where each person last read each official LINE conversation, kept on the server so every device opens at the same
// place (2026-11-13). Only forward, never past the conversation's newest row, and only the person's own.

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'line-reads-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let t: LineTestApp;
let reads: LineReadStore;
let n = 0;
beforeEach(async () => {
  n += 1;
  reads = new LineReadStore(join(dir, `case-${n}`));
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
  });
});

describe('a server that does not keep places', () => {
  it('leaves lastReadAt out (the screen keeps it per device) and answers 404 to the write', async () => {
    const plain = await makeLineApp();
    try {
      const d = (await plain.call(EDITOR_C, 'GET', `/api/line/conversations/${CONV.l1}`)).json;
      expect('lastReadAt' in d).toBe(false);
      expect((await plain.call(EDITOR_C, 'PUT', `/api/line/conversations/${CONV.l1}/read`, { at: newestOf(d) })).status).toBe(404);
    } finally {
      await plain.app.close();
    }
  });
});

describe('the file', () => {
  it('keeps places across a restart and refuses a newer schema without touching it', () => {
    const root = join(dir, 'restart');
    const first = new LineReadStore(root);
    expect(first.advance('u-1', 'lc_0000000000000001', '2026-09-02T01:00:00.000Z', '2026-11-13T00:00:00.000Z')).toBe('2026-09-02T01:00:00.000Z');
    first.close();
    const again = new LineReadStore(root);
    expect(again.get('u-1', 'lc_0000000000000001')).toBe('2026-09-02T01:00:00.000Z');
    again.db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run();
    again.close();
    expect(() => new LineReadStore(root)).toThrow();
  });
});
