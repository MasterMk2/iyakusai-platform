import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// サービス間要求の署名（svc-auth/v1）。共通 Web のゲートウェイと Discord 連携 Bot だけが
// それぞれ別の鍵で署名する。ブラウザは鍵を持たないため、利用者の申告ヘッダーを偽造できない。
// 正規文字列は「版・クライアント ID・メソッド・パス（クエリ込み）・時刻・ノンス・利用者・本文の SHA-256」を
// 改行でつないだもの。共有メール側の実装と同じ形式で、契約は docs/task-service/integration-api.md に記す。

export const SIGNATURE_VERSION = 'svc-auth/v1';

export const SVC_HEADERS = {
  client: 'x-svc-client',
  timestamp: 'x-svc-timestamp',
  nonce: 'x-svc-nonce',
  actor: 'x-svc-actor',
  signature: 'x-svc-signature',
} as const;

export const CLIENT_IDS = ['web-gateway', 'discord-bridge'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/** 時刻のずれの許容（前後）。ノンスはこの 2 倍の期間だけ記録して再利用を拒否する。 */
export const MAX_SKEW_MS = 30_000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
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
  const bodyHash = createHash('sha256').update(input.body, 'utf8').digest('hex');
  return [SIGNATURE_VERSION, input.client, input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.actor, bodyHash].join('\n');
}

export function signRequest(key: Buffer, input: SignatureInput): string {
  return createHmac('sha256', key).update(canonicalString(input), 'utf8').digest('hex');
}

/** 送信側の署名ヘッダー（連携 Bot・テスト・模擬送信で使う）。 */
export function signedHeaders(
  key: Buffer,
  request: { client: ClientId; method: string; path: string; body: string; actor?: string | null; now?: number },
): Record<string, string> {
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

/** 鍵ファイルの内容（16 進または base64 / base64url）を 32 バイト以上の鍵として読む。 */
export function parseKeyMaterial(text: string): Buffer | null {
  const value = text.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) key = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  else return null;
  if (key.length < MIN_KEY_BYTES || key.every((b) => b === key[0])) return null;
  return key;
}

/**
 * 使用済みノンスの記録。上限に達したら期限切れを捨て、それでも満杯なら新しい要求を拒否する
 * （古い記録を消して再送を通すことはしない）。
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries = 100_000,
    private readonly retentionMs = MAX_SKEW_MS * 2,
  ) {}

  /** 'ok' なら記録した。 */
  claim(key: string, now: number): 'ok' | 'replay' | 'full' {
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > now) return 'replay';
    if (this.seen.size >= this.maxEntries) {
      for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
      if (this.seen.size >= this.maxEntries) return 'full';
    }
    this.seen.set(key, now + this.retentionMs);
    return 'ok';
  }
}

export type VerifyResult = { ok: true; client: ClientId; actor: string | null } | { ok: false; reason: 'missing' | 'unknown_client' | 'skew' | 'bad_signature' | 'replay' | 'capacity' };

export interface SignedRequestParts {
  method: string;
  path: string;
  body: string;
  /** 各ヘッダーの値の一覧（重複の検出のため生の値を渡す）。 */
  header: (name: string) => string[];
}

export function verifySignedRequest(parts: SignedRequestParts, keys: ReadonlyMap<ClientId, Buffer>, nonces: NonceCache, now: number): VerifyResult {
  const single = (name: string): string | null => {
    const values = parts.header(name);
    return values.length === 1 ? values[0]! : null;
  };
  const client = single(SVC_HEADERS.client);
  const timestamp = single(SVC_HEADERS.timestamp);
  const nonce = single(SVC_HEADERS.nonce);
  const signature = single(SVC_HEADERS.signature);
  const actorValues = parts.header(SVC_HEADERS.actor);
  if (!client || !timestamp || !nonce || !signature || actorValues.length > 1) return { ok: false, reason: 'missing' };
  if (!(CLIENT_IDS as readonly string[]).includes(client)) return { ok: false, reason: 'unknown_client' };
  const key = keys.get(client as ClientId);
  if (!key) return { ok: false, reason: 'unknown_client' };
  if (!/^\d{1,16}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return { ok: false, reason: 'skew' };
  if (!NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) return { ok: false, reason: 'bad_signature' };
  const actor = actorValues[0] ?? '';
  const expected = Buffer.from(signRequest(key, { client, method: parts.method, path: parts.path, timestamp, nonce, actor, body: parts.body }), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  // 署名を確認してからノンスを記録する（未署名の要求でノンス表を埋められないように）。
  const claimed = nonces.claim(`${client}:${nonce}`, now);
  if (claimed !== 'ok') return { ok: false, reason: claimed === 'replay' ? 'replay' : 'capacity' };
  return { ok: true, client: client as ClientId, actor: actor === '' ? null : actor };
}
