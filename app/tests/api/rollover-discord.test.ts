import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { RolloverStore } from '../../src/server/rollover/store.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { CHAIR, MEMBER, OTHER, PASSWORD, register, ROLE_GENERAL_AFFAIRS, setup } from '../discord-auth/helpers.js';

// The grant stocktaking under the Discord login, over HTTP: the stored accounts of every status reach the screen with
// their roster names (a member who left shows by name, not as a bare login ID), and someone registering now is told
// apart from someone who left. Synthetic Discord IDs, student IDs and names only.

let dir: string;
let ctx: ReturnType<typeof setup>;
let rental: RentalStore;
let rollover: RolloverStore;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rollover-discord-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: { [CHAIR]: '合成 委員長', [MEMBER]: '合成 退任者', [OTHER]: '合成 新人' } }));
  ctx = setup();
  rental = new RentalStore(path.join(dir, 'rental'));
  rollover = new RolloverStore(path.join(dir, 'rollover'));
  const mail = await seedState();
  app = await buildApp({
    store: new StateStore({ ...mail, users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), audit: ctx.audit, publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    rental: { store: rental, itemOrigin: null, webDir: null },
    rollover: { store: rollover, organizations: null },
  });
});
afterEach(async () => {
  await app.close();
  rental.close();
  rollover.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the grant stocktaking under the Discord login', () => {
  it('shows a member who left by the roster name, and someone registering now apart from them', async () => {
    const admin = await register(ctx, CHAIR, '21000001', [ROLE_GENERAL_AFFAIRS]);
    const member = await register(ctx, MEMBER, '21000002');
    ctx.host.join(OTHER);
    const { initialLoginId: pending } = await ctx.service.issueRegistration(OTHER);
    for (const id of [member.initialLoginId, pending]) rental.setPermissions(id, ['rental.loan'], { id: admin.initialLoginId, name: '合成 委員長' });
    // The member leaves the server; the next sign-in retires the account.
    ctx.host.members.delete(MEMBER);
    await expect(ctx.service.login({ loginId: '21000002', password: PASSWORD })).rejects.toThrow();

    const res = await app.inject({ method: 'GET', url: '/api/rollover/grants', headers: { host: TEST_HOST, cookie: `__Host-iy_session=${admin.sessionToken}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { holders: { id: string; name: string; status: string; attention: boolean; detail: string | null }[]; notes: string[] };
    const left = body.holders.find((h) => h.id === member.initialLoginId)!;
    expect(left).toMatchObject({ name: '合成 退任者', status: 'left', attention: true });
    expect(left.detail).toContain('最後に Discord の在籍を確かめたのは');
    expect(body.holders.find((h) => h.id === pending)).toMatchObject({ name: '合成 新人', status: 'pending', attention: false });
    // The administrator registered on the account service's clock is in, not stale; the one who left comes first.
    expect(body.holders.find((h) => h.id === admin.initialLoginId)).toMatchObject({ name: '合成 委員長', status: 'active', attention: false });
    expect(body.holders[0]!.id).toBe(member.initialLoginId);
    expect(body.notes.join('\n')).toContain('Bot のホストで確かめた結果');
    expect(body.notes.join('\n')).not.toContain('名簿のファイルが設定されていない');
  });
});
