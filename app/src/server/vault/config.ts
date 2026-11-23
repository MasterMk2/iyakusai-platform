import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { VAULT_REVEAL_MINUTES_DEFAULT } from '../../shared/vault.js';
import { ConfigError } from '../auth.js';
import { parseKeyMaterial } from '../tasks/signing.js';

// パスワード帳 (2026-11-23): an operator file `vault.json` next to the mailbox configuration (SMM_MAIL_CONFIG), like
// bank.json. Present and valid, the password book exists; absent, nothing about it exists.
//
//   { "version": 1, "keyFile": "<file holding a random key of 32 bytes or more>", "revealMinutes": 10 }
//
// - The key file is readable by its owner only (600) and is never logged or copied. It must not be the bank's token
//   key (mailbox/config.ts refuses the same bytes). The entries are encrypted with a key derived from it (cipher.ts) in
//   vault.sqlite3, in the mail folder; the app's backup copies that file, never this folder.
// - revealMinutes: how long a password typed on a device lets it open entries (1–60, default 10).

export const VAULT_CONFIG_FILE = 'vault.json';
export const VAULT_FILE = 'vault.sqlite3';

const KNOWN = new Set(['version', 'keyFile', 'revealMinutes']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface VaultConfig {
  /** 32 bytes or more; the cipher derives its own key from it (HKDF). */
  key: Buffer;
  revealMinutes: number;
}

function readKey(file: unknown): Buffer {
  if (typeof file !== 'string' || !file || CONTROL.test(file)) throw new ConfigError('パスワード帳の鍵のファイル（keyFile）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('パスワード帳の鍵のファイルは所有者だけが読める権限（600 など）にしてください。');
    if (stat.size > 4096) throw new ConfigError('パスワード帳の鍵のファイルが大きすぎます。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('パスワード帳の鍵のファイルを読み込めません。');
  }
  const key = parseKeyMaterial(text);
  if (!key) throw new ConfigError('パスワード帳の鍵は 32 バイト以上のランダム値（16 進または base64）にしてください。');
  return key;
}

export function validateVaultConfig(raw: unknown, key: Buffer): VaultConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${VAULT_CONFIG_FILE} はオブジェクトにしてください。`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`${VAULT_CONFIG_FILE} に知らない項目があります: ${unknown.join(', ')}`);
  if (o.version !== 1) throw new ConfigError(`${VAULT_CONFIG_FILE} の version は 1 にしてください。`);
  const minutes = o.revealMinutes ?? VAULT_REVEAL_MINUTES_DEFAULT;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new ConfigError('revealMinutes は 1〜60 の整数（分）にしてください。');
  return { key, revealMinutes: minutes };
}

/** vault.json next to the mailbox configuration, or null when there is none (the password book is off). */
export function loadVaultConfig(mailConfigFile: string): VaultConfig | null {
  const file = join(dirname(resolve(mailConfigFile)), VAULT_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ConfigError(`${VAULT_CONFIG_FILE} を JSON として読み込めません。`);
  }
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return validateVaultConfig(raw, readKey(o.keyFile));
}
