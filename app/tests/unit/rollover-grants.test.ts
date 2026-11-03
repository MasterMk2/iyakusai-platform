import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/server/domain/types.js';
import { committeeLineState } from '../../src/server/line/committee.js';
import { validateLineConfig } from '../../src/server/line/oa-config.js';
import { LineStore } from '../../src/server/line/store.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { RentalStore } from '../../src/server/rental/store.js';
import { committeeLineSource, committeeMailSource, grantInventory, planGrantRemoval, rentalPolicyNote, rentalSource, type GrantPeople } from '../../src/server/rollover/grants.js';

// The grant stocktaking over the committee's own stores (mail.sqlite3 and rental.sqlite3 in a temporary folder):
// a grant left to someone who can no longer sign in shows first, and is removed by the store's own change, which
// writes its audit row. Synthetic IDs and names only.

const NOW = '2026-11-04T03:00:00.000Z';
const ADMIN: User = { id: 'login-admin', displayName: '合成 管理者', roleLabel: '総務部', email: '', canManageAccess: true };
const MEMBER: User = { id: 'login-member', displayName: '合成 委員', roleLabel: '渉外部', email: '', canManageAccess: false };
const FORMER = 'login-former';

const people: GrantPeople = {
  active: () => [ADMIN, MEMBER],
  standing: (id) => {
    const user = [ADMIN, MEMBER].find((u) => u.id === id);
    return user ? { status: 'active', name: user.displayName, detail: null, roleLabel: user.roleLabel } : { status: 'inactive', name: null, detail: null, roleLabel: '' };
  },
  nameOf: (id) => [ADMIN, MEMBER].find((u) => u.id === id)?.displayName ?? null,
  notes: () => [],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rollover-grants-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('committee mailbox grants', () => {
  it('lists a departed person’s grants first and removes them with the inbox’s audit row', () => {
    const store = new MailboxStore(dir);
    try {
      store.setGrant(FORMER, 'mbx-info', true, ADMIN.id, NOW);
      store.setSendGrant(FORMER, 'mbx-info', true, ADMIN.id, NOW);
      store.setGrant(MEMBER.id, 'mbx-info', true, ADMIN.id, NOW);
      store.setDepartmentGrant('企画部', 'mbx-info', 'edit', true, ADMIN.id, NOW);
      const sources = [committeeMailSource(store, [{ id: 'mbx-info', name: '合成の窓口' }])];

      const inventory = grantInventory(sources, people, []);
      expect(inventory.holders.map((h) => [h.kind, h.id, h.status, h.attention])).toEqual([
        ['person', FORMER, 'inactive', true],
        ['department', '企画部', 'active', true],
        ['person', MEMBER.id, 'active', false],
      ]);
      expect(inventory.holders[0]!.name).toBe(`（名前の分からない利用者：${FORMER}）`);
      // No one signs in with 企画部 now: worth a look too.
      expect(inventory.holders[1]!.members).toBe(0);

      const keys = inventory.holders[0]!.grants.map((g) => g.key);
      const plan = planGrantRemoval(sources, people, keys);
      expect(plan.counts).toEqual({ remove: 2, gone: 0, kept: 0 });
      const auditBefore = store.audit().length;
      for (const { entry } of plan.removals) entry.revoke!(ADMIN, NOW);
      expect(store.grants().map((g) => g.user_id)).toEqual([MEMBER.id]);
      expect(store.sendGrants()).toEqual([]);
      expect(store.audit().length).toBe(auditBefore + 2);
      expect(store.audit()[0]!.actor_id).toBe(ADMIN.id);

      const again = planGrantRemoval(sources, people, keys);
      expect(again.counts).toEqual({ remove: 0, gone: 2, kept: 0 });
      expect(again.planToken).not.toBe(plan.planToken);
    } finally {
      store.close();
    }
  });
});

describe('committee official LINE grants', () => {
  it('lists a departed person’s edit and send grants by the settings screen’s names, and removes them with the LINE audit row', () => {
    const cfg = validateLineConfig(
      { version: 1, account: { id: 'oa', name: '合成 公式LINE' }, receiver: { url: 'http://receiver.example.invalid:8788' }, send: {} },
      '/unused',
      { pullToken: 'pull-token-synthetic-0001', accessToken: 'access-token-synthetic-0001' },
    );
    const line = new LineStore(committeeLineState(null, cfg), null);
    line.transact((s) => {
      s.grants.push({ userId: FORMER, accountId: 'oa', level: 'edit', reply: true }, { userId: MEMBER.id, accountId: 'oa', level: 'edit', reply: false });
      s.departmentGrants = [{ department: '企画部', accountId: 'oa', kind: 'send' }];
    });
    const sources = [committeeLineSource(line, () => [ADMIN, MEMBER])];

    const inventory = grantInventory(sources, people, []);
    const former = inventory.holders.find((h) => h.id === FORMER)!;
    expect(former).toMatchObject({ status: 'inactive', attention: true });
    expect(former.grants.map((g) => g.permission)).toEqual(['編集（内部メモ）', '送信']);
    expect(inventory.holders.find((h) => h.id === '企画部')!.grants.map((g) => g.permission)).toEqual(['送信（部局）']);

    const plan = planGrantRemoval(sources, people, former.grants.map((g) => g.key));
    expect(plan.counts).toEqual({ remove: 2, gone: 0, kept: 0 });
    const auditBefore = line.current.audit.length;
    for (const { entry } of plan.removals) entry.revoke!(ADMIN, NOW);
    expect(line.current.grants).toEqual([{ userId: MEMBER.id, accountId: 'oa', level: 'edit', reply: false }]);
    expect(line.current.audit.slice(auditBefore).map((a) => [a.actorId, a.action])).toEqual([
      [ADMIN.id, 'line_grant_changed'],
      [ADMIN.id, 'line_grant_changed'],
    ]);
    expect(planGrantRemoval(sources, people, former.grants.map((g) => g.key)).counts).toEqual({ remove: 0, gone: 2, kept: 0 });
  });
});

describe('rental grants', () => {
  it('names the screen and the switch of the everyone setting as the settings screen does', () => {
    const store = new RentalStore(dir, { demo: true });
    try {
      expect(rentalPolicyNote(store, true)).toBe('物品は、設定の「物品の権限」の「全員設定」がオンのため、委員全員が物品管理者です。外すときは、設定の「物品の権限」の「全員設定」で切り替えます。');
      expect(rentalPolicyNote(store, false)).toBeNull();
    } finally {
      store.close();
    }
  });

  it('removes a person’s rental permissions with the rental change record', () => {
    const store = new RentalStore(dir, { demo: true });
    try {
      store.setPermissions(FORMER, ['rental.loan'], { id: ADMIN.id, name: ADMIN.displayName });
      const sources = [rentalSource(store, false)];
      const [holder] = grantInventory(sources, people, []).holders;
      expect(holder).toMatchObject({ id: FORMER, status: 'inactive', grants: [expect.objectContaining({ permission: '貸出・返却', removable: true })] });
      const before = Number((store.db.prepare('SELECT count(*) AS n FROM rental_access_events').get() as { n: number }).n);
      planGrantRemoval(sources, people, [holder!.grants[0]!.key]).removals[0]!.entry.revoke!(ADMIN, NOW);
      expect(store.permissionsOf(FORMER)).toEqual([]);
      expect(Number((store.db.prepare('SELECT count(*) AS n FROM rental_access_events').get() as { n: number }).n)).toBe(before + 1);
    } finally {
      store.close();
    }
  });
});
