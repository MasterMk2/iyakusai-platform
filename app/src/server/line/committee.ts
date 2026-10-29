import { departmentsOfLabel, TEMPORARY_STAFF_DEPARTMENT, type MailAccessResponse } from '../../shared/mailbox.js';
import { DomainError, type User } from '../domain/types.js';
import { sha256 } from './normalize.js';
import type { LineOaConfig } from './oa-config.js';
import { LINE_SCHEMA_VERSION, LINE_STATE_KIND, nextLineId, type LineAccount, type LineState } from './types.js';

// The committee's official LINE account (2026-10-28): its state, kept in line.json in the mail folder, and its
// grants, managed like the committee mailbox's (the same answer shape, so the settings screen shows both alike).

/** The receiver does not export the bot's user ID: without one in line.json, a fixed stand-in binds the feed. */
const standInDestination = (accountId: string) => `U${sha256(`line-feed-destination|${accountId}`).slice(0, 32)}`;

export function committeeAccount(cfg: LineOaConfig): LineAccount {
  return {
    id: cfg.account.id,
    name: cfg.account.name,
    kind: 'official_account',
    destination: cfg.account.botUserId ?? standInDestination(cfg.account.id),
    outbound: cfg.send ? 'push' : 'disabled',
    ...(cfg.send ? { monthlyLimit: cfg.send.monthlyLimit, allowGroups: cfg.send.allowGroups } : {}),
  };
}

/**
 * The stored state with the account as line.json describes it now (name, sending, limit). A new file starts empty:
 * the feed then reads the receiver from its first record. Grants, conversations and send records are kept.
 */
export function committeeLineState(stored: LineState | null, cfg: LineOaConfig): LineState {
  const account = committeeAccount(cfg);
  const state: LineState = stored
    ? structuredClone(stored)
    : {
        kind: LINE_STATE_KIND,
        schemaVersion: LINE_SCHEMA_VERSION,
        accounts: [],
        grants: [],
        accessVersion: 1,
        conversations: [],
        messages: [],
        processedEvents: [],
        tombstones: [],
        feed: { releasedBatch: 0, cursors: {} },
        drafts: [],
        consents: [],
        outbox: [],
        audit: [],
        seq: 0,
      };
  state.committee = true;
  state.departmentGrants ??= [];
  state.accounts = [account, ...state.accounts.filter((a) => a.id !== account.id)];
  return state;
}

function people(list: User[]): User[] {
  return list.filter((p) => !departmentsOfLabel(p.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT)).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
}

function departments(list: User[]): string[] {
  const all = new Set(list.filter((p) => !p.disabled).flatMap((p) => departmentsOfLabel(p.roleLabel)));
  all.delete(TEMPORARY_STAFF_DEPARTMENT);
  return [...all].sort((a, b) => a.localeCompare(b, 'ja'));
}

function requireManager(user: User): void {
  if (!user.canManageAccess || user.disabled) throw new DomainError('forbidden', '公式LINE の権限を扱えるのは権限管理者だけです。');
}

/** Names and grants only, never conversation contents. `mailboxes` are the LINE accounts. */
export function lineCommitteeAccess(state: LineState, list: User[], user: User): MailAccessResponse {
  requireManager(user);
  const shown = people(list);
  const known = new Set(shown.map((p) => p.id));
  const accounts = state.accounts.filter((a) => a.kind === 'official_account');
  const ids = new Set(accounts.map((a) => a.id));
  const own = state.grants.filter((g) => known.has(g.userId) && ids.has(g.accountId));
  const latest = state.messages.reduce<string | null>((at, m) => (at === null || m.importedAt > at ? m.importedAt : at), null);
  return {
    people: shown.map((p) => ({ id: p.id, displayName: p.displayName, roleLabel: p.roleLabel })),
    mailboxes: accounts.map((a) => ({ id: a.id, name: a.name, address: '公式LINE' })),
    grants: own.filter((g) => g.level === 'edit').map((g) => ({ userId: g.userId, mailboxId: g.accountId })),
    sendGrants: own.filter((g) => g.reply).map((g) => ({ userId: g.userId, mailboxId: g.accountId })),
    sendable: accounts.some((a) => a.outbound !== 'disabled') ? accounts.filter((a) => a.outbound !== 'disabled').map((a) => a.id) : null,
    departments: departments(list),
    departmentGrants: (state.departmentGrants ?? []).filter((g) => ids.has(g.accountId)).map((g) => ({ department: g.department, mailboxId: g.accountId, kind: g.kind })),
    ingest: { messages: state.messages.length, latestStoredAt: latest, sources: {} },
  };
}

export interface LineGrantChange {
  userId?: string | undefined;
  department?: string | undefined;
  accountId: string;
  kind: 'edit' | 'send';
  on: boolean;
}

/** One tick of the settings screen. Granting needs a current person or department; removing is always allowed. */
export function setLineCommitteeGrant(state: LineState, list: User[], actor: User, change: LineGrantChange, now: string): MailAccessResponse {
  requireManager(actor);
  const account = state.accounts.find((a) => a.id === change.accountId && a.kind === 'official_account');
  if (!account) throw new DomainError('validation', '存在しない LINE アカウントです。');
  if (change.on && change.kind === 'send' && account.outbound === 'disabled') throw new DomainError('validation', 'このサーバーでは公式LINE の送信が設定されていないため、送信権限は付けられません。');
  const what = change.kind === 'edit' ? '編集' : '送信';
  let subject: string;
  if (change.department !== undefined) {
    const department = change.department;
    if (change.on && !departments(list).includes(department)) throw new DomainError('validation', 'この部局には今、委員がいません（Discord のロールで部局が決まります）。');
    const rest = (state.departmentGrants ?? []).filter((g) => !(g.department === department && g.accountId === account.id && g.kind === change.kind));
    state.departmentGrants = change.on ? [...rest, { department, accountId: account.id, kind: change.kind }] : rest;
    subject = `${department}（部局）`;
  } else {
    const person = list.find((p) => p.id === change.userId);
    if (change.on && (!person || person.disabled || departmentsOfLabel(person.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT))) {
      throw new DomainError('validation', 'このアカウントは見つからないか、権限を付けられない状態です。');
    }
    const userId = change.userId!;
    const before = state.grants.find((g) => g.userId === userId && g.accountId === account.id);
    const edit = change.kind === 'edit' ? change.on : before?.level === 'edit';
    const reply = change.kind === 'send' ? change.on : before?.reply === true;
    state.grants = state.grants.filter((g) => !(g.userId === userId && g.accountId === account.id));
    if (edit || reply) state.grants.push({ userId, accountId: account.id, level: edit ? 'edit' : 'read', reply });
    subject = person?.displayName ?? '（名簿にない利用者）';
  }
  state.accessVersion += 1;
  state.audit.push({ id: nextLineId(state, 'laudit'), at: now, actorId: actor.id, action: 'line_grant_changed', detail: `${subject} の「${account.name}」の${what}権限を${change.on ? '付与' : '解除'}` });
  return lineCommitteeAccess(state, list, actor);
}
