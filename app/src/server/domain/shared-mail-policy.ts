import { DomainError, type AppState, type CommitteeSharedMailTarget, type Mailbox, type Receipt, type User } from './types.js';

// Proofs belong to one HTTP request and never enter JSON state, cookies, or API input.
// The account boundary creates one ONLY after LoginService.authenticate() has
// rechecked the current group, active principal, link, and credential version.
const currentReaders = new WeakMap<User, number>();
const REQUEST_PROOF_MS = 5_000;

export function verifiedCommitteeReader(user: User): User {
  const reader = { ...user };
  currentReaders.set(reader, Date.now());
  return reader;
}

export function isVerifiedCommitteeReader(state: AppState, user: User): boolean {
  const checkedAt = currentReaders.get(user);
  const current = state.users.find((u) => u.id === user.id);
  const age = checkedAt === undefined ? Infinity : Date.now() - checkedAt;
  return !!current && !current.disabled && !user.disabled && age >= 0 && age <= REQUEST_PROOF_MS;
}

export function requireVerifiedCommitteeReader(state: AppState, user: User): void {
  if (!isVerifiedCommitteeReader(state, user)) {
    throw new DomainError('forbidden', '現役委員であることを確認できません。');
  }
}

function canonicalAddress(value: string): boolean {
  return typeof value === 'string' && value.length <= 320 && value === value.trim().toLowerCase() && /^[^\s@<>]+@[^\s@<>]+$/.test(value);
}

function validTarget(value: unknown): value is CommitteeSharedMailTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  return Object.keys(t).length === 4 && ['mailboxId', 'address', 'sourceKey', 'connectorId'].every((key) => typeof t[key] === 'string' && (t[key] as string).length > 0) && canonicalAddress(t.address as string);
}

/** No domain, To/Cc, role, department, alias, or old ACL can create a target. */
export function approvedSharedMailTarget(state: AppState, mailbox: Mailbox, connectorId?: string): CommitteeSharedMailTarget | null {
  const policy = state.committeeSharedMailReadPolicy;
  if (!policy || policy.version !== 1 || !['operator-approved', 'synthetic-fixture'].includes(policy.mode) || !Array.isArray(policy.targets) || !policy.targets.every(validTarget)) return null;
  if (mailbox.scope !== 'committee-shared' || !canonicalAddress(mailbox.address) || typeof mailbox.sourceKey !== 'string' || !mailbox.sourceKey) return null;
  const current = state.mailboxes.filter((m) => m.id === mailbox.id);
  if (current.length !== 1 || current[0]!.scope !== 'committee-shared' || current[0]!.address !== mailbox.address || current[0]!.sourceKey !== mailbox.sourceKey) return null;
  const targets = policy.targets.filter((t) => t.mailboxId === mailbox.id);
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  if (target.address !== mailbox.address || target.sourceKey !== mailbox.sourceKey || !target.connectorId || (connectorId !== undefined && connectorId !== target.connectorId)) return null;
  // Connector bindings and target addresses must also be unique. No ambiguous acquisition.
  if (policy.targets.filter((t) => t.address === target.address).length !== 1 ||
      policy.targets.filter((t) => t.sourceKey === target.sourceKey && t.connectorId === target.connectorId).length !== 1) return null;
  if (policy.mode === 'synthetic-fixture' && (!/@[^@]+\.(?:example|invalid)$/.test(target.address) || !target.sourceKey.startsWith('mock-src-') || target.connectorId !== 'mock-inbound')) return null;
  return target;
}

/** Receipt delivery evidence must name the approved source, not merely a visible recipient. */
export function isApprovedSharedReceipt(state: AppState, receipt: Receipt): boolean {
  const delivery = receipt.delivery;
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery) || typeof delivery.connectorId !== 'string' || !delivery.connectorId || typeof delivery.sourceMailboxKey !== 'string' || !delivery.sourceMailboxKey || typeof delivery.deliveredTo !== 'string') return false;
  const mailbox = state.mailboxes.find((m) => m.id === receipt.mailboxId);
  if (!mailbox) return false;
  const target = approvedSharedMailTarget(state, mailbox, delivery.connectorId);
  return !!target && delivery.sourceMailboxKey === target.sourceKey && delivery.deliveredTo === target.address;
}

/** Demo-only member selection cannot authenticate a person or read an actual mailbox. */
export function syntheticCommitteeReader(state: AppState, user: User): User {
  const policy = state.committeeSharedMailReadPolicy;
  if (policy?.mode !== 'synthetic-fixture' || !Array.isArray(policy.syntheticCurrentMemberIds) || !policy.syntheticCurrentMemberIds.includes(user.id) ||
      state.mailboxes.length === 0 || state.mailboxes.some((m) => !approvedSharedMailTarget(state, m))) return user;
  return verifiedCommitteeReader(user);
}
