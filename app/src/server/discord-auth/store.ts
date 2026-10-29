import { existsSync, readFileSync } from 'node:fs';
import { writeFileDurable } from '../durable-file.js';
import type { PasswordHash } from '../login/password.js';
import { validateCardAuth, type CardAuthState } from './cards.js';
import { isTemporaryStaffAccount, isTemporaryStaffId } from './temporary-staff.js';

// Account state of the Discord login: one JSON document, written atomically (temp file, fsync,
// rename). The shape is the production minimal runtime's `discord-accounts/v1` plus two fields per
// account (studentId, memberVerifiedAt); `migrateFromMinimum` converts that file. Codes, tokens and
// passwords are stored only as HMAC digests or scrypt records.

export const ACCOUNT_SCHEMA = 'iyakusai-accounts/v1';
const MINIMUM_SCHEMA = 'discord-accounts/v1';

export interface PendingRegistration {
  purpose: 'password_setup';
  deliveryId: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  state: 'waiting_ack' | 'ready';
  /** Issued by the committee's bulk issue (valid for days) rather than by the person's own `/register`. */
  bulk?: boolean;
}

export interface Account {
  /** Absent for committee members; 'temporary_staff' for the operator-issued item accounts (temporary-staff.ts). */
  accountType?: 'temporary_staff';
  initialLoginId: string;
  /** null only for temporary staff, who have no Discord identity. */
  guildId: string | null;
  discordUserId: string;
  joinEpochMs: number | null;
  version: number;
  status: 'pending' | 'active' | 'retired';
  password: PasswordHash | null;
  taskUserId: string | null;
  existingRoleIds: string[];
  issueTimes: number[];
  loginFailures: number[];
  registrationFailures: number[];
  pending: PendingRegistration | null;
  /** Login ID chosen at registration (digits, or letters and digits for graduate students). */
  studentId: string | null;
  /** Last time the Bot host confirmed current membership (epoch ms). */
  memberVerifiedAt: number | null;
  // Sign-in record (added 2026-10-14; absent in older files, read as none).
  /** Last successful sign-in with the password (epoch ms). */
  lastLoginAt?: number | null;
  /** Wrong passwords for this account since the last successful sign-in (shown at the next sign-in). */
  failedSinceLogin?: number;
  /** Times of wrong passwords in the last 24 hours, for the daily limit. */
  dailyFailures?: number[];
}

export interface Session {
  cardId?: string;
  deviceId?: string;
  /** Absent in existing password sessions. Card sessions start with zero. */
  passwordAt?: number;
  discordUserId: string;
  version: number;
  createdAt: number;
  expiresAt: number;
  /** What the person is shown about the sign-ins before this one (absent in older files). */
  previousLoginAt?: number | null;
  failedBefore?: number;
}

export interface AccountState {
  cardAuth?: CardAuthState;
  schema: typeof ACCOUNT_SCHEMA;
  revision: number;
  nextInitialId: number;
  accounts: Record<string, Account>;
  sessions: Record<string, Session>;
  issuerNonces: Record<string, number>;
}

export class AccountStateError extends Error {}

const SNOWFLAKE = /^\d{17,20}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export const emptyAccountState = (): AccountState => ({ schema: ACCOUNT_SCHEMA, revision: 0, nextInitialId: 1, accounts: {}, sessions: {}, issuerNonces: {} });

/** Structural check of the whole document; any unexpected shape refuses the state. */
export function validateAccountState(value: unknown): asserts value is AccountState {
  const fail = (): never => {
    throw new AccountStateError('アカウントの保存内容の形式が正しくありません。');
  };
  const s = value as AccountState;
  if (!s || typeof s !== 'object' || s.schema !== ACCOUNT_SCHEMA || !Number.isSafeInteger(s.revision) || !Number.isSafeInteger(s.nextInitialId) || s.nextInitialId < 1) fail();
  if (!s.accounts || typeof s.accounts !== 'object' || !s.sessions || typeof s.sessions !== 'object' || !s.issuerNonces || typeof s.issuerNonces !== 'object') fail();
  if (s.cardAuth !== undefined && !validateCardAuth(s.cardAuth)) fail();
  if (s.cardAuth && Object.values(s.cardAuth.cards).some(c => !s.accounts[c.discordUserId])) fail();
  const loginIds = new Set<string>();
  const studentIds = new Set<string>();
  for (const [uid, a] of Object.entries(s.accounts)) {
    if (!(SNOWFLAKE.test(uid) || isTemporaryStaffAccount(a)) || (isTemporaryStaffId(uid) && !isTemporaryStaffAccount(a)) || (!isTemporaryStaffId(uid) && a.accountType !== undefined) || a.discordUserId !== uid || !/^iy-\d{8}$/.test(a.initialLoginId) || loginIds.has(a.initialLoginId)) fail();
    if (!['pending', 'active', 'retired'].includes(a.status) || !Number.isSafeInteger(a.version) || a.version < 1) fail();
    if (a.studentId !== null && (typeof a.studentId !== 'string' || !/^[0-9A-Z]{5,12}$/.test(a.studentId) || studentIds.has(a.studentId))) fail();
    if (a.memberVerifiedAt !== null && !Number.isSafeInteger(a.memberVerifiedAt)) fail();
    if (a.password !== null && (a.password.alg !== 'scrypt' || typeof a.password.salt !== 'string' || typeof a.password.hash !== 'string')) fail();
    if (a.status === 'retired' && (a.password !== null || a.pending !== null)) fail();
    if (!Array.isArray(a.existingRoleIds) || a.existingRoleIds.some((r) => !SNOWFLAKE.test(r))) fail();
    if (a.lastLoginAt !== undefined && a.lastLoginAt !== null && !Number.isSafeInteger(a.lastLoginAt)) fail();
    if (a.failedSinceLogin !== undefined && (!Number.isSafeInteger(a.failedSinceLogin) || a.failedSinceLogin < 0)) fail();
    if (a.dailyFailures !== undefined && (!Array.isArray(a.dailyFailures) || a.dailyFailures.some((t) => !Number.isSafeInteger(t)))) fail();
    loginIds.add(a.initialLoginId);
    if (a.studentId) studentIds.add(a.studentId);
  }
  for (const [hash, session] of Object.entries(s.sessions)) {
    if (session.passwordAt !== undefined && (!Number.isSafeInteger(session.passwordAt) || session.passwordAt < 0)) fail();
    if ((session.cardId !== undefined || session.deviceId !== undefined) && (!/^[a-f0-9]{32}$/.test(session.cardId ?? '') || !/^[a-f0-9]{32}$/.test(session.deviceId ?? ''))) fail();
    if (!DIGEST.test(hash) || !(SNOWFLAKE.test(session.discordUserId) || (isTemporaryStaffId(session.discordUserId) && isTemporaryStaffAccount(s.accounts[session.discordUserId]))) || !Number.isSafeInteger(session.expiresAt) || !Number.isSafeInteger(session.version)) fail();
    if (session.previousLoginAt !== undefined && session.previousLoginAt !== null && !Number.isSafeInteger(session.previousLoginAt)) fail();
    if (session.failedBefore !== undefined && (!Number.isSafeInteger(session.failedBefore) || session.failedBefore < 0)) fail();
  }
  for (const [hash, expiresAt] of Object.entries(s.issuerNonces)) if (!DIGEST.test(hash) || !Number.isSafeInteger(expiresAt)) fail();
}

/**
 * Converts the production minimal runtime's account file. Accounts, password records, pending codes and
 * the replay cache are kept; sessions are not (they were one-hour sessions bound to its CSRF cookie), so
 * people sign in once more after the switch.
 */
export function migrateFromMinimum(value: unknown): AccountState {
  const m = value as { schema?: unknown; revision?: number; nextInitialId?: number; accounts?: Record<string, Omit<Account, 'studentId' | 'memberVerifiedAt'>>; issuerNonces?: Record<string, number> };
  if (!m || m.schema !== MINIMUM_SCHEMA || !m.accounts) throw new AccountStateError(`${MINIMUM_SCHEMA} の形式ではありません。`);
  const state: AccountState = {
    schema: ACCOUNT_SCHEMA,
    revision: 0,
    nextInitialId: m.nextInitialId ?? 1,
    accounts: Object.fromEntries(Object.entries(m.accounts).map(([uid, a]) => [uid, { ...a, studentId: null, memberVerifiedAt: null }])),
    sessions: {},
    issuerNonces: { ...(m.issuerNonces ?? {}) },
  };
  validateAccountState(state);
  return state;
}

export type MergeOutcome = 'trial-kept' | 'trial-newer' | 'production-newer' | 'production-only';

/**
 * Converts the production minimal runtime's file once more at the switch and keeps what people did in the
 * unified app during the trial, which ran on a copy migrated earlier. Every password change raises an
 * account's version, so for each account:
 * - unchanged on both sides (same version, status and password record): the unified app's record, with its
 *   student ID and sign-ins;
 * - a higher version in the unified app (password changed there): the unified app's record and sign-ins;
 * - otherwise (re-registered or reset through the old login): the production record, keeping the student ID
 *   set in the unified app; its sign-ins in the unified app end.
 * Accounts only in production (registered through the old login meanwhile) come as they are. An account
 * only in the unified app cannot be created there, so it stops the merge for a person to look at.
 */
export function mergeWithTrial(minimum: unknown, trial: unknown): { state: AccountState; report: { initialLoginId: string; outcome: MergeOutcome }[] } {
  const production = migrateFromMinimum(minimum);
  validateAccountState(trial);
  const extra = Object.keys(trial.accounts).filter((uid) => !production.accounts[uid]);
  if (extra.length > 0) throw new AccountStateError(`統合アプリにだけあるアカウントが ${extra.length} 件あります。統合を止めました。`);
  const accounts: Record<string, Account> = {};
  const keepSignIns = new Set<string>();
  const report: { initialLoginId: string; outcome: MergeOutcome }[] = [];
  for (const [uid, p] of Object.entries(production.accounts)) {
    const t = trial.accounts[uid];
    let outcome: MergeOutcome;
    if (!t) {
      accounts[uid] = p;
      outcome = 'production-only';
    } else if (t.initialLoginId !== p.initialLoginId) {
      throw new AccountStateError(`ログイン ID が食い違うアカウントがあります（${p.initialLoginId}）。統合を止めました。`);
    } else if (t.version === p.version && t.status === p.status && JSON.stringify(t.password) === JSON.stringify(p.password)) {
      accounts[uid] = t;
      keepSignIns.add(uid);
      outcome = 'trial-kept';
    } else if (t.version > p.version) {
      accounts[uid] = t;
      keepSignIns.add(uid);
      outcome = 'trial-newer';
    } else {
      accounts[uid] = { ...p, studentId: t.studentId };
      outcome = 'production-newer';
    }
    report.push({ initialLoginId: p.initialLoginId, outcome });
  }
  const sessions = Object.fromEntries(
    Object.entries(trial.sessions).filter(([, s]) => keepSignIns.has(s.discordUserId) && accounts[s.discordUserId]!.version === s.version),
  );
  const state: AccountState = {
    schema: ACCOUNT_SCHEMA,
    revision: trial.revision + 1,
    ...(trial.cardAuth ? { cardAuth: trial.cardAuth } : {}),
    nextInitialId: Math.max(production.nextInitialId, trial.nextInitialId),
    accounts,
    sessions,
    issuerNonces: { ...trial.issuerNonces, ...production.issuerNonces },
  };
  validateAccountState(state);
  report.sort((x, y) => x.initialLoginId.localeCompare(y.initialLoginId));
  return { state, report };
}

export class AccountStore {
  private state: AccountState;

  private constructor(
    private readonly file: string | null,
    initial: AccountState,
  ) {
    this.state = initial;
  }

  /** Opens an existing state file. A missing file is created empty only when `createIfMissing`. */
  static open(file: string, options: { createIfMissing?: boolean } = {}): AccountStore {
    if (!existsSync(file)) {
      if (!options.createIfMissing) throw new AccountStateError('アカウントの保存ファイルがありません。');
      const store = new AccountStore(file, emptyAccountState());
      store.persist(store.state);
      return store;
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    validateAccountState(parsed);
    return new AccountStore(file, parsed);
  }

  static memory(initial: AccountState = emptyAccountState()): AccountStore {
    validateAccountState(initial);
    return new AccountStore(null, structuredClone(initial));
  }

  read<T>(fn: (s: Readonly<AccountState>) => T): T {
    return structuredClone(fn(this.state));
  }

  /** Applies `fn` to a copy and keeps it only if the copy validates and is durably written. */
  transact<T>(fn: (s: AccountState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    draft.revision = this.state.revision + 1;
    validateAccountState(draft);
    this.persist(draft);
    this.state = draft;
    return structuredClone(result);
  }

  private persist(next: AccountState): void {
    if (this.file) writeFileDurable(this.file, `${JSON.stringify(next)}\n`);
  }
}
