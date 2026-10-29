import { randomBytes } from 'node:crypto';
import { existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NODE_FILE_OPS, writeFileDurable, type DurableFileOps } from '../../src/server/durable-file.js';
import { emptyLinkState, TaskLinkStore } from '../../src/server/tasks/links.js';

// Durable replacement used by the login store and the task-link store: unique exclusive owner-only
// temp file, fsync before rename, parent-directory fsync where the platform supports it, and on
// failure only the owned temp file is removed while the previous file stays valid.

const TMP = join('.tmp', 'unit-durable-file');
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const freshDir = () => {
  const dir = join(TMP, randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
};

interface Recorded {
  opens: { path: string; flags: unknown; mode: unknown }[];
  fsyncs: number;
  ops: DurableFileOps;
}

function recording(overrides: Partial<DurableFileOps> = {}): Recorded {
  const rec: Recorded = { opens: [], fsyncs: 0, ops: NODE_FILE_OPS };
  rec.ops = {
    ...NODE_FILE_OPS,
    openSync: ((path: string, flags: string, mode?: number) => {
      rec.opens.push({ path, flags, mode });
      return openSync(path, flags, mode);
    }) as DurableFileOps['openSync'],
    fsyncSync: (fd: number) => {
      rec.fsyncs += 1;
      fsyncSync(fd);
    },
    ...overrides,
  };
  return rec;
}

describe('writeFileDurable', () => {
  it('creates a unique, exclusive, owner-only temp file, fsyncs it and renames over the target', () => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    const rec = recording();
    writeFileDurable(file, '{"a":1}', rec.ops);
    writeFileDurable(file, '{"a":2}', rec.ops);
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}');
    const temps = rec.opens.filter((o) => o.flags === 'wx');
    expect(temps).toHaveLength(2);
    expect(temps.every((o) => o.mode === 0o600)).toBe(true);
    expect(new Set(temps.map((o) => o.path)).size).toBe(2);
    expect(rec.fsyncs).toBeGreaterThanOrEqual(2);
    expect(readdirSync(dir)).toEqual(['state.json']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('never reuses or deletes an existing file at the temp name (exclusive create)', () => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, 'previous');
    const ops = { ...NODE_FILE_OPS, randomSuffix: () => 'fixed' };
    const planted = join(dir, `.state.json.${process.pid}.fixed.tmp`);
    writeFileSync(planted, 'planted');
    expect(() => writeFileDurable(file, 'next', ops)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(file, 'utf8')).toBe('previous');
    expect(readFileSync(planted, 'utf8')).toBe('planted');
  });

  it.each([
    ['write', { writeSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }],
    ['fsync', { fsyncSync: () => { throw Object.assign(new Error('I/O'), { code: 'EIO' }); } }],
    ['rename', { renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }],
  ] as [string, Partial<DurableFileOps>][])('keeps the previous file and removes only its own temp file when %s fails', (_name, fault) => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, 'previous');
    const other = join(dir, 'unrelated.tmp');
    writeFileSync(other, 'not ours');
    expect(() => writeFileDurable(file, 'next', { ...NODE_FILE_OPS, ...fault })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('previous');
    expect(readdirSync(dir).sort()).toEqual(['state.json', 'unrelated.tmp']);
  });

  it('fsyncs the parent directory on POSIX and reports that Windows cannot', () => {
    const dir = freshDir();
    const file = join(dir, 'state.json');
    const dirSyncs: string[] = [];
    // POSIX path, simulated: the directory is opened read-only and fsynced after the rename.
    const posix: DurableFileOps = {
      ...NODE_FILE_OPS,
      platform: 'linux',
      openSync: ((path: string, flags: string, mode?: number) => {
        if (flags === 'r') {
          dirSyncs.push(path);
          // Stand-in handle that this host can fsync (Windows cannot open a directory).
          return openSync(file, 'r+');
        }
        return openSync(path, flags, mode);
      }) as DurableFileOps['openSync'],
    };
    expect(writeFileDurable(file, 'x', posix)).toEqual({ directorySynced: true });
    expect(dirSyncs).toEqual([dir]);
    // A failing directory fsync is reported (the caller fails closed) instead of claimed durable.
    const failing: DurableFileOps = { ...posix, fsyncSync: ((fd: number) => {
      if (dirSyncs.length > 1) throw Object.assign(new Error('I/O'), { code: 'EIO' });
      fsyncSync(fd);
    }) };
    expect(() => writeFileDurable(file, 'y', failing)).toThrow();
    // Windows: no directory handle is opened; the result says so.
    const win = recording({ platform: 'win32' });
    expect(writeFileDurable(file, 'z', win.ops)).toEqual({ directorySynced: false });
    expect(win.opens.some((o) => o.flags === 'r')).toBe(false);
    expect(writeFileDurable(file, 'real').directorySynced).toBe(process.platform !== 'win32');
  });
});

describe('task-link store durability', () => {
  it('keeps memory and disk at the previous state when a write fails, and restarts from it', () => {
    const dir = freshDir();
    const file = join(dir, 'links.json');
    let fail = false;
    const ops: DurableFileOps = { ...NODE_FILE_OPS, renameSync: (from, to) => {
      if (fail) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      renameSync(from, to);
    } };
    const store = new TaskLinkStore(emptyLinkState(), file, ops);
    store.transact((d) => {
      d.seq = 1;
    });
    fail = true;
    expect(() => store.transact((d) => {
      d.seq = 2;
    })).toThrow();
    expect(store.current.seq).toBe(1);
    expect(readdirSync(dir)).toEqual(['links.json']);
    const restarted = TaskLinkStore.inspect(file);
    expect(restarted).toMatchObject({ kind: 'ok', state: { seq: 1 } });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
