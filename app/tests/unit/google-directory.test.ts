import type { Stats } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTORY_BUDGETS, DirectoryError, fileAccessTokenSource, GoogleDirectoryReader, MAX_DIRECTORY_DEADLINE_MS, type DirectoryBudgets } from '../../src/server/account/google-directory.js';
import type { LocalFileOps } from '../../src/server/account/local-file.js';
import { PROPOSED_LOGIN_POLICY } from '../../src/server/login/types.js';
import { OTHER_CUSTOMER, ROOT_GROUP, SYN_CUSTOMER, SYN_TOKEN, SyntheticGoogleDirectory, uid } from '../directory-fake.js';

// Directory READ adapter against a synthetic directory behind an injected fetch: whole-graph
// effective membership (pages, nested groups, CUSTOMER), live principal checks, budgets and
// fail-closed transport handling. Nothing here reaches the network.

const G = ['grpsynthone', 'grpsynthtwo', 'grpsynththree', 'grpsynthfour', 'grpsynthfive', 'grpsynthsix'];

/** The reader exactly as composed in production (default budgets, nothing to configure for reuse). */
function reader(dir: SyntheticGoogleDirectory, budgets: Partial<DirectoryBudgets> = {}): GoogleDirectoryReader {
  return new GoogleDirectoryReader({ groupId: ROOT_GROUP, customerId: SYN_CUSTOMER, token: async () => SYN_TOKEN, fetchImpl: dir.fetch, budgets });
}

const userReads = (dir: SyntheticGoogleDirectory, n: number) => dir.requests.filter((q) => new URL(q.url).pathname.endsWith(`/${uid(n)}`)).length;

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

/** Root -> six nested groups in a chain; direct user on the last root page; a deep user; a non-member. */
function sixNested(withCustomer: boolean): SyntheticGoogleDirectory {
  const dir = new SyntheticGoogleDirectory();
  dir.pageSize = 2;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) dir.addUser(n);
  dir.group(ROOT_GROUP);
  for (const g of G) dir.group(g);
  // Root: filler users, the first nested group, and the direct member on page 3.
  dir.member(ROOT_GROUP, { id: uid(3), type: 'USER' });
  dir.member(ROOT_GROUP, { id: uid(4), type: 'USER' });
  dir.member(ROOT_GROUP, { id: G[0]!, type: 'GROUP' });
  dir.member(ROOT_GROUP, { id: uid(5), type: 'USER', status: 'SUSPENDED' });
  dir.member(ROOT_GROUP, { id: uid(1), type: 'USER' });
  G.forEach((g, i) => {
    if (i + 1 < G.length) dir.member(g, { id: G[i + 1]!, type: 'GROUP' });
  });
  dir.member(G[5]!, { id: uid(6), type: 'USER' });
  dir.member(G[5]!, { id: uid(2), type: 'USER' });
  if (withCustomer) dir.member(G[2]!, { id: SYN_CUSTOMER, type: 'CUSTOMER' });
  return dir;
}

describe('Directory effective membership', () => {
  it('reads every page and six nested groups and reports direct, nested and organization membership', async () => {
    const dir = sixNested(true);
    const r = reader(dir);
    const direct = await r.lookup(ROOT_GROUP, uid(1));
    expect(direct).toMatchObject({ resolution: 'complete', effectiveMember: true, subjectType: 'user', subjectState: 'active', organizationId: SYN_CUSTOMER });
    expect([...direct.provenance].sort()).toEqual(['direct', 'organization']);
    const deep = await r.lookup(ROOT_GROUP, uid(2));
    expect([...deep.provenance].sort()).toEqual(['nested', 'organization']);
    // Root has 5 members at page size 2: three pages, every one read; every nested group read.
    expect(dir.membersRequests(ROOT_GROUP)).toBe(6);
    for (const g of G) expect(dir.membersRequests(g)).toBeGreaterThan(0);
    // Never relies on the derived-membership flag or hasMember alone; only fixed GET paths with the token.
    expect(dir.requests.every((q) => q.method === 'GET' && q.authorized && q.url.startsWith('https://admin.googleapis.com/admin/directory/v1/'))).toBe(true);
    expect(dir.requests.some((q) => q.url.includes('hasMember') || q.url.includes('includeDerivedMembership'))).toBe(false);
  });

  it('qualifies a same-customer user through CUSTOMER only by the verified customer id', async () => {
    const dir = sixNested(true);
    // uid(7): not listed anywhere, but in the configured organization -> organization membership.
    const org = await reader(dir).lookup(ROOT_GROUP, uid(7));
    expect(org).toMatchObject({ resolution: 'complete', effectiveMember: true, provenance: ['organization'], organizationId: SYN_CUSTOMER });

    // Without the CUSTOMER entry the same user is a complete non-member.
    expect(await reader(sixNested(false)).lookup(ROOT_GROUP, uid(7))).toMatchObject({ resolution: 'complete', effectiveMember: false, provenance: [], organizationId: null });

    // A CUSTOMER entry of ANOTHER organization never qualifies a user of the configured one.
    const other = sixNested(false);
    other.member(G[1]!, { id: OTHER_CUSTOMER, type: 'CUSTOMER' });
    expect(await reader(other).lookup(ROOT_GROUP, uid(7))).toMatchObject({ effectiveMember: false });

    // A user of another customer is never resolved, even if the group contains that customer.
    const foreign = sixNested(true);
    foreign.addUser(8, { customerId: OTHER_CUSTOMER });
    foreign.member(G[0]!, { id: OTHER_CUSTOMER, type: 'CUSTOMER' });
    foreign.member(ROOT_GROUP, { id: uid(8), type: 'USER' });
    expect(await reader(foreign).lookup(ROOT_GROUP, uid(8))).toMatchObject({ resolution: 'incomplete', effectiveMember: 'unknown' });
  });

  it('never resolves inactive, unknown or non-ACTIVE member entries', async () => {
    const dir = sixNested(false);
    dir.addUser(1, { suspended: true });
    expect(await reader(dir).lookup(ROOT_GROUP, uid(1))).toMatchObject({ subjectState: 'suspended', effectiveMember: 'unknown' });
    dir.addUser(1, { archived: true });
    expect(await reader(dir).lookup(ROOT_GROUP, uid(1))).toMatchObject({ subjectState: 'archived', effectiveMember: 'unknown' });
    dir.addUser(1, { deletionTime: '2026-10-01T00:00:00.000Z' });
    expect(await reader(dir).lookup(ROOT_GROUP, uid(1))).toMatchObject({ subjectState: 'deleted', effectiveMember: 'unknown' });
    // Unknown user (404): no answer at all.
    expect(await reader(dir).lookup(ROOT_GROUP, uid(42))).toMatchObject({ resolution: 'forbidden', effectiveMember: 'unknown' });
    // Listed only with a SUSPENDED member status: unresolved, not a member and not a non-member.
    expect(await reader(dir).lookup(ROOT_GROUP, uid(5))).toMatchObject({ resolution: 'incomplete', effectiveMember: 'unknown' });
    // Wrong group or a non-stable member key: never looked up.
    expect(await reader(dir).lookup('grpsynthother', uid(1))).toMatchObject({ resolution: 'unavailable' });
    expect(await reader(dir).lookup(ROOT_GROUP, 'person-1@synthetic.invalid')).toMatchObject({ resolution: 'unavailable' });
  });

  it('handles cycles: every group is read once and the read still completes', async () => {
    const dir = sixNested(false);
    dir.member(G[5]!, { id: G[0]!, type: 'GROUP' });
    dir.member(G[3]!, { id: ROOT_GROUP, type: 'GROUP' });
    const obs = await reader(dir).lookup(ROOT_GROUP, uid(6));
    expect(obs).toMatchObject({ resolution: 'complete', effectiveMember: true, provenance: ['nested'] });
    expect(dir.membersRequests(G[0]!)).toBe(1);
  });

  it.each([
    ['depth', { maxDepth: 5 }],
    ['groups', { maxGroups: 4 }],
    ['pages', { maxPages: 5 }],
    ['members', { maxMembers: 6 }],
  ] as const)('denies when the %s budget is exhausted, even for a member found earlier', async (_name, budgets) => {
    const obs = await reader(sixNested(true), budgets).lookup(ROOT_GROUP, uid(1));
    expect(obs).toMatchObject({ resolution: 'limit_exceeded', effectiveMember: 'unknown', provenance: [] });
  });

  it('denies when the whole read exceeds its deadline', async () => {
    const dir = sixNested(true);
    dir.faults.set(`/admin/directory/v1/groups/${G[4]}/members`, { kind: 'hang' });
    const obs = await reader(dir, { readDeadlineMs: 200, requestTimeoutMs: 150 }).lookup(ROOT_GROUP, uid(1));
    expect(obs).toMatchObject({ resolution: 'limit_exceeded', effectiveMember: 'unknown' });
  });

  it.each([
    ['403 on a nested (external) group', { kind: 'status', status: 403 }, 'forbidden'],
    ['404 on a nested group', { kind: 'status', status: 404 }, 'forbidden'],
    ['429', { kind: 'status', status: 429 }, 'unavailable'],
    ['500', { kind: 'status', status: 500 }, 'unavailable'],
    ['401', { kind: 'status', status: 401 }, 'unavailable'],
    ['network error', { kind: 'throw', name: 'TypeError' }, 'unavailable'],
    ['timeout', { kind: 'throw', name: 'TimeoutError' }, 'limit_exceeded'],
    ['redirect', { kind: 'redirect' }, 'incomplete'],
    ['non-JSON content type', { kind: 'body', body: '{}', contentType: 'text/html' }, 'incomplete'],
    ['invalid JSON', { kind: 'body', body: '{"members":[' }, 'incomplete'],
    ['unknown member type', { kind: 'body', body: JSON.stringify({ members: [{ id: 'x1', type: 'EXTERNAL', role: 'MEMBER' }] }) }, 'incomplete'],
    ['member without role', { kind: 'body', body: JSON.stringify({ members: [{ id: uid(1), type: 'USER', status: 'ACTIVE' }] }) }, 'incomplete'],
    ['CUSTOMER carrying an email', { kind: 'body', body: JSON.stringify({ members: [{ id: SYN_CUSTOMER, type: 'CUSTOMER', role: 'MEMBER', email: 'all@synthetic.invalid' }] }) }, 'incomplete'],
    ['oversized streamed body', { kind: 'stream', bytes: 2 * 1024 * 1024 }, 'incomplete'],
    ['oversized declared body', { kind: 'declared', length: 10 * 1024 * 1024 }, 'incomplete'],
  ] as const)('denies on %s and never reports a non-member', async (_name, fault, resolution) => {
    const dir = sixNested(true);
    dir.faults.set(`/admin/directory/v1/groups/${G[3]}/members`, fault);
    const obs = await reader(dir).lookup(ROOT_GROUP, uid(1));
    expect(obs.resolution).toBe(resolution);
    expect(obs.effectiveMember).toBe('unknown');
  });

  it('denies a partial pagination (failure on a later page) and a page-token loop', async () => {
    const dir = sixNested(true);
    dir.faults.set(`/admin/directory/v1/groups/${ROOT_GROUP}/members#p4`, { kind: 'status', status: 503 });
    expect(await reader(dir).lookup(ROOT_GROUP, uid(3))).toMatchObject({ resolution: 'unavailable', effectiveMember: 'unknown' });
    const loop = sixNested(true);
    loop.loopTokens.add(G[1]!);
    expect(await reader(loop).lookup(ROOT_GROUP, uid(3))).toMatchObject({ resolution: 'incomplete' });
  });

  it('accepts only the stable group id (an alias/email answer with another id denies)', async () => {
    const dir = sixNested(true);
    dir.faults.set(`/admin/directory/v1/groups/${ROOT_GROUP}`, { kind: 'body', body: JSON.stringify({ id: 'grpsynthalias', email: 'x@groups.synthetic.invalid' }) });
    expect(await reader(dir).lookup(ROOT_GROUP, uid(1))).toMatchObject({ resolution: 'incomplete', effectiveMember: 'unknown' });
  });

  it('reads the user and the whole tree again for every lookup, even at the same instant', async () => {
    const t = Date.parse('2026-10-11T00:00:00.000Z');
    const dir = sixNested(false);
    // A frozen clock: any time-based reuse would answer from the earlier read.
    const r = new GoogleDirectoryReader({ groupId: ROOT_GROUP, customerId: SYN_CUSTOMER, token: async () => SYN_TOKEN, fetchImpl: dir.fetch, now: () => t });
    const [a, b] = await Promise.all([r.lookup(ROOT_GROUP, uid(1)), r.lookup(ROOT_GROUP, uid(6))]);
    expect(a.effectiveMember && b.effectiveMember).toBe(true);
    // Two lookups: two whole reads (3 root pages each), one user read each.
    expect(dir.membersRequests(ROOT_GROUP)).toBe(6);
    expect(dir.membersRequests(G[5]!)).toBe(2);
    expect(userReads(dir, 1)).toBe(1);
    dir.remove(ROOT_GROUP, uid(1));
    expect(await r.lookup(ROOT_GROUP, uid(1))).toMatchObject({ resolution: 'complete', effectiveMember: false });
    dir.addUser(6, { suspended: true });
    expect(await r.lookup(ROOT_GROUP, uid(6))).toMatchObject({ subjectState: 'suspended', effectiveMember: 'unknown' });
    expect(await r.verifyPrincipal(uid(6), 'person-6@synthetic.invalid')).toBe(false);
    dir.addUser(6, { primaryEmail: 'renamed-6@synthetic.invalid' });
    expect(await r.verifyPrincipal(uid(6), 'person-6@synthetic.invalid')).toBe(false);
    expect(userReads(dir, 6)).toBe(4);
  });

  it('never lets a lookup join a read that started before a removal', async () => {
    const dir = sixNested(false);
    const r = reader(dir);
    let release!: () => void;
    const path = `/admin/directory/v1/groups/${G[5]}/members`;
    dir.holds.set(path, new Promise<void>((resolve) => (release = resolve)));
    // A: its read of the last group is answered with the pre-removal data, but held back.
    const before = r.lookup(ROOT_GROUP, uid(6));
    await until(() => dir.membersRequests(G[5]!) === 1);
    dir.holds.delete(path);
    dir.remove(G[5]!, uid(6));
    // B starts after the removal: its own complete read, decided while A is still pending.
    expect(await r.lookup(ROOT_GROUP, uid(6))).toMatchObject({ resolution: 'complete', effectiveMember: false });
    expect(dir.membersRequests(G[5]!)).toBe(2);
    release();
    // A answers only for itself, from the read it started; nothing it saw is kept.
    expect((await before).effectiveMember).toBe(true);
    expect(await r.lookup(ROOT_GROUP, uid(6))).toMatchObject({ effectiveMember: false });
  });

  it('keeps one deadline for the user read and the group read together', async () => {
    const dir = sixNested(false);
    // Each answer alone fits its request timeout; together they exceed the lookup deadline.
    dir.faults.set(`/admin/directory/v1/users/${uid(1)}`, { kind: 'delay', ms: 150 });
    dir.faults.set(`/admin/directory/v1/groups/${ROOT_GROUP}/members`, { kind: 'delay', ms: 150 });
    const started = Date.now();
    const obs = await reader(dir, { readDeadlineMs: 250, requestTimeoutMs: 200 }).lookup(ROOT_GROUP, uid(1));
    expect(obs).toMatchObject({ resolution: 'limit_exceeded', effectiveMember: 'unknown' });
    expect(Date.now() - started).toBeLessThan(1_000);
    // A slow user read alone also ends as a limit, never as a non-member.
    dir.faults.set(`/admin/directory/v1/users/${uid(1)}`, { kind: 'hang' });
    expect(await reader(dir, { readDeadlineMs: 200, requestTimeoutMs: 200 }).lookup(ROOT_GROUP, uid(1))).toMatchObject({ resolution: 'limit_exceeded', effectiveMember: 'unknown' });
  });

  it('fits the default deadline inside the login provider timeout and refuses budgets that do not', () => {
    expect(DEFAULT_DIRECTORY_BUDGETS.readDeadlineMs).toBeLessThanOrEqual(MAX_DIRECTORY_DEADLINE_MS);
    expect(MAX_DIRECTORY_DEADLINE_MS).toBeLessThan(PROPOSED_LOGIN_POLICY.providerTimeoutMs);
    expect(DEFAULT_DIRECTORY_BUDGETS.requestTimeoutMs).toBeLessThanOrEqual(DEFAULT_DIRECTORY_BUDGETS.readDeadlineMs);
    const dir = sixNested(false);
    for (const budgets of [{ readDeadlineMs: 6_000 }, { readDeadlineMs: 1_000, requestTimeoutMs: 2_000 }, { maxPages: 0 }, { maxMembers: 1.5 }]) {
      expect(() => reader(dir, budgets)).toThrow(/directory (deadline|budgets) invalid/);
    }
  });
});

describe('Directory principal verification', () => {
  it('requires the exact stable id, primary email, configured customer and an active user', async () => {
    const dir = sixNested(false);
    const r = reader(dir);
    expect(await r.verifyPrincipal(uid(1), 'person-1@synthetic.invalid')).toBe(true);
    expect(await r.verifyPrincipal(uid(1), 'person-2@synthetic.invalid')).toBe(false);
    dir.addUser(1, { customerId: OTHER_CUSTOMER });
    expect(await r.verifyPrincipal(uid(1), 'person-1@synthetic.invalid')).toBe(false);
    for (const state of [{ suspended: true }, { archived: true }, { deletionTime: '2026-10-01T00:00:00Z' }]) {
      dir.addUser(1, state);
      expect(await r.verifyPrincipal(uid(1), 'person-1@synthetic.invalid')).toBe(false);
    }
  });

  it('throws (denies) on unknown users, missing status fields, another id, or a non-stable key', async () => {
    const dir = sixNested(false);
    const r = reader(dir);
    await expect(r.verifyPrincipal(uid(42), 'person-42@synthetic.invalid')).rejects.toBeInstanceOf(DirectoryError);
    dir.faults.set(`/admin/directory/v1/users/${uid(1)}`, { kind: 'body', body: JSON.stringify({ id: uid(1), primaryEmail: 'person-1@synthetic.invalid', customerId: SYN_CUSTOMER, suspended: false }) });
    await expect(r.verifyPrincipal(uid(1), 'person-1@synthetic.invalid')).rejects.toMatchObject({ failure: 'invalid' });
    dir.faults.set(`/admin/directory/v1/users/${uid(1)}`, { kind: 'body', body: JSON.stringify({ id: uid(2), primaryEmail: 'person-1@synthetic.invalid', customerId: SYN_CUSTOMER, suspended: false, archived: false }) });
    await expect(r.verifyPrincipal(uid(1), 'person-1@synthetic.invalid')).rejects.toMatchObject({ failure: 'invalid' });
    await expect(r.verifyPrincipal('person-1@synthetic.invalid', 'person-1@synthetic.invalid')).rejects.toMatchObject({ failure: 'invalid' });
    // The user read asks only for the verification fields.
    const userReq = dir.requests.find((q) => q.url.includes('/users/'))!;
    expect(new URL(userReq.url).searchParams.get('fields')).toBe('id,primaryEmail,customerId,suspended,archived,deletionTime');
  });
});

describe('Directory credential handling', () => {
  let logs: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    logs = (['log', 'error', 'warn', 'info', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  });
  afterEach(() => vi.restoreAllMocks());

  it('never puts the token or a response body into errors or logs', async () => {
    const dir = sixNested(true);
    dir.faults.set(`/admin/directory/v1/users/${uid(1)}`, { kind: 'status', status: 403 });
    const err = await reader(dir).verifyPrincipal(uid(1), 'person-1@synthetic.invalid').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectoryError);
    const text = `${(err as Error).message} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`;
    expect(text).not.toContain(SYN_TOKEN);
    expect(text).not.toContain('synthetic failure body');
    expect(text).not.toContain(uid(1));
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it('denies when the token source fails or yields a malformed token', async () => {
    const dir = sixNested(true);
    const failing = new GoogleDirectoryReader({ groupId: ROOT_GROUP, customerId: SYN_CUSTOMER, token: async () => Promise.reject(new Error(SYN_TOKEN)), fetchImpl: dir.fetch });
    await expect(failing.verifyPrincipal(uid(1), 'person-1@synthetic.invalid')).rejects.toMatchObject({ failure: 'credential', message: expect.not.stringContaining(SYN_TOKEN) });
    const malformed = new GoogleDirectoryReader({ groupId: ROOT_GROUP, customerId: SYN_CUSTOMER, token: async () => 'bad token\nX-Injected: 1', fetchImpl: dir.fetch });
    expect((await malformed.lookup(ROOT_GROUP, uid(1))).effectiveMember).toBe('unknown');
    expect(dir.requests).toHaveLength(0);
  });

  it('reads an operator token file only when it is an owner-only regular file (POSIX checks)', async () => {
    const content = Buffer.from(`${SYN_TOKEN}\n`);
    const ops = (stat: Partial<{ symlink: boolean; file: boolean; uid: number; mode: number; platform: NodeJS.Platform }>): LocalFileOps => {
      const s = { symlink: false, file: true, uid: 1000, mode: 0o100600, platform: 'linux' as NodeJS.Platform, ...stat };
      const stats = { isSymbolicLink: () => s.symlink, isFile: () => s.file, uid: s.uid, mode: s.mode, size: content.length, dev: 1, ino: 2 } as unknown as Stats;
      return {
        lstat: () => stats,
        open: () => 7,
        fstat: () => stats,
        read: (_fd, buffer, offset, length, position) => content.copy(buffer, offset, position, position + Math.min(length, content.length - position)),
        close: () => undefined,
        platform: s.platform,
        uid: () => 1000,
      };
    };
    const file = '/synthetic/secret/directory-token';
    await expect(fileAccessTokenSource(file, ops({}))()).resolves.toBe(SYN_TOKEN);
    // Windows: owner/mode cannot be enforced, so the token file is never read there.
    for (const bad of [{ symlink: true }, { file: false }, { uid: 0 }, { mode: 0o100640 }, { mode: 0o100604 }, { platform: 'win32' as const }]) {
      await expect(fileAccessTokenSource(file, ops(bad))()).rejects.toMatchObject({ failure: 'credential' });
    }
    await expect(fileAccessTokenSource('relative/token', ops({}))()).rejects.toMatchObject({ failure: 'credential' });
  });
});
