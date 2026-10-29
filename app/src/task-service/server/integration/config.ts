import { readFileSync, statSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import type { AppState } from '../domain/state.js';
import { parseKeyMaterial, type ClientId } from './signing.js';

// 保護モード（共通 Web のゲートウェイと Discord 連携専用）の設定。
// 不足・不正があれば起動を拒否し、デモへ切り替えることはしない。
// エラーメッセージには鍵・パス・識別子の値を含めない。

export class IntegrationConfigError extends Error {}

const SNOWFLAKE = /^[1-9]\d{16,19}$/;
const ID = /^[a-z0-9-]{1,64}$/;

export interface DiscordBindings {
  /** guild ID → (channel ID → 委員会 ID) */
  channels: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** 検証済み Discord 利用者 ID → 内部利用者 ID */
  users: ReadonlyMap<string, string>;
}

export interface ProtectedConfig {
  host: string;
  port: number;
  dataFile: string;
  /** 同じホストのループバックか、運用者が確認した TLS 終端の背後か。 */
  transport: TransportMode;
  /** 接続を受け付ける送信元ソケットのアドレス（ゲートウェイ・連携 Bot、または TLS 終端）。 */
  trustedClients: ReadonlySet<string>;
  keys: ReadonlyMap<ClientId, Buffer>;
  discord: DiscordBindings | null;
}

export function normalizeAddress(address: string | undefined): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const candidate = mapped ? mapped[1]! : address;
  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family === 6) return new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  return null;
}

function readKey(file: string | undefined, name: string): Buffer {
  if (!file) throw new IntegrationConfigError(`${name} が未設定です。`);
  let text: string;
  try {
    const stat = statSync(file);
    // POSIX では所有者以外が読める鍵ファイルを拒否する（Windows では権限の形式が異なるため確認しない）。
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new IntegrationConfigError(`${name} の鍵ファイルは所有者だけが読める権限（600 など）にしてください。`);
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof IntegrationConfigError) throw error;
    throw new IntegrationConfigError(`${name} の鍵ファイルを読み込めません。`);
  }
  const key = parseKeyMaterial(text);
  if (!key) throw new IntegrationConfigError(`${name} の鍵は 32 バイト以上のランダム値（16 進または base64）でなければなりません。`);
  return key;
}

/**
 * Discord 連携の対応表。運用者が確認済みの guild/channel → 委員会、Discord 利用者 → 内部利用者だけを書く。
 * { "version": 1, "guilds": [{ "guildId", "channels": [{ "channelId", "workspaceId" }] }], "users": [{ "discordUserId", "userId" }] }
 */
export function parseDiscordBindings(text: string): DiscordBindings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntegrationConfigError('Discord 対応表を JSON として読み込めません。');
  }
  const root = parsed as { version?: unknown; guilds?: unknown; users?: unknown };
  if (!root || typeof root !== 'object' || Array.isArray(root) || Object.keys(root).some((k) => !['version', 'guilds', 'users'].includes(k))) {
    throw new IntegrationConfigError('Discord 対応表の形式が正しくありません。');
  }
  if (root.version !== 1 || !Array.isArray(root.guilds) || !Array.isArray(root.users)) throw new IntegrationConfigError('Discord 対応表の version / guilds / users が正しくありません。');
  const channels = new Map<string, Map<string, string>>();
  const seenChannels = new Set<string>();
  root.guilds.forEach((g: unknown, gi: number) => {
    const guild = g as { guildId?: unknown; channels?: unknown };
    if (!guild || typeof guild !== 'object' || typeof guild.guildId !== 'string' || !SNOWFLAKE.test(guild.guildId) || !Array.isArray(guild.channels)) {
      throw new IntegrationConfigError(`Discord 対応表の guild ${gi + 1} 番目が正しくありません。`);
    }
    if (channels.has(guild.guildId)) throw new IntegrationConfigError(`Discord 対応表の guild ${gi + 1} 番目が重複しています。`);
    const map = new Map<string, string>();
    guild.channels.forEach((c: unknown, ci: number) => {
      const channel = c as { channelId?: unknown; workspaceId?: unknown };
      if (!channel || typeof channel.channelId !== 'string' || !SNOWFLAKE.test(channel.channelId) || typeof channel.workspaceId !== 'string' || !ID.test(channel.workspaceId)) {
        throw new IntegrationConfigError(`Discord 対応表の guild ${gi + 1} 番目の channel ${ci + 1} 番目が正しくありません。`);
      }
      if (seenChannels.has(channel.channelId)) throw new IntegrationConfigError(`Discord 対応表の channel が重複しています（guild ${gi + 1} 番目の ${ci + 1} 番目）。`);
      seenChannels.add(channel.channelId);
      map.set(channel.channelId, channel.workspaceId);
    });
    channels.set(guild.guildId, map);
  });
  const users = new Map<string, string>();
  const mappedUsers = new Set<string>();
  root.users.forEach((u: unknown, ui: number) => {
    const user = u as { discordUserId?: unknown; userId?: unknown };
    if (!user || typeof user.discordUserId !== 'string' || !SNOWFLAKE.test(user.discordUserId) || typeof user.userId !== 'string' || !ID.test(user.userId)) {
      throw new IntegrationConfigError(`Discord 対応表の user ${ui + 1} 番目が正しくありません。`);
    }
    if (users.has(user.discordUserId) || mappedUsers.has(user.userId)) throw new IntegrationConfigError(`Discord 対応表の user ${ui + 1} 番目が重複しています（1 人に 1 アカウント）。`);
    users.set(user.discordUserId, user.userId);
    mappedUsers.add(user.userId);
  });
  return { channels, users };
}

/** 対応表が存在しない委員会・利用者を指していれば起動を拒否する。 */
export function assertBindingsMatchState(bindings: DiscordBindings, state: AppState): void {
  for (const map of bindings.channels.values()) {
    for (const workspaceId of map.values()) {
      if (!state.workspaces.some((w) => w.id === workspaceId)) throw new IntegrationConfigError('Discord 対応表に存在しない委員会が含まれています。');
    }
  }
  for (const userId of bindings.users.values()) {
    if (!state.users.some((u) => u.id === userId)) throw new IntegrationConfigError('Discord 対応表に存在しない利用者が含まれています。');
  }
}

/**
 * ループバック以外での待受を運用者が明示的に認める値（秘密ではない）。Task API は TLS を終端せず、応答（タスクの内容）は
 * 暗号化も署名もされない。この値は「ゲートウェイと Discord 連携 Bot の両方が、運用者の TLS 終端（証明書を検証する https）
 * だけを経由して接続し、終端から Task API までは運用者が管理する私設ネットワーク内に限られる」ことの確認を表す。
 */
export const NON_LOOPBACK_TRANSPORT_ACK = 'operator-tls-termination-for-gateway-and-discord-bridge';

export type TransportMode = 'loopback' | 'operator-tls-termination';

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_NETWORKS.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_NETWORKS.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6');

const isPrivate = (address: string) => PRIVATE_NETWORKS.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

export function loadProtectedConfig(env: NodeJS.ProcessEnv = process.env): ProtectedConfig {
  const host = env.HOST ?? '127.0.0.1';
  const normalizedHost = normalizeAddress(host);
  if (!normalizedHost || normalizedHost === '0.0.0.0' || normalizedHost === '::') {
    throw new IntegrationConfigError('保護モードの HOST は特定の IP アドレス（ループバックまたは内部ネットワーク）で指定してください。');
  }
  const port = Number(env.PORT ?? '');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new IntegrationConfigError('PORT は 1〜65535 の整数で指定してください。');
  if (!env.DTM_DATA_FILE) throw new IntegrationConfigError('DTM_DATA_FILE が未設定です。');
  const trusted = new Set<string>();
  for (const entry of (env.DTM_TRUSTED_CLIENT_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const normalized = normalizeAddress(entry);
    if (!normalized || normalized === '0.0.0.0' || normalized === '::') throw new IntegrationConfigError('DTM_TRUSTED_CLIENT_ADDRESSES には単一の IP アドレスだけを指定してください。');
    trusted.add(normalized);
  }
  if (trusted.size === 0) throw new IntegrationConfigError('DTM_TRUSTED_CLIENT_ADDRESSES が未設定です。');

  // 署名は要求の改ざん・再送を防ぐだけで、通信路の暗号化や応答の保護にはならない。既定は同じホストのループバックだけ。
  const ack = env.DTM_NON_LOOPBACK_TRANSPORT_ACK;
  let transport: TransportMode;
  if (LOOPBACK.has(normalizedHost)) {
    if (ack !== undefined) throw new IntegrationConfigError('DTM_NON_LOOPBACK_TRANSPORT_ACK はループバック以外で待ち受ける場合だけ指定してください。');
    if ([...trusted].some((a) => !LOOPBACK.has(a))) {
      throw new IntegrationConfigError('ループバックで待ち受ける場合、DTM_TRUSTED_CLIENT_ADDRESSES は 127.0.0.1 / ::1 だけにしてください（ゲートウェイと連携 Bot は同じホストに置く）。');
    }
    transport = 'loopback';
  } else {
    if (ack !== NON_LOOPBACK_TRANSPORT_ACK) {
      throw new IntegrationConfigError('ループバック以外で待ち受けるには、運用者の TLS 終端を経由することを確認した DTM_NON_LOOPBACK_TRANSPORT_ACK が必要です（値は文書を参照）。');
    }
    if (!isPrivate(normalizedHost)) throw new IntegrationConfigError('ループバック以外の HOST は私設ネットワークのアドレス（10/8、172.16/12、192.168/16、fc00::/7）だけを指定できます。');
    if ([...trusted].some((a) => !isPrivate(a))) {
      throw new IntegrationConfigError('ループバック以外で待ち受ける場合、DTM_TRUSTED_CLIENT_ADDRESSES には私設ネットワーク上の TLS 終端のアドレスだけを指定してください。');
    }
    transport = 'operator-tls-termination';
  }

  const keys = new Map<ClientId, Buffer>();
  keys.set('web-gateway', readKey(env.DTM_GATEWAY_KEY_FILE, 'DTM_GATEWAY_KEY_FILE'));
  let discord: DiscordBindings | null = null;
  const bridgeKey = env.DTM_DISCORD_BRIDGE_KEY_FILE;
  const bindingsFile = env.DTM_DISCORD_BINDINGS_FILE;
  if ((bridgeKey === undefined) !== (bindingsFile === undefined)) {
    throw new IntegrationConfigError('DTM_DISCORD_BRIDGE_KEY_FILE と DTM_DISCORD_BINDINGS_FILE は両方指定するか、両方省略してください。');
  }
  if (bridgeKey !== undefined && bindingsFile !== undefined) {
    const key = readKey(bridgeKey, 'DTM_DISCORD_BRIDGE_KEY_FILE');
    if (key.equals(keys.get('web-gateway')!)) throw new IntegrationConfigError('Discord 連携とゲートウェイには別々の鍵を使ってください。');
    keys.set('discord-bridge', key);
    let text: string;
    try {
      text = readFileSync(bindingsFile, 'utf8');
    } catch {
      throw new IntegrationConfigError('Discord 対応表（DTM_DISCORD_BINDINGS_FILE）を読み込めません。');
    }
    discord = parseDiscordBindings(text);
  }
  return { host, port, dataFile: path.resolve(env.DTM_DATA_FILE), transport, trustedClients: trusted, keys, discord };
}
