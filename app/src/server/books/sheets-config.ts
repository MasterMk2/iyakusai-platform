import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '../auth.js';

// The committee's spreadsheet of the books (2026-11-05): an operator file `books-sheets.json` next to the mailbox
// configuration (SMM_MAIL_CONFIG), like line.json and minutes.json. Present, the books are written to the
// spreadsheet; absent, the books work without it.
//
//   { "version": 1, "spreadsheetId": "<the id in the sheet's URL>", "serviceAccountKeyFile": "<a JSON key>",
//     "tabPrefix": "", "debounceSeconds": 30 }
//
// The spreadsheet is the committee's master copy of the books: a file of its own on the shared drive that members read
// and do not write (see sheets.ts). tabPrefix (none by default) goes before every tab's name.
// The key is a Google Cloud service account's JSON key (only client_email and private_key are read). The sheet is
// shared with that service account's address as an editor; the account has no other access. The key file must be
// readable by its owner only (600) and is never logged or copied.

export const BOOKS_SHEETS_FILE = 'books-sheets.json';
const KNOWN = new Set(['version', 'spreadsheetId', 'serviceAccountKeyFile', 'tabPrefix', 'debounceSeconds']);
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
const CLIENT_EMAIL = /^[a-z0-9-]{1,63}@[a-z0-9-]{1,63}\.iam\.gserviceaccount\.com$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface BooksSheetsConfig {
  spreadsheetId: string;
  clientEmail: string;
  privateKey: string;
  tabPrefix: string;
  debounceSeconds: number;
}

function readKey(file: unknown): { clientEmail: string; privateKey: string } {
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

/** Validates the document; the key is passed by the caller (tests give a generated one). */
export function validateBooksSheetsConfig(raw: unknown, key: { clientEmail: string; privateKey: string }): BooksSheetsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${BOOKS_SHEETS_FILE} はオブジェクトで指定してください。`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`${BOOKS_SHEETS_FILE} に不明な項目があります: ${unknown.join(', ')}`);
  if (o.version !== 1) throw new ConfigError(`${BOOKS_SHEETS_FILE} の version は 1 にしてください。`);
  if (typeof o.spreadsheetId !== 'string' || !SPREADSHEET_ID.test(o.spreadsheetId)) throw new ConfigError('spreadsheetId はスプレッドシートの URL の /d/ と /edit の間の文字列で指定してください。');
  const prefix = o.tabPrefix ?? '';
  if (typeof prefix !== 'string' || prefix.length > 20 || CONTROL.test(prefix) || /['!]/.test(prefix)) throw new ConfigError('tabPrefix は 20 文字までで、\' と ! を含めないでください。');
  const debounce = o.debounceSeconds ?? 30;
  if (typeof debounce !== 'number' || !Number.isInteger(debounce) || debounce < 5 || debounce > 3600) throw new ConfigError('debounceSeconds は 5〜3600 の整数にしてください。');
  return { spreadsheetId: o.spreadsheetId, clientEmail: key.clientEmail, privateKey: key.privateKey, tabPrefix: prefix, debounceSeconds: debounce };
}

/** books-sheets.json next to the mailbox configuration, or null when there is none (the spreadsheet is off). */
export function loadBooksSheetsConfig(mailConfigFile: string): BooksSheetsConfig | null {
  const file = join(dirname(resolve(mailConfigFile)), BOOKS_SHEETS_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new ConfigError(`${BOOKS_SHEETS_FILE} を JSON として読み込めません。`);
  }
  const keyFile = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).serviceAccountKeyFile : undefined;
  return validateBooksSheetsConfig(raw, readKey(keyFile));
}
