import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/server/auth.js';
import { authorizeUrl, requestToken } from '../../src/server/bank/client.js';
import { loadBankConfig, validateBankConfig, type BankConfig } from '../../src/server/bank/config.js';
import { BankFlowError, BankService } from '../../src/server/bank/service.js';
import { BankVault, VaultUnreadable } from '../../src/server/bank/vault.js';

// The bank connection without HTTP: the operator file, the encrypted tokens, the bank's token endpoint (faked), and the
// connect / renew / disconnect lifecycle. Synthetic client ids, secrets and tokens only; no request leaves the process.

const CLIENT_ID = 'synthetic-client-0001';
const SECRET = 'synthetic-secret-0001-abcdef';
const REDIRECT = 'https://app.example.invalid/bank/callback';
const T0 = Date.parse('2026-11-06T00:00:00.000Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-bank-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const raw = (changes: Record<string, unknown> = {}) => ({ version: 1, environment: 'sunabar', clientId: CLIENT_ID, redirectUri: REDIRECT, ...changes });
const config = (changes: Record<string, unknown> = {}, key = randomBytes(32), secret = SECRET): BankConfig => validateBankConfig(raw(changes), dir, secret, key);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake bank: answers the token endpoint from a queue and the read APIs with synthetic accounts. */
function fakeBank(answers: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: typeof init?.body === 'string' ? init.body : '' });
    if (url.endsWith('/ganb/api/auth/v1/token')) {
      const next = answers.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }
    if (url.endsWith('/corporation/v1/accounts')) return new Response(JSON.stringify({ accounts: [{ accountId: '101011234567', branchName: '合成支店', accountTypeName: '普通預金', accountNumber: '1234567' }] }), { status: 200 });
    if (url.endsWith('/corporation/v1/accounts/balances')) return new Response(JSON.stringify({ balances: [{ accountId: '101011234567', balance: '1500000' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const grant = (n: number, changes: Record<string, unknown> = {}) => ({ status: 200, body: { access_token: `synthetic-access-${n}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `synthetic-refresh-${n}`, scope: 'private:account private:virtual-account', ...changes } });

function service(c: BankConfig, bank: ReturnType<typeof fakeBank>, clock: { now: number }) {
  return new BankService(c, { fetch: bank.fetchImpl, now: () => clock.now, clock: () => new Date(clock.now).toISOString() });
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

describe('bank.json', () => {
  it('accepts the sunabar setup and fixes the bank addresses in code', () => {
    const c = config();
    expect(c.endpoints).toEqual({
      authorize: 'https://api.sunabar.gmo-aozora.com/ganb/api/auth/v1/authorization',
      token: 'https://api.sunabar.gmo-aozora.com/ganb/api/auth/v1/token',
      api: 'https://api.sunabar.gmo-aozora.com/corporation/v1',
    });
    expect(c.scopes).toEqual(['private:account', 'private:virtual-account']);
    expect(c.clientAuth).toBe('basic');
    expect(c.tokenFile).toBe(path.join(dir, 'bank-tokens.json'));
  });

  it('refuses transfer scopes, the production bank, addresses in the file, and a redirect that is not /bank/callback', () => {
    expect(() => config({ scopes: ['private:account', 'private:transfer'] })).toThrow(/private:transfer/);
    expect(() => config({ scopes: ['private:bulk-transfer'] })).toThrow(ConfigError);
    expect(() => config({ scopes: ['private:virtual-account'] })).toThrow(/private:account/);
    expect(() => config({ environment: 'production' })).toThrow(/production/);
    expect(() => config({ tokenEndpoint: 'https://attacker.example/token' })).toThrow(/不明な項目/);
    expect(() => config({ redirectUri: 'http://app.example.invalid/bank/callback' })).toThrow(/https/);
    expect(() => config({ redirectUri: 'https://app.example.invalid/api/bank/callback' })).toThrow(/パス/);
    expect(() => config({ redirectUri: 'https://app.example.invalid/bank/callback?x=1' })).toThrow(ConfigError);
    expect(() => config({ redirectUri: 'https://APP.example.invalid/bank/callback' })).toThrow(/1 文字も/);
    expect(config({ redirectUri: 'http://localhost:5173/bank/callback' }).redirectUri).toBe('http://localhost:5173/bank/callback');
  });

  it('reads the secret and the key from owner-only files, never naming their contents', () => {
    const configDir = path.join(dir, 'config');
    const secretFile = path.join(dir, 'secret.txt');
    const keyFile = path.join(dir, 'key.txt');
    writeFileSync(secretFile, `${String.fromCharCode(0xfeff)}${SECRET}\n`, { mode: 0o600 });
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const mailConfig = path.join(dir, 'mailbox.json');
    expect(loadBankConfig(mailConfig, configDir)).toBeNull();
    writeFileSync(path.join(dir, 'bank.json'), JSON.stringify(raw({ clientSecretFile: secretFile, tokenKeyFile: keyFile })));
    expect(loadBankConfig(mailConfig, configDir)!.clientSecret).toBe(SECRET);
    writeFileSync(keyFile, 'short');
    expect(() => loadBankConfig(mailConfig, configDir)).toThrow(/32 バイト/);
    if (process.platform !== 'win32') {
      writeFileSync(keyFile, randomBytes(32).toString('hex'));
      chmodSync(secretFile, 0o644);
      try {
        loadBankConfig(mailConfig, configDir);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toMatch(/600/);
        expect((err as Error).message).not.toContain(SECRET);
      }
    }
  });
});

describe('the token vault', () => {
  it('keeps the tokens encrypted and refuses a file made for another client or key', () => {
    const key = randomBytes(32);
    const file = path.join(dir, 'bank-tokens.json');
    const vault = new BankVault(file, key, { environment: 'sunabar', clientId: CLIENT_ID });
    const tokens = { accessToken: 'synthetic-access-secret', refreshToken: 'synthetic-refresh-secret', expiresAt: T0, scopes: ['private:account'], connectedAt: '2026-11-06T00:00:00.000Z', connectedBy: 'u1', refreshedAt: null };
    vault.write(tokens);
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('synthetic-access-secret');
    expect(onDisk).not.toContain('synthetic-refresh-secret');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(vault.read()).toEqual(tokens);
    expect(() => new BankVault(file, key, { environment: 'sunabar', clientId: 'another-client' }).read()).toThrow(VaultUnreadable);
    expect(() => new BankVault(file, randomBytes(32), { environment: 'sunabar', clientId: CLIENT_ID }).read()).toThrow(VaultUnreadable);
    const outer = JSON.parse(onDisk) as { data: string };
    const flipped = Buffer.from(outer.data, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    writeFileSync(file, JSON.stringify({ ...outer, data: flipped.toString('base64') }));
    expect(() => vault.read()).toThrow(VaultUnreadable);
    vault.clear();
    expect(vault.read()).toBeNull();
    vault.clear();
  });
});

describe('the bank calls', () => {
  it('asks only for the read scopes, with spaces as %20 and the registered redirect_uri', () => {
    const url = authorizeUrl(config(), 'state-value');
    expect(url.startsWith('https://api.sunabar.gmo-aozora.com/ganb/api/auth/v1/authorization?')).toBe(true);
    expect(url).toContain('scope=private:account%20private:virtual-account');
    expect(url).not.toContain('+');
    expect(url).toContain(`redirect_uri=${encodeURIComponent(REDIRECT)}`);
    expect(new URL(url).searchParams.get('response_type')).toBe('code');
  });

  it('sends the client secret as Basic or in the body, as configured', async () => {
    const basic = fakeBank([grant(1)]);
    await requestToken(config(), basic.fetchImpl, { grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT }, ['private:account']);
    expect(basic.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);
    expect(basic.calls[0]!.body).not.toContain('client_secret');
    const post = fakeBank([grant(1)]);
    await requestToken(config({ clientAuth: 'post' }), post.fetchImpl, { grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT }, ['private:account']);
    expect(post.calls[0]!.headers.Authorization).toBeUndefined();
    expect(new URLSearchParams(post.calls[0]!.body).get('client_secret')).toBe(SECRET);
  });

  it('refuses a grant wider than the read scopes and keeps the bank answer out of the message', async () => {
    const bank = fakeBank([grant(1, { scope: 'private:account private:transfer' }), { status: 400, body: { error: 'invalid_grant', error_description: 'synthetic-detail' } }]);
    await expect(requestToken(config(), bank.fetchImpl, { grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT }, ['private:account'])).rejects.toMatchObject({ kind: 'scope' });
    const refused = requestToken(config(), bank.fetchImpl, { grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT }, ['private:account']);
    await expect(refused).rejects.toMatchObject({ kind: 'invalid_grant' });
    await expect(refused).rejects.not.toThrow(/synthetic-detail/);
  });
});

describe('connecting, renewing, disconnecting', () => {
  it('binds the state to the member, uses it once, and lets it expire', async () => {
    const clock = { now: T0 };
    const bank = fakeBank([grant(1), grant(2)]);
    const s = service(config(), bank, clock);
    const state = stateOf(s.start('chair'));
    await expect(s.complete('someone-else', { state, code: 'code-1' })).rejects.toMatchObject({ reason: 'state' });
    // Used up by the failed attempt: the right member cannot replay it.
    await expect(s.complete('chair', { state, code: 'code-1' })).rejects.toMatchObject({ reason: 'state' });
    const late = stateOf(s.start('chair'));
    clock.now += 11 * 60_000;
    await expect(s.complete('chair', { state: late, code: 'code-1' })).rejects.toMatchObject({ reason: 'state' });
    expect(bank.calls).toHaveLength(0);
    const denied = stateOf(s.start('chair'));
    await expect(s.complete('chair', { state: denied, error: 'access_denied' })).rejects.toThrow(/許可されませんでした/);
    const ok = stateOf(s.start('chair'));
    await s.complete('chair', { state: ok, code: 'code-1' });
    expect(new URLSearchParams(bank.calls[0]!.body).get('redirect_uri')).toBe(REDIRECT);
    const status = s.status();
    expect(status).toMatchObject({ state: 'connected', scopes: ['private:account', 'private:virtual-account'], connectedBy: 'chair', refreshable: true });
    expect(JSON.stringify(status)).not.toContain('synthetic-access');
    expect(JSON.stringify(status)).not.toContain('synthetic-refresh');
    const audit = readFileSync(path.join(dir, 'bank-audit.jsonl'), 'utf8');
    expect(audit).toContain('"connected"');
    expect(audit).not.toContain('code-1');
    expect(audit).not.toContain('synthetic-');
  });

  it('renews in the second half of the token life, once for concurrent callers, saving the rotated refresh token', async () => {
    const clock = { now: T0 };
    const bank = fakeBank([grant(1), grant(2)]);
    const c = config();
    const s = service(c, bank, clock);
    await s.complete('chair', { state: stateOf(s.start('chair')), code: 'code-1' });
    clock.now += 20 * 60_000;
    expect(await s.accessToken()).toBe('synthetic-access-1');
    clock.now += 15 * 60_000;
    const [a, b] = await Promise.all([s.accessToken(), s.accessToken()]);
    expect([a, b]).toEqual(['synthetic-access-2', 'synthetic-access-2']);
    const refreshes = bank.calls.filter((call) => new URLSearchParams(call.body).get('grant_type') === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(new URLSearchParams(refreshes[0]!.body).get('refresh_token')).toBe('synthetic-refresh-1');
    // A fresh service (a restart) reads the rotated tokens from the vault.
    expect(new BankVault(c.tokenFile, c.tokenKey, { environment: 'sunabar', clientId: CLIENT_ID }).read()).toMatchObject({ accessToken: 'synthetic-access-2', refreshToken: 'synthetic-refresh-2' });
  });

  it('clears the tokens and asks for a new connection when the bank refuses the renewal; keeps them on a network failure', async () => {
    const clock = { now: T0 };
    const bank = fakeBank([grant(1), { status: 503, body: {} }, { status: 400, body: { error: 'invalid_grant' } }]);
    const s = service(config(), bank, clock);
    await s.complete('chair', { state: stateOf(s.start('chair')), code: 'code-1' });
    clock.now += 40 * 60_000;
    await expect(s.accessToken()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(s.status().state).toBe('connected');
    await expect(s.accessToken()).rejects.toMatchObject({ reason: 'reconnect' });
    expect(s.status()).toMatchObject({ state: 'reconnect_required', connectedBy: null });
    await expect(s.accessToken()).rejects.toBeInstanceOf(BankFlowError);
  });

  it('uses a token without refresh until it expires, then says so', async () => {
    const clock = { now: T0 };
    const bank = fakeBank([grant(1, { refresh_token: undefined })]);
    const s = service(config(), bank, clock);
    await s.complete('chair', { state: stateOf(s.start('chair')), code: 'code-1' });
    clock.now += 50 * 60_000;
    expect(await s.accessToken()).toBe('synthetic-access-1');
    clock.now += 11 * 60_000;
    expect(s.status().state).toBe('expired');
    await expect(s.accessToken()).rejects.toMatchObject({ reason: 'expired' });
  });

  it('sweeps: leaves a valid token, deletes an expired one without refresh, renews one with refresh', async () => {
    const clock = { now: T0 };
    const bank = fakeBank([grant(1, { refresh_token: undefined }), grant(2), grant(3)]);
    const c = config();
    const s = service(c, bank, clock);
    expect(await s.sweep()).toBe('none');
    await s.complete('chair', { state: stateOf(s.start('chair')), code: 'code-1' });
    clock.now += 59 * 60_000;
    expect(await s.sweep()).toBe('valid');
    expect(existsSync(c.tokenFile)).toBe(true);
    clock.now += 2 * 60_000;
    expect(await s.sweep()).toBe('deleted');
    expect(existsSync(c.tokenFile)).toBe(false);
    expect(s.status()).toMatchObject({ state: 'reconnect_required', lastError: { message: expect.stringContaining('削除しました') } });
    expect(readFileSync(path.join(dir, 'bank-audit.jsonl'), 'utf8')).toContain('"expired_deleted"');

    // With a refresh token, the expired access token is replaced by a renewed one.
    await s.complete('chair', { state: stateOf(s.start('chair')), code: 'code-2' });
    clock.now += 61 * 60_000;
    expect(await s.sweep()).toBe('renewed');
    expect(new BankVault(c.tokenFile, c.tokenKey, { environment: 'sunabar', clientId: CLIENT_ID }).read()).toMatchObject({ accessToken: 'synthetic-access-3', refreshToken: 'synthetic-refresh-3' });
    expect(s.status().state).toBe('connected');
  });

  it('sweeps: deletes when the bank refuses the refresh token, keeps the tokens on a network failure', async () => {
    const clock = { now: T0 };
    const bank = fakeBank([grant(1), { status: 503, body: {} }, { status: 400, body: { error: 'invalid_grant' } }]);
    const c = config();
    const s = service(c, bank, clock);
    await s.complete('chair', { state: stateOf(s.start('chair')), code: 'code-1' });
    clock.now += 61 * 60_000;
    expect(await s.sweep()).toBe('failed');
    expect(existsSync(c.tokenFile)).toBe(true);
    expect(await s.sweep()).toBe('deleted');
    expect(existsSync(c.tokenFile)).toBe(false);
    expect(s.status().state).toBe('reconnect_required');
  });

  it('sweeps: leaves a file it cannot open for the member to reconnect over', async () => {
    const clock = { now: T0 };
    const c = config();
    new BankVault(c.tokenFile, randomBytes(32), { environment: 'sunabar', clientId: CLIENT_ID }).write({ accessToken: 'synthetic-access-x', refreshToken: null, expiresAt: T0 - 1, scopes: ['private:account'], connectedAt: new Date(T0 - 3_600_000).toISOString(), connectedBy: 'chair', refreshedAt: null });
    const s = service(c, fakeBank([]), clock);
    expect(await s.sweep()).toBe('unreadable');
    expect(existsSync(c.tokenFile)).toBe(true);
  });

  it('checks the connection with the accounts and balances, account numbers cut to four digits', async () => {
    const clock = { now: T0 };
    const bank = fakeBank([grant(1)]);
    const s = service(config(), bank, clock);
    await s.complete('chair', { state: stateOf(s.start('chair')), code: 'code-1' });
    const checked = await s.check('accountant');
    expect(checked.accounts).toEqual([{ branchName: '合成支店', accountTypeName: '普通預金', accountNumberLast4: '4567', balanceYen: 1_500_000 }]);
    const reads = bank.calls.filter((call) => call.method === 'GET');
    expect(reads.map((call) => call.headers['x-access-token'])).toEqual(['synthetic-access-1', 'synthetic-access-1']);
    s.disconnect('chair');
    expect(s.status().state).toBe('disconnected');
    await expect(s.check('accountant')).rejects.toMatchObject({ reason: 'not_connected' });
  });
});
