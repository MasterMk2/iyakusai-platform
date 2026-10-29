import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { isAbsolute } from 'node:path';

// Strict read of a local input file of the direct composition (the Directory access-token file and
// the identity registry). Read-only: nothing here creates, copies, rewrites or logs
// the file or its content. Every read re-checks the file, so a later permission change, symlink
// swap or corruption denies instead of retaining the previous content.
//  - absolute path, not a symlink (lstat), a regular file, bounded size;
//  - POSIX: owned by the process user and owner-only (no group/other bits at all, e.g. 0600/0400:
//    the token is a secret and the registry holds primary emails and Discord ids); opened with
//    O_NOFOLLOW | O_NONBLOCK and re-verified via fstat. O_NONBLOCK keeps the synchronous open from
//    waiting forever when the path is swapped for a FIFO (or device) between lstat and open: the open
//    returns at once and the fstat type check refuses it. It does not change reads of a regular file.
// Windows: POSIX owner/mode cannot be enforced, so every read is refused ('platform'). The direct
// composition therefore cannot run on Windows; synthetic trials there inject a labelled test view.

export type LocalFileRefusal = 'platform' | 'not_absolute' | 'missing' | 'symlink' | 'not_regular' | 'owner' | 'permissions' | 'too_large' | 'changed' | 'unreadable';

/** The message names only the refusal kind: never the path or any content. */
export class LocalFileRefused extends Error {
  constructor(readonly refusal: LocalFileRefusal) {
    super(`local file refused: ${refusal}`);
  }
}

export interface LocalFileOps {
  lstat: (file: string) => Stats;
  open: (file: string, flags: number) => number;
  fstat: (fd: number) => Stats;
  read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  close: (fd: number) => void;
  platform: NodeJS.Platform;
  uid: () => number | null;
}

export const NODE_LOCAL_FILE_OPS: LocalFileOps = {
  lstat: (file) => lstatSync(file),
  open: (file, flags) => openSync(file, flags),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
  platform: process.platform,
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
};

export interface LocalFilePolicy {
  maxBytes: number;
}

function checkStats(st: Stats, policy: LocalFilePolicy, ops: LocalFileOps): void {
  if (st.isSymbolicLink()) throw new LocalFileRefused('symlink');
  if (!st.isFile()) throw new LocalFileRefused('not_regular');
  const uid = ops.uid();
  if (uid === null || st.uid !== uid) throw new LocalFileRefused('owner');
  if ((st.mode & 0o077) !== 0) throw new LocalFileRefused('permissions');
  if (st.size > policy.maxBytes) throw new LocalFileRefused('too_large');
}

/**
 * Flags of the strict open: read-only, never through a final symlink, never blocking. A POSIX Node
 * always defines both; if either were missing the open could follow a link or block, so it is refused.
 */
export function strictOpenFlags(): number {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  if (process.platform !== 'win32' && (O_NOFOLLOW === undefined || O_NONBLOCK === undefined)) throw new LocalFileRefused('platform');
  // Windows defines neither: the real reader refuses there before opening (see the platform check);
  // only the labelled test view reaches this point on a Windows host.
  return O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0);
}

export function readStrictLocalFile(file: string, policy: LocalFilePolicy, ops: LocalFileOps = NODE_LOCAL_FILE_OPS): Buffer {
  if (ops.platform === 'win32') throw new LocalFileRefused('platform');
  if (typeof file !== 'string' || !isAbsolute(file)) throw new LocalFileRefused('not_absolute');
  let before: Stats;
  try {
    before = ops.lstat(file);
  } catch {
    throw new LocalFileRefused('missing');
  }
  checkStats(before, policy, ops);
  const flags = strictOpenFlags();
  let fd: number;
  try {
    fd = ops.open(file, flags);
  } catch {
    throw new LocalFileRefused('unreadable');
  }
  try {
    const opened = ops.fstat(fd);
    checkStats(opened, policy, ops);
    // The opened file must be the one that was checked (no swap between lstat and open).
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new LocalFileRefused('changed');
    // One spare byte: a file that grew after fstat is detected instead of silently truncated.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    for (;;) {
      const n = ops.read(fd, buffer, length, buffer.length - length, length);
      if (n <= 0) break;
      length += n;
      if (length > opened.size) throw new LocalFileRefused('changed');
    }
    return buffer.subarray(0, length);
  } catch (err) {
    if (err instanceof LocalFileRefused) throw err;
    throw new LocalFileRefused('unreadable');
  } finally {
    try {
      ops.close(fd);
    } catch {
      // Nothing was written; a failing close changes nothing.
    }
  }
}
