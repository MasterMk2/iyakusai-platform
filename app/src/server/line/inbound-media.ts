import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ORIGINAL_MAX_BYTES, sniffImage, type ImageType } from './media.js';
import type { Fetch } from './messaging-api.js';
import type { LineMessage } from './types.js';

// Received images (2026-11-04). The receiver already downloads an image's content from LINE when the webhook
// arrives (LINE keeps it only for a limited time) and serves it at /media/<messageId> behind the same pull token
// as /export. The app reads it from there on first view and keeps its own copy in a private folder; it is shown
// only through a signed-in route that checks the conversation's read access, never the public /line-media.

export interface InboundImage {
  type: ImageType;
  data: Buffer;
}

export interface InboundImageSource {
  get(externalMessageId: string): Promise<InboundImage | null>;
}

const MESSAGE_ID = /^\d{1,20}$/;
/** A miss (not yet downloaded, or none) is asked again only after this long. */
const MISS_TTL_MS = 5 * 60 * 1000;

/** A received image the app can show: an event-feed image that was not unsent. */
export const isInboundImage = (m: LineMessage) =>
  m.direction === 'inbound' && m.provenance.source === 'event_feed' && m.content.kind === 'unsupported' && m.content.mediaType === 'image' && MESSAGE_ID.test(m.externalMessageId);

function checked(data: Buffer): InboundImage | null {
  if (data.length > ORIGINAL_MAX_BYTES) return null;
  const sniffed = sniffImage(data);
  return sniffed ? { type: sniffed.type, data } : null;
}

export class ReceiverImages implements InboundImageSource {
  private readonly misses = new Map<string, number>();
  private readonly fetchImpl: Fetch;

  constructor(
    private readonly receiver: { url: string; pullToken: string },
    private readonly dir: string,
    fetchImpl?: Fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async get(externalMessageId: string): Promise<InboundImage | null> {
    if (!MESSAGE_ID.test(externalMessageId)) return null;
    const file = join(this.dir, externalMessageId);
    try {
      return checked(readFileSync(file));
    } catch {
      // Not kept yet.
    }
    const missedAt = this.misses.get(externalMessageId);
    if (missedAt !== undefined && this.now() - missedAt < MISS_TTL_MS) return null;
    const image = await this.download(externalMessageId);
    if (!image) {
      this.misses.set(externalMessageId, this.now());
      return null;
    }
    this.misses.delete(externalMessageId);
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, image.data, { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // Shown this time; asked again next time.
    }
    return image;
  }

  private async download(externalMessageId: string): Promise<InboundImage | null> {
    try {
      const res = await this.fetchImpl(`${this.receiver.url}/media/${externalMessageId}`, {
        headers: { Authorization: `Bearer ${this.receiver.pullToken}` },
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (!res.ok || declared > ORIGINAL_MAX_BYTES) {
        await res.body?.cancel();
        return null;
      }
      return checked(Buffer.from(await res.arrayBuffer()));
    } catch {
      return null;
    }
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A synthetic striped PNG (demo and tests): no file and no network. */
export function syntheticPng(width = 160, height = 120): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const band = Math.floor((x + y) / 20) % 2 === 0;
      row.set(band ? [0x4c, 0xaf, 0x50] : [0xe8, 0xf5, 0xe9], 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** Demo mode: every received image is the same synthetic picture. */
export class MockInboundImages implements InboundImageSource {
  private readonly png = syntheticPng();
  async get(externalMessageId: string): Promise<InboundImage | null> {
    return MESSAGE_ID.test(externalMessageId) ? { type: 'image/png', data: this.png } : null;
  }
}
