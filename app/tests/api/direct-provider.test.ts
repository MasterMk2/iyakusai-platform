import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { directIdentityProviders } from '../../src/server/account/direct-providers.js';
import { GoogleDirectoryReader } from '../../src/server/account/google-directory.js';
import { FileIdentityRegistry } from '../../src/server/account/identity-registry.js';
import { NODE_LOCAL_FILE_OPS } from '../../src/server/account/local-file.js';
import { ConfigError } from '../../src/server/auth.js';
import { loadConfig, type AccountProviderConfig } from '../../src/server/config.js';
import {
  FileLoginPersistence,
  LOW_COST_TEST_ONLY,
  LoginService,
  PasswordHasher,
  REFERENCE_STORE_ACK,
  type LoginAuditEvent,
  type LoginCodeEnvelope,
  type LoginServiceOptions,
} from '../../src/server/login/index.js';
import { composeServer, StartupRefusal, type ServerRuntime } from '../../src/server/runtime.js';
import { Browser, PROD_HOST, PROD_ORIGIN } from '../account-harness.js';
import { binding, hostFileOps, registryDoc, ROOT_GROUP, SYN_CUSTOMER, SYN_TOKEN, SyntheticGoogleDirectory, uid } from '../directory-fake.js';

// Direct-provider composition (SMM_IDENTITY_PROVIDER=direct): explicit opt-in config without an
// identity bridge URL, the real composition wired to the in-process Directory reader (synthetic
// directory behind an injected fetch) and the authoritative registry file, the explicit
// "DM unavailable" transport, startup refusals, and revocation of live sessions. Synthetic only.
// Token and registry files are written owner-only; on a Windows host the composition is given the
// labelled synthetic POSIX view (hostFileOps), because the real reader refuses on Windows.

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'direct-provider-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const secret = (name: string, text: string) => {
  const file = join(dir, name);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
};
const pepperFile = secret('pepper.key', randomBytes(32).toString('base64url'));
const taskKeyFile = secret('task.key', randomBytes(32).toString('base64url'));
const bridgeKeyFile = secret('bridge.key', randomBytes(32).toString('base64url'));
const tokenFile = secret('directory-token', `${SYN_TOKEN}\n`);
const taskBridgeFile = join(dir, 'task-bridge.json');
writeFileSync(taskBridgeFile, JSON.stringify({ version: 1, bindings: [{ principalId: 'u-editor-a', taskUserId: 'user-member-a1' }] }));
const REGISTRY = [binding(1, 'u-editor-a', 'user-member-a1'), binding(2, 'u-viewer-b', null)];
const registryFile = secret('identity-registry.json', registryDoc(REGISTRY));
const files = { localFileOps: hostFileOps() };

let n = 0;
const direct = (): Record<string, string> => {
  n += 1;
  return {
    SMM_AUTH_MODE: 'account',
    SMM_HOST: '127.0.0.1',
    SMM_PORT: '5197',
    SMM_PUBLIC_ORIGIN: PROD_ORIGIN,
    SMM_TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
    SMM_AUTH_PEPPER_FILE: pepperFile,
    SMM_AUTH_STORE_FILE: join(dir, `login-store-${n}.json`),
    SMM_AUTH_AUDIT_FILE: join(dir, `auth-audit-${n}.jsonl`),
    SMM_IDENTITY_PROVIDER: 'direct',
    SMM_DIRECTORY_TOKEN_FILE: tokenFile,
    SMM_IDENTITY_REGISTRY_FILE: registryFile,
    SMM_AUTH_DM_TRANSPORT: 'unavailable',
    SMM_AUTH_GROUP_ID: ROOT_GROUP,
    SMM_AUTH_ORGANIZATION_ID: SYN_CUSTOMER,
    SMM_AUTH_LINK_EVIDENCE: 'verified_roster',
    SMM_TASK_SERVICE_URL: 'http://127.0.0.1:9',
    SMM_TASK_GATEWAY_KEY_FILE: taskKeyFile,
    SMM_TASK_BRIDGE_FILE: taskBridgeFile,
    SMM_DATA_FILE: join(dir, `mail-state-${n}.json`),
    SMM_ALLOW_SAMPLE_SEED: 'synthetic-trial',
  };
};

function syntheticDirectory(): SyntheticGoogleDirectory {
  const d = new SyntheticGoogleDirectory();
  d.addUser(1);
  d.addUser(2);
  d.group(ROOT_GROUP);
  d.group('grpsynthnested');
  d.member(ROOT_GROUP, { id: uid(1), type: 'USER' });
  d.member(ROOT_GROUP, { id: 'grpsynthnested', type: 'GROUP' });
  d.member('grpsynthnested', { id: uid(2), type: 'USER' });
  return d;
}

describe('direct-provider configuration', () => {
  it('is an explicit opt-in that needs no identity bridge URL', () => {
    const config = loadConfig(direct());
    expect(config.account).toMatchObject({ composition: 'production', provider: 'direct', groupId: ROOT_GROUP, organizationId: SYN_CUSTOMER, dm: { transport: 'unavailable' } });
    expect(config.account).not.toHaveProperty('bridgeUrl');
    // The signed bridge stays the default provider and keeps its own shape.
    const bridgeEnv = { ...direct(), SMM_IDENTITY_BRIDGE_URL: 'https://identity-bridge.example.invalid', SMM_IDENTITY_BRIDGE_KEY_FILE: bridgeKeyFile };
    for (const name of ['SMM_IDENTITY_PROVIDER', 'SMM_DIRECTORY_TOKEN_FILE', 'SMM_IDENTITY_REGISTRY_FILE', 'SMM_AUTH_DM_TRANSPORT'] as const) delete (bridgeEnv as Record<string, string>)[name];
    expect(loadConfig(bridgeEnv).account).toMatchObject({ provider: 'bridge', bridgeUrl: 'https://identity-bridge.example.invalid' });
    // The existing signed DM contract may be selected explicitly for delivery only.
    const viaBridge = loadConfig({ ...direct(), SMM_AUTH_DM_TRANSPORT: 'identity-bridge', SMM_IDENTITY_BRIDGE_URL: 'https://identity-bridge.example.invalid', SMM_IDENTITY_BRIDGE_KEY_FILE: bridgeKeyFile });
    expect(viaBridge.account).toMatchObject({ provider: 'direct', dm: { transport: 'identity-bridge', bridgeUrl: 'https://identity-bridge.example.invalid' } });
  });

  it.each(['SMM_DIRECTORY_TOKEN_FILE', 'SMM_IDENTITY_REGISTRY_FILE', 'SMM_AUTH_DM_TRANSPORT', 'SMM_AUTH_ORGANIZATION_ID', 'SMM_AUTH_GROUP_ID', 'SMM_AUTH_PEPPER_FILE', 'SMM_TASK_BRIDGE_FILE'])(
    'refuses the direct provider without %s',
    (name) => {
      const env = direct();
      delete env[name];
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );

  it.each([
    ['unknown provider', { SMM_IDENTITY_PROVIDER: 'google' }],
    ['group email instead of the stable id', { SMM_AUTH_GROUP_ID: 'everyone@groups.synthetic.invalid' }],
    ['organization alias instead of the customer id', { SMM_AUTH_ORGANIZATION_ID: 'my_customer' }],
    ['implicit DM transport', { SMM_AUTH_DM_TRANSPORT: 'discord' }],
    ['bridge URL with the unavailable DM transport', { SMM_IDENTITY_BRIDGE_URL: 'https://identity-bridge.example.invalid' }],
    ['identity-bridge DM without its URL', { SMM_AUTH_DM_TRANSPORT: 'identity-bridge', SMM_IDENTITY_BRIDGE_KEY_FILE: bridgeKeyFile }],
    ['plain-http DM bridge', { SMM_AUTH_DM_TRANSPORT: 'identity-bridge', SMM_IDENTITY_BRIDGE_URL: 'http://10.0.0.5:8443', SMM_IDENTITY_BRIDGE_KEY_FILE: bridgeKeyFile }],
    ['any authorization reuse window (removed setting)', { SMM_DIRECTORY_CACHE_MS: '15000' }],
    ['even a zero reuse window (removed setting)', { SMM_DIRECTORY_CACHE_MS: '0' }],
    ['same file for token and registry', { SMM_IDENTITY_REGISTRY_FILE: tokenFile }],
  ])('refuses the direct provider with %s', (_name, override) => {
    expect(() => loadConfig({ ...direct(), ...override })).toThrow(ConfigError);
  });

  it('keeps direct-provider settings out of the bridge provider and the mock', () => {
    const bridgeEnv = { ...direct(), SMM_IDENTITY_PROVIDER: 'bridge', SMM_IDENTITY_BRIDGE_URL: 'https://identity-bridge.example.invalid', SMM_IDENTITY_BRIDGE_KEY_FILE: bridgeKeyFile };
    expect(() => loadConfig(bridgeEnv)).toThrow(/SMM_IDENTITY_PROVIDER=direct/);
    expect(() => loadConfig({ SMM_AUTH_MODE: 'account-mock', SMM_IDENTITY_PROVIDER: 'direct' })).toThrow(ConfigError);
    expect(() => loadConfig({ SMM_IDENTITY_REGISTRY_FILE: registryFile })).toThrow(ConfigError);
  });
});

describe('direct-provider composition', () => {
  it('wires the registry and the Directory reader, and refuses DM delivery (no usable code)', async () => {
    const env = direct();
    const directory = syntheticDirectory();
    const rt = await composeServer(loadConfig(env), { directoryFetch: directory.fetch, ...files });
    try {
      expect(rt.account?.composition).toBe('production');
      const browser = new Browser(rt.app, { host: PROD_HOST, origin: PROD_ORIGIN, remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.30' });
      const req = await browser.call('POST', '/api/auth/setup/request', { email: 'person-1@synthetic.invalid' });
      expect(req.status).toBe(202);
      await rt.account!.service.idle();

      // Eligibility ran through the in-process providers: registry link, live user, whole group read.
      expect(directory.requests.length).toBeGreaterThan(0);
      expect(directory.requests.every((q) => q.authorized && q.url.startsWith('https://admin.googleapis.com/admin/directory/v1/'))).toBe(true);
      expect(directory.requests.some((q) => q.url.includes(`/users/${uid(1)}`))).toBe(true);
      expect(directory.membersRequests('grpsynthnested')).toBe(1);

      const audit = readFileSync(env.SMM_AUTH_AUDIT_FILE!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LoginAuditEvent);
      expect(audit.map((e) => e.type)).toContain('code_issued');
      expect(audit).toContainEqual(expect.objectContaining({ type: 'delivery_failed', reason: 'dm_failed' }));
      expect(audit.map((e) => e.type)).not.toContain('delivery_succeeded');
      // The refused code is discarded; any guess fails and nothing else can log in.
      expect(rt.account!.service.store.findChallenges(() => true).every((c) => c.code === null)).toBe(true);
      expect((await browser.call('POST', '/api/auth/setup/verify', { challengeId: req.json.challengeId, code: '12345678' })).status).toBe(401);
      expect((await browser.call('POST', '/api/auth/login', { email: 'person-1@synthetic.invalid', password: 'synthetic passphrase 42' })).status).toBe(401);
      // Production composition: no mock endpoints.
      expect((await browser.call('GET', '/api/mock/dm-outbox')).status).toBe(404);
    } finally {
      await rt.app.close();
    }
    const written = readFileSync(env.SMM_AUTH_AUDIT_FILE!, 'utf8') + (existsSync(env.SMM_AUTH_STORE_FILE!) ? readFileSync(env.SMM_AUTH_STORE_FILE!, 'utf8') : '');
    expect(written).not.toContain(SYN_TOKEN);
    expect(written).not.toContain('person-1@synthetic.invalid');
  });

  it.each([
    ['a registry disagreeing with the Task identity map', () => registryDoc([binding(1, 'u-editor-a', 'user-other')]), /タスク本人対応表と一致しません/],
    ['a registry naming a principal that does not exist', () => registryDoc([binding(3, 'u-nobody', null)]), /既存の利用者を指していません/],
    ['a corrupt registry', () => '{"kind":', /JSON/],
  ])('refuses to start with %s, without touching data', async (_name, text, message) => {
    const env = direct();
    const file = secret(`registry-bad-${n}.json`, text());
    const error = await composeServer(loadConfig({ ...env, SMM_IDENTITY_REGISTRY_FILE: file }), { directoryFetch: syntheticDirectory().fetch, ...files }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StartupRefusal);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain(dir);
    expect(existsSync(env.SMM_DATA_FILE!)).toBe(false);
    expect(existsSync(env.SMM_AUTH_STORE_FILE!)).toBe(false);
  });

  it('refuses to start with a missing registry or token file, or a malformed token', async () => {
    const malformed = secret('directory-token-bad', 'not a token\n');
    for (const override of [{ SMM_IDENTITY_REGISTRY_FILE: join(dir, 'absent.json') }, { SMM_DIRECTORY_TOKEN_FILE: join(dir, 'absent-token') }, { SMM_DIRECTORY_TOKEN_FILE: malformed }]) {
      const directory = syntheticDirectory();
      const error = await composeServer(loadConfig({ ...direct(), ...override }), { directoryFetch: directory.fetch, ...files }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StartupRefusal);
      expect((error as Error).message).not.toContain(dir);
      expect((error as Error).message).not.toContain('not a token');
      // No Directory request is made at startup.
      expect(directory.requests).toHaveLength(0);
    }
  });

  it('refuses to start on Windows, where owner-only permissions cannot be enforced', async () => {
    const env = direct();
    const directory = syntheticDirectory();
    const error = await composeServer(loadConfig(env), { directoryFetch: directory.fetch, localFileOps: { ...NODE_LOCAL_FILE_OPS, platform: 'win32' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StartupRefusal);
    expect((error as Error).message).toMatch(/Windows/);
    expect(directory.requests).toHaveLength(0);
    expect(existsSync(env.SMM_DATA_FILE!)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('refuses on this Windows host with the real file access (no synthetic view)', async () => {
    const error = await composeServer(loadConfig(direct()), { directoryFetch: syntheticDirectory().fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StartupRefusal);
  });
});

describe('shipped direct composition: fresh authorization on every request', () => {
  const PASSWORD = 'synthetic passphrase 42';
  const CLIENT = 'socket:192.0.2.41';
  type Direct = Extract<AccountProviderConfig, { provider: 'direct' }>;

  /**
   * Sessions created earlier (a previous run on the same store, through the same registry and a
   * default reader), then the SHIPPED composition from the default env (no reuse setting exists).
   */
  async function composedWithSessions(sessions: Record<string, number>) {
    const env = direct();
    const config = loadConfig(env);
    const a = config.account as Direct;
    const directory = syntheticDirectory();
    const registry = new FileIdentityRegistry(
      registryFile,
      { principalExists: (p) => ['u-editor-a', 'u-viewer-b'].includes(p), taskUserFor: (p) => (p === 'u-editor-a' ? 'user-member-a1' : null) },
      hostFileOps(),
    );
    const sent: LoginCodeEnvelope[] = [];
    const seedOptions: LoginServiceOptions = {
      groupId: a.groupId,
      organizationId: a.organizationId!,
      acceptedLinkEvidence: a.linkEvidence,
      pepper: a.pepper,
      serviceLabel: a.serviceLabel,
      audience: PROD_ORIGIN,
      ...directIdentityProviders(registry, new GoogleDirectoryReader({ groupId: a.groupId, customerId: a.organizationId!, token: async () => SYN_TOKEN, fetchImpl: directory.fetch })),
      // TEST-ONLY capture to create the earlier sessions; the composition below refuses every DM.
      deliver: async (e) => {
        sent.push(e);
        return { deliveryId: e.deliveryId, status: 'delivered' };
      },
      audit: () => undefined,
      stateStore: new FileLoginPersistence(a.storeFile, a.pepper),
      passwords: new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY }),
    };
    const seed = new LoginService(seedOptions);
    const tokens: Record<string, string[]> = {};
    for (const [email, count] of Object.entries(sessions)) {
      const req = seed.requestChallenge({ email, clientKey: CLIENT, purpose: 'password_setup' });
      if (!req.ok) throw new Error(req.error);
      await seed.idle();
      const grant = await seed.verifySetupCode({ challengeId: req.challengeId, browserSecret: req.browserSecret, code: sent.at(-1)!.code, clientKey: CLIENT });
      if (!grant.ok) throw new Error(grant.error);
      const done = await seed.completePasswordSetup({ setupToken: grant.setupToken, password: PASSWORD, clientKey: CLIENT });
      if (!done.ok) throw new Error(done.error);
      const list = [done.sessionToken];
      for (let i = 1; i < count; i += 1) {
        const more = await seed.passwordLogin({ email, password: PASSWORD, clientKey: CLIENT });
        if (!more.ok) throw new Error(more.error);
        list.push(more.sessionToken);
      }
      tokens[email] = list;
    }
    await seed.idle();
    const rt: ServerRuntime = await composeServer(config, { directoryFetch: directory.fetch, ...files });
    const lastRevocation = () =>
      readFileSync(env.SMM_AUTH_AUDIT_FILE!, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as LoginAuditEvent)
        .filter((e) => e.type === 'session_revoked')
        .at(-1)?.reason;
    return { rt, service: rt.account!.service, directory, tokens, lastRevocation };
  }

  it('denies the very next request after a removal, suspension, archive, deletion or email change', async () => {
    const s = await composedWithSessions({ 'person-1@synthetic.invalid': 5, 'person-2@synthetic.invalid': 1 });
    const started = Date.now();
    try {
      const sessions = s.tokens['person-1@synthetic.invalid']!;
      expect(await s.service.authenticate(sessions[0])).toMatchObject({ principalId: 'u-editor-a' });
      const groupReads = s.directory.membersRequests(ROOT_GROUP);
      expect(await s.service.authenticate(sessions[0])).toMatchObject({ principalId: 'u-editor-a' });
      // The repeated request read the group again: nothing was reused.
      expect(s.directory.membersRequests(ROOT_GROUP)).toBe(groupReads + 1);

      const changes: [string, () => void, () => void, string][] = [
        ['removal', () => s.directory.remove(ROOT_GROUP, uid(1)), () => s.directory.member(ROOT_GROUP, { id: uid(1), type: 'USER' }), 'not_member'],
        ['suspension', () => s.directory.addUser(1, { suspended: true }), () => s.directory.addUser(1), 'principal_inactive'],
        ['archive', () => s.directory.addUser(1, { archived: true }), () => s.directory.addUser(1), 'principal_inactive'],
        ['deletion', () => s.directory.addUser(1, { deletionTime: '2026-10-11T00:00:00Z' }), () => s.directory.addUser(1), 'principal_inactive'],
        ['email change', () => s.directory.addUser(1, { primaryEmail: 'renamed-1@synthetic.invalid' }), () => s.directory.addUser(1), 'principal_inactive'],
      ];
      for (const [i, [name, apply, restore, reason]] of changes.entries()) {
        // A session that works on this request ...
        expect(await s.service.authenticate(sessions[i]), name).not.toBeNull();
        apply();
        // ... is denied on the very next one.
        expect(await s.service.authenticate(sessions[i]), name).toBeNull();
        expect(s.lastRevocation(), name).toBe(reason);
        restore();
      }
      // A nested member removed from the nested group is denied on the next request too.
      const nested = s.tokens['person-2@synthetic.invalid']![0];
      expect(await s.service.authenticate(nested)).toMatchObject({ principalId: 'u-viewer-b' });
      s.directory.remove('grpsynthnested', uid(2));
      expect(await s.service.authenticate(nested)).toBeNull();
      expect(s.lastRevocation()).toBe('not_member');
      // All of this happened well inside the former 15 s reuse window.
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await s.rt.app.close();
    }
  });

  it('never lets a new request join a read that started before the removal', async () => {
    const s = await composedWithSessions({ 'person-1@synthetic.invalid': 2 });
    try {
      const [early, late] = s.tokens['person-1@synthetic.invalid']!;
      const path = `/admin/directory/v1/groups/${ROOT_GROUP}/members`;
      let release!: () => void;
      s.directory.holds.set(path, new Promise<void>((resolve) => (release = resolve)));
      const before = s.directory.membersRequests(ROOT_GROUP);
      // Request A: its group read is answered with the pre-removal data but held back.
      const pending = s.service.authenticate(early);
      for (let i = 0; i < 200 && s.directory.membersRequests(ROOT_GROUP) === before; i += 1) await new Promise((r) => setTimeout(r, 5));
      expect(s.directory.membersRequests(ROOT_GROUP)).toBe(before + 1);
      s.directory.holds.delete(path);
      s.directory.remove(ROOT_GROUP, uid(1));
      // Request B starts after the removal: its own read, decided while A is still pending.
      expect(await s.service.authenticate(late)).toBeNull();
      expect(s.lastRevocation()).toBe('not_member');
      expect(s.directory.membersRequests(ROOT_GROUP)).toBe(before + 2);
      release();
      // A answers only for itself (it started before the removal); its next request is denied.
      expect(await pending).not.toBeNull();
      expect(await s.service.authenticate(early)).toBeNull();
      expect(s.lastRevocation()).toBe('not_member');
    } finally {
      await s.rt.app.close();
    }
  });
});

describe('direct providers under the login core', () => {
  const PASSWORD = 'synthetic passphrase 42';
  const CLIENT = 'socket:192.0.2.40';

  async function setup() {
    const file = secret(`registry-live-${(n += 1)}.json`, registryDoc(REGISTRY));
    const task = new Map([['u-editor-a', 'user-member-a1']]);
    const registry = new FileIdentityRegistry(file, { principalExists: (p) => ['u-editor-a', 'u-viewer-b'].includes(p), taskUserFor: (p) => task.get(p) ?? null }, hostFileOps());
    const directory = syntheticDirectory();
    // Default reader, as composed: nothing can be configured for reuse.
    const reader = new GoogleDirectoryReader({ groupId: ROOT_GROUP, customerId: SYN_CUSTOMER, token: async () => SYN_TOKEN, fetchImpl: directory.fetch });
    const providers = directIdentityProviders(registry, reader);
    const sent: LoginCodeEnvelope[] = [];
    const audit: LoginAuditEvent[] = [];
    const service = new LoginService({
      groupId: ROOT_GROUP,
      organizationId: SYN_CUSTOMER,
      acceptedLinkEvidence: ['verified_roster'],
      pepper: randomBytes(32),
      serviceLabel: 'direct provider test',
      ...providers,
      // TEST-ONLY capture of the envelope to reach a session; production uses the unavailable transport.
      deliver: async (e) => {
        sent.push(e);
        return { deliveryId: e.deliveryId, status: 'delivered' };
      },
      audit: (e) => audit.push(e),
      stateStore: REFERENCE_STORE_ACK,
      passwords: new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY }),
    });
    const signUp = async (email: string): Promise<string> => {
      const req = service.requestChallenge({ email, clientKey: CLIENT, purpose: 'password_setup' });
      if (!req.ok) throw new Error(req.error);
      await service.idle();
      const code = sent.at(-1)?.code;
      if (!code) throw new Error('no code');
      const grant = await service.verifySetupCode({ challengeId: req.challengeId, browserSecret: req.browserSecret, code, clientKey: CLIENT });
      if (!grant.ok) throw new Error(grant.error);
      const done = await service.completePasswordSetup({ setupToken: grant.setupToken, password: PASSWORD, clientKey: CLIENT });
      if (!done.ok) throw new Error(done.error);
      return done.sessionToken;
    };
    const lastRevocation = () => audit.filter((e) => e.type === 'session_revoked').at(-1)?.reason;
    return { file, task, directory, service, signUp, lastRevocation, audit };
  }

  it('signs up a direct and a nested member and revokes on a registry revocation or version change', async () => {
    const s = await setup();
    const a = await s.signUp('person-1@synthetic.invalid');
    const b = await s.signUp('person-2@synthetic.invalid');
    expect(await s.service.authenticate(a)).toMatchObject({ principalId: 'u-editor-a' });
    expect(await s.service.authenticate(b)).toMatchObject({ principalId: 'u-viewer-b' });

    writeFileSync(s.file, registryDoc([{ ...REGISTRY[0]!, status: 'revoked', linkVersion: 2 }, REGISTRY[1]]));
    expect(await s.service.authenticate(a)).toBeNull();
    expect(s.lastRevocation()).toBe('link_inactive');
    expect(await s.service.authenticate(b)).not.toBeNull();
    expect((await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);

    // A replaced binding (new version) invalidates the old session and the password set for it.
    writeFileSync(s.file, registryDoc([REGISTRY[0], { ...REGISTRY[1]!, linkVersion: 2, discord: { userId: '3000000000000000099', verified: true } }]));
    expect(await s.service.authenticate(b)).toBeNull();
    expect(s.lastRevocation()).toBe('link_changed');
    expect((await s.service.passwordLogin({ email: 'person-2@synthetic.invalid', password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
  });

  it('revokes on Directory removal, suspension, live email change or outage; password login rechecks too', async () => {
    const s = await setup();
    const a = await s.signUp('person-1@synthetic.invalid');
    s.directory.remove(ROOT_GROUP, uid(1));
    expect(await s.service.authenticate(a)).toBeNull();
    expect(s.lastRevocation()).toBe('not_member');
    expect((await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);

    s.directory.member(ROOT_GROUP, { id: uid(1), type: 'USER' });
    const again = await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT });
    if (!again.ok) throw new Error(again.error);
    s.directory.addUser(1, { suspended: true });
    expect(await s.service.authenticate(again.sessionToken)).toBeNull();
    expect(s.lastRevocation()).toBe('principal_inactive');

    s.directory.addUser(1);
    const third = await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT });
    if (!third.ok) throw new Error(third.error);
    s.directory.addUser(1, { primaryEmail: 'renamed-1@synthetic.invalid' });
    expect(await s.service.authenticate(third.sessionToken)).toBeNull();
    expect(s.lastRevocation()).toBe('principal_inactive');

    s.directory.addUser(1);
    const fourth = await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT });
    if (!fourth.ok) throw new Error(fourth.error);
    s.directory.faults.set('/admin/directory/v1/groups/grpsynthnested/members', { kind: 'status', status: 503 });
    expect(await s.service.authenticate(fourth.sessionToken)).toBeNull();
    expect(s.lastRevocation()).toBe('provider_failure');
  });

  it('denies on a Task mapping mismatch or an unsafe/corrupt registry, never on the old content', async () => {
    const s = await setup();
    const a = await s.signUp('person-1@synthetic.invalid');
    s.task.set('u-editor-a', 'user-member-z9');
    expect(await s.service.authenticate(a)).toBeNull();
    expect(s.lastRevocation()).toBe('provider_failure');
    s.task.set('u-editor-a', 'user-member-a1');

    const b = await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT });
    if (!b.ok) throw new Error(b.error);
    writeFileSync(s.file, '{"kind":"smm-identity-registry","version":1,"bindings":[{"linkId":');
    expect(await s.service.authenticate(b.sessionToken)).toBeNull();
    expect(s.lastRevocation()).toBe('provider_failure');
    rmSync(s.file);
    expect((await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT })).ok).toBe(false);
    // The revoked session stays revoked after the file is restored; a fresh login works again.
    writeFileSync(s.file, registryDoc(REGISTRY), { mode: 0o600 });
    expect(await s.service.authenticate(b.sessionToken)).toBeNull();
    expect((await s.service.passwordLogin({ email: 'person-1@synthetic.invalid', password: PASSWORD, clientKey: CLIENT })).ok).toBe(true);
  });
});
