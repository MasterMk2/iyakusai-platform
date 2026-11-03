import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '../auth.js';
import { parseKeyMaterial } from '../tasks/signing.js';
import type { DiscordLineAuth } from './discord.js';

// The committee's official LINE account in the unified app (2026-10-28). An operator file `line.json` next to
// the mailbox configuration (SMM_MAIL_CONFIG): present, LINE is on; absent, LINE is off and the app is as before.
// It lives in its own file so a build without LINE still starts with the same mailbox.json.
//
// Receiving reads the existing receiver (the one that verifies LINE's webhook signature) through its /export
// feed, as a second reader beside the Drive import; the receiver itself is not changed. Sending (push) needs
// "send" and the channel access token; without it LINE is read-only.

const ACCOUNT_ID = /^[a-z0-9-]{1,40}$/;
const BOT_USER_ID = /^U[0-9a-f]{32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface LineOaConfig {
  account: { id: string; name: string; botUserId: string | null };
  receiver: { url: string; pullToken: string; pollSeconds: number; settleSeconds: number };
  /**
   * Null: read-only (no push). `publicBaseUrl` (2026-11-02): where LINE fetches sent images (the app's public
   * origin); null here means SMM_PUBLIC_ORIGIN is used, and without either images cannot be sent.
   */
  send: { accessToken: string; monthlyLimit: number; allowGroups: boolean; apiBase: string; publicBaseUrl: string | null } | null;
  /** Where the conversations, grants and send records are kept (line-state.json in the mail folder). */
  dataFile: string;
  /** Images for sending (line-media/ in the mail folder). */
  mediaDir: string;
  /** Copies of received images (line-inbound-media/ in the mail folder; never served publicly). */
  inboundMediaDir: string;
  /** The official account's own chat history (JSONL, contract A of 2026-11-02), or null. */
  history: { file: string } | null;
  /**
   * Replies from Discord threads through the Bot (contract C of 2026-11-02), or null (no internal routes). `auth` is
   * how the Bot proves itself (discord.ts): "signed" (svc-auth/v1, a key of 32 bytes or more) or "bearer" (the first version).
   */
  discord: { auth: DiscordLineAuth; threadMapFile: string } | null;
}

const KNOWN = new Set(['version', 'account', 'receiver', 'send', 'history', 'discord']);
const ACCOUNT_KNOWN = new Set(['id', 'name', 'botUserId']);
const RECEIVER_KNOWN = new Set(['url', 'pullTokenFile', 'pollSeconds', 'settleSeconds']);
const SEND_KNOWN = new Set(['accessTokenFile', 'monthlyLimit', 'allowGroups', 'apiBase', 'publicBaseUrl']);
const HISTORY_KNOWN = new Set(['file']);
const DISCORD_KNOWN = new Set(['enabled', 'keyFile', 'threadMapFile', 'auth']);

/** An https origin, optionally with a path prefix (no query, no credentials, no trailing slash). */
export function publicBaseUrlOf(value: unknown, where: string): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ConfigError(`${where} は https:// で始まる公開 URL で指定してください。`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ConfigError(`${where} は https:// で始まる公開 URL（クエリなし）で指定してください。`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const filePath = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value)) throw new ConfigError(`${where} はファイルのパスで指定してください。`);
  return resolve(value);
};

export const LINE_CONFIG_FILE = 'line.json';

/** A secret file that only its owner can read; the value is one line of printable ASCII. */
function readSecret(file: unknown, what: string): string {
  if (typeof file !== 'string' || !file) throw new ConfigError(`${what}のファイルを指定してください。`);
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError(`${what}のファイルは所有者だけが読める権限（600 など）にしてください。`);
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${what}のファイルを読み込めません。`);
  }
  // A BOM or a trailing newline from the editor or the pipe does not count.
  const value = text.replace(/^\uFEFF/, '').trim();
  if (!/^[\x21-\x7e]{16,512}$/.test(value)) throw new ConfigError(`${what}のファイルの中身が正しい形ではありません。`);
  return value;
}

function object(raw: unknown, where: string, known: Set<string>): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${where} はオブジェクトで指定してください。`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new ConfigError(`${where} に不明な項目があります: ${unknown.join(', ')}`);
  return o;
}

function integer(value: unknown, fallback: number, min: number, max: number, where: string): number {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${where} は ${min}〜${max} の整数で指定してください。`);
  return v;
}

/** Validates the document; the secrets are read by the caller (tests pass them directly). */
export function validateLineConfig(raw: unknown, dataDir: string, secrets: { pullToken: string; accessToken: string | null; discordKey?: string | null }): LineOaConfig {
  const c = object(raw, 'line.json', KNOWN);
  if (c.version !== 1) throw new ConfigError('line.json の version は 1 でなければなりません。');
  const a = object(c.account, 'line.json の account', ACCOUNT_KNOWN);
  if (typeof a.id !== 'string' || !ACCOUNT_ID.test(a.id)) throw new ConfigError('account.id は英小文字・数字・- の 1〜40 文字で指定してください。');
  if (typeof a.name !== 'string' || !a.name.trim() || a.name.trim().length > 40 || CONTROL.test(a.name)) throw new ConfigError('account.name は 1〜40 文字で指定してください。');
  if (a.botUserId !== undefined && (typeof a.botUserId !== 'string' || !BOT_USER_ID.test(a.botUserId))) throw new ConfigError('account.botUserId は U で始まる 33 文字のボットのユーザー ID で指定してください。');

  const r = object(c.receiver, 'line.json の receiver', RECEIVER_KNOWN);
  let url: URL;
  try {
    url = new URL(String(r.url));
  } catch {
    throw new ConfigError('receiver.url は受け口の URL で指定してください（例: http://line-receiver:8788）。');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ConfigError('receiver.url はパスのない http(s) の URL で指定してください。');
  }

  let send: LineOaConfig['send'] = null;
  if (c.send !== undefined) {
    const s = object(c.send, 'line.json の send', SEND_KNOWN);
    if (s.allowGroups !== undefined && typeof s.allowGroups !== 'boolean') throw new ConfigError('send.allowGroups は true / false で指定してください。');
    const apiBase = s.apiBase ?? 'https://api.line.me';
    if (typeof apiBase !== 'string' || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(apiBase)) throw new ConfigError('send.apiBase は https://ホスト名 の形で指定してください。');
    if (!secrets.accessToken) throw new ConfigError('send.accessTokenFile（チャネルアクセストークン）がありません。');
    // By default the free plan's 200 messages a month; a group counts once per member.
    send = {
      accessToken: secrets.accessToken,
      monthlyLimit: integer(s.monthlyLimit, 200, 1, 100_000, 'send.monthlyLimit'),
      allowGroups: s.allowGroups === true,
      apiBase,
      publicBaseUrl: s.publicBaseUrl === undefined ? null : publicBaseUrlOf(s.publicBaseUrl, 'send.publicBaseUrl'),
    };
  }

  let history: LineOaConfig['history'] = null;
  if (c.history !== undefined) {
    const h = object(c.history, 'line.json の history', HISTORY_KNOWN);
    history = { file: filePath(h.file, 'history.file') };
  }

  let discord: LineOaConfig['discord'] = null;
  if (c.discord !== undefined) {
    const d = object(c.discord, 'line.json の discord', DISCORD_KNOWN);
    if (d.enabled !== undefined && typeof d.enabled !== 'boolean') throw new ConfigError('discord.enabled は true / false で指定してください。');
    const threadMapFile = filePath(d.threadMapFile, 'discord.threadMapFile');
    const auth = d.auth ?? 'bearer';
    if (auth !== 'bearer' && auth !== 'signed') throw new ConfigError('discord.auth は "signed"（署名付き・推奨）か "bearer" にしてください。');
    if (d.enabled === true) {
      if (!send) throw new ConfigError('discord を使うには send（公式LINE の送信）の設定が要ります。');
      if (!secrets.discordKey) throw new ConfigError('discord.keyFile（Bot との鍵）がありません。');
      if (auth === 'signed') {
        const key = parseKeyMaterial(secrets.discordKey);
        if (!key) throw new ConfigError('discord.auth が "signed" のとき、discord.keyFile の鍵は 32 バイト以上の乱数（16 進または base64）にしてください。');
        discord = { auth: { mode: 'signed', key }, threadMapFile };
      } else {
        discord = { auth: { mode: 'bearer', key: secrets.discordKey }, threadMapFile };
      }
    }
  }

  return {
    account: { id: a.id, name: a.name.trim(), botUserId: typeof a.botUserId === 'string' ? a.botUserId : null },
    receiver: {
      url: url.origin,
      pullToken: secrets.pullToken,
      pollSeconds: integer(r.pollSeconds, 30, 5, 3600, 'receiver.pollSeconds'),
      // The receiver adds the display name a moment after it answered LINE: newer records wait this long.
      settleSeconds: integer(r.settleSeconds, 60, 0, 3600, 'receiver.settleSeconds'),
    },
    send,
    dataFile: join(dataDir, 'line-state.json'),
    mediaDir: join(dataDir, 'line-media'),
    inboundMediaDir: join(dataDir, 'line-inbound-media'),
    history,
    discord,
  };
}

/** line.json next to SMM_MAIL_CONFIG, or null when there is none (LINE off). */
export function loadLineConfig(mailConfigFile: string, dataDir: string): LineOaConfig | null {
  const file = join(dirname(resolve(mailConfigFile)), LINE_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ConfigError('line.json を JSON として読み込めません。');
  }
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const receiver = (doc.receiver && typeof doc.receiver === 'object' ? doc.receiver : {}) as Record<string, unknown>;
  const send = doc.send && typeof doc.send === 'object' ? (doc.send as Record<string, unknown>) : null;
  const pullToken = readSecret(receiver.pullTokenFile, 'receiver.pullTokenFile（受け口の読み出し用トークン）');
  const accessToken = send ? readSecret(send.accessTokenFile, 'send.accessTokenFile（チャネルアクセストークン）') : null;
  const discord = doc.discord && typeof doc.discord === 'object' ? (doc.discord as Record<string, unknown>) : null;
  const discordKey = discord?.enabled === true ? readSecret(discord.keyFile, 'discord.keyFile（Bot との鍵）') : null;
  return validateLineConfig(raw, dataDir, { pullToken, accessToken, discordKey });
}
