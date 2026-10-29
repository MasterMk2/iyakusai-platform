import type { PasswordHash } from './password.js';
import { REFERENCE_STORE_ACK, type ChallengePurpose } from './types.js';

// Single-process in-memory state. Alone it is the PREPARATION/TEST reference (lost on
// restart, which denies every challenge and session). With an injected LoginPersistence
// the service snapshots it after every change (see file-store.ts), which is the durable
// single-process store of the account composition. The account-failure and target-DM counters
// are part of that snapshot; per-client and global request counters stay in memory only.

export interface IssuedCode {
  hash: Buffer;
  salt: Buffer;
  generation: number;
  deliveryId: string;
  /** False until the Bot acknowledged delivery; an unacknowledged code is never usable. */
  delivered: boolean;
  expiresAt: number;
  linkId: string;
  linkVersion: number;
  memberKey: string;
  principalId: string;
}

export interface ChallengeRecord {
  id: string;
  browserHash: Buffer;
  /** Keyed hash of the normalized target email; the email itself is not stored. */
  targetKey: string;
  createdAt: number;
  expiresAt: number;
  state: 'open' | 'consumed' | 'dead';
  /** Bound into the code hash; a code for one purpose never works for another. */
  purpose: ChallengePurpose;
  generation: number;
  failedAttempts: number;
  /** A dispatch for this challenge is queued or running; further resends coalesce. */
  dispatching: boolean;
  /** Set once an eligible link resolved, so a resend can recheck it without the email. */
  linkId: string | null;
  memberKey: string | null;
  principalId: string | null;
  code: IssuedCode | null;
}

export interface SessionRecord {
  /** SHA-256 of the opaque session token; the token itself is not stored. */
  tokenHash: string;
  principalId: string;
  linkId: string;
  linkVersion: number;
  memberKey: string;
  targetKey: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  /** Credential version the session was issued for; null for a code-only (purpose `login`) session. */
  credentialVersion?: number | null;
}

/** The person's own permanent password, bound to the verified link it was set through. */
export interface CredentialRecord {
  principalId: string;
  linkId: string;
  linkVersion: number;
  /** Incremented on every set/reset; sessions of an older version stop working. */
  version: number;
  hash: PasswordHash;
  updatedAt: number;
}

/** One-time permission to set a password, issued after a verified setup code. Token stored hashed. */
export interface SetupGrantRecord {
  tokenHash: string;
  principalId: string;
  linkId: string;
  linkVersion: number;
  memberKey: string;
  targetKey: string;
  expiresAt: number;
  used: boolean;
}

export interface StoreLimits {
  maxChallenges: number;
  maxSessions: number;
  maxRateKeys: number;
  /** Longest counter window; a key with no event inside it cannot be blocking anything. */
  maxWindowMs: number;
}

export type CounterResult = 'allowed' | 'limited' | 'full';

/**
 * Sliding-log counters with a bounded key space. A full key space first drops
 * keys whose entries all expired (they cannot be blocking anything); live keys
 * are never evicted, so a flood cannot reset someone's blocked counter.
 */
class Counters {
  private readonly logs = new Map<string, number[]>();
  constructor(
    private readonly maxKeys: number,
    private readonly maxWindowMs: number,
  ) {}

  private live(key: string, windowMs: number, now: number): number[] | undefined {
    const log = this.logs.get(key);
    if (!log) return undefined;
    const kept = log.filter((t) => now - t < windowMs);
    if (kept.length === 0) this.logs.delete(key);
    else this.logs.set(key, kept);
    return kept.length === 0 ? undefined : kept;
  }

  count(key: string, windowMs: number, now: number): number {
    return this.live(key, windowMs, now)?.length ?? 0;
  }

  /** Records one event unless `limit` events already fall inside the window. */
  hit(key: string, limit: number, windowMs: number, now: number): CounterResult {
    const log = this.live(key, windowMs, now);
    if (log && log.length >= limit) return 'limited';
    if (!log && this.logs.size >= this.maxKeys) {
      this.purge(now);
      if (this.logs.size >= this.maxKeys) return 'full';
    }
    if (log) log.push(now);
    else this.logs.set(key, [now]);
    return 'allowed';
  }

  /** True when an event for `key` could be recorded now: the key is live or a slot is (or can be made) free. */
  canRecord(key: string, now: number): boolean {
    if (this.live(key, this.maxWindowMs, now)) return true;
    if (this.logs.size < this.maxKeys) return true;
    this.purge(now);
    return this.logs.size < this.maxKeys;
  }

  private purge(now: number): void {
    for (const [key, log] of this.logs) if (log.every((t) => now - t >= this.maxWindowMs)) this.logs.delete(key);
  }

  get size(): number {
    return this.logs.size;
  }

  /** Live entries of the durable counter kinds only (expired timestamps pruned, newest kept). */
  exportDurable(now: number): DurableCounter[] {
    const out: DurableCounter[] = [];
    for (const [key, log] of this.logs) {
      if (!DURABLE_COUNTER_KEY.test(key)) continue;
      const live = log.filter((t) => now - t < this.maxWindowMs).slice(-MAX_DURABLE_EVENTS);
      if (live.length > 0) out.push({ key, at: live });
    }
    return out;
  }

  /** Restores durable counters (validated by the caller's integrity check); drops expired ones. */
  importDurable(entries: DurableCounter[], now: number): void {
    for (const { key, at } of entries) {
      if (this.logs.size >= this.maxKeys) break;
      const live = at.filter((t) => now - t < this.maxWindowMs).slice(-MAX_DURABLE_EVENTS);
      if (live.length > 0) this.logs.set(key, live);
    }
  }
}

/**
 * Counter kinds that survive a restart: the per-account failure budget and the per-target DM
 * limits. Keys hold only keyed (pepper HMAC) references, never an email or address. Per-client and
 * global request counters stay in memory (they reset on restart).
 */
const DURABLE_COUNTER_KEY = /^(account-fail|target-interval|target-window):[0-9a-f]{64}$/;
const MAX_DURABLE_EVENTS = 64;

export interface DurableCounter {
  key: string;
  at: number[];
}

function isDurableCounter(value: unknown): value is DurableCounter {
  const c = value as Partial<DurableCounter> | null;
  return (
    !!c &&
    typeof c.key === 'string' &&
    DURABLE_COUNTER_KEY.test(c.key) &&
    Array.isArray(c.at) &&
    c.at.length <= MAX_DURABLE_EVENTS &&
    c.at.every((t) => Number.isSafeInteger(t) && t >= 0)
  );
}

export class MemoryLoginStore {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  readonly credentials = new Map<string, CredentialRecord>();
  readonly setupGrants = new Map<string, SetupGrantRecord>();
  readonly counters: Counters;

  constructor(
    acknowledgement: typeof REFERENCE_STORE_ACK,
    readonly limits: StoreLimits,
  ) {
    // Guards against accidental production use of a store that forgets everything on restart.
    if (acknowledgement !== REFERENCE_STORE_ACK) throw new Error('MemoryLoginStore is a single-process preparation/test reference only.');
    this.counters = new Counters(limits.maxRateKeys, limits.maxWindowMs);
  }

  // ---- challenges

  addChallenge(record: ChallengeRecord, now: number): boolean {
    if (this.challenges.size >= this.limits.maxChallenges) this.sweepChallenges(now);
    if (this.challenges.size >= this.limits.maxChallenges) return false;
    this.challenges.set(record.id, record);
    return true;
  }

  getChallenge(id: string): ChallengeRecord | undefined {
    return this.challenges.get(id);
  }

  deleteChallenge(id: string): void {
    this.challenges.delete(id);
  }

  findChallenges(predicate: (c: ChallengeRecord) => boolean): ChallengeRecord[] {
    return [...this.challenges.values()].filter(predicate);
  }

  private sweepChallenges(now: number): void {
    // Consumed/dead records stay until expiry so a replay still reads as a replay; then they go.
    for (const [id, c] of this.challenges) if (now >= c.expiresAt && !c.dispatching) this.challenges.delete(id);
  }

  // ---- sessions

  addSession(record: SessionRecord, now: number, idleMs: number): boolean {
    if (this.sessions.size >= this.limits.maxSessions) {
      for (const [hash, s] of this.sessions) if (now >= s.absoluteExpiresAt || now - s.lastSeenAt >= idleMs) this.sessions.delete(hash);
    }
    if (this.sessions.size >= this.limits.maxSessions) return false;
    this.sessions.set(record.tokenHash, record);
    return true;
  }

  getSession(tokenHash: string): SessionRecord | undefined {
    return this.sessions.get(tokenHash);
  }

  deleteSession(tokenHash: string): boolean {
    return this.sessions.delete(tokenHash);
  }

  deleteSessionsWhere(predicate: (s: SessionRecord) => boolean): number {
    let removed = 0;
    for (const [hash, s] of this.sessions) {
      if (predicate(s)) {
        this.sessions.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  // ---- durable snapshot (Buffers as base64; only the durable counter kinds, see Counters)

  snapshot(now: number): LoginSnapshot {
    return {
      kind: SNAPSHOT_KIND,
      version: 1,
      counters: this.counters.exportDurable(now),
      challenges: [...this.challenges.values()].map((c) => ({
        ...c,
        browserHash: c.browserHash.toString('base64'),
        code: c.code ? { ...c.code, hash: c.code.hash.toString('base64'), salt: c.code.salt.toString('base64') } : null,
      })),
      sessions: [...this.sessions.values()],
      credentials: [...this.credentials.values()],
      setupGrants: [...this.setupGrants.values()],
    };
  }

  /**
   * Replaces everything with a validated snapshot; throws on any structural problem. A version-1
   * snapshot written before counters were persisted (no `counters` field) still loads.
   */
  restore(value: unknown, now: number): void {
    const snap = value as Partial<LoginSnapshot> | null;
    if (!snap || snap.kind !== SNAPSHOT_KIND || snap.version !== 1 || ![snap.challenges, snap.sessions, snap.credentials, snap.setupGrants].every(Array.isArray)) {
      throw new Error('login state snapshot is not valid');
    }
    if (snap.counters !== undefined && (!Array.isArray(snap.counters) || snap.counters.length > this.limits.maxRateKeys || !snap.counters.every(isDurableCounter))) {
      throw new Error('login state snapshot is not valid');
    }
    const fail = () => {
      throw new Error('login state snapshot is not valid');
    };
    this.challenges.clear();
    this.sessions.clear();
    this.credentials.clear();
    this.setupGrants.clear();
    for (const c of snap.challenges!) {
      if (typeof c.id !== 'string' || typeof c.browserHash !== 'string' || typeof c.targetKey !== 'string') fail();
      this.challenges.set(c.id, {
        ...c,
        // A dispatch cannot survive a restart; an undelivered code is never usable.
        dispatching: false,
        browserHash: Buffer.from(c.browserHash, 'base64'),
        code: c.code && c.code.delivered ? { ...c.code, hash: Buffer.from(c.code.hash, 'base64'), salt: Buffer.from(c.code.salt, 'base64') } : null,
      });
    }
    for (const s of snap.sessions!) {
      if (typeof s.tokenHash !== 'string' || typeof s.principalId !== 'string') fail();
      this.sessions.set(s.tokenHash, s);
    }
    for (const c of snap.credentials!) {
      if (typeof c.principalId !== 'string' || !c.hash || typeof c.version !== 'number') fail();
      this.credentials.set(c.principalId, c);
    }
    for (const g of snap.setupGrants!) {
      if (typeof g.tokenHash !== 'string') fail();
      this.setupGrants.set(g.tokenHash, g);
    }
    this.counters.importDurable(snap.counters ?? [], now);
  }

  /** Drops expired setup grants and expired sessions (bounded growth). */
  sweep(now: number, idleMs: number): void {
    for (const [hash, g] of this.setupGrants) if (g.used || now >= g.expiresAt) this.setupGrants.delete(hash);
    for (const [hash, s] of this.sessions) if (now >= s.absoluteExpiresAt || now - s.lastSeenAt >= idleMs) this.sessions.delete(hash);
    for (const [id, c] of this.challenges) if (now >= c.expiresAt && !c.dispatching) this.challenges.delete(id);
  }

  /** Size snapshot for bounded-state assertions. */
  stats(): { challenges: number; sessions: number; rateKeys: number } {
    return { challenges: this.challenges.size, sessions: this.sessions.size, rateKeys: this.counters.size };
  }

  /** Test/diagnostic view of everything held; used to assert that only hashes are stored. */
  dumpForInspection(): unknown {
    return { challenges: [...this.challenges.values()], sessions: [...this.sessions.values()], credentials: [...this.credentials.values()], setupGrants: [...this.setupGrants.values()] };
  }
}

const SNAPSHOT_KIND = 'smm-login-state';

type Encoded<T> = Omit<T, 'browserHash' | 'code'> & { browserHash: string; code: (Omit<IssuedCode, 'hash' | 'salt'> & { hash: string; salt: string }) | null };

export interface LoginSnapshot {
  kind: typeof SNAPSHOT_KIND;
  version: 1;
  /** Account-failure and target-DM counters (keyed references and timestamps only). */
  counters?: DurableCounter[];
  challenges: Encoded<ChallengeRecord>[];
  sessions: SessionRecord[];
  credentials: CredentialRecord[];
  setupGrants: SetupGrantRecord[];
}
