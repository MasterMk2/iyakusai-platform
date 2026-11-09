import { describe, expect, it } from 'vitest';
import { AccessManagerError } from '../../src/server/discord-auth/service.js';
import { AccountStore, emptyAccountState, validateAccountState } from '../../src/server/discord-auth/store.js';
import { CHAIR, MEMBER, OTHER, register, ROLE_GENERAL_AFFAIRS, setup } from './helpers.js';

// Masters and setters (2026-11-06): only masters choose setters and masters; the chair is the first master.

const roleOf = (ctx: ReturnType<typeof setup>, loginId: string) => ctx.service.accessManagers().people.find((p) => p.initialLoginId === loginId)?.role;
const refused = (fn: () => void, code: AccessManagerError['code']) => expect(fn).toThrow(expect.objectContaining({ code }));

describe('masters and setters', () => {
  it('start with the chair as the only master; a department role of the configuration still makes a setter', async () => {
    const ctx = setup();
    const chair = await register(ctx, CHAIR, '21000001');
    const member = await register(ctx, MEMBER, '21000002');
    const other = await register(ctx, OTHER, '21000003', [ROLE_GENERAL_AFFAIRS]);
    expect((await ctx.service.authenticate(chair.sessionToken)).admin).toBe(true);
    expect((await ctx.service.authenticate(member.sessionToken)).admin).toBe(false);
    expect((await ctx.service.authenticate(other.sessionToken)).admin).toBe(true);
    expect(ctx.service.isMasterAccount(CHAIR)).toBe(true);
    expect(ctx.service.isMasterAccount(OTHER)).toBe(false);
    const overview = ctx.service.accessManagers();
    expect(overview.version).toBe(0);
    expect(overview.people.map((p) => [p.initialLoginId, p.role, p.byConfig])).toEqual(
      expect.arrayContaining([
        [chair.initialLoginId, 'master', false],
        [member.initialLoginId, 'none', false],
        [other.initialLoginId, 'none', true],
      ]),
    );
    expect(ctx.store.read((s) => s.accessManagers)).toBeUndefined();
  });

  it('let a master choose setters and masters, who take effect at once', async () => {
    const ctx = setup({ config: { adminRoleIds: [] } });
    const chair = await register(ctx, CHAIR, '21000001');
    const member = await register(ctx, MEMBER, '21000002');
    const other = await register(ctx, OTHER, '21000003');
    ctx.service.setAccessManager(CHAIR, { initialLoginId: other.initialLoginId, role: 'setter', expectedVersion: 0 });
    expect((await ctx.service.authenticate(other.sessionToken)).admin).toBe(true);
    // A setter manages grants but not who manages them.
    refused(() => ctx.service.setAccessManager(OTHER, { initialLoginId: member.initialLoginId, role: 'setter', expectedVersion: 1 }), 'forbidden');
    ctx.service.setAccessManager(CHAIR, { initialLoginId: member.initialLoginId, role: 'master', expectedVersion: 1 });
    expect(ctx.service.isMasterAccount(MEMBER)).toBe(true);
    // Masters set each other: the new master may remove the chair, who then manages nothing.
    ctx.service.setAccessManager(MEMBER, { initialLoginId: chair.initialLoginId, role: 'none', expectedVersion: 2 });
    expect((await ctx.service.authenticate(chair.sessionToken)).admin).toBe(false);
    refused(() => ctx.service.setAccessManager(CHAIR, { initialLoginId: chair.initialLoginId, role: 'master', expectedVersion: 3 }), 'forbidden');
    ctx.service.setAccessManager(MEMBER, { initialLoginId: other.initialLoginId, role: 'none', expectedVersion: 3 });
    expect((await ctx.service.authenticate(other.sessionToken)).admin).toBe(false);
    const overview = ctx.service.accessManagers();
    expect(overview.version).toBe(4);
    expect(overview.history.map((h) => [h.actor, h.target, h.before, h.after])).toEqual([
      [MEMBER, OTHER, 'setter', 'none'],
      [MEMBER, CHAIR, 'master', 'none'],
      [CHAIR, MEMBER, 'none', 'master'],
      [CHAIR, OTHER, 'none', 'setter'],
    ]);
  });

  it('refuse removing the last master, a stale list, and accounts that cannot sign in', async () => {
    const ctx = setup();
    const chair = await register(ctx, CHAIR, '21000001');
    refused(() => ctx.service.setAccessManager(CHAIR, { initialLoginId: chair.initialLoginId, role: 'setter', expectedVersion: 0 }), 'last_master');
    const member = await register(ctx, MEMBER, '21000002');
    ctx.service.setAccessManager(CHAIR, { initialLoginId: member.initialLoginId, role: 'setter', expectedVersion: 0 });
    refused(() => ctx.service.setAccessManager(CHAIR, { initialLoginId: member.initialLoginId, role: 'none', expectedVersion: 0 }), 'conflict');
    ctx.host.join(OTHER);
    const pending = await ctx.service.issueRegistration(OTHER);
    refused(() => ctx.service.setAccessManager(CHAIR, { initialLoginId: pending.initialLoginId, role: 'setter', expectedVersion: 1 }), 'inactive');
    refused(() => ctx.service.setAccessManager(CHAIR, { initialLoginId: 'iy-09999999', role: 'setter', expectedVersion: 1 }), 'not_found');
    expect(roleOf(ctx, member.initialLoginId)).toBe('setter');
    expect(roleOf(ctx, chair.initialLoginId)).toBe('master');
  });

  it('are stored with the accounts and checked when read', () => {
    const base = emptyAccountState();
    const valid = { ...base, accessManagers: { version: 1, masters: [CHAIR], setters: [MEMBER], history: [{ at: 1, actor: CHAIR, target: MEMBER, before: 'none' as const, after: 'setter' as const }] } };
    expect(() => validateAccountState(valid)).not.toThrow();
    expect(() => AccountStore.memory(valid)).not.toThrow();
    expect(() => validateAccountState({ ...base, accessManagers: { ...valid.accessManagers, masters: [] } })).toThrow();
    expect(() => validateAccountState({ ...base, accessManagers: { ...valid.accessManagers, setters: [CHAIR] } })).toThrow();
    expect(() => validateAccountState({ ...base, accessManagers: { ...valid.accessManagers, masters: ['chair'] } })).toThrow();
  });
});
