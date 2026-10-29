import { describe, expect, it } from 'vitest';
import { AccountStateError, migrateFromMinimum, mergeWithTrial, type AccountState } from '../../src/server/discord-auth/store.js';
import { CHAIR, GUILD, MEMBER, OTHER } from './helpers.js';

// Synthetic records only: password records are placeholders, never real scrypt output.
const NEWCOMER = '1000000000000001004';
const pw = (n: number) => ({ alg: 'scrypt' as const, N: 131072, r: 8, p: 1, salt: `salt-${n}`, hash: `hash-${n}` });
const digest = (n: number) => n.toString(16).padStart(64, '0');

function minimumAccount(uid: string, id: number, version: number, password: number) {
  return {
    initialLoginId: `iy-${String(id).padStart(8, '0')}`, guildId: GUILD, discordUserId: uid, joinEpochMs: 1_700_000_000_000, version, status: 'active',
    password: pw(password), taskUserId: null, existingRoleIds: [], issueTimes: [], loginFailures: [], registrationFailures: [], pending: null,
  };
}

const minimum = (accounts: ReturnType<typeof minimumAccount>[], nextInitialId: number) => ({
  schema: 'discord-accounts/v1', revision: 7, nextInitialId,
  accounts: Object.fromEntries(accounts.map((a) => [a.discordUserId, a])), sessions: {}, issuerNonces: { [digest(1)]: 1 },
});

/** The trial copy as migrated earlier, then used: student IDs set and people signed in. */
function trialFrom(before: ReturnType<typeof minimum>): AccountState {
  const state = migrateFromMinimum(before);
  state.accounts[CHAIR]!.studentId = '21000001';
  state.accounts[MEMBER]!.studentId = '21000002';
  state.accounts[OTHER]!.studentId = 'M25A003';
  for (const [n, uid] of [CHAIR, MEMBER, OTHER].entries()) {
    state.sessions[digest(100 + n)] = { discordUserId: uid, version: state.accounts[uid]!.version, createdAt: 1, expiresAt: 9_000_000_000_000 };
  }
  state.issuerNonces[digest(2)] = 2;
  return state;
}

describe('merging the production accounts with the trial at the switch', () => {
  const atTrial = minimum([minimumAccount(CHAIR, 1, 2, 1), minimumAccount(MEMBER, 2, 2, 2), minimumAccount(OTHER, 3, 2, 3)], 4);

  it('keeps student IDs and sign-ins, takes the newer password side and adds new registrations', () => {
    const trial = trialFrom(atTrial);
    // In the unified app, OTHER changed the password (version 3).
    trial.accounts[OTHER] = { ...trial.accounts[OTHER]!, version: 3, password: pw(30) };
    trial.sessions[digest(102)]!.version = 3;
    // Through the old login, MEMBER reset the password with /register and NEWCOMER registered.
    const atSwitch = minimum([minimumAccount(CHAIR, 1, 2, 1), minimumAccount(MEMBER, 2, 4, 20), minimumAccount(OTHER, 3, 2, 3), minimumAccount(NEWCOMER, 4, 2, 4)], 5);

    const { state, report } = mergeWithTrial(atSwitch, trial);
    expect(report).toEqual([
      { initialLoginId: 'iy-00000001', outcome: 'trial-kept' },
      { initialLoginId: 'iy-00000002', outcome: 'production-newer' },
      { initialLoginId: 'iy-00000003', outcome: 'trial-newer' },
      { initialLoginId: 'iy-00000004', outcome: 'production-only' },
    ]);
    expect(state.accounts[CHAIR]).toMatchObject({ studentId: '21000001', password: pw(1) });
    expect(state.accounts[MEMBER]).toMatchObject({ studentId: '21000002', password: pw(20), version: 4 });
    expect(state.accounts[OTHER]).toMatchObject({ studentId: 'M25A003', password: pw(30), version: 3 });
    expect(state.accounts[NEWCOMER]).toMatchObject({ studentId: null, password: pw(4) });
    expect(Object.values(state.sessions).map((s) => s.discordUserId).sort()).toEqual([CHAIR, OTHER].sort());
    expect(state.nextInitialId).toBe(5);
    expect(Object.keys(state.issuerNonces)).toEqual(expect.arrayContaining([digest(1), digest(2)]));
  });

  it('stops for an account that exists only in the unified app or whose login ID differs', () => {
    const trial = trialFrom(atTrial);
    expect(() => mergeWithTrial(minimum([minimumAccount(CHAIR, 1, 2, 1), minimumAccount(MEMBER, 2, 2, 2)], 4), trial)).toThrow(AccountStateError);
    expect(() => mergeWithTrial(minimum([minimumAccount(CHAIR, 1, 2, 1), minimumAccount(MEMBER, 2, 2, 2), minimumAccount(OTHER, 9, 2, 3)], 10), trial)).toThrow(AccountStateError);
  });
});
