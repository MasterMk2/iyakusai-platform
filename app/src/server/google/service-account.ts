import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../auth.js';

// A Google Cloud service account, shared by the features that call Google from the server: the books' master
// spreadsheet (books/sheets.ts, 2026-11-05) and the calendars' free/busy (availability/, 2026-11-20). Each feature
// names its own scope; the key is the account's JSON key, of which only client_email and private_key are read. The
// key file must be readable by its owner only (600) and is never logged or copied.

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const CLIENT_EMAIL = /^[a-z0-9-]{1,63}@[a-z0-9-]{1,63}\.iam\.gserviceaccount\.com$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

/** Reads and checks a service account's JSON key (the path comes from an operator file). */
export function readServiceAccountKey(file: unknown): ServiceAccountKey {
  if (typeof file !== 'string' || !file || CONTROL.test(file)) throw new ConfigError('サービスアカウントの鍵のファイル（serviceAccountKeyFile）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('サービスアカウントの鍵のファイルは所有者だけが読める権限（600 など）にしてください。');
    if (stat.size > 16_384) throw new ConfigError('サービスアカウントの鍵のファイルが大きすぎます。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('サービスアカウントの鍵のファイルを読み込めません。');
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    throw new ConfigError('サービスアカウントの鍵のファイルが JSON ではありません。');
  }
  const clientEmail = raw.client_email;
  const privateKey = raw.private_key;
  if (raw.type !== 'service_account' || typeof clientEmail !== 'string' || !CLIENT_EMAIL.test(clientEmail)) throw new ConfigError('鍵のファイルはサービスアカウントの JSON 鍵にしてください（client_email が見つかりません）。');
  if (typeof privateKey !== 'string' || !/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n?$/.test(privateKey)) throw new ConfigError('鍵のファイルの private_key が正しい形ではありません。');
  return { clientEmail, privateKey };
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/**
 * The signed assertion of Google's service-account flow (RS256, one hour) for one scope. Throws when the key cannot
 * sign; the caller turns that into its own failure kind.
 */
export function signServiceAccountAssertion(key: ServiceAccountKey, scope: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.clientEmail, scope, aud: GOOGLE_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Google's access-token answer, checked: the token and when to stop using it (two minutes early). */
export function acceptedToken(out: unknown, nowMs: number): { value: string; until: number } | null {
  const o = out as { access_token?: unknown; expires_in?: unknown } | null;
  if (!o || typeof o.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]{16,4096}=*$/.test(o.access_token)) return null;
  const seconds = typeof o.expires_in === 'number' && o.expires_in > 120 ? o.expires_in : 3600;
  return { value: o.access_token, until: nowMs + (seconds - 120) * 1000 };
}
