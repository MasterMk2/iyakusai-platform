import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { GOOGLE_CUSTOMER_ID, GOOGLE_GROUP_ID } from './account/google-directory.js';
import { ConfigError, normalizeAddress, parseAuthMode, parsePublicOrigin, parseTrustedProxies, parseUserMap, type AuthConfig } from './auth.js';
import { LINK_EVIDENCE, type LinkEvidence } from './login/types.js';
import { parseDiscordAuthConfig, type DiscordAuthConfig } from './discord-auth/config.js';
import { parseKeyMaterial } from './tasks/signing.js';
import { parseMailboxConfig, type MailboxConfig } from './mailbox/config.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** LINE inbox: off, or the mock connector with its own data file (never the mail data file). */
export type LineConfig = { mode: 'off' } | { mode: 'mock'; dataFile: string };

/** Task gateway to the separate Task service. */
export type TaskGatewayConfig =
  | { mode: 'off' }
  | {
      /** The Task service runs in this process on its own state file (the unified app). */
      mode: 'in-process';
      dataFile: string;
      /** Identity bridge map text (operator file), or null for the synthetic demo/mock map. */
      bridgeText: string | null;
      linkFile: string;
    }
  | {
      mode: 'on';
      serviceUrl: string;
      key: Buffer;
      /** Identity bridge map text (operator file), or null for the synthetic demo/mock map. */
      bridgeText: string | null;
      linkFile: string;
    };

/**
 * Bot tab (IyakusaiBot integration, ../docs/contracts/bot-front.md). Off by default. On uses the
 * Bot host's signed task API (same URL and key as SMM_TASK_SERVICE_URL / SMM_TASK_GATEWAY_KEY_FILE).
 */
export type AssistantConfig = { mode: 'off' } | { mode: 'on'; serviceUrl: string; key: Buffer };

interface AccountProductionCommon {
  composition: 'production';
  pepper: Buffer;
  storeFile: string;
  auditFile: string;
  groupId: string;
  organizationId: string | undefined;
  linkEvidence: LinkEvidence[];
  serviceLabel: string;
}

/** DM transport of the direct-provider composition: refused, or the existing signed bridge DM contract. */
export type DirectDmTransport = { transport: 'unavailable' } | { transport: 'identity-bridge'; bridgeUrl: string; bridgeKey: Buffer };

/**
 * Account providers: synthetic (mock), the operator's signed identity bridge (production default),
 * or the explicit opt-in in-process direct providers (Directory read + authoritative registry file).
 */
export type AccountProviderConfig =
  | { composition: 'mock' }
  | (AccountProductionCommon & { provider: 'bridge'; bridgeUrl: string; bridgeKey: Buffer })
  | (AccountProductionCommon & {
      provider: 'direct';
      /** Directory access-token file (read-only reference; never copied, minted or refreshed here). */
      tokenFile: string;
      /** Identity registry file (outside Git, owner-only). */
      registryFile: string;
      dm: DirectDmTransport;
    });

export type RentalConfig =
  | { mode: 'off' }
  | {
      mode: 'on';
      /** Folder of the rental ledger (rental.sqlite3 and photo spool), the same layout as the Python server's. */
      dataDir: string;
      /** Origin written on labels and cards; null (demo only) accepts any https origin. */
      itemOrigin: string | null;
      webDir: string;
      /** Synthetic sample items, borrowers and permissions (demo and mock compositions). */
      demo: boolean;
      /** Every authenticated active member administers rental only; explicitly enabled by the operator. */
      allMembersAdmin: boolean;
      /** Key of the signed copy to Google Drive (SMM_RENTAL_DRIVE_SYNC_KEY_FILE, Discord login only), or null. */
      driveSyncKey: Buffer | null;
    };

export interface ServerConfig {
  host: string;
  port: number;
  dataFile: string;
  staticDir: string;
  auth: AuthConfig;
  line: LineConfig;
  tasks: TaskGatewayConfig;
  assistant: AssistantConfig;
  rental: RentalConfig;
  account: AccountProviderConfig | null;
  /** Discord login (SMM_AUTH_MODE=discord) only: the private login configuration. */
  discord: DiscordAuthConfig | null;
  /** Discord login only: the committee mailbox (SMM_MAIL_DIR + SMM_MAIL_CONFIG), or null. */
  mailbox: MailboxConfig | null;
  /** Discord login only: key of the Bot's read-only data source (SMM_BOT_DATASOURCE_KEY_FILE), or null for no such route. */
  botDatasourceKey: Buffer | null;
  /** Account production only: a missing mail data file may be seeded with the synthetic sample. */
  allowSampleSeed: boolean;
}

/**
 * Demo mode enables the mock LINE inbox by default, stored next to the demo data file.
 * Trusted-proxy mode keeps it off unless explicitly enabled with a separate data file,
 * so an existing hosted trial never gains LINE records implicitly.
 */
export function parseLineConfig(env: NodeJS.ProcessEnv, mode: 'demo' | 'trusted-proxy', mailDataFile: string): LineConfig {
  const raw = env.SMM_LINE_MODE ?? (mode === 'demo' ? 'mock' : 'off');
  if (raw !== 'off' && raw !== 'mock') throw new ConfigError('SMM_LINE_MODE は "off" または "mock" のどちらかを正確に指定してください（実際の LINE 接続はありません）。');
  if (raw === 'off') {
    if (env.SMM_LINE_DATA_FILE !== undefined) throw new ConfigError('SMM_LINE_DATA_FILE は SMM_LINE_MODE=mock のときだけ指定できます。');
    return { mode: 'off' };
  }
  if (mode === 'trusted-proxy' && !env.SMM_LINE_DATA_FILE) {
    throw new ConfigError('trusted-proxy モードで LINE を有効にするには、専用の SMM_LINE_DATA_FILE が必要です。');
  }
  const dataFile = resolve(env.SMM_LINE_DATA_FILE ?? mailDataFile.replace(/\.json$/i, '') + '.line.json');
  if (dataFile.toLowerCase() === mailDataFile.toLowerCase()) throw new ConfigError('SMM_LINE_DATA_FILE にはメールのデータファイルと別のファイルを指定してください。');
  return { mode: 'mock', dataFile };
}

/** Reads a secret key file. POSIX: refuses group/other-readable files. Messages never echo paths or contents. */
export function readKeyFile(file: string | undefined, name: string): Buffer {
  if (!file) throw new ConfigError(`${name} が未設定です。`);
  let text: string;
  try {
    const stat = statSync(file);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ConfigError(`${name} の鍵ファイルは所有者だけが読める権限（600 など）にしてください。`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${name} の鍵ファイルを読み込めません。`);
  }
  const key = parseKeyMaterial(text);
  if (!key) throw new ConfigError(`${name} の鍵は 32 バイト以上のランダム値（16 進または base64）でなければなりません。`);
  return key;
}

/**
 * Internal service origin (identity bridge, Task service): https, or plain http ONLY to the exact
 * loopback literals 127.0.0.1 / [::1] on the same host. Cleartext to any other address (including
 * private-network IPs) is refused: login codes, membership answers and task data would cross the
 * network unencrypted, and the bridge's answers are trusted on the strength of the transport alone.
 * No credentials, path, query or fragment.
 */
export function parseServiceUrl(value: string, name: string, loopbackOnly: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} は URL として解釈できません。`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.replace(/\/$/, '') !== url.origin) {
    throw new ConfigError(`${name} はパスや認証情報のないオリジンで指定してください。`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === '::1';
  if (loopbackOnly && !(url.protocol === 'http:' && loopback)) throw new ConfigError(`${name} はこのモードではループバックの http アドレスだけを指定できます。`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} は http または https で指定してください。`);
  if (url.protocol === 'http:' && !loopback) {
    throw new ConfigError(`${name} は https で指定してください（平文の http は同じホストのループバック 127.0.0.1 / [::1] だけ）。`);
  }
  return url.origin;
}

/**
 * The Bot data source's own key: never the same value as another key the app holds (so a leak of this read-only
 * key reveals nothing else, and no other key can call the route). `others` are the keys already loaded.
 */
export function parseBotDatasourceKey(env: NodeJS.ProcessEnv, others: readonly (Buffer | null | undefined)[]): Buffer | null {
  if (env.SMM_BOT_DATASOURCE_KEY_FILE === undefined) return null;
  const key = readKeyFile(env.SMM_BOT_DATASOURCE_KEY_FILE, 'SMM_BOT_DATASOURCE_KEY_FILE');
  if (others.some((other) => other?.equals(key))) throw new ConfigError('SMM_BOT_DATASOURCE_KEY_FILE の鍵は、ペッパー・本人 bridge・タスク連携・メール収集・物品の Drive 複製の鍵とは別の値にしてください。');
  return key;
}

const TASK_VARS = ['SMM_TASK_GATEWAY_KEY_FILE', 'SMM_TASK_BRIDGE_FILE', 'SMM_TASK_LINK_FILE'] as const;

function readTaskBridge(env: NodeJS.ProcessEnv, synthetic: boolean, derived = false): string | null {
  if (derived) {
    // Discord login: the task user is derived from the verified Discord account (discord-<ID>).
    if (env.SMM_TASK_BRIDGE_FILE !== undefined) throw new ConfigError('discord モードでは SMM_TASK_BRIDGE_FILE は使いません（Discord アカウントから対応を決めます）。');
    return null;
  }
  if (env.SMM_TASK_BRIDGE_FILE) {
    try {
      return readFileSync(resolve(env.SMM_TASK_BRIDGE_FILE), 'utf8');
    } catch {
      throw new ConfigError('タスク本人対応表（SMM_TASK_BRIDGE_FILE）を読み込めません。');
    }
  }
  if (!synthetic) throw new ConfigError('このモードでは SMM_TASK_BRIDGE_FILE（タスク本人対応表）が必要です。');
  return null;
}

function taskLinkFile(env: NodeJS.ProcessEnv, mailDataFile: string): string {
  const linkFile = resolve(env.SMM_TASK_LINK_FILE ?? mailDataFile.replace(/\.json$/i, '') + '.task-links.json');
  if (linkFile.toLowerCase() === mailDataFile.toLowerCase()) throw new ConfigError('SMM_TASK_LINK_FILE にはメールのデータファイルと別のファイルを指定してください。');
  return linkFile;
}

/** SMM_ASSISTANT_MODE=on|off (default off). On needs the signed Bot-host task API, and nothing else is read. */
export function parseAssistantConfig(env: NodeJS.ProcessEnv, tasks: TaskGatewayConfig): AssistantConfig {
  const raw = env.SMM_ASSISTANT_MODE ?? 'off';
  if (raw !== 'on' && raw !== 'off') throw new ConfigError('SMM_ASSISTANT_MODE は on か off を指定してください。');
  if (raw === 'off') return { mode: 'off' };
  if (tasks.mode !== 'on') {
    throw new ConfigError('SMM_ASSISTANT_MODE=on には SMM_TASK_SERVICE_URL と SMM_TASK_GATEWAY_KEY_FILE（Bot ホストのタスク API）が必要です。');
  }
  return { mode: 'on', serviceUrl: tasks.serviceUrl, key: tasks.key };
}

export function parseTaskGatewayConfig(env: NodeJS.ProcessEnv, mode: ReturnType<typeof parseAuthMode>, mailDataFile: string): TaskGatewayConfig {
  const synthetic = mode === 'demo' || mode === 'account-mock';
  if (env.SMM_TASK_DATA_FILE !== undefined) {
    if (env.SMM_TASK_SERVICE_URL !== undefined || env.SMM_TASK_GATEWAY_KEY_FILE !== undefined) {
      throw new ConfigError('SMM_TASK_DATA_FILE（同じプロセスのタスク）と SMM_TASK_SERVICE_URL / SMM_TASK_GATEWAY_KEY_FILE（別サービス）は同時に指定できません。');
    }
    if (env.SMM_TASK_DATA_FILE === '') throw new ConfigError('SMM_TASK_DATA_FILE にはタスクの保存ファイルを指定してください。');
    const bridgeText = readTaskBridge(env, synthetic, mode === 'discord');
    const linkFile = taskLinkFile(env, mailDataFile);
    const dataFile = resolve(env.SMM_TASK_DATA_FILE);
    if ([mailDataFile, linkFile].some((other) => other.toLowerCase() === dataFile.toLowerCase())) {
      throw new ConfigError('SMM_TASK_DATA_FILE にはメールのデータ・タスク関連付けと別のファイルを指定してください。');
    }
    return { mode: 'in-process', dataFile, bridgeText, linkFile };
  }
  const url = env.SMM_TASK_SERVICE_URL;
  if (!url) {
    const stray = TASK_VARS.filter((name) => env[name] !== undefined);
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} は SMM_TASK_DATA_FILE か SMM_TASK_SERVICE_URL と一緒に指定してください。`);
    if (mode === 'account' || mode === 'discord') throw new ConfigError(`${mode} モードではタスク（SMM_TASK_DATA_FILE か SMM_TASK_SERVICE_URL）が必要です。`);
    return { mode: 'off' };
  }
  const serviceUrl = parseServiceUrl(url, 'SMM_TASK_SERVICE_URL', synthetic);
  const key = readKeyFile(env.SMM_TASK_GATEWAY_KEY_FILE, 'SMM_TASK_GATEWAY_KEY_FILE');
  const bridgeText = readTaskBridge(env, synthetic, mode === 'discord');
  return { mode: 'on', serviceUrl, key, bridgeText, linkFile: taskLinkFile(env, mailDataFile) };
}

export function parseRentalConfig(env: NodeJS.ProcessEnv, mode: ReturnType<typeof parseAuthMode>): RentalConfig {
  const dir = env.SMM_RENTAL_DATA_DIR;
  if (!dir) {
    const stray = ['SMM_RENTAL_ITEM_ORIGIN', 'SMM_RENTAL_WEB_DIR', 'SMM_RENTAL_DRIVE_SYNC_KEY_FILE', 'SMM_RENTAL_ALL_MEMBERS_ADMIN'].filter((name) => env[name] !== undefined);
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} は SMM_RENTAL_DATA_DIR と一緒に指定してください。`);
    return { mode: 'off' };
  }
  const adminSetting = env.SMM_RENTAL_ALL_MEMBERS_ADMIN;
  if (adminSetting !== undefined && adminSetting !== 'true' && adminSetting !== 'false') {
    throw new ConfigError('SMM_RENTAL_ALL_MEMBERS_ADMIN は true または false で指定してください。');
  }
  const allMembersAdmin = adminSetting === 'true';
  const synthetic = mode === 'demo' || mode === 'account-mock';
  let itemOrigin: string | null = null;
  if (env.SMM_RENTAL_ITEM_ORIGIN) {
    let url: URL;
    try {
      url = new URL(env.SMM_RENTAL_ITEM_ORIGIN);
    } catch {
      throw new ConfigError('SMM_RENTAL_ITEM_ORIGIN を URL として解釈できません。');
    }
    if (url.protocol !== 'https:' || url.origin !== env.SMM_RENTAL_ITEM_ORIGIN) {
      throw new ConfigError('SMM_RENTAL_ITEM_ORIGIN は https の正規オリジン（パス・末尾スラッシュなし）で指定してください。');
    }
    itemOrigin = url.origin;
  } else if (!synthetic) {
    throw new ConfigError('このモードでは SMM_RENTAL_ITEM_ORIGIN（ラベル・カードに書く URL のオリジン）が必要です。');
  }
  // The copy to Drive (an Apps Script fetching over signed requests) is for the committee's real ledger only.
  let driveSyncKey: Buffer | null = null;
  if (env.SMM_RENTAL_DRIVE_SYNC_KEY_FILE !== undefined) {
    if (mode !== 'discord') throw new ConfigError('物品の Drive 同期（SMM_RENTAL_DRIVE_SYNC_KEY_FILE）は discord モードでだけ使えます。');
    driveSyncKey = readKeyFile(env.SMM_RENTAL_DRIVE_SYNC_KEY_FILE, 'SMM_RENTAL_DRIVE_SYNC_KEY_FILE');
  }
  return { mode: 'on', dataDir: resolve(dir), itemOrigin, webDir: resolve(env.SMM_RENTAL_WEB_DIR ?? 'dist/rental-web'), demo: synthetic, driveSyncKey, allMembersAdmin };
}

const DIRECT_VARS = ['SMM_DIRECTORY_TOKEN_FILE', 'SMM_IDENTITY_REGISTRY_FILE', 'SMM_AUTH_DM_TRANSPORT', 'SMM_DIRECTORY_CACHE_MS'] as const;
const ACCOUNT_VARS = [
  'SMM_AUTH_PEPPER_FILE',
  'SMM_AUTH_STORE_FILE',
  'SMM_AUTH_AUDIT_FILE',
  'SMM_IDENTITY_PROVIDER',
  'SMM_IDENTITY_BRIDGE_URL',
  'SMM_IDENTITY_BRIDGE_KEY_FILE',
  'SMM_AUTH_GROUP_ID',
  'SMM_AUTH_ORGANIZATION_ID',
  'SMM_AUTH_LINK_EVIDENCE',
  'SMM_AUTH_SERVICE_LABEL',
  ...DIRECT_VARS,
] as const;

function parseBridge(env: NodeJS.ProcessEnv, pepper: Buffer): { bridgeUrl: string; bridgeKey: Buffer } {
  const bridgeKey = readKeyFile(env.SMM_IDENTITY_BRIDGE_KEY_FILE, 'SMM_IDENTITY_BRIDGE_KEY_FILE');
  if (bridgeKey.equals(pepper)) throw new ConfigError('本人 bridge の鍵とペッパーには別々の値を使ってください。');
  if (!env.SMM_IDENTITY_BRIDGE_URL) throw new ConfigError('SMM_IDENTITY_BRIDGE_URL（本人 bridge）が未設定です。');
  return { bridgeUrl: parseServiceUrl(env.SMM_IDENTITY_BRIDGE_URL, 'SMM_IDENTITY_BRIDGE_URL', false), bridgeKey };
}

/** An operator file reference: required, resolved to an absolute path. The file itself is checked at use. */
function fileReference(env: NodeJS.ProcessEnv, name: string, label: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`${name}（${label}）が未設定です。`);
  return resolve(value);
}

/**
 * Direct-provider settings (SMM_IDENTITY_PROVIDER=direct): Google Directory read with an access-token
 * file, the identity registry file, and an explicit DM transport. No new internal bridge is needed:
 * SMM_IDENTITY_BRIDGE_URL is only accepted for the signed bridge DM transport. Live use is blocked
 * until a credential lifecycle, registry ingestion from a verified authority and a real DM exist.
 */
function parseDirect(env: NodeJS.ProcessEnv, pepper: Buffer, groupId: string): Omit<Extract<AccountProviderConfig, { provider: 'direct' }>, keyof AccountProductionCommon> {
  if (!GOOGLE_GROUP_ID.test(groupId)) throw new ConfigError('direct 構成では SMM_AUTH_GROUP_ID に Group の安定 ID（メールアドレスや別名ではない）を指定してください。');
  if (!env.SMM_AUTH_ORGANIZATION_ID || !GOOGLE_CUSTOMER_ID.test(env.SMM_AUTH_ORGANIZATION_ID)) {
    throw new ConfigError('direct 構成では SMM_AUTH_ORGANIZATION_ID に組織の顧客 ID（C で始まる ID）が必要です。');
  }
  const tokenFile = fileReference(env, 'SMM_DIRECTORY_TOKEN_FILE', '既存の Directory アクセストークンのファイル');
  const registryFile = fileReference(env, 'SMM_IDENTITY_REGISTRY_FILE', '本人紐付けレジストリ');
  if (tokenFile.toLowerCase() === registryFile.toLowerCase()) throw new ConfigError('トークンのファイルとレジストリには別々のファイルを指定してください。');
  // Authorization is read fresh on every request; no reuse window can be configured (not even 0).
  if (env.SMM_DIRECTORY_CACHE_MS !== undefined) throw new ConfigError('SMM_DIRECTORY_CACHE_MS は廃止しました（認可は要求ごとに Directory を読み直します）。設定を削除してください。');
  const transport = env.SMM_AUTH_DM_TRANSPORT;
  let dm: DirectDmTransport;
  if (transport === 'unavailable') {
    const stray = ['SMM_IDENTITY_BRIDGE_URL', 'SMM_IDENTITY_BRIDGE_KEY_FILE'].filter((name) => env[name] !== undefined);
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} は SMM_AUTH_DM_TRANSPORT=identity-bridge のときだけ指定できます。`);
    dm = { transport: 'unavailable' };
  } else if (transport === 'identity-bridge') {
    dm = { transport: 'identity-bridge', ...parseBridge(env, pepper) };
  } else {
    throw new ConfigError('direct 構成では SMM_AUTH_DM_TRANSPORT に "unavailable" か "identity-bridge" を明示してください。');
  }
  return { provider: 'direct', tokenFile, registryFile, dm };
}

function parseAccountProduction(env: NodeJS.ProcessEnv): Extract<AccountProviderConfig, { composition: 'production' }> {
  const provider = env.SMM_IDENTITY_PROVIDER ?? 'bridge';
  if (provider !== 'bridge' && provider !== 'direct') throw new ConfigError('SMM_IDENTITY_PROVIDER は "bridge" または "direct" を指定してください。');
  if (provider === 'bridge') {
    const stray = DIRECT_VARS.filter((name) => env[name] !== undefined);
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} は SMM_IDENTITY_PROVIDER=direct でのみ指定できます。`);
  }
  const pepper = readKeyFile(env.SMM_AUTH_PEPPER_FILE, 'SMM_AUTH_PEPPER_FILE');
  if (!env.SMM_AUTH_STORE_FILE) throw new ConfigError('SMM_AUTH_STORE_FILE（ログイン状態の保存先）が未設定です。');
  if (!env.SMM_AUTH_AUDIT_FILE) throw new ConfigError('SMM_AUTH_AUDIT_FILE（認証監査ログ）が未設定です。');
  const groupId = env.SMM_AUTH_GROUP_ID;
  if (!groupId) throw new ConfigError('SMM_AUTH_GROUP_ID（対象 Group の安定 ID）が未設定です。');
  const evidence = (env.SMM_AUTH_LINK_EVIDENCE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (evidence.length === 0 || evidence.some((e) => !LINK_EVIDENCE.includes(e as LinkEvidence))) throw new ConfigError('SMM_AUTH_LINK_EVIDENCE（承認済みの紐付け根拠）が未設定または不正です。');
  const common: AccountProductionCommon = {
    composition: 'production',
    pepper,
    storeFile: resolve(env.SMM_AUTH_STORE_FILE),
    auditFile: resolve(env.SMM_AUTH_AUDIT_FILE),
    groupId,
    organizationId: env.SMM_AUTH_ORGANIZATION_ID || undefined,
    linkEvidence: evidence as LinkEvidence[],
    serviceLabel: env.SMM_AUTH_SERVICE_LABEL ?? '共有受信と委員会タスク',
  };
  if (provider === 'direct') return { ...common, ...parseDirect(env, pepper, groupId) };
  return { ...common, provider: 'bridge', ...parseBridge(env, pepper) };
}

/**
 * Server configuration. Demo and account-mock accept only loopback hosts. Trusted-proxy and
 * account (production) additionally permit a container-private bind address, but only after
 * every required origin, proxy allowlist, provider and secret validated. Nothing here writes data.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const base = loadBaseConfig(env);
  return { ...base, assistant: parseAssistantConfig(env, base.tasks) };
}

function loadBaseConfig(env: NodeJS.ProcessEnv): Omit<ServerConfig, 'assistant'> {
  const mode = parseAuthMode(env);
  const host = env.SMM_HOST ?? '127.0.0.1';
  const port = Number(env.SMM_PORT ?? '5178');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('SMM_PORT must be a valid port number.');
  const paths = {
    dataFile: resolve(env.SMM_DATA_FILE ?? 'data/demo-state.json'),
    staticDir: resolve(env.SMM_STATIC_DIR ?? 'dist/client'),
  };
  if (mode !== 'discord' && env.SMM_DISCORD_AUTH_CONFIG !== undefined) throw new ConfigError('SMM_DISCORD_AUTH_CONFIG は SMM_AUTH_MODE=discord でのみ指定できます。');
  if (mode !== 'discord' && env.SMM_BOT_DATASOURCE_KEY_FILE !== undefined) throw new ConfigError('SMM_BOT_DATASOURCE_KEY_FILE は SMM_AUTH_MODE=discord でのみ指定できます。');
  const mailbox = parseMailboxConfig(env, mode === 'discord');
  if (mode !== 'account') {
    const stray = ACCOUNT_VARS.filter((name) => env[name] !== undefined);
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} は SMM_AUTH_MODE=account でのみ指定できます。`);
    if (env.SMM_ALLOW_SAMPLE_SEED !== undefined) throw new ConfigError('SMM_ALLOW_SAMPLE_SEED は SMM_AUTH_MODE=account でのみ指定できます。');
  }

  if (mode === 'demo' || mode === 'account-mock') {
    if (!LOOPBACK.has(host)) {
      throw new ConfigError(`SMM_HOST must be a loopback address for this demo (got "${host}").`);
    }
    const auth: AuthConfig = mode === 'demo' ? { mode: 'demo' } : { mode: 'account', composition: 'mock', publicOrigin: null, publicHost: null, trustedProxies: new Set() };
    return {
      host,
      port,
      ...paths,
      auth,
      line: parseLineConfig(env, 'demo', paths.dataFile),
      tasks: parseTaskGatewayConfig(env, mode, paths.dataFile),
      rental: parseRentalConfig(env, mode),
      account: mode === 'demo' ? null : { composition: 'mock' },
      discord: null,
      mailbox,
      botDatasourceKey: null,
      allowSampleSeed: true,
    };
  }

  // Only an IP literal may be bound; host names could resolve to anything.
  if (!normalizeAddress(host)) throw new ConfigError(`SMM_HOST must be an IP address literal in ${mode} mode.`);
  const { origin, host: publicHost } = parsePublicOrigin(env.SMM_PUBLIC_ORIGIN);
  const trustedProxies = parseTrustedProxies(env.SMM_TRUSTED_PROXY_ADDRESSES);
  if (mode === 'discord') {
    if (env.SMM_USER_MAP_FILE !== undefined) throw new ConfigError('SMM_USER_MAP_FILE は trusted-proxy モード専用です。');
    if (env.SMM_ALLOW_SAMPLE_SEED !== undefined) throw new ConfigError('discord モードでは合成データを作りません（SMM_ALLOW_SAMPLE_SEED は指定できません）。');
    const line = parseLineConfig(env, 'trusted-proxy', paths.dataFile);
    const tasks = parseTaskGatewayConfig(env, mode, paths.dataFile);
    const rental = parseRentalConfig(env, mode);
    const discord = parseDiscordAuthConfig(env.SMM_DISCORD_AUTH_CONFIG);
    return {
      host,
      port,
      ...paths,
      auth: { mode: 'discord', publicOrigin: origin, publicHost, trustedProxies },
      line,
      tasks,
      rental,
      account: null,
      discord,
      mailbox,
      botDatasourceKey: parseBotDatasourceKey(env, [discord.pepper, discord.bridgeKey, tasks.mode === 'on' ? tasks.key : null, mailbox?.ingestKey, rental.mode === 'on' ? rental.driveSyncKey : null]),
      allowSampleSeed: false,
    };
  }
  if (mode === 'account') {
    if (env.SMM_USER_MAP_FILE !== undefined) throw new ConfigError('SMM_USER_MAP_FILE は trusted-proxy モード専用です（account モードは本人 bridge を使います）。');
    const seed = env.SMM_ALLOW_SAMPLE_SEED;
    if (seed !== undefined && seed !== 'synthetic-trial') throw new ConfigError('SMM_ALLOW_SAMPLE_SEED は "synthetic-trial" だけを指定できます。');
    const account = parseAccountProduction(env);
    return {
      host,
      port,
      ...paths,
      auth: { mode: 'account', composition: 'production', publicOrigin: origin, publicHost, trustedProxies },
      line: parseLineConfig(env, 'trusted-proxy', paths.dataFile),
      tasks: parseTaskGatewayConfig(env, mode, paths.dataFile),
      rental: parseRentalConfig(env, mode),
      account,
      discord: null,
      mailbox,
      botDatasourceKey: null,
      allowSampleSeed: seed === 'synthetic-trial',
    };
  }
  if (!env.SMM_USER_MAP_FILE) throw new ConfigError('SMM_USER_MAP_FILE が未設定です。');
  let text: string;
  try {
    text = readFileSync(resolve(env.SMM_USER_MAP_FILE), 'utf8');
  } catch {
    throw new ConfigError('利用者対応表（SMM_USER_MAP_FILE）を読み込めません。');
  }
  const identities = parseUserMap(text);
  const line = parseLineConfig(env, 'trusted-proxy', paths.dataFile);
  return {
    host,
    port,
    ...paths,
    auth: { mode: 'trusted-proxy', publicOrigin: origin, publicHost, trustedProxies, identities },
    line,
    tasks: parseTaskGatewayConfig(env, mode, paths.dataFile),
    rental: parseRentalConfig(env, mode),
    account: null,
    discord: null,
    mailbox,
    botDatasourceKey: null,
    allowSampleSeed: true,
  };
}
