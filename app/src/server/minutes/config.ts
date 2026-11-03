import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '../auth.js';
import { parseKeyMaterial } from '../tasks/signing.js';

// Meeting minutes (α, 2026-11-02): an operator file `minutes.json` next to the mailbox configuration
// (SMM_MAIL_CONFIG), like line.json. Present, the minutes are on; absent, the app is as before.
//
//   { "version": 1, "workerKeyFile": "<file with the worker's svc-auth key>", "audioRetentionDays": 14 }
//
// The key is the minutes worker's own (client "iyakusai-minutes-worker"): it can fetch audio and hand back
// transcripts and drafts, nothing else.

export const MINUTES_CONFIG_FILE = 'minutes.json';
const KNOWN = new Set(['version', 'workerKeyFile', 'audioRetentionDays']);

export interface MinutesConfig {
  workerKey: Buffer;
  audioRetentionDays: number;
  /** minutes.sqlite3 and the audio folder live here (the mail folder). */
  dataDir: string;
}

function readKey(file: unknown): Buffer {
  if (typeof file !== 'string' || !file) throw new ConfigError('議事録の処理役の鍵のファイル（workerKeyFile）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('議事録の処理役の鍵のファイルは所有者だけが読める権限（600 など）にしてください。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('議事録の処理役の鍵のファイルを読み込めません。');
  }
  const key = parseKeyMaterial(text.replace(/^\uFEFF/, ''));
  if (!key) throw new ConfigError('議事録の処理役の鍵は 32 バイト以上のランダムな値（hex か base64）にしてください。');
  return key;
}

export function validateMinutesConfig(raw: unknown, dataDir: string): MinutesConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('minutes.json はオブジェクトで指定してください。');
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`minutes.json に不明な項目があります: ${unknown.join(', ')}`);
  if (o.version !== 1) throw new ConfigError('minutes.json の version は 1 にしてください。');
  const days = o.audioRetentionDays ?? 14;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 365) throw new ConfigError('audioRetentionDays は 0〜365 の整数にしてください。');
  return { workerKey: readKey(o.workerKeyFile), audioRetentionDays: days, dataDir };
}

/** minutes.json next to the mailbox configuration, or null when there is none (the minutes are off). */
export function loadMinutesConfig(mailConfigFile: string, dataDir: string): MinutesConfig | null {
  const file = join(dirname(resolve(mailConfigFile)), MINUTES_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ConfigError('minutes.json を JSON として読み込めません。');
  }
  return validateMinutesConfig(raw, dataDir);
}
