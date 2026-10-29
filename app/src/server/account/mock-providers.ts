import { EFFECTIVE_MEMBERSHIP_KIND, type DeliveryAck, type DirectoryEvent, type IdentityLink, type LoginCodeEnvelope, type MembershipObservation, type MembershipProvenance } from '../login/types.js';

// MOCK composition providers (SMM_AUTH_MODE=account-mock, loopback only). Synthetic links,
// effective-membership evidence and a mock DM transport whose outbox the loopback demo can read.
// Never constructed by the production composition; nothing here talks to a real directory or Discord.

export const MOCK_GROUP_ID = 'group-everyone-synthetic';
export const MOCK_ORGANIZATION_ID = 'org-synthetic';

type MembershipState = 'member' | 'removed' | 'unresolved';

interface SyntheticPerson {
  principalId: string;
  label: string;
  email: string;
  provenance: MembershipProvenance;
  link: IdentityLink;
  membership: MembershipState;
  active: boolean;
  dm: 'open' | 'closed';
}

/** Synthetic people for the fixture users (reserved .invalid addresses and made-up Discord IDs). */
const SEED: { principalId: string; label: string; email: string; provenance: MembershipProvenance }[] = [
  { principalId: 'u-editor-a', label: '編集担当A', email: 'editor-a@staff.invalid', provenance: 'direct' },
  { principalId: 'u-viewer-b', label: '閲覧担当B', email: 'viewer-b@staff.invalid', provenance: 'nested' },
  { principalId: 'u-editor-c', label: '編集担当C', email: 'editor-c@staff.invalid', provenance: 'organization' },
  { principalId: 'u-noaccess-d', label: '権限なしD', email: 'noaccess-d@staff.invalid', provenance: 'nested' },
  { principalId: 'u-admin', label: 'デモ管理者', email: 'admin@staff.invalid', provenance: 'direct' },
];

export interface MockDmMessage {
  at: string;
  recipientLabel: string;
  discordUserId: string;
  template: LoginCodeEnvelope['template'];
  verifiedEmail: string | null;
  code: string;
  expiresAt: string;
}

export type MockDirectoryAction = 'remove_membership' | 'restore_membership' | 'unresolve_membership' | 'disable' | 'enable' | 'replace_binding' | 'dm_closed' | 'dm_open';

export class MockAccountProviders {
  private readonly people = new Map<string, SyntheticPerson>();
  private readonly outbox: MockDmMessage[] = [];
  private revision = 1;

  constructor(private readonly now: () => number = Date.now) {
    SEED.forEach((p, index) => {
      this.people.set(p.principalId, {
        ...p,
        link: {
          linkId: `link-${p.principalId}`,
          version: 1,
          status: 'active',
          email: p.email,
          emailVerified: true,
          discordUserId: `20000000000000000${String(index + 1).padStart(2, '0')}`,
          memberKey: `mk-${p.principalId}`,
          principalId: p.principalId,
          evidence: 'verified_roster',
        },
        membership: 'member',
        active: true,
        dm: 'open',
      });
    });
  }

  private byLink(linkId: string): SyntheticPerson | undefined {
    return [...this.people.values()].find((p) => p.link.linkId === linkId);
  }

  readonly links = {
    findByVerifiedEmail: async (email: string): Promise<IdentityLink | null> => {
      const person = [...this.people.values()].find((p) => p.email === email);
      return person ? { ...person.link } : null;
    },
    getLink: async (linkId: string): Promise<IdentityLink | null> => {
      const person = this.byLink(linkId);
      return person ? { ...person.link } : null;
    },
  };

  readonly principals = {
    getPrincipal: async (principalId: string) => {
      const person = this.people.get(principalId);
      return person ? { principalId, active: person.active } : null;
    },
  };

  readonly membership = {
    lookup: async (groupId: string, memberKey: string): Promise<MembershipObservation> => {
      const person = [...this.people.values()].find((p) => p.link.memberKey === memberKey);
      const member = !!person && person.membership === 'member';
      const provenance = member ? [person.provenance] : [];
      return {
        kind: EFFECTIVE_MEMBERSHIP_KIND,
        groupId,
        groupRevision: `synthetic-rev-${this.revision}`,
        memberKey,
        subjectType: 'user',
        subjectState: 'active',
        resolution: person?.membership === 'unresolved' ? 'incomplete' : 'complete',
        effectiveMember: person?.membership === 'unresolved' ? 'unknown' : member,
        provenance,
        organizationId: member && person.provenance === 'organization' ? MOCK_ORGANIZATION_ID : null,
        observedAt: this.now(),
      };
    },
  };

  /** Mock DM transport: acknowledges delivery only to the exact linked Discord ID of an open DM. */
  readonly deliver = async (envelope: LoginCodeEnvelope): Promise<DeliveryAck> => {
    const person = this.byLink(envelope.recipient.linkId);
    if (!person || person.link.discordUserId !== envelope.recipient.discordUserId || person.link.version !== envelope.recipient.linkVersion) {
      return { deliveryId: envelope.deliveryId, status: 'failed', reason: 'recipient_mismatch' };
    }
    if (person.dm === 'closed') return { deliveryId: envelope.deliveryId, status: 'failed', reason: 'dm_closed' };
    this.outbox.push({
      at: new Date(this.now()).toISOString(),
      recipientLabel: person.label,
      discordUserId: person.link.discordUserId,
      template: envelope.template,
      verifiedEmail: envelope.context.verifiedEmail ?? null,
      code: envelope.code,
      expiresAt: envelope.expiresAt,
    });
    if (this.outbox.length > 50) this.outbox.splice(0, this.outbox.length - 50);
    return { deliveryId: envelope.deliveryId, status: 'delivered' };
  };

  /** Newest first. MOCK ONLY: exposes codes to the loopback demo/test, never in production. */
  dmOutbox(): MockDmMessage[] {
    return [...this.outbox].reverse();
  }

  directory(): { principalId: string; label: string; email: string; discordUserId: string; provenance: MembershipProvenance; membership: MembershipState; active: boolean; dm: 'open' | 'closed' }[] {
    return [...this.people.values()].map((p) => ({
      principalId: p.principalId,
      label: p.label,
      email: p.email,
      discordUserId: p.link.discordUserId,
      provenance: p.provenance,
      membership: p.membership,
      active: p.active,
      dm: p.dm,
    }));
  }

  /** Applies a synthetic directory change and returns the event the login core must process. */
  apply(principalId: string, action: MockDirectoryAction): DirectoryEvent | null {
    const person = this.people.get(principalId);
    if (!person) return null;
    this.revision += 1;
    switch (action) {
      case 'remove_membership':
        person.membership = 'removed';
        return { type: 'membership_removed', memberKey: person.link.memberKey };
      case 'unresolve_membership':
        person.membership = 'unresolved';
        return null;
      case 'restore_membership':
        person.membership = 'member';
        return null;
      case 'disable':
        person.active = false;
        return { type: 'principal_disabled', principalId };
      case 'enable':
        person.active = true;
        return null;
      case 'replace_binding':
        // A verified replacement of the Discord account: new version, new ID.
        person.link = { ...person.link, version: person.link.version + 1, discordUserId: `21${person.link.discordUserId.slice(2, -2)}${String(person.link.version + 10).padStart(2, '0')}` };
        return { type: 'link_changed', linkId: person.link.linkId };
      case 'dm_closed':
        person.dm = 'closed';
        return null;
      case 'dm_open':
        person.dm = 'open';
        return null;
    }
  }
}
