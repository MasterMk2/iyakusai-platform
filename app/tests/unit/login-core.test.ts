import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/server/auth.js';
import { MemoryLoginStore } from '../../src/server/login/memory-store.js';
import { LoginService, normalizeEmail, validatePolicy } from '../../src/server/login/service.js';
import { PROPOSED_LOGIN_POLICY, REFERENCE_STORE_ACK, type LoginServiceOptions, type MembershipObservation } from '../../src/server/login/index.js';
import {
  allUsersOf,
  CLIENT,
  delivered,
  FakeClock,
  FakeDirectory,
  LOGIN_GROUP,
  LOGIN_ORG,
  makeLogin,
  P,
  startLogin,
  SyntheticGroupGraph,
  TEST_PEPPER,
  type LoginFixture,
} from '../login-fixtures.js';

const MIN = 60_000;

async function login(f: LoginFixture, email = P.editorA.email) {
  const started = await startLogin(f, email);
  const result = await f.service.verify({ ...started, code: started.code ?? '00000000', clientKey: CLIENT });
  return { started, result };
}

const wrong = (code: string) => (code === '00000000' ? '00000001' : '00000000');

describe('fail-safe construction', () => {
  it('refuses missing providers, unapproved evidence, weak pepper, unknown store and out-of-range policy', () => {
    const base = makeLogin().options;
    const bad: Partial<LoginServiceOptions>[] = [
      { membership: undefined as never },
      { links: { findByVerifiedEmail: base.links.findByVerifiedEmail } as never },
      { principals: undefined as never },
      { deliver: undefined as never },
      { audit: undefined as never },
      { groupId: '' },
      { groupId: 'group with spaces' },
      { organizationId: '' },
      { organizationId: 'org with spaces' },
      { acceptedLinkEvidence: [] },
      { acceptedLinkEvidence: ['self_asserted' as never] },
      { pepper: Buffer.alloc(16, 7) },
      { pepper: Buffer.alloc(64, 0) },
      { stateStore: 'production' as never },
      { serviceLabel: '' },
      { policy: { codeDigits: 4 } },
      { policy: { codeTtlMs: 60 * MIN } },
      { policy: { maxAttemptsPerChallenge: 0 } },
      { policy: { sessionIdleMs: 60 * MIN, sessionAbsoluteMs: 10 * MIN } },
      { policy: { maxQueue: 1.5 } },
      { policy: { unknownKnob: 1 } as never },
    ];
    for (const patch of bad) expect(() => new LoginService({ ...base, ...patch }), JSON.stringify(Object.keys(patch))).toThrow(ConfigError);
    expect(() => new MemoryLoginStore('yes' as never, { maxChallenges: 1, maxSessions: 1, maxRateKeys: 1, maxWindowMs: 1 })).toThrow();
  });

  it('exposes the documented proposal defaults', () => {
    expect(validatePolicy()).toEqual(PROPOSED_LOGIN_POLICY);
    expect(PROPOSED_LOGIN_POLICY).toMatchObject({ codeDigits: 8, codeTtlMs: 5 * MIN, maxAttemptsPerChallenge: 5, accountFailureLimit: 5, targetMinIntervalMs: MIN, targetMaxDeliveries: 3, sessionIdleMs: 30 * MIN, sessionAbsoluteMs: 480 * MIN });
  });
});

describe('happy path and recipient safety', () => {
  it('delivers one 8-digit code only to the linked Discord account and logs in as the linked principal', async () => {
    const f = makeLogin();
    const { started, result } = await login(f);
    expect(f.sent).toHaveLength(1);
    const envelope = f.sent[0]!;
    expect(envelope.code).toMatch(/^\d{8}$/);
    expect(envelope.recipient).toEqual({ discordUserId: P.editorA.discordUserId, linkId: P.editorA.linkId, linkVersion: 1 });
    expect(envelope.template).toBe('login_code_v1');
    // Minimal envelope: no email, browser, IP, group or role information.
    expect(Object.keys(envelope).sort()).toEqual(['code', 'context', 'deliveryId', 'expiresAt', 'kind', 'recipient', 'template']);
    expect(JSON.stringify(envelope)).not.toContain('@');
    expect(started.browserSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result).toMatchObject({ ok: true, principalId: P.editorA.principalId });
    if (!result.ok) throw new Error('login failed');
    expect(await f.service.authenticate(result.sessionToken)).toMatchObject({ principalId: P.editorA.principalId });
  });

  it('normalizes only case and whitespace; aliases, plus-addresses and look-alikes never reach a DM', async () => {
    expect(normalizeEmail('  Editor-A@Staff.INVALID ')).toBe(P.editorA.email);
    expect(normalizeEmail('a@b')).toBeNull();
    const f = makeLogin();
    for (const email of ['editor-a+x@staff.invalid', 'editora@staff.invalid', 'editor-a@staff.example', 'editor-a@sub.staff.invalid']) await startLogin(f, email);
    expect(f.sent).toHaveLength(0);
    // A directory that (wrongly) resolves an alias to someone else's link is still refused.
    const g = makeLogin({}, {}, undefined);
    g.options.links.findByVerifiedEmail = async () => g.dir.links.get(P.viewerB.linkId)!;
    const aliasing = new LoginService({ ...g.options });
    aliasing.requestChallenge({ email: 'alias-of-viewer@staff.invalid', clientKey: CLIENT });
    await aliasing.idle();
    expect(g.sent).toHaveLength(0);
    expect(g.audit.some((e) => e.reason === 'link_mismatch')).toBe(true);
  });

  it('denies unverified, revoked, unapproved-evidence, malformed and principal-inactive links', async () => {
    const cases: [string, (f: LoginFixture) => void, string][] = [
      ['unverified', (f) => f.dir.updateLink(P.editorA.linkId, { emailVerified: false }), 'link_unverified'],
      ['revoked', (f) => f.dir.updateLink(P.editorA.linkId, { status: 'revoked' }), 'link_inactive'],
      ['evidence', (f) => f.dir.updateLink(P.editorA.linkId, { evidence: 'dual_control_proof' }), 'evidence_not_accepted'],
      ['discord name instead of id', (f) => f.dir.updateLink(P.editorA.linkId, { discordUserId: 'editor_a#0001' }), 'link_invalid'],
      ['disabled principal', (f) => f.dir.principals.set(P.editorA.principalId, false), 'principal_inactive'],
      ['unknown principal', (f) => f.dir.updateLink(P.editorA.linkId, { principalId: 'u-ghost' }), 'principal_inactive'],
      ['no link at all', (f) => f.dir.links.delete(P.editorA.linkId), 'unknown_target'],
    ];
    for (const [name, mutate, reason] of cases) {
      const f = makeLogin();
      mutate(f);
      await startLogin(f, P.editorA.email);
      expect(f.sent, name).toHaveLength(0);
      expect(f.audit.find((e) => e.type === 'eligibility_denied')?.reason, name).toBe(reason);
    }
  });

  it('requires fresh, complete, true effective membership of an active user in the configured group; anything else denies', async () => {
    const set = (patch: Partial<MembershipObservation>) => (f: LoginFixture) => f.dir.members.set(P.editorA.memberKey, patch);
    const cases: [string, (f: LoginFixture) => void, string][] = [
      ['non member', (f) => f.dir.members.delete(P.editorA.memberKey), 'not_member'],
      ['membership unknown', set({ effectiveMember: 'unknown' }), 'membership_unresolved'],
      ['incomplete resolution', set({ resolution: 'incomplete' }), 'membership_unresolved'],
      ['traversal limit', set({ resolution: 'limit_exceeded' }), 'membership_unresolved'],
      ['cycle', set({ resolution: 'cycle' }), 'membership_unresolved'],
      ['permission denied', set({ resolution: 'forbidden' }), 'provider_failure'],
      ['provider unavailable', set({ resolution: 'unavailable' }), 'provider_failure'],
      ['invited', set({ subjectState: 'invited' }), 'membership_ineligible'],
      ['suspended', set({ subjectState: 'suspended' }), 'membership_ineligible'],
      ['deleted', set({ subjectState: 'deleted' }), 'membership_ineligible'],
      ['unknown state', set({ subjectState: 'unknown' }), 'membership_ineligible'],
      ['group record', set({ subjectType: 'group' }), 'membership_ineligible'],
      ['customer record', set({ subjectType: 'customer' }), 'membership_ineligible'],
      ['no provenance', set({ provenance: [] }), 'membership_unsupported'],
      ['unknown provenance', set({ provenance: ['inferred_from_domain' as never] }), 'membership_unsupported'],
      ['duplicate provenance', set({ provenance: ['nested', 'nested'] }), 'membership_unsupported'],
      ['organization id without organization provenance', set({ organizationId: LOGIN_ORG }), 'membership_unsupported'],
      ['organization without id', set({ provenance: ['organization'] }), 'wrong_organization'],
      ['other organization', set({ provenance: ['organization'], organizationId: 'org-mock-0002' }), 'wrong_organization'],
      ['legacy direct-only shape', set({ kind: undefined as never }), 'membership_unsupported'],
      ['stale', (f) => f.dir.members.set(P.editorA.memberKey, { observedAt: f.clock.t - 31_000 }), 'membership_stale'],
      ['future', (f) => f.dir.members.set(P.editorA.memberKey, { observedAt: f.clock.t + 5_000 }), 'membership_stale'],
      ['no revision', (f) => f.dir.members.set(P.editorA.memberKey, { groupRevision: '' }), 'membership_stale'],
      ['other group', (f) => f.dir.members.set(P.editorA.memberKey, { groupId: 'grp-other' }), 'wrong_group'],
      ['other member', (f) => f.dir.members.set(P.editorA.memberKey, { memberKey: 'mem-viewer-b' }), 'link_mismatch'],
      ['provider failure', (f) => (f.dir.failing = true), 'provider_failure'],
    ];
    for (const [name, mutate, reason] of cases) {
      const f = makeLogin();
      mutate(f);
      await startLogin(f, P.editorA.email);
      expect(f.sent, name).toHaveLength(0);
      expect(f.audit.find((e) => e.type === 'eligibility_denied')?.reason, name).toBe(reason);
    }
  });

  it('times out a hanging membership provider and denies', async () => {
    const f = makeLogin({ providerTimeoutMs: 20 });
    f.dir.membershipDelayMs = 200;
    await startLogin(f, P.editorA.email);
    expect(f.sent).toHaveLength(0);
    expect(f.audit.find((e) => e.type === 'eligibility_denied')?.reason).toBe('provider_failure');
  });
});

describe('effective membership through a synthetic group graph', () => {
  const ROOT = LOGIN_GROUP;
  const OTHER_ORG = 'org-mock-0002';

  /** Login core whose only membership source is the synthetic graph; every persona starts outside the group. */
  function graphLogin(build: (g: SyntheticGroupGraph) => void, overrides: Partial<LoginServiceOptions> = {}) {
    const clock = new FakeClock();
    const dir = new FakeDirectory(clock);
    dir.enrol(P.noAccessD);
    dir.enrol(P.externalC);
    const graph = new SyntheticGroupGraph(clock);
    for (const p of Object.values(P)) graph.user(p.memberKey);
    graph.user(P.externalC.memberKey, 'org-partner-0009');
    graph.group(ROOT, []);
    build(graph);
    return { f: makeLogin({}, { membership: graph, ...overrides }, { clock, dir }), graph };
  }

  it('admits direct, one- and two-level nested, configured-organization and known external members alike', async () => {
    const cases: [string, (g: SyntheticGroupGraph) => void, typeof P.editorA][] = [
      ['direct', (g) => g.group(ROOT, [P.editorA.memberKey]), P.editorA],
      ['nested one level', (g) => g.group(ROOT, ['grp-mock-child']).group('grp-mock-child', [P.editorA.memberKey]), P.editorA],
      ['nested two levels', (g) => g.group(ROOT, ['grp-mock-a']).group('grp-mock-a', ['grp-mock-b']).group('grp-mock-b', [P.noAccessD.memberKey]), P.noAccessD],
      ['organization all-users entry', (g) => g.group(ROOT, [allUsersOf(LOGIN_ORG)]), P.viewerB],
      ['external user through a nested group', (g) => g.group(ROOT, ['grp-mock-guests']).group('grp-mock-guests', [P.externalC.memberKey]), P.externalC],
    ];
    for (const [name, build, who] of cases) {
      const { f } = graphLogin(build);
      const started = await startLogin(f, who.email);
      expect(f.sent.map((e) => e.recipient.discordUserId), name).toEqual([who.discordUserId]);
      const result = await f.service.verify({ ...started, code: started.code!, clientKey: CLIENT });
      expect(result, name).toMatchObject({ ok: true, principalId: who.principalId });
      if (!result.ok) continue;
      // The session carries only the internal principal: no group, provenance or organization.
      expect(await f.service.authenticate(result.sessionToken), name).toEqual({ principalId: who.principalId, absoluteExpiresAt: expect.any(Number) });
    }
  });

  it('treats direct plus organization evidence conservatively: the configured organization must match even with a direct path', async () => {
    const both = (g: SyntheticGroupGraph) => g.group(ROOT, [P.editorA.memberKey, allUsersOf(LOGIN_ORG)]);
    const cases: [string, Partial<LoginServiceOptions>, string | null][] = [
      ['configured organization', {}, null],
      ['other organization configured', { organizationId: OTHER_ORG }, 'wrong_organization'],
      ['no organization configured', { organizationId: undefined }, 'wrong_organization'],
    ];
    for (const [name, overrides, reason] of cases) {
      const { f, graph } = graphLogin(both, overrides);
      const observed = await graph.lookup(ROOT, P.editorA.memberKey);
      expect([...observed.provenance].sort(), name).toEqual(['direct', 'organization']);
      const started = await startLogin(f, P.editorA.email);
      if (reason === null) {
        expect(f.sent, name).toHaveLength(1);
        expect(await f.service.verify({ ...started, code: started.code!, clientKey: CLIENT }), name).toMatchObject({ ok: true, principalId: P.editorA.principalId });
      } else {
        // The direct path does not override missing or mismatched organization evidence.
        expect(f.sent, name).toHaveLength(0);
        expect(f.audit.find((e) => e.type === 'eligibility_denied')?.reason, name).toBe(reason);
      }
    }
  });

  it('denies containers, wrong scope, nonmembers, inactive subjects and non-decisive resolution', async () => {
    const nestedEditor = (g: SyntheticGroupGraph) => g.group(ROOT, ['grp-mock-child']).group('grp-mock-child', [P.editorA.memberKey]);
    const cases: [string, (g: SyntheticGroupGraph, f: LoginFixture) => void, string, Partial<LoginServiceOptions>?][] = [
      ['authoritative nonmember', (g) => g.group(ROOT, ['grp-mock-child']).group('grp-mock-child', [P.viewerB.memberKey]), 'not_member'],
      ['member of another group only', (g) => g.group('grp-mock-other', [P.editorA.memberKey]), 'not_member'],
      ['user outside the configured organization', (g) => (g.group(ROOT, [allUsersOf(LOGIN_ORG)]), g.user(P.editorA.memberKey, OTHER_ORG)), 'not_member'],
      ['all-users entry of another organization', (g) => (g.group(ROOT, [allUsersOf(OTHER_ORG)]), g.user(P.editorA.memberKey, OTHER_ORG)), 'wrong_organization'],
      ['organization evidence with no organization configured', (g) => g.group(ROOT, [allUsersOf(LOGIN_ORG)]), 'wrong_organization', { organizationId: undefined }],
      ['bare group record as identity', (g, f) => (nestedEditor(g), f.dir.updateLink(P.editorA.linkId, { memberKey: 'grp-mock-child' })), 'membership_ineligible'],
      ['bare customer record as identity', (g, f) => (g.group(ROOT, [allUsersOf(LOGIN_ORG)]), f.dir.updateLink(P.editorA.linkId, { memberKey: allUsersOf(LOGIN_ORG) })), 'membership_ineligible'],
      ['suspended nested user', (g) => (nestedEditor(g), g.user(P.editorA.memberKey, LOGIN_ORG, 'suspended')), 'membership_ineligible'],
      ['deleted organization user', (g) => (g.group(ROOT, [allUsersOf(LOGIN_ORG)]), g.user(P.editorA.memberKey, LOGIN_ORG, 'deleted')), 'membership_ineligible'],
      ['hidden child group', (g) => g.group(ROOT, ['grp-mock-hidden']).group('grp-mock-hidden', [P.editorA.memberKey], { hidden: true }), 'membership_unresolved'],
      ['incomplete pagination', (g) => g.group(ROOT, ['grp-mock-child'], { truncated: true }).group('grp-mock-child', []), 'membership_unresolved'],
      ['cycle without an answer', (g) => g.group(ROOT, ['grp-mock-a']).group('grp-mock-a', [ROOT]), 'membership_unresolved'],
      [
        'traversal limit',
        (g) => {
          const chain = Array.from({ length: 7 }, (_, i) => `grp-mock-l${i}`);
          g.group(ROOT, [chain[0]!]);
          chain.forEach((id, i) => g.group(id, i + 1 < chain.length ? [chain[i + 1]!] : [P.editorA.memberKey]));
        },
        'membership_unresolved',
      ],
      ['permission denied', (g) => (nestedEditor(g), (g.forbidden = true)), 'provider_failure'],
    ];
    for (const [name, build, reason, overrides] of cases) {
      const { f, graph } = graphLogin(() => undefined, overrides);
      build(graph, f);
      await startLogin(f, P.editorA.email);
      expect(f.sent, name).toHaveLength(0);
      expect(f.audit.find((e) => e.type === 'eligibility_denied')?.reason, name).toBe(reason);
    }
  });

  it('a nested member still needs the operator link and an acknowledged DM', async () => {
    const nested = (g: SyntheticGroupGraph) => g.group(ROOT, ['grp-mock-child']).group('grp-mock-child', [P.noAccessD.memberKey]);
    const unlinked = graphLogin(nested).f;
    unlinked.dir.links.delete(P.noAccessD.linkId);
    await startLogin(unlinked, P.noAccessD.email);
    expect(unlinked.sent).toHaveLength(0);
    expect(unlinked.audit.find((e) => e.type === 'eligibility_denied')?.reason).toBe('unknown_target');

    const closed = graphLogin(nested).f;
    closed.setDelivery(async (e) => ({ deliveryId: e.deliveryId, status: 'failed', reason: 'dm_closed' }));
    const s = await startLogin(closed, P.noAccessD.email);
    expect((await closed.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(closed.service.store.stats().sessions).toBe(0);
  });

  it('revalidates sessions: losing nested or organization membership or active status revokes, a changed path does not', async () => {
    const viaChild = (g: SyntheticGroupGraph) => g.group(ROOT, ['grp-mock-child']).group('grp-mock-child', [P.editorA.memberKey]);
    const viaOrg = (g: SyntheticGroupGraph) => g.group(ROOT, [allUsersOf(LOGIN_ORG)]);
    const cases: [string, (g: SyntheticGroupGraph) => void, (g: SyntheticGroupGraph) => void, string | null][] = [
      ['removed from the child group', viaChild, (g) => g.group('grp-mock-child', []), 'not_member'],
      ['child group detached', viaChild, (g) => g.group(ROOT, []), 'not_member'],
      ['all-users entry removed', viaOrg, (g) => g.group(ROOT, []), 'not_member'],
      ['moved to another organization', viaOrg, (g) => g.user(P.editorA.memberKey, OTHER_ORG), 'not_member'],
      ['suspended', viaOrg, (g) => g.user(P.editorA.memberKey, LOGIN_ORG, 'suspended'), 'membership_ineligible'],
      ['graph became unresolvable', viaChild, (g) => g.group('grp-mock-child', [P.editorA.memberKey], { hidden: true }), 'membership_unresolved'],
      ['nested path replaced by a direct one', viaChild, (g) => g.group(ROOT, [P.editorA.memberKey]).group('grp-mock-child', []), null],
      ['organization path replaced by a nested one', viaOrg, (g) => (g.group(ROOT, ['grp-mock-child']), g.group('grp-mock-child', [P.editorA.memberKey])), null],
    ];
    for (const [name, build, change, reason] of cases) {
      const { f, graph } = graphLogin(build);
      const { result } = await login(f);
      if (!result.ok) throw new Error(`login failed: ${name}`);
      change(graph);
      const session = await f.service.authenticate(result.sessionToken);
      if (reason === null) {
        expect(session, name).not.toBeNull();
        continue;
      }
      expect(session, name).toBeNull();
      expect(f.audit.at(-1), name).toMatchObject({ type: 'session_revoked', reason });
      // Restoring the graph does not resurrect the revoked session.
      build(graph);
      graph.user(P.editorA.memberKey);
      expect(await f.service.authenticate(result.sessionToken), `${name} stays revoked`).toBeNull();
    }
  });
});

describe('no public enumeration', () => {
  it('returns the same outcome shape for every target and decides eligibility only after responding', async () => {
    const f = makeLogin();
    f.dir.updateLink(P.viewerB.linkId, { emailVerified: false });
    f.dir.members.delete(P.admin.memberKey);
    const shapes = new Set<string>();
    for (const email of [P.editorA.email, P.viewerB.email, P.admin.email, P.noAccessD.email, 'nobody@staff.invalid']) {
      const lookupsBefore = f.dir.lookups;
      const outcome = f.service.requestChallenge({ email, clientKey: CLIENT });
      // Synchronous: no directory/membership/Bot call has happened yet for any target.
      expect(f.dir.lookups).toBe(lookupsBefore);
      expect(f.sent).toHaveLength(0);
      expect(outcome.ok).toBe(true);
      shapes.add(JSON.stringify(Object.keys(outcome).sort()) + JSON.stringify(outcome.ok && outcome.expiresInSeconds));
    }
    expect(shapes.size).toBe(1);
    await f.service.idle();
    expect(f.sent.map((e) => e.recipient.discordUserId)).toEqual([P.editorA.discordUserId]);
  });

  it('answers verification with the same failure for unknown, ineligible and wrong-code challenges', async () => {
    const f = makeLogin();
    const known = await startLogin(f, P.editorA.email);
    const unknown = await startLogin(f, 'nobody@staff.invalid');
    const results = [
      await f.service.verify({ ...known, code: wrong(known.code!), clientKey: CLIENT }),
      await f.service.verify({ ...unknown, code: '12345678', clientKey: CLIENT }),
      await f.service.verify({ challengeId: `lc_${'0'.repeat(32)}`, browserSecret: known.browserSecret, code: '12345678', clientKey: CLIENT }),
    ];
    expect(new Set(results.map((r) => JSON.stringify(r)))).toEqual(new Set([JSON.stringify({ ok: false, error: 'login_failed' })]));
  });
});

describe('code lifetime, attempts and resend budget', () => {
  it('expires codes after the TTL', async () => {
    const f = makeLogin();
    const s = await startLogin(f, P.editorA.email);
    f.clock.advance(5 * MIN);
    expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.at(-1)?.reason).toBe('expired');
  });

  it('kills a challenge after 5 failures even if the correct code follows', async () => {
    const f = makeLogin();
    const s = await startLogin(f, P.editorA.email);
    for (let i = 0; i < 5; i += 1) expect((await f.service.verify({ ...s, code: wrong(s.code!), clientKey: CLIENT })).ok).toBe(false);
    expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
  });

  it('keeps the account failure budget across resends and new challenges', async () => {
    const f = makeLogin({ maxAttemptsPerChallenge: 10 });
    const first = await startLogin(f, P.editorA.email);
    for (let i = 0; i < 3; i += 1) await f.service.verify({ ...first, code: wrong(first.code!), clientKey: CLIENT });
    f.clock.advance(MIN);
    const second = await startLogin(f, P.editorA.email);
    for (let i = 0; i < 2; i += 1) await f.service.verify({ ...second, code: wrong(second.code!), clientKey: CLIENT });
    // Budget of 5 per 15 min exhausted: even the right code of a fresh challenge is refused.
    f.clock.advance(MIN);
    const third = await startLogin(f, P.editorA.email);
    expect(third.code).not.toBeNull();
    expect((await f.service.verify({ ...third, code: third.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.at(-1)?.reason).toBe('account_locked');
    f.clock.advance(15 * MIN);
    const later = await startLogin(f, P.editorA.email);
    expect((await f.service.verify({ ...later, code: later.code!, clientKey: CLIENT })).ok).toBe(true);
  });

  it('limits DMs per target to one per 60 s and 3 per 15 min, identically for unknown targets', async () => {
    const f = makeLogin();
    for (const email of [P.editorA.email, 'nobody@staff.invalid']) {
      await startLogin(f, email);
      await startLogin(f, email);
    }
    expect(f.sent).toHaveLength(1);
    expect(f.audit.filter((e) => e.type === 'target_rate_limited')).toHaveLength(2);
    for (let i = 0; i < 4; i += 1) {
      f.clock.advance(MIN);
      await startLogin(f, P.editorA.email);
    }
    expect(f.sent).toHaveLength(3);
  });

  it('reissue in the same challenge invalidates the previous code', async () => {
    const f = makeLogin();
    const s = await startLogin(f, P.editorA.email);
    f.clock.advance(MIN);
    expect(f.service.resend({ ...s, clientKey: CLIENT })).toMatchObject({ ok: true, challengeId: s.challengeId });
    await f.service.idle();
    expect(f.sent).toHaveLength(2);
    expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(s.code === f.sent[1]!.code);
    expect((await f.service.verify({ ...s, code: f.sent[1]!.code, clientKey: CLIENT })).ok).toBe(true);
  });

  it('coalesces duplicate resends while a dispatch is in flight', async () => {
    const f = makeLogin();
    let release!: () => void;
    f.setDelivery((e) => new Promise((resolve) => (release = () => resolve({ deliveryId: e.deliveryId, status: 'delivered' }))));
    const outcome = f.service.requestChallenge({ email: P.editorA.email, clientKey: CLIENT });
    if (!outcome.ok) throw new Error('unexpected');
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 3; i += 1) expect(f.service.resend({ challengeId: outcome.challengeId, browserSecret: outcome.browserSecret, clientKey: CLIENT }).ok).toBe(true);
    release();
    await f.service.idle();
    expect(f.sent).toHaveLength(1);
  });

  it('an email-only request from another browser does not revoke an existing challenge or session', async () => {
    const f = makeLogin();
    const { result } = await login(f);
    if (!result.ok) throw new Error('login failed');
    f.clock.advance(MIN);
    const pending = await startLogin(f, P.editorA.email);
    f.clock.advance(MIN);
    await startLogin(f, P.editorA.email, 'socket:198.51.100.7');
    expect(await f.service.authenticate(result.sessionToken)).not.toBeNull();
    expect((await f.service.verify({ ...pending, code: pending.code!, clientKey: CLIENT })).ok).toBe(true);
  });
});

describe('client and global volumetric limits', () => {
  it('limits per trusted client key and globally; a missing client key is refused', async () => {
    const f = makeLogin({ clientRequestLimit: 2, globalRequestLimit: 3, clientVerifyLimit: 2 });
    expect(f.service.requestChallenge({ email: P.editorA.email, clientKey: null })).toEqual({ ok: false, error: 'rate_limited' });
    expect(f.service.requestChallenge({ email: P.editorA.email, clientKey: 'a' }).ok).toBe(true);
    expect(f.service.requestChallenge({ email: 'nobody@staff.invalid', clientKey: 'a' }).ok).toBe(true);
    expect(f.service.requestChallenge({ email: P.viewerB.email, clientKey: 'a' })).toEqual({ ok: false, error: 'rate_limited' });
    expect(f.service.requestChallenge({ email: P.viewerB.email, clientKey: 'b' }).ok).toBe(true);
    expect(f.service.requestChallenge({ email: P.viewerB.email, clientKey: 'c' })).toEqual({ ok: false, error: 'rate_limited' });
    const any = { challengeId: `lc_${'1'.repeat(32)}`, browserSecret: 'x'.repeat(43), code: '12345678' };
    expect(await f.service.verify({ ...any, clientKey: 'v' })).toEqual({ ok: false, error: 'login_failed' });
    expect(await f.service.verify({ ...any, clientKey: 'v' })).toEqual({ ok: false, error: 'login_failed' });
    expect(await f.service.verify({ ...any, clientKey: 'v' })).toEqual({ ok: false, error: 'rate_limited' });
    await f.service.idle();
  });
});

describe('single use, browser binding and fixation', () => {
  it('rejects the right code from another browser and replays of a consumed code', async () => {
    const f = makeLogin();
    const s = await startLogin(f, P.editorA.email);
    const other = await startLogin(f, 'nobody@staff.invalid');
    expect((await f.service.verify({ ...s, browserSecret: other.browserSecret, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.at(-1)?.reason).toBe('browser_mismatch');
    expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(true);
    expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.at(-1)?.reason).toBe('replay');
  });

  it('lets exactly one of many concurrent verifications win', async () => {
    const f = makeLogin({ clientVerifyLimit: 100 });
    const s = await startLogin(f, P.editorA.email);
    f.dir.membershipDelayMs = 20;
    const results = await Promise.all(Array.from({ length: 10 }, () => f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(f.service.store.stats().sessions).toBe(1);
  });

  it('revokes a session presented at login and always issues a new token', async () => {
    const f = makeLogin();
    const { result: first } = await login(f);
    if (!first.ok) throw new Error('login failed');
    f.clock.advance(MIN);
    const s = await startLogin(f, P.editorA.email);
    const second = await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT, priorSessionToken: first.sessionToken });
    if (!second.ok) throw new Error('login failed');
    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(await f.service.authenticate(first.sessionToken)).toBeNull();
    expect(await f.service.authenticate(second.sessionToken)).not.toBeNull();
  });
});

describe('revocation and rechecks', () => {
  it('a link change between issue and verify denies the code', async () => {
    const f = makeLogin();
    const s = await startLogin(f, P.editorA.email);
    f.dir.updateLink(P.editorA.linkId, { discordUserId: '100000000000000099' });
    expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.at(-1)?.reason).toBe('link_changed');
  });

  it('rechecks every authenticated request: link change, departure, disablement and provider failure revoke', async () => {
    const mutations: [string, (f: LoginFixture) => void, string][] = [
      ['link changed', (f) => f.dir.updateLink(P.editorA.linkId, {}), 'link_changed'],
      ['left group', (f) => f.dir.members.delete(P.editorA.memberKey), 'not_member'],
      ['principal disabled', (f) => f.dir.principals.set(P.editorA.principalId, false), 'principal_inactive'],
      ['provider failure', (f) => (f.dir.failing = true), 'provider_failure'],
    ];
    for (const [name, mutate, reason] of mutations) {
      const f = makeLogin();
      const { result } = await login(f);
      if (!result.ok) throw new Error('login failed');
      mutate(f);
      expect(await f.service.authenticate(result.sessionToken), name).toBeNull();
      expect(f.audit.at(-1)).toMatchObject({ type: 'session_revoked', reason });
      f.dir.failing = false;
      expect(await f.service.authenticate(result.sessionToken), `${name} stays revoked`).toBeNull();
    }
  });

  it('directory events revoke matching sessions and open challenges immediately, and only those', async () => {
    const f = makeLogin();
    const { result: a } = await login(f);
    const { result: b } = await login(f, P.viewerB.email);
    if (!a.ok || !b.ok) throw new Error('login failed');
    f.clock.advance(MIN);
    const pending = await startLogin(f, P.editorA.email);
    expect(f.service.handleDirectoryEvent({ type: 'membership_removed', memberKey: P.editorA.memberKey })).toEqual({ sessions: 1, challenges: 1 });
    expect(await f.service.authenticate(a.sessionToken)).toBeNull();
    expect((await f.service.verify({ ...pending, code: pending.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(await f.service.authenticate(b.sessionToken)).not.toBeNull();
    expect(f.service.handleDirectoryEvent({ type: 'principal_disabled', principalId: P.viewerB.principalId }).sessions).toBe(1);
    expect(f.service.handleDirectoryEvent({ type: 'link_changed', linkId: P.viewerB.linkId }).sessions).toBe(0);
  });

  it('an event during the verify recheck prevents session creation', async () => {
    const f = makeLogin();
    const s = await startLogin(f, P.editorA.email);
    f.dir.membershipDelayMs = 30;
    const pending = f.service.verify({ ...s, code: s.code!, clientKey: CLIENT });
    await new Promise((r) => setTimeout(r, 5));
    f.service.handleDirectoryEvent({ type: 'link_changed', linkId: P.editorA.linkId });
    expect((await pending).ok).toBe(false);
    expect(f.service.store.stats().sessions).toBe(0);
  });

  it('expires sessions after 30 min idle and 8 h absolute; logout revokes', async () => {
    const f = makeLogin();
    const { result } = await login(f);
    if (!result.ok) throw new Error('login failed');
    f.clock.advance(29 * MIN);
    expect(await f.service.authenticate(result.sessionToken)).not.toBeNull();
    f.clock.advance(30 * MIN);
    expect(await f.service.authenticate(result.sessionToken)).toBeNull();

    const g = makeLogin();
    const { result: r2 } = await login(g);
    if (!r2.ok) throw new Error('login failed');
    for (let i = 0; i < 16; i += 1) {
      g.clock.advance(29 * MIN);
      g.dir.members.set(P.editorA.memberKey, { observedAt: g.clock.t });
      expect(await g.service.authenticate(r2.sessionToken)).not.toBeNull();
    }
    g.clock.advance(20 * MIN);
    expect(await g.service.authenticate(r2.sessionToken)).toBeNull();
    expect(g.audit.at(-1)?.reason).toBe('absolute_timeout');

    const h = makeLogin();
    const { result: r3 } = await login(h);
    if (!r3.ok) throw new Error('login failed');
    h.service.logout(r3.sessionToken);
    expect(await h.service.authenticate(r3.sessionToken)).toBeNull();
    expect(h.audit.some((e) => e.type === 'logout')).toBe(true);
  });
});

describe('Bot delivery failures and idempotency', () => {
  const failures: [string, (f: LoginFixture) => void][] = [
    ['failed ack', (f) => f.setDelivery(async (e) => ({ deliveryId: e.deliveryId, status: 'failed', reason: 'dm_closed' }))],
    ['thrown', (f) => f.setDelivery(async () => Promise.reject(new Error('synthetic transport error')))],
    ['ack for another delivery', (f) => f.setDelivery(async () => ({ deliveryId: 'dl_other', status: 'delivered' }))],
    ['timeout', (f) => f.setDelivery(() => new Promise(() => undefined))],
  ];
  for (const [name, arrange] of failures) {
    it(`leaves no usable code after ${name}`, async () => {
      const f = makeLogin({ deliveryTimeoutMs: 20 });
      arrange(f);
      const s = await startLogin(f, P.editorA.email);
      expect(s.code).toMatch(/^\d{8}$/);
      expect(f.audit.some((e) => e.type === 'delivery_failed')).toBe(true);
      expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
      expect(f.service.store.stats().sessions).toBe(0);
    });
  }

  it('a code is unusable until the Bot acknowledges delivery', async () => {
    const f = makeLogin();
    let ack!: () => void;
    f.setDelivery((e) => new Promise((resolve) => (ack = () => resolve({ deliveryId: e.deliveryId, status: 'delivered' }))));
    const outcome = f.service.requestChallenge({ email: P.editorA.email, clientKey: CLIENT });
    if (!outcome.ok) throw new Error('unexpected');
    await new Promise((r) => setTimeout(r, 10));
    const code = f.sent[0]!.code;
    expect((await f.service.verify({ ...outcome, code, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.at(-1)?.reason).toBe('no_code');
    ack();
    await f.service.idle();
    expect((await f.service.verify({ ...outcome, code, clientKey: CLIENT })).ok).toBe(true);
  });

  it('a late ack cannot revive a timed-out code, and the failed attempt still counts', async () => {
    const f = makeLogin({ deliveryTimeoutMs: 20, accountFailureLimit: 1 });
    let lateAck: (() => void) | null = null;
    f.setDelivery((e) => new Promise((resolve) => (lateAck = () => resolve({ deliveryId: e.deliveryId, status: 'delivered' }))));
    const s = await startLogin(f, P.editorA.email);
    lateAck!();
    await new Promise((r) => setTimeout(r, 5));
    expect((await f.service.verify({ ...s, code: s.code!, clientKey: CLIENT })).ok).toBe(false);
    // A new successful delivery does not reset the account failure budget.
    f.setDelivery(delivered);
    f.clock.advance(MIN);
    const t = await startLogin(f, P.editorA.email);
    expect((await f.service.verify({ ...t, code: t.code!, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.at(-1)?.reason).toBe('account_locked');
  });
});

describe('storage and audit hygiene', () => {
  it('stores only hashes and keeps codes, tokens, secrets, emails and client keys out of state and audit', async () => {
    const f = makeLogin();
    const { started, result } = await login(f);
    if (!result.ok) throw new Error('login failed');
    await startLogin(f, 'nobody@staff.invalid', 'socket:203.0.113.99');
    const state = JSON.stringify(f.service.store.dumpForInspection());
    const audit = JSON.stringify(f.audit);
    for (const secret of [started.code!, started.browserSecret, result.sessionToken, P.editorA.email, 'nobody@staff.invalid', '203.0.113.99', P.editorA.discordUserId, TEST_PEPPER.toString('utf8')]) {
      expect(state).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
    for (const event of f.audit) {
      expect(Object.keys(event).every((k) => ['type', 'at', 'subjectRef', 'challengeRef', 'reason'].includes(k))).toBe(true);
    }
    const types = new Set(f.audit.map((e) => e.type));
    for (const t of ['challenge_requested', 'code_issued', 'delivery_succeeded', 'login_succeeded', 'eligibility_denied']) expect(types.has(t as never)).toBe(true);
  });
});

describe('bounded state and restart', () => {
  it('denies new challenges when the store is full, then recovers after expiry cleanup', async () => {
    const f = makeLogin({ maxChallenges: 2, clientRequestLimit: 100 });
    await startLogin(f, 'one@staff.invalid');
    await startLogin(f, 'two@staff.invalid');
    expect(f.service.requestChallenge({ email: 'three@staff.invalid', clientKey: CLIENT })).toEqual({ ok: false, error: 'unavailable' });
    f.clock.advance(15 * MIN);
    expect(f.service.requestChallenge({ email: 'three@staff.invalid', clientKey: CLIENT }).ok).toBe(true);
    expect(f.service.store.stats().challenges).toBe(1);
    await f.service.idle();
  });

  it('drops dispatches beyond the bounded queue without changing the public response', async () => {
    const f = makeLogin({ maxQueue: 1, dispatchConcurrency: 1 });
    let release!: () => void;
    f.setDelivery((e) => new Promise((resolve) => (release = () => resolve({ deliveryId: e.deliveryId, status: 'delivered' }))));
    const a = f.service.requestChallenge({ email: P.editorA.email, clientKey: CLIENT });
    const b = f.service.requestChallenge({ email: P.viewerB.email, clientKey: CLIENT });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(f.audit.some((e) => e.type === 'dispatch_dropped' && e.reason === 'queue_full')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await f.service.idle();
    expect(f.sent).toHaveLength(1);
  });

  it('never evicts a live blocked counter when the key space is full', async () => {
    const f = makeLogin({ maxRateKeys: 3, clientRequestLimit: 1 });
    expect(f.service.requestChallenge({ email: P.editorA.email, clientKey: 'a' }).ok).toBe(true);
    // keys now: client a, global, + target keys after dispatch
    await f.service.idle();
    expect(f.service.store.stats().rateKeys).toBeLessThanOrEqual(3);
    expect(f.service.requestChallenge({ email: P.editorA.email, clientKey: 'b' })).toEqual({ ok: false, error: 'rate_limited' });
    expect(f.service.requestChallenge({ email: P.editorA.email, clientKey: 'a' })).toEqual({ ok: false, error: 'rate_limited' });
    expect(f.audit.some((e) => e.type === 'capacity_denied')).toBe(true);
  });

  it('loses every challenge and session on restart of the reference service', async () => {
    const f = makeLogin();
    const { result } = await login(f);
    if (!result.ok) throw new Error('login failed');
    f.clock.advance(MIN);
    const pending = await startLogin(f, P.editorA.email);
    const restarted = makeLogin({}, {}, { clock: f.clock, dir: f.dir });
    expect(await restarted.service.authenticate(result.sessionToken)).toBeNull();
    expect((await restarted.service.verify({ ...pending, code: pending.code!, clientKey: CLIENT })).ok).toBe(false);
  });

  it('uses the configured group for every lookup', async () => {
    const f = makeLogin();
    const seen: string[] = [];
    const lookup = f.dir.membership.lookup;
    f.options.membership = { lookup: (g, m) => (seen.push(g), lookup(g, m)) };
    const service = new LoginService(f.options);
    service.requestChallenge({ email: P.editorA.email, clientKey: CLIENT });
    await service.idle();
    expect(seen).toEqual([LOGIN_GROUP]);
    expect(REFERENCE_STORE_ACK).toBe('single-process-preparation-test-only');
  });
});
