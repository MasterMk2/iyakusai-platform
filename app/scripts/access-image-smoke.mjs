import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import Fastify from 'fastify';
import { RentalStore } from '/app/dist/server/rental/store.js';
import { RentalAccess } from '/app/dist/server/rental/access.js';
import { registerRentalRoutes } from '/app/dist/server/rental/routes.js';
const dir = mkdtempSync('/tmp/access-smoke-');
const store = new RentalStore(dir, { demo: true });
store.addItems([['IY-100001', 'Synthetic item']]);
const people = [
  { id: 'manager', displayName: 'Synthetic manager', roleLabel: 'manager', email: 'manager@example.invalid', canManageAccess: true },
  { id: 'member', displayName: 'Synthetic member', roleLabel: 'member', email: 'member@example.invalid', canManageAccess: false },
];
let user = people[0];
const app = Fastify();
await registerRentalRoutes(app, { rental: { store, itemOrigin: null, webDir: null, allMembersAdmin: true }, requireUser: () => user, lookupUser: id => people.find(p => p.id === id), listUsers: () => people });
try {
  const request = async body => app.inject({ url: '/api/rental/admin/access', method: body ? 'PUT' : 'GET', ...(body ? { payload: body } : {}) });
  assert.equal((await request()).json().allMembersAdmin, true);
  assert.equal((await request({ kind: 'account', userId: 'member', permissions: ['rental.admin'], expectedRevision: 0 })).statusCode, 200);
  assert.equal((await request({ kind: 'policy', allMembersAdmin: false, expectedRevision: 1 })).statusCode, 200);
  assert.equal((await request({ kind: 'policy', allMembersAdmin: true, expectedRevision: 1 })).statusCode, 409);
  user = people[1];
  assert.equal((await request()).statusCode, 403);
  assert.equal((await app.inject('/api/rental/me')).json().issuer_reset_allowed, true);
  user = people[0];
  assert.equal((await request()).json().history.length, 2);
  await app.close(); store.close();
  const reopened = new RentalStore(dir, { demo: true });
  assert.equal(new RentalAccess(reopened, true).policy().allMembersAdmin, false);
  reopened.close();
  console.log(JSON.stringify({ passed: true, isolatedSyntheticData: true, savedOverrideSurvivesReopen: true, scopedAdminAndAudit: true, staleChangeRejected: true }));
} finally { try { await app.close(); store.close(); } catch { /* already closed */ } }
