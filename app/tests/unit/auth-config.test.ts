import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertMappedUsers,
  ConfigError,
  normalizeAddress,
  parseAuthMode,
  parsePublicOrigin,
  parseTrustedProxies,
  parseUserMap,
} from '../../src/server/auth.js';
import { loadConfig, parseRentalConfig } from '../../src/server/config.js';
import { SAMPLE_USERS } from '../../src/server/connector/fixtures.js';

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'auth-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mapText = (identities: unknown) => JSON.stringify({ version: 1, identities });
const VALID_MAP = mapText([
  { identity: 'editor-a@idp.example', userId: 'u-editor-a' },
  { identity: 'admin@idp.example', userId: 'u-admin' },
]);

function writeMap(name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

const proxyEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  SMM_AUTH_MODE: 'trusted-proxy',
  SMM_PUBLIC_ORIGIN: 'https://mail.example.invalid',
  SMM_TRUSTED_PROXY_ADDRESSES: '10.0.0.2',
  SMM_USER_MAP_FILE: writeMap('valid.json', VALID_MAP),
  SMM_DATA_FILE: join(dir, 'never-written.json'),
  ...overrides,
});

describe('auth mode selection', () => {
  it('defaults to demo and accepts only the two exact mode names', () => {
    expect(parseAuthMode({})).toBe('demo');
    expect(parseAuthMode({ SMM_AUTH_MODE: 'demo' })).toBe('demo');
    expect(parseAuthMode({ SMM_AUTH_MODE: 'trusted-proxy' })).toBe('trusted-proxy');
    for (const mode of ['', 'Demo', 'proxy', ' trusted-proxy', 'trusted-proxy,demo', 'none', 'oauth']) {
      expect(() => parseAuthMode({ SMM_AUTH_MODE: mode }), mode).toThrow(ConfigError);
    }
  });

  it('refuses proxy settings next to demo mode instead of exposing personas publicly', () => {
    for (const name of ['SMM_PUBLIC_ORIGIN', 'SMM_TRUSTED_PROXY_ADDRESSES', 'SMM_USER_MAP_FILE']) {
      expect(() => parseAuthMode({ [name]: 'x' }), name).toThrow(ConfigError);
      expect(() => loadConfig({ SMM_AUTH_MODE: 'demo', [name]: 'x' }), name).toThrow(ConfigError);
    }
  });

  it('keeps demo mode loopback-only', () => {
    expect(loadConfig({}).auth).toEqual({ mode: 'demo' });
    for (const host of ['::1', 'localhost', '127.0.0.1']) expect(loadConfig({ SMM_HOST: host }).host).toBe(host);
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'mail.example.invalid']) {
      expect(() => loadConfig({ SMM_HOST: host }), host).toThrow(/loopback/);
    }
  });
});

describe('public origin', () => {
  it('accepts a canonical https origin with a DNS host name', () => {
    expect(parsePublicOrigin('https://mail.example.invalid')).toEqual({ origin: 'https://mail.example.invalid', host: 'mail.example.invalid' });
    expect(parsePublicOrigin('https://mail.example.invalid:8443')).toEqual({ origin: 'https://mail.example.invalid:8443', host: 'mail.example.invalid:8443' });
  });

  it('rejects missing, insecure or non-canonical origins', () => {
    const bad = [
      undefined,
      '',
      'mail.example.invalid',
      'http://mail.example.invalid',
      'https://mail.example.invalid/',
      'https://mail.example.invalid/app',
      'https://mail.example.invalid?x=1',
      'https://mail.example.invalid#x',
      'https://user:pass@mail.example.invalid',
      'https://user@mail.example.invalid',
      'https://Mail.Example.Invalid',
      'https://mail.example.invalid:443',
      'https://localhost',
      'https://10.0.0.5',
      'https://[::1]',
      'https://*.example.invalid',
      'https://-bad.example.invalid',
      'wss://mail.example.invalid',
    ];
    for (const value of bad) expect(() => parsePublicOrigin(value), String(value)).toThrow(ConfigError);
  });
});

describe('trusted proxy allowlist', () => {
  it('accepts exact addresses and normalizes IPv6 / IPv4-mapped spellings', () => {
    expect([...parseTrustedProxies('10.0.0.2, 172.18.0.7')]).toEqual(['10.0.0.2', '172.18.0.7']);
    expect([...parseTrustedProxies('fd00:0:0:0::2')]).toEqual(['fd00::2']);
    expect(normalizeAddress('::ffff:10.0.0.2')).toBe('10.0.0.2');
    expect(normalizeAddress('FD00::2')).toBe('fd00::2');
    expect(normalizeAddress('proxy.example')).toBeNull();
  });

  it('rejects wildcard, unspecified, range, host name, empty and duplicate entries', () => {
    for (const value of [undefined, '', ' ', '*', '0.0.0.0', '::', '0:0::0', '10.0.0.0/8', 'proxy.example', '10.0.0.2,', '10.0.0.2,,10.0.0.3', '10.0.0.2,::ffff:10.0.0.2', '10.0.0.256']) {
      expect(() => parseTrustedProxies(value), String(value)).toThrow(ConfigError);
    }
  });
});

describe('identity map', () => {
  it('parses a valid map', () => {
    expect([...parseUserMap(VALID_MAP)]).toEqual([
      ['editor-a@idp.example', 'u-editor-a'],
      ['admin@idp.example', 'u-admin'],
    ]);
  });

  it('rejects malformed, ambiguous or attribution-breaking maps', () => {
    const one = { identity: 'editor-a@idp.example', userId: 'u-editor-a' };
    const bad: [string, string][] = [
      ['not json', '{'],
      ['array root', '[]'],
      ['wrong version', JSON.stringify({ version: 2, identities: [one] })],
      ['unknown root key', JSON.stringify({ version: 1, identities: [one], fallback: 'u-admin' })],
      ['empty', mapText([])],
      ['not an array', JSON.stringify({ version: 1, identities: { a: 'u-editor-a' } })],
      ['entry not object', mapText(['editor-a'])],
      ['unknown entry key', mapText([{ ...one, role: 'admin' }])],
      ['blank identity', mapText([{ identity: '', userId: 'u-editor-a' }])],
      ['identity with space', mapText([{ identity: 'editor a', userId: 'u-editor-a' }])],
      ['combined identity', mapText([{ identity: 'a@idp.example,b@idp.example', userId: 'u-editor-a' }])],
      ['wildcard identity', mapText([{ identity: '*', userId: 'u-editor-a' }])],
      ['bad user id', mapText([{ identity: 'x@idp.example', userId: 'U Admin' }])],
      ['duplicate identity', mapText([one, { identity: 'editor-a@idp.example', userId: 'u-viewer-b' }])],
      ['case-folded duplicate identity', mapText([one, { identity: 'EDITOR-A@idp.example', userId: 'u-viewer-b' }])],
      ['shared user', mapText([one, { identity: 'second@idp.example', userId: 'u-editor-a' }])],
    ];
    for (const [label, text] of bad) {
      let error: unknown;
      try {
        parseUserMap(text);
      } catch (err) {
        error = err;
      }
      expect(error, label).toBeInstanceOf(ConfigError);
      // Diagnostics name the entry position, never the identity values.
      expect((error as Error).message, label).not.toMatch(/idp\.example|EDITOR/);
    }
  });

  it('requires every mapped user to exist and be active', () => {
    expect(() => assertMappedUsers(parseUserMap(VALID_MAP), SAMPLE_USERS)).not.toThrow();
    const unknown = parseUserMap(mapText([{ identity: 'ghost@idp.example', userId: 'u-ghost' }]));
    expect(() => assertMappedUsers(unknown, SAMPLE_USERS)).toThrow(/存在しません/);
    const inactive = SAMPLE_USERS.map((u) => (u.id === 'u-editor-a' ? { ...u, disabled: true } : u));
    expect(() => assertMappedUsers(parseUserMap(VALID_MAP), inactive)).toThrow(/無効化/);
  });
});

describe('trusted-proxy configuration loading', () => {
  it('loads a complete configuration and permits a container-private bind address', () => {
    const config = loadConfig(proxyEnv({ SMM_HOST: '0.0.0.0', SMM_PORT: '8080' }));
    expect(config).toMatchObject({ host: '0.0.0.0', port: 8080 });
    expect(config.auth).toMatchObject({ mode: 'trusted-proxy', publicOrigin: 'https://mail.example.invalid', publicHost: 'mail.example.invalid' });
    if (config.auth.mode !== 'trusted-proxy') throw new Error('unreachable');
    expect([...config.auth.trustedProxies]).toEqual(['10.0.0.2']);
    expect(config.auth.identities.get('admin@idp.example')).toBe('u-admin');
  });

  it('refuses incomplete or invalid configuration without echoing secrets or paths', () => {
    const secretPath = join(dir, 'private-location', 'map.json');
    const cases: [string, NodeJS.ProcessEnv][] = [
      ['missing origin', proxyEnv({ SMM_PUBLIC_ORIGIN: undefined })],
      ['insecure origin', proxyEnv({ SMM_PUBLIC_ORIGIN: 'http://mail.example.invalid' })],
      ['origin with credentials', proxyEnv({ SMM_PUBLIC_ORIGIN: 'https://user:hunter2@mail.example.invalid' })],
      ['missing proxies', proxyEnv({ SMM_TRUSTED_PROXY_ADDRESSES: undefined })],
      ['wildcard proxy', proxyEnv({ SMM_TRUSTED_PROXY_ADDRESSES: '0.0.0.0' })],
      ['missing map', proxyEnv({ SMM_USER_MAP_FILE: undefined })],
      ['unreadable map', proxyEnv({ SMM_USER_MAP_FILE: secretPath })],
      ['invalid map', proxyEnv({ SMM_USER_MAP_FILE: writeMap('broken.json', '{"version":1,') })],
      ['host name bind', proxyEnv({ SMM_HOST: 'mail.example.invalid' })],
      ['bad port', proxyEnv({ SMM_PORT: '70000' })],
    ];
    for (const [label, env] of cases) {
      let error: unknown;
      try {
        loadConfig(env);
      } catch (err) {
        error = err;
      }
      expect(error, label).toBeInstanceOf(ConfigError);
      expect((error as Error).message, label).not.toMatch(/hunter2|private-location|idp\.example/);
    }
  });
});


describe('explicit rental-wide member administration', () => {
  it('defaults off and accepts only exact boolean settings', () => {
    const base = { SMM_RENTAL_DATA_DIR: 'rental-test' };
    expect(parseRentalConfig(base, 'demo')).toMatchObject({ allMembersAdmin: false });
    expect(parseRentalConfig({ ...base, SMM_RENTAL_ALL_MEMBERS_ADMIN: 'false' }, 'demo')).toMatchObject({ allMembersAdmin: false });
    expect(parseRentalConfig({ ...base, SMM_RENTAL_ALL_MEMBERS_ADMIN: 'true' }, 'demo')).toMatchObject({ allMembersAdmin: true });
    for (const value of ['', '1', 'TRUE', ' true']) expect(() => parseRentalConfig({ ...base, SMM_RENTAL_ALL_MEMBERS_ADMIN: value }, 'demo')).toThrow(ConfigError);
    expect(() => parseRentalConfig({ SMM_RENTAL_ALL_MEMBERS_ADMIN: 'true' }, 'demo')).toThrow(ConfigError);
  });
});
