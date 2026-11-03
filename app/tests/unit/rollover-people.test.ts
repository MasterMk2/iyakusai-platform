import { describe, expect, it } from 'vitest';
import { discordPeople, type DiscordPeopleApi } from '../../src/server/rollover/compose.js';
import { grantInventory, type GrantSource } from '../../src/server/rollover/grants.js';
import { HOLDER_ATTENTION, MEMBER_STALE_DAYS } from '../../src/shared/rollover.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, setup } from '../discord-auth/helpers.js';

// The people of the grant stocktaking under the Discord login, read from the real account service (in memory, with
// the fake Bot host): a member who left (retired), someone registering now (pending), someone not seen for a long
// time (stale), and the roster with and without its file. Synthetic Discord IDs, student IDs and names only.

const FOURTH = '1000000000000001004';
const DAY_MS = 86_400_000;

async function people(options: { roster: boolean }) {
  const ctx = setup();
  const names: Record<string, string> = { [CHAIR]: '合成 委員長', [MEMBER]: '合成 退任者' };
  const chair = await register(ctx, CHAIR, '21000001');
  const member = await register(ctx, MEMBER, '21000002');
  const fourth = await register(ctx, FOURTH, '21000004');
  // Left the server: the next sign-in asks the Bot host, which retires the account.
  ctx.host.members.delete(MEMBER);
  await expect(ctx.service.login({ loginId: '21000002', password: PASSWORD })).rejects.toThrow();
  // Registering now: the code is out, the password not yet set.
  ctx.host.join(OTHER);
  const { initialLoginId: pending } = await ctx.service.issueRegistration(OTHER);
  // Not seen for a while; the chair signs in again on the day of the stocktaking.
  ctx.clock.now += (MEMBER_STALE_DAYS + 5) * DAY_MS;
  await ctx.service.login({ loginId: '21000001', password: PASSWORD });

  const api: DiscordPeopleApi = {
    listUsers: () => [],
    lookupUser: () => undefined,
    storedAccount: (id) => {
      const a = ctx.service.storedAccount(id);
      return a ? { ...a, name: options.roster ? (names[a.discordUserId] ?? null) : null } : null;
    },
    rosterConfigured: options.roster,
  };
  return { ctx, ids: { chair: chair.initialLoginId, member: member.initialLoginId, fourth: fourth.initialLoginId, pending }, gp: discordPeople(api) };
}

describe('people under the Discord login', () => {
  it('tells apart who left, who is registering, who has not been seen for long, and who is not on the roster', async () => {
    const { ctx, ids, gp } = await people({ roster: true });
    expect(ctx.service.storedAccount(ids.member)!.status).toBe('retired');
    expect(ctx.service.storedAccount(ids.pending)!.status).toBe('pending');

    expect(gp.standing(ids.chair)).toMatchObject({ status: 'active', name: '合成 委員長', detail: null });
    // Retired accounts keep their roster name, so the administrator can see who it is.
    expect(gp.standing(ids.member)).toMatchObject({ status: 'left', name: '合成 退任者' });
    expect(gp.standing(ids.member).detail).toContain('最後に Discord の在籍を確かめたのは');
    // Registering now: not one to look at, and not shown like someone who left.
    expect(gp.standing(ids.pending).status).toBe('pending');
    expect(HOLDER_ATTENTION.pending).toBe(false);
    // Active but not confirmed for longer than the threshold: someone who may have left without signing in again.
    const stale = gp.standing(ids.fourth);
    expect(stale.status).toBe('stale');
    expect(stale.name).toBe('学籍番号 21000004');
    expect(stale.detail).toContain(`（${MEMBER_STALE_DAYS + 5} 日前）`);
    expect(stale.detail).toContain(`ログイン ID ${ids.fourth}`);
    expect(gp.standing('iy-99999999')).toMatchObject({ status: 'no_account', name: null });
    expect(gp.notes().join('\n')).toContain(`${MEMBER_STALE_DAYS} 日`);

    // The grants of each, in the stocktaking.
    const source: GrantSource = {
      label: '合成の権限',
      entries: () =>
        [ids.chair, ids.member, ids.pending, ids.fourth].map((id) => ({ key: `x|edit|p:${id}|t`, holder: { kind: 'person' as const, id }, sourceLabel: '合成の権限', target: '合成', permission: '編集', revoke: () => undefined, reason: null })),
    };
    const inventory = grantInventory([source], gp, []);
    // The two to look at come first (by name among themselves); the one registering now is not among them.
    expect(inventory.counts.attention).toBe(2);
    expect(new Set(inventory.holders.slice(0, 2).map((h) => [h.id, h.status].join(' ')))).toEqual(new Set([`${ids.member} left`, `${ids.fourth} stale`]));
    expect(new Set(inventory.holders.slice(2).map((h) => [h.id, h.status, h.attention].join(' ')))).toEqual(new Set([`${ids.chair} active false`, `${ids.pending} pending false`]));
  });

  it('marks nobody as off the roster when no roster file is set, and says so once', async () => {
    const { ids, gp } = await people({ roster: false });
    // Without the file nobody has a roster name: the chair is in, named by the student ID.
    expect(gp.standing(ids.chair)).toMatchObject({ status: 'active', name: '学籍番号 21000001' });
    expect(gp.notes().join('\n')).toContain('委員の名簿のファイルが設定されていない');
  });

  it('says "off the roster" only for a member the roster file does not name', async () => {
    const { ctx, gp } = await people({ roster: true });
    const extra = '1000000000000001005';
    const { initialLoginId } = await register(ctx, extra, '21000005');
    expect(gp.standing(initialLoginId)).toMatchObject({ status: 'unknown', name: '学籍番号 21000005' });
    expect(gp.notes().join('\n')).not.toContain('名簿のファイルが設定されていない');
  });
});
