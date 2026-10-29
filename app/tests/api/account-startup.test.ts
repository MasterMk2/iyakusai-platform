import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/server/auth.js';
import { loadConfig } from '../../src/server/config.js';
import { parseTaskBridge } from '../../src/server/tasks/bridge.js';

// Account (production) and account-mock configuration must fail closed: any missing provider,
// secret, store or Task gateway setting refuses startup without creating or touching data, and
// never falls back to the demo. Secrets and paths never appear in the output.

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'account-startup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const key = (name: string) => {
  const file = join(dir, name);
  writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return file;
};
const pepperFile = key('pepper.key');
const bridgeKeyFile = key('bridge.key');
const taskKeyFile = key('task.key');
const bridgeMap = join(dir, 'task-bridge.json');
writeFileSync(bridgeMap, JSON.stringify({ version: 1, bindings: [{ principalId: 'u-editor-a', taskUserId: 'user-member-a1' }] }));

const production = (): Record<string, string> => ({
  SMM_AUTH_MODE: 'account',
  SMM_HOST: '127.0.0.1',
  SMM_PUBLIC_ORIGIN: 'https://mail.example.invalid',
  SMM_TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
  SMM_AUTH_PEPPER_FILE: pepperFile,
  SMM_AUTH_STORE_FILE: join(dir, 'login-store.json'),
  SMM_AUTH_AUDIT_FILE: join(dir, 'auth-audit.jsonl'),
  SMM_IDENTITY_BRIDGE_URL: 'https://identity-bridge.example.invalid',
  SMM_IDENTITY_BRIDGE_KEY_FILE: bridgeKeyFile,
  SMM_AUTH_GROUP_ID: 'group-placeholder',
  SMM_AUTH_LINK_EVIDENCE: 'verified_roster',
  SMM_TASK_SERVICE_URL: 'http://127.0.0.1:17699',
  SMM_TASK_GATEWAY_KEY_FILE: taskKeyFile,
  SMM_TASK_BRIDGE_FILE: bridgeMap,
  SMM_DATA_FILE: join(dir, 'mail-state.json'),
});

describe('account configuration', () => {
  it('accepts a complete production configuration and the loopback mock', () => {
    const config = loadConfig(production());
    expect(config.auth).toMatchObject({ mode: 'account', composition: 'production', publicOrigin: 'https://mail.example.invalid' });
    expect(config.account).toMatchObject({ composition: 'production', groupId: 'group-placeholder' });
    expect(config.tasks.mode).toBe('on');
    expect(config.allowSampleSeed).toBe(false);
    expect(loadConfig({ SMM_AUTH_MODE: 'account-mock' }).auth).toMatchObject({ mode: 'account', composition: 'mock' });
  });

  it.each([
    'SMM_AUTH_PEPPER_FILE',
    'SMM_AUTH_STORE_FILE',
    'SMM_AUTH_AUDIT_FILE',
    'SMM_IDENTITY_BRIDGE_URL',
    'SMM_IDENTITY_BRIDGE_KEY_FILE',
    'SMM_AUTH_GROUP_ID',
    'SMM_AUTH_LINK_EVIDENCE',
    'SMM_TASK_SERVICE_URL',
    'SMM_TASK_GATEWAY_KEY_FILE',
    'SMM_TASK_BRIDGE_FILE',
    'SMM_PUBLIC_ORIGIN',
    'SMM_TRUSTED_PROXY_ADDRESSES',
  ])('refuses production without %s', (name) => {
    const env = production();
    delete env[name];
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it.each([
    ['http public origin', { SMM_PUBLIC_ORIGIN: 'http://mail.example.invalid' }],
    ['wildcard proxy', { SMM_TRUSTED_PROXY_ADDRESSES: '0.0.0.0' }],
    ['plain-http bridge by host name', { SMM_IDENTITY_BRIDGE_URL: 'http://identity-bridge.example.invalid' }],
    ['plain-http bridge on a private IP', { SMM_IDENTITY_BRIDGE_URL: 'http://10.0.0.5:8443' }],
    ['plain-http bridge on another loopback address', { SMM_IDENTITY_BRIDGE_URL: 'http://127.0.0.2:8443' }],
    ['plain-http bridge via localhost name', { SMM_IDENTITY_BRIDGE_URL: 'http://localhost:8443' }],
    ['plain-http Task service on a private IP', { SMM_TASK_SERVICE_URL: 'http://192.168.10.4:17631' }],
    ['plain-http Task service on IPv6 private', { SMM_TASK_SERVICE_URL: 'http://[fd00::4]:17631' }],
    ['non-http bridge scheme', { SMM_IDENTITY_BRIDGE_URL: 'ftp://identity-bridge.example.invalid' }],
    ['bridge URL with a path', { SMM_IDENTITY_BRIDGE_URL: 'https://identity-bridge.example.invalid/api' }],
    ['unknown link evidence', { SMM_AUTH_LINK_EVIDENCE: 'email_domain' }],
    ['pepper reused as bridge key', { SMM_IDENTITY_BRIDGE_KEY_FILE: pepperFile }],
    ['proxy identity map', { SMM_USER_MAP_FILE: bridgeMap }],
    ['unknown sample seed value', { SMM_ALLOW_SAMPLE_SEED: 'yes' }],
  ])('refuses production with %s', (_name, override) => {
    expect(() => loadConfig({ ...production(), ...override })).toThrow(ConfigError);
  });

  it('accepts only https or the exact same-host loopback for the identity bridge and Task service', () => {
    for (const [bridge, task] of [
      ['https://identity-bridge.example.invalid', 'https://tasks.example.invalid'],
      ['http://127.0.0.1:8443', 'http://127.0.0.1:17631'],
      ['http://[::1]:8443', 'http://[::1]:17631'],
    ]) {
      const config = loadConfig({ ...production(), SMM_IDENTITY_BRIDGE_URL: bridge!, SMM_TASK_SERVICE_URL: task! });
      expect(config.account).toMatchObject({ bridgeUrl: bridge });
      expect(config.tasks).toMatchObject({ mode: 'on', serviceUrl: task });
    }
    // The trusted-proxy composition uses the same rule for its Task gateway.
    const userMap = join(dir, 'user-map.json');
    writeFileSync(userMap, JSON.stringify({ version: 1, identities: [{ identity: 'editor-a', userId: 'u-editor-a' }] }));
    const proxy = { SMM_AUTH_MODE: 'trusted-proxy', SMM_HOST: '127.0.0.1', SMM_PUBLIC_ORIGIN: 'https://mail.example.invalid', SMM_TRUSTED_PROXY_ADDRESSES: '127.0.0.1', SMM_USER_MAP_FILE: userMap, SMM_TASK_GATEWAY_KEY_FILE: taskKeyFile, SMM_TASK_BRIDGE_FILE: bridgeMap };
    expect(() => loadConfig({ ...proxy, SMM_TASK_SERVICE_URL: 'http://10.0.0.7:17631' })).toThrow(/https/);
    expect(loadConfig({ ...proxy, SMM_TASK_SERVICE_URL: 'http://127.0.0.1:17631' }).tasks.mode).toBe('on');
  });

  it('keeps account settings out of the demo and the mock on loopback', () => {
    expect(() => loadConfig({ SMM_AUTH_PEPPER_FILE: pepperFile })).toThrow(ConfigError);
    expect(() => loadConfig({ SMM_AUTH_MODE: 'account-mock', SMM_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ SMM_AUTH_MODE: 'account-mock', SMM_IDENTITY_BRIDGE_URL: 'https://x.example.invalid' })).toThrow(ConfigError);
    // Demo/mock Task gateway: loopback http only, key required.
    expect(() => loadConfig({ SMM_TASK_SERVICE_URL: 'https://tasks.example.invalid', SMM_TASK_GATEWAY_KEY_FILE: taskKeyFile })).toThrow(ConfigError);
    expect(() => loadConfig({ SMM_TASK_SERVICE_URL: 'http://127.0.0.1:17699' })).toThrow(ConfigError);
    expect(() => loadConfig({ SMM_TASK_GATEWAY_KEY_FILE: taskKeyFile })).toThrow(ConfigError);
    expect(loadConfig({ SMM_TASK_SERVICE_URL: 'http://127.0.0.1:17699', SMM_TASK_GATEWAY_KEY_FILE: taskKeyFile }).tasks.mode).toBe('on');
  });

  it('validates the task identity bridge map strictly', () => {
    expect(parseTaskBridge(JSON.stringify({ version: 1, bindings: [{ principalId: 'u-a', taskUserId: 'user-a' }] })).taskUserFor('u-a')).toBe('user-a');
    for (const bad of [
      { version: 2, bindings: [] },
      { version: 1, bindings: [{ principalId: 'u-a', taskUserId: 'user-a', role: 'admin' }] },
      { version: 1, bindings: [{ principalId: 'u-a', taskUserId: 'user-a' }, { principalId: 'u-a', taskUserId: 'user-b' }] },
      { version: 1, bindings: [{ principalId: 'u-a', taskUserId: 'user-a' }, { principalId: 'u-b', taskUserId: 'user-a' }] },
      { version: 1, bindings: [{ principalId: 'U A', taskUserId: 'user-a' }] },
    ]) {
      expect(() => parseTaskBridge(JSON.stringify(bad))).toThrow(ConfigError);
    }
  });
});

function start(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { env: { ...clean, SMM_PORT: '5198', ...env }, encoding: 'utf8', timeout: 30_000 });
}

describe('account startup', () => {
  it('refuses a missing mail data file instead of seeding sample users', () => {
    const env = production();
    const result = start(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('データファイルがありません');
    expect(existsSync(env.SMM_DATA_FILE!)).toBe(false);
    expect(existsSync(env.SMM_AUTH_STORE_FILE!)).toBe(false);
    expect(result.stderr + result.stdout).not.toContain(dir);
  }, 40_000);

  it('refuses a corrupt or foreign login store without changing it', () => {
    const env = production();
    const store = join(dir, 'corrupt-store.json');
    writeFileSync(store, JSON.stringify({ kind: 'smm-login-store', version: 1, data: '{}', mac: '0'.repeat(64) }));
    const result = start({ ...env, SMM_AUTH_STORE_FILE: store, SMM_ALLOW_SAMPLE_SEED: 'synthetic-trial' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ログイン状態を読み込めない');
    expect(result.stderr + result.stdout).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(existsSync(env.SMM_DATA_FILE!)).toBe(false);
  }, 40_000);

  it('refuses a configuration error with a secret-free message', () => {
    const env = production();
    delete env.SMM_IDENTITY_BRIDGE_KEY_FILE;
    const result = start(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMM_IDENTITY_BRIDGE_KEY_FILE');
    expect(result.stderr).not.toContain(dir);
  }, 40_000);

  it('starts the labelled loopback mock composition', async () => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      env: { ...clean, SMM_PORT: '5198', SMM_AUTH_MODE: 'account-mock', SMM_DATA_FILE: join(dir, 'mock-state.json') },
    });
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(output)), 30_000);
        const onData = (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.includes('http://127.0.0.1:5198/')) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('exit', () => reject(new Error(output)));
      });
      expect(output).toContain('模擬');
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }, 40_000);
});
