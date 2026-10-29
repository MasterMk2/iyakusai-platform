// Group-membership + existing-Bot DM login core. Every provider is injected. The
// account composition (SMM_AUTH_MODE=account / account-mock) wires it: a DM code proves
// the verified binding once, the person sets their own password, and later logins use
// email + password. Live providers (directory, binding store, Bot DM) are operator-provided.

/** Required acknowledgement that the in-memory store is a single-process test reference. */
export const REFERENCE_STORE_ACK = 'single-process-preparation-test-only' as const;

// ---- authoritative EFFECTIVE group membership (read-only)

/** Contract tag. Any other shape (e.g. a plain direct-membership boolean) is unsupported evidence and denies. */
export const EFFECTIVE_MEMBERSHIP_KIND = 'effective_membership/v1' as const;

/** Account status of the subject itself. Only `active` is eligible. */
export type SubjectState = 'active' | 'invited' | 'suspended' | 'archived' | 'deleted' | 'unknown';
/** Kind of the subject. Group and customer (all-users) records are containers, never identities. */
export type SubjectType = 'user' | 'group' | 'customer';
/** How the subject reaches the configured group. Informational: any one of them qualifies, none grants privileges. */
export type MembershipProvenance = 'direct' | 'nested' | 'organization';
export const MEMBERSHIP_PROVENANCE: readonly MembershipProvenance[] = ['direct', 'nested', 'organization'];
/**
 * Whether the provider resolved the whole effective membership for this group and subject.
 * Only `complete` is decisive; hidden children, partial pagination, traversal limits or cycles
 * without a decisive answer are `incomplete` / `limit_exceeded` / `cycle`.
 */
export type MembershipResolution = 'complete' | 'incomplete' | 'limit_exceeded' | 'cycle' | 'forbidden' | 'unavailable';

/** One authoritative, transitive observation of a single subject in a single group. */
export interface MembershipObservation {
  kind: typeof EFFECTIVE_MEMBERSHIP_KIND;
  /** Stable group identifier (not an email address or display name). */
  groupId: string;
  /** Opaque, non-empty provider revision of the observed membership (recorded for diagnosis only). */
  groupRevision: string;
  /** Stable member key the lookup was made for. */
  memberKey: string;
  subjectType: SubjectType;
  subjectState: SubjectState;
  resolution: MembershipResolution;
  /** Effective (direct, nested or organization-wide) membership. `unknown` is never treated as membership. */
  effectiveMember: boolean | 'unknown';
  /** Non-empty and duplicate-free when `effectiveMember` is true. */
  provenance: readonly MembershipProvenance[];
  /**
   * Required with `organization` provenance and null otherwise: the organization the provider verified
   * this subject belongs to, whose all-users entry is a member of the group. Must equal the configured one.
   */
  organizationId: string | null;
  /** Epoch ms at which the provider observed this state. */
  observedAt: number;
}

/**
 * Answers effective membership for exactly (groupId, memberKey). An adapter over a direct-only API
 * must not report nested or organization membership it did not resolve. Throwing or timing out is a
 * provider failure and always denies.
 */
export interface GroupMembershipReader {
  lookup(groupId: string, memberKey: string): Promise<MembershipObservation>;
}

// ---- verified email <-> Discord account <-> internal principal

/** How an operator established the link. Which of these is acceptable is an unresolved production gate. */
export type LinkEvidence = 'verified_roster' | 'operator_attestation' | 'dual_control_proof';
export const LINK_EVIDENCE: readonly LinkEvidence[] = ['verified_roster', 'operator_attestation', 'dual_control_proof'];

/** Operator-controlled record; never created from a browser or DM request. */
export interface IdentityLink {
  linkId: string;
  /** Incremented on every change; a different version invalidates challenges and sessions. */
  version: number;
  status: 'active' | 'revoked';
  /** Normalized registered email. Exact match only: no alias, plus-address or domain inference. */
  email: string;
  emailVerified: boolean;
  /** Stable Discord user ID (snowflake). Never a user name or display name. */
  discordUserId: string;
  /** Stable member key used for the membership lookup. */
  memberKey: string;
  /** Existing internal principal (application user ID); authorization comes from it, not from the group. */
  principalId: string;
  evidence: LinkEvidence;
}

export interface IdentityLinkDirectory {
  findByVerifiedEmail(email: string): Promise<IdentityLink | null>;
  getLink(linkId: string): Promise<IdentityLink | null>;
}

export interface PrincipalDirectory {
  getPrincipal(principalId: string): Promise<{ principalId: string; active: boolean } | null>;
}

// ---- Bot delivery (injected callable; no transport or credentials here)

/**
 * What a code may be used for. `login` is the original code-only login; `password_setup`
 * proves the verified binding before the person sets (or resets) their own password.
 */
export type ChallengePurpose = 'login' | 'password_setup';

/** Minimal transient sensitive envelope. Contains the plain code: never store or log it. */
export interface LoginCodeEnvelope {
  kind: 'login_code';
  /** Idempotency key: the Bot must send at most one DM per deliveryId. */
  deliveryId: string;
  /** Fixed template; the Bot renders the text itself (no caller-supplied text). */
  template: 'login_code_v1' | 'password_setup_code_v1';
  /** Present for password setup only (the original login envelope keeps its minimal shape). */
  purpose?: ChallengePurpose;
  /** Service audience the code is bound to (the public origin); password setup only. */
  audience?: string;
  recipient: { discordUserId: string; linkId: string; linkVersion: number };
  code: string;
  expiresAt: string;
  /**
   * Generic context shown in the DM: service label and request time; for password setup also the
   * verified email of the binding (never the address typed into the form).
   */
  context: { serviceLabel: string; requestedAt: string; verifiedEmail?: string };
}

export type DeliveryFailure = 'dm_closed' | 'blocked' | 'rate_limited' | 'timeout' | 'recipient_mismatch' | 'unavailable';
export type DeliveryAck = { deliveryId: string; status: 'delivered' } | { deliveryId: string; status: 'failed'; reason: DeliveryFailure };
export type BotDelivery = (envelope: LoginCodeEnvelope) => Promise<DeliveryAck>;

// ---- audit (pseudonymous, bounded)

export type LoginAuditType =
  | 'challenge_requested'
  | 'resend_requested'
  | 'dispatch_dropped'
  | 'target_rate_limited'
  | 'eligibility_denied'
  | 'code_issued'
  | 'delivery_succeeded'
  | 'delivery_failed'
  | 'verify_failed'
  | 'login_succeeded'
  | 'session_denied'
  | 'session_revoked'
  | 'logout'
  | 'client_rate_limited'
  | 'capacity_denied'
  | 'setup_code_verified'
  | 'password_set'
  | 'password_reset'
  | 'password_login_succeeded'
  | 'password_login_failed'
  | 'store_failed';

export type LoginDenyReason =
  | 'unknown_target'
  | 'link_inactive'
  | 'link_unverified'
  | 'evidence_not_accepted'
  | 'link_invalid'
  | 'link_mismatch'
  | 'link_changed'
  | 'principal_inactive'
  | 'not_member'
  | 'membership_ineligible'
  | 'membership_stale'
  | 'membership_unresolved'
  | 'membership_unsupported'
  | 'wrong_group'
  | 'wrong_organization'
  | 'provider_failure'
  | 'wrong_code'
  | 'no_code'
  | 'expired'
  | 'attempts_exhausted'
  | 'account_locked'
  | 'browser_mismatch'
  | 'replay'
  | 'unknown_challenge'
  | 'dm_failed'
  | 'ack_mismatch'
  | 'superseded'
  | 'idle_timeout'
  | 'absolute_timeout'
  | 'membership_removed'
  | 'principal_disabled'
  | 'queue_full'
  | 'store_full'
  | 'logout'
  | 'wrong_purpose'
  | 'wrong_password'
  | 'no_credential'
  | 'credential_stale'
  | 'credential_changed'
  /** Stored hash uses a cost profile other than the active one (e.g. a cheaper one): never evaluated. */
  | 'credential_profile_rejected'
  | 'grant_invalid'
  | 'kdf_busy'
  | 'persist_failed';

/** Only these fields are ever emitted: no email, IP, code, token, secret or DM content. */
export interface LoginAuditEvent {
  type: LoginAuditType;
  at: string;
  /** Pseudonymous keyed hash of the normalized target email (16 hex). */
  subjectRef?: string;
  /** Keyed hash of the challenge ID (12 hex). */
  challengeRef?: string;
  reason?: LoginDenyReason;
}

export type LoginAuditSink = (event: LoginAuditEvent) => void;

// ---- durable state (credentials, sessions, challenges, setup grants)

/** Durable persistence for the login state. Implementations must write atomically and fail closed. */
export interface LoginPersistence {
  kind: 'durable';
  /** null for a first start; throws on any integrity or format problem (never "empty instead"). */
  load(): unknown;
  save(snapshot: unknown): void;
}

/** Removal/change notifications from an approved event source or poller. */
export type DirectoryEvent =
  | { type: 'membership_removed'; memberKey: string }
  | { type: 'link_changed'; linkId: string }
  | { type: 'principal_disabled'; principalId: string };

// ---- policy (PROPOSED defaults; every value is bounded and validated)

export interface LoginPolicy {
  codeDigits: number;
  codeTtlMs: number;
  challengeLifetimeMs: number;
  maxAttemptsPerChallenge: number;
  accountFailureLimit: number;
  accountFailureWindowMs: number;
  targetMinIntervalMs: number;
  targetMaxDeliveries: number;
  targetDeliveryWindowMs: number;
  clientRequestLimit: number;
  clientVerifyLimit: number;
  clientWindowMs: number;
  globalRequestLimit: number;
  globalWindowMs: number;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  membershipMaxAgeMs: number;
  /** Password logins per client key per window (anti-guessing; the account budget also applies). */
  clientLoginLimit: number;
  /** Lifetime of the one-time "set your password" grant after a verified setup code. */
  setupGrantMs: number;
  providerTimeoutMs: number;
  deliveryTimeoutMs: number;
  maxChallenges: number;
  maxSessions: number;
  maxRateKeys: number;
  maxQueue: number;
  dispatchConcurrency: number;
}

const MIN = 60_000;

export const PROPOSED_LOGIN_POLICY: LoginPolicy = {
  codeDigits: 8,
  codeTtlMs: 5 * MIN,
  challengeLifetimeMs: 15 * MIN,
  maxAttemptsPerChallenge: 5,
  accountFailureLimit: 5,
  accountFailureWindowMs: 15 * MIN,
  targetMinIntervalMs: MIN,
  targetMaxDeliveries: 3,
  targetDeliveryWindowMs: 15 * MIN,
  clientRequestLimit: 10,
  clientVerifyLimit: 30,
  clientWindowMs: 15 * MIN,
  globalRequestLimit: 300,
  globalWindowMs: MIN,
  sessionIdleMs: 30 * MIN,
  sessionAbsoluteMs: 8 * 60 * MIN,
  membershipMaxAgeMs: 30_000,
  clientLoginLimit: 20,
  setupGrantMs: 10 * MIN,
  providerTimeoutMs: 5_000,
  deliveryTimeoutMs: 10_000,
  maxChallenges: 10_000,
  maxSessions: 10_000,
  maxRateKeys: 20_000,
  maxQueue: 100,
  dispatchConcurrency: 4,
};

/** Inclusive [min, max] for each policy value; anything outside refuses construction. */
export const POLICY_BOUNDS: Record<keyof LoginPolicy, readonly [number, number]> = {
  codeDigits: [6, 10],
  codeTtlMs: [60_000, 10 * MIN],
  challengeLifetimeMs: [60_000, 30 * MIN],
  maxAttemptsPerChallenge: [1, 10],
  accountFailureLimit: [1, 20],
  accountFailureWindowMs: [MIN, 24 * 60 * MIN],
  targetMinIntervalMs: [10_000, 10 * MIN],
  targetMaxDeliveries: [1, 10],
  targetDeliveryWindowMs: [MIN, 24 * 60 * MIN],
  clientRequestLimit: [1, 1_000],
  clientVerifyLimit: [1, 1_000],
  clientWindowMs: [1_000, 24 * 60 * MIN],
  globalRequestLimit: [1, 100_000],
  globalWindowMs: [1_000, 60 * MIN],
  sessionIdleMs: [MIN, 60 * MIN],
  sessionAbsoluteMs: [10 * MIN, 12 * 60 * MIN],
  membershipMaxAgeMs: [0, 5 * MIN],
  clientLoginLimit: [1, 1_000],
  setupGrantMs: [MIN, 30 * MIN],
  providerTimeoutMs: [10, 30_000],
  deliveryTimeoutMs: [10, 60_000],
  maxChallenges: [1, 100_000],
  maxSessions: [1, 100_000],
  maxRateKeys: [1, 1_000_000],
  maxQueue: [1, 10_000],
  dispatchConcurrency: [1, 32],
};
