import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Durable whole-file replacement for the single-process stores (login state, task links).
//  1. A uniquely named temp file next to the target is created exclusively ('wx': never reuses or
//     follows an existing file) with owner-only permissions (0600 on POSIX).
//  2. The data is written completely and fsync'ed before the rename.
//  3. rename() atomically replaces the target on the same file system.
//  4. The parent directory is fsync'ed so the rename itself survives a power loss - on POSIX only.
//     Windows cannot open a directory for fsync from Node; there the rename is atomic but its
//     durability after a sudden power loss is left to NTFS metadata journaling (not guaranteed).
// On any failure before the rename, only the temp file this call created is removed; the previous
// target file is untouched and the error propagates so the caller fails closed.

export interface DurableWriteResult {
  /** True when the parent directory was fsync'ed after the rename (never on Windows). */
  directorySynced: boolean;
}

/** File operations, injectable so tests can simulate failures without touching real data. */
export interface DurableFileOps {
  openSync: typeof openSync;
  writeSync: (fd: number, data: Buffer, offset: number, length: number) => number;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  randomSuffix: () => string;
  platform: NodeJS.Platform;
}

export const NODE_FILE_OPS: DurableFileOps = {
  openSync,
  writeSync: (fd, data, offset, length) => writeSync(fd, data, offset, length),
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  randomSuffix: () => randomBytes(12).toString('hex'),
  platform: process.platform,
};

export function writeFileDurable(file: string, text: string, ops: DurableFileOps = NODE_FILE_OPS): DurableWriteResult {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${ops.randomSuffix()}.tmp`);
  const data = Buffer.from(text, 'utf8');
  // Exclusive create: an existing (stale or planted) file of the same name is an error, never reused.
  const fd = ops.openSync(tmp, 'wx', 0o600);
  let renamed = false;
  try {
    try {
      let offset = 0;
      while (offset < data.length) offset += ops.writeSync(fd, data, offset, data.length - offset);
      ops.fsyncSync(fd);
    } finally {
      ops.closeSync(fd);
    }
    ops.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        ops.unlinkSync(tmp);
      } catch {
        // Already gone; nothing else is ever deleted.
      }
    }
  }
  return { directorySynced: syncDirectory(dir, ops) };
}

function syncDirectory(dir: string, ops: DurableFileOps): boolean {
  if (ops.platform === 'win32') return false;
  // After the rename the new state is already the visible state; a failing directory sync is
  // reported to the caller (fail closed) rather than claimed as durable.
  const fd = ops.openSync(dir, 'r');
  try {
    ops.fsyncSync(fd);
  } finally {
    ops.closeSync(fd);
  }
  return true;
}
