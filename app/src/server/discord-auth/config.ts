import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../auth.js';
import { parseKeyMaterial } from '../tasks/signing.js';

// Private configuration of the Discord account login (SMM_AUTH_MODE=discord). It lives in one
// operator-owned JSON file outside Git, because it names real Discord IDs (guild, the chair, shared
// accounts, roles) and the key files. Nothing here is a secret by itself except the files it points to.

const SNOWFLAKE = /^[1-9]\d{16,19}$/;

export interface DiscordAuthConfig {
  guildId: string;
  /** The first account (the chair). Always an access administrator. */
  bootstrapDiscordUserId: string;
  /** Shared PCs and other non-personal Discord accounts: never registrable. */
  excludedSharedDiscordUserIds: string[];
  /** Additional access administrators by Discord user ID. */
  adminDiscordUserIds: string[];
  /** Access administrators by Discord role (e.g. a department). */
  adminRoleIds: string[];
  /** Discord role ID -> department label shown in the app. */
  departmentRoleIds: Record<string, string>;
  /** Origin written into registration-code envelopes; the Bot host's receiver checks it (kept as before). */
  registrationAudience: string;
  memberUrl: string;
  registrationDmUrl: string;
  stateFile: string;
  pepper: Buffer;
  /** Key of the svc-auth/v1 link with the Bot host: signs member/DM requests and verifies /v1/registration/issue. */
  bridgeKey: Buffer;
  /** Optional roster: Discord user ID -> real name (operator file, outside Git). */
  namesFile: string | null;
  /** Optional roster: Discord user ID -> student ID from committee documents (operator file, outside Git). */
  studentIdsFile: string | null;
  sessionDays: number;
  /** How long a signed-in account keeps working while the Bot host cannot be reached. */
  memberGraceHours: number;
  /** How long a successful membership answer is reused before asking the Bot host again. */
  memberCacheMinutes: number;
  /**
   * The bulk issue of registration codes (/v1/registration/bulk-issue) is accepted only before this time
   * (epoch ms); null closes it. Set for the evening of a bulk issue, then removed.
   */
  bulkRegistrationUntil: number | null;
}

function keyFile(path: unknown, name: string): Buffer {
  if (typeof path !== 'string' || !path) throw new ConfigError(`${name} を指定してください。`);
  let text: string;
  try {
    text = readFileSync(resolve(path), 'utf8');
  } catch {
    throw new ConfigError(`${name} の鍵ファイルを読み込めません。`);
  }
  const key = parseKeyMaterial(text);
  if (!key) throw new ConfigError(`${name} の鍵ファイルの形式が正しくありません（32 バイト以上の乱数）。`);
  return key;
}

const ids = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !SNOWFLAKE.test(v)) || new Set(value).size !== value.length) {
    throw new ConfigError(`${name} は Discord ID（数字の文字列）の配列で指定してください。`);
  }
  return [...value] as string[];
};

const httpsUrl = (value: unknown, name: string): string => {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return url.toString();
  } catch {
    // fall through
  }
  throw new ConfigError(`${name} は https の URL で指定してください。`);
};

const positive = (value: unknown, fallback: number, max: number, name: string): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) throw new ConfigError(`${name} は 0 より大きく ${max} 以下の数で指定してください。`);
  return value;
};

export function parseDiscordAuthConfig(file: string | undefined): DiscordAuthConfig {
  if (!file) throw new ConfigError('SMM_AUTH_MODE=discord では SMM_DISCORD_AUTH_CONFIG（非公開の設定ファイル）が必要です。');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<string, unknown>;
  } catch {
    throw new ConfigError('SMM_DISCORD_AUTH_CONFIG を JSON として読み込めません。');
  }
  const known = new Set([
    'guildId', 'bootstrapDiscordUserId', 'excludedSharedDiscordUserIds', 'adminDiscordUserIds', 'adminRoleIds', 'departmentRoleIds',
    'registrationAudience', 'memberUrl', 'registrationDmUrl', 'stateFile', 'pepperFile', 'bridgeKeyFile', 'namesFile', 'studentIdsFile',
    'sessionDays', 'memberGraceHours', 'memberCacheMinutes', 'bulkRegistrationUntil',
  ]);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new ConfigError(`SMM_DISCORD_AUTH_CONFIG に不明な項目があります: ${unknown.join(', ')}`);
  if (typeof raw.guildId !== 'string' || !SNOWFLAKE.test(raw.guildId)) throw new ConfigError('guildId は Discord サーバーの ID で指定してください。');
  if (typeof raw.bootstrapDiscordUserId !== 'string' || !SNOWFLAKE.test(raw.bootstrapDiscordUserId)) throw new ConfigError('bootstrapDiscordUserId は Discord ID で指定してください。');
  const departments = raw.departmentRoleIds ?? {};
  if (!departments || typeof departments !== 'object' || Array.isArray(departments)) throw new ConfigError('departmentRoleIds はロール ID と部署名の対応で指定してください。');
  for (const [role, label] of Object.entries(departments)) {
    if (!SNOWFLAKE.test(role) || typeof label !== 'string' || !label.trim() || label.length > 80) throw new ConfigError('departmentRoleIds の対応が正しくありません。');
  }
  const excluded = ids(raw.excludedSharedDiscordUserIds ?? [], 'excludedSharedDiscordUserIds');
  if (excluded.includes(raw.bootstrapDiscordUserId)) throw new ConfigError('bootstrapDiscordUserId を共有アカウントに含めることはできません。');
  const pepper = keyFile(raw.pepperFile, 'pepperFile');
  const bridgeKey = keyFile(raw.bridgeKeyFile, 'bridgeKeyFile');
  if (pepper.equals(bridgeKey)) throw new ConfigError('pepperFile と bridgeKeyFile には別の鍵を使ってください。');
  if (typeof raw.stateFile !== 'string' || !raw.stateFile) throw new ConfigError('stateFile（アカウントの保存先）を指定してください。');
  if (raw.namesFile !== undefined && (typeof raw.namesFile !== 'string' || !raw.namesFile)) throw new ConfigError('namesFile は名簿ファイルのパスで指定してください。');
  if (raw.studentIdsFile !== undefined && (typeof raw.studentIdsFile !== 'string' || !raw.studentIdsFile)) throw new ConfigError('studentIdsFile は学籍番号の名簿ファイルのパスで指定してください。');
  const audience = new URL(httpsUrl(raw.registrationAudience, 'registrationAudience')).origin;
  let bulkUntil: number | null = null;
  if (raw.bulkRegistrationUntil !== undefined && raw.bulkRegistrationUntil !== null) {
    bulkUntil = typeof raw.bulkRegistrationUntil === 'string' && /^\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:\d{2})$/.test(raw.bulkRegistrationUntil) ? Date.parse(raw.bulkRegistrationUntil) : NaN;
    if (!Number.isFinite(bulkUntil)) throw new ConfigError('bulkRegistrationUntil は時差つきの日時（例 2026-10-14T23:59:00+09:00）で指定してください。');
  }
  return {
    guildId: raw.guildId,
    bootstrapDiscordUserId: raw.bootstrapDiscordUserId,
    excludedSharedDiscordUserIds: excluded,
    adminDiscordUserIds: ids(raw.adminDiscordUserIds ?? [], 'adminDiscordUserIds'),
    adminRoleIds: ids(raw.adminRoleIds ?? [], 'adminRoleIds'),
    departmentRoleIds: Object.fromEntries(Object.entries(departments as Record<string, string>).map(([k, v]) => [k, v.trim()])),
    registrationAudience: audience,
    memberUrl: httpsUrl(raw.memberUrl, 'memberUrl'),
    registrationDmUrl: httpsUrl(raw.registrationDmUrl, 'registrationDmUrl'),
    stateFile: resolve(raw.stateFile),
    pepper,
    bridgeKey,
    namesFile: typeof raw.namesFile === 'string' ? resolve(raw.namesFile) : null,
    studentIdsFile: typeof raw.studentIdsFile === 'string' ? resolve(raw.studentIdsFile) : null,
    sessionDays: positive(raw.sessionDays, 14, 31, 'sessionDays'),
    memberGraceHours: positive(raw.memberGraceHours, 48, 168, 'memberGraceHours'),
    memberCacheMinutes: positive(raw.memberCacheMinutes, 10, 60, 'memberCacheMinutes'),
    bulkRegistrationUntil: bulkUntil,
  };
}
