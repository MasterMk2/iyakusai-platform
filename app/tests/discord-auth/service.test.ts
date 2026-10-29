import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudentIdRoster } from '../../src/server/discord-auth/names.js';
import { AccountError, normalizeStudentId } from '../../src/server/discord-auth/service.js';
import { AccountStore, migrateFromMinimum } from '../../src/server/discord-auth/store.js';
import { PasswordHasher } from '../../src/server/login/password.js';
import { CHAIR, GUILD, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, ROLE_PLANNING, setup, SHARED_PC } from './helpers.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof AccountError) return err.code;
    throw err;
  }
  return 'OK';
};

describe('student IDs', () => {
  it('accept digits, and letters for graduate students, in upper case', () => {
    expect(normalizeStudentId('21123456')).toBe('21123456');
    expect(normalizeStudentId('m25a123')).toBe('M25A123');
    expect(normalizeStudentId('２１１２３４５６')).toBe('21123456');
    expect(normalizeStudentId('2112')).toBeNull();
    expect(normalizeStudentId('21-123456')).toBeNull();
  });
});

describe('registration from Discord /register', () => {
  it('delivers a code by DM, then the student ID and password sign in', async () => {
    const ctx = setup();
    ctx.host.join(MEMBER, [ROLE_PLANNING]);
    const issued = await ctx.service.issueRegistration(MEMBER);
    expect(issued.initialLoginId).toMatch(/^iy-\d{8}$/);
    const envelope = ctx.host.delivered[0]!;
    expect(envelope).toMatchObject({ audience: 'https://task.example.invalid', context: { registrationUrl: 'https://task.example.invalid/register', initialLoginId: issued.initialLoginId } });
    expect(await code(ctx.service.completeRegistration({ initialLoginId: issued.initialLoginId, code: '00000000', password: PASSWORD, studentId: 'm25a123' }))).toBe('REJECTED');
    await ctx.service.completeRegistration({ initialLoginId: issued.initialLoginId, code: envelope.code, password: PASSWORD, studentId: 'm25a123' });
    const { sessionToken } = await ctx.service.login({ loginId: 'M25A123', password: PASSWORD });
    const identity = await ctx.service.authenticate(sessionToken);
    expect(identity).toMatchObject({ initialLoginId: issued.initialLoginId, studentId: 'M25A123', departments: ['企画部'], admin: false, degraded: false });
    // The iy- ID keeps working; a wrong password does not.
    expect(await code(ctx.service.login({ loginId: issued.initialLoginId, password: PASSWORD }))).toBe('OK');
    expect(await code(ctx.service.login({ loginId: 'M25A123', password: 'wrong password 0000' }))).toBe('REJECTED');
  });

  it('refuses shared accounts and people who are not current members', async () => {
    const ctx = setup();
    ctx.host.join(SHARED_PC);
    expect(await code(ctx.service.issueRegistration(SHARED_PC))).toBe('REJECTED');
    expect(await code(ctx.service.issueRegistration(OTHER))).toBe('REJECTED');
  });

  it('keeps one student ID per person', async () => {
    const ctx = setup();
    await register(ctx, MEMBER, '21123456');
    ctx.host.join(OTHER);
    const { initialLoginId } = await ctx.service.issueRegistration(OTHER);
    expect(await code(ctx.service.completeRegistration({ initialLoginId, code: ctx.host.lastCode(), password: PASSWORD, studentId: '21123456' }))).toBe('STUDENT_ID_TAKEN');
  });

  it('resets a forgotten password when a registered person runs /register again', async () => {
    const ctx = setup();
    const { initialLoginId, sessionToken } = await register(ctx, MEMBER, '21123456');
    ctx.clock.now += 60_000;
    expect((await ctx.service.issueRegistration(MEMBER)).initialLoginId).toBe(initialLoginId);
    expect(await code(ctx.service.authenticate(sessionToken))).toBe('REJECTED');
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('REJECTED');
    await ctx.service.completeRegistration({ initialLoginId, code: ctx.host.lastCode(), password: `${PASSWORD}-reset`, studentId: '21123456' });
    expect(await code(ctx.service.login({ loginId: '21123456', password: `${PASSWORD}-reset` }))).toBe('OK');
  });

  it('locks sign-in after five wrong passwords in ten minutes', async () => {
    const ctx = setup();
    await register(ctx, MEMBER, '21123456');
    for (let i = 0; i < 5; i += 1) await code(ctx.service.login({ loginId: '21123456', password: `wrong password ${i}0000` }));
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('RATE_LIMITED');
    ctx.clock.now += 600_001;
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('OK');
  });

  it('takes at most fifteen wrong passwords in 24 hours', async () => {
    const ctx = setup();
    await register(ctx, MEMBER, '21123456');
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 5; i += 1) expect(await code(ctx.service.login({ loginId: '21123456', password: `wrong password ${round}${i}000` }))).toBe('REJECTED');
      ctx.clock.now += 600_001;
    }
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('RATE_LIMITED');
    ctx.clock.now += 86_400_000;
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('OK');
  });
});

describe('sign-in record', () => {
  it('tells the person when they last signed in and the wrong passwords since then', async () => {
    const ctx = setup();
    await register(ctx, MEMBER, '21123456');
    const firstAt = ctx.clock.now;
    ctx.clock.now += 3_600_000;
    for (let i = 0; i < 2; i += 1) await code(ctx.service.login({ loginId: '21123456', password: `wrong password ${i}0000` }));
    const second = await ctx.service.login({ loginId: '21123456', password: PASSWORD });
    expect(second).toMatchObject({ previousLoginAt: firstAt, failedSince: 2 });
    expect((await ctx.service.authenticate(second.sessionToken)).signIn).toEqual({ previousLoginAt: firstAt, failedSince: 2 });
    const third = await ctx.service.login({ loginId: '21123456', password: PASSWORD });
    expect(third).toMatchObject({ previousLoginAt: ctx.clock.now, failedSince: 0 });
  });

  it('counts a wrong password typed again on a signed-in device', async () => {
    const ctx = setup();
    const { sessionToken } = await register(ctx, MEMBER, '21123456');
    expect(await code(ctx.service.reauthenticate({ sessionToken, password: 'wrong password 00000' }))).toBe('REJECTED');
    expect((await ctx.service.login({ loginId: '21123456', password: PASSWORD })).failedSince).toBe(1);
  });

  it('logs sign-ins and registrations without passwords or codes', async () => {
    const ctx = setup();
    await register(ctx, MEMBER, '21123456');
    ctx.clock.now += 1000;
    await code(ctx.service.login({ loginId: '29999999', password: 'wrong password 00000', client: '192.0.2.10' }));
    ctx.clock.now += 1000;
    await code(ctx.service.login({ loginId: '21123456', password: 'wrong password 00001', client: '192.0.2.10' }));
    ctx.clock.now += 1000;
    await code(ctx.service.login({ loginId: 'not an id at all', password: 'wrong password 00002', client: '192.0.2.10' }));
    const events = ctx.audit.recent(0, 100);
    expect(events.slice(0, 3).map((e) => [e.kind, e.reason ?? null])).toEqual([
      ['login_failed', 'unknown_id'],
      ['login_failed', 'wrong_password'],
      ['login_failed', 'unknown_id'],
    ]);
    expect(events.slice(3).map((e) => e.kind).sort()).toEqual(['code_issued', 'login_ok', 'register_ok']);
    expect(events[1]).toMatchObject({ loginId: '21123456', account: 'iy-00000001', client: '192.0.2.10' });
    expect(events[0]!.loginId).toBeNull();
    expect(events[2]!.loginId).toBe('29999999');
    const text = JSON.stringify(events);
    for (const secret of [PASSWORD, 'wrong password', ctx.host.lastCode()]) expect(text).not.toContain(secret);
  });
});

describe('bulk issue of registration codes', () => {
  const DAY = 86_400_000;

  it('gives a member who has not registered a code valid for days, without the Bot host DM', async () => {
    const ctx = setup();
    ctx.host.join(MEMBER);
    expect(await ctx.service.issueBulkRegistration(MEMBER, ctx.clock.now + 5 * DAY, true)).toEqual({ status: 'would_issue' });
    expect(ctx.service.accountActivity()).toHaveLength(0);
    const issued = await ctx.service.issueBulkRegistration(MEMBER, ctx.clock.now + 5 * DAY, false);
    expect(issued).toMatchObject({ status: 'issued', initialLoginId: 'iy-00000001', expiresAt: ctx.clock.now + 5 * DAY });
    expect(ctx.host.delivered).toHaveLength(0);
    expect(ctx.service.accountActivity()[0]).toMatchObject({ status: 'pending', pendingCode: { bulk: true, attempts: 0 } });
    ctx.clock.now += 4 * DAY;
    const { code: issuedCode } = issued as { code: string };
    await ctx.service.completeRegistration({ initialLoginId: 'iy-00000001', code: issuedCode, password: PASSWORD, studentId: '21123456' });
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('OK');
  });

  it('leaves a registered account as it is: same password, same sign-ins', async () => {
    const ctx = setup();
    const { sessionToken } = await register(ctx, CHAIR, '20000001');
    const before = ctx.store.read((s) => s.accounts[CHAIR]);
    expect(await ctx.service.issueBulkRegistration(CHAIR, ctx.clock.now + 5 * DAY, false)).toEqual({ status: 'skipped', reason: 'active' });
    expect(ctx.store.read((s) => s.accounts[CHAIR])).toEqual(before);
    expect((await ctx.service.authenticate(sessionToken)).initialLoginId).toBe('iy-00000001');
    expect(await code(ctx.service.login({ loginId: '20000001', password: PASSWORD }))).toBe('OK');
  });

  it('takes a validity between one hour and eight days, and the code ends with it', async () => {
    const ctx = setup();
    ctx.host.join(MEMBER);
    expect(await code(ctx.service.issueBulkRegistration(MEMBER, ctx.clock.now + 30 * 60_000, false))).toBe('REJECTED');
    expect(await code(ctx.service.issueBulkRegistration(MEMBER, ctx.clock.now + 9 * DAY, false))).toBe('REJECTED');
    const issued = (await ctx.service.issueBulkRegistration(MEMBER, ctx.clock.now + 2 * DAY, false)) as { code: string; initialLoginId: string };
    ctx.clock.now += 2 * DAY;
    expect(await code(ctx.service.completeRegistration({ initialLoginId: issued.initialLoginId, code: issued.code, password: PASSWORD, studentId: '21123456' }))).toBe('REJECTED');
  });

  it('refuses shared accounts and people who are not current members', async () => {
    const ctx = setup();
    ctx.host.join(SHARED_PC);
    expect(await code(ctx.service.issueBulkRegistration(SHARED_PC, ctx.clock.now + DAY * 2, false))).toBe('REJECTED');
    expect(await code(ctx.service.issueBulkRegistration(OTHER, ctx.clock.now + DAY * 2, false))).toBe('REJECTED');
  });

  it('is replaced by the person\'s own /register', async () => {
    const ctx = setup();
    ctx.host.join(MEMBER);
    const bulk = (await ctx.service.issueBulkRegistration(MEMBER, ctx.clock.now + 2 * DAY, false)) as { code: string; initialLoginId: string };
    ctx.clock.now += 60_000;
    await ctx.service.issueRegistration(MEMBER);
    expect(await code(ctx.service.completeRegistration({ initialLoginId: bulk.initialLoginId, code: bulk.code, password: PASSWORD, studentId: '21123456' }))).toBe('REJECTED');
    await ctx.service.completeRegistration({ initialLoginId: bulk.initialLoginId, code: ctx.host.lastCode(), password: PASSWORD, studentId: '21123456' });
  });
});

describe('sessions', () => {
  it('last 14 days on the device', async () => {
    const ctx = setup();
    const { sessionToken } = await register(ctx, MEMBER, '21123456');
    ctx.clock.now += 14 * 86_400_000 - 1;
    expect(await code(ctx.service.authenticate(sessionToken))).toBe('OK');
    ctx.clock.now += 2;
    expect(await code(ctx.service.authenticate(sessionToken))).toBe('REJECTED');
  });

  it('reuse a membership answer for ten minutes', async () => {
    const ctx = setup();
    const { sessionToken } = await register(ctx, MEMBER, '21123456');
    const before = ctx.host.memberCalls;
    await ctx.service.authenticate(sessionToken);
    await ctx.service.authenticate(sessionToken);
    expect(ctx.host.memberCalls).toBe(before);
    ctx.clock.now += 600_001;
    await ctx.service.authenticate(sessionToken);
    expect(ctx.host.memberCalls).toBe(before + 1);
  });

  it('keep working for 48 hours while the Bot host is unreachable, but new sign-ins need it', async () => {
    const ctx = setup();
    const { sessionToken } = await register(ctx, MEMBER, '21123456');
    ctx.host.down = true;
    ctx.clock.now += 47 * 3_600_000;
    expect(await ctx.service.authenticate(sessionToken)).toMatchObject({ degraded: true, studentId: '21123456' });
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('DEPENDENCY_UNAVAILABLE');
    ctx.clock.now += 2 * 3_600_000;
    expect(await code(ctx.service.authenticate(sessionToken))).toBe('DEPENDENCY_UNAVAILABLE');
    ctx.host.down = false;
    expect(await ctx.service.authenticate(sessionToken)).toMatchObject({ degraded: false });
  });

  it('end when the person leaves the Discord server', async () => {
    const ctx = setup();
    const { sessionToken } = await register(ctx, MEMBER, '21123456');
    ctx.host.members.get(MEMBER)!.active = false;
    ctx.clock.now += 600_001;
    expect(await code(ctx.service.authenticate(sessionToken))).toBe('REJECTED');
    ctx.host.members.get(MEMBER)!.active = true;
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('REJECTED');
  });

  it('end everywhere on a password change except the new one', async () => {
    const ctx = setup();
    const first = await register(ctx, MEMBER, '21123456');
    const second = await ctx.service.login({ loginId: '21123456', password: PASSWORD });
    const changed = await ctx.service.changePassword({ sessionToken: first.sessionToken, currentPassword: PASSWORD, newPassword: `${PASSWORD}-new` });
    expect(await code(ctx.service.authenticate(second.sessionToken))).toBe('REJECTED');
    expect(await code(ctx.service.authenticate(changed.sessionToken))).toBe('OK');
  });
});

describe('administrators and departments', () => {
  it('are the chair and members of the configured roles', async () => {
    const ctx = setup();
    const chair = await register(ctx, CHAIR, '20000001');
    const general = await register(ctx, MEMBER, '21123456', [ROLE_GENERAL_AFFAIRS]);
    const planning = await register(ctx, OTHER, '22123456', [ROLE_PLANNING]);
    expect((await ctx.service.authenticate(chair.sessionToken)).admin).toBe(true);
    expect(await ctx.service.authenticate(general.sessionToken)).toMatchObject({ admin: true, departments: ['総務部'] });
    expect(await ctx.service.authenticate(planning.sessionToken)).toMatchObject({ admin: false, departments: ['企画部'] });
  });
});

describe('switching from the production minimal runtime', () => {
  it('keeps accounts and production-profile passwords; the student ID is set afterwards', async () => {
    const hasher = new PasswordHasher();
    const password = await hasher.hash(PASSWORD);
    const minimum = {
      schema: 'discord-accounts/v1',
      revision: 0,
      nextInitialId: 2,
      accounts: {
        [MEMBER]: {
          initialLoginId: 'iy-00000001', guildId: GUILD, discordUserId: MEMBER, joinEpochMs: 1_700_000_000_000, version: 4, status: 'active',
          password, taskUserId: null, existingRoleIds: [], issueTimes: [], loginFailures: [], registrationFailures: [], pending: null,
        },
      },
      sessions: { ['0'.repeat(64)]: { discordUserId: MEMBER, version: 4, expiresAt: 1, csrfHash: '1'.repeat(64) } },
      issuerNonces: {},
    };
    const state = migrateFromMinimum(minimum);
    expect(state.sessions).toEqual({});
    const ctx = setup({ store: AccountStore.memory(state), hasher });
    ctx.host.join(MEMBER);
    const { sessionToken } = await ctx.service.login({ loginId: 'iy-00000001', password: PASSWORD });
    await ctx.service.setStudentId({ sessionToken, password: PASSWORD, studentId: '21123456' });
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('OK');
    // The next registration continues the iy- numbering.
    ctx.host.join(OTHER);
    expect((await ctx.service.issueRegistration(OTHER)).initialLoginId).toBe('iy-00000002');
  }, 30_000);
});

describe('student IDs from the committee roster', () => {
  it('sign in before the person sets one, and fill an empty field at registration', async () => {
    const ctx = setup({ roster: { [MEMBER]: '21123456' } });
    ctx.host.join(MEMBER);
    const { initialLoginId } = await ctx.service.issueRegistration(MEMBER);
    await ctx.service.completeRegistration({ initialLoginId, code: ctx.host.lastCode(), password: PASSWORD, studentId: '' });
    const { sessionToken } = await ctx.service.login({ loginId: '21123456', password: PASSWORD });
    expect(await ctx.service.authenticate(sessionToken)).toMatchObject({ studentId: '21123456' });
  });

  it('may be left empty at a password reset: the registered student ID stays', async () => {
    const ctx = setup({ roster: {} });
    const { initialLoginId } = await register(ctx, MEMBER, 'M25A123');
    ctx.clock.now += 60_000;
    await ctx.service.issueRegistration(MEMBER);
    await ctx.service.completeRegistration({ initialLoginId, code: ctx.host.lastCode(), password: `${PASSWORD}-reset`, studentId: '' });
    expect(await code(ctx.service.login({ loginId: 'M25A123', password: `${PASSWORD}-reset` }))).toBe('OK');
  });

  it('are required at registration only when the roster has none for the person', async () => {
    const ctx = setup({ roster: {} });
    ctx.host.join(MEMBER);
    const { initialLoginId } = await ctx.service.issueRegistration(MEMBER);
    expect(await code(ctx.service.completeRegistration({ initialLoginId, code: ctx.host.lastCode(), password: PASSWORD, studentId: ' ' }))).toBe('STUDENT_ID_REQUIRED');
  });

  it('give way to the ID the person typed or set', async () => {
    const ctx = setup({ roster: { [MEMBER]: '21123456' } });
    const { sessionToken } = await register(ctx, MEMBER, '21999999');
    expect(await code(ctx.service.login({ loginId: '21123456', password: PASSWORD }))).toBe('REJECTED');
    await ctx.service.setStudentId({ sessionToken, password: PASSWORD, studentId: 'm25a123' });
    expect(await code(ctx.service.login({ loginId: 'M25A123', password: PASSWORD }))).toBe('OK');
    expect(await code(ctx.service.login({ loginId: '21999999', password: PASSWORD }))).toBe('REJECTED');
  });

  it('cannot be taken by someone else, and an ID someone set wins over the roster', async () => {
    const ctx = setup({ roster: { [MEMBER]: '21123456' } });
    ctx.host.join(MEMBER);
    const first = await ctx.service.issueRegistration(MEMBER);
    await ctx.service.completeRegistration({ initialLoginId: first.initialLoginId, code: ctx.host.lastCode(), password: PASSWORD, studentId: '' });
    ctx.host.join(OTHER);
    const { initialLoginId } = await ctx.service.issueRegistration(OTHER);
    expect(await code(ctx.service.completeRegistration({ initialLoginId, code: ctx.host.lastCode(), password: PASSWORD, studentId: '21123456' }))).toBe('STUDENT_ID_TAKEN');

    // A roster mistake: OTHER already set the number explicitly, so the roster entry is not used for MEMBER.
    const wrong = setup({ roster: { [MEMBER]: '21123456' } });
    await register(wrong, OTHER, '21123456');
    wrong.host.join(MEMBER);
    const issued = await wrong.service.issueRegistration(MEMBER);
    await wrong.service.completeRegistration({ initialLoginId: issued.initialLoginId, code: wrong.host.lastCode(), password: PASSWORD, studentId: '21000001' });
    const { sessionToken } = await wrong.service.login({ loginId: '21123456', password: PASSWORD });
    expect((await wrong.service.authenticate(sessionToken)).initialLoginId).not.toBe(issued.initialLoginId);
    expect(await code(wrong.service.login({ loginId: '21000001', password: PASSWORD }))).toBe('OK');
  });

  it('are read from the operator file, ignoring invalid and duplicated entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iy-roster-'));
    try {
      const file = join(dir, 'student-ids.json');
      writeFileSync(file, JSON.stringify({ version: 1, studentIds: { [MEMBER]: 'm25a123', [OTHER]: '21-1', [CHAIR]: '21000001', [SHARED_PC]: '21000001' } }));
      const roster = new StudentIdRoster(file, normalizeStudentId);
      expect(roster.studentIdOf(MEMBER)).toBe('M25A123');
      expect(roster.studentIdOf(OTHER)).toBeNull();
      expect(roster.studentIdOf(CHAIR)).toBeNull();
      expect(roster.studentIdOf(SHARED_PC)).toBeNull();
      writeFileSync(file, JSON.stringify({ version: 1, studentIds: { [OTHER]: '21123456' } }));
      expect(roster.studentIdOf(OTHER)).toBe('21123456');
      expect(new StudentIdRoster(join(dir, 'missing.json'), normalizeStudentId).studentIdOf(MEMBER)).toBeNull();
      expect(new StudentIdRoster(null, normalizeStudentId).studentIdOf(MEMBER)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
