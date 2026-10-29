import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_GROUP_ID, MOCK_ORGANIZATION_ID, MockAccountProviders } from '../../src/server/account/mock-providers.js';
import { loadConfig } from '../../src/server/config.js';
import { FileLoginPersistence, LOW_COST_TEST_ONLY, PasswordHasher, SCRYPT_PRODUCTION } from '../../src/server/login/index.js';
import { composeServer, type ServerRuntime } from '../../src/server/runtime.js';
import { Browser, EMAIL, PROD_HOST, PROD_ORIGIN, startFakeBridge } from '../account-harness.js';

// The REAL production composition (loadConfig -> composeServer, as main.ts does) with a TEST-ONLY
// signed identity bridge on loopback: the password KDF is the production profile, a real
// N=2^17 hash/check works end to end over HTTP, and a stored hash of a cheaper profile is refused
// after a restart. No mock endpoints, no real providers, synthetic people only.

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'production-kdf-'));
const PASSWORD = 'synthetic production passphrase 8';
const providers = new MockAccountProviders();
let bridge: Awaited<ReturnType<typeof startFakeBridge>>;
let env: Record<string, string>;
const pepper = randomBytes(32);

const keyFile = (name: string, key: Buffer) => {
  const file = join(dir, name);
  writeFileSync(file, key.toString('base64url'), { mode: 0o600 });
  return file;
};

beforeAll(async () => {
  bridge = await startFakeBridge(providers);
  const taskBridge = join(dir, 'task-bridge.json');
  writeFileSync(taskBridge, JSON.stringify({ version: 1, bindings: [{ principalId: 'u-editor-a', taskUserId: 'user-member-a1' }] }));
  env = {
    SMM_AUTH_MODE: 'account',
    SMM_HOST: '127.0.0.1',
    SMM_PORT: '5199',
    SMM_PUBLIC_ORIGIN: PROD_ORIGIN,
    SMM_TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
    SMM_AUTH_PEPPER_FILE: keyFile('pepper.key', pepper),
    SMM_AUTH_STORE_FILE: join(dir, 'login-store.json'),
    SMM_AUTH_AUDIT_FILE: join(dir, 'auth-audit.jsonl'),
    SMM_IDENTITY_BRIDGE_URL: bridge.url,
    SMM_IDENTITY_BRIDGE_KEY_FILE: keyFile('bridge.key', bridge.key),
    SMM_AUTH_GROUP_ID: MOCK_GROUP_ID,
    SMM_AUTH_ORGANIZATION_ID: MOCK_ORGANIZATION_ID,
    SMM_AUTH_LINK_EVIDENCE: 'verified_roster',
    SMM_TASK_SERVICE_URL: 'http://127.0.0.1:9',
    SMM_TASK_GATEWAY_KEY_FILE: keyFile('task.key', randomBytes(32)),
    SMM_TASK_BRIDGE_FILE: taskBridge,
    SMM_DATA_FILE: join(dir, 'mail-state.json'),
    SMM_ALLOW_SAMPLE_SEED: 'synthetic-trial',
  };
});
afterAll(async () => {
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });
});

const browserFor = (rt: ServerRuntime) => new Browser(rt.app, { host: PROD_HOST, origin: PROD_ORIGIN, remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.20' });

describe('production composition password KDF', () => {
  it('hashes and checks with scrypt N=2^17/r=8/p=1 and refuses a cheaper stored hash after restart', async () => {
    const config = loadConfig(env);
    const first = await composeServer(config);
    expect(first.account?.composition).toBe('production');
    expect(first.account?.service.passwords.params).toEqual(SCRYPT_PRODUCTION);

    // First use over HTTP: DM code through the signed bridge -> own password (production-cost hash).
    const browser = browserFor(first);
    const req = await browser.call('POST', '/api/auth/setup/request', { email: EMAIL['u-editor-a'] });
    expect(req.status).toBe(202);
    await first.account!.service.idle();
    const editor = providers.directory().find((p) => p.principalId === 'u-editor-a')!;
    const code = bridge.dms.filter((d) => d.recipient.discordUserId === editor.discordUserId).at(-1)!.code;
    expect((await browser.call('POST', '/api/auth/setup/verify', { challengeId: req.json.challengeId, code })).status).toBe(200);
    expect((await browser.call('POST', '/api/auth/setup/password', { password: PASSWORD, confirmation: PASSWORD })).status).toBe(200);
    const stored = [...first.account!.service.store.credentials.values()][0]!;
    expect(stored.hash).toMatchObject({ alg: 'scrypt', N: 2 ** 17, r: 8, p: 1 });

    // Normal login verifies against the production-cost hash.
    const login = browserFor(first);
    expect((await login.call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: PASSWORD })).status).toBe(200);
    expect((await login.call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: `${PASSWORD}x` })).status).toBe(401);
    await first.app.close();

    // Neither the password nor the code is persisted or logged.
    const storeText = readFileSync(env.SMM_AUTH_STORE_FILE!, 'utf8');
    const auditText = readFileSync(env.SMM_AUTH_AUDIT_FILE!, 'utf8');
    for (const secret of [PASSWORD, code, EMAIL['u-editor-a']!]) {
      expect(storeText).not.toContain(secret);
      expect(auditText).not.toContain(secret);
    }

    // Simulate a store holding a cheaper (test-profile) hash of the SAME password, with a valid
    // integrity tag, and restart the production composition from it.
    const persistence = new FileLoginPersistence(env.SMM_AUTH_STORE_FILE!, pepper);
    const snapshot = persistence.load() as { credentials: { hash: unknown }[] };
    snapshot.credentials[0]!.hash = await new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY }).hash(PASSWORD);
    persistence.save(snapshot);

    const second = await composeServer(loadConfig(env));
    expect(second.account?.service.passwords.params).toEqual(SCRYPT_PRODUCTION);
    const again = await browserFor(second).call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: PASSWORD });
    expect(again.status).toBe(401);
    expect(again.json.error).toBe('login_failed');
    await second.app.close();
    const reasons = readFileSync(env.SMM_AUTH_AUDIT_FILE!, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { reason?: string }).reason);
    expect(reasons).toContain('credential_profile_rejected');
  }, 60_000);
});
