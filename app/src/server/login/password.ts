import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Permanent password hashing with Node's built-in scrypt (no new dependency, no custom
// algorithm). Each hash has its own random salt and records its parameters. A hasher evaluates
// ONLY records of its own cost profile: in production that is the OWASP minimum below, so a
// tampered or cheaper record is never evaluated (no unbounded cost, no downgrade). Work runs
// through a small bounded queue, one derivation at a time by default.

export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
  /** UTF-8 byte ceiling for the normalized password (rejects, never truncates). */
  maxBytes: 512,
} as const;

export type PasswordPolicyError = 'too_short' | 'too_long' | 'control_characters' | 'contains_email';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Length is counted in Unicode code points after NFC normalization. */
export function checkPasswordPolicy(password: string, email?: string | null): PasswordPolicyError | null {
  if (typeof password !== 'string') return 'too_short';
  const normalized = password.normalize('NFC');
  const length = [...normalized].length;
  if (length > PASSWORD_POLICY.maxLength || Buffer.byteLength(normalized, 'utf8') > PASSWORD_POLICY.maxBytes) return 'too_long';
  if (length < PASSWORD_POLICY.minLength) return 'too_short';
  if (CONTROL.test(normalized)) return 'control_characters';
  if (email && normalized.toLowerCase().includes(email.toLowerCase())) return 'contains_email';
  return null;
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

/**
 * Production profile: the OWASP Password Storage Cheat Sheet minimum for scrypt
 * (N=2^17, r=8, p=1). Memory per derivation is 128 * N * r bytes = 128 MiB.
 */
export const SCRYPT_PRODUCTION: ScryptParams = Object.freeze({ N: 131072, r: 8, p: 1, keyLength: 32 });
/** Node's scrypt needs slightly more than 128 * N * r * p bytes; 144 MiB leaves headroom and caps any one call. */
export const SCRYPT_MAXMEM = 144 * 1024 * 1024;
/**
 * Low-cost profile for automated tests ONLY (N=2^14, 16 MiB). It is selected solely by passing
 * LOW_COST_TEST_ONLY in code; no configuration or environment variable can choose it, and the
 * server composition never passes it.
 */
export const SCRYPT_TEST_ONLY: ScryptParams = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32 });
export const LOW_COST_TEST_ONLY = 'low-cost-kdf-for-automated-tests-only' as const;
const SALT_BYTES = 16;

export interface PasswordHash {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

export class KdfBusyError extends Error {
  constructor() {
    super('password hashing queue is full');
  }
}

export interface PasswordHasherOptions {
  /** Simultaneous scrypt computations (1-2; default 1, i.e. at most about 128 MiB at a time). */
  maxConcurrent?: number;
  /** Waiting computations beyond which requests are refused (KdfBusyError). Default 8. */
  maxQueue?: number;
  /** TEST ONLY: use SCRYPT_TEST_ONLY. Must be the exact acknowledgement constant. */
  lowCostTestProfile?: typeof LOW_COST_TEST_ONLY;
}

export class PasswordHasher {
  readonly params: ScryptParams;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private dummy: PasswordHash | null = null;

  constructor(options: PasswordHasherOptions = {}) {
    if (options.lowCostTestProfile !== undefined && options.lowCostTestProfile !== LOW_COST_TEST_ONLY) throw new Error('unsupported scrypt profile');
    this.params = options.lowCostTestProfile === LOW_COST_TEST_ONLY ? SCRYPT_TEST_ONLY : SCRYPT_PRODUCTION;
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.maxQueue = options.maxQueue ?? 8;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 2) throw new Error('unsupported KDF concurrency');
    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 0 || this.maxQueue > 64) throw new Error('unsupported KDF queue length');
  }

  /** True only for a well-formed record of exactly this hasher's cost profile. */
  accepts(stored: PasswordHash | null | undefined): stored is PasswordHash {
    return (
      !!stored &&
      stored.alg === 'scrypt' &&
      stored.N === this.params.N &&
      stored.r === this.params.r &&
      stored.p === this.params.p &&
      typeof stored.salt === 'string' &&
      typeof stored.hash === 'string' &&
      Buffer.from(stored.hash, 'base64').length === this.params.keyLength
    );
  }

  private derive(password: string, salt: Buffer): Promise<Buffer> {
    const { N, r, p, keyLength } = this.params;
    return new Promise((resolve, reject) => {
      scrypt(password.normalize('NFC'), salt, keyLength, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
    });
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueue) throw new KdfBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  async hash(password: string): Promise<PasswordHash> {
    const salt = randomBytes(SALT_BYTES);
    const key = await this.slot(() => this.derive(password, salt));
    return { alg: 'scrypt', N: this.params.N, r: this.params.r, p: this.params.p, salt: salt.toString('base64'), hash: key.toString('base64') };
  }

  /**
   * Constant-time comparison. A missing, malformed or other-profile record still costs one full
   * derivation (at this hasher's profile) against a dummy hash, so it takes as long as a wrong password.
   */
  async verify(password: string, stored: PasswordHash | null | undefined): Promise<boolean> {
    const usable = this.accepts(stored);
    const record = usable ? stored : await this.dummyHash();
    const key = await this.slot(() => this.derive(password, Buffer.from(record.salt, 'base64')));
    const expected = Buffer.from(record.hash, 'base64');
    return usable && key.length === expected.length && timingSafeEqual(key, expected);
  }

  private async dummyHash(): Promise<PasswordHash> {
    if (!this.dummy) {
      const salt = randomBytes(SALT_BYTES);
      this.dummy = { alg: 'scrypt', N: this.params.N, r: this.params.r, p: this.params.p, salt: salt.toString('base64'), hash: randomBytes(32).toString('base64') };
    }
    return this.dummy;
  }
}
