import { dateLabel } from '../../shared/calendar.js';
import { MEMBER_STALE_DAYS } from '../../shared/rollover.js';
import type { CalendarStore } from '../calendar/store.js';
import type { DecisionsStore } from '../decisions/store.js';
import { findUser } from '../domain/access.js';
import type { StateStore } from '../domain/store.js';
import type { User } from '../domain/types.js';
import type { LineStore } from '../line/store.js';
import type { MailboxStore } from '../mailbox/store.js';
import type { OrganizationsStore } from '../organizations/store.js';
import type { RentalStore } from '../rental/store.js';
import type { TaskRuntime } from '../tasks/routes.js';
import {
  administratorSource,
  committeeLineSource,
  committeeMailSource,
  demoLineSource,
  demoMailSource,
  rentalPolicyNote,
  rentalSource,
  type GrantPeople,
  type GrantSource,
  type PersonStanding,
} from './grants.js';
import type { RolloverRuntime } from './routes.js';
import type { RolloverStore } from './store.js';

// The rollover's view of the rest of the app, put together once in buildApp: which stores this composition has (the
// committee's under the Discord login, the synthetic ones elsewhere) and who the people are.

/** One stored account as the Discord login hands it to the rollover (any status; stored data only). */
export interface StoredPerson {
  status: 'pending' | 'active' | 'retired';
  /** Last time the Bot host confirmed membership (epoch ms). */
  memberVerifiedAt: number | null;
  studentId: string | null;
  temporaryStaff: boolean;
  departments: string[];
  /** The roster name (the temporary staff name for those), or null. */
  name: string | null;
  /** The account service's clock at the read (epoch ms): memberVerifiedAt is measured against it. */
  asOf: number;
}

/** The part of the Discord login the rollover reads (stored accounts and the roster; never for authorization). */
export interface DiscordPeopleApi {
  listUsers(): User[];
  lookupUser(userId: string): User | undefined;
  storedAccount(userId: string): StoredPerson | null;
  rosterConfigured: boolean;
}

const DAY_MS = 86_400_000;
const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * People under the Discord login, by their stored account in any status. Membership is what the Bot host answered
 * when the person last signed in or used the app (memberVerifiedAt): an account whose owner left the server and
 * never came back stays active, so an old confirmation is what marks it ("stale"). A retired account is someone the
 * Bot host saw leave; a pending one is someone registering or resetting the password now (not one to look at).
 * Without a roster file nobody has a roster name, so "unknown" is not given at all then (the screen says so once).
 */
export function discordPeople(api: DiscordPeopleApi): GrantPeople {
  const standing = (userId: string): PersonStanding => {
    const a = api.storedAccount(userId);
    if (!a) return { status: 'no_account', name: null, detail: null, roleLabel: '' };
    const roleLabel = a.departments.join('・') || '委員';
    // The roster name, else the student ID (as the rest of the app shows a person), with the login ID as a clue.
    const name = a.name ?? (a.studentId ? `学籍番号 ${a.studentId}` : null);
    const detail = (...parts: (string | null)[]) => [...parts, a.name ? null : `ログイン ID ${userId}`].filter(Boolean).join('・') || null;
    if (a.temporaryStaff) return { status: a.status === 'active' ? 'active' : 'inactive', name, detail: detail(), roleLabel };
    const verified = a.memberVerifiedAt === null ? '在籍を確かめた記録なし' : `最後に Discord の在籍を確かめたのは ${dateLabel(jstDay(a.memberVerifiedAt))}`;
    if (a.status === 'retired') return { status: 'left', name, detail: detail(verified), roleLabel };
    if (a.status === 'pending') return { status: 'pending', name, detail: detail(), roleLabel };
    const days = a.memberVerifiedAt === null ? null : Math.floor((a.asOf - a.memberVerifiedAt) / DAY_MS);
    if (days === null || days > MEMBER_STALE_DAYS) return { status: 'stale', name, detail: detail(days === null ? verified : `${verified}（${days} 日前）`), roleLabel };
    if (api.rosterConfigured && a.name === null) return { status: 'unknown', name, detail: detail(), roleLabel };
    return { status: 'active', name, detail: detail(), roleLabel };
  };
  return {
    active: () => api.listUsers(),
    standing,
    nameOf: (userId) => api.storedAccount(userId)?.name ?? api.lookupUser(userId)?.displayName ?? null,
    notes: () => [
      `在籍は、その人がログインしたりアプリを使ったりしたときに Bot のホストで確かめた結果です（この画面からは問い合わせません）。最後に確かめてから ${MEMBER_STALE_DAYS} 日を過ぎた人は「しばらく在籍を確かめていない」として先に出します。`,
      ...(api.rosterConfigured ? [] : ['委員の名簿のファイルが設定されていないため、名前は学籍番号で出し、「委員の名簿に名前がない」かどうかは確かめていません。']),
    ],
  };
}

/** People of the synthetic state (the demos): a disabled persona is "inactive", one not in the state "no_account". */
export function statePeople(store: StateStore): GrantPeople {
  return {
    active: () => store.current.users.filter((u) => !u.disabled),
    standing: (userId): PersonStanding => {
      const user = findUser(store.current, userId);
      if (!user) return { status: 'no_account', name: null, detail: null, roleLabel: '' };
      return { status: user.disabled ? 'inactive' : 'active', name: user.displayName, detail: null, roleLabel: user.roleLabel };
    },
    nameOf: (userId) => findUser(store.current, userId)?.displayName ?? null,
    notes: () => [],
  };
}

export interface RolloverParts {
  store: RolloverStore;
  organizations: OrganizationsStore | null;
  calendar: CalendarStore | null;
  decisions: DecisionsStore | null;
  tasks: TaskRuntime | null;
  people: GrantPeople;
  /** The committee mailbox (Discord login), or the synthetic inbox. */
  mail: { kind: 'committee'; store: MailboxStore; mailboxes: { id: string; name: string }[] } | { kind: 'synthetic'; store: StateStore } | null;
  /** The committee's official LINE (Discord login), or the demo's synthetic LINE. */
  line: { kind: 'committee'; store: LineStore; people: () => User[] } | { kind: 'synthetic'; store: LineStore; mail: StateStore } | null;
  rental: { store: RentalStore; allMembersAdmin: boolean } | null;
}

const NOTES = [
  '会計（経費の申請・精算）の権限は、このアプリには保存されていません。共有ドライブやスプレッドシートの共有は、それぞれの共有設定で確かめてください。',
  'Discord の Bot（IyakusaiBot）で使える操作は、Discord のロールと Bot のホストの設定で決まるため、ここには出ません。',
];

export function rolloverRuntime(parts: RolloverParts): RolloverRuntime {
  const grants: GrantSource[] = [];
  if (parts.mail?.kind === 'committee') grants.push(committeeMailSource(parts.mail.store, parts.mail.mailboxes));
  else if (parts.mail?.kind === 'synthetic') grants.push(demoMailSource(parts.mail.store));
  if (parts.line?.kind === 'committee') grants.push(committeeLineSource(parts.line.store, parts.line.people));
  else if (parts.line?.kind === 'synthetic') grants.push(demoLineSource(parts.line.store, parts.line.mail));
  const rental = parts.rental;
  if (rental) grants.push(rentalSource(rental.store, rental.allMembersAdmin));
  grants.push(administratorSource(parts.people));
  return {
    store: parts.store,
    organizations: parts.organizations,
    calendar: parts.calendar,
    decisions: parts.decisions,
    tasks: parts.tasks,
    grants,
    grantNotes: () => {
      const notes = [...NOTES];
      const policy = rental ? rentalPolicyNote(rental.store, rental.allMembersAdmin) : null;
      if (policy) notes.unshift(policy);
      return notes;
    },
    people: parts.people,
  };
}
