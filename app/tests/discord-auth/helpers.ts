import { randomBytes } from 'node:crypto';
import { LoginAudit } from '../../src/server/discord-auth/audit.js';
import type { DiscordAuthConfig } from '../../src/server/discord-auth/config.js';
import { DiscordAccountService, type MemberObservation, type RegistrationEnvelope } from '../../src/server/discord-auth/service.js';
import { AccountStore } from '../../src/server/discord-auth/store.js';
import { LOW_COST_TEST_ONLY, PasswordHasher } from '../../src/server/login/password.js';

// Synthetic Discord IDs only (no real guild, person or role).
export const GUILD = '1000000000000000001';
export const CHAIR = '1000000000000001001';
export const MEMBER = '1000000000000001002';
export const OTHER = '1000000000000001003';
export const SHARED_PC = '1000000000000001999';
export const ROLE_GENERAL_AFFAIRS = '1000000000000002001';
export const ROLE_PLANNING = '1000000000000002002';
export const PASSWORD = '合成テスト用のパスワード-0001';

export function testConfig(changes: Partial<DiscordAuthConfig> = {}): DiscordAuthConfig {
  return {
    guildId: GUILD,
    bootstrapDiscordUserId: CHAIR,
    excludedSharedDiscordUserIds: [SHARED_PC],
    adminDiscordUserIds: [],
    adminRoleIds: [ROLE_GENERAL_AFFAIRS],
    departmentRoleIds: { [ROLE_GENERAL_AFFAIRS]: '総務部', [ROLE_PLANNING]: '企画部' },
    registrationAudience: 'https://task.example.invalid',
    memberUrl: 'https://bot-host.example.invalid/v1/discord/member',
    registrationDmUrl: 'https://bot-host.example.invalid/v1/dm/registration-code',
    stateFile: '',
    pepper: randomBytes(32),
    bridgeKey: randomBytes(32),
    namesFile: null,
    studentIdsFile: null,
    sessionDays: 14,
    memberGraceHours: 48,
    memberCacheMinutes: 10,
    bulkRegistrationUntil: null,
    ...changes,
  };
}

/** Test double of the Bot host's member lookup and DM delivery. */
export class FakeBotHost {
  members = new Map<string, { active: boolean; human: boolean; roleIds: string[]; joinEpochMs: number }>();
  down = false;
  memberCalls = 0;
  delivered: RegistrationEnvelope[] = [];

  constructor(private readonly clock: () => number) {}

  join(uid: string, roleIds: string[] = [], joinEpochMs = 1_700_000_000_000): void {
    this.members.set(uid, { active: true, human: true, roleIds, joinEpochMs });
  }

  member = async (uid: string): Promise<MemberObservation> => {
    this.memberCalls += 1;
    if (this.down) throw new Error('unreachable');
    const m = this.members.get(uid);
    const now = this.clock();
    return m && m.active
      ? { kind: 'discord_member/v1', guildId: GUILD, discordUserId: uid, linkId: `dcg:${GUILD}:${uid}`, joinEpochMs: m.joinEpochMs, current: true, bot: !m.human, roleIds: m.roleIds, observedAtMs: now, taskUserId: null }
      : { kind: 'discord_member/v1', guildId: GUILD, discordUserId: uid, linkId: null, joinEpochMs: null, current: false, bot: false, roleIds: [], observedAtMs: now, taskUserId: null };
  };

  deliver = async (envelope: RegistrationEnvelope) => {
    if (this.down) throw new Error('unreachable');
    this.delivered.push(envelope);
    return { deliveryId: envelope.deliveryId, status: 'delivered' as const };
  };

  lastCode(): string {
    return this.delivered.at(-1)!.code;
  }
}

export function setup(options: { config?: Partial<DiscordAuthConfig>; store?: AccountStore; hasher?: PasswordHasher; roster?: Record<string, string> } = {}) {
  const clock = { now: 1_760_000_000_000 };
  const host = new FakeBotHost(() => clock.now);
  const config = testConfig(options.config);
  const store = options.store ?? AccountStore.memory();
  const audit = new LoginAudit(null);
  const service = new DiscordAccountService({
    config,
    store,
    member: host.member,
    deliver: host.deliver,
    hasher: options.hasher ?? new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY }),
    now: () => clock.now,
    rosterStudentId: (uid) => options.roster?.[uid] ?? null,
    audit,
  });
  return { clock, host, config, store, service, audit };
}

/** Registers `uid` end to end and returns the session token of the first sign-in. */
export async function register(ctx: ReturnType<typeof setup>, uid: string, studentId: string, roles: string[] = []) {
  ctx.host.join(uid, roles);
  const { initialLoginId } = await ctx.service.issueRegistration(uid);
  await ctx.service.completeRegistration({ initialLoginId, code: ctx.host.lastCode(), password: PASSWORD, studentId });
  const { sessionToken } = await ctx.service.login({ loginId: studentId, password: PASSWORD });
  return { initialLoginId, sessionToken };
}
