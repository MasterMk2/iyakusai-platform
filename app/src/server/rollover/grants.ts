import { createHash } from 'node:crypto';
import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import { HOLDER_ATTENTION, type GrantHolderView, type GrantPlanItem, type GrantsResponse, type HolderStatus } from '../../shared/rollover.js';
import { setGrant as setDemoMailGrant } from '../domain/admin.js';
import type { StateStore } from '../domain/store.js';
import type { User } from '../domain/types.js';
import { setLineCommitteeGrant } from '../line/committee.js';
import type { LineStore } from '../line/store.js';
import { setLineGrant } from '../line/triage.js';
import { approvalRequired, departmentReviewGrants, reviewGrants, setApprovalRequired, setDepartmentReviewGrant, setReviewGrant } from '../mailbox/approval-store.js';
import type { MailboxStore } from '../mailbox/store.js';
import { RentalAccess } from '../rental/access.js';
import type { RentalPermission, RentalStore } from '../rental/store.js';

// Step 4: every grant this app stores, by the person (or department) holding it, read from the stores themselves.
// The settings screens of each permission list only the people who can sign in now, so a grant left to someone who
// has gone shows nowhere else; here it shows first. Removing one goes through the same write as those screens (the
// store's own change with its audit row), with the administrator as the actor. Nothing here asks the Bot host or
// Discord: the flags come from the stored accounts (with the time membership was last confirmed) and the roster.
// The permission names follow the settings screens (受信箱・公式LINE の「編集」「送信」, 物品の権限).

export interface GrantEntry {
  key: string;
  holder: { kind: 'person'; id: string } | { kind: 'department'; name: string };
  sourceLabel: string;
  target: string;
  permission: string;
  /** Null: cannot be removed here (the reason says where it is decided). */
  revoke: ((actor: User, now: string) => void) | null;
  reason: string | null;
}

export interface GrantSource {
  label: string;
  entries(): GrantEntry[];
}

/** How one person stands, for the stocktaking. */
export interface PersonStanding {
  status: HolderStatus;
  /** A name for the screen, or null when the stores do not know one. */
  name: string | null;
  /** A clue for the screen (when membership was last confirmed, the student ID), or null. */
  detail: string | null;
  roleLabel: string;
}

export interface GrantPeople {
  /** The people who can sign in now. */
  active(): User[];
  /** How a person stands (any account status), with a name and a clue. */
  standing(userId: string): PersonStanding;
  /** A name for the screen, or null when the stores do not know one. */
  nameOf(userId: string): string | null;
  /** Said once on the grants screen about how the people were checked. */
  notes(): string[];
}

const MAIL = 'メールの受信箱';
const LINE = '公式LINE';
const RENTAL = '物品貸出';
const ADMIN = '権限の管理者';

const userKey = (id: string) => `p:${id}`;
/** The synthetic inbox's own change refuses a person it does not know, so such a grant is listed but kept. */
const NOT_IN_STATE = '合成データの利用者の一覧にない人の権限は、この画面では外せません';
const deptKey = (name: string) => `d:${encodeURIComponent(name)}`;

/** The committee mailbox (Discord login): edit, send and department grants in mail.sqlite3. */
export function committeeMailSource(store: MailboxStore, mailboxes: { id: string; name: string }[]): GrantSource {
  const name = (id: string) => mailboxes.find((m) => m.id === id)?.name ?? id;
  return {
    label: MAIL,
    entries: () => [
      ...store.grants().map((g) => ({
        key: `mail|edit|${userKey(g.user_id)}|${g.mailbox_id}`,
        holder: { kind: 'person' as const, id: g.user_id },
        sourceLabel: MAIL,
        target: name(g.mailbox_id),
        permission: '編集（内部メモ）',
        reason: null,
        revoke: (actor: User, now: string) => store.setGrant(g.user_id, g.mailbox_id, false, actor.id, now),
      })),
      ...store.sendGrants().map((g) => ({
        key: `mail|send|${userKey(g.user_id)}|${g.mailbox_id}`,
        holder: { kind: 'person' as const, id: g.user_id },
        sourceLabel: MAIL,
        target: name(g.mailbox_id),
        permission: '送信',
        reason: null,
        revoke: (actor: User, now: string) => store.setSendGrant(g.user_id, g.mailbox_id, false, actor.id, now),
      })),
      ...store.departmentGrants().map((g) => ({
        key: `mail|${g.kind}|${deptKey(g.department)}|${g.mailbox_id}`,
        holder: { kind: 'department' as const, name: g.department },
        sourceLabel: MAIL,
        target: name(g.mailbox_id),
        permission: g.kind === 'send' ? '送信（部局）' : '編集（内部メモ・部局）',
        reason: null,
        revoke: (actor: User, now: string) => store.setDepartmentGrant(g.department, g.mailbox_id, g.kind, false, actor.id, now),
      })),
      // Approval before sending (2026-11-11): the review grants, and the people marked 承認必須 (a restriction, listed so
      // that it does not stay on someone's account unseen).
      ...reviewGrants(store).map((g) => ({
        key: `mail|review|${userKey(g.user_id)}|${g.mailbox_id}`,
        holder: { kind: 'person' as const, id: g.user_id },
        sourceLabel: MAIL,
        target: name(g.mailbox_id),
        permission: '校閲（承認・差し戻し）',
        reason: null,
        revoke: (actor: User, now: string) => setReviewGrant(store, g.user_id, g.mailbox_id, false, actor.id, now),
      })),
      ...departmentReviewGrants(store).map((g) => ({
        key: `mail|review|${deptKey(g.department)}|${g.mailbox_id}`,
        holder: { kind: 'department' as const, name: g.department },
        sourceLabel: MAIL,
        target: name(g.mailbox_id),
        permission: '校閲（承認・差し戻し・部局）',
        reason: null,
        revoke: (actor: User, now: string) => setDepartmentReviewGrant(store, g.department, g.mailbox_id, false, actor.id, now),
      })),
      ...approvalRequired(store).map((g) => ({
        key: `mail|approval|${userKey(g.user_id)}|${g.mailbox_id}`,
        holder: { kind: 'person' as const, id: g.user_id },
        sourceLabel: MAIL,
        target: name(g.mailbox_id),
        permission: '承認必須（送信の前に校閲者の承認）',
        reason: null,
        revoke: (actor: User, now: string) => setApprovalRequired(store, g.user_id, g.mailbox_id, false, actor.id, now),
      })),
    ],
  };
}

/** The committee's official LINE account (Discord login): the grants in its state file, changed as the settings screen does. */
export function committeeLineSource(line: LineStore, people: () => User[]): GrantSource {
  return {
    label: LINE,
    entries: () => {
      const state = line.current;
      const accounts = state.accounts.filter((a) => a.kind === 'official_account');
      const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
      const ids = new Set(accounts.map((a) => a.id));
      const change = (c: { userId?: string; department?: string; accountId: string; kind: 'edit' | 'send' }) => (actor: User, now: string) =>
        void line.transact((s) => setLineCommitteeGrant(s, people(), actor, { ...c, on: false }, now));
      const out: GrantEntry[] = [];
      for (const g of state.grants.filter((x) => ids.has(x.accountId))) {
        if (g.level === 'edit') out.push({ key: `line|edit|${userKey(g.userId)}|${g.accountId}`, holder: { kind: 'person', id: g.userId }, sourceLabel: LINE, target: name(g.accountId), permission: '編集（内部メモ）', reason: null, revoke: change({ userId: g.userId, accountId: g.accountId, kind: 'edit' }) });
        if (g.reply) out.push({ key: `line|send|${userKey(g.userId)}|${g.accountId}`, holder: { kind: 'person', id: g.userId }, sourceLabel: LINE, target: name(g.accountId), permission: '送信', reason: null, revoke: change({ userId: g.userId, accountId: g.accountId, kind: 'send' }) });
      }
      for (const g of (state.departmentGrants ?? []).filter((x) => ids.has(x.accountId))) {
        out.push({ key: `line|${g.kind}|${deptKey(g.department)}|${g.accountId}`, holder: { kind: 'department', name: g.department }, sourceLabel: LINE, target: name(g.accountId), permission: g.kind === 'send' ? '送信（部局）' : '編集（内部メモ・部局）', reason: null, revoke: change({ department: g.department, accountId: g.accountId, kind: g.kind }) });
      }
      return out;
    },
  };
}

/** The synthetic inbox of the demo and the integrated demo: read and edit grants per mailbox. */
export function demoMailSource(store: StateStore): GrantSource {
  return {
    label: MAIL,
    entries: () => {
      const state = store.current;
      const name = (id: string) => state.mailboxes.find((m) => m.id === id)?.name ?? id;
      return state.grants.map((g) => {
        const known = state.users.some((u) => u.id === g.userId);
        return {
          key: `mail|${g.level}|${userKey(g.userId)}|${g.mailboxId}`,
          holder: { kind: 'person' as const, id: g.userId },
          sourceLabel: MAIL,
          target: name(g.mailboxId),
          permission: g.level === 'edit' ? '編集' : '閲覧',
          reason: known ? null : NOT_IN_STATE,
          revoke: known ? (actor: User, now: string) => void store.transact((s) => setDemoMailGrant(s, actor, { userId: g.userId, mailboxId: g.mailboxId, level: 'none', expectedVersion: s.accessVersion }, now)) : null,
        };
      });
    },
  };
}

/** The demo's synthetic LINE accounts: read, edit and reply per account. */
export function demoLineSource(line: LineStore, mail: StateStore): GrantSource {
  return {
    label: LINE,
    entries: () => {
      const state = line.current;
      const name = (id: string) => state.accounts.find((a) => a.id === id)?.name ?? id;
      return state.grants.map((g) => {
        const known = mail.current.users.some((u) => u.id === g.userId);
        return {
          key: `line|${g.level}${g.reply ? '+reply' : ''}|${userKey(g.userId)}|${g.accountId}`,
          holder: { kind: 'person' as const, id: g.userId },
          sourceLabel: LINE,
          target: name(g.accountId),
          permission: `${g.level === 'edit' ? '編集' : '閲覧'}${g.reply ? '・返信' : ''}`,
          reason: known ? null : NOT_IN_STATE,
          revoke: known
            ? (actor: User, now: string) => void line.transact((s) => setLineGrant(s, mail.current, actor, { userId: g.userId, accountId: g.accountId, level: 'none', reply: false, expectedVersion: s.accessVersion }, now))
            : null,
        };
      });
    },
  };
}

const RENTAL_LABEL = (permissions: RentalPermission[]): string =>
  permissions.includes('rental.admin') ? '物品管理者' : permissions.includes('rental.loan') && permissions.includes('rental.issue') ? '貸出・返却・発行' : permissions.includes('rental.loan') ? '貸出・返却' : '発行・台帳変更';

/** Rental permissions in rental.sqlite3, removed as the rental permissions screen does (with its change record). */
export function rentalSource(store: RentalStore, allMembersAdmin: boolean): GrantSource {
  const access = new RentalAccess(store, allMembersAdmin);
  return {
    label: RENTAL,
    entries: () =>
      store
        .listPermissions()
        .filter((p) => p.permissions.length > 0)
        .map((p) => ({
          key: `rental|all|${userKey(p.userId)}|rental`,
          holder: { kind: 'person' as const, id: p.userId },
          sourceLabel: RENTAL,
          target: '物品貸出',
          permission: RENTAL_LABEL(p.permissions),
          reason: null,
          revoke: (actor: User) => access.updateAccount(p.userId, [], access.policy().revision, { id: actor.id, name: actor.displayName }),
        })),
  };
}

/** The note for rental when every member is a rental administrator by the setting (not a grant of anyone). */
export function rentalPolicyNote(store: RentalStore, allMembersAdmin: boolean): string | null {
  return new RentalAccess(store, allMembersAdmin).policy().allMembersAdmin ? '物品は、設定の「物品の権限」の「全員設定」がオンのため、委員全員が物品管理者です。外すときは、設定の「物品の権限」の「全員設定」で切り替えます。' : null;
}

/** The access administrators: decided by the Discord roles and the operator's settings, so listed but not removable here. */
export function administratorSource(people: GrantPeople): GrantSource {
  return {
    label: ADMIN,
    entries: () =>
      people
        .active()
        .filter((u) => u.canManageAccess)
        .map((u) => ({
          key: `admin|all|${userKey(u.id)}|app`,
          holder: { kind: 'person' as const, id: u.id },
          sourceLabel: ADMIN,
          target: 'このアプリ全体',
          permission: '権限の管理者',
          reason: 'Discord のロールと運用者の設定で決まります（この画面では外せません）',
          revoke: null,
        })),
  };
}

export function allEntries(sources: GrantSource[]): GrantEntry[] {
  return sources.flatMap((s) => s.entries());
}

/** The screen's name of a person the stores know no name of (the standing's detail adds what else is known). */
export const unnamed = (personId: string) => `（名前の分からない利用者：${personId}）`;

/** Holders with their grants; people to look at (gone, stale, not on the roster, an empty department) first. */
export function grantInventory(sources: GrantSource[], people: GrantPeople, notes: string[]): GrantsResponse {
  const entries = allEntries(sources);
  const active = people.active();
  const holders = new Map<string, GrantHolderView>();
  for (const entry of entries) {
    const id = entry.holder.kind === 'person' ? userKey(entry.holder.id) : deptKey(entry.holder.name);
    let holder = holders.get(id);
    if (!holder) {
      if (entry.holder.kind === 'person') {
        const personId = entry.holder.id;
        const s = people.standing(personId);
        holder = { kind: 'person', id: personId, name: s.name ?? unnamed(personId), roleLabel: s.roleLabel, status: s.status, detail: s.detail, members: null, attention: HOLDER_ATTENTION[s.status], grants: [] };
      } else {
        const name = entry.holder.name;
        const members = active.filter((u) => departmentsOfLabel(u.roleLabel).includes(name) && !departmentsOfLabel(u.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT)).length;
        holder = { kind: 'department', id: name, name, roleLabel: '部局', status: 'active', detail: null, members, attention: members === 0, grants: [] };
      }
      holders.set(id, holder);
    }
    holder.grants.push({ key: entry.key, sourceLabel: entry.sourceLabel, target: entry.target, permission: entry.permission, removable: entry.revoke !== null, reason: entry.reason });
  }
  const list = [...holders.values()].sort((a, b) => Number(b.attention) - Number(a.attention) || Number(a.kind === 'department') - Number(b.kind === 'department') || a.name.localeCompare(b.name, 'ja'));
  return {
    holders: list,
    sources: [...new Set(sources.map((s) => s.label))],
    notes: [...people.notes(), ...notes],
    counts: { holders: list.length, attention: list.filter((h) => h.attention).length, grants: entries.length },
  };
}

export interface GrantPlan {
  items: GrantPlanItem[];
  removals: { item: GrantPlanItem; entry: GrantEntry }[];
  counts: { remove: number; gone: number; kept: number };
  planToken: string;
}

/** What removing the chosen grants would do now: gone ones (removed meanwhile) and fixed ones are listed, not removed. */
export function planGrantRemoval(sources: GrantSource[], people: GrantPeople, keys: string[]): GrantPlan {
  const entries = new Map(allEntries(sources).map((e) => [e.key, e]));
  const items: GrantPlanItem[] = [];
  const removals: GrantPlan['removals'] = [];
  for (const key of [...new Set(keys)].sort()) {
    const entry = entries.get(key);
    if (!entry) {
      items.push({ key, holderName: '', sourceLabel: '', target: '', permission: '', action: 'gone', reason: 'すでに外れています' });
      continue;
    }
    const holderName = entry.holder.kind === 'person' ? (people.standing(entry.holder.id).name ?? unnamed(entry.holder.id)) : `${entry.holder.name}（部局）`;
    const base = { key, holderName, sourceLabel: entry.sourceLabel, target: entry.target, permission: entry.permission };
    if (!entry.revoke) {
      items.push({ ...base, action: 'kept', reason: entry.reason });
      continue;
    }
    const item: GrantPlanItem = { ...base, action: 'remove', reason: null };
    items.push(item);
    removals.push({ item, entry });
  }
  const counts = { remove: 0, gone: 0, kept: 0 };
  for (const item of items) counts[item.action] += 1;
  const planToken = createHash('sha256').update(JSON.stringify(items.map((i) => [i.key, i.action]))).digest('base64url').slice(0, 32);
  return { items, removals, counts, planToken };
}
