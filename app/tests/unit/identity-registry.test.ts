import { spawnSync } from 'node:child_process';
import { constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FileIdentityRegistry, parseIdentityRegistry, type RegistryCompatibility } from '../../src/server/account/identity-registry.js';
import { NODE_LOCAL_FILE_OPS, readStrictLocalFile, strictOpenFlags, type LocalFileOps } from '../../src/server/account/local-file.js';
import { ConfigError } from '../../src/server/auth.js';
import { binding, registryDoc as doc, hostFileOps, uid } from '../directory-fake.js';

// Authoritative identity registry: strict versioned schema, one record per person/account, Task
// identity map compatibility, and a file source that re-reads on every call and never keeps stale
// content after a corrupt/unsafe change. Synthetic ids and reserved .invalid addresses only.

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'identity-registry-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const USERS = new Set(['u-editor-a', 'u-viewer-b', 'u-admin']);
const TASK = new Map([['u-editor-a', 'user-member-a1']]);
const compat: RegistryCompatibility = { principalExists: (p) => USERS.has(p), taskUserFor: (p) => TASK.get(p) ?? null };

const VALID = [binding(1, 'u-editor-a', 'user-member-a1'), binding(2, 'u-viewer-b', null)];
/** Registry files are owner-only (0600); see hostFileOps for what a Windows host does and does not check. */
const writeOwnerOnly = (file: string, text: string) => writeFileSync(file, text, { mode: 0o600 });

describe('identity registry schema', () => {
  it('parses a valid registry and indexes it by exact email, link and principal', () => {
    const r = parseIdentityRegistry(doc(VALID), compat);
    expect(r.byEmail('person-1@synthetic.invalid')?.principalId).toBe('u-editor-a');
    expect(r.byEmail('PERSON-1@synthetic.invalid')).toBeUndefined();
    expect(r.byLinkId('link-2')?.google.userId).toBe(uid(2));
    expect(r.byPrincipal('u-viewer-b')?.taskUserId).toBeNull();
  });

  it.each([
    ['wrong kind', JSON.stringify({ kind: 'other', version: 1, bindings: [] })],
    ['future version', JSON.stringify({ kind: 'smm-identity-registry', version: 2, bindings: [] })],
    ['unknown top-level field', JSON.stringify({ kind: 'smm-identity-registry', version: 1, bindings: [], extra: 1 })],
    ['not JSON', '{"kind":'],
    ['unknown binding field', doc([{ ...VALID[0], role: 'admin' }])],
    ['unverified Discord id', doc([{ ...VALID[0], discord: { userId: '3000000000000000001', verified: false } }])],
    ['Discord user name instead of id', doc([{ ...VALID[0], discord: { userId: 'someone', verified: true } }])],
    ['email instead of stable Google id', doc([{ ...VALID[0], google: { userId: 'person-1@synthetic.invalid', primaryEmail: 'person-1@synthetic.invalid' } }])],
    ['non-normalized email', doc([{ ...VALID[0], google: { userId: uid(1), primaryEmail: 'Person-1@synthetic.invalid' } }])],
    ['unknown status', doc([{ ...VALID[0], status: 'pending' }])],
    ['unapproved evidence kind', doc([{ ...VALID[0], evidence: 'email_domain' }])],
    ['missing link version', doc([{ ...VALID[0], linkVersion: undefined }])],
    ['duplicate email', doc([VALID[0], { ...VALID[1], google: { userId: uid(2), primaryEmail: 'person-1@synthetic.invalid' } }])],
    ['duplicate Google id', doc([VALID[0], { ...VALID[1], google: { userId: uid(1), primaryEmail: 'person-2@synthetic.invalid' } }])],
    ['duplicate Discord id', doc([VALID[0], { ...VALID[1], discord: VALID[0]!.discord }])],
    ['duplicate principal', doc([VALID[0], { ...VALID[1], principalId: 'u-editor-a', taskUserId: 'user-member-a1' }])],
    ['duplicate link id', doc([VALID[0], { ...VALID[1], linkId: 'link-1' }])],
    ['duplicate even with a revoked record', doc([VALID[0], { ...binding(3, 'u-admin', null), status: 'revoked', discord: VALID[0]!.discord }])],
    ['principal that does not exist (never created)', doc([binding(4, 'u-new-person', null)])],
    ['Task user differing from the Task identity map', doc([binding(1, 'u-editor-a', 'user-other')])],
    ['Task user missing for a mapped principal', doc([binding(1, 'u-editor-a', null)])],
    ['Task user for a principal without Task identity', doc([binding(2, 'u-viewer-b', 'user-member-a1')])],
  ])('rejects %s', (_name, text) => {
    expect(() => parseIdentityRegistry(text, compat)).toThrow(ConfigError);
  });

  it('keeps messages free of identifiers and addresses', () => {
    const err = (() => {
      try {
        parseIdentityRegistry(doc([binding(1, 'u-editor-a', 'user-other')]), compat);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).not.toMatch(/person-1|u-editor-a|user-other|3000000000/);
  });

  it('keeps the tracked placeholder template valid', () => {
    const text = readFileSync(join(process.cwd(), 'deploy', 'identity-registry.example.json'), 'utf8');
    const r = parseIdentityRegistry(text, { principalExists: (p) => p === 'principal-placeholder-1', taskUserFor: (p) => (p === 'principal-placeholder-1' ? 'task-user-placeholder-1' : null) });
    expect(r.bindings.map((b) => b.status)).toEqual(['active', 'revoked']);
  });

  it('accepts a revoked binding whose principal no longer exists (it is never eligible)', () => {
    const r = parseIdentityRegistry(doc([...VALID, { ...binding(5, 'u-removed', null), status: 'revoked' }]), compat);
    expect(r.byPrincipal('u-removed')?.status).toBe('revoked');
  });
});

describe('identity registry file source', () => {
  it('re-reads changes, and a corrupt or missing file denies instead of keeping the old content', () => {
    const file = join(dir, 'registry.json');
    writeOwnerOnly(file, doc(VALID));
    const source = new FileIdentityRegistry(file, compat, hostFileOps());
    expect(source.current().byLinkId('link-1')?.status).toBe('active');
    writeFileSync(file, doc([{ ...VALID[0], status: 'revoked', linkVersion: 2 }, VALID[1]]));
    expect(source.current().byLinkId('link-1')).toMatchObject({ status: 'revoked', linkVersion: 2 });
    writeFileSync(file, '{"kind":"smm-identity-registry","version":1,"bindings":[');
    expect(() => source.current()).toThrow(ConfigError);
    rmSync(file);
    expect(() => source.current()).toThrow(/missing/);
    writeOwnerOnly(file, doc(VALID));
    expect(source.current().byLinkId('link-1')?.status).toBe('active');
  });

  it('re-checks compatibility on unchanged bytes (a removed user or changed Task map denies)', () => {
    const file = join(dir, 'registry-compat.json');
    writeOwnerOnly(file, doc(VALID));
    const users = new Set(USERS);
    const source = new FileIdentityRegistry(file, { principalExists: (p) => users.has(p), taskUserFor: compat.taskUserFor }, hostFileOps());
    source.current();
    users.delete('u-viewer-b');
    expect(() => source.current()).toThrow(ConfigError);
    users.add('u-viewer-b');
    expect(source.current().bindings).toHaveLength(2);
  });

  it('refuses symlinks, foreign owners, any group/other permission, swaps and Windows (POSIX checks)', () => {
    const content = Buffer.from(doc(VALID));
    const ops = (s: Partial<{ symlink: boolean; uid: number; mode: number; swapped: boolean; grows: boolean; platform: NodeJS.Platform }>): LocalFileOps => {
      const v = { symlink: false, uid: 1000, mode: 0o100600, swapped: false, grows: false, platform: 'linux' as NodeJS.Platform, ...s };
      const stat = (ino: number) => ({ isSymbolicLink: () => v.symlink, isFile: () => true, uid: v.uid, mode: v.mode, size: content.length - (v.grows ? 10 : 0), dev: 1, ino }) as unknown as Stats;
      return {
        lstat: () => stat(2),
        open: () => 9,
        fstat: () => stat(v.swapped ? 3 : 2),
        read: (_fd, buffer, offset, length, position) => content.copy(buffer, offset, position, position + Math.min(length, content.length - position)),
        close: () => undefined,
        platform: v.platform,
        uid: () => 1000,
      };
    };
    const file = '/synthetic/registry.json';
    expect(new FileIdentityRegistry(file, compat, ops({})).current().bindings).toHaveLength(2);
    expect(new FileIdentityRegistry(file, compat, ops({ mode: 0o100400 })).current().bindings).toHaveLength(2);
    // The registry holds primary emails and Discord ids: readable by others is refused like writable.
    for (const [bad, refusal] of [
      [{ symlink: true }, 'symlink'],
      [{ uid: 1001 }, 'owner'],
      [{ mode: 0o100644 }, 'permissions'],
      [{ mode: 0o100640 }, 'permissions'],
      [{ mode: 0o100604 }, 'permissions'],
      [{ mode: 0o100664 }, 'permissions'],
      [{ mode: 0o100646 }, 'permissions'],
      [{ platform: 'win32' }, 'platform'],
      [{ swapped: true }, 'changed'],
      [{ grows: true }, 'changed'],
    ] as const) {
      expect(() => new FileIdentityRegistry(file, compat, ops(bad)).current()).toThrow(new RegExp(refusal));
    }
    expect(() => readStrictLocalFile(file, { maxBytes: 10 }, ops({}))).toThrow(/too_large/);
  });

  it('refuses a FIFO that replaced the checked file before the open, and closes it unread', () => {
    const regular = { isSymbolicLink: () => false, isFile: () => true, uid: 1000, mode: 0o100600, size: 4, dev: 1, ino: 2 } as unknown as Stats;
    const fifo = { ...regular, isFile: () => false, mode: 0o010600, size: 0 } as unknown as Stats;
    const calls: string[] = [];
    let flags = -1;
    const ops: LocalFileOps = {
      lstat: () => regular,
      open: (_file, f) => {
        flags = f;
        calls.push('open');
        return 9;
      },
      fstat: () => fifo,
      read: () => {
        calls.push('read');
        return 0;
      },
      close: () => void calls.push('close'),
      platform: 'linux',
      uid: () => 1000,
    };
    expect(() => readStrictLocalFile('/synthetic/registry.json', { maxBytes: 10 }, ops)).toThrow(/not_regular/);
    expect(calls).toEqual(['open', 'close']);
    expect(flags).toBe(strictOpenFlags());
  });
});

// Real POSIX file system (skipped on Windows, where the reader refuses before opening). The swap
// between lstat and open is staged by giving the reader the lstat of a safe regular file while the
// path itself is a FIFO or a symlink; open, fstat and read are the real ones.
describe.runIf(process.platform !== 'win32')('strict local file on the real POSIX file system', () => {
  const real = (statOf: string): LocalFileOps => ({ ...NODE_LOCAL_FILE_OPS, lstat: () => lstatSync(statOf) });

  it('opens without following a final symlink and without blocking', () => {
    expect(strictOpenFlags() & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(strictOpenFlags() & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it('refuses promptly when the checked path is a FIFO at open time (bounded child process)', () => {
    const fixture = mkdtempSync(join(dir, 'fifo-'));
    const safe = join(fixture, 'safe.json');
    const fifo = join(fixture, 'swapped.json');
    writeOwnerOnly(safe, doc(VALID));
    expect(spawnSync('mkfifo', ['-m', '600', fifo]).status).toBe(0);
    // A blocking open would hang a FIFO without a writer forever: run it in a child that is killed at the deadline.
    const script = [
      `import { lstatSync } from 'node:fs';`,
      `import { NODE_LOCAL_FILE_OPS, readStrictLocalFile } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/server/account/local-file.ts')).href)};`,
      `const [fifo, safe] = process.argv.slice(-2);`,
      `try { readStrictLocalFile(fifo, { maxBytes: 1 << 20 }, { ...NODE_LOCAL_FILE_OPS, lstat: () => lstatSync(safe) }); console.log('read'); }`,
      `catch (err) { console.log(err?.refusal ?? 'other'); }`,
    ].join('\n');
    const started = Date.now();
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, fifo, safe], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
    expect(child.signal).toBeNull();
    expect(child.stdout.trim()).toBe('not_regular');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('refuses a final symlink that replaced the checked file before the open', () => {
    const fixture = mkdtempSync(join(dir, 'link-'));
    const safe = join(fixture, 'safe.json');
    const link = join(fixture, 'swapped.json');
    writeOwnerOnly(safe, doc(VALID));
    symlinkSync(safe, link);
    expect(() => readStrictLocalFile(link, { maxBytes: 1 << 20 }, real(safe))).toThrow(/unreadable/);
    expect(readStrictLocalFile(safe, { maxBytes: 1 << 20 }).toString('utf8')).toBe(doc(VALID));
  });
});
