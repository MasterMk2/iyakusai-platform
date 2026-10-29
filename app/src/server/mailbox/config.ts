import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../auth.js';
import { loadLineConfig, type LineOaConfig } from '../line/oa-config.js';
import { parseKeyMaterial } from '../tasks/signing.js';
import type { SmtpSettings } from './smtp.js';

// The committee mailbox (SMM_MAIL_DIR + SMM_MAIL_CONFIG, Discord login only). The configuration is an
// operator file outside Git: the committee addresses shown as mailboxes, the key the mail collector (GAS)
// signs with, and the reading rules.

const SNOWFLAKE = /^[1-9]\d{16,19}$/;
const MAILBOX_ID = /^[a-z0-9-]{1,40}$/;
const ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/;
const DOMAIN = /^[a-z0-9.-]{1,190}\.[a-z]{2,}$/;

export interface MailboxDefinition {
  id: string;
  name: string;
  /** Canonical committee address (lower case, the main domain). */
  address: string;
  /** The collector account's own mailbox: mail it received for no listed address is shown here. */
  catchAll: boolean;
  /** Mailboxes this address forwards to (a Google Group that is a member of another): its mail shows there too. */
  forwardsTo: string[];
  /** The group's subject prefix without brackets (e.g. "sps" for "[sps]"), or null. */
  subjectTag: string | null;
}

export interface MailboxConfig {
  /** Folder of mail.sqlite3 and the attachment files. */
  dataDir: string;
  /** In display order. */
  mailboxes: MailboxDefinition[];
  /** Other domains of the committee, e.g. { "iyakusai.jp": "iyakusai.com" }. */
  domainAliases: Record<string, string>;
  /** Key of the mail collector's signed requests (svc-auth/v1, client "mail-collector"). */
  ingestKey: Buffer;
  /** When not empty, only these Discord accounts can open the mailbox (trial before opening it to everyone). */
  previewDiscordUserIds: string[];
  /** The mail screens ask for the password again after this many hours without mail use. */
  idleHours: number;
  /** Past mail: also accept proof of delivery through a committee group (List-Id, the group's leading subject tag). */
  backfillUseGroupDelivery: boolean;
  /** The address the Bot's mail drafts tell people to put in BCC to keep a copy in the committee mailbox, or null. */
  draftBccAddress: string | null;
  /** Senders (and their subdomains) whose every message is sign-in mail, shown to access administrators only (restricted.ts). */
  restrictedSenderDomains: string[];
  /** Sending from the app, or null when the configuration has no "send". */
  send: MailSendConfig | null;
  /** The official LINE account (line.json next to this file, 2026-10-28); absent or null when LINE is off. */
  line?: LineOaConfig | null;
}

/**
 * Sending through the committee's Gmail account (SMTP with its app password). The From addresses are the
 * mailboxes listed here, each registered as "Send mail as" in that account's Gmail settings; who may use
 * which address is a per-mailbox send grant. Mail sent from the app also goes as BCC to draftBccAddress.
 */
export interface MailSendConfig {
  smtp: SmtpSettings;
  /** Display name of the From line. */
  fromName: string;
  mailboxIds: string[];
  maxAttachmentBytes: number;
  maxRecipients: number;
}

const KNOWN = new Set(['version', 'mailboxes', 'domainAliases', 'ingestKeyFile', 'previewDiscordUserIds', 'idleHours', 'backfillUseGroupDelivery', 'draftBccAddress', 'restrictedSenderDomains', 'send']);
const SEND_KNOWN = new Set(['smtpHost', 'smtpPort', 'smtpUser', 'smtpPasswordFile', 'fromName', 'mailboxes', 'maxAttachmentMB', 'maxRecipients']);
const SUBJECT_TAG = /^[A-Za-z0-9._-]{1,20}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The app password (Gmail shows it in groups of four; the spaces do not count). */
function readPassword(file: unknown): string {
  if (typeof file !== 'string' || !file) throw new ConfigError('send.smtpPasswordFile（送信用アカウントのアプリパスワードのファイル）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('send.smtpPasswordFile は所有者だけが読める権限（600 など）にしてください。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('send.smtpPasswordFile を読み込めません。');
  }
  const password = text.replace(/\s+/g, '');
  if (!/^[\x21-\x7e]{8,128}$/.test(password)) throw new ConfigError('send.smtpPasswordFile の中身がアプリパスワードの形ではありません。');
  return password;
}

function validateSend(raw: unknown, mailboxes: MailboxDefinition[], password: string | null, archive: boolean): MailSendConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('send はオブジェクトで指定してください。');
  // Every message sent from the app goes to the archive as BCC (the mail record): no archive, no sending.
  if (!archive) throw new ConfigError('send を使うときは draftBccAddress（送ったメールの記録用の BCC 先）も指定してください。');
  const s = raw as Record<string, unknown>;
  const unknown = Object.keys(s).filter((k) => !SEND_KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`send に不明な項目があります: ${unknown.join(', ')}`);
  if (typeof s.smtpHost !== 'string' || !DOMAIN.test(s.smtpHost)) throw new ConfigError('send.smtpHost は小文字のホスト名で指定してください（例: smtp.gmail.com）。');
  const port = s.smtpPort ?? 465;
  if (port !== 465 && port !== 587) throw new ConfigError('send.smtpPort は 465（TLS）か 587（STARTTLS）にしてください。');
  if (typeof s.smtpUser !== 'string' || !ADDRESS.test(s.smtpUser)) throw new ConfigError('send.smtpUser は送信用アカウントの小文字のメールアドレスで指定してください。');
  if (typeof s.fromName !== 'string' || !s.fromName.trim() || s.fromName.trim().length > 60 || CONTROL.test(s.fromName)) throw new ConfigError('send.fromName（差出人の名前）は 1〜60 文字で指定してください。');
  const ids = new Set(mailboxes.map((m) => m.id));
  if (!Array.isArray(s.mailboxes) || s.mailboxes.length === 0 || s.mailboxes.some((v) => typeof v !== 'string' || !ids.has(v)) || new Set(s.mailboxes).size !== s.mailboxes.length) {
    throw new ConfigError('send.mailboxes は、差出人にできる受信箱の id の配列で指定してください（Gmail の「他のアドレスからメールを送信」に登録済みのもの）。');
  }
  const mb = s.maxAttachmentMB ?? 15;
  // The proxy takes requests of up to 17MB (17,000,000 bytes); 15MiB leaves room for the text and the form.
  if (typeof mb !== 'number' || !Number.isFinite(mb) || mb <= 0 || mb > 15) throw new ConfigError('send.maxAttachmentMB は 0 より大きく 15 以下で指定してください。');
  const recipients = s.maxRecipients ?? 30;
  // Gmail takes up to 100 recipients per message over SMTP; the archive BCC is one of them.
  if (typeof recipients !== 'number' || !Number.isInteger(recipients) || recipients < 1 || recipients > 99) throw new ConfigError('send.maxRecipients は 1〜99 の整数で指定してください。');
  if (password === null) throw new ConfigError('send.smtpPasswordFile（アプリパスワード）がありません。');
  return {
    smtp: { host: s.smtpHost, port, security: port === 465 ? 'tls' : 'starttls', user: s.smtpUser, password },
    fromName: s.fromName.trim(),
    mailboxIds: [...(s.mailboxes as string[])],
    maxAttachmentBytes: Math.floor(mb * 1024 * 1024),
    maxRecipients: recipients,
  };
}

function readKey(file: unknown): Buffer {
  if (typeof file !== 'string' || !file) throw new ConfigError('ingestKeyFile（メール収集の署名鍵）を指定してください。');
  let text: string;
  try {
    const stat = statSync(resolve(file));
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError('ingestKeyFile は所有者だけが読める権限（600 など）にしてください。');
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('ingestKeyFile の鍵ファイルを読み込めません。');
  }
  const key = parseKeyMaterial(text);
  if (!key) throw new ConfigError('ingestKeyFile の鍵は 32 バイト以上の乱数（16 進または base64）でなければなりません。');
  return key;
}

/** Validates the parsed configuration document (separate from the file so tests can pass objects). */
export function validateMailboxConfig(raw: unknown, dataDir: string, ingestKey: Buffer, smtpPassword: string | null = null): MailboxConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('SMM_MAIL_CONFIG はオブジェクトでなければなりません。');
  const c = raw as Record<string, unknown>;
  const unknown = Object.keys(c).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`SMM_MAIL_CONFIG に不明な項目があります: ${unknown.join(', ')}`);
  if (c.version !== 1) throw new ConfigError('SMM_MAIL_CONFIG の version は 1 でなければなりません。');

  const aliases: Record<string, string> = {};
  const rawAliases = c.domainAliases ?? {};
  if (!rawAliases || typeof rawAliases !== 'object' || Array.isArray(rawAliases)) throw new ConfigError('domainAliases は「別ドメイン → 正規ドメイン」の対応で指定してください。');
  for (const [from, to] of Object.entries(rawAliases)) {
    if (!DOMAIN.test(from) || typeof to !== 'string' || !DOMAIN.test(to) || from === to) throw new ConfigError('domainAliases の対応が正しくありません（小文字のドメイン名）。');
    aliases[from] = to;
  }

  if (!Array.isArray(c.mailboxes) || c.mailboxes.length === 0) throw new ConfigError('mailboxes（受信箱の一覧）が空か配列ではありません。');
  const ids = new Set<string>();
  const addresses = new Set<string>();
  const mailboxes = c.mailboxes.map((entry: unknown, index): MailboxDefinition => {
    const at = `mailboxes の ${index + 1} 番目`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ConfigError(`${at}はオブジェクトでなければなりません。`);
    const m = entry as Record<string, unknown>;
    if (Object.keys(m).some((k) => !['id', 'name', 'address', 'catchAll', 'forwardsTo', 'subjectTag'].includes(k))) throw new ConfigError(`${at}に不明な項目があります。`);
    if (typeof m.id !== 'string' || !MAILBOX_ID.test(m.id) || ids.has(m.id)) throw new ConfigError(`${at}の id が不正か重複しています（英小文字・数字・- の 1〜40 文字）。`);
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.trim().length > 40) throw new ConfigError(`${at}の name は 1〜40 文字で指定してください。`);
    if (typeof m.address !== 'string' || !ADDRESS.test(m.address) || m.address.includes('+')) throw new ConfigError(`${at}の address は小文字のメールアドレスで指定してください（+ 付きは不可）。`);
    if (aliases[m.address.split('@')[1]!]) throw new ConfigError(`${at}の address は正規ドメインで指定してください（別ドメインは domainAliases で扱います）。`);
    if (addresses.has(m.address)) throw new ConfigError(`${at}の address が重複しています。`);
    if (m.catchAll !== undefined && typeof m.catchAll !== 'boolean') throw new ConfigError(`${at}の catchAll は true / false で指定してください。`);
    const forwards = m.forwardsTo ?? [];
    if (!Array.isArray(forwards) || forwards.some((f) => typeof f !== 'string' || !MAILBOX_ID.test(f) || f === m.id) || new Set(forwards).size !== forwards.length) {
      throw new ConfigError(`${at}の forwardsTo は、ほかの受信箱の id の配列で指定してください。`);
    }
    if (m.subjectTag !== undefined && (typeof m.subjectTag !== 'string' || !SUBJECT_TAG.test(m.subjectTag))) throw new ConfigError(`${at}の subjectTag は件名の印（[ ] を除いた英数字と . _ -。大文字小文字は区別しない）で指定してください。`);
    ids.add(m.id);
    addresses.add(m.address);
    return { id: m.id, name: m.name.trim(), address: m.address, catchAll: m.catchAll === true, forwardsTo: [...(forwards as string[])], subjectTag: typeof m.subjectTag === 'string' ? m.subjectTag.toLowerCase() : null };
  });
  for (const m of mailboxes) {
    if (m.forwardsTo.some((f) => !ids.has(f))) throw new ConfigError(`受信箱 ${m.id} の forwardsTo に、一覧にない受信箱があります。`);
  }
  const tags = mailboxes.flatMap((m) => (m.subjectTag ? [m.subjectTag] : []));
  if (new Set(tags).size !== tags.length) throw new ConfigError('subjectTag が重複しています。');
  if (mailboxes.filter((m) => m.catchAll).length !== 1) throw new ConfigError('catchAll（収集アカウント自身の受信箱）はちょうど 1 つ指定してください。');

  const preview = c.previewDiscordUserIds ?? [];
  if (!Array.isArray(preview) || preview.some((v) => typeof v !== 'string' || !SNOWFLAKE.test(v)) || new Set(preview).size !== preview.length) {
    throw new ConfigError('previewDiscordUserIds は Discord ID（数字の文字列）の配列で指定してください。');
  }
  const idle = c.idleHours ?? 12;
  if (typeof idle !== 'number' || !Number.isFinite(idle) || idle <= 0 || idle > 24 * 14) throw new ConfigError('idleHours は 0 より大きく 336 以下の数で指定してください。');
  if (c.backfillUseGroupDelivery !== undefined && typeof c.backfillUseGroupDelivery !== 'boolean') throw new ConfigError('backfillUseGroupDelivery は true / false で指定してください。');
  if (c.draftBccAddress !== undefined && (typeof c.draftBccAddress !== 'string' || !ADDRESS.test(c.draftBccAddress))) {
    throw new ConfigError('draftBccAddress は小文字のメールアドレスで指定してください。');
  }
  const restricted = c.restrictedSenderDomains ?? [];
  if (!Array.isArray(restricted) || restricted.some((v) => typeof v !== 'string' || !DOMAIN.test(v)) || new Set(restricted).size !== restricted.length) {
    throw new ConfigError('restrictedSenderDomains は小文字のドメイン名の配列で指定してください（例: ["bank.example.jp"]）。');
  }

  return {
    dataDir,
    mailboxes,
    domainAliases: aliases,
    ingestKey,
    previewDiscordUserIds: [...(preview as string[])],
    idleHours: idle,
    // List-Id is looked at (also for past mail).
    backfillUseGroupDelivery: c.backfillUseGroupDelivery !== false,
    draftBccAddress: typeof c.draftBccAddress === 'string' ? c.draftBccAddress : null,
    restrictedSenderDomains: [...(restricted as string[])],
    send: c.send === undefined ? null : validateSend(c.send, mailboxes, smtpPassword, typeof c.draftBccAddress === 'string'),
  };
}

/** SMM_MAIL_DIR and SMM_MAIL_CONFIG: both (Discord login only) or neither. */
export function parseMailboxConfig(env: NodeJS.ProcessEnv, discordMode: boolean): MailboxConfig | null {
  const dir = env.SMM_MAIL_DIR;
  const file = env.SMM_MAIL_CONFIG;
  if (dir === undefined && file === undefined) return null;
  if (!discordMode) throw new ConfigError('SMM_MAIL_DIR / SMM_MAIL_CONFIG は SMM_AUTH_MODE=discord でのみ指定できます。');
  if (!dir || !file) throw new ConfigError('受信箱には SMM_MAIL_DIR（保存先）と SMM_MAIL_CONFIG（設定ファイル）の両方が必要です。');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch {
    throw new ConfigError('SMM_MAIL_CONFIG を JSON として読み込めません。');
  }
  const key = readKey((raw as Record<string, unknown> | null)?.ingestKeyFile);
  const send = (raw as Record<string, unknown> | null)?.send;
  const password = send && typeof send === 'object' ? readPassword((send as Record<string, unknown>).smtpPasswordFile) : null;
  return { ...validateMailboxConfig(raw, resolve(dir), key, password), line: lineOrOff(file, resolve(dir)) };
}

/** A line.json that cannot be used turns off LINE only: the mailbox starts as before (the message names no secret). */
function lineOrOff(file: string, dir: string): LineOaConfig | null {
  try {
    return loadLineConfig(file, dir);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`公式LINE は無効のまま起動しました: ${err.message}`);
    return null;
  }
}
