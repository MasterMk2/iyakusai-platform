import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COOKIES, installAccount } from '../../src/server/account/http.js';
import { createSeedState } from '../../src/server/domain/seed.js';
import { getAttachment, getReceipt, listThreads, mailboxSummaries } from '../../src/server/domain/queries.js';
import { DomainError } from '../../src/server/domain/types.js';
import { LoginService } from '../../src/server/login/service.js';
import { EFFECTIVE_MEMBERSHIP_KIND, REFERENCE_STORE_ACK, type IdentityLink, type MembershipObservation } from '../../src/server/login/types.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture() {
  const state = await createSeedState('2026-10-01T00:00:00.000Z');
  let current = true;
  let providerFailure = false;
  let lookups = 0;
  let issuedCode = '';
  const link: IdentityLink = {
    linkId: 'synthetic-link-a', version: 1, status: 'active', email: 'editor-a@staff.invalid',
    emailVerified: true, discordUserId: '100000000000000001', memberKey: 'synthetic-member-a',
    principalId: 'u-editor-a', evidence: 'operator_attestation',
  };
  const service = new LoginService({
    groupId: 'synthetic-committee', acceptedLinkEvidence: ['operator_attestation'],
    pepper: Buffer.from('test-only-mail-pepper-not-a-production-secret-0123456789'),
    serviceLabel: 'Synthetic committee mail', stateStore: REFERENCE_STORE_ACK,
    membership: { lookup: async (groupId, memberKey): Promise<MembershipObservation> => {
      lookups += 1;
      if (providerFailure) throw new Error('synthetic provider unavailable');
      return { kind: EFFECTIVE_MEMBERSHIP_KIND, groupId, groupRevision: 'synthetic-revision-1', memberKey,
        subjectType: 'user', subjectState: 'active', resolution: 'complete', effectiveMember: current,
        provenance: ['direct'], organizationId: null, observedAt: Date.now() };
    } },
    links: { findByVerifiedEmail: async (email) => email === link.email ? link : null, getLink: async (id) => id === link.linkId ? link : null },
    principals: { getPrincipal: async (id) => ({ principalId: id, active: !state.users.find((u) => u.id === id)?.disabled }) },
    deliver: async (envelope) => { issuedCode = envelope.code; return { deliveryId: envelope.deliveryId, status: 'delivered' }; },
    audit: () => {},
  });
  const challenge = service.requestChallenge({ email: link.email, clientKey: 'synthetic-loopback-client' });
  if (!challenge.ok) throw new Error('synthetic challenge failed');
  await service.idle();
  const login = await service.verify({ challengeId: challenge.challengeId, browserSecret: challenge.browserSecret, code: issuedCode, clientKey: 'synthetic-loopback-client' });
  if (!login.ok) throw new Error('synthetic session failed');
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  const account = installAccount(app, { service, composition: 'mock', publicOrigin: null, publicHost: null, trustedProxies: new Set(), mock: null }, {
    listenPort: 17633, isAllowedLoopbackHost: (host) => host === '127.0.0.1:17633',
    lookupUser: (id) => state.users.find((u) => u.id === id),
    sessionUser: (u) => ({ id: u.id, displayName: u.displayName, roleLabel: u.roleLabel, canManageAccess: u.canManageAccess }),
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof DomainError ? (error.code === 'not_found' ? 404 : 403) : 500;
    return reply.code(status).send({ error: error instanceof DomainError ? error.code : 'internal' });
  });
  app.get('/api/fixture/mailboxes', (request, reply) => {
    const user = account.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return mailboxSummaries(state, user);
  });
  app.get('/api/fixture/search', (request, reply) => {
    const user = account.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return listThreads(state, user, { q: 'synthetic-private-body', page: 1, pageSize: 50 });
  });
  app.get<{ Params: { id: string } }>('/api/fixture/receipts/:id', (request, reply) => {
    const user = account.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return getReceipt(state, user, request.params.id);
  });
  app.get<{ Params: { id: string; attachment: string } }>('/api/fixture/receipts/:id/attachments/:attachment', (request, reply) => {
    const user = account.currentUser(request);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return getAttachment(state, user, request.params.id, request.params.attachment);
  });
  await app.ready();
  const headers = { host: '127.0.0.1:17633', cookie: `${ACCOUNT_COOKIES.session}=${login.sessionToken}` };
  const get = (url: string) => app.inject({ method: 'GET', url, headers, remoteAddress: '127.0.0.1' });
  return { state, app, get, removeMember: () => { current = false; }, failProvider: () => { providerFailure = true; }, lookups: () => lookups };
}

describe('mail reads after fresh account membership checks', () => {
  it('reads a different department mailbox after the real account boundary verifies membership', async () => {
    const f = await fixture();
    const billing = f.state.receipts.find((r) => r.mailboxId === 'mbx-billing')!;
    const response = await f.get(`/api/fixture/receipts/${billing.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().access).toBe('read');
    expect(response.json().text).toBeTruthy();
    expect((await f.get('/api/fixture/mailboxes')).json()).toHaveLength(3);
  });

  it('does not reuse membership from login or a previous read after departure', async () => {
    const f = await fixture();
    expect((await f.get('/api/fixture/mailboxes')).statusCode).toBe(200);
    const before = f.lookups();
    f.removeMember();
    expect((await f.get('/api/fixture/mailboxes')).statusCode).toBe(401);
    expect(f.lookups()).toBeGreaterThan(before);
    expect((await f.get(`/api/fixture/receipts/${f.state.receipts[0]!.id}/attachments/att1`)).statusCode).toBe(401);
  });

  it('refuses reads and attachments when the current membership provider is unavailable', async () => {
    const f = await fixture();
    f.failProvider();
    expect((await f.get('/api/fixture/mailboxes')).statusCode).toBe(401);
    expect((await f.get(`/api/fixture/receipts/${f.state.receipts[0]!.id}/attachments/att1`)).statusCode).toBe(401);
  });

  it('refuses a disabled principal despite an existing session and grant', async () => {
    const f = await fixture();
    f.state.users.find((u) => u.id === 'u-editor-a')!.disabled = true;
    expect((await f.get('/api/fixture/mailboxes')).statusCode).toBe(401);
  });

  it('does not accept forged membership or identity headers', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'GET', url: '/api/fixture/mailboxes', remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:17633', 'x-mail-user': 'u-editor-a', 'x-current-committee-member': 'true' } });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a personal delivery in an approved mailbox before detail/search/attachment responses', async () => {
    const f = await fixture();
    const r = f.state.receipts[0]!;
    const message = f.state.messages.find((m) => m.id === r.messageId)!;
    message.text = 'synthetic-private-body';
    r.delivery.deliveredTo = 'personal@staff.invalid';
    expect((await f.get(`/api/fixture/receipts/${r.id}`)).statusCode).toBe(404);
    expect((await f.get(`/api/fixture/receipts/${r.id}/attachments/att1`)).statusCode).toBe(404);
    expect((await f.get('/api/fixture/search')).json().total).toBe(0);
  });
});
