import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sendRecording, WAIT_MS, type UploadDeps, type UploadState } from '../../src/client/components/bot/minutesUpload.js';

// Sending a recording in pieces from the browser (2026-11-07): waiting out a dropped connection or a restarting
// server, stopping after WAIT_MS, and going on with the part the server holds — from the same page, or after a reload
// by choosing the same file — but never with another file. A small stand-in for the server's upload routes.

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

class FakeServer {
  uploads = new Map<string, { bytes: number; data: number[] }>();
  opened = 0;
  next = 0;
  /** Answers given instead of the real one, in order: 'down' (no connection) or an HTTP status. */
  faults: ('down' | number)[] = [];
  /** While true, every request finds no connection. */
  offline = false;
  chunk = 4;

  handle = async (url: string, init: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError('Failed to fetch');
    const fault = this.faults.shift();
    if (fault === 'down') throw new TypeError('Failed to fetch');
    if (typeof fault === 'number') return new Response(JSON.stringify({ error: 'x', message: 'down' }), { status: fault });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const u = new URL(url, 'http://app.invalid');
    if (init.method === 'GET' && u.pathname === '/api/minutes/uploads') {
      return json(200, { items: [...this.uploads].map(([uploadId, x]) => ({ uploadId, filename: 'f', bytes: x.bytes, received: x.data.length, openedAt: '', expiresAt: '' })) });
    }
    if (init.method === 'POST' && u.pathname === '/api/minutes/uploads') {
      const { bytes } = JSON.parse(String(init.body)) as { bytes: number };
      const id = `mt_${String(++this.next).padStart(16, '0')}`;
      this.uploads.set(id, { bytes, data: [] });
      this.opened += 1;
      return json(201, { uploadId: id, chunkBytes: this.chunk });
    }
    const resume = /^\/api\/minutes\/uploads\/(mt_\d{16})\/resume$/.exec(u.pathname);
    if (init.method === 'POST' && resume) {
      const x = this.uploads.get(resume[1]!);
      if (!x) return json(404, { error: 'not_found', message: 'この取り込みは見つかりません' });
      const body = JSON.parse(String(init.body)) as { bytes: number; headBytes: number; headSha256: string };
      if (body.headBytes !== x.data.length) return json(409, { error: 'offset', received: x.data.length });
      if (body.bytes !== x.bytes || body.headSha256 !== sha(Uint8Array.from(x.data))) return json(409, { error: 'conflict', message: '違います' });
      return json(200, { uploadId: resume[1], chunkBytes: this.chunk, received: x.data.length });
    }
    const put = /^\/api\/minutes\/uploads\/(mt_\d{16})$/.exec(u.pathname);
    if (init.method === 'PUT' && put) {
      const x = this.uploads.get(put[1]!);
      if (!x) return json(404, { error: 'not_found', message: 'この取り込みは見つかりません' });
      const offset = Number(u.searchParams.get('offset'));
      if (offset !== x.data.length) return json(409, { error: 'offset', received: x.data.length });
      const piece = new Uint8Array(await (init.body as Blob).arrayBuffer());
      x.data.push(...piece);
      return json(200, { received: x.data.length });
    }
    return json(404, { error: 'not_found' });
  };
}

function setup(server: FakeServer) {
  let now = 1_000_000;
  const waited: number[] = [];
  const deps: UploadDeps = {
    fetch: server.handle,
    sleep: async (ms) => {
      waited.push(ms);
      now += ms;
    },
    now: () => now,
    sha256: async (data) => sha(new Uint8Array(data)),
  };
  const states: UploadState[] = [];
  return { deps, waited, states, onState: (s: UploadState) => states.push(s), advance: (ms: number) => (now += ms) };
}

const fileOf = (text: string) => new File([new TextEncoder().encode(text)], 'meeting.m4a', { type: 'audio/mp4' });
const held = (server: FakeServer, id: string) => new TextDecoder().decode(Uint8Array.from(server.uploads.get(id)!.data));

describe('sending a recording in pieces', () => {
  it('waits out a dropped connection and a restarting server, and says so while it waits', async () => {
    const server = new FakeServer();
    const t = setup(server);
    server.faults = ['down', 'down', 502, 503];
    const file = fileOf('0123456789abcdef');
    const id = await sendRecording(file, t.onState, [], t.deps);
    expect(held(server, id)).toBe('0123456789abcdef');
    expect(server.opened).toBe(1);
    // Four tries again, each waiting longer (2, 4, 8, 16 seconds).
    expect(t.waited).toEqual([2000, 4000, 8000, 16_000]);
    expect(t.states.some((s) => s.waitingUntil !== null)).toBe(true);
    expect(t.states.at(-1)).toEqual({ sent: 16, total: 16, waitingUntil: null });
  });

  it('stops after the connection has been away for the whole wait, and goes on from there when sent again', async () => {
    const server = new FakeServer();
    const t = setup(server);
    const file = fileOf('0123456789abcdef');
    // Two pieces get through, then the connection is gone.
    let pieces = 0;
    const handle = server.handle;
    t.deps.fetch = async (url, init) => {
      if (init.method === 'PUT' && ++pieces > 2) server.offline = true;
      return handle(url, init);
    };
    const failed = await sendRecording(file, t.onState, [], t.deps).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('続きから送ります');
    expect((failed as Error).message).toContain('10 分');
    expect(t.waited.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(WAIT_MS - 30_000);
    expect(Math.max(...t.waited)).toBe(30_000);
    const [id] = [...server.uploads.keys()];
    expect(held(server, id!)).toBe('01234567');

    // Back online: the same file (still in the page) goes on with the same upload.
    server.offline = false;
    t.deps.fetch = handle;
    const again = await sendRecording(file, t.onState, [], t.deps);
    expect(again).toBe(id);
    expect(server.opened).toBe(1);
    expect(held(server, id!)).toBe('0123456789abcdef');
  });

  it('after a reload, goes on only with the same file, and opens a new upload for another file of the same size', async () => {
    const server = new FakeServer();
    const t = setup(server);
    const id = 'mt_0000000000000099';
    server.uploads.set(id, { bytes: 16, data: [...new TextEncoder().encode('012345')] });

    // Another recording of the same size: refused by the server's check, so it is sent as a new upload.
    const other = await sendRecording(fileOf('zzzzzzzzzzzzzzzz'), t.onState, [id], t.deps);
    expect(other).not.toBe(id);
    expect(held(server, id)).toBe('012345');

    // The same recording, chosen again after the reload (a new File object): goes on from byte 6.
    const same = await sendRecording(fileOf('0123456789abcdef'), t.onState, [id], t.deps);
    expect(same).toBe(id);
    expect(held(server, id)).toBe('0123456789abcdef');
    expect(server.opened).toBe(1);
  });

  it('measures the head again when the server holds more than the list said', async () => {
    const server = new FakeServer();
    const t = setup(server);
    const id = 'mt_0000000000000042';
    server.uploads.set(id, { bytes: 16, data: [...new TextEncoder().encode('0123')] });
    const handle = server.handle;
    let listed = false;
    t.deps.fetch = async (url, init) => {
      const res = await handle(url, init);
      // Another tab sends a piece right after the list was read.
      if (init.method === 'GET' && !listed) {
        listed = true;
        server.uploads.get(id)!.data.push(...new TextEncoder().encode('4567'));
      }
      return res;
    };
    expect(await sendRecording(fileOf('0123456789abcdef'), t.onState, [id], t.deps)).toBe(id);
    expect(held(server, id)).toBe('0123456789abcdef');
  });

  it('stops at once on an answer that is not about the connection', async () => {
    const server = new FakeServer();
    const t = setup(server);
    server.faults = [422];
    const failed = await sendRecording(fileOf('0123'), t.onState, [], t.deps).catch((e: Error) => e);
    expect((failed as Error).message).toBe('down');
    expect(t.waited).toEqual([]);
  });
});
