import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Service-to-service request signing, contract "svc-auth/v1" (shared with the Task service and the
// identity bridge; see docs/unified-integration.md). Canonical string: version, client ID, method,
// path with query, timestamp, nonce, actor and SHA-256 of the exact body, joined by newlines.
// The browser never holds a key, so it cannot assert an actor to the Task service.

export const SIGNATURE_VERSION = 'svc-auth/v1';

export const SVC_HEADERS = {
  client: 'x-svc-client',
  timestamp: 'x-svc-timestamp',
  nonce: 'x-svc-nonce',
  actor: 'x-svc-actor',
  signature: 'x-svc-signature',
} as const;

export const MAX_SKEW_MS = 30_000;
export const MIN_KEY_BYTES = 32;

export interface SignatureInput {
  client: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  actor: string;
  body: string;
}

export function canonicalString(input: SignatureInput): string {
  return canonicalStringForBodyHash(input, createHash('sha256').update(input.body, 'utf8').digest('hex'));
}

/** The same canonical string for a body that is bytes rather than text (raw mail): its SHA-256 in hex. */
export function canonicalStringForBodyHash(input: Omit<SignatureInput, 'body'>, bodyHash: string): string {
  return [SIGNATURE_VERSION, input.client, input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.actor, bodyHash].join('\n');
}

/** Verifies a signature over a byte body (e.g. raw mail sent by the collector). */
export function verifyBytesSignature(key: Buffer, input: Omit<SignatureInput, 'body'>, body: Buffer, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const expected = createHmac('sha256', key).update(canonicalStringForBodyHash(input, bodyHash), 'utf8').digest();
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signRequest(key: Buffer, input: SignatureInput): string {
  return createHmac('sha256', key).update(canonicalString(input), 'utf8').digest('hex');
}

export function signedHeaders(key: Buffer, request: { client: string; method: string; path: string; body: string; actor?: string | null; now?: number }): Record<string, string> {
  const timestamp = String(request.now ?? Date.now());
  const nonce = randomBytes(18).toString('base64url');
  const actor = request.actor ?? '';
  const signature = signRequest(key, { client: request.client, method: request.method, path: request.path, timestamp, nonce, actor, body: request.body });
  return {
    [SVC_HEADERS.client]: request.client,
    [SVC_HEADERS.timestamp]: timestamp,
    [SVC_HEADERS.nonce]: nonce,
    [SVC_HEADERS.signature]: signature,
    ...(actor ? { [SVC_HEADERS.actor]: actor } : {}),
  };
}

/** Verifies a response or callback signature (used by test doubles of the peer services). */
export function verifySignature(key: Buffer, input: SignatureInput, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signRequest(key, input), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Key file content: hex or base64/base64url of at least 32 random bytes. */
export function parseKeyMaterial(text: string): Buffer | null {
  const value = text.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) key = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  else return null;
  if (key.length < MIN_KEY_BYTES || key.every((b) => b === key[0])) return null;
  return key;
}
