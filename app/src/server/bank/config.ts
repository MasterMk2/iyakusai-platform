import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BANK_CALLBACK_PATH, BANK_SCOPES, type BankEnvironment, type BankScope } from '../../shared/bank.js';
import { ConfigError } from '../auth.js';
import { parseKeyMaterial } from '../tasks/signing.js';

// The bank connection (GMO あおぞらネット銀行 API, 2026-11-06): an operator file `bank.json` next to the mailbox
// configuration (SMM_MAIL_CONFIG), like books-sheets.json. Present, the settings screen offers to connect the bank;
// absent, nothing about the bank exists.
//
//   { "version": 1, "environment": "sunabar", "accountType": "corporation",
//     "clientId": "<クライアントID>", "clientSecretFile": "<file holding the client secret>",
//     "clientAuth": "basic", "redirectUri": "https://<public host>/bank/callback",
//     "scopes": ["private:account", "private:virtual-account"], "tokenKeyFile": "<file holding a random key>" }
//
// - The bank's addresses are fixed here per environment, never read from the file: editing the file cannot send the
//   client secret or a token anywhere else. Only "sunabar" (the bank's test site, imaginary money) is accepted for now;
//   the production API has another path and is not tried yet.
// - Only read scopes are accepted (BANK_SCOPES). A transfer scope in the file is refused, not ignored.
// - The client secret and the token key are files readable by their owner only (600), never logged or copied. The
//   tokens themselves are written encrypted with the token key in the data folder (vault.ts), which the backup leaves out.

export const BANK_CONFIG_FILE = 'bank.json';
export const BANK_TOKEN_FILE = 'bank-tokens.json';
export const BANK_AUDIT_FILE = 'bank-audit.jsonl';

const KNOWN = new Set(['version', 'environment', 'accountType', 'clientId', 'clientSecretFile', 'clientAuth', 'redirectUri', 'scopes', 'tokenKeyFile']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const PRINTABLE = /^[\x21-\x7e]+$/;
/** Files saved by Windows editors may start with a byte order mark. */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export type BankAccountType = 'corporation' | 'personal';
export type BankClientAuth = 'basic' | 'post';

export interface BankEndpoints {
  authorize: string;
  token: string;
  /** Base of the read APIs, without a trailing slash (…/corporation/v1). */
  api: string;
}

const HOSTS: Record<BankEnvironment, string> = { sunabar: 'https://api.sunabar.gmo-aozora.com' };

/** The bank's addresses for an environment (fixed in code; see the note at the top). */
export function bankEndpoints(environment: BankEnvironment, accountType: BankAccountType): BankEndpoints {
  const host = HOSTS[environment];
  return { authorize: `${host}/ganb/api/auth/v1/authorization`, token: `${host}/ganb/api/auth/v1/token`, api: `${host}/${accountType}/v1` };
}

export interface BankConfig {
  environment: BankEnvironment;
  accountType: BankAccountType;
  clientId: string;
  clientSecret: string;
  clientAuth: BankClientAuth;
  redirectUri: string;
  scopes: BankScope[];
  /** 32 bytes or more; the vault derives its own key from it (HKDF). */
  tokenKey: Buffer;
  tokenFile: string;
  auditFile: string;
  endpoints: BankEndpoints;
}

function readSecretFile(file: unknown): string {
  if (typeof file !== 'string' || !file || CONTROL.test(file)) throw new ConfigError('クライアントシークレットのファイル（clientSecretFile）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('クライアントシークレットのファイルは所有者だけが読める権限（600 など）にしてください。');
    if (stat.size > 4096) throw new ConfigError('クライアントシークレットのファイルが大きすぎます。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('クライアントシークレットのファイルを読み込めません。');
  }
  const secret = stripBom(text).trim();
  if (secret.length < 8 || secret.length > 512 || !PRINTABLE.test(secret)) throw new ConfigError('クライアントシークレットのファイルには、銀行の画面に出た値だけを 1 行で書いてください。');
  return secret;
}

/** The token key: a random value of 32 bytes or more (hex or base64), like the app's other key files. */
function readTokenKey(file: unknown): Buffer {
  if (typeof file !== 'string' || !file || CONTROL.test(file)) throw new ConfigError('トークンを暗号化する鍵のファイル（tokenKeyFile）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('tokenKeyFile の鍵ファイルは所有者だけが読める権限（600 など）にしてください。');
    if (stat.size > 4096) throw new ConfigError('tokenKeyFile の鍵ファイルが大きすぎます。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('tokenKeyFile の鍵ファイルを読み込めません。');
  }
  const key = parseKeyMaterial(text);
  if (!key) throw new ConfigError('tokenKeyFile の鍵は 32 バイト以上のランダム値（16 進または base64）にしてください。');
  return key;
}

function parseRedirectUri(value: unknown): string {
  if (typeof value !== 'string' || CONTROL.test(value)) throw new ConfigError(`redirectUri は https://<公開ホスト>${BANK_CALLBACK_PATH} の形で指定してください。`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('redirectUri は URL として解釈できません。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new ConfigError('redirectUri は https で指定してください（http は手元の試験の localhost だけ）。');
  if (url.username || url.password || url.search || url.hash || url.pathname !== BANK_CALLBACK_PATH) throw new ConfigError(`redirectUri のパスは ${BANK_CALLBACK_PATH} にしてください（クエリ・認証情報なし）。`);
  // The exact string the bank compares: keep what the operator registered, only checked.
  if (value !== `${url.origin}${BANK_CALLBACK_PATH}`) throw new ConfigError(`redirectUri は ${url.origin}${BANK_CALLBACK_PATH} と書いてください（銀行に登録した値と 1 文字も違わないように）。`);
  return value;
}

function parseScopes(value: unknown): BankScope[] {
  const list = value ?? [...BANK_SCOPES];
  if (!Array.isArray(list) || list.length === 0 || list.some((s) => typeof s !== 'string')) throw new ConfigError('scopes は文字列の配列で指定してください。');
  const refused = (list as string[]).filter((s) => !(BANK_SCOPES as readonly string[]).includes(s));
  if (refused.length > 0) throw new ConfigError(`scopes に使えないスコープがあります: ${refused.join(', ')}（この基盤は ${BANK_SCOPES.join(' と ')} だけを使います。振込の権限は使いません）。`);
  if (!list.includes('private:account')) throw new ConfigError('scopes には private:account を入れてください（接続の確認に口座の照会を使います）。');
  return [...new Set(list as BankScope[])];
}

/** Validates the document; the secret and the key are passed by the caller (tests give their own). */
export function validateBankConfig(raw: unknown, dataDir: string, clientSecret: string, tokenKey: Buffer): BankConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${BANK_CONFIG_FILE} はオブジェクトで指定してください。`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`${BANK_CONFIG_FILE} に不明な項目があります: ${unknown.join(', ')}`);
  if (o.version !== 1) throw new ConfigError(`${BANK_CONFIG_FILE} の version は 1 にしてください。`);
  if (o.environment === 'production') throw new ConfigError('environment の production（本番の銀行）はまだ使えません。sunabar で確かめてから、本番の接続を別に作ります。');
  if (o.environment !== 'sunabar') throw new ConfigError('environment は "sunabar" にしてください。');
  const accountType = o.accountType ?? 'corporation';
  if (accountType !== 'corporation' && accountType !== 'personal') throw new ConfigError('accountType は "corporation"（法人）か "personal"（個人）にしてください。');
  if (typeof o.clientId !== 'string' || o.clientId.length < 4 || o.clientId.length > 200 || !PRINTABLE.test(o.clientId)) throw new ConfigError('clientId には銀行の画面に出たクライアントID をそのまま書いてください。');
  const clientAuth = o.clientAuth ?? 'basic';
  if (clientAuth !== 'basic' && clientAuth !== 'post') throw new ConfigError('clientAuth は "basic"（ベーシック認証）か "post"（クライアントシークレット認証）にしてください。');
  if (clientSecret.includes(':') && clientAuth === 'basic') throw new ConfigError('クライアントシークレットに「:」が含まれるときは clientAuth を "post" にしてください。');
  const environment: BankEnvironment = 'sunabar';
  const dir = resolve(dataDir);
  return {
    environment,
    accountType,
    clientId: o.clientId,
    clientSecret,
    clientAuth,
    redirectUri: parseRedirectUri(o.redirectUri),
    scopes: parseScopes(o.scopes),
    tokenKey,
    tokenFile: join(dir, BANK_TOKEN_FILE),
    auditFile: join(dir, BANK_AUDIT_FILE),
    endpoints: bankEndpoints(environment, accountType),
  };
}

/** bank.json next to the mailbox configuration, or null when there is none (the bank connection is off). */
export function loadBankConfig(mailConfigFile: string, dataDir: string): BankConfig | null {
  const file = join(dirname(resolve(mailConfigFile)), BANK_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch {
    throw new ConfigError(`${BANK_CONFIG_FILE} を JSON として読み込めません。`);
  }
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const secret = readSecretFile(o.clientSecretFile);
  const key = readTokenKey(o.tokenKeyFile);
  return validateBankConfig(raw, dataDir, secret, key);
}
