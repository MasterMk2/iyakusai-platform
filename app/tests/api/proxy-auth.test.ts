import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/server/auth.js';
import { buildApp } from '../../src/server/http/app.js';
import { StateStore } from '../../src/server/domain/store.js';
import {
  ADMIN,
  EDITOR_A,
  ID,
  makeProxyApp,
  PROXY_IP,
  PROXY_MAP,
  proxyAuth,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  R,
  seedState,
  TEST_PORT,
  VIEWER_B,
  type ProxyTestApp,
} from '../helpers.js';

let t: ProxyTestApp;
beforeEach(async () => {
  t = await makeProxyApp();
});

const snapshot = () => JSON.stringify(t.store.current);
const noteUrl = `/api/receipts/${R.supportLogin}/notes`;

describe('trusted-proxy startup validation', () => {
  it('refuses to build with a map naming an unknown or inactive user', async () => {
    const unknown = new Map([...PROXY_MAP, ['ghost@idp.example', 'u-ghost']]);
    await expect(buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT, auth: proxyAuth(unknown) })).rejects.toThrow(ConfigError);
    const state = await seedState();
    state.users.find((u) => u.id === VIEWER_B)!.disabled = true;
    await expect(buildApp({ store: new StateStore(state, null), listenPort: TEST_PORT, auth: proxyAuth() })).rejects.toThrow(ConfigError);
  });
});

describe('identity is accepted only from the allowlisted proxy socket', () => {
  it('maps a verified identity to its application user without demo labelling', async () => {
    const session = await t.call(ID.editorA, 'GET', '/api/session');
    expect(session.status).toBe(200);
    expect(session.json).toEqual({
      demoAuthentication: false,
      authMode: 'trusted-proxy',
      user: { id: EDITOR_A, displayName: '編集担当A', roleLabel: '編集者（サポート・営業）', canManageAccess: false },
    });
    expect(session.headers['set-cookie']).toBeUndefined();
    // IPv4-mapped IPv6 spelling of the same proxy socket is the same proxy.
    expect((await t.call(ID.viewerB, 'GET', '/api/session', undefined, {}, `::ffff:${PROXY_IP}`)).json.user.id).toBe(VIEWER_B);
  });

  it('rejects a direct client with a forged identity header, even when it claims a forwarded proxy address', async () => {
    const before = snapshot();
    for (const remote of ['10.0.0.3', '127.0.0.1', '192.0.2.10']) {
      for (const [method, url] of [['GET', '/api/session'], ['GET', '/api/mailboxes'], ['GET', '/'], ['GET', `/api/receipts/${R.supportAttachment}/attachments/att1`]] as const) {
        const res = await t.call(ID.admin, method, url, undefined, { 'x-forwarded-for': PROXY_IP, forwarded: `for=${PROXY_IP}`, 'x-real-ip': PROXY_IP }, remote);
        expect(res.status, `${remote} ${url}`).toBe(403);
        expect(res.json.error).toBe('untrusted_proxy');
        expect(res.raw).not.toMatch(/合成|support|編集/);
      }
      const write = await t.call(ID.editorA, 'POST', noteUrl, { body: '直接接続のメモ' }, {}, remote);
      expect(write.status, remote).toBe(403);
    }
    expect(snapshot()).toBe(before);
  });

  it('rejects missing, blank, combined, malformed and unknown identities', async () => {
    const cases: [string | null, number, string][] = [
      [null, 401, 'unauthenticated'],
      ['', 401, 'unauthenticated'],
      ['   ', 401, 'unauthenticated'],
      [`${ID.editorA},${ID.admin}`, 403, 'invalid_identity'],
      [`${ID.editorA}, ${ID.admin}`, 403, 'invalid_identity'],
      ['editor a', 403, 'invalid_identity'],
      ['x'.repeat(129), 403, 'invalid_identity'],
      ['nobody@idp.example', 403, 'unknown_identity'],
      [ID.editorA.toUpperCase(), 403, 'unknown_identity'],
      [EDITOR_A, 403, 'unknown_identity'], // an application user ID is not a proxy identity
    ];
    const before = snapshot();
    for (const [identity, status, error] of cases) {
      for (const url of ['/api/session', '/api/mailboxes', `/api/receipts/${R.supportAttachment}/attachments/att1`, '/api/admin/access']) {
        const res = await t.call(identity, 'GET', url);
        expect(res.status, `${identity} ${url}`).toBe(status);
        expect(res.json.error, `${identity} ${url}`).toBe(error);
      }
      expect((await t.call(identity, 'POST', noteUrl, { body: '識別できない利用者のメモ' })).status, String(identity)).toBe(status);
      // Non-API writes are identity-gated too; only static GET/HEAD skips the identity check.
      expect((await t.call(identity, 'POST', '/', {})).status, String(identity)).toBe(status);
      // A percent-encoded API path is still an API path.
      const encoded = await t.call(identity, 'GET', '/%61pi/mailboxes');
      expect(encoded.status, `${identity} encoded`).toBe(status);
      expect(encoded.raw).not.toContain('サポート窓口');
    }
    expect(snapshot()).toBe(before);
  });

  it('rejects an identity whose user was deactivated after startup', async () => {
    expect((await t.call(ID.viewerB, 'GET', '/api/mailboxes')).status).toBe(200);
    t.store.current.users.find((u) => u.id === VIEWER_B)!.disabled = true;
    const res = await t.call(ID.viewerB, 'GET', '/api/mailboxes');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('unknown_identity');
  });

  it('ignores demo cookies, persona selection and alternative identity headers', async () => {
    const impersonate = { cookie: `smm_demo_persona=${ADMIN}`, 'x-forwarded-user': ID.admin, 'x-remote-user': ID.admin, 'remote-user': ID.admin, 'x-auth-request-user': ID.admin };
    const session = await t.call(ID.viewerB, 'GET', '/api/session', undefined, impersonate);
    expect(session.json.user.id).toBe(VIEWER_B);
    expect((await t.call(ID.viewerB, 'GET', '/api/admin/access', undefined, impersonate)).status).toBe(403);
    const before = snapshot();
    const grant = await t.call(ID.viewerB, 'PUT', '/api/admin/access', { userId: VIEWER_B, mailboxId: 'mbx-sales', level: 'edit', expectedVersion: 1 }, impersonate);
    expect(grant.status).toBe(403);
    expect((await t.call(ID.viewerB, 'POST', '/api/session', { userId: ADMIN }, impersonate)).status).toBe(404);
    // Cookie alone, without the proxy identity, authenticates nobody.
    expect((await t.call(null, 'GET', '/api/mailboxes', undefined, { cookie: `smm_demo_persona=${EDITOR_A}` })).status).toBe(401);
    expect(snapshot()).toBe(before);
  });
});

describe('canonical Host and browser origin rules', () => {
  it('requires the canonical public Host and ignores forwarded host/proto claims', async () => {
    for (const host of ['evil.example', '127.0.0.1:5178', `localhost:${TEST_PORT}`, `${PUBLIC_HOST}:443`, `${PUBLIC_HOST}.evil.example`, `${PUBLIC_HOST}:8443`]) {
      const res = await t.call(ID.editorA, 'GET', '/api/mailboxes', undefined, { host, 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-proto': 'https' });
      expect(res.status, host).toBe(421);
    }
    expect((await t.call(ID.editorA, 'GET', '/api/mailboxes', undefined, { host: PUBLIC_HOST.toUpperCase() })).status).toBe(200);
  });

  it('requires the exact public Origin and same-origin fetch metadata for every write', async () => {
    const before = snapshot();
    const bad: Record<string, string | null>[] = [
      { origin: null, 'sec-fetch-site': null },
      { origin: null },
      { origin: 'https://evil.example' },
      { origin: 'http://mail.example.invalid' },
      { origin: 'https://mail.example.invalid:8443' },
      { origin: 'null' },
      { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'none' },
    ];
    for (const headers of bad) {
      const label = JSON.stringify(headers);
      expect((await t.call(ID.editorA, 'POST', noteUrl, { body: '別オリジンのメモ' }, headers)).status, label).toBe(403);
      expect((await t.call(ID.editorA, 'PATCH', `/api/receipts/${R.supportLogin}/triage`, { expectedVersion: 1, status: 'done' }, headers)).status, label).toBe(403);
      expect((await t.call(ID.admin, 'POST', '/api/admin/sync', {}, headers)).status, label).toBe(403);
      expect((await t.call(ID.admin, 'PUT', '/api/admin/access', { userId: VIEWER_B, mailboxId: 'mbx-sales', level: 'edit', expectedVersion: 1 }, headers)).status, label).toBe(403);
    }
    expect(snapshot()).toBe(before);
  });

  it('rejects cross-site API reads but accepts same-origin and direct reads', async () => {
    expect((await t.call(ID.editorA, 'GET', '/api/mailboxes', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await t.call(ID.editorA, 'GET', '/api/mailboxes', undefined, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await t.call(ID.editorA, 'GET', '/api/mailboxes', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await t.call(ID.editorA, 'GET', '/api/mailboxes', undefined, { 'sec-fetch-site': 'same-origin', origin: PUBLIC_ORIGIN })).status).toBe(200);
    expect((await t.call(ID.editorA, 'GET', '/api/mailboxes', undefined, { 'sec-fetch-site': 'none' })).status).toBe(200);
  });
});

describe('demo controls do not exist in trusted-proxy mode', () => {
  it('answers 404 for persona, login-switch, reset and fault routes, including for the mapped administrator', async () => {
    const before = snapshot();
    const routes: [('GET' | 'POST' | 'PUT' | 'DELETE'), string, unknown?][] = [
      ['GET', '/api/personas'],
      ['POST', '/api/session', { userId: ADMIN }],
      ['DELETE', '/api/session'],
      ['GET', '/api/demo/faults'],
      ['PUT', '/api/demo/faults', { failNextRequests: 5, delayNextRequests: 0, delayMs: 0, connectorFailMailboxId: 'mbx-support' }],
      ['POST', '/api/demo/reset'],
    ];
    for (const identity of [ID.admin, ID.editorA]) {
      for (const [method, url, body] of routes) {
        const res = await t.call(identity, method, url, body);
        expect(res.status, `${identity} ${method} ${url}`).toBe(404);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    }
    expect(snapshot()).toBe(before);
    // No fault was armed: the next requests and a sync all succeed.
    expect((await t.call(ID.editorA, 'GET', '/api/mailboxes')).status).toBe(200);
    expect((await t.call(ID.admin, 'POST', '/api/admin/sync', {})).json.failed).toBe(0);
  });
});

describe('mailbox ACLs and permitted actions behind the proxy', () => {
  it('keeps mailbox, receipt and attachment isolation per mapped user', async () => {
    const mailboxes = async (identity: string) => (await t.call(identity, 'GET', '/api/mailboxes')).json.map((m: { id: string }) => m.id).sort();
    expect(await mailboxes(ID.editorA)).toEqual(['mbx-sales', 'mbx-support']);
    expect(await mailboxes(ID.viewerB)).toEqual(['mbx-billing', 'mbx-support']);
    expect(await mailboxes(ID.noAccessD)).toEqual([]);
    expect(await mailboxes(ID.admin)).toEqual([]);

    const attachment = `/api/receipts/${R.supportAttachment}/attachments/att1`;
    const download = await t.call(ID.viewerB, 'GET', attachment);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    for (const identity of [ID.editorC, ID.noAccessD, ID.admin]) {
      expect((await t.call(identity, 'GET', attachment)).status, identity).toBe(404);
      expect((await t.call(identity, 'GET', `/api/receipts/${R.supportLogin}`)).status, identity).toBe(404);
    }
    expect((await t.call(ID.editorA, 'GET', `/api/receipts/${R.billingLate}`)).status).toBe(404);
    expect((await t.call(ID.viewerB, 'POST', noteUrl, { body: '閲覧者のメモ' })).status).toBe(403);
    expect((await t.call(ID.admin, 'GET', '/api/threads')).json.total).toBe(0);
    const html = (await t.call(ID.editorA, 'GET', `/api/receipts/${R.supportHtml}`)).json;
    expect(html.sanitizedHtml).not.toMatch(/<script|onerror|onload|<form|\ssrc=|\shref=/i);
  });

  it('lets mapped users act with correct attribution', async () => {
    const patch = await t.call(ID.editorA, 'PATCH', `/api/receipts/${R.salesQuote}/triage`, { expectedVersion: 1, status: 'in_progress', assigneeId: EDITOR_A });
    expect(patch.status).toBe(200);
    expect((await t.call(ID.editorA, 'POST', `/api/receipts/${R.salesQuote}/notes`, { body: 'プロキシ経由のメモ' })).status).toBe(201);
    const view = (await t.call(ID.editorA, 'GET', `/api/receipts/${R.salesQuote}`)).json;
    expect(view.notes.at(-1)).toMatchObject({ authorName: '編集担当A', body: 'プロキシ経由のメモ' });
    expect(view.history[0]).toMatchObject({ actorName: '編集担当A' });

    const matrix = (await t.call(ID.admin, 'GET', '/api/admin/access')).json;
    const revoke = await t.call(ID.admin, 'PUT', '/api/admin/access', { userId: VIEWER_B, mailboxId: 'mbx-billing', level: 'none', expectedVersion: matrix.version });
    expect(revoke.status).toBe(200);
    expect((await t.call(ID.viewerB, 'GET', `/api/receipts/${R.billingLate}`)).status).toBe(404);
    expect((await t.call(ID.admin, 'GET', '/api/admin/audit')).json[0]).toMatchObject({ action: 'grant_changed', actorName: 'デモ管理者' });
    expect((await t.call(ID.admin, 'POST', '/api/admin/mock/release')).json).toEqual({ releasedBatch: 2 });
    expect((await t.call(ID.admin, 'POST', '/api/admin/sync', { mode: 'incremental' })).json).toMatchObject({ imported: 2, failed: 0 });
  });
});

describe('liveness check', () => {
  it('answers only a constant body, to the proxy or a local probe, and nothing else is exempt', async () => {
    for (const remote of [PROXY_IP, '127.0.0.1', '::1']) {
      const res = await t.call(null, 'GET', '/api/health', undefined, { host: 'anything.invalid' }, remote);
      expect(res.status, remote).toBe(200);
      expect(res.raw).toBe('{"ok":true}');
    }
    expect((await t.call(null, 'GET', '/api/health', undefined, {}, '10.0.0.3')).status).toBe(403);
    expect((await t.call(null, 'POST', '/api/health', {}, {}, '127.0.0.1')).status).toBe(403);
    expect((await t.call(null, 'GET', '/api/session', undefined, {}, '127.0.0.1')).status).toBe(403);
  });
});

describe('response cache policy', () => {
  it('marks authenticated API responses no-store, including percent-encoded API paths', async () => {
    for (const url of ['/api/mailboxes', '/%61pi/mailboxes', '/%61pi/session', `/%61pi/receipts/${R.supportAttachment}/attachments/att1`]) {
      const res = await t.call(ID.editorA, 'GET', url);
      expect(res.status, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
    // The encoded path reaches the same data, so it must be just as uncacheable.
    expect((await t.call(ID.editorA, 'GET', '/%61pi/mailboxes')).raw).toContain('サポート窓口');
  });

  it('never makes error responses cacheable', async () => {
    const cases: [string | null, string, string | undefined][] = [
      [ID.editorA, '/%61pi/no-such-route', undefined],
      [ID.editorA, '/no-such-page', undefined],
      [null, '/%61pi/mailboxes', undefined],
      [ID.viewerB, '/%61pi/admin/access', undefined],
      [ID.editorA, '/%61pi/mailboxes', '10.0.0.3'],
    ];
    for (const [identity, url, remote] of cases) {
      const res = await t.call(identity, 'GET', url, undefined, {}, remote);
      expect(res.status, url).toBeGreaterThanOrEqual(400);
      expect(res.headers['cache-control'], `${identity} ${url}`).toBe('no-store');
    }
  });
});

describe('real TCP sockets', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function listen(proxies: string[]): Promise<number> {
    const app = await buildApp({ store: new StateStore(await seedState(), null), listenPort: TEST_PORT, auth: proxyAuth(PROXY_MAP, proxies) });
    await app.listen({ host: '127.0.0.1', port: 0 });
    close = () => app.close();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  function rawGet(port: number, headerLines: string[]): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (data += chunk));
      socket.on('error', reject);
      socket.on('end', () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
        resolve({ status, body: data.slice(data.indexOf('\r\n\r\n') + 4) });
      });
      socket.write(['GET /api/session HTTP/1.1', ...headerLines, 'Connection: close', '', ''].join('\r\n'));
    });
  }

  it('uses the real socket address and rejects duplicate identity or Host headers', async () => {
    const port = await listen(['127.0.0.1']);
    const ok = await rawGet(port, [`Host: ${PUBLIC_HOST}`, `X-Mail-User: ${ID.editorA}`]);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain(EDITOR_A);
    const duplicateIdentity = await rawGet(port, [`Host: ${PUBLIC_HOST}`, `X-Mail-User: ${ID.editorA}`, `x-mail-user: ${ID.editorA}`]);
    expect(duplicateIdentity.status).toBe(403);
    const twoIdentities = await rawGet(port, [`Host: ${PUBLIC_HOST}`, `X-Mail-User: ${ID.viewerB}`, `X-Mail-User: ${ID.admin}`]);
    expect(twoIdentities.status).toBe(403);
    const duplicateHost = await rawGet(port, [`Host: ${PUBLIC_HOST}`, 'Host: evil.example', `X-Mail-User: ${ID.editorA}`]);
    expect([400, 421]).toContain(duplicateHost.status);
  });

  it('treats a loopback client as untrusted when only another proxy address is allowlisted', async () => {
    const port = await listen([PROXY_IP]);
    const res = await rawGet(port, [`Host: ${PUBLIC_HOST}`, `X-Mail-User: ${ID.admin}`, `X-Forwarded-For: ${PROXY_IP}`]);
    expect(res.status).toBe(403);
    expect(res.body).toContain('untrusted_proxy');
  });
});
