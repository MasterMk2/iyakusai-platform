import { fsyncSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  FileLoginPersistence,
  LoginService,
  LoginStoreIntegrityError,
  LOW_COST_TEST_ONLY,
  PasswordHasher,
  SCRYPT_PRODUCTION,
  SCRYPT_TEST_ONLY,
  type LoginServiceOptions,
  type PasswordHash,
} from '../../src/server/login/index.js';
import { NODE_FILE_OPS } from '../../src/server/durable-file.js';
import { CLIENT, makeLogin, P, type LoginFixture, type Persona } from '../login-fixtures.js';

const FAST = () => new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY });
const PASSWORD = 'correct horse battery 7';
const OTHER = 'another long passphrase 9';
const TMP = join('.tmp', 'unit-login-password');
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function fixture(overrides: Partial<LoginServiceOptions> = {}, policy = {}): LoginFixture {
  return makeLogin(policy, { passwords: FAST(), audience: 'https://login.example.invalid', ...overrides });
}

async function requestSetup(f: LoginFixture, p: Persona) {
  const before = f.sent.length;
  const outcome = f.service.requestChallenge({ email: p.email, clientKey: CLIENT, purpose: 'password_setup' });
  if (!outcome.ok) throw new Error(outcome.error);
  await f.service.idle();
  return { ...outcome, code: f.sent.slice(before).at(-1)?.code ?? null };
}

async function grantFor(f: LoginFixture, p: Persona) {
  const c = await requestSetup(f, p);
  const v = await f.service.verifySetupCode({ challengeId: c.challengeId, browserSecret: c.browserSecret, code: c.code ?? '', clientKey: CLIENT });
  if (!v.ok) throw new Error(`verify ${v.error}`);
  return v;
}

async function setPassword(f: LoginFixture, p: Persona, password = PASSWORD) {
  const grant = await grantFor(f, p);
  const done = await f.service.completePasswordSetup({ setupToken: grant.setupToken, password, clientKey: CLIENT });
  if (!done.ok) throw new Error(`setup ${done.error}`);
  return done;
}

describe('first password setup through the verified binding', () => {
  it('DMs a purpose-bound code with the verified email to the linked Discord ID only, then the person sets a password', async () => {
    const f = fixture();
    const c = await requestSetup(f, P.editorA);
    const envelope = f.sent.at(-1)!;
    expect(envelope).toMatchObject({
      template: 'password_setup_code_v1',
      purpose: 'password_setup',
      audience: 'https://login.example.invalid',
      recipient: { discordUserId: P.editorA.discordUserId, linkId: P.editorA.linkId, linkVersion: 1 },
      context: { verifiedEmail: P.editorA.email },
    });
    const grant = await f.service.verifySetupCode({ challengeId: c.challengeId, browserSecret: c.browserSecret, code: c.code!, clientKey: CLIENT });
    expect(grant).toMatchObject({ ok: true, principalId: P.editorA.principalId, hasPassword: false });
    if (!grant.ok) return;
    const done = await f.service.completePasswordSetup({ setupToken: grant.setupToken, password: PASSWORD, clientKey: CLIENT });
    expect(done).toMatchObject({ ok: true, principalId: P.editorA.principalId, replacedPassword: false });
    if (!done.ok) return;
    expect(await f.service.authenticate(done.sessionToken)).toMatchObject({ principalId: P.editorA.principalId });
    // Only hashes are held.
    const dump = JSON.stringify(f.service.store.dumpForInspection());
    for (const secret of [PASSWORD, c.code!, grant.setupToken, done.sessionToken, P.editorA.email]) expect(dump).not.toContain(secret);
  });

  it('binds codes to their purpose in both directions', async () => {
    const f = fixture();
    const setup = await requestSetup(f, P.editorA);
    expect(await f.service.verify({ challengeId: setup.challengeId, browserSecret: setup.browserSecret, code: setup.code!, clientKey: CLIENT })).toEqual({ ok: false, error: 'login_failed' });
    f.clock.advance(61_000);
    const before = f.sent.length;
    const login = f.service.requestChallenge({ email: P.editorA.email, clientKey: CLIENT, purpose: 'login' });
    if (!login.ok) throw new Error('request');
    await f.service.idle();
    const loginCode = f.sent.slice(before).at(-1)!.code;
    expect(await f.service.verifySetupCode({ challengeId: login.challengeId, browserSecret: login.browserSecret, code: loginCode, clientKey: CLIENT })).toEqual({ ok: false, error: 'login_failed' });
    expect(f.audit.some((e) => e.reason === 'wrong_purpose')).toBe(true);
  });

  it('never issues a usable code when the DM is not acknowledged, and rejects replayed, expired and superseded codes', async () => {
    const f = fixture();
    f.setDelivery(async (e) => ({ deliveryId: e.deliveryId, status: 'failed', reason: 'dm_closed' }));
    const failed = await requestSetup(f, P.editorA);
    expect((await f.service.verifySetupCode({ challengeId: failed.challengeId, browserSecret: failed.browserSecret, code: failed.code!, clientKey: CLIENT })).ok).toBe(false);

    f.setDelivery(async (e) => ({ deliveryId: e.deliveryId, status: 'delivered' }));
    f.clock.advance(61_000);
    const first = await requestSetup(f, P.viewerB);
    f.clock.advance(61_000);
    expect(f.service.resend({ challengeId: first.challengeId, browserSecret: first.browserSecret, clientKey: CLIENT }).ok).toBe(true);
    await f.service.idle();
    const second = f.sent.at(-1)!.code;
    expect(second).not.toBe(first.code);
    expect((await f.service.verifySetupCode({ challengeId: first.challengeId, browserSecret: first.browserSecret, code: first.code!, clientKey: CLIENT })).ok).toBe(false);
    const ok = await f.service.verifySetupCode({ challengeId: first.challengeId, browserSecret: first.browserSecret, code: second, clientKey: CLIENT });
    expect(ok.ok).toBe(true);
    // Replay of the consumed code.
    expect((await f.service.verifySetupCode({ challengeId: first.challengeId, browserSecret: first.browserSecret, code: second, clientKey: CLIENT })).ok).toBe(false);

    f.clock.advance(61_000);
    const late = await requestSetup(f, P.admin);
    f.clock.advance(5 * 60_000 + 1);
    expect((await f.service.verifySetupCode({ challengeId: late.challengeId, browserSecret: late.browserSecret, code: late.code!, clientKey: CLIENT })).ok).toBe(false);
  });

  it('consumes the setup grant exactly once, also under concurrency, and expires it', async () => {
    const f = fixture();
    const grant = await grantFor(f, P.editorA);
    const results = await Promise.all([
      f.service.completePasswordSetup({ setupToken: grant.setupToken, password: PASSWORD, clientKey: CLIENT }),
      f.service.completePasswordSetup({ setupToken: grant.setupToken, password: OTHER, clientKey: CLIENT }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)[0]).toEqual({ ok: false, error: 'setup_failed' });

    f.clock.advance(61_000);
    const stale = await grantFor(f, P.viewerB);
    f.clock.advance(10 * 60_000 + 1);
    expect(await f.service.completePasswordSetup({ setupToken: stale.setupToken, password: PASSWORD, clientKey: CLIENT })).toEqual({ ok: false, error: 'setup_failed' });
  });

  it('validates the password without consuming the grant and never truncates', async () => {
    expect(checkPasswordPolicy('short')).toBe('too_short');
    expect(checkPasswordPolicy('x'.repeat(129))).toBe('too_long');
    expect(checkPasswordPolicy('あ'.repeat(128))).toBeNull();
    expect(checkPasswordPolicy('tab\tinside password')).toBe('control_characters');
    expect(checkPasswordPolicy('my editor-a@staff.invalid pw', 'editor-a@staff.invalid')).toBe('contains_email');
    const f = fixture();
    const grant = await grantFor(f, P.editorA);
    for (const bad of ['short', 'y'.repeat(129), `${P.editorA.email} 12345`]) {
      const res = await f.service.completePasswordSetup({ setupToken: grant.setupToken, password: bad, clientKey: CLIENT });
      expect(res).toMatchObject({ ok: false, error: 'policy' });
    }
    expect((await f.service.completePasswordSetup({ setupToken: grant.setupToken, password: PASSWORD, clientKey: CLIENT })).ok).toBe(true);
    // The 128-character limit is exact: 129 characters never log in as the first 128.
    const long = 'z'.repeat(128);
    f.clock.advance(61_000);
    await setPassword(f, P.viewerB, long);
    expect((await f.service.passwordLogin({ email: P.viewerB.email, password: long, clientKey: CLIENT })).ok).toBe(true);
    expect((await f.service.passwordLogin({ email: P.viewerB.email, password: `${long}z`, clientKey: CLIENT })).ok).toBe(false);
  });
});

describe('normal password login', () => {
  it('logs in with the own password and fails uniformly otherwise', async () => {
    const f = fixture();
    await setPassword(f, P.editorA);
    const ok = await f.service.passwordLogin({ email: ` ${P.editorA.email.toUpperCase()} `, password: PASSWORD, clientKey: CLIENT });
    expect(ok).toMatchObject({ ok: true, principalId: P.editorA.principalId });
    const failures = await Promise.all([
      f.service.passwordLogin({ email: P.editorA.email, password: OTHER, clientKey: CLIENT }),
      f.service.passwordLogin({ email: 'nobody@staff.invalid', password: PASSWORD, clientKey: CLIENT }),
      f.service.passwordLogin({ email: P.viewerB.email, password: PASSWORD, clientKey: CLIENT }),
      f.service.passwordLogin({ email: 'not-an-email', password: PASSWORD, clientKey: CLIENT }),
    ]);
    for (const r of failures) expect(r).toEqual({ ok: false, error: 'login_failed' });
  });

  it('locks the account budget after repeated wrong passwords (also for the right one) until the window passes', async () => {
    const f = fixture();
    await setPassword(f, P.editorA);
    for (let i = 0; i < 5; i += 1) expect((await f.service.passwordLogin({ email: P.editorA.email, password: OTHER, clientKey: `${CLIENT}-${i}` })).ok).toBe(false);
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.some((e) => e.reason === 'account_locked')).toBe(true);
    f.clock.advance(15 * 60_000 + 1);
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(true);
  });

  it('rate-limits password attempts per client key', async () => {
    const f = fixture({}, { clientLoginLimit: 3 });
    await setPassword(f, P.editorA);
    for (let i = 0; i < 3; i += 1) await f.service.passwordLogin({ email: 'nobody@staff.invalid', password: OTHER, clientKey: CLIENT });
    expect(await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).toEqual({ ok: false, error: 'rate_limited' });
    expect(await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: null })).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('denies and revokes on membership loss, principal deactivation and binding replacement', async () => {
    const f = fixture();
    const first = await setPassword(f, P.editorA);
    if (!first.ok) return;
    f.dir.members.delete(P.editorA.memberKey);
    expect(await f.service.authenticate(first.sessionToken)).toBeNull();
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
    f.dir.members.set(P.editorA.memberKey, { provenance: ['nested'] });
    const nested = await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT });
    expect(nested.ok).toBe(true);
    // Uncertain membership denies.
    f.dir.members.set(P.editorA.memberKey, { resolution: 'incomplete', effectiveMember: 'unknown', provenance: [] });
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
    f.dir.members.set(P.editorA.memberKey, {});
    f.dir.principals.set(P.editorA.principalId, false);
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
    f.dir.principals.set(P.editorA.principalId, true);
    const before = await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT });
    // Verified binding replaced (new Discord account): the old password and session stop working.
    f.dir.updateLink(P.editorA.linkId, { discordUserId: '100000000000000099' });
    if (before.ok) expect(await f.service.authenticate(before.sessionToken)).toBeNull();
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
    expect(f.audit.some((e) => e.reason === 'credential_stale')).toBe(true);
    f.clock.advance(61_000);
    await setPassword(f, P.editorA, OTHER);
    expect(f.sent.at(-1)!.recipient.discordUserId).toBe('100000000000000099');
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: OTHER, clientKey: CLIENT })).ok).toBe(true);
  });
});

describe('recovery and revocation', () => {
  it('re-setting the password revokes every session, open code and older grant, and the old password', async () => {
    const f = fixture();
    const first = await setPassword(f, P.editorA);
    const login = await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT });
    if (!first.ok || !login.ok) throw new Error('setup');
    f.clock.advance(61_000);
    const pendingCode = await requestSetup(f, P.editorA);
    f.clock.advance(61_000);
    const recovered = await setPassword(f, P.editorA, OTHER);
    expect(recovered).toMatchObject({ ok: true, replacedPassword: true });
    expect(await f.service.authenticate(first.sessionToken)).toBeNull();
    expect(await f.service.authenticate(login.sessionToken)).toBeNull();
    expect((await f.service.verifySetupCode({ challengeId: pendingCode.challengeId, browserSecret: pendingCode.browserSecret, code: pendingCode.code!, clientKey: CLIENT })).ok).toBe(false);
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
    expect((await f.service.passwordLogin({ email: P.editorA.email, password: OTHER, clientKey: CLIENT })).ok).toBe(true);
    expect(f.audit.map((e) => e.type)).toContain('password_reset');
  });

  it('a login racing with a password reset never yields a session for the old credential', async () => {
    const f = fixture();
    await setPassword(f, P.editorA);
    f.clock.advance(61_000);
    const grant = await grantFor(f, P.editorA);
    const [login, reset] = await Promise.all([
      f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT }),
      f.service.completePasswordSetup({ setupToken: grant.setupToken, password: OTHER, clientKey: CLIENT }),
    ]);
    expect(reset.ok).toBe(true);
    if (login.ok) expect(await f.service.authenticate(login.sessionToken)).toBeNull();
  });

  it('removal events revoke sessions and setup grants immediately', async () => {
    const f = fixture();
    const done = await setPassword(f, P.editorA);
    f.clock.advance(61_000);
    const grant = await grantFor(f, P.editorA);
    if (!done.ok) return;
    f.service.handleDirectoryEvent({ type: 'membership_removed', memberKey: P.editorA.memberKey });
    expect(await f.service.authenticate(done.sessionToken)).toBeNull();
    expect((await f.service.completePasswordSetup({ setupToken: grant.setupToken, password: OTHER, clientKey: CLIENT })).ok).toBe(false);
  });
});

describe('KDF', () => {
  it('uses unique salts, explicit parameters and refuses tampered cost settings', async () => {
    const hasher = FAST();
    const a = await hasher.hash(PASSWORD);
    const b = await hasher.hash(PASSWORD);
    expect(a.salt).not.toBe(b.salt);
    expect(a).toMatchObject({ alg: 'scrypt', N: 16384, r: 8, p: 1 });
    expect(await hasher.verify(PASSWORD, a)).toBe(true);
    expect(await hasher.verify(OTHER, a)).toBe(false);
    const tampered: PasswordHash = { ...a, N: 2 ** 22 };
    expect(await hasher.verify(PASSWORD, tampered)).toBe(false);
    // The low-cost profile needs the exact test acknowledgement; anything else is refused.
    expect(() => new PasswordHasher({ lowCostTestProfile: 'yes' as typeof LOW_COST_TEST_ONLY })).toThrow();
    expect(() => new PasswordHasher({ maxConcurrent: 0 })).toThrow();
    expect(() => new PasswordHasher({ maxConcurrent: 8 })).toThrow();
  });

  it('defaults to the OWASP scrypt profile (N=2^17, r=8, p=1) and never evaluates a cheaper stored hash', async () => {
    expect(SCRYPT_PRODUCTION).toEqual({ N: 2 ** 17, r: 8, p: 1, keyLength: 32 });
    const production = new PasswordHasher();
    expect(production.params).toEqual(SCRYPT_PRODUCTION);
    const cheap = await FAST().hash(PASSWORD);
    expect(cheap).toMatchObject({ N: SCRYPT_TEST_ONLY.N });
    expect(production.accepts(cheap)).toBe(false);
    // Correct password, cheaper record: rejected (one production-cost dummy derivation is still spent).
    expect(await production.verify(PASSWORD, cheap)).toBe(false);
    // And a low-cost test hasher does not evaluate production records either.
    expect(FAST().accepts({ ...cheap, N: SCRYPT_PRODUCTION.N })).toBe(false);
  }, 30_000);

  it('bounds concurrent work and reports a busy KDF as unavailable', async () => {
    const f = fixture({ passwords: new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY, maxConcurrent: 1, maxQueue: 0 }) });
    await setPassword(f, P.editorA);
    const results = await Promise.all([1, 2, 3].map(() => f.service.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })));
    expect(results.some((r) => !r.ok && r.error === 'unavailable')).toBe(true);
    expect(results.some((r) => r.ok)).toBe(true);
  });
});

describe('durable login store', () => {
  it('survives a restart with only hashes on disk and refuses tampered, foreign-key or malformed files', async () => {
    const file = join(TMP, `store-${randomBytes(4).toString('hex')}.json`);
    const pepper = randomBytes(32);
    const f = fixture({ pepper, stateStore: new FileLoginPersistence(file, pepper) });
    const done = await setPassword(f, P.editorA);
    if (!done.ok) throw new Error('setup');
    const text = readFileSync(file, 'utf8');
    for (const secret of [PASSWORD, done.sessionToken, P.editorA.email]) expect(text).not.toContain(secret);

    const restarted = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
    expect(await restarted.authenticate(done.sessionToken)).toMatchObject({ principalId: P.editorA.principalId });
    expect((await restarted.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(true);

    const doc = JSON.parse(readFileSync(file, 'utf8')) as { data: string };
    writeFileSync(file, JSON.stringify({ ...doc, data: doc.data.replace('"version":1', '"version":2') }));
    expect(() => new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) })).toThrow(LoginStoreIntegrityError);
    writeFileSync(file, text);
    expect(() => new LoginService({ ...f.options, pepper: randomBytes(32), stateStore: new FileLoginPersistence(file, randomBytes(32)) })).toThrow(LoginStoreIntegrityError);
    writeFileSync(file, '{not json');
    expect(() => new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) })).toThrow(LoginStoreIntegrityError);
    // A missing file is a first start (no sample users, no passwords).
    const fresh = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(join(TMP, 'absent.json'), pepper) });
    expect(fresh.store.credentials.size).toBe(0);
  });

  it('keeps the account-failure lock across a restart and prunes it after the window', async () => {
    const file = join(TMP, `lock-${randomBytes(4).toString('hex')}.json`);
    const pepper = randomBytes(32);
    const f = fixture({ pepper, stateStore: new FileLoginPersistence(file, pepper) });
    await setPassword(f, P.editorA);
    for (let i = 0; i < 5; i += 1) expect((await f.service.passwordLogin({ email: P.editorA.email, password: OTHER, clientKey: `${CLIENT}-${i}` })).ok).toBe(false);

    const restarted = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
    const auditBefore = f.audit.length;
    // Correct password right after the restart: still locked, with the same uniform failure.
    expect(await restarted.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).toEqual({ ok: false, error: 'login_failed' });
    expect(f.audit.slice(auditBefore).some((e) => e.reason === 'account_locked')).toBe(true);
    // Only keyed references are on disk, never the email.
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).toContain('account-fail:');
    expect(onDisk).not.toContain(P.editorA.email);

    f.clock.advance(15 * 60_000 + 1);
    const later = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
    expect((await later.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(true);
    // Expired counters are pruned from the next snapshot.
    expect(readFileSync(file, 'utf8')).not.toContain('account-fail:');
  });

  it('fails closed when a full counter table cannot track a new account, and recovers after expiry', async () => {
    const file = join(TMP, `full-${randomBytes(4).toString('hex')}.json`);
    const pepper = randomBytes(32);
    const f = fixture({ pepper, stateStore: new FileLoginPersistence(file, pepper) });
    await setPassword(f, P.editorA);
    f.clock.advance(15 * 60_000 + 1);
    // Synthetic tiny cap: the client key, the global key and one other account fill the table.
    const tiny = new LoginService({ ...f.options, policy: { ...f.options.policy, maxRateKeys: 3 }, stateStore: new FileLoginPersistence(file, pepper) });
    expect(await tiny.passwordLogin({ email: 'nobody@staff.invalid', password: OTHER, clientKey: CLIENT })).toEqual({ ok: false, error: 'login_failed' });
    expect(tiny.store.stats().rateKeys).toBe(3);

    const auditBefore = f.audit.length;
    for (let i = 0; i < 7; i += 1) expect((await tiny.passwordLogin({ email: P.editorA.email, password: OTHER, clientKey: CLIENT })).ok).toBe(false);
    // Untracked while full: even the right password is not evaluated (no unlimited guesses).
    expect(await tiny.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).toEqual({ ok: false, error: 'unavailable' });
    expect(f.audit.slice(auditBefore).some((e) => e.type === 'capacity_denied' && e.reason === 'store_full')).toBe(true);
    expect(f.audit.slice(auditBefore).some((e) => e.type === 'password_login_succeeded')).toBe(false);

    // After the window the table frees up: the account is tracked again and its own limit applies.
    f.clock.advance(15 * 60_000 + 1);
    expect((await tiny.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).ok).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(await tiny.passwordLogin({ email: P.editorA.email, password: OTHER, clientKey: CLIENT })).toEqual({ ok: false, error: 'login_failed' });
    expect(await tiny.passwordLogin({ email: P.editorA.email, password: PASSWORD, clientKey: CLIENT })).toEqual({ ok: false, error: 'login_failed' });
    expect(f.audit.at(-1)).toMatchObject({ type: 'password_login_failed', reason: 'account_locked' });
  });

  it('keeps the per-target DM interval and window limits across a restart', async () => {
    const file = join(TMP, `target-${randomBytes(4).toString('hex')}.json`);
    const pepper = randomBytes(32);
    const f = fixture({ pepper, stateStore: new FileLoginPersistence(file, pepper) });
    const sentFor = () => f.sent.filter((e) => e.recipient.discordUserId === P.viewerB.discordUserId).length;
    const request = async (service: LoginService) => {
      const outcome = service.requestChallenge({ email: P.viewerB.email, clientKey: `${CLIENT}-${f.clock.now()}`, purpose: 'password_setup' });
      expect(outcome.ok).toBe(true);
      await service.idle();
    };
    await request(f.service);
    expect(sentFor()).toBe(1);
    // Interval: a restart within the minimum interval does not allow another DM.
    let service = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
    await request(service);
    expect(sentFor()).toBe(1);
    expect(f.audit.at(-1)?.type).toBe('target_rate_limited');
    // Window: three deliveries per window, each across a restart; the fourth is refused.
    for (let i = 0; i < 2; i += 1) {
      f.clock.advance(61_000);
      service = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
      await request(service);
    }
    expect(sentFor()).toBe(3);
    f.clock.advance(61_000);
    service = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
    await request(service);
    expect(sentFor()).toBe(3);
    f.clock.advance(15 * 60_000);
    service = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
    await request(service);
    expect(sentFor()).toBe(4);
  });

  it('refuses a snapshot whose counters are malformed or unbounded', () => {
    const pepper = randomBytes(32);
    const base = { kind: 'smm-login-state', version: 1, challenges: [], sessions: [], credentials: [], setupGrants: [] };
    const load = (counters: unknown) => () => new LoginService({ ...fixture({ pepper }).options, pepper, stateStore: { kind: 'durable', load: () => ({ ...base, counters }), save: () => undefined } });
    expect(load([{ key: `account-fail:${'a'.repeat(64)}`, at: [Date.now()] }])).not.toThrow();
    // A snapshot from before counters were persisted still loads.
    expect(() => new LoginService({ ...fixture({ pepper }).options, pepper, stateStore: { kind: 'durable', load: () => base, save: () => undefined } })).not.toThrow();
    for (const bad of [
      'nope',
      [{ key: 'account-fail:editor-a@staff.invalid', at: [1] }],
      [{ key: `client-login:${'a'.repeat(64)}`, at: [1] }],
      [{ key: `account-fail:${'a'.repeat(64)}`, at: ['1'] }],
      [{ key: `account-fail:${'a'.repeat(64)}`, at: Array.from({ length: 65 }, () => 1) }],
    ]) {
      expect(load(bad)).toThrow();
    }
  });

  it('keeps the previous file and leaves no temp file when a durable write fails', async () => {
    const dir = join(TMP, `fault-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'login-store.json');
    const pepper = randomBytes(32);
    let failFsync = false;
    const ops = { ...NODE_FILE_OPS, fsyncSync: (fd: number) => {
      if (failFsync) throw Object.assign(new Error('I/O error'), { code: 'EIO' });
      fsyncSync(fd);
    } };
    const f = fixture({ pepper, stateStore: new FileLoginPersistence(file, pepper, ops) });
    const grant = await grantFor(f, P.editorA);
    const before = readFileSync(file, 'utf8');
    failFsync = true;
    expect(await f.service.completePasswordSetup({ setupToken: grant.setupToken, password: PASSWORD, clientKey: CLIENT })).toEqual({ ok: false, error: 'unavailable' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['login-store.json']);
    // Restart reads the previous valid state: no password was stored.
    const restarted = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, pepper) });
    expect(restarted.store.credentials.size).toBe(0);
  });

  it('fails closed when the store cannot be written', async () => {
    const pepper = randomBytes(32);
    let fail = false;
    const persistence = { kind: 'durable' as const, load: () => null, save: () => {
      if (fail) throw new Error('disk full');
    } };
    const f = fixture({ pepper, stateStore: persistence });
    const grant = await grantFor(f, P.editorA);
    fail = true;
    expect(await f.service.completePasswordSetup({ setupToken: grant.setupToken, password: PASSWORD, clientKey: CLIENT })).toEqual({ ok: false, error: 'unavailable' });
    expect(f.service.store.credentials.size).toBe(0);
    expect(f.service.requestChallenge({ email: P.viewerB.email, clientKey: CLIENT, purpose: 'password_setup' })).toEqual({ ok: false, error: 'unavailable' });
  });
});
