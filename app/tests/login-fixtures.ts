import { SAMPLE_USERS } from '../src/server/connector/fixtures.js';
import { LoginService, type LoginServiceOptions } from '../src/server/login/service.js';
import {
  EFFECTIVE_MEMBERSHIP_KIND,
  REFERENCE_STORE_ACK,
  type DeliveryAck,
  type IdentityLink,
  type LoginAuditEvent,
  type LoginCodeEnvelope,
  type LoginPolicy,
  type MembershipObservation,
  type MembershipProvenance,
  type MembershipResolution,
  type SubjectState,
  type SubjectType,
} from '../src/server/login/types.js';
import { ADMIN, EDITOR_A, EDITOR_C, NOACCESS_D, T0, VIEWER_B } from './helpers.js';

// Synthetic login fixtures: reserved .invalid addresses, mock group/member/link
// IDs and obviously fake Discord snowflakes. The pepper is a throwaway test value.

export const LOGIN_GROUP = 'grp-mock-0001';
export const TEST_PEPPER = Buffer.from('test-only-pepper/not-for-production/0123456789', 'utf8');
export const LOGIN_ORIGIN = 'https://login.example.invalid';
export const LOGIN_HOST = 'login.example.invalid';

export interface Persona {
  email: string;
  discordUserId: string;
  memberKey: string;
  principalId: string;
  linkId: string;
}

const persona = (name: string, principalId: string, n: number): Persona => ({
  email: `${name}@staff.invalid`,
  discordUserId: `10000000000000000${n}`,
  memberKey: `mem-${name}`,
  principalId,
  linkId: `lk-${name}`,
});

export const P = {
  editorA: persona('editor-a', EDITOR_A, 1),
  viewerB: persona('viewer-b', VIEWER_B, 2),
  admin: persona('admin', ADMIN, 3),
  noAccessD: persona('noaccess-d', NOACCESS_D, 4),
  /** Known member from outside the organization's domain (no domain restriction applies). */
  externalC: { ...persona('guest-c', EDITOR_C, 5), email: 'guest-c@partner.example' },
};

export class FakeClock {
  t = Date.parse(T0);
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Mutable synthetic directory: links, principals and group membership. */
export class FakeDirectory {
  readonly links = new Map<string, IdentityLink>();
  readonly principals = new Map<string, boolean>(SAMPLE_USERS.map((u) => [u.id, !u.disabled]));
  readonly members = new Map<string, Partial<MembershipObservation>>();
  /** Throws from every provider call when set. */
  failing = false;
  /** Delay (real ms) added to membership lookups. */
  membershipDelayMs = 0;
  lookups = 0;

  constructor(private readonly clock: FakeClock) {
    for (const p of [P.editorA, P.viewerB, P.admin]) {
      this.enrol(p);
      this.members.set(p.memberKey, {});
    }
  }

  /** Adds an operator-attested, verified link for the persona (membership is decided separately). */
  enrol(p: Persona): void {
    this.links.set(p.linkId, {
      linkId: p.linkId,
      version: 1,
      status: 'active',
      email: p.email,
      emailVerified: true,
      discordUserId: p.discordUserId,
      memberKey: p.memberKey,
      principalId: p.principalId,
      evidence: 'operator_attestation',
    });
  }

  updateLink(linkId: string, patch: Partial<IdentityLink>): void {
    const link = this.links.get(linkId)!;
    this.links.set(linkId, { ...link, ...patch, version: link.version + 1 });
  }

  readonly linkDirectory = {
    findByVerifiedEmail: async (email: string) => {
      if (this.failing) throw new Error('synthetic directory failure');
      return [...this.links.values()].find((l) => l.email === email) ?? null;
    },
    getLink: async (linkId: string) => {
      if (this.failing) throw new Error('synthetic directory failure');
      return this.links.get(linkId) ?? null;
    },
  };

  readonly principalDirectory = {
    getPrincipal: async (principalId: string) => {
      if (this.failing) throw new Error('synthetic principal failure');
      const active = this.principals.get(principalId);
      return active === undefined ? null : { principalId, active };
    },
  };

  readonly membership = {
    lookup: async (groupId: string, memberKey: string): Promise<MembershipObservation> => {
      this.lookups += 1;
      if (this.membershipDelayMs > 0) await new Promise((r) => setTimeout(r, this.membershipDelayMs));
      if (this.failing) throw new Error('synthetic membership failure');
      const override = this.members.get(memberKey);
      // Default: a complete answer; listed keys are direct active users, everyone else an authoritative nonmember.
      const base: MembershipObservation = {
        kind: EFFECTIVE_MEMBERSHIP_KIND,
        groupId,
        groupRevision: 'rev-mock-1',
        memberKey,
        subjectType: 'user',
        subjectState: 'active',
        resolution: 'complete',
        effectiveMember: override !== undefined,
        provenance: override ? ['direct'] : [],
        organizationId: null,
        observedAt: this.clock.now(),
      };
      return { ...base, ...override };
    },
  };
}

/** Synthetic organization whose managed all-users entry may be a member of a group. */
export const LOGIN_ORG = 'org-mock-0001';
/** Member entry that stands for "all users of this organization". */
export const allUsersOf = (organizationId: string): string => `customer:${organizationId}`;

interface GraphUser {
  state: SubjectState;
  organizationId: string | null;
}
interface GraphGroup {
  members: string[];
  /** Children the provider is not allowed to list. */
  hidden?: boolean;
  /** Only a partial page of members was returned. */
  truncated?: boolean;
}

/**
 * Synthetic effective-membership provider over an in-memory graph of invented groups, users and
 * all-users entries. It stands in for an approved directory adapter; it is not a Google API model.
 * A found path is decisive; otherwise hidden, truncated, too deep or cyclic graphs are not decisive.
 */
export class SyntheticGroupGraph {
  readonly users = new Map<string, GraphUser>();
  readonly groups = new Map<string, GraphGroup>();
  maxDepth = 4;
  forbidden = false;
  revision = 1;

  constructor(private readonly clock: FakeClock) {}

  user(memberKey: string, organizationId: string | null = LOGIN_ORG, state: SubjectState = 'active'): this {
    this.users.set(memberKey, { state, organizationId });
    return this;
  }

  group(groupId: string, members: string[], flags: Omit<GraphGroup, 'members'> = {}): this {
    this.groups.set(groupId, { members: [...members], ...flags });
    this.revision += 1;
    return this;
  }

  readonly lookup = async (groupId: string, memberKey: string): Promise<MembershipObservation> => {
    const base = { kind: EFFECTIVE_MEMBERSHIP_KIND, groupId, groupRevision: `rev-graph-${this.revision}`, memberKey, observedAt: this.clock.now(), organizationId: null };
    if (this.forbidden) return { ...base, subjectType: 'user', subjectState: 'unknown', resolution: 'forbidden', effectiveMember: 'unknown', provenance: [] };
    const user = this.users.get(memberKey);
    const subjectType: SubjectType = user ? 'user' : memberKey.startsWith('customer:') ? 'customer' : 'group';
    const provenance = new Set<MembershipProvenance>();
    let resolution: MembershipResolution = 'complete';
    const seen = new Set<string>([groupId]);
    let frontier = [groupId];
    for (let depth = 0; frontier.length > 0; depth += 1) {
      if (depth > this.maxDepth) {
        resolution = 'limit_exceeded';
        break;
      }
      const next: string[] = [];
      for (const id of frontier) {
        const g = this.groups.get(id);
        if (!g || g.hidden || g.truncated) resolution = 'incomplete';
        for (const entry of g && !g.hidden ? g.members : []) {
          if (entry === memberKey) provenance.add(depth === 0 ? 'direct' : 'nested');
          else if (user?.organizationId && entry === allUsersOf(user.organizationId)) provenance.add('organization');
          else if (this.groups.has(entry) || entry.startsWith('grp-')) {
            if (seen.has(entry)) resolution = resolution === 'complete' ? 'cycle' : resolution;
            else {
              seen.add(entry);
              next.push(entry);
            }
          }
        }
      }
      frontier = next;
    }
    const found = provenance.size > 0;
    return {
      ...base,
      subjectType,
      subjectState: user?.state ?? 'unknown',
      // A found path is a decisive positive; a negative is decisive only when nothing was left unresolved.
      resolution: found ? 'complete' : resolution,
      effectiveMember: found ? true : resolution === 'complete' ? false : 'unknown',
      provenance: [...provenance],
      organizationId: provenance.has('organization') ? (user?.organizationId ?? null) : null,
    };
  };
}

export type DeliveryBehaviour = (envelope: LoginCodeEnvelope) => Promise<DeliveryAck>;
export const delivered: DeliveryBehaviour = async (e) => ({ deliveryId: e.deliveryId, status: 'delivered' });

export interface LoginFixture {
  service: LoginService;
  clock: FakeClock;
  dir: FakeDirectory;
  /** Synthetic delivery sink: captured envelopes. This is not a Discord integration. */
  sent: LoginCodeEnvelope[];
  audit: LoginAuditEvent[];
  setDelivery: (behaviour: DeliveryBehaviour) => void;
  options: LoginServiceOptions;
}

export function makeLogin(policy: Partial<LoginPolicy> = {}, overrides: Partial<LoginServiceOptions> = {}, shared?: { clock: FakeClock; dir: FakeDirectory }): LoginFixture {
  const clock = shared?.clock ?? new FakeClock();
  const dir = shared?.dir ?? new FakeDirectory(clock);
  const sent: LoginCodeEnvelope[] = [];
  const audit: LoginAuditEvent[] = [];
  let behaviour: DeliveryBehaviour = delivered;
  const options: LoginServiceOptions = {
    groupId: LOGIN_GROUP,
    organizationId: LOGIN_ORG,
    acceptedLinkEvidence: ['operator_attestation'],
    pepper: TEST_PEPPER,
    serviceLabel: 'shared-mail-manager test',
    membership: dir.membership,
    links: dir.linkDirectory,
    principals: dir.principalDirectory,
    deliver: async (envelope) => {
      sent.push(structuredClone(envelope));
      return behaviour(envelope);
    },
    audit: (event) => audit.push(event),
    stateStore: REFERENCE_STORE_ACK,
    now: clock.now,
    policy,
    ...overrides,
  };
  return { service: new LoginService(options), clock, dir, sent, audit, setDelivery: (b) => (behaviour = b), options };
}

export const CLIENT = 'socket:192.0.2.10';

/** Requests a challenge, drains the dispatch queue and returns the code captured for it (if any). */
export async function startLogin(f: LoginFixture, email: string, clientKey = CLIENT): Promise<{ challengeId: string; browserSecret: string; code: string | null }> {
  const before = f.sent.length;
  const outcome = f.service.requestChallenge({ email, clientKey });
  if (!outcome.ok) throw new Error(`unexpected ${outcome.error}`);
  await f.service.idle();
  const envelope = f.sent.slice(before).at(-1);
  return { challengeId: outcome.challengeId, browserSecret: outcome.browserSecret, code: envelope?.code ?? null };
}
