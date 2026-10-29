import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { RentalAccess } from '../../src/server/rental/access.js';
import { seedRentalDemo } from '../../src/server/rental/seed.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { ADMIN, EDITOR_A, seedState, TEST_HOST, TEST_PORT, VIEWER_B } from '../helpers.js';

let dir: string;
let store: RentalStore;
let common: StateStore;
let app: FastifyInstance;
let access: RentalAccess;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rental-access-'));
  store = new RentalStore(dir, { demo: true });
  seedRentalDemo(store);
  common = new StateStore(await seedState(), null);
  app = await buildApp({ store: common, listenPort: TEST_PORT, rental: { store, itemOrigin: null, webDir: null, allMembersAdmin: true } });
  access = new RentalAccess(store, true);
});
afterEach(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
const actor = { id: ADMIN, name: '試験管理者' };
async function call(url: string, user: string | null = ADMIN, body?: unknown, origin = `http://${TEST_HOST}`) {
  return app.inject({ url, method: body === undefined ? 'GET' : 'PUT', headers: {
    host: TEST_HOST, ...(user ? { cookie: `${SESSION_COOKIE}=${user}` } : {}), ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}
const setPolicy = (enabled: boolean, expectedRevision: number) => call('/api/rental/admin/access', ADMIN, { kind: 'policy', allMembersAdmin: enabled, expectedRevision });
const setPerson = (userId: string, permissions: string[], expectedRevision: number) => call('/api/rental/admin/access', ADMIN, { kind: 'account', userId, permissions, expectedRevision });

describe('rental access settings', () => {
  it('uses the existing environment default without modifying policy, grants or ledger on read', async () => {
    const before = JSON.stringify(store.db.prepare('SELECT * FROM items ORDER BY code').all());
    const grants = JSON.stringify(store.db.prepare('SELECT * FROM grants ORDER BY user_id,permission').all());
    const result = await call('/api/rental/admin/access');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ allMembersAdmin: true, revision: 0, history: [] });
    expect(result.json().people.find((p: { id: string }) => p.id === VIEWER_B)).toMatchObject({ storedPermissions: [], effectivePermissions: ['rental.issue', 'rental.loan'], effectiveAdmin: true });
    expect(store.db.prepare("SELECT * FROM config WHERE key LIKE 'rental_%'").all()).toEqual([]);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM items ORDER BY code').all())).toBe(before);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM grants ORDER BY user_id,permission').all())).toBe(grants);
  });
  it('reserves settings for common access administrators even when all members administer rental', async () => {
    expect((await call('/api/rental/admin/access', null)).statusCode).toBe(401);
    expect((await call('/api/rental/admin/access', VIEWER_B)).statusCode).toBe(403);
    expect((await call('/api/rental/admin/access', VIEWER_B, { kind: 'policy', allMembersAdmin: false, expectedRevision: 0 })).statusCode).toBe(403);
    expect((await call('/api/rental/admin/permissions', EDITOR_A)).statusCode).toBe(403);
    expect((await call(`/api/rental/admin/permissions/${VIEWER_B}`, EDITOR_A, { permissions: ['rental.admin'] })).statusCode).toBe(403);
    const member = common.current.users.find((u) => u.id === VIEWER_B)!;
    common.replace({ ...common.current, users: [...common.current.users, { ...member, id: 'disabled-admin', canManageAccess: true, disabled: true }] });
    expect((await call('/api/rental/admin/access', 'disabled-admin')).statusCode).toBe(403);
    expect((await call('/api/rental/admin/access')).json().people.some((p: { id: string }) => p.id === 'disabled-admin')).toBe(false);
  });
  it('persists policy overrides across reopening and follows them immediately without restart', async () => {
    expect((await setPolicy(false, 0)).json()).toMatchObject({ allMembersAdmin: false, revision: 1 });
    expect((await call('/api/rental/me', VIEWER_B)).json()).toMatchObject({ permissions: [], issuer_reset_allowed: false });
    expect((await call('/api/rental/issuer/state', VIEWER_B)).statusCode).toBe(403);
    expect((await call('/api/rental/admin/access')).statusCode).toBe(200);
    const second = new RentalStore(dir, { demo: true });
    try { expect(new RentalAccess(second, true).policy()).toEqual({ allMembersAdmin: false, revision: 1 }); } finally { second.close(); }
    const enabled = await setPolicy(true, 1);
    expect(enabled.json().history[0]).toMatchObject({ kind: 'policy', before: false, after: true });
    const member = common.current.users.find((u) => u.id === VIEWER_B)!;
    common.replace({ ...common.current, users: [...common.current.users, { ...member, id: 'new-member' }] });
    expect((await call('/api/rental/me', 'new-member')).json().issuer_reset_allowed).toBe(true);
  });
  it('supports all individual roles and preserves stored settings while everyone is an administrator', async () => {
    expect((await setPerson(VIEWER_B, ['rental.admin'], 0)).statusCode).toBe(200);
    expect(store.permissionsOf(VIEWER_B)).toEqual(['rental.admin', 'rental.issue', 'rental.loan']);
    expect((await setPolicy(false, 1)).statusCode).toBe(200);
    expect((await call('/api/rental/issuer/state', VIEWER_B)).json().reset_allowed).toBe(true);
    expect((await setPerson(VIEWER_B, ['rental.issue'], 2)).statusCode).toBe(200);
    expect((await call('/api/rental/issuer/state', VIEWER_B)).json().reset_allowed).toBe(false);
    expect((await setPerson(VIEWER_B, ['rental.loan'], 3)).statusCode).toBe(200);
    expect((await call('/api/rental/issuer/state', VIEWER_B)).statusCode).toBe(403);
    expect((await setPerson(VIEWER_B, ['rental.loan', 'rental.issue'], 4)).statusCode).toBe(200);
    expect((await call('/api/rental/me', VIEWER_B)).json().permissions).toEqual(['rental.issue', 'rental.loan']);
    expect((await setPerson(VIEWER_B, [], 5)).statusCode).toBe(200);
    expect(store.permissionsOf(VIEWER_B)).toEqual([]);
    const history = (await call('/api/rental/admin/access')).json().history;
    expect(history[0]).toMatchObject({ kind: 'account', after: [] });
    expect(history[0].actorName).toBe(common.current.users.find((u) => u.id === ADMIN)!.displayName);
  });
  it('rejects stale changes atomically across different connections and legacy permission APIs', async () => {
    expect((await setPerson(VIEWER_B, ['rental.loan'], 0)).statusCode).toBe(200);
    const stale = await setPolicy(false, 0);
    expect(stale.statusCode).toBe(409);
    expect(access.policy()).toEqual({ allMembersAdmin: true, revision: 1 });
    const second = new RentalStore(dir, { demo: true });
    try {
      new RentalAccess(second, true).updatePolicy(false, 1, actor);
      expect((await setPerson(VIEWER_B, [], 1)).statusCode).toBe(409);
    } finally { second.close(); }
    expect(store.permissionsOf(VIEWER_B)).toEqual(['rental.loan']);
    expect((await call(`/api/rental/admin/permissions/${VIEWER_B}`, ADMIN, { permissions: ['rental.issue'] })).statusCode).toBe(200);
    expect((await setPolicy(true, 2)).statusCode).toBe(409);
    expect(access.policy().revision).toBe(3);
  });
  it('rolls back permissions, policy and revision if writing the audit fails', async () => {
    store.db.exec("CREATE TRIGGER access_audit_failure BEFORE INSERT ON rental_access_events BEGIN SELECT RAISE(FAIL,'audit failure'); END;");
    expect((await setPolicy(false, 0)).statusCode).toBeGreaterThanOrEqual(500);
    expect(access.policy()).toEqual({ allMembersAdmin: true, revision: 0 });
    expect((await setPerson(VIEWER_B, ['rental.admin'], 0)).statusCode).toBeGreaterThanOrEqual(500);
    expect(store.permissionsOf(VIEWER_B)).toEqual([]);
    expect(store.db.prepare('SELECT * FROM rental_access_events').all()).toEqual([]);
  });
  it('refuses bad input, unavailable accounts and foreign-origin writes without changes', async () => {
    for (const body of [
      { kind: 'policy', allMembersAdmin: 'false', expectedRevision: 0 },
      { kind: 'policy', allMembersAdmin: false },
      { kind: 'account', userId: VIEWER_B, permissions: ['mail.admin'], expectedRevision: 0 },
      { kind: 'other', expectedRevision: 0 },
    ]) expect((await call('/api/rental/admin/access', ADMIN, body)).statusCode).toBe(400);
    expect((await setPerson('missing-member', ['rental.admin'], 0)).statusCode).toBe(404);
    expect((await call('/api/rental/admin/access', ADMIN, { kind: 'policy', allMembersAdmin: false, expectedRevision: 0 }, 'https://foreign.example')).statusCode).toBe(403);
    expect(access.policy().revision).toBe(0);
    expect((await call('/api/session', VIEWER_B)).json().user.canManageAccess).toBe(false);
  });
});
