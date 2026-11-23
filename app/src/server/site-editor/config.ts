import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '../auth.js';
import { parseKeyMaterial } from '../tasks/signing.js';

// The website editor (2026-11-23): an operator file `site-editor.json` next to the mailbox configuration
// (SMM_MAIL_CONFIG), like vault.json. Present and valid, the editor opens at /site-editor/ for the people it names;
// absent, nothing about it exists.
//
//   {
//     "version": 1,
//     "upstream": "http://wge:8080",
//     "keyFile": "<file holding a random key of 32 bytes or more>",
//     "siteUrl": "https://example.org/",
//     "editors": { "departments": ["…"], "userIds": [] },
//     "publishers": { "departments": [], "userIds": ["…"] }
//   }
//
// - upstream: the editor's own server (WebGenEngine's trusted-front.php) on the internal network. It is never published.
// - keyFile: the key shared with that server (its WGE_SVC_KEY_FILE). Readable by its owner only (600); it must differ
//   from every other key of the mail configuration (mailbox/config.ts refuses the same bytes).
// - siteUrl: where the published site is seen (a link on the settings screen). Optional.
// - editors may change pages; publishers may also publish and take a publish back. Access administrators may always do
//   both. A department is a name of the person's roles (as on the account screen); a user ID is the account's ID
//   (iy-…, the 「ログインID」 of the account screen), not the student ID.

export const SITE_EDITOR_CONFIG_FILE = 'site-editor.json';

export interface SiteEditorPeople {
  departments: string[];
  userIds: string[];
}

export interface SiteEditorConfig {
  /** The editor's server, as an origin without a trailing slash (http://host:port). */
  upstream: string;
  key: Buffer;
  siteUrl: string | null;
  editors: SiteEditorPeople;
  publishers: SiteEditorPeople;
}

const KNOWN = new Set(['version', 'upstream', 'keyFile', 'siteUrl', 'editors', 'publishers']);
const PEOPLE_KNOWN = new Set(['departments', 'userIds']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function readKey(file: unknown): Buffer {
  if (typeof file !== 'string' || !file || CONTROL.test(file)) throw new ConfigError('Webサイトの編集の鍵のファイル（keyFile）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('Webサイトの編集の鍵のファイルは所有者だけが読める権限（600 など）にしてください。');
    if (stat.size > 4096) throw new ConfigError('Webサイトの編集の鍵のファイルが大きすぎます。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('Webサイトの編集の鍵のファイルを読み込めません。');
  }
  const key = parseKeyMaterial(text);
  if (!key) throw new ConfigError('Webサイトの編集の鍵は 32 バイト以上のランダム値（16 進または base64）にしてください。');
  return key;
}

function upstreamOf(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ConfigError('upstream は http://ホスト名:ポート の形にしてください。');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('upstream は http://ホスト名:ポート の形にしてください（道・クエリ・利用者名は付けない）。');
  }
  return url.origin;
}

function siteUrlOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ConfigError('siteUrl は http:// か https:// で始まる URL にしてください。');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new ConfigError('siteUrl は http:// か https:// で始まる URL にしてください。');
  return url.href;
}

function namesOf(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new ConfigError(`${what} は 200 件までの文字列の配列にしてください。`);
  for (const v of value) {
    if (typeof v !== 'string' || v.trim() === '' || v.length > 100 || CONTROL.test(v)) throw new ConfigError(`${what} には 1 行の名前だけを書いてください。`);
  }
  return [...new Set((value as string[]).map((v) => v.trim()))];
}

function peopleOf(value: unknown, name: string): SiteEditorPeople {
  if (value === undefined) return { departments: [], userIds: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${name} は { "departments": [...], "userIds": [...] } の形にしてください。`);
  const o = value as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !PEOPLE_KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`${name} に知らない項目があります: ${unknown.join(', ')}`);
  return { departments: namesOf(o.departments, `${name}.departments`), userIds: namesOf(o.userIds, `${name}.userIds`) };
}

export function validateSiteEditorConfig(raw: unknown, key: Buffer): SiteEditorConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${SITE_EDITOR_CONFIG_FILE} はオブジェクトにしてください。`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`${SITE_EDITOR_CONFIG_FILE} に知らない項目があります: ${unknown.join(', ')}`);
  if (o.version !== 1) throw new ConfigError(`${SITE_EDITOR_CONFIG_FILE} の version は 1 にしてください。`);
  return { upstream: upstreamOf(o.upstream), key, siteUrl: siteUrlOf(o.siteUrl), editors: peopleOf(o.editors, 'editors'), publishers: peopleOf(o.publishers, 'publishers') };
}

/** site-editor.json next to the mailbox configuration, or null when there is none (the editor is off). */
export function loadSiteEditorConfig(mailConfigFile: string): SiteEditorConfig | null {
  const file = join(dirname(resolve(mailConfigFile)), SITE_EDITOR_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ConfigError(`${SITE_EDITOR_CONFIG_FILE} を JSON として読み込めません。`);
  }
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return validateSiteEditorConfig(raw, readKey(o.keyFile));
}
