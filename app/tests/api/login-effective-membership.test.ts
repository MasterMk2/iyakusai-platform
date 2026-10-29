import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_USERS } from '../../src/server/connector/fixtures.js';
import { LINE_SHOP } from '../../src/server/line/fixtures.js';
import { buildLoginHarness, CSRF_HEADER, LOGIN_COOKIE, LOGIN_SESSION_COOKIE } from '../../src/server/login/http.js';
import type { SessionUser } from '../../src/shared/api.js';
import { R } from '../helpers.js';
import { CONV, makeLineApp, type LineTestApp } from '../line-helpers.js';
import { allUsersOf, FakeClock, FakeDirectory, LOGIN_GROUP, LOGIN_HOST, LOGIN_ORG, LOGIN_ORIGIN, makeLogin, P, SyntheticGroupGraph, type LoginFixture, type Persona } from '../login-fixtures.js';

// Login eligibility (effective Group membership) and content access are separate. The login core is
// unwired, so these tests take the principal ID only from the harness session and present it to the
// existing app's mailbox/LINE ACL through its demo session cookie, standing in for future wiring.

const present = (principalId: string): SessionUser | null => {
  const u = SAMPLE_USERS.find((x) => x.id === principalId && !x.disabled);
  return u ? { id: u.id, displayName: u.displayName, roleLabel: u.roleLabel, canManageAccess: u.canManageAccess } : null;
};

const SUB = 'grp-mock-committee-sub';
const GUESTS = 'grp-mock-guests';

let f: LoginFixture;
let graph: SyntheticGroupGraph;
let harness: FastifyInstance;
let content: LineTestApp;

beforeEach(async () => {
  const clock = new FakeClock();
  const dir = new FakeDirectory(clock);
  dir.enrol(P.noAccessD);
  dir.enrol(P.externalC);
  graph = new SyntheticGroupGraph(clock);
  for (const p of Object.values(P)) graph.user(p.memberKey);
  graph.user(P.externalC.memberKey, 'org-partner-0009');
  // Two-level nesting for the no-access user and the external guest; everyone in the organization via all-users.
  graph.group(LOGIN_GROUP, [SUB, allUsersOf(LOGIN_ORG)]).group(SUB, [P.noAccessD.memberKey, GUESTS]).group(GUESTS, [P.externalC.memberKey]);
  f = makeLogin({}, { membership: graph }, { clock, dir });
  harness = await buildLoginHarness({ service: f.service, publicOrigin: LOGIN_ORIGIN, clientKey: (request) => request.raw.socket.remoteAddress ?? null, presentPrincipal: present });
  content = await makeLineApp();
});

async function post(url: string, body: unknown, cookie?: string) {
  return harness.inject({
    method: 'POST',
    url,
    remoteAddress: '192.0.2.10',
    headers: { host: LOGIN_HOST, origin: LOGIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: '1', ...(cookie ? { cookie } : {}) },
    payload: body as object,
  });
}

async function sessionUser(token: string): Promise<{ status: number; user: SessionUser | undefined }> {
  const res = await harness.inject({ method: 'GET', url: '/api/login/session', headers: { host: LOGIN_HOST, cookie: `${LOGIN_SESSION_COOKIE}=${token}` } });
  return { status: res.statusCode, user: res.statusCode === 200 ? (res.json() as { user: SessionUser }).user : undefined };
}

/** Full harness login; returns the session token and the principal the server presents for it. */
async function signIn(who: Persona): Promise<{ token: string; user: SessionUser }> {
  const challenge = await post('/api/login/challenge', { email: who.email });
  await f.service.idle();
  const secret = challenge.cookies.find((c) => c.name === LOGIN_COOKIE)?.value ?? '';
  const code = f.sent.at(-1)?.recipient.discordUserId === who.discordUserId ? f.sent.at(-1)!.code : '';
  const verify = await post('/api/login/verify', { challengeId: challenge.json().challengeId, code }, `${LOGIN_COOKIE}=${secret}`);
  expect(verify.statusCode, who.email).toBe(200);
  const token = verify.cookies.find((c) => c.name === LOGIN_SESSION_COOKIE)?.value ?? '';
  const { user } = await sessionUser(token);
  return { token, user: user! };
}

describe('effective-membership login does not widen content access', () => {
  it('a two-level nested member without grants sees, counts, searches and changes nothing', async () => {
    const { user } = await signIn(P.noAccessD);
    expect(user).toMatchObject({ id: P.noAccessD.principalId, canManageAccess: false });
    const id = user.id;
    expect((await content.call(id, 'GET', '/api/inbox?pageSize=50')).json).toMatchObject({ total: 0, items: [], counts: { email: 0, line: 0 } });
    expect((await content.call(id, 'GET', `/api/inbox?q=${encodeURIComponent('契約')}`)).json).toMatchObject({ total: 0, counts: { email: 0, line: 0 } });
    expect((await content.call(id, 'GET', '/api/mailboxes')).json).toEqual([]);
    expect((await content.call(id, 'GET', '/api/inbox/labels')).json).toEqual([]);
    for (const receipt of [R.supportLogin, R.salesQuote, R.billingInvoice]) {
      expect((await content.call(id, 'GET', `/api/receipts/${receipt}`)).status, receipt).toBe(404);
      expect((await content.call(id, 'PATCH', `/api/receipts/${receipt}/triage`, { expectedVersion: 1, status: 'done' })).status, receipt).toBe(404);
      expect((await content.call(id, 'POST', `/api/receipts/${receipt}/notes`, { body: '資格だけのメモ' })).status, receipt).toBe(404);
    }
    expect((await content.call(id, 'GET', `/api/line/conversations/${CONV.l1}`)).status).toBe(404);
    expect((await content.call(id, 'POST', `/api/line/conversations/${CONV.l1}/notes`, { body: 'x' })).status).toBe(404);
    expect((await content.call(id, 'GET', '/api/admin/access')).status).toBe(403);
  });

  it('an organization member keeps only their own read-only mailbox and LINE grants', async () => {
    const { user } = await signIn(P.viewerB);
    const id = user.id;
    const inbox = await content.call(id, 'GET', '/api/inbox?source=email&pageSize=50');
    expect(new Set(inbox.json.items.map((i: { mailbox: { id: string } }) => i.mailbox.id))).toEqual(new Set(['mbx-support', 'mbx-billing']));
    expect((await content.call(id, 'GET', `/api/receipts/${R.salesQuote}`)).status).toBe(404);
    expect((await content.call(id, 'GET', `/api/receipts/${R.supportLogin}`)).status).toBe(200);
    expect((await content.call(id, 'PATCH', `/api/receipts/${R.supportLogin}/triage`, { expectedVersion: 1, status: 'done' })).status).toBe(403);
    expect((await content.call(id, 'GET', `/api/inbox?lineAccountId=${LINE_SHOP}`)).status).toBe(404);
    expect((await content.call(id, 'GET', `/api/inbox?q=${encodeURIComponent('店舗限定キーワード')}`)).json).toMatchObject({ total: 0, counts: { email: 0, line: 0 } });
    expect((await content.call(id, 'GET', `/api/line/conversations/${CONV.shopL1}`)).status).toBe(404);
    expect((await content.call(id, 'POST', `/api/line/conversations/${CONV.l1}/notes`, { body: '閲覧者のメモ' })).status).toBe(403);
    expect((await content.call(id, 'GET', '/api/admin/access')).status).toBe(403);
  });

  it('an administrator admitted through the organization manages access but reads no content', async () => {
    const { user } = await signIn(P.admin);
    expect(user.canManageAccess).toBe(true);
    const id = user.id;
    expect((await content.call(id, 'GET', '/api/admin/access')).status).toBe(200);
    expect((await content.call(id, 'GET', '/api/inbox?pageSize=50')).json).toMatchObject({ total: 0, counts: { email: 0, line: 0 } });
    expect((await content.call(id, 'GET', `/api/receipts/${R.supportLogin}`)).status).toBe(404);
    expect((await content.call(id, 'GET', `/api/line/conversations/${CONV.l1}`)).status).toBe(404);
  });

  it('a nested external member is assessed like anyone else and keeps the principal ACL', async () => {
    const { user } = await signIn(P.externalC);
    expect(user).toMatchObject({ id: P.externalC.principalId, canManageAccess: false });
    const id = user.id;
    expect((await content.call(id, 'GET', `/api/receipts/${R.supportLogin}`)).status).toBe(404);
    expect((await content.call(id, 'GET', `/api/receipts/${R.salesQuote}`)).status).toBe(200);
    expect((await content.call(id, 'PATCH', `/api/receipts/${R.salesQuote}/triage`, { expectedVersion: 1, status: 'done' })).status).toBe(403);
    expect((await content.call(id, 'GET', '/api/admin/access')).status).toBe(403);
  });

  it('losing every effective path ends the session, so no principal reaches the inbox; a remaining path keeps it', async () => {
    const both = await signIn(P.noAccessD);
    const org = await signIn(P.viewerB);
    const guest = await signIn(P.externalC);
    // Leaving the sub-group still leaves the organization path: effective membership is unchanged.
    graph.group(SUB, [GUESTS]);
    expect((await sessionUser(both.token)).status).toBe(200);
    // Removing the all-users entry ends both organization-only sessions; the nested guest is unaffected.
    graph.group(LOGIN_GROUP, [SUB]);
    expect((await sessionUser(both.token)).status).toBe(401);
    expect((await sessionUser(org.token)).status).toBe(401);
    expect((await sessionUser(guest.token)).status).toBe(200);
    graph.group(GUESTS, []);
    expect((await sessionUser(guest.token)).status).toBe(401);
  });

  it('ignores browser-supplied provenance, organization or nesting claims', async () => {
    for (const extra of [{ provenance: 'organization' }, { organizationId: LOGIN_ORG }, { nested: true }, { groupId: LOGIN_GROUP }]) {
      const res = await post('/api/login/challenge', { email: 'outsider@partner.example', ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    await f.service.idle();
    expect(f.sent).toHaveLength(0);
  });
});
