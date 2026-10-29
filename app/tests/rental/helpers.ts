import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RentalStore, type Actor } from '../../src/server/rental/store.js';
import { RentalError } from '../../src/server/rental/validate.js';

export const FIXTURES = path.join(import.meta.dirname, 'fixtures');
export const LEDGER = path.join(FIXTURES, 'python-ledger');

/** Real JPEG files written by Pillow for the Python fixture (100×80). */
export const RED = readFileSync(path.join(LEDGER, 'photos', 'red.jpg'));
export const BLUE = readFileSync(path.join(LEDGER, 'photos', 'blue.jpg'));

/** A distinct valid JPEG: the red one with a comment segment after the start marker. */
export function variant(label: string, base: Buffer = RED): Buffer {
  const text = Buffer.from(label, 'utf8');
  const segment = Buffer.alloc(4 + text.length);
  segment.writeUInt16BE(0xfffe, 0);
  segment.writeUInt16BE(2 + text.length, 2);
  text.copy(segment, 4);
  return Buffer.concat([base.subarray(0, 2), segment, base.subarray(2)]);
}

/** PNG header and end chunk only, claiming the given size. */
export function pngHeader(width: number, height: number, extraChunk?: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out; // CRC is not checked by the probe.
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(extraChunk ? [chunk(extraChunk, Buffer.alloc(8))] : []),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const ACTOR: Actor = { id: 'demo', name: '試用スタッフ' };

export function metadata(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: randomUUID(),
    item_code: 'IY-000123',
    item_version: 0,
    action: 'borrow',
    borrower: '試用 模擬店A',
    condition: 'normal',
    note: '',
    client_at: '2026-10-12T12:00:00Z',
    client_read_at: '2026-10-12T11:59:58Z',
    ...changes,
  };
}

/** A fresh demo ledger with the Python server's demo items and borrowers. */
export function demoStore(): { store: RentalStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rental-'));
  const store = new RentalStore(dir, { demo: true });
  store.addItems([
    ['IY-000123', '試用 延長コード'],
    ['IY-000124', '試用 折りたたみ机'],
  ]);
  store.addBorrowers(['試用 模擬店A', '試用 模擬店B', '試用 本部']);
  return {
    store,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof RentalError) return err.status;
    throw err;
  }
  throw new Error('expected a RentalError');
}
