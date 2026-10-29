import { afterEach, describe, expect, it } from 'vitest';
import { R } from '../helpers.js';
import { EMAIL, expectAcceptedWithoutCode, makeMockAccountApp, makeProductionAccountApp, PROXY_IP, signUp, TEST_PASSWORD, type AccountApp } from '../account-harness.js';
import { startTaskFake, type TaskFake } from '../task-fake.js';

let a: AccountApp | null = null;
let fake: TaskFake | null = null;
afterEach(async () => {
  await a?.close();
  await fake?.close();
  a = null;
  fake = null;
});

describe('account mock composition over HTTP', () => {
  it('runs email -> mock DM code -> own password -> protected app -> logout -> password login', async () => {
    a = await makeMockAccountApp();
    const b = a.browser();
    expect((await b.call('GET', '/api/session')).json).toMatchObject({ authMode: 'account', composition: 'mock', user: null, passwordPolicy: { minLength: 12, maxLength: 128 } });
    expect((await b.call('GET', '/api/mailboxes')).status).toBe(401);

    const req = await b.call('POST', '/api/auth/setup/request', { email: EMAIL['u-editor-a'] });
    expect(req.status).toBe(202);
    const challengeCookie = req.cookies.find((c) => c.startsWith('__Host-smm_challenge='))!;
    expect(challengeCookie).toMatch(/HttpOnly/i);
    expect(challengeCookie).toMatch(/Secure/i);
    expect(challengeCookie).toMatch(/SameSite=Strict/i);
    expect(challengeCookie).toMatch(/Path=\//);

    const code = await a.codeFor('u-editor-a');
    expectAcceptedWithoutCode(req, code, a.service.policy.codeTtlMs / 1000);
    const outbox = await b.call('GET', '/api/mock/dm-outbox');
    expect(outbox.json.messages[0]).toMatchObject({ recipientLabel: '編集担当A', verifiedEmail: EMAIL['u-editor-a'], template: 'password_setup_code_v1' });

    expect((await b.call('POST', '/api/auth/setup/verify', { challengeId: req.json.challengeId, code: '00000000' })).status).toBe(401);
    const verify = await b.call('POST', '/api/auth/setup/verify', { challengeId: req.json.challengeId, code });
    expect(verify.status).toBe(200);
    expect(verify.json).toMatchObject({ next: 'set_password', hasPassword: false });
    expect(verify.raw).not.toContain(code);
    expect((await b.call('POST', '/api/auth/setup/verify', { challengeId: req.json.challengeId, code })).status).toBe(401);

    expect((await b.call('POST', '/api/auth/setup/password', { password: TEST_PASSWORD, confirmation: `${TEST_PASSWORD}x` })).json.error).toBe('password_mismatch');
    expect((await b.call('POST', '/api/auth/setup/password', { password: 'short', confirmation: 'short' })).json.error).toBe('password_policy');
    const set = await b.call('POST', '/api/auth/setup/password', { password: TEST_PASSWORD, confirmation: TEST_PASSWORD });
    expect(set.status).toBe(200);
    expect(set.json.user).toMatchObject({ id: 'u-editor-a' });
    expect(set.raw).not.toContain(TEST_PASSWORD);
    expect((await b.call('GET', '/api/mailboxes')).status).toBe(200);

    const oldCookie = b.jar.get('__Host-smm_session')!;
    expect((await b.call('POST', '/api/auth/logout', {})).json.user).toBeNull();
    const stale = await a.app.inject({ method: 'GET', url: '/api/mailboxes', headers: { host: '127.0.0.1:5178', cookie: `__Host-smm_session=${oldCookie}` } });
    expect(stale.statusCode).toBe(401);

    const login = await b.call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    expect(b.jar.get('__Host-smm_session')).not.toBe(oldCookie);
    expect((await b.call('GET', '/api/session')).json.user.id).toBe('u-editor-a');
  });

  it('answers the same for unknown and known addresses and for unknown and wrong passwords', async () => {
    a = await makeMockAccountApp();
    await signUp(a, 'u-editor-a');
    const b = a.browser();
    const known = await b.call('POST', '/api/auth/setup/request', { email: EMAIL['u-viewer-b'] });
    const unknown = await b.call('POST', '/api/auth/setup/request', { email: 'nobody@staff.invalid' });
    expect(unknown.status).toBe(known.status);
    expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(known.json).sort());
    expect(unknown.json.message).toBe(known.json.message);
    const wrong = await b.call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: 'wrong password 123' });
    const nobody = await b.call('POST', '/api/auth/login', { email: 'nobody@staff.invalid', password: 'wrong password 123' });
    const noPassword = await b.call('POST', '/api/auth/login', { email: EMAIL['u-viewer-b'], password: TEST_PASSWORD });
    for (const r of [nobody, noPassword]) {
      expect(r.status).toBe(wrong.status);
      expect(r.json).toEqual(wrong.json);
    }
  });

  it('requires the CSRF header and exact origin for writes and never trusts identity headers', async () => {
    a = await makeMockAccountApp();
    const b = await signUp(a, 'u-editor-a');
    expect((await b.call('POST', '/api/auth/logout', {}, { 'x-smm-csrf': null })).status).toBe(403);
    expect((await b.call('POST', '/api/auth/logout', {}, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await b.call('POST', '/api/auth/logout', {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await b.call('GET', '/api/mailboxes', undefined, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await b.call('GET', '/api/session')).json.user.id).toBe('u-editor-a');

    const anon = a.browser();
    const forged: Record<string, string>[] = [{ 'x-mail-user': 'u-editor-a' }, { 'x-svc-actor': 'user-member-a1' }, { 'x-demo-user': 'u-editor-a' }, { cookie: 'smm_demo_persona=u-editor-a' }];
    for (const headers of forged) {
      expect((await anon.call('GET', '/api/mailboxes', undefined, headers)).status).toBe(401);
    }
  });

  it('has no demo persona, reset or fault endpoints and rejects oversized or URL-borne secrets', async () => {
    a = await makeMockAccountApp();
    const b = a.browser();
    for (const [method, url] of [
      ['GET', '/api/personas'],
      ['POST', '/api/session'],
      ['POST', '/api/demo/reset'],
      ['PUT', '/api/demo/faults'],
    ] as const) {
      expect((await b.call(method, url, method === 'GET' ? undefined : {})).status, url).toBe(404);
    }
    expect((await b.call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: 'x'.repeat(600) })).json.error).toBe('invalid_request');
    expect((await b.call('POST', '/api/auth/login?password=x', { email: EMAIL['u-editor-a'], password: 'y' })).status).toBe(400);
  });

  it('keeps the original inbox ACL for nested and organization-eligible users; admins read no mail', async () => {
    a = await makeMockAccountApp();
    const nested = await signUp(a, 'u-viewer-b');
    const ids = (r: { json: { id: string }[] }) => r.json.map((m) => m.id).sort();
    expect(ids(await nested.call('GET', '/api/mailboxes'))).toEqual(['mbx-billing', 'mbx-support']);
    expect((await nested.call('GET', `/api/receipts/${R.salesQuote}`)).status).toBe(404);
    const inbox = await nested.call('GET', '/api/inbox?source=email');
    expect(inbox.raw).not.toContain('営業窓口');
    const org = await signUp(a, 'u-editor-c');
    expect(ids(await org.call('GET', '/api/mailboxes'))).toEqual(['mbx-billing', 'mbx-sales']);
    expect((await org.call('GET', `/api/receipts/${R.supportLogin}`)).status).toBe(404);
    const admin = await signUp(a, 'u-admin');
    expect((await admin.call('GET', '/api/session')).json.user.canManageAccess).toBe(true);
    expect((await admin.call('GET', '/api/mailboxes')).json).toEqual([]);
    expect((await admin.call('GET', `/api/receipts/${R.supportLogin}`)).status).toBe(404);
  });

  it('ends sessions on membership loss, deactivation and binding replacement; recovery revokes old sessions', async () => {
    a = await makeMockAccountApp();
    const first = await signUp(a, 'u-editor-a');
    const second = a.browser();
    expect((await second.call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: TEST_PASSWORD })).status).toBe(200);
    // Recovery through the same verified binding: both older sessions end.
    a.clock.advance(61_000);
    const recovered = await signUp(a, 'u-editor-a', a.browser(), 'brand new passphrase 77');
    expect((await first.call('GET', '/api/mailboxes')).status).toBe(401);
    expect((await second.call('GET', '/api/mailboxes')).status).toBe(401);
    expect((await recovered.call('GET', '/api/mailboxes')).status).toBe(200);
    expect((await a.browser().call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: TEST_PASSWORD })).status).toBe(401);

    const control = a.browser();
    expect((await control.call('POST', '/api/mock/directory', { principalId: 'u-editor-a', action: 'remove_membership' })).json.revoked.sessions).toBe(1);
    expect((await recovered.call('GET', '/api/mailboxes')).status).toBe(401);
    expect((await a.browser().call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: 'brand new passphrase 77' })).status).toBe(401);
    await control.call('POST', '/api/mock/directory', { principalId: 'u-editor-a', action: 'restore_membership' });
    const back = a.browser();
    expect((await back.call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: 'brand new passphrase 77' })).status).toBe(200);
    await control.call('POST', '/api/mock/directory', { principalId: 'u-editor-a', action: 'replace_binding' });
    a.clock.advance(1_000);
    expect((await back.call('GET', '/api/mailboxes')).status).toBe(401);
    expect((await a.browser().call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: 'brand new passphrase 77' })).status).toBe(401);

    const viewer = await signUp(a, 'u-viewer-b');
    await control.call('POST', '/api/mock/directory', { principalId: 'u-viewer-b', action: 'disable' });
    expect((await viewer.call('GET', '/api/mailboxes')).status).toBe(401);
    // A closed DM never yields a usable code.
    await control.call('POST', '/api/mock/directory', { principalId: 'u-noaccess-d', action: 'dm_closed' });
    const d = a.browser();
    expect((await d.call('POST', '/api/auth/setup/request', { email: EMAIL['u-noaccess-d'] })).status).toBe(202);
    await a.service.idle();
    expect((await d.call('GET', '/api/mock/dm-outbox')).json.messages.some((m: { recipientLabel: string }) => m.recipientLabel === '権限なしD')).toBe(false);
  });

  it('applies the same verified identity to the Task gateway', async () => {
    fake = await startTaskFake();
    a = await makeMockAccountApp(fake);
    const org = await signUp(a, 'u-editor-c');
    const ctx = await org.call('GET', '/api/tasks/context');
    expect(ctx.json.memberships.map((m: { workspace: { id: string } }) => m.workspace.id)).toEqual(['ws-publicity']);
    expect((await org.call('GET', '/api/tasks/workspaces/ws-planning/tasks')).status).toBe(403);
    const nested = await signUp(a, 'u-viewer-b');
    expect((await nested.call('GET', '/api/tasks/context')).json).toMatchObject({ bound: false });
    expect((await a.browser().call('GET', '/api/tasks/context')).status).toBe(401);
  });
});

describe('account production composition', () => {
  it('works only through the trusted proxy and public host, without any mock endpoint', async () => {
    a = await makeProductionAccountApp();
    const b = a.browser();
    expect((await b.call('GET', '/api/mock/dm-outbox')).status).toBe(404);
    expect((await b.call('POST', '/api/mock/directory', { principalId: 'u-editor-a', action: 'disable' })).status).toBe(404);
    expect((await b.call('GET', '/api/personas')).status).toBe(404);
    const direct = await a.app.inject({ method: 'GET', url: '/api/session', remoteAddress: '198.51.100.7', headers: { host: 'mail.example.invalid' } });
    expect(direct.statusCode).toBe(403);
    expect((await b.call('GET', '/api/session', undefined, { host: 'other.example.invalid' })).status).toBe(421);
    const health = await a.app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1' });
    expect(health.json()).toEqual({ ok: true });
    expect((await b.call('GET', '/api/session')).json).toMatchObject({ authMode: 'account', composition: 'production', user: null });
  });

  it('completes setup and login through the signed identity bridge with secure cookies', async () => {
    a = await makeProductionAccountApp();
    const b = await signUp(a, 'u-editor-a');
    const bridge = (a as Awaited<ReturnType<typeof makeProductionAccountApp>>).bridge;
    expect(bridge.dms.at(-1)).toMatchObject({ template: 'password_setup_code_v1', audience: 'https://mail.example.invalid', context: { verifiedEmail: EMAIL['u-editor-a'] } });
    expect((await b.call('GET', '/api/mailboxes')).status).toBe(200);
    const login = await a.browser('198.51.100.8').call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: TEST_PASSWORD });
    const cookie = login.cookies.find((c) => c.startsWith('__Host-smm_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('denies when the bridge answers malformed data or the client address is not attributable', async () => {
    a = await makeProductionAccountApp();
    await signUp(a, 'u-editor-a');
    const bridge = (a as Awaited<ReturnType<typeof makeProductionAccountApp>>).bridge;
    bridge.garbage.on = true;
    expect((await a.browser().call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: TEST_PASSWORD })).status).toBe(401);
    bridge.garbage.on = false;
    // The proxy-appended address is only a rate-limit key; it grants nothing by itself.
    const other = await a.browser().call('POST', '/api/auth/login', { email: EMAIL['u-editor-a'], password: TEST_PASSWORD }, { 'x-forwarded-for': '203.0.113.9' });
    expect(other.status).toBe(200);
    // An unparsable client address leaves no trusted rate-limit key: refused, not guessed.
    const raw = await a.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: PROXY_IP,
      headers: { host: 'mail.example.invalid', origin: 'https://mail.example.invalid', 'x-smm-csrf': '1', 'content-type': 'application/json', 'x-forwarded-for': 'not-an-ip' },
      payload: JSON.stringify({ email: EMAIL['u-editor-a'], password: TEST_PASSWORD }),
    });
    expect(raw.statusCode).toBe(429);
  });
});
