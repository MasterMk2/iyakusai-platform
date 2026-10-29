import { ConfigError } from '../auth.js';
import { generateCode, hashCode, keyedRef, MIN_PEPPER_BYTES, newSalt, OPAQUE_SECRET_PATTERN, opaqueSecret, publicId, safeEqual, sha256 } from './crypto.js';
import { MemoryLoginStore, type ChallengeRecord, type CounterResult, type CredentialRecord, type IssuedCode, type SessionRecord } from './memory-store.js';
import { checkPasswordPolicy, KdfBusyError, PasswordHasher, type PasswordPolicyError } from './password.js';
import {
  EFFECTIVE_MEMBERSHIP_KIND,
  LINK_EVIDENCE,
  MEMBERSHIP_PROVENANCE,
  POLICY_BOUNDS,
  PROPOSED_LOGIN_POLICY,
  REFERENCE_STORE_ACK,
  type BotDelivery,
  type ChallengePurpose,
  type DirectoryEvent,
  type GroupMembershipReader,
  type IdentityLink,
  type IdentityLinkDirectory,
  type LinkEvidence,
  type LoginAuditSink,
  type LoginAuditType,
  type LoginCodeEnvelope,
  type LoginDenyReason,
  type LoginPersistence,
  type LoginPolicy,
  type PrincipalDirectory,
} from './types.js';

// Login core. Code flow: email -> uniform accepted response -> bounded asynchronous
// dispatch (target rate limit, verified link, active principal, fresh complete effective
// membership) -> Bot DM to the linked account only -> the same browser returns the code ->
// atomic consume + recheck. A `login` code yields a session directly (original preparation
// flow); a `password_setup` code yields a one-time grant to set the person's own password,
// after which they log in with email + password. Every authenticated request rechecks
// link, principal, membership and (for password sessions) the credential version.

export interface LoginServiceOptions {
  /** Stable identifier of the single eligible group. */
  groupId: string;
  /**
   * Stable identifier of the organization whose managed all-users entry is a member of the group.
   * Organization-provenance evidence is accepted only for exactly this value; absent means it never qualifies.
   */
  organizationId?: string;
  /** Link evidence kinds the operator approved. Empty refuses construction (unresolved gate). */
  acceptedLinkEvidence: readonly LinkEvidence[];
  /** Injected keyed-hash pepper (>= 32 bytes). Tests inject a throwaway value; nothing is provisioned here. */
  pepper: Buffer;
  /** Generic label the Bot shows in the DM. */
  serviceLabel: string;
  /** Audience bound into every code hash (the public origin). Defaults to the service label. */
  audience?: string;
  membership: GroupMembershipReader;
  links: IdentityLinkDirectory;
  principals: PrincipalDirectory;
  deliver: BotDelivery;
  audit: LoginAuditSink;
  /**
   * Either the explicit acknowledgement that state is in memory and lost on restart, or a
   * durable persistence that is loaded at construction and saved after every change.
   */
  stateStore: typeof REFERENCE_STORE_ACK | LoginPersistence;
  /** Password KDF (defaults to calibrated scrypt). */
  passwords?: PasswordHasher;
  now?: () => number;
  policy?: Partial<LoginPolicy>;
}

export type ChallengeOutcome =
  | { ok: true; challengeId: string; browserSecret: string; expiresInSeconds: number }
  | { ok: false; error: 'invalid_request' | 'rate_limited' | 'unavailable' };

export type ResendOutcome = { ok: true; challengeId: string; expiresInSeconds: number } | { ok: false; error: 'login_failed' | 'rate_limited' };

export type VerifyOutcome = { ok: true; sessionToken: string; principalId: string } | { ok: false; error: 'login_failed' | 'rate_limited' | 'unavailable' };

export type SetupVerifyOutcome =
  | { ok: true; setupToken: string; principalId: string; hasPassword: boolean; expiresInSeconds: number }
  | { ok: false; error: 'login_failed' | 'rate_limited' | 'unavailable' };

export type PasswordSetupOutcome =
  | { ok: true; sessionToken: string; principalId: string; replacedPassword: boolean }
  | { ok: false; error: 'setup_failed' | 'rate_limited' | 'unavailable' }
  | { ok: false; error: 'policy'; policy: PasswordPolicyError };

export interface AuthenticatedSession {
  principalId: string;
  absoluteExpiresAt: number;
}

const GROUP_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const DISCORD_ID_PATTERN = /^[1-9]\d{16,19}$/;
const LINK_FIELD_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const LABEL_PATTERN = /^[\p{L}\p{N} ._-]{1,40}$/u;
const AUDIENCE_PATTERN = /^[A-Za-z0-9.:/_-]{1,200}$/;
const EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const CHALLENGE_ID_PATTERN = /^lc_[0-9a-f]{32}$/;
/** Lazy persistence of last-seen times (other changes are persisted immediately). */
const TOUCH_PERSIST_MS = 30_000;

/** Trim + ASCII lower-case only. No alias, plus-address or dot folding: the link must match exactly. */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return value.length <= 254 && EMAIL_PATTERN.test(value) ? value : null;
}

export function validatePolicy(overrides: Partial<LoginPolicy> = {}): LoginPolicy {
  const policy = { ...PROPOSED_LOGIN_POLICY, ...overrides };
  for (const key of Object.keys(policy) as (keyof LoginPolicy)[]) {
    const bounds = POLICY_BOUNDS[key];
    const value = policy[key];
    if (!bounds) throw new ConfigError(`ログイン方針に未知の項目があります（${String(key)}）。`);
    if (!Number.isInteger(value) || value < bounds[0] || value > bounds[1]) throw new ConfigError(`ログイン方針の ${key} が許容範囲外です。`);
  }
  if (policy.codeTtlMs > policy.challengeLifetimeMs) throw new ConfigError('codeTtlMs は challengeLifetimeMs 以下にしてください。');
  if (policy.sessionIdleMs > policy.sessionAbsoluteMs) throw new ConfigError('sessionIdleMs は sessionAbsoluteMs 以下にしてください。');
  return policy;
}

async function withTimeout<T>(call: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Eligibility = { ok: true; link: IdentityLink } | { ok: false; reason: LoginDenyReason };

interface DispatchJob {
  challengeId: string;
  /** Transient: present only for the first dispatch, never stored on the record. */
  email: string | null;
}

type CodeFailure = Extract<VerifyOutcome, { ok: false }>;
type Consumed = { ok: true; challenge: ChallengeRecord; winner: IssuedCode; link: IdentityLink } | { ok: false; outcome: CodeFailure };

export class LoginService {
  readonly policy: LoginPolicy;
  /** Exposed for bounded-state and hash-only assertions in tests. */
  readonly store: MemoryLoginStore;
  readonly passwords: PasswordHasher;
  private readonly options: LoginServiceOptions;
  private readonly now: () => number;
  private readonly accepted: ReadonlySet<LinkEvidence>;
  private readonly audience: string;
  private readonly persistence: LoginPersistence | null;
  private lastPersistAt = 0;
  private readonly queue: DispatchJob[] = [];
  private running = 0;
  private idleWaiters: (() => void)[] = [];
  /** Incremented by every directory event so in-flight checks cannot outlive a revocation. */
  private revocationEpoch = 0;

  constructor(options: LoginServiceOptions) {
    // Fail safe: any missing provider or unapproved setting means no authentication at all.
    for (const [name, fn] of [
      ['membership.lookup', options.membership?.lookup],
      ['links.findByVerifiedEmail', options.links?.findByVerifiedEmail],
      ['links.getLink', options.links?.getLink],
      ['principals.getPrincipal', options.principals?.getPrincipal],
      ['deliver', options.deliver],
      ['audit', options.audit],
    ] as const) {
      if (typeof fn !== 'function') throw new ConfigError(`ログインの提供元 ${name} が未設定です。`);
    }
    if (typeof options.groupId !== 'string' || !GROUP_ID_PATTERN.test(options.groupId)) throw new ConfigError('対象グループの識別子が未設定または不正です。');
    if (options.organizationId !== undefined && (typeof options.organizationId !== 'string' || !GROUP_ID_PATTERN.test(options.organizationId))) {
      throw new ConfigError('組織の識別子が不正です。');
    }
    const evidence = options.acceptedLinkEvidence ?? [];
    if (evidence.length === 0 || evidence.some((e) => !LINK_EVIDENCE.includes(e)) || new Set(evidence).size !== evidence.length) {
      throw new ConfigError('承認済みの連携根拠（acceptedLinkEvidence）が未設定または不正です。');
    }
    if (!Buffer.isBuffer(options.pepper) || options.pepper.length < MIN_PEPPER_BYTES || options.pepper.every((b) => b === options.pepper[0])) {
      throw new ConfigError(`ペッパーは ${MIN_PEPPER_BYTES} バイト以上の注入値が必要です。`);
    }
    if (typeof options.serviceLabel !== 'string' || !LABEL_PATTERN.test(options.serviceLabel)) throw new ConfigError('サービス表示名が不正です。');
    if (options.audience !== undefined && (typeof options.audience !== 'string' || !AUDIENCE_PATTERN.test(options.audience))) throw new ConfigError('audience が不正です。');
    const durable = typeof options.stateStore === 'object' && options.stateStore !== null && options.stateStore.kind === 'durable';
    if (!durable && options.stateStore !== REFERENCE_STORE_ACK) throw new ConfigError('状態保存先が承認されていません（参照実装は単一プロセスのテスト専用）。');
    if (durable && (typeof (options.stateStore as LoginPersistence).load !== 'function' || typeof (options.stateStore as LoginPersistence).save !== 'function')) {
      throw new ConfigError('永続保存先の load / save が未設定です。');
    }
    this.policy = validatePolicy(options.policy);
    this.options = options;
    this.now = options.now ?? Date.now;
    this.accepted = new Set(evidence);
    this.audience = options.audience ?? options.serviceLabel;
    this.passwords = options.passwords ?? new PasswordHasher();
    const p = this.policy;
    this.store = new MemoryLoginStore(REFERENCE_STORE_ACK, {
      maxChallenges: p.maxChallenges,
      maxSessions: p.maxSessions,
      maxRateKeys: p.maxRateKeys,
      maxWindowMs: Math.max(p.accountFailureWindowMs, p.targetMinIntervalMs, p.targetDeliveryWindowMs, p.clientWindowMs, p.globalWindowMs),
    });
    this.persistence = durable ? (options.stateStore as LoginPersistence) : null;
    if (this.persistence) {
      // Integrity failures propagate: the caller refuses to start rather than starting empty.
      const snapshot = this.persistence.load();
      if (snapshot !== null && snapshot !== undefined) this.store.restore(snapshot, this.now());
    }
  }

  // ---- public operations

  /** Same outcome for every syntactically valid email; eligibility runs later in the bounded queue. */
  requestChallenge(input: { email: string; clientKey: string | null; purpose?: ChallengePurpose }): ChallengeOutcome {
    const now = this.now();
    if (!this.clientAllowed('request', input.clientKey, now)) return { ok: false, error: 'rate_limited' };
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : null;
    if (!email) return { ok: false, error: 'invalid_request' };
    const browserSecret = opaqueSecret();
    const record: ChallengeRecord = {
      id: publicId('lc'),
      browserHash: sha256(browserSecret),
      targetKey: keyedRef(this.options.pepper, 'target', email),
      createdAt: now,
      expiresAt: now + this.policy.challengeLifetimeMs,
      state: 'open',
      purpose: input.purpose ?? 'login',
      generation: 0,
      failedAttempts: 0,
      dispatching: false,
      linkId: null,
      memberKey: null,
      principalId: null,
      code: null,
    };
    if (!this.store.addChallenge(record, now)) {
      this.emit('capacity_denied', now, { reason: 'store_full' });
      return { ok: false, error: 'unavailable' };
    }
    if (!this.persist()) {
      this.store.deleteChallenge(record.id);
      return { ok: false, error: 'unavailable' };
    }
    this.emit('challenge_requested', now, { challenge: record });
    this.enqueue(record, email, now);
    return { ok: true, challengeId: record.id, browserSecret, expiresInSeconds: this.policy.codeTtlMs / 1000 };
  }

  /** Reissue within the same browser challenge. Coalesces while a dispatch is in flight. */
  resend(input: { challengeId: string; browserSecret: string; clientKey: string | null }): ResendOutcome {
    const now = this.now();
    if (!this.clientAllowed('request', input.clientKey, now)) return { ok: false, error: 'rate_limited' };
    const found = this.findBound(input.challengeId, input.browserSecret, now);
    if (!found.ok) {
      this.emit('verify_failed', now, { challenge: found.challenge, reason: found.reason });
      return { ok: false, error: 'login_failed' };
    }
    const challenge = found.challenge;
    this.emit('resend_requested', now, { challenge });
    if (!challenge.dispatching) this.enqueue(challenge, null, now);
    return { ok: true, challengeId: challenge.id, expiresInSeconds: this.policy.codeTtlMs / 1000 };
  }

  /** Original code-only login (purpose `login`): consumes the code and issues a session. */
  async verify(input: { challengeId: string; browserSecret: string; code: string; clientKey: string | null; priorSessionToken?: string | null }): Promise<VerifyOutcome> {
    const consumed = await this.consumeCode(input, 'login');
    if (!consumed.ok) return consumed.outcome;
    const { challenge, winner } = consumed;
    // Session fixation: any session presented by this browser is revoked; a fresh token is always issued.
    if (input.priorSessionToken) this.dropSession(input.priorSessionToken, 'superseded');
    const issued = this.issueSession({ principalId: winner.principalId, linkId: winner.linkId, linkVersion: winner.linkVersion, memberKey: winner.memberKey, targetKey: challenge.targetKey, credentialVersion: null });
    if (!issued) {
      this.emit('capacity_denied', this.now(), { challenge, reason: 'store_full' });
      return { ok: false, error: 'unavailable' };
    }
    this.emit('login_succeeded', this.now(), { challenge });
    return { ok: true, sessionToken: issued, principalId: winner.principalId };
  }

  /**
   * Password setup / recovery step 1: consumes a `password_setup` code (same atomic single use,
   * attempt limits and fresh eligibility as the login code) and returns a short one-time grant.
   */
  async verifySetupCode(input: { challengeId: string; browserSecret: string; code: string; clientKey: string | null }): Promise<SetupVerifyOutcome> {
    const consumed = await this.consumeCode(input, 'password_setup');
    if (!consumed.ok) return consumed.outcome;
    const { challenge, winner } = consumed;
    const at = this.now();
    // Only the newest grant of a principal is usable.
    for (const [hash, grant] of this.store.setupGrants) if (grant.principalId === winner.principalId) this.store.setupGrants.delete(hash);
    const token = opaqueSecret();
    const expiresAt = at + this.policy.setupGrantMs;
    this.store.setupGrants.set(sha256(token).toString('hex'), {
      tokenHash: sha256(token).toString('hex'),
      principalId: winner.principalId,
      linkId: winner.linkId,
      linkVersion: winner.linkVersion,
      memberKey: winner.memberKey,
      targetKey: challenge.targetKey,
      expiresAt,
      used: false,
    });
    if (!this.persist()) return { ok: false, error: 'unavailable' };
    this.emit('setup_code_verified', at, { challenge });
    return { ok: true, setupToken: token, principalId: winner.principalId, hasPassword: this.store.credentials.has(winner.principalId), expiresInSeconds: this.policy.setupGrantMs / 1000 };
  }

  /**
   * Password setup / recovery step 2. The grant is single use; the binding and membership are
   * rechecked; the new credential revokes every existing session, open code and other grant of
   * the principal. Roles and source permissions are untouched (they never live here).
   */
  async completePasswordSetup(input: { setupToken: string; password: string; clientKey: string | null; priorSessionToken?: string | null }): Promise<PasswordSetupOutcome> {
    const now = this.now();
    if (!this.clientAllowed('verify', input.clientKey, now)) return { ok: false, error: 'rate_limited' };
    const tokenHash = typeof input.setupToken === 'string' && OPAQUE_SECRET_PATTERN.test(input.setupToken) ? sha256(input.setupToken).toString('hex') : null;
    const grant = tokenHash ? this.store.setupGrants.get(tokenHash) : undefined;
    if (!grant || grant.used || now >= grant.expiresAt) return this.setupFailed(grant?.targetKey, 'grant_invalid', now);
    const basic = checkPasswordPolicy(input.password, null);
    if (basic) return { ok: false, error: 'policy', policy: basic };

    const epoch = this.revocationEpoch;
    const eligibility = await this.checkLink(await this.loadLink(grant.linkId), grant.targetKey, grant.linkVersion);
    if (!eligibility.ok) return this.setupFailed(grant.targetKey, eligibility.reason, this.now());
    const withEmail = checkPasswordPolicy(input.password, eligibility.link.email);
    if (withEmail) return { ok: false, error: 'policy', policy: withEmail };
    let hash;
    try {
      hash = await this.passwords.hash(input.password);
    } catch (err) {
      this.emit('capacity_denied', this.now(), { subject: grant.targetKey, reason: err instanceof KdfBusyError ? 'kdf_busy' : 'store_full' });
      return { ok: false, error: 'unavailable' };
    }

    // Everything below is synchronous: the grant check-and-consume and the credential swap are atomic.
    const at = this.now();
    const current = this.store.setupGrants.get(tokenHash!);
    if (!current || current.used || at >= current.expiresAt) return this.setupFailed(grant.targetKey, 'grant_invalid', at);
    if (epoch !== this.revocationEpoch) return this.setupFailed(grant.targetKey, 'superseded', at);
    current.used = true;
    const previous = this.store.credentials.get(grant.principalId);
    const credential: CredentialRecord = {
      principalId: grant.principalId,
      linkId: eligibility.link.linkId,
      linkVersion: eligibility.link.version,
      version: (previous?.version ?? 0) + 1,
      hash,
      updatedAt: at,
    };
    this.store.credentials.set(grant.principalId, credential);
    const revokedSubjects: string[] = [];
    this.store.deleteSessionsWhere((s) => {
      const hit = s.principalId === grant.principalId || s.targetKey === grant.targetKey;
      if (hit) revokedSubjects.push(s.targetKey);
      return hit;
    });
    for (const c of this.store.findChallenges((c) => c.state === 'open' && (c.targetKey === grant.targetKey || c.principalId === grant.principalId))) {
      c.state = 'dead';
      c.code = null;
    }
    for (const [hashKey, g] of this.store.setupGrants) if (g.principalId === grant.principalId && hashKey !== tokenHash) this.store.setupGrants.delete(hashKey);
    if (input.priorSessionToken) this.dropSession(input.priorSessionToken, 'superseded');
    const token = this.issueSession({
      principalId: grant.principalId,
      linkId: credential.linkId,
      linkVersion: credential.linkVersion,
      memberKey: eligibility.link.memberKey,
      targetKey: grant.targetKey,
      credentialVersion: credential.version,
    });
    if (!token) {
      // Could not persist: put the previous credential back; revoked sessions stay revoked (fail closed).
      if (previous) this.store.credentials.set(grant.principalId, previous);
      else this.store.credentials.delete(grant.principalId);
      this.persist();
      return { ok: false, error: 'unavailable' };
    }
    for (const subject of revokedSubjects) this.emit('session_revoked', at, { subject, reason: 'credential_changed' });
    this.emit(previous ? 'password_reset' : 'password_set', at, { subject: grant.targetKey });
    return { ok: true, sessionToken: token, principalId: grant.principalId, replacedPassword: !!previous };
  }

  /**
   * Normal login with email + the person's own password. Uniform failure for unknown email,
   * missing password, wrong password, lost membership or changed binding; an unknown email
   * still costs one KDF run.
   */
  async passwordLogin(input: { email: string; password: string; clientKey: string | null; priorSessionToken?: string | null }): Promise<VerifyOutcome> {
    const now = this.now();
    if (!this.clientAllowed('login', input.clientKey, now)) return { ok: false, error: 'rate_limited' };
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : null;
    const password = typeof input.password === 'string' ? input.password : '';
    const targetKey = email ? keyedRef(this.options.pepper, 'target', email) : null;
    const accountKey = targetKey ? `account-fail:${targetKey}` : null;
    const fail = async (reason: LoginDenyReason, count: boolean, runKdf: boolean): Promise<VerifyOutcome> => {
      if (runKdf) {
        try {
          await this.passwords.verify(password, null);
        } catch {
          // Busy: the uniform failure below still applies.
        }
      }
      if (count && accountKey) {
        // The account budget is durable: it survives a restart (the failure is uniform either way).
        // If the table filled up meanwhile, this attempt still fails; the next one is refused by the check below.
        if (this.store.counters.hit(accountKey, Number.MAX_SAFE_INTEGER, this.policy.accountFailureWindowMs, this.now()) !== 'allowed') {
          this.emit('capacity_denied', this.now(), { subject: targetKey ?? undefined, reason: 'store_full' });
        }
        this.persist();
      }
      this.emit('password_login_failed', this.now(), { subject: targetKey ?? undefined, reason });
      return { ok: false, error: 'login_failed' };
    };
    if (!email || !accountKey || password.length === 0 || checkPasswordPolicy(password, null) === 'too_long') return fail('wrong_password', false, true);
    if (this.store.counters.count(accountKey, this.policy.accountFailureWindowMs, now) >= this.policy.accountFailureLimit) return fail('account_locked', false, true);
    // Fail closed like code verification: a password is only evaluated when a failure could be counted
    // for this account. Decided before any lookup, so it does not depend on whether the account exists.
    if (!this.store.counters.canRecord(accountKey, now)) {
      this.emit('capacity_denied', now, { subject: targetKey ?? undefined, reason: 'store_full' });
      return { ok: false, error: 'unavailable' };
    }

    const epoch = this.revocationEpoch;
    const found = await this.findLinkByEmail(email);
    const link = found && found !== 'failure' ? found : null;
    const credential = link ? this.store.credentials.get(link.principalId) : undefined;
    let match: boolean;
    try {
      match = await this.passwords.verify(password, credential?.hash ?? null);
    } catch (err) {
      this.emit('capacity_denied', this.now(), { subject: targetKey ?? undefined, reason: err instanceof KdfBusyError ? 'kdf_busy' : 'store_full' });
      return { ok: false, error: 'unavailable' };
    }
    if (found === 'failure') return fail('provider_failure', false, false);
    if (!link || !credential) return fail('no_credential', true, false);
    // A record of another (e.g. cheaper) cost profile was never evaluated; the person must reset through recovery.
    if (!this.passwords.accepts(credential.hash)) return fail('credential_profile_rejected', true, false);
    if (!match) return fail('wrong_password', true, false);
    // The password was set through this exact binding version; a replaced binding needs a new setup.
    if (credential.linkId !== link.linkId || credential.linkVersion !== link.version) return fail('credential_stale', false, false);
    const eligibility = await this.checkLink(link, targetKey!, credential.linkVersion);
    if (!eligibility.ok) return fail(eligibility.reason, false, false);
    if (this.store.credentials.get(link.principalId) !== credential || epoch !== this.revocationEpoch) return fail('credential_changed', false, false);

    if (input.priorSessionToken) this.dropSession(input.priorSessionToken, 'superseded');
    const token = this.issueSession({ principalId: link.principalId, linkId: link.linkId, linkVersion: link.version, memberKey: link.memberKey, targetKey: targetKey!, credentialVersion: credential.version });
    if (!token) return { ok: false, error: 'unavailable' };
    this.emit('password_login_succeeded', this.now(), { subject: targetKey! });
    return { ok: true, sessionToken: token, principalId: link.principalId };
  }

  /** Per-request check: idle/absolute expiry, credential version, then current link, principal and membership. */
  async authenticate(token: string | null | undefined): Promise<AuthenticatedSession | null> {
    if (typeof token !== 'string' || !OPAQUE_SECRET_PATTERN.test(token)) return null;
    const hash = sha256(token).toString('hex');
    const session = this.store.getSession(hash);
    const now = this.now();
    if (!session) {
      this.emit('session_denied', now, {});
      return null;
    }
    const expired: LoginDenyReason | null =
      now >= session.absoluteExpiresAt ? 'absolute_timeout' : now - session.lastSeenAt >= this.policy.sessionIdleMs ? 'idle_timeout' : null;
    const credentialVersion = session.credentialVersion ?? null;
    const stale: LoginDenyReason | null =
      credentialVersion !== null && this.store.credentials.get(session.principalId)?.version !== credentialVersion ? 'credential_changed' : null;
    if (expired || stale) {
      this.store.deleteSession(hash);
      this.persist();
      this.emit('session_revoked', now, { subject: session.targetKey, reason: expired ?? stale! });
      return null;
    }
    const eligibility = await this.checkLink(await this.loadLink(session.linkId), session.targetKey, session.linkVersion);
    // A directory event or a password change may have removed the session while the checks were awaited.
    if (this.store.getSession(hash) !== session) return null;
    if (credentialVersion !== null && this.store.credentials.get(session.principalId)?.version !== credentialVersion) return null;
    if (!eligibility.ok) {
      this.store.deleteSession(hash);
      this.persist();
      this.emit('session_revoked', this.now(), { subject: session.targetKey, reason: eligibility.reason });
      return null;
    }
    session.lastSeenAt = this.now();
    if (this.persistence && session.lastSeenAt - this.lastPersistAt >= TOUCH_PERSIST_MS) this.persist();
    return { principalId: session.principalId, absoluteExpiresAt: session.absoluteExpiresAt };
  }

  logout(token: string | null | undefined): void {
    if (typeof token === 'string' && OPAQUE_SECRET_PATTERN.test(token)) this.dropSession(token, 'logout');
  }

  /** Removal/change notification: revokes matching sessions, open challenges and setup grants immediately. */
  handleDirectoryEvent(event: DirectoryEvent): { sessions: number; challenges: number } {
    this.revocationEpoch += 1;
    const now = this.now();
    const [reason, matchSession, matchChallenge]: [LoginDenyReason, (s: SessionRecord) => boolean, (c: ChallengeRecord) => boolean] =
      event.type === 'membership_removed'
        ? ['membership_removed', (s) => s.memberKey === event.memberKey, (c) => c.memberKey === event.memberKey]
        : event.type === 'link_changed'
          ? ['link_changed', (s) => s.linkId === event.linkId, (c) => c.linkId === event.linkId]
          : ['principal_disabled', (s) => s.principalId === event.principalId, (c) => c.principalId === event.principalId];
    const subjects: string[] = [];
    const sessions = this.store.deleteSessionsWhere((s) => {
      const hit = matchSession(s);
      if (hit) subjects.push(s.targetKey);
      return hit;
    });
    for (const subject of subjects) this.emit('session_revoked', now, { subject, reason });
    const challenges = this.store.findChallenges((c) => c.state === 'open' && matchChallenge(c));
    for (const c of challenges) {
      c.state = 'dead';
      c.code = null;
      this.emit('session_revoked', now, { challenge: c, reason });
    }
    for (const [hash, g] of this.store.setupGrants) {
      const hit = event.type === 'membership_removed' ? g.memberKey === event.memberKey : event.type === 'link_changed' ? g.linkId === event.linkId : g.principalId === event.principalId;
      if (hit) this.store.setupGrants.delete(hash);
    }
    this.persist();
    return { sessions, challenges: challenges.length };
  }

  /** Writes the current state now (orderly shutdown); false if it could not be written. */
  flush(): boolean {
    return this.persist();
  }

  /** Resolves once the dispatch queue is empty (tests and orderly shutdown). */
  idle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ---- code consumption (shared by both purposes)

  private async consumeCode(input: { challengeId: string; browserSecret: string; code: string; clientKey: string | null }, purpose: ChallengePurpose): Promise<Consumed> {
    const now = this.now();
    if (!this.clientAllowed('verify', input.clientKey, now)) return { ok: false, outcome: { ok: false, error: 'rate_limited' } };
    const found = this.findBound(input.challengeId, input.browserSecret, now);
    if (!found.ok) return { ok: false, outcome: this.verifyFailed(found.challenge, found.reason, now) };
    const challenge = found.challenge;
    const accountKey = `account-fail:${challenge.targetKey}`;
    if (this.store.counters.count(accountKey, this.policy.accountFailureWindowMs, now) >= this.policy.accountFailureLimit) {
      return { ok: false, outcome: this.verifyFailed(challenge, 'account_locked', now) };
    }

    const issued = challenge.code;
    const code = typeof input.code === 'string' ? input.code : '';
    const wellFormed = code.length === this.policy.codeDigits && /^\d+$/.test(code);
    // Always compute one HMAC so a missing code costs the same as a wrong one.
    const candidate = hashCode(this.options.pepper, issued?.salt ?? newSalt(), this.codeBinding(challenge), issued?.generation ?? 0, wellFormed ? code : '');
    let reason: LoginDenyReason | null = null;
    if (!issued || !issued.delivered) reason = 'no_code';
    else if (now >= issued.expiresAt) reason = 'expired';
    else if (!wellFormed || !safeEqual(candidate, issued.hash)) reason = 'wrong_code';
    else if (challenge.purpose !== purpose) reason = 'wrong_purpose';

    if (reason) {
      challenge.failedAttempts += 1;
      if (challenge.failedAttempts >= this.policy.maxAttemptsPerChallenge) {
        challenge.state = 'dead';
        challenge.code = null;
      }
      // The account budget survives resends and new challenges. If it cannot be recorded, fail closed.
      if (this.store.counters.hit(accountKey, Number.MAX_SAFE_INTEGER, this.policy.accountFailureWindowMs, now) !== 'allowed') {
        challenge.state = 'dead';
        challenge.code = null;
      }
      this.persist();
      return { ok: false, outcome: this.verifyFailed(challenge, challenge.state === 'dead' && reason === 'wrong_code' ? 'attempts_exhausted' : reason, now) };
    }

    // Atomic single use: the first matching request consumes synchronously, before any await.
    const winner = issued!;
    challenge.state = 'consumed';
    challenge.code = null;
    if (!this.persist()) return { ok: false, outcome: { ok: false, error: 'unavailable' } };
    const epoch = this.revocationEpoch;
    const eligibility = await this.checkLink(await this.loadLink(winner.linkId), challenge.targetKey, winner.linkVersion);
    if (!eligibility.ok) return { ok: false, outcome: this.verifyFailed(challenge, eligibility.reason, this.now()) };
    if (epoch !== this.revocationEpoch) return { ok: false, outcome: this.verifyFailed(challenge, 'superseded', this.now()) };
    return { ok: true, challenge, winner, link: eligibility.link };
  }

  private issueSession(fields: Pick<SessionRecord, 'principalId' | 'linkId' | 'linkVersion' | 'memberKey' | 'targetKey' | 'credentialVersion'>): string | null {
    const token = opaqueSecret();
    const at = this.now();
    const session: SessionRecord = {
      tokenHash: sha256(token).toString('hex'),
      ...fields,
      createdAt: at,
      lastSeenAt: at,
      absoluteExpiresAt: at + this.policy.sessionAbsoluteMs,
    };
    if (fields.credentialVersion === null) delete session.credentialVersion;
    if (!this.store.addSession(session, at, this.policy.sessionIdleMs)) return null;
    if (!this.persist()) {
      this.store.deleteSession(session.tokenHash);
      return null;
    }
    return token;
  }

  // ---- dispatch (asynchronous, bounded)

  private enqueue(challenge: ChallengeRecord, email: string | null, now: number): void {
    if (this.queue.length + this.running >= this.policy.maxQueue) {
      this.emit('dispatch_dropped', now, { challenge, reason: 'queue_full' });
      return;
    }
    challenge.dispatching = true;
    this.queue.push({ challengeId: challenge.id, email });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.policy.dispatchConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running += 1;
      void this.dispatch(job)
        .catch(() => undefined)
        .finally(() => {
          const challenge = this.store.getChallenge(job.challengeId);
          if (challenge) {
            challenge.dispatching = false;
            // Never leave an unacknowledged code behind, whatever happened.
            if (challenge.code && !challenge.code.delivered) challenge.code = null;
          }
          this.persist();
          this.running -= 1;
          this.pump();
          if (this.running === 0 && this.queue.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const resolve of waiters) resolve();
          }
        });
    }
  }

  private async dispatch(job: DispatchJob): Promise<void> {
    const startedAt = this.now();
    const challenge = this.store.getChallenge(job.challengeId);
    if (!challenge || challenge.state !== 'open' || startedAt >= challenge.expiresAt) return;

    // Target budget first, identically for known and unknown targets.
    const target = challenge.targetKey;
    const limited = this.targetHit(`target-interval:${target}`, 1, this.policy.targetMinIntervalMs, startedAt);
    const windowed = limited ?? this.targetHit(`target-window:${target}`, this.policy.targetMaxDeliveries, this.policy.targetDeliveryWindowMs, startedAt);
    if (windowed) {
      this.emit(windowed === 'full' ? 'capacity_denied' : 'target_rate_limited', startedAt, { challenge, reason: windowed === 'full' ? 'store_full' : undefined });
      return;
    }

    const epoch = this.revocationEpoch;
    const link = job.email !== null ? await this.findLinkByEmail(job.email) : challenge.linkId ? await this.loadLink(challenge.linkId) : null;
    const eligibility = await this.checkLink(link, target, null);
    const now = this.now();
    if (!eligibility.ok) {
      this.emit('eligibility_denied', now, { challenge, reason: eligibility.reason });
      return;
    }
    if (epoch !== this.revocationEpoch || challenge.state !== 'open' || now >= challenge.expiresAt) {
      this.emit('eligibility_denied', now, { challenge, reason: 'superseded' });
      return;
    }

    const eligible = eligibility.link;
    challenge.linkId = eligible.linkId;
    challenge.memberKey = eligible.memberKey;
    challenge.principalId = eligible.principalId;
    // Reissue: the previous code of this challenge stops working from here on.
    const code = generateCode(this.policy.codeDigits);
    const salt = newSalt();
    const generation = challenge.generation + 1;
    challenge.generation = generation;
    const issued: IssuedCode = {
      hash: hashCode(this.options.pepper, salt, this.codeBinding(challenge), generation, code),
      salt,
      generation,
      deliveryId: publicId('dl'),
      delivered: false,
      expiresAt: Math.min(now + this.policy.codeTtlMs, challenge.expiresAt),
      linkId: eligible.linkId,
      linkVersion: eligible.version,
      memberKey: eligible.memberKey,
      principalId: eligible.principalId,
    };
    challenge.code = issued;
    this.emit('code_issued', now, { challenge });

    const setup = challenge.purpose === 'password_setup';
    const envelope: LoginCodeEnvelope = {
      kind: 'login_code',
      deliveryId: issued.deliveryId,
      template: setup ? 'password_setup_code_v1' : 'login_code_v1',
      ...(setup ? { purpose: challenge.purpose, audience: this.audience } : {}),
      recipient: { discordUserId: eligible.discordUserId, linkId: eligible.linkId, linkVersion: eligible.version },
      code,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      context: {
        serviceLabel: this.options.serviceLabel,
        requestedAt: new Date(challenge.createdAt).toISOString(),
        ...(setup ? { verifiedEmail: eligible.email } : {}),
      },
    };
    let failure: LoginDenyReason | null = null;
    try {
      const ack = await withTimeout(() => this.options.deliver(envelope), this.policy.deliveryTimeoutMs);
      if (!ack || ack.deliveryId !== issued.deliveryId) failure = 'ack_mismatch';
      else if (ack.status !== 'delivered') failure = 'dm_failed';
    } catch {
      failure = 'dm_failed';
    }
    const after = this.now();
    // Only the still-current issuance of a still-open challenge becomes usable.
    if (failure || challenge.code !== issued || challenge.state !== 'open' || epoch !== this.revocationEpoch) {
      if (challenge.code === issued) challenge.code = null;
      this.emit('delivery_failed', after, { challenge, reason: failure ?? 'superseded' });
      return;
    }
    issued.delivered = true;
    this.emit('delivery_succeeded', after, { challenge });
  }

  private targetHit(key: string, limit: number, windowMs: number, now: number): Exclude<CounterResult, 'allowed'> | null {
    const result = this.store.counters.hit(key, limit, windowMs, now);
    return result === 'allowed' ? null : result;
  }

  // ---- eligibility

  private async findLinkByEmail(email: string): Promise<IdentityLink | null | 'failure'> {
    try {
      return await withTimeout(() => this.options.links.findByVerifiedEmail(email), this.policy.providerTimeoutMs);
    } catch {
      return 'failure';
    }
  }

  private async loadLink(linkId: string): Promise<IdentityLink | null | 'failure'> {
    try {
      return await withTimeout(() => this.options.links.getLink(linkId), this.policy.providerTimeoutMs);
    } catch {
      return 'failure';
    }
  }

  /**
   * Verified active operator link for exactly this target, active principal, and a fresh, complete,
   * true effective membership of an active user in the configured group (direct, nested or through the
   * configured organization). Anything else denies. Provenance never changes the result or privileges.
   */
  private async checkLink(link: IdentityLink | null | 'failure', targetKey: string, expectedVersion: number | null): Promise<Eligibility> {
    if (link === 'failure') return { ok: false, reason: 'provider_failure' };
    if (!link) return { ok: false, reason: 'unknown_target' };
    if (link.status !== 'active') return { ok: false, reason: 'link_inactive' };
    if (link.emailVerified !== true) return { ok: false, reason: 'link_unverified' };
    if (!this.accepted.has(link.evidence)) return { ok: false, reason: 'evidence_not_accepted' };
    if (
      !Number.isInteger(link.version) ||
      !DISCORD_ID_PATTERN.test(link.discordUserId ?? '') ||
      ![link.linkId, link.memberKey, link.principalId].every((v) => typeof v === 'string' && LINK_FIELD_PATTERN.test(v))
    ) {
      return { ok: false, reason: 'link_invalid' };
    }
    // The link must name exactly the requested email (no alias resolution by the directory).
    if (typeof link.email !== 'string' || keyedRef(this.options.pepper, 'target', link.email) !== targetKey) return { ok: false, reason: 'link_mismatch' };
    if (expectedVersion !== null && link.version !== expectedVersion) return { ok: false, reason: 'link_changed' };

    try {
      const principal = await withTimeout(() => this.options.principals.getPrincipal(link.principalId), this.policy.providerTimeoutMs);
      if (!principal || principal.principalId !== link.principalId || principal.active !== true) return { ok: false, reason: 'principal_inactive' };
      const m = await withTimeout(() => this.options.membership.lookup(this.options.groupId, link.memberKey), this.policy.providerTimeoutMs);
      if (!m || typeof m !== 'object') return { ok: false, reason: 'provider_failure' };
      if (m.kind !== EFFECTIVE_MEMBERSHIP_KIND) return { ok: false, reason: 'membership_unsupported' };
      if (m.groupId !== this.options.groupId) return { ok: false, reason: 'wrong_group' };
      if (m.memberKey !== link.memberKey) return { ok: false, reason: 'link_mismatch' };
      if (m.resolution === 'forbidden' || m.resolution === 'unavailable') return { ok: false, reason: 'provider_failure' };
      if (m.resolution !== 'complete') return { ok: false, reason: 'membership_unresolved' };
      if (m.effectiveMember === false) return { ok: false, reason: 'not_member' };
      if (m.effectiveMember !== true) return { ok: false, reason: 'membership_unresolved' };
      if (m.subjectType !== 'user' || m.subjectState !== 'active') return { ok: false, reason: 'membership_ineligible' };
      const provenance: readonly unknown[] = Array.isArray(m.provenance) ? m.provenance : [];
      if (provenance.length === 0 || new Set(provenance).size !== provenance.length || provenance.some((p) => !MEMBERSHIP_PROVENANCE.includes(p as never))) {
        return { ok: false, reason: 'membership_unsupported' };
      }
      // Organization evidence must name the configured organization; it is never a blanket allow.
      if (provenance.includes('organization')) {
        if (this.options.organizationId === undefined || m.organizationId !== this.options.organizationId) return { ok: false, reason: 'wrong_organization' };
      } else if (m.organizationId !== null) {
        return { ok: false, reason: 'membership_unsupported' };
      }
      const now = this.now();
      const age = now - m.observedAt;
      if (typeof m.groupRevision !== 'string' || m.groupRevision === '' || !Number.isFinite(age) || age < 0 || age > this.policy.membershipMaxAgeMs) {
        return { ok: false, reason: 'membership_stale' };
      }
    } catch {
      return { ok: false, reason: 'provider_failure' };
    }
    return { ok: true, link };
  }

  // ---- helpers

  /** Code hash binding: challenge, purpose and audience (a code never transfers between them). */
  private codeBinding(challenge: ChallengeRecord): string {
    return challenge.purpose === 'login' ? challenge.id : `${challenge.id}\u0000${challenge.purpose}\u0000${this.audience}`;
  }

  /** Durable write after a change. A failed write is reported so the caller can fail closed. */
  private persist(): boolean {
    if (!this.persistence) return true;
    const now = this.now();
    try {
      this.store.sweep(now, this.policy.sessionIdleMs);
      this.persistence.save(this.store.snapshot(now));
      this.lastPersistAt = now;
      return true;
    } catch {
      this.emit('store_failed', now, { reason: 'persist_failed' });
      return false;
    }
  }

  private findBound(challengeId: string, browserSecret: string, now: number): { ok: true; challenge: ChallengeRecord } | { ok: false; challenge?: ChallengeRecord; reason: LoginDenyReason } {
    const challenge = typeof challengeId === 'string' && CHALLENGE_ID_PATTERN.test(challengeId) ? this.store.getChallenge(challengeId) : undefined;
    if (!challenge) return { ok: false, reason: 'unknown_challenge' };
    if (typeof browserSecret !== 'string' || !OPAQUE_SECRET_PATTERN.test(browserSecret) || !safeEqual(sha256(browserSecret), challenge.browserHash)) {
      return { ok: false, challenge, reason: 'browser_mismatch' };
    }
    if (challenge.state === 'consumed') return { ok: false, challenge, reason: 'replay' };
    if (challenge.state === 'dead') return { ok: false, challenge, reason: 'attempts_exhausted' };
    if (now >= challenge.expiresAt) return { ok: false, challenge, reason: 'expired' };
    return { ok: true, challenge };
  }

  private verifyFailed(challenge: ChallengeRecord | undefined, reason: LoginDenyReason, now: number): CodeFailure {
    this.emit('verify_failed', now, { challenge, reason });
    return { ok: false, error: 'login_failed' };
  }

  private setupFailed(subject: string | undefined, reason: LoginDenyReason, now: number): PasswordSetupOutcome {
    this.emit('verify_failed', now, { subject, reason });
    return { ok: false, error: 'setup_failed' };
  }

  private clientAllowed(kind: 'request' | 'verify' | 'login', clientKey: string | null, now: number): boolean {
    // The key must come from operator-defined trusted transport context; absent means deny.
    if (typeof clientKey !== 'string' || clientKey.length === 0 || clientKey.length > 256) {
      this.emit('client_rate_limited', now, {});
      return false;
    }
    const ref = keyedRef(this.options.pepper, 'client', clientKey).slice(0, 32);
    const p = this.policy;
    const limit = kind === 'request' ? p.clientRequestLimit : kind === 'verify' ? p.clientVerifyLimit : p.clientLoginLimit;
    const results: CounterResult[] = [this.store.counters.hit(`client-${kind}:${ref}`, limit, p.clientWindowMs, now)];
    if (kind !== 'verify' && results[0] === 'allowed') results.push(this.store.counters.hit(`global-${kind}`, p.globalRequestLimit, p.globalWindowMs, now));
    const denied = results.find((r) => r !== 'allowed');
    if (denied) {
      this.emit(denied === 'full' ? 'capacity_denied' : 'client_rate_limited', now, { reason: denied === 'full' ? 'store_full' : undefined });
      return false;
    }
    return true;
  }

  private dropSession(token: string, reason: LoginDenyReason): void {
    const hash = sha256(token).toString('hex');
    const session = this.store.getSession(hash);
    if (session && this.store.deleteSession(hash)) {
      this.persist();
      this.emit(reason === 'logout' ? 'logout' : 'session_revoked', this.now(), { subject: session.targetKey, reason });
    }
  }

  private emit(type: LoginAuditType, now: number, refs: { challenge?: ChallengeRecord | undefined; subject?: string | undefined; reason?: LoginDenyReason | undefined }): void {
    const subject = refs.subject ?? refs.challenge?.targetKey;
    try {
      this.options.audit({
        type,
        at: new Date(now).toISOString(),
        ...(subject ? { subjectRef: subject.slice(0, 16) } : {}),
        ...(refs.challenge ? { challengeRef: keyedRef(this.options.pepper, 'challenge-ref', refs.challenge.id).slice(0, 12) } : {}),
        ...(refs.reason ? { reason: refs.reason } : {}),
      });
    } catch {
      // Audit failure never grants anything and must not break denial paths.
    }
  }
}
