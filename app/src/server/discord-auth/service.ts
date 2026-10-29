import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { checkPasswordPolicy, PasswordHasher } from '../login/password.js';
import { loggableLoginId, type LoginAudit, type LoginEventKind, type LoginEventReason } from './audit.js';
import type { DiscordAuthConfig } from './config.js';
import type { Account, AccountState, AccountStore } from './store.js';
import { isStaffStudentId, isTemporaryStaffAccount, isTemporaryStaffId } from './temporary-staff.js';
import { CARD_DAYS, DEVICE_DAYS, CardAuthError, cardView, type CardAuthState } from './cards.js';
import type { CardSettings } from '../../shared/card-login.js';

// Discord account login of the common app. Ported from the production minimal runtime on
// task.iyakusai.com (DiscordAccountService): registration starts from Discord `/register` on the Bot
// host, which asks this service to issue a one-time code; the code is delivered by DM through the Bot
// host and the person sets a password. Every step re-checks current guild membership with the Bot host.
// Changes from the minimal runtime:
// - the login ID is the student ID chosen at registration (the iy- ID still works);
// - a session lasts 14 days on its device (was 1 hour);
// - a signed-in session keeps working for 48 hours while the Bot host cannot be reached (new logins,
//   registrations and password changes still need it); a membership answer is reused for 10 minutes;
// - access administrators are the chair, listed IDs and listed roles (was none);
// - real names come from an operator roster, never from guesses;
// - `/register` by a registered person resets a forgotten password (was refused);
// - a committee roster (Discord ID -> student ID, operator file) gives people their student ID login
//   from the start; an ID the person sets in the settings takes precedence over the roster.
// Sign-in records and bulk issue:
// - wrong passwords are counted per account since the last sign-in and shown at the next one, and
//   every sign-in, registration and code event goes to the sign-in log for access administrators;
// - besides 5 tries in 10 minutes, an account takes at most 15 wrong passwords in 24 hours;
// - the committee may bulk-issue codes valid for days to members who have not registered; a
//   registered account is never touched by it.

const UID = /^[1-9]\d{16,19}$/;
export const STUDENT_ID = /^[0-9A-Z]{5,12}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SESSIONS_PER_ACCOUNT = 10;
const DAY_MS = 86_400_000;
/** Tries per account in 10 minutes (sign-in and password re-entry). */
export const ACCOUNT_TRIES_PER_10_MIN = 5;
/** Wrong passwords per account in 24 hours. */
export const ACCOUNT_FAILURES_PER_DAY = 15;
/** A bulk-issued code is valid for at least an hour and at most 8 days. */
export const BULK_CODE_MIN_MS = 3_600_000;
export const BULK_CODE_MAX_MS = 8 * DAY_MS;

export class AccountError extends Error {
  constructor(readonly code: 'REJECTED' | 'RATE_LIMITED' | 'DEPENDENCY_UNAVAILABLE' | 'STUDENT_ID_TAKEN' | 'STUDENT_ID_REQUIRED') {
    super(code);
  }
}

const reject = (): never => {
  throw new AccountError('REJECTED');
};
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const trimWindow = (times: number[], now: number, window = 600_000) => times.filter((t) => t > now - window && t <= now);

/** Normalizes a typed student ID: full-width digits/letters to ASCII, letters to upper case. */
export function normalizeStudentId(input: string): string | null {
  const value = input.normalize('NFKC').trim().toUpperCase();
  return STUDENT_ID.test(value) ? value : null;
}

/** The Bot host's answer about one guild member (contract of /v1/discord/member). */
export interface MemberObservation {
  kind: 'discord_member/v1';
  guildId: string;
  discordUserId: string;
  linkId: string | null;
  joinEpochMs: number | null;
  current: boolean;
  bot: boolean;
  roleIds: string[];
  observedAtMs: number;
  taskUserId: string | null;
}

export interface RegistrationEnvelope {
  kind: 'registration_code';
  deliveryId: string;
  template: 'password_setup_code_v2';
  purpose: 'password_setup';
  audience: string;
  recipient: { discordUserId: string; linkId: string; linkVersion: number };
  code: string;
  expiresAt: string;
  context: { serviceLabel: string; requestedAt: string; initialLoginId: string; registrationUrl: string };
}

export interface AccountServiceOptions {
  config: DiscordAuthConfig;
  store: AccountStore;
  member: (discordUserId: string, signal: AbortSignal) => Promise<MemberObservation>;
  deliver: (envelope: RegistrationEnvelope, signal: AbortSignal) => Promise<{ deliveryId: string; status: 'delivered' | 'failed' }>;
  hasher?: PasswordHasher;
  now?: () => number;
  dependencyTimeoutMs?: number;
  /** Committee roster: the student ID of a Discord user, or null. */
  rosterStudentId?: (discordUserId: string) => string | null;
  /** Sign-in log; none in tests that do not look at it. */
  audit?: LoginAudit;
}

/** What a sign-in tells the person about the sign-ins before it. */
export interface SignInRecord {
  previousLoginAt: number | null;
  /** Wrong passwords for the account between the previous sign-in and this one. */
  failedSince: number;
}

/** One account as access administrators see it when looking into sign-ins (no secrets). */
export interface AccountActivity {
  initialLoginId: string;
  discordUserId: string;
  studentId: string | null;
  status: Account['status'];
  lastLoginAt: number | null;
  failedSinceLogin: number;
  failures24h: number;
  /** Sign-in is refused now by a per-account limit. */
  limited: boolean;
  pendingCode: { expiresAt: number; bulk: boolean; attempts: number } | null;
  sessions: number;
}

export type BulkIssueResult = { status: 'issued'; initialLoginId: string; code: string; expiresAt: number } | { status: 'would_issue' } | { status: 'skipped'; reason: 'active' };

/** What the rest of the app needs to know about a signed-in account. */
export interface AccountIdentity {
  initialLoginId: string;
  discordUserId: string;
  studentId: string | null;
  /** An operator-issued item account (temporary-staff.ts), not a committee member. */
  temporaryStaff?: boolean;
  departments: string[];
  admin: boolean;
  /** True when this answer relies on the stored membership because the Bot host was unreachable. */
  degraded: boolean;
}

/** A signed-in session: the account plus server-side facts about this sign-in (never sent to the browser). */
export interface SessionIdentity extends AccountIdentity {
  /** Stable key of this session (the stored digest of its token); a new sign-in or re-entry gets a new key. */
  sessionKey: string;
  /** When the password was last typed on this session (sign-in, registration, password change or re-entry). */
  passwordAt: number;
  /** Shown to the person: the sign-in before this session's and the wrong passwords since then. */
  signIn: SignInRecord;
}

export class DiscordAccountService {
  private readonly config: DiscordAuthConfig;
  private readonly hasher: PasswordHasher;
  private readonly now: () => number;
  /** discordUserId -> last successful live observation, reused for memberCacheMinutes. */
  private readonly memberCache = new Map<string, { at: number; member: MemberObservation }>();

  constructor(private readonly o: AccountServiceOptions) {
    this.config = o.config;
    this.hasher = o.hasher ?? new PasswordHasher();
    this.now = o.now ?? Date.now;
  }

  get sessionLifetimeMs(): number {
    return this.config.sessionDays * 86_400_000;
  }

  private digest(domain: string, ...parts: string[]): string {
    return createHmac('sha256', this.config.pepper).update(JSON.stringify([domain, ...parts])).digest('hex');
  }

  private log(kind: LoginEventKind, e: { loginId?: string | null; account?: string | null; client?: string | null; reason?: LoginEventReason }): void {
    this.o.audit?.record({ at: this.now(), kind, loginId: e.loginId ?? null, account: e.account ?? null, client: e.client ?? null, ...(e.reason ? { reason: e.reason } : {}) });
  }

  /** Takes one sign-in try for the account, unless a per-account limit refuses it. */
  private takeTry(uid: string, expectedVersion: number | null): 'ok' | 'not_active' | 'account_limit' {
    return this.o.store.transact((s) => {
      const v = s.accounts[uid]!;
      const now = this.now();
      v.loginFailures = trimWindow(v.loginFailures, now);
      v.dailyFailures = trimWindow(v.dailyFailures ?? [], now, DAY_MS);
      if (v.status !== 'active' || (expectedVersion !== null && v.version !== expectedVersion)) return 'not_active';
      if (v.loginFailures.length >= ACCOUNT_TRIES_PER_10_MIN || v.dailyFailures.length >= ACCOUNT_FAILURES_PER_DAY) return 'account_limit';
      v.loginFailures.push(now);
      return 'ok';
    });
  }

  private countWrongPassword(uid: string): void {
    this.o.store.transact((s) => {
      const v = s.accounts[uid];
      if (!v) return;
      const now = this.now();
      v.failedSinceLogin = (v.failedSinceLogin ?? 0) + 1;
      v.dailyFailures = [...trimWindow(v.dailyFailures ?? [], now, DAY_MS), now];
    });
  }

  private newAccount(s: AccountState, uid: string, m: MemberObservation, now: number): Account {
    if (s.nextInitialId > 99_999_999) reject();
    const account: Account = {
      initialLoginId: `iy-${String(s.nextInitialId++).padStart(8, '0')}`,
      guildId: this.config.guildId,
      discordUserId: uid,
      joinEpochMs: m.joinEpochMs!,
      version: 1,
      status: 'pending',
      password: null,
      taskUserId: m.taskUserId,
      existingRoleIds: [...m.roleIds],
      issueTimes: [],
      loginFailures: [],
      registrationFailures: [],
      pending: null,
      studentId: null,
      memberVerifiedAt: now,
    };
    s.accounts[uid] = account;
    return account;
  }

  private async bounded<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.timeout(this.o.dependencyTimeoutMs ?? 10_000);
    return call(signal);
  }

  permitsRegistrationSubject(uid: unknown): uid is string {
    return typeof uid === 'string' && UID.test(uid) && BigInt(uid) < 2n ** 64n && !this.config.excludedSharedDiscordUserIds.includes(uid);
  }

  private isAdmin(uid: string, roleIds: string[]): boolean {
    if (isTemporaryStaffId(uid)) return false;
    return uid === this.config.bootstrapDiscordUserId || this.config.adminDiscordUserIds.includes(uid) || roleIds.some((r) => this.config.adminRoleIds.includes(r));
  }

  private departments(roleIds: string[]): string[] {
    return [...new Set(roleIds.filter((r) => Object.hasOwn(this.config.departmentRoleIds, r)).map((r) => this.config.departmentRoleIds[r]!))].sort();
  }

  private retire(s: AccountState, a: Account): void {
    if (a.status !== 'retired') a.version += 1;
    a.status = 'retired';
    a.password = null;
    a.pending = null;
    for (const [key, v] of Object.entries(s.sessions)) if (v.discordUserId === a.discordUserId) delete s.sessions[key];
  }

  private validObservation(m: MemberObservation, uid: string): boolean {
    const now = this.now();
    const linkValid = m.current
      ? m.linkId === `dcg:${this.config.guildId}:${uid}` && Number.isSafeInteger(m.joinEpochMs) && m.joinEpochMs !== null && m.joinEpochMs > 0 && m.joinEpochMs <= now
      : m.linkId === null && m.joinEpochMs === null;
    return (
      m.kind === 'discord_member/v1' &&
      m.guildId === this.config.guildId &&
      m.discordUserId === uid &&
      linkValid &&
      Number.isSafeInteger(m.observedAtMs) &&
      m.observedAtMs <= now + 1000 &&
      now - m.observedAtMs <= 15_000 &&
      typeof m.bot === 'boolean' &&
      Array.isArray(m.roleIds) &&
      m.roleIds.length <= 250 &&
      m.roleIds.every((r) => typeof r === 'string' && UID.test(r)) &&
      new Set(m.roleIds).size === m.roleIds.length
    );
  }

  /**
   * Current membership of `uid`. `live` asks the Bot host now (login, registration, password change).
   * Otherwise a cached answer is reused, and if the Bot host cannot be reached the account's last
   * confirmed membership is accepted within the grace period. A member who left is retired.
   */
  private async qualify(uid: string, live: boolean): Promise<{ roleIds: string[]; degraded: boolean; member: MemberObservation | null }> {
    // Temporary staff are not Discord members: their stored account alone decides, and the operator can stop them all.
    if (isTemporaryStaffId(uid)) {
      const account = this.o.store.read((s) => s.accounts[uid]);
      if (process.env.SMM_TEMPORARY_STAFF_DISABLED === '1' || !isTemporaryStaffAccount(account) || account!.status !== 'active') reject();
      return { roleIds: [], degraded: false, member: null };
    }
    if (!this.permitsRegistrationSubject(uid)) reject();
    const now = this.now();
    const cached = this.memberCache.get(uid);
    if (!live && cached && now - cached.at < this.config.memberCacheMinutes * 60_000) return { roleIds: cached.member.roleIds, degraded: false, member: cached.member };
    let m: MemberObservation;
    try {
      m = await this.bounded((signal) => this.o.member(uid, signal));
      if (!this.validObservation(m, uid)) throw new Error('MEMBER_REJECTED');
    } catch {
      if (!live) {
        const stored = this.o.store.read((s) => s.accounts[uid]);
        if (stored && stored.status === 'active' && stored.memberVerifiedAt !== null && now - stored.memberVerifiedAt <= this.config.memberGraceHours * 3_600_000) {
          return { roleIds: stored.existingRoleIds, degraded: true, member: null };
        }
      }
      throw new AccountError('DEPENDENCY_UNAVAILABLE');
    }
    const eligible = m.current && !m.bot;
    this.o.store.transact((s) => {
      const a = s.accounts[uid];
      if (a && (!eligible || a.joinEpochMs !== m.joinEpochMs)) this.retire(s, a);
      if (a && eligible) {
        a.existingRoleIds = [...m.roleIds];
        a.memberVerifiedAt = now;
      }
    });
    if (!eligible) {
      this.memberCache.delete(uid);
      reject();
    }
    this.memberCache.set(uid, { at: now, member: m });
    return { roleIds: m.roleIds, degraded: false, member: m };
  }

  /** Called only by the signed issuer route after an authenticated Discord self-interaction. */
  async issueRegistration(uid: string): Promise<{ initialLoginId: string; deliveryStatus: 'delivered' }> {
    if (isTemporaryStaffId(uid)) reject();
    const { member } = await this.qualify(uid, true);
    const m = member!;
    const now = this.now();
    const deliveryId = `dl_${randomBytes(16).toString('hex')}`;
    let code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const a = this.o.store.transact((s) => {
      const account = s.accounts[uid] ?? this.newAccount(s, uid, m, now);
      if (account.status === 'retired' && account.joinEpochMs === m.joinEpochMs) reject();
      // A registered person who runs /register again is resetting a forgotten password: only they can
      // trigger it (Discord self-interaction); the old password and every session end now.
      if (account.status === 'active') for (const [key, v] of Object.entries(s.sessions)) if (v.discordUserId === uid) delete s.sessions[key];
      for (let retry = 0; account.pending && same(account.pending.codeHash, this.digest('registration-code', uid, String(account.version), account.pending.deliveryId, code)); retry++) {
        if (retry >= 4) reject();
        code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      }
      account.issueTimes = trimWindow(account.issueTimes, now);
      if (account.issueTimes.length >= 3 || account.issueTimes.some((t) => now - t < 30_000)) throw new AccountError('RATE_LIMITED');
      account.issueTimes.push(now);
      account.joinEpochMs = m.joinEpochMs!;
      account.status = 'pending';
      account.version += 1;
      account.password = null;
      account.registrationFailures = [];
      account.pending = { purpose: 'password_setup', deliveryId, codeHash: this.digest('registration-code', uid, String(account.version), deliveryId, code), expiresAt: now + 300_000, attempts: 0, state: 'waiting_ack' };
      return account;
    });
    const audience = this.config.registrationAudience;
    const envelope: RegistrationEnvelope = {
      kind: 'registration_code',
      deliveryId,
      template: 'password_setup_code_v2',
      purpose: 'password_setup',
      audience,
      recipient: { discordUserId: uid, linkId: m.linkId!, linkVersion: m.joinEpochMs! },
      code,
      expiresAt: new Date(now + 300_000).toISOString(),
      context: { serviceLabel: '医薬祭', requestedAt: new Date(now).toISOString(), initialLoginId: a.initialLoginId, registrationUrl: `${audience}/register` },
    };
    try {
      const ack = await this.bounded((signal) => this.o.deliver(envelope, signal));
      if (ack.deliveryId !== deliveryId || ack.status !== 'delivered') throw new Error('ACK_REJECTED');
      await this.qualify(uid, true);
      this.o.store.transact((s) => {
        const current = s.accounts[uid]!;
        if (current.version !== a.version || current.status !== 'pending' || current.pending?.deliveryId !== deliveryId || current.pending.expiresAt <= this.now()) reject();
        current.pending!.state = 'ready';
      });
      this.log('code_issued', { account: a.initialLoginId });
      return { initialLoginId: a.initialLoginId, deliveryStatus: 'delivered' };
    } catch {
      this.o.store.transact((s) => {
        const current = s.accounts[uid];
        if (current?.pending?.deliveryId === deliveryId) current.pending = null;
      });
      throw new AccountError('DEPENDENCY_UNAVAILABLE');
    }
  }

  /**
   * The committee's bulk issue (signed route, run from the Bot host): a code valid until `expiresAt` for a
   * member who has not registered. A registered account is never touched: its password and sign-ins stay.
   * The code goes back to the caller, which sends it by DM; `dryRun` only says what would happen.
   */
  async issueBulkRegistration(uid: string, expiresAt: number, dryRun: boolean): Promise<BulkIssueResult> {
    if (isTemporaryStaffId(uid)) reject();
    const { member } = await this.qualify(uid, true);
    const m = member!;
    const now = this.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now + BULK_CODE_MIN_MS || expiresAt > now + BULK_CODE_MAX_MS) reject();
    const existing = this.o.store.read((s) => s.accounts[uid] ?? null);
    if (existing?.status === 'active') return { status: 'skipped', reason: 'active' };
    if (existing?.status === 'retired' && existing.joinEpochMs === m.joinEpochMs) reject();
    if (dryRun) return { status: 'would_issue' };
    const deliveryId = `bulk_${randomBytes(16).toString('hex')}`;
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const issued = this.o.store.transact((s) => {
      const account = s.accounts[uid] ?? this.newAccount(s, uid, m, now);
      // Registered meanwhile: left as it is.
      if (account.status === 'active') return null;
      if (account.status === 'retired' && account.joinEpochMs === m.joinEpochMs) reject();
      account.issueTimes = trimWindow(account.issueTimes, now);
      if (account.issueTimes.length >= 3 || account.issueTimes.some((t) => now - t < 30_000)) throw new AccountError('RATE_LIMITED');
      account.issueTimes.push(now);
      account.joinEpochMs = m.joinEpochMs!;
      account.status = 'pending';
      account.version += 1;
      account.password = null;
      account.registrationFailures = [];
      account.pending = { purpose: 'password_setup', deliveryId, codeHash: this.digest('registration-code', uid, String(account.version), deliveryId, code), expiresAt, attempts: 0, state: 'ready', bulk: true };
      return account.initialLoginId;
    });
    if (!issued) return { status: 'skipped', reason: 'active' };
    this.log('code_bulk_issued', { account: issued });
    return { status: 'issued', initialLoginId: issued, code, expiresAt };
  }

  /** The person's own student ID, else the committee roster's (only when no other account claims it). */
  private studentIdOf(s: Readonly<AccountState>, a: Account): string | null {
    if (a.studentId) return a.studentId;
    const roster = this.o.rosterStudentId?.(a.discordUserId) ?? null;
    if (!roster) return null;
    const claimed = Object.values(s.accounts).some((other) => other.discordUserId !== a.discordUserId && other.studentId === roster && other.status !== 'retired');
    return claimed ? null : roster;
  }

  private studentIdTaken(s: Readonly<AccountState>, uid: string, studentId: string): boolean {
    // The temporary staff number range is reserved: members cannot take those numbers.
    if (isStaffStudentId(studentId) && !isTemporaryStaffId(uid)) return true;
    return Object.values(s.accounts).some((other) => other.discordUserId !== uid && other.status !== 'retired' && this.studentIdOf(s, other) === studentId);
  }

  private findByLoginId(s: Readonly<AccountState>, loginId: string): Account | undefined {
    const value = loginId.normalize('NFKC').trim();
    if (/^iy-\d{8}$/i.test(value)) return Object.values(s.accounts).find((a) => a.initialLoginId === value.toLowerCase());
    const studentId = normalizeStudentId(value);
    return studentId ? Object.values(s.accounts).find((a) => a.status !== 'retired' && this.studentIdOf(s, a) === studentId) : undefined;
  }

  /**
   * The code from the DM, a new password and the student ID that becomes the login ID. The student ID may
   * be left empty when the person already has one (a password reset) or the committee roster has one.
   */
  async completeRegistration(input: { initialLoginId: string; code: string; password: string; studentId: string; client?: string | null }): Promise<void> {
    const client = input.client ?? null;
    const typed = input.studentId.trim() ? normalizeStudentId(input.studentId) : null;
    if (!/^iy-\d{8}$/.test(input.initialLoginId) || !/^\d{8}$/.test(input.code) || checkPasswordPolicy(input.password, null) || (input.studentId.trim() && !typed)) reject();
    const snapshot = this.o.store.read((s) => Object.values(s.accounts).find((a) => a.initialLoginId === input.initialLoginId));
    if (!snapshot) {
      this.log('register_failed', { loginId: input.initialLoginId, client, reason: 'unknown_id' });
      reject();
    }
    const account = snapshot!.initialLoginId;
    const studentId = typed ?? snapshot!.studentId ?? this.o.rosterStudentId?.(snapshot!.discordUserId) ?? null;
    if (!studentId) throw new AccountError('STUDENT_ID_REQUIRED');
    await this.qualify(snapshot!.discordUserId, true);
    const codeOk = (a: Account) => {
      const p = a.pending;
      return !!p && p.state === 'ready' && p.expiresAt > this.now() && p.attempts < 5 && same(p.codeHash, this.digest('registration-code', a.discordUserId, String(a.version), p.deliveryId, input.code));
    };
    const verdict = this.o.store.transact((s): 'ok' | 'no_code' | 'account_limit' | 'wrong_code' => {
      const a = s.accounts[snapshot!.discordUserId]!;
      const now = this.now();
      a.registrationFailures = trimWindow(a.registrationFailures, now);
      if (a.status !== 'pending' || !a.pending || a.pending.state !== 'ready' || a.pending.expiresAt <= now) return 'no_code';
      if (a.pending.attempts >= 5 || a.registrationFailures.length >= 5) return 'account_limit';
      if (!codeOk(a)) {
        a.pending.attempts += 1;
        a.registrationFailures.push(now);
        if (a.pending.attempts >= 5) a.pending = null;
        return 'wrong_code';
      }
      return a.version === snapshot!.version ? 'ok' : 'no_code';
    });
    if (verdict !== 'ok') {
      this.log(verdict === 'account_limit' ? 'register_blocked' : 'register_failed', { loginId: input.initialLoginId, account, client, reason: verdict });
      reject();
    }
    const hash = await this.hasher.hash(input.password);
    await this.qualify(snapshot!.discordUserId, true);
    this.o.store.transact((s) => {
      const a = s.accounts[snapshot!.discordUserId]!;
      if (a.status !== 'pending' || a.version !== snapshot!.version || !codeOk(a)) reject();
      if (this.studentIdTaken(s, a.discordUserId, studentId)) throw new AccountError('STUDENT_ID_TAKEN');
      a.password = hash;
      a.status = 'active';
      a.pending = null;
      a.version += 1;
      a.registrationFailures = [];
      a.studentId = studentId;
    });
    this.log('register_ok', { account, client });
  }

  private newSession(s: AccountState, a: Account, signIn: SignInRecord): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    for (const [k, v] of Object.entries(s.sessions)) if (v.expiresAt <= now) delete s.sessions[k];
    const current = Object.entries(s.sessions)
      .filter(([, v]) => v.discordUserId === a.discordUserId)
      .sort((x, y) => x[1].expiresAt - y[1].expiresAt);
    while (current.length >= MAX_SESSIONS_PER_ACCOUNT) delete s.sessions[current.shift()![0]];
    s.sessions[this.digest('session', token)] = {
      discordUserId: a.discordUserId,
      version: a.version,
      createdAt: now,
      expiresAt: now + this.sessionLifetimeMs,
      previousLoginAt: signIn.previousLoginAt,
      failedBefore: signIn.failedSince,
    };
    return token;
  }

  /**
   * Student ID (or iy- ID) and password. Needs the Bot host (live membership check). Tells the person when
   * they last signed in and how many wrong passwords the account had since then.
   */
  async login(input: { loginId: string; password: string; client?: string | null }): Promise<{ sessionToken: string } & SignInRecord> {
    if (typeof input.password !== 'string' || input.password.length > 1024 || typeof input.loginId !== 'string' || input.loginId.length > 64) reject();
    const client = input.client ?? null;
    const loginId = loggableLoginId(input.loginId);
    const a = this.o.store.read((s) => this.findByLoginId(s, input.loginId));
    if (!a) {
      await this.hasher.verify(input.password, null);
      this.log('login_failed', { loginId, client, reason: 'unknown_id' });
      reject();
    }
    const account = a!.initialLoginId;
    await this.qualify(a!.discordUserId, true);
    const permitted = this.takeTry(a!.discordUserId, a!.version);
    if (permitted === 'not_active') {
      this.log('login_failed', { loginId, account, client, reason: 'not_active' });
      reject();
    }
    if (permitted === 'account_limit') {
      this.log('login_blocked', { loginId, account, client, reason: 'account_limit' });
      throw new AccountError('RATE_LIMITED');
    }
    if (!(await this.hasher.verify(input.password, a!.password))) {
      this.countWrongPassword(a!.discordUserId);
      this.log('login_failed', { loginId, account, client, reason: 'wrong_password' });
      reject();
    }
    const result = this.o.store.transact((s) => {
      const v = s.accounts[a!.discordUserId]!;
      if (v.status !== 'active' || v.version !== a!.version || JSON.stringify(v.password) !== JSON.stringify(a!.password)) reject();
      const signIn: SignInRecord = { previousLoginAt: v.lastLoginAt ?? null, failedSince: v.failedSinceLogin ?? 0 };
      v.loginFailures = [];
      v.dailyFailures = [];
      v.failedSinceLogin = 0;
      v.lastLoginAt = this.now();
      return { sessionToken: this.newSession(s, v, signIn), ...signIn };
    });
    this.log('login_ok', { loginId, account, client });
    return result;
  }

  /** Resolves a session token. Reuses membership answers and tolerates a Bot host outage within the grace period. */
  async authenticate(token: string): Promise<SessionIdentity> {
    if (!SESSION_TOKEN.test(token)) reject();
    const sessionHash = this.digest('session', token);
    const a = this.o.store.read((s) => {
      const v = s.sessions[sessionHash];
      const account = v && s.accounts[v.discordUserId];
      return v && account && v.expiresAt > this.now() && v.version === account.version && account.status === 'active' && this.cardSessionValid(s, v) ? account : null;
    });
    if (!a) reject();
    const { roleIds, degraded } = await this.qualify(a!.discordUserId, false);
    const session = this.o.store.read((s) => {
      const v = s.sessions[sessionHash];
      const account = s.accounts[a!.discordUserId]!;
      return v && v.expiresAt > this.now() && v.version === account.version && account.status === 'active' && this.cardSessionValid(s, v) ? v : null;
    });
    if (!session) reject();
    const studentId = this.o.store.read((s) => this.studentIdOf(s, s.accounts[a!.discordUserId]!));
    return {
      initialLoginId: a!.initialLoginId,
      discordUserId: a!.discordUserId,
      studentId,
      temporaryStaff: isTemporaryStaffAccount(a),
      departments: isTemporaryStaffAccount(a) ? ['臨時スタッフ'] : this.departments(roleIds),
      admin: this.isAdmin(a!.discordUserId, roleIds),
      degraded,
      sessionKey: sessionHash,
      passwordAt: session!.passwordAt ?? session!.createdAt,
      signIn: { previousLoginAt: session!.previousLoginAt ?? null, failedSince: session!.failedBefore ?? 0 },
    };
  }

  /** For access administrators looking into sign-ins: every account's record and pending code (no secrets). */
  accountActivity(): AccountActivity[] {
    const now = this.now();
    return this.o.store.read((s) =>
      Object.values(s.accounts).map((a) => {
        const failures24h = trimWindow(a.dailyFailures ?? [], now, DAY_MS).length;
        const p = a.pending;
        return {
          initialLoginId: a.initialLoginId,
          discordUserId: a.discordUserId,
          studentId: this.studentIdOf(s, a),
          status: a.status,
          lastLoginAt: a.lastLoginAt ?? null,
          failedSinceLogin: a.failedSinceLogin ?? 0,
          failures24h,
          limited: a.status === 'active' && (trimWindow(a.loginFailures, now).length >= ACCOUNT_TRIES_PER_10_MIN || failures24h >= ACCOUNT_FAILURES_PER_DAY),
          pendingCode: p && p.state === 'ready' && p.expiresAt > now ? { expiresAt: p.expiresAt, bulk: p.bulk === true, attempts: p.attempts } : null,
          sessions: Object.values(s.sessions).filter((x) => x.discordUserId === a.discordUserId && x.expiresAt > now && x.version === a.version).length,
        };
      }),
    );
  }

  /** Accounts that can sign in now, from stored data without any check (for choosing people, never for authorization). */
  listActiveIdentities(): Omit<AccountIdentity, 'degraded'>[] {
    return this.o.store.read((s) =>
      Object.values(s.accounts)
        .filter((a) => a.status === 'active')
        .map((a) => ({ initialLoginId: a.initialLoginId, discordUserId: a.discordUserId, studentId: this.studentIdOf(s, a), temporaryStaff: isTemporaryStaffAccount(a), departments: isTemporaryStaffAccount(a) ? ['臨時スタッフ'] : this.departments(a.existingRoleIds), admin: this.isAdmin(a.discordUserId, a.existingRoleIds) })),
    );
  }

  /** Stored identity without any check (for showing who acted, never for authorization). */
  identityByLoginId(initialLoginId: string): Omit<AccountIdentity, 'degraded'> | null {
    const a = this.o.store.read((s) => Object.values(s.accounts).find((x) => x.initialLoginId === initialLoginId) ?? null);
    if (!a || a.status !== 'active') return null;
    const studentId = this.o.store.read((s) => this.studentIdOf(s, s.accounts[a.discordUserId]!));
    return { initialLoginId: a.initialLoginId, discordUserId: a.discordUserId, studentId, temporaryStaff: isTemporaryStaffAccount(a), departments: isTemporaryStaffAccount(a) ? ['臨時スタッフ'] : this.departments(a.existingRoleIds), admin: this.isAdmin(a.discordUserId, a.existingRoleIds) };
  }

  /** The password typed again on a signed-in device; counted and limited like a sign-in. */
  private async withVerifiedPassword(token: string, password: string, client: string | null): Promise<{ account: Account; sessionHash: string; signIn: SignInRecord }> {
    const identity = await this.authenticate(token);
    await this.qualify(identity.discordUserId, true);
    const sessionHash = this.digest('session', token);
    const account = this.o.store.read((s) => s.accounts[identity.discordUserId]!);
    const permitted = this.takeTry(identity.discordUserId, null);
    if (permitted !== 'ok') {
      this.log('login_blocked', { account: account.initialLoginId, client, reason: 'account_limit' });
      throw new AccountError('RATE_LIMITED');
    }
    if (typeof password !== 'string' || password.length > 1024 || !(await this.hasher.verify(password, account.password))) {
      this.countWrongPassword(identity.discordUserId);
      this.log('password_failed', { account: account.initialLoginId, client, reason: 'wrong_password' });
      reject();
    }
    this.o.store.transact((s) => {
      s.accounts[identity.discordUserId]!.loginFailures = [];
    });
    return { account, sessionHash, signIn: identity.signIn };
  }

  /** New password; every session of the account ends and this device gets a new one. */
  async changePassword(input: { sessionToken: string; currentPassword: string; newPassword: string; client?: string | null }): Promise<{ sessionToken: string }> {
    if (checkPasswordPolicy(input.newPassword, null)) reject();
    const { account, signIn } = await this.withVerifiedPassword(input.sessionToken, input.currentPassword, input.client ?? null);
    const hash = await this.hasher.hash(input.newPassword);
    return this.o.store.transact((s) => {
      const v = s.accounts[account.discordUserId]!;
      if (v.version !== account.version || v.status !== 'active') reject();
      v.password = hash;
      v.version += 1;
      for (const [key, se] of Object.entries(s.sessions)) if (se.discordUserId === v.discordUserId) delete s.sessions[key];
      return { sessionToken: this.newSession(s, v, signIn) };
    });
  }

  /**
   * The password typed again on a signed-in device (the mail screens ask for it after a period without
   * use). The session is replaced by a new one, whose creation time marks this entry.
   */
  async reauthenticate(input: { sessionToken: string; password: string; client?: string | null }): Promise<{ sessionToken: string }> {
    const { account, sessionHash, signIn } = await this.withVerifiedPassword(input.sessionToken, input.password, input.client ?? null);
    return this.o.store.transact((s) => {
      const v = s.accounts[account.discordUserId]!;
      if (v.version !== account.version || v.status !== 'active' || !s.sessions[sessionHash]) reject();
      delete s.sessions[sessionHash];
      return { sessionToken: this.newSession(s, v, signIn) };
    });
  }

  /** Sets or corrects the student ID used to sign in (password required). */
  async setStudentId(input: { sessionToken: string; password: string; studentId: string; client?: string | null }): Promise<void> {
    const studentId = normalizeStudentId(input.studentId);
    if (!studentId) throw new AccountError('REJECTED');
    const { account } = await this.withVerifiedPassword(input.sessionToken, input.password, input.client ?? null);
    this.o.store.transact((s) => {
      if (this.studentIdTaken(s, account.discordUserId, studentId)) throw new AccountError('STUDENT_ID_TAKEN');
      // A temporary staff account's number is its identity; it cannot be changed.
      if (isTemporaryStaffAccount(account) && account.studentId !== studentId) reject();
      s.accounts[account.discordUserId]!.studentId = studentId;
    });
  }

  private cardState(s: AccountState): CardAuthState {
    return s.cardAuth ??= { cards: {}, devices: {}, events: [] };
  }

  private cardEvent(s: AccountState, kind: string, actor: string, subject: string, id: string): void {
    const state = this.cardState(s);
    state.events.push({ at: this.now(), kind, actor, subject, id });
    // Records contain public IDs only, never card URLs, cookie secrets or IDm.
    state.events = state.events.slice(-2000);
  }

  private cardSessionValid(s: Readonly<AccountState>, session: import('./store.js').Session): boolean {
    if (!session.cardId) return true;
    const state = s.cardAuth;
    const c = state?.cards[session.cardId];
    const device = Object.values(state?.devices ?? {}).find(d => d.id === session.deviceId);
    return !!c && c.discordUserId === session.discordUserId && c.version === session.version && c.revokedAt === null && c.activatedAt !== null && c.expiresAt > this.now() && !!device && device.expiresAt > this.now() && device.grants[session.discordUserId] === session.version;
  }

  /** A recent password sign-in is enough for setup; card sessions never satisfy this proof. */
  private async cardProof(token: string, password?: string): Promise<{ account: Account; sessionHash: string }> {
    const identity = await this.authenticate(token);
    if (password !== undefined) return this.withVerifiedPassword(token, password, null);
    if (identity.passwordAt <= this.now() - 300_000) throw new CardAuthError('card_forbidden');
    await this.qualify(identity.discordUserId, true);
    return { account: this.o.store.read(s => s.accounts[identity.discordUserId]!), sessionHash: identity.sessionKey };
  }

  private checkCardProof(s: AccountState, proof: { account: Account; sessionHash: string }, admin = false): Account {
    const a = s.accounts[proof.account.discordUserId];
    const se = s.sessions[proof.sessionHash];
    if (!a || a.status !== 'active' || a.version !== proof.account.version || !se || se.expiresAt <= this.now() || se.version !== a.version || !this.cardSessionValid(s, se) || (admin && !this.isAdmin(a.discordUserId, a.existingRoleIds))) throw new CardAuthError('card_forbidden');
    return a;
  }

  async registerCardDevice(token: string, deviceToken: string | null, label: string, password?: string): Promise<string> {
    const proof = await this.cardProof(token, password);
    if (!label.trim() || label.length > 80) reject();
    const existing = deviceToken && SESSION_TOKEN.test(deviceToken) ? deviceToken : null;
    const valid = existing && this.o.store.read(s => (s.cardAuth?.devices[this.digest('card-device', existing)]?.expiresAt ?? 0) > this.now());
    const secret = valid ? existing! : randomBytes(32).toString('base64url');
    this.o.store.transact(s => {
      const a = this.checkCardProof(s, proof);
      const state = this.cardState(s);
      const key = this.digest('card-device', secret);
      const count = Object.values(state.devices).filter(d => d.expiresAt > this.now() && d.grants[a.discordUserId] === a.version).length;
      if (count >= 10 && state.devices[key]?.grants[a.discordUserId] !== a.version) throw new CardAuthError('card_limit');
      const d = state.devices[key] ?? { id: randomBytes(16).toString('hex'), label: label.trim(), expiresAt: 0, grants: {} };
      d.label = label.trim();
      d.expiresAt = this.now() + DEVICE_DAYS * DAY_MS;
      d.grants[a.discordUserId] = a.version;
      state.devices[key] = d;
      this.cardEvent(s, 'device_registered', a.discordUserId, a.discordUserId, d.id);
    });
    return secret;
  }

  async loginCardSettings(token: string, deviceToken: string | null): Promise<CardSettings> {
    const actor = await this.authenticate(token);
    return this.o.store.read(s => {
      const state = s.cardAuth;
      const current = deviceToken ? state?.devices[this.digest('card-device', deviceToken)] : undefined;
      return {
        cards: Object.values(state?.cards ?? {}).filter(c => actor.admin || c.discordUserId === actor.discordUserId).map(c => cardView(c, s.accounts[c.discordUserId]!.initialLoginId, this.now(), s.accounts[c.discordUserId]!.version)),
        devices: Object.values(state?.devices ?? {}).filter(d => d.expiresAt > this.now() && d.grants[actor.discordUserId] === s.accounts[actor.discordUserId]!.version).map(d => ({ id: d.id, label: d.label, expiresAt: d.expiresAt, current: d.id === current?.id })),
        deviceRegistered: !!current && current.expiresAt > this.now() && current.grants[actor.discordUserId] === s.accounts[actor.discordUserId]!.version,
        people: actor.admin ? Object.values(s.accounts).filter(a => a.status === 'active').map(a => ({ account: a.initialLoginId, name: this.studentIdOf(s, a) ?? a.initialLoginId })) : [],
      };
    });
  }

  async issueLoginCard(token: string, account: string, label: string, password?: string): Promise<{ id: string; secret: string }> {
    const proof = await this.cardProof(token, password);
    if (!label.trim() || label.length > 80) reject();
    const id = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    this.o.store.transact(s => {
      const actor = this.checkCardProof(s, proof, true);
      const target = Object.values(s.accounts).find(a => a.initialLoginId === account && a.status === 'active');
      if (!target) reject();
      const state = this.cardState(s);
      if (Object.values(state.cards).filter(c => c.discordUserId === target!.discordUserId && c.revokedAt === null && c.version === target!.version && c.expiresAt > this.now()).length >= 3) throw new CardAuthError('card_limit');
      state.cards[id] = { id, tokenHash: this.digest('login-card', secret), discordUserId: target!.discordUserId, version: target!.version, label: label.trim(), createdAt: this.now(), expiresAt: this.now() + 600_000, lastUsedAt: null, activatedAt: null, revokedAt: null };
      this.cardEvent(s, 'card_issued_pending', actor.discordUserId, target!.discordUserId, id);
    });
    return { id, secret };
  }

  async activateLoginCard(token: string, id: string, password?: string): Promise<void> {
    const proof = await this.cardProof(token, password);
    this.o.store.transact(s => {
      const actor = this.checkCardProof(s, proof, true);
      const c = this.cardState(s).cards[id];
      if (!c || c.revokedAt !== null || c.activatedAt !== null || c.expiresAt <= this.now() || s.accounts[c.discordUserId]?.status !== 'active' || s.accounts[c.discordUserId]?.version !== c.version) throw new CardAuthError('card_rejected');
      c.activatedAt = this.now();
      c.expiresAt = this.now() + CARD_DAYS * DAY_MS;
      this.cardEvent(s, 'card_activated', actor.discordUserId, c.discordUserId, id);
    });
  }

  async revokeLoginCard(token: string, id: string): Promise<void> {
    const identity = await this.authenticate(token);
    this.o.store.transact(s => {
      const a = s.accounts[identity.discordUserId]!;
      const se = s.sessions[identity.sessionKey];
      const c = this.cardState(s).cards[id];
      if (!se || se.version !== a.version || se.expiresAt <= this.now() || !this.cardSessionValid(s, se) || !c || (c.discordUserId !== identity.discordUserId && !this.isAdmin(a.discordUserId, a.existingRoleIds))) throw new CardAuthError('card_forbidden');
      c.revokedAt ??= this.now();
      for (const [key, session] of Object.entries(s.sessions)) if (session.cardId === id) delete s.sessions[key];
      this.cardEvent(s, 'card_revoked', identity.discordUserId, c.discordUserId, id);
    });
  }

  async revokeCardDevice(token: string, id: string): Promise<void> {
    const identity = await this.authenticate(token);
    this.o.store.transact(s => {
      const a = s.accounts[identity.discordUserId]!;
      const se = s.sessions[identity.sessionKey];
      if (!se || se.version !== a.version || se.expiresAt <= this.now() || !this.cardSessionValid(s, se)) throw new CardAuthError('card_forbidden');
      const d = Object.values(this.cardState(s).devices).find(d => d.id === id);
      if (!d || !d.grants[identity.discordUserId]) throw new CardAuthError('card_forbidden');
      delete d.grants[identity.discordUserId];
      for (const [key, v] of Object.entries(s.sessions)) if (v.deviceId === id && v.discordUserId === identity.discordUserId) delete s.sessions[key];
      this.cardEvent(s, 'device_revoked', identity.discordUserId, identity.discordUserId, id);
    });
  }

  async loginWithCard(secret: string, deviceToken: string | null, currentToken: string | null, switchAccount = false): Promise<{ sessionToken: string }> {
    if (!SESSION_TOKEN.test(secret)) throw new CardAuthError('card_rejected');
    const hash = this.digest('login-card', secret);
    const card = this.o.store.read(s => Object.values(s.cardAuth?.cards ?? {}).find(c => c.tokenHash === hash));
    if (!card || card.revokedAt !== null || card.activatedAt === null || card.expiresAt <= this.now()) throw new CardAuthError('card_rejected');
    if (!deviceToken || !SESSION_TOKEN.test(deviceToken)) throw new CardAuthError('device_required');
    const deviceKey = this.digest('card-device', deviceToken);
    const eligible = this.o.store.read(s => {
      const a = s.accounts[card.discordUserId];
      const d = s.cardAuth?.devices[deviceKey];
      return a && a.status === 'active' && a.version === card.version && d && d.expiresAt > this.now() && d.grants[a.discordUserId] === a.version;
    });
    if (!eligible) throw new CardAuthError('device_required');
    await this.qualify(card.discordUserId, true);
    return this.o.store.transact(s => {
      const a = s.accounts[card.discordUserId]!;
      const c = s.cardAuth!.cards[card.id]!;
      const d = s.cardAuth!.devices[deviceKey];
      if (!d || !this.cardSessionValid(s, { discordUserId: card.discordUserId, version: card.version, createdAt: 0, expiresAt: 0, cardId: card.id, deviceId: d.id }) || a.status !== 'active' || a.version !== card.version) throw new CardAuthError('card_rejected');
      const oldKey = currentToken && SESSION_TOKEN.test(currentToken) ? this.digest('session', currentToken) : null;
      const old = oldKey ? s.sessions[oldKey] : null;
      if (old && old.expiresAt > this.now() && old.discordUserId !== a.discordUserId && !switchAccount) throw new CardAuthError('account_switch');
      const sessionToken = this.newSession(s, a, { previousLoginAt: a.lastLoginAt ?? null, failedSince: a.failedSinceLogin ?? 0 });
      Object.assign(s.sessions[this.digest('session', sessionToken)]!, { cardId: c.id, deviceId: d.id, passwordAt: 0 });
      if (oldKey) delete s.sessions[oldKey];
      c.lastUsedAt = this.now();
      this.cardEvent(s, 'card_login', a.discordUserId, a.discordUserId, c.id);
      return { sessionToken };
    });
  }

  async logout(token: string, everywhere = false): Promise<void> {
    if (!SESSION_TOKEN.test(token)) return;
    const sessionHash = this.digest('session', token);
    this.o.store.transact((s) => {
      const session = s.sessions[sessionHash];
      if (!session) return;
      if (everywhere) {
        for (const d of Object.values(s.cardAuth?.devices ?? {})) delete d.grants[session.discordUserId];
        for (const [key, v] of Object.entries(s.sessions)) if (v.discordUserId === session.discordUserId) delete s.sessions[key];
      } else {
        delete s.sessions[sessionHash];
      }
    });
  }
}
