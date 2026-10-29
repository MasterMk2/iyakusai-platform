import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Node crypto primitives only. The pepper is injected by the caller; this
// module holds no fixed secret, password or production pepper.

export const MIN_PEPPER_BYTES = 32;

/** Uniform numeric code from the CSPRNG (randomInt rejects modulo bias). */
export function generateCode(digits: number): string {
  return randomInt(0, 10 ** digits).toString().padStart(digits, '0');
}

/** Opaque 256-bit secret, base64url (43 characters). */
export function opaqueSecret(): string {
  return randomBytes(32).toString('base64url');
}

export const OPAQUE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function publicId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function keyedRef(pepper: Buffer, purpose: string, value: string): string {
  return createHmac('sha256', pepper).update(`${purpose}\u0000${value}`, 'utf8').digest('hex');
}

/** Code hash bound to the challenge and its generation, salted per issuance. */
export function hashCode(pepper: Buffer, salt: Buffer, challengeId: string, generation: number, code: string): Buffer {
  return createHmac('sha256', pepper).update(salt).update(`code\u0000${challengeId}\u0000${generation}\u0000${code}`, 'utf8').digest();
}

export function newSalt(): Buffer {
  return randomBytes(16);
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
