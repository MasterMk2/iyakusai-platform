import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MockInboundImages, ReceiverImages, syntheticPng } from '../../src/server/line/inbound-media.js';
import { ORIGINAL_MAX_BYTES, sniffImage } from '../../src/server/line/media.js';

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'line-inbound-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const RECEIVER = { url: 'http://receiver.test:8788', pullToken: 'pull-token-synthetic' };
const PNG = syntheticPng(8, 6);
const body = (b: Buffer) => new Uint8Array(b);

function fakeFetch(answer: (url: string) => Response) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    return answer(url);
  };
  return { fetch, calls };
}

describe('received images from the receiver', () => {
  it('reads /media with the pull token once, then serves the kept copy', async () => {
    const f = fakeFetch(() => new Response(body(PNG), { status: 200, headers: { 'content-type': 'image/png' } }));
    const images = new ReceiverImages(RECEIVER, join(dir, 'a'), f.fetch);
    const first = await images.get('900000000012');
    expect(first?.type).toBe('image/png');
    expect(first?.data.equals(PNG)).toBe(true);
    expect(f.calls).toEqual([{ url: 'http://receiver.test:8788/media/900000000012', auth: 'Bearer pull-token-synthetic' }]);
    expect((await images.get('900000000012'))?.data.equals(PNG)).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it('a miss is asked again only after a while; a non-image, an oversized body or a bad ID is never kept', async () => {
    let now = 0;
    let status = 404;
    const f = fakeFetch(() => new Response(status === 200 ? body(PNG) : 'not found', { status }));
    const images = new ReceiverImages(RECEIVER, join(dir, 'b'), f.fetch, () => now);
    expect(await images.get('1')).toBeNull();
    expect(await images.get('1')).toBeNull();
    expect(f.calls).toHaveLength(1);
    now += 5 * 60 * 1000;
    status = 200;
    expect((await images.get('1'))?.type).toBe('image/png');

    const html = new ReceiverImages(RECEIVER, join(dir, 'c'), fakeFetch(() => new Response('<html>', { status: 200 })).fetch);
    expect(await html.get('2')).toBeNull();
    const big = new ReceiverImages(RECEIVER, join(dir, 'd'), fakeFetch(() => new Response(body(PNG), { status: 200, headers: { 'content-length': String(ORIGINAL_MAX_BYTES + 1) } })).fetch);
    expect(await big.get('3')).toBeNull();
    const bad = fakeFetch(() => new Response(body(PNG)));
    const strict = new ReceiverImages(RECEIVER, join(dir, 'e'), bad.fetch);
    for (const id of ['../x', 'abc', '']) expect(await strict.get(id)).toBeNull();
    expect(bad.calls).toHaveLength(0);
  });

  it('a connection failure is a miss, not an error', async () => {
    const images = new ReceiverImages(RECEIVER, join(dir, 'f'), async () => {
      throw new TypeError('fetch failed');
    });
    expect(await images.get('4')).toBeNull();
  });

  it('the demo picture is a real PNG', async () => {
    expect(sniffImage(syntheticPng())).toEqual({ type: 'image/png', width: 160, height: 120 });
    expect((await new MockInboundImages().get('900000000012'))?.type).toBe('image/png');
  });
});
