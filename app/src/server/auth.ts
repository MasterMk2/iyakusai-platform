import { isIP } from 'node:net';
import type { User } from './domain/types.js';

// Authentication modes. "demo" is the original loopback-only persona switch.
// "trusted-proxy" accepts exactly one identity header, and only from an
// explicitly allowlisted reverse-proxy socket address. Every validation error
// here refuses startup; messages never echo identities, map contents or paths.

/** The single identity header a trusted proxy must overwrite. Not configurable. */
export const IDENTITY_HEADER = 'x-mail-user';

const IDENTITY_PATTERN = /^[A-Za-z0-9._@+-]{1,128}$/;
const USER_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export class ConfigError extends Error {}

export interface DemoAuth {
  mode: 'demo';
}

export interface TrustedProxyAuth {
  mode: 'trusted-proxy';
  /** Canonical https origin, e.g. https://mail.example.invalid */
  publicOrigin: string;
  /** Host header value the proxy must forward (URL.host of the origin). */
  publicHost: string;
  /** Normalized exact socket addresses of the trusted proxies. */
  trustedProxies: ReadonlySet<string>;
  /** Verified proxy identity -> application user ID. */
  identities: ReadonlyMap<string, string>;
}

/**
 * Account login (own password after a verified DM code). `production` needs every operator
 * provider and secret; `mock` is the labelled loopback composition with synthetic providers.
 */
export interface AccountAuth {
  mode: 'account';
  composition: 'production' | 'mock';
  /** Production only: canonical https origin and its host. */
  publicOrigin: string | null;
  publicHost: string | null;
  /** Production only: exact socket addresses of the TLS-terminating reverse proxies. */
  trustedProxies: ReadonlySet<string>;
}

/** Discord account login (the unified app's production login). Settings beyond transport: SMM_DISCORD_AUTH_CONFIG. */
export interface DiscordAuth {
  mode: 'discord';
  publicOrigin: string;
  publicHost: string;
  trustedProxies: ReadonlySet<string>;
}

export type AuthConfig = DemoAuth | TrustedProxyAuth | AccountAuth | DiscordAuth;

export type AuthModeName = 'demo' | 'trusted-proxy' | 'account' | 'account-mock' | 'discord';

const PROXY_ONLY_VARS = ['SMM_PUBLIC_ORIGIN', 'SMM_TRUSTED_PROXY_ADDRESSES', 'SMM_USER_MAP_FILE'] as const;

export function parseAuthMode(env: NodeJS.ProcessEnv): AuthModeName {
  const raw = env.SMM_AUTH_MODE;
  if (raw === undefined || raw === 'demo') {
    // A public origin or proxy setting next to demo mode is ambiguous: refuse rather than expose personas.
    const stray = PROXY_ONLY_VARS.filter((name) => env[name] !== undefined);
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} は SMM_AUTH_MODE=trusted-proxy でのみ指定できます。`);
    return 'demo';
  }
  if (raw === 'trusted-proxy' || raw === 'account' || raw === 'account-mock' || raw === 'discord') return raw;
  throw new ConfigError('SMM_AUTH_MODE は "demo"・"trusted-proxy"・"account"・"account-mock"・"discord" のいずれかを正確に指定してください。');
}

/** Requires an exact canonical https origin with a DNS host name: no credentials, path, query or fragment. */
export function parsePublicOrigin(value: string | undefined): { origin: string; host: string } {
  if (!value) throw new ConfigError('SMM_PUBLIC_ORIGIN が未設定です。');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('SMM_PUBLIC_ORIGIN は URL として解釈できません。');
  }
  if (url.protocol !== 'https:') throw new ConfigError('SMM_PUBLIC_ORIGIN は https のオリジンでなければなりません。');
  if (url.username || url.password) throw new ConfigError('SMM_PUBLIC_ORIGIN に認証情報を含めることはできません。');
  if (value !== url.origin) {
    throw new ConfigError('SMM_PUBLIC_ORIGIN は末尾スラッシュ・パス・クエリ・フラグメントのない正規形（小文字）のオリジンで指定してください。');
  }
  const labels = url.hostname.split('.');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 || labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) {
    throw new ConfigError('SMM_PUBLIC_ORIGIN のホストは完全修飾ドメイン名でなければなりません（IP アドレスは不可）。');
  }
  return { origin: url.origin, host: url.host };
}

/** Normalizes a socket or configured address so that IPv4-mapped IPv6 and IPv6 spellings compare equal. */
export function normalizeAddress(address: string | undefined): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const candidate = mapped ? mapped[1]! : address;
  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family === 6) return new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  return null;
}

export function parseTrustedProxies(value: string | undefined): Set<string> {
  if (!value || !value.trim()) throw new ConfigError('SMM_TRUSTED_PROXY_ADDRESSES が未設定です。');
  const result = new Set<string>();
  for (const [index, entry] of value.split(',').map((s) => s.trim()).entries()) {
    const normalized = normalizeAddress(entry);
    if (!normalized) throw new ConfigError(`SMM_TRUSTED_PROXY_ADDRESSES の ${index + 1} 番目は単一の IP アドレスではありません（範囲・ワイルドカード・ホスト名は不可）。`);
    if (normalized === '0.0.0.0' || normalized === '::') throw new ConfigError(`SMM_TRUSTED_PROXY_ADDRESSES の ${index + 1} 番目は未指定アドレスです。`);
    if (result.has(normalized)) throw new ConfigError(`SMM_TRUSTED_PROXY_ADDRESSES の ${index + 1} 番目が重複しています。`);
    result.add(normalized);
  }
  return result;
}

export function isValidIdentity(value: string): boolean {
  return IDENTITY_PATTERN.test(value);
}

/**
 * Parses the operator-local identity map:
 * { "version": 1, "identities": [ { "identity": "...", "userId": "..." } ] }
 * Identities must be unique (also case-insensitively) and every user ID may be mapped once,
 * so each action stays attributable to exactly one proxy identity.
 */
export function parseUserMap(text: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError('利用者対応表（SMM_USER_MAP_FILE）が JSON として解釈できません。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError('利用者対応表はオブジェクトでなければなりません。');
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).some((k) => k !== 'version' && k !== 'identities')) throw new ConfigError('利用者対応表に未知の項目があります。');
  if (root.version !== 1) throw new ConfigError('利用者対応表の version は 1 でなければなりません。');
  if (!Array.isArray(root.identities) || root.identities.length === 0) throw new ConfigError('利用者対応表の identities が空か配列ではありません。');

  const map = new Map<string, string>();
  const folded = new Set<string>();
  const users = new Set<string>();
  root.identities.forEach((entry: unknown, index) => {
    const at = `利用者対応表の ${index + 1} 番目`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ConfigError(`${at}はオブジェクトでなければなりません。`);
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).some((k) => k !== 'identity' && k !== 'userId')) throw new ConfigError(`${at}に未知の項目があります。`);
    if (typeof e.identity !== 'string' || !isValidIdentity(e.identity)) throw new ConfigError(`${at}の identity が不正です（英数字と . _ @ + - の 1〜128 文字）。`);
    if (typeof e.userId !== 'string' || !USER_ID_PATTERN.test(e.userId)) throw new ConfigError(`${at}の userId が不正です。`);
    if (folded.has(e.identity.toLowerCase())) throw new ConfigError(`${at}の identity が重複しています（大文字小文字の違いも重複とみなします）。`);
    if (users.has(e.userId)) throw new ConfigError(`${at}の userId は別の identity に割り当て済みです（1 利用者に 1 identity）。`);
    folded.add(e.identity.toLowerCase());
    users.add(e.userId);
    map.set(e.identity, e.userId);
  });
  return map;
}

/** Every mapped user must exist and be active in the application state. */
export function assertMappedUsers(identities: ReadonlyMap<string, string>, users: readonly User[]): void {
  let index = 0;
  for (const userId of identities.values()) {
    index += 1;
    const user = users.find((u) => u.id === userId);
    if (!user) throw new ConfigError(`利用者対応表の ${index} 番目の userId はアプリの利用者に存在しません。`);
    if (user.disabled) throw new ConfigError(`利用者対応表の ${index} 番目の userId は無効化された利用者です。`);
  }
}
