import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { compareDepartments } from '../../shared/departments.js';
import {
  VAULT_ENTRY_ID,
  VAULT_LIMITS,
  VAULT_REAUTH_REQUIRED,
  VAULT_ROLES,
  VAULT_SECRET_KEYS,
  VAULT_SECTION_ID,
  VAULT_TOKEN,
  vaultRoleRank,
  type VaultEntriesResponse,
  type VaultEntryItem,
  type VaultEntryResponse,
  type VaultEventItem,
  type VaultEventsResponse,
  type VaultMembersResponse,
  type VaultMetaResponse,
  type VaultPrintResponse,
  type VaultRevealResponse,
  type VaultRole,
  type VaultSecret,
  type VaultSectionSummary,
  type VaultSectionsResponse,
} from '../../shared/vault.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import { VaultUnreadable, type VaultCipher } from './cipher.js';
import { VaultStore, type EntryRow, type MemberRow, type SectionRow, type VaultRefusal } from './store.js';

// パスワード帳 over HTTP (2026-11-23). Committee members only (temporary staff never; their allowed routes are a list
// that does not name these). Then:
// - a section is opened by the departments and the members named on it, each with 見る / 編集する / 管理する;
// - access administrators make, rename and remove sections and set who opens them, but read no values unless they
//   are on the section themselves (adding themselves is recorded like any other change);
// - every route that reads or changes entries, prints, or changes who opens a section needs the password typed on this
//   device within `revealMinutes` (401 vault_reauth_required; the screen asks for it and calls /api/auth/reauth);
// - lists carry names, addresses and IDs only. A password or a note leaves the server one at a time (reveal) or in a
//   section's print, and is recorded before it does. No value is logged; the answers are no-store (http/app.ts).
// A section or an entry the person may not open answers 404, as if it did not exist.

export interface VaultRuntime {
  store: VaultStore;
  cipher: VaultCipher;
  revealMinutes: number;
}

export interface VaultViewer {
  user: User;
  /** Department names from the person's roles. */
  departments: string[];
  /** When the password was last typed on this device (epoch ms; 0 for a card sign-in). */
  passwordAt: number;
}

export interface VaultRouteDeps {
  /** The signed-in committee member, or null for a person who may not use the password book. Throws when nobody is signed in. */
  viewer: (request: FastifyRequest) => VaultViewer | null;
  /** The committee members who could be named on a section (no temporary staff, no disabled accounts). */
  members: () => { id: string; name: string; departments: string[] }[];
  /** The roster name of an account, or a placeholder (never an ID). */
  nameOf: (userId: string) => string;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BODY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const line = (max: number) => z.string().max(max).refine((s) => !CONTROL_LINE.test(s), { message: '1行で、使えない文字を入れないでください。' });
const body = (max: number) => z.string().max(max).refine((s) => !CONTROL_BODY.test(s), { message: '使えない文字が入っています。' });

const sectionParams = z.strictObject({ sectionId: z.string().regex(VAULT_SECTION_ID) });
const entryParams = z.strictObject({ entryId: z.string().regex(VAULT_ENTRY_ID) });
const versionQuery = z.strictObject({ expectedVersion: z.coerce.number().int().min(1) });
const sectionBody = z.strictObject({ name: line(VAULT_LIMITS.sectionName), note: body(VAULT_LIMITS.sectionNote) });
const sectionUpdateBody = z.strictObject({ name: line(VAULT_LIMITS.sectionName), note: body(VAULT_LIMITS.sectionNote), expectedVersion: z.number().int().min(1) });
const memberBody = z.strictObject({
  kind: z.enum(['user', 'department']),
  target: line(100).refine((s) => s.trim() !== '', { message: '相手を選んでください。' }),
  role: z.enum(VAULT_ROLES).nullable(),
  expectedVersion: z.number().int().min(1),
});
const plainShape = {
  sectionId: z.string().regex(VAULT_SECTION_ID),
  name: line(VAULT_LIMITS.entryName),
  url: line(VAULT_LIMITS.url),
  username: line(VAULT_LIMITS.username),
};
const createBody = z.strictObject({ ...plainShape, password: line(VAULT_LIMITS.password), notes: body(VAULT_LIMITS.notes), clientToken: z.string().regex(VAULT_TOKEN) });
// null leaves the password or the note as it is (the edit form does not have to reveal them first).
const updateBody = z.strictObject({ ...plainShape, password: line(VAULT_LIMITS.password).nullable(), notes: body(VAULT_LIMITS.notes).nullable(), expectedVersion: z.number().int().min(1) });
const entriesQuery = z.strictObject({ sectionId: z.string().regex(VAULT_SECTION_ID).optional() });
const revealBody = z.strictObject({ field: z.enum(['password', 'notes']), purpose: z.enum(['show', 'copy', 'edit']) });
const eventsQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(VAULT_LIMITS.events).default(50) });

const REFUSED: Record<VaultRefusal, string> = {
  conflict: 'ほかの人が先に変更しました。最新の内容を読み込み直してから、もう一度操作してください。',
  duplicate_name: '同じ名前の区分がすでにあります。別の名前にしてください。',
  not_empty: '項目が残っている区分は消せません。先に項目を消すか、別の区分へ移してください。',
  last_manager: '「管理する」を持つ人（個人の指定）が 1 人もいなくなるため、変更できません。先にほかの人に「管理する」を付けてください。',
  too_many: '上限に達しているため、これ以上は追加できません。',
};

const invalid = (message: string, field: string): never => {
  throw new DomainError('validation', message, { field });
};

/** The fields that differ between two versions of an entry (names only, never values). */
export function changedVaultFields(before: VaultSecret, after: VaultSecret): string[] {
  return VAULT_SECRET_KEYS.filter((k) => before[k] !== after[k]);
}

/** A short mark for one state of a section's entries, printed on the paper and its envelope. */
export function vaultEdition(sectionId: string, entries: { id: string; version: number }[]): string {
  const parts = entries.map((e) => `${e.id}:${e.version}`).sort();
  return createHash('sha256').update(`${sectionId}|${parts.join(',')}`).digest('hex').slice(0, 6).toUpperCase();
}

const newSectionId = () => `vs_${randomBytes(8).toString('hex')}`;
const newEntryId = () => `ve_${randomBytes(8).toString('hex')}`;

/** The password book's routes. A null runtime answers the meta route only (enabled: false); the rest do not exist. */
export function registerVaultRoutes(app: FastifyInstance, runtime: VaultRuntime | null, deps: VaultRouteDeps): void {
  app.get('/api/vault/meta', async (request): Promise<VaultMetaResponse> => {
    const viewer = deps.viewer(request);
    if (!runtime || !viewer) return { enabled: false, canOpen: false, canAdminister: false, revealMinutes: runtime?.revealMinutes ?? 0, freshUntil: null };
    const admin = viewer.user.canManageAccess;
    const grants = runtime.store.allMembers();
    const member = [...grants.values()].some((g) => VaultStore.roleIn(g, viewer.user.id, viewer.departments) !== null);
    const until = viewer.passwordAt + runtime.revealMinutes * 60_000;
    return { enabled: true, canOpen: admin || member, canAdminister: admin, revealMinutes: runtime.revealMinutes, freshUntil: until > Date.parse(deps.clock()) ? new Date(until).toISOString() : null };
  });
  if (!runtime) return;
  const { store, cipher } = runtime;

  // ---- who the person is, and what they may do

  const member = (request: FastifyRequest): VaultViewer => {
    const viewer = deps.viewer(request);
    if (!viewer) throw new DomainError('forbidden', 'パスワード帳は委員だけが使えます。');
    return viewer;
  };
  const isAdmin = (v: VaultViewer) => v.user.canManageAccess;
  const roleOf = (v: VaultViewer, sectionId: string) => VaultStore.roleIn(store.members(sectionId), v.user.id, v.departments);
  const isFresh = (v: VaultViewer) => Date.parse(deps.clock()) - v.passwordAt <= runtime.revealMinutes * 60_000;
  /** The password typed on this device recently enough; otherwise the screen asks for it again. */
  const fresh = (v: VaultViewer) => {
    if (!isFresh(v)) {
      throw new HttpError(401, { error: VAULT_REAUTH_REQUIRED, message: `パスワード帳を使うには、パスワードをもう一度入力してください（入力してから ${runtime.revealMinutes} 分を過ぎたため）。` });
    }
  };
  const user = (request: FastifyRequest): VaultViewer => {
    const v = member(request);
    if (!isAdmin(v) && ![...store.allMembers().values()].some((g) => VaultStore.roleIn(g, v.user.id, v.departments) !== null)) {
      throw new DomainError('forbidden', 'パスワード帳の区分を見られるように指定されていません。区分を管理する人か権限管理者に依頼してください。');
    }
    return v;
  };
  const administrator = (request: FastifyRequest): VaultViewer => {
    const v = member(request);
    if (!isAdmin(v)) throw new DomainError('forbidden', '区分を作る・名前を変える・消すことができるのは権限管理者だけです。');
    return v;
  };
  /** The section, for a person who is on it with at least `need`, or an administrator when `admins` is set; else 404. */
  const sectionFor = (v: VaultViewer, sectionId: string, need: VaultRole, admins: boolean): { section: SectionRow; role: VaultRole | null } => {
    const section = store.section(sectionId);
    if (!section) throw notFound();
    const role = roleOf(v, sectionId);
    if (vaultRoleRank(role) >= vaultRoleRank(need)) return { section, role };
    if (admins && isAdmin(v)) return { section, role };
    if (role !== null || isAdmin(v)) throw new DomainError('forbidden', need === 'manage' ? 'この区分の見られる人を変えるには「管理する」が要ります。' : need === 'edit' ? 'この区分の項目を変えるには「編集する」が要ります。' : 'この区分を見る権限がありません。');
    throw notFound();
  };
  const settled = <T>(outcome: T | VaultRefusal | null): T => {
    if (outcome === null) throw notFound();
    if (typeof outcome === 'string' && outcome in REFUSED) throw new DomainError('conflict', REFUSED[outcome as VaultRefusal]);
    return outcome as T;
  };

  // ---- answers

  const summary = (v: VaultViewer, s: SectionRow): VaultSectionSummary => {
    const role = roleOf(v, s.id);
    return { id: s.id, name: s.name, note: s.note, myRole: role, canManage: isAdmin(v) || role === 'manage', entryCount: store.entryCount(s.id), ...store.printState(s.id), version: s.version };
  };
  const open = (row: EntryRow): VaultSecret => cipher.open(row.sectionId, row.id, row.sealed);
  const item = (row: EntryRow, secret: VaultSecret): VaultEntryItem => ({
    id: row.id,
    sectionId: row.sectionId,
    name: secret.name,
    url: secret.url,
    username: secret.username,
    hasPassword: secret.password !== '',
    hasNotes: secret.notes !== '',
    updatedAt: row.updatedAt,
    updatedByName: deps.nameOf(row.updatedBy),
    version: row.version,
  });
  const unreadable = (): never => {
    throw new HttpError(500, { error: 'vault_unreadable', message: 'この項目は開けません（鍵が替わったか、保存ファイルが変わっています）。権限管理者に知らせてください。' });
  };
  const opened = (row: EntryRow): VaultSecret => {
    try {
      return open(row);
    } catch (err) {
      if (err instanceof VaultUnreadable) return unreadable();
      throw err;
    }
  };
  /** The entry, for a person on its section with at least `need`; else 404. */
  const entryFor = (v: VaultViewer, entryId: string, need: VaultRole): { row: EntryRow; section: SectionRow } => {
    const row = store.entry(entryId);
    if (!row) throw notFound();
    const role = roleOf(v, row.sectionId);
    if (role === null) throw notFound();
    if (vaultRoleRank(role) < vaultRoleRank(need)) throw new DomainError('forbidden', 'この区分の項目を変えるには「編集する」が要ります。');
    return { row, section: store.section(row.sectionId)! };
  };
  const normalizedSecret = (raw: { name: string; url: string; username: string }, password: string, notes: string): VaultSecret => {
    const name = raw.name.trim();
    if (!name) invalid('名前を入力してください。', 'name');
    return { name, url: raw.url.trim(), username: raw.username.trim(), password, notes: notes.replace(/\r\n/g, '\n').trimEnd() };
  };

  // ---- sections

  app.get('/api/vault/sections', async (request): Promise<VaultSectionsResponse> => {
    const v = user(request);
    const sections = store.sections().filter((s) => isAdmin(v) || roleOf(v, s.id) !== null);
    return { sections: sections.map((s) => summary(v, s)), canAdminister: isAdmin(v) };
  });

  app.post('/api/vault/sections', async (request, reply) => {
    const v = administrator(request);
    const b = deps.parse(sectionBody, request.body);
    fresh(v);
    const name = b.name.trim();
    if (!name) invalid('区分の名前を入力してください。', 'name');
    const section = settled(store.createSection(newSectionId(), name, b.note.trim(), v.user.id, deps.clock()));
    return reply.code(201).send({ section: summary(v, section) });
  });

  app.put('/api/vault/sections/:sectionId', async (request) => {
    const v = administrator(request);
    const { sectionId } = deps.parse(sectionParams, request.params);
    const b = deps.parse(sectionUpdateBody, request.body);
    fresh(v);
    const name = b.name.trim();
    if (!name) invalid('区分の名前を入力してください。', 'name');
    if (!store.section(sectionId)) throw notFound();
    return { section: summary(v, settled(store.updateSection(sectionId, b.expectedVersion, name, b.note.trim(), v.user.id, deps.clock()))) };
  });

  app.delete('/api/vault/sections/:sectionId', async (request) => {
    const v = administrator(request);
    const { sectionId } = deps.parse(sectionParams, request.params);
    const q = deps.parse(versionQuery, request.query);
    fresh(v);
    settled(store.deleteSection(sectionId, q.expectedVersion, v.user.id, deps.clock()));
    return { deleted: true };
  });

  // ---- who opens a section

  const membersOf = (v: VaultViewer, section: SectionRow): VaultMembersResponse => {
    const grants = store.members(section.id);
    const people = deps.members();
    const label = (m: MemberRow) => (m.kind === 'user' ? deps.nameOf(m.target) : m.target);
    const openers = people
      .map((p) => {
        const via: string[] = [];
        let role: VaultRole | null = null;
        for (const g of grants) {
          const hit = g.kind === 'user' ? g.target === p.id : p.departments.includes(g.target);
          if (!hit) continue;
          via.push(g.kind === 'user' ? '個人の指定' : g.target);
          if (vaultRoleRank(g.role) > vaultRoleRank(role)) role = g.role;
        }
        return role ? { id: p.id, name: p.name, role, via } : null;
      })
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .sort((a, b) => vaultRoleRank(b.role) - vaultRoleRank(a.role) || a.name.localeCompare(b.name, 'ja'));
    return {
      section: summary(v, section),
      members: grants.map((m) => ({ kind: m.kind, target: m.target, label: label(m), role: m.role, grantedByName: deps.nameOf(m.grantedBy), grantedAt: m.grantedAt })),
      openers,
      choices: {
        departments: [...new Set(people.flatMap((p) => p.departments))].sort(compareDepartments),
        people: people.map((p) => ({ id: p.id, name: p.name, departments: p.departments })).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
      },
    };
  };

  app.get('/api/vault/sections/:sectionId/members', async (request): Promise<VaultMembersResponse> => {
    const v = member(request);
    const { sectionId } = deps.parse(sectionParams, request.params);
    return membersOf(v, sectionFor(v, sectionId, 'view', true).section);
  });

  app.put('/api/vault/sections/:sectionId/members', async (request): Promise<VaultMembersResponse> => {
    const v = member(request);
    const { sectionId } = deps.parse(sectionParams, request.params);
    const b = deps.parse(memberBody, request.body);
    sectionFor(v, sectionId, 'manage', true);
    fresh(v);
    // A new grant names a member or a department of today's members; taking one away works for any name (a department
    // whose role was renamed, a member who left).
    if (b.role !== null) {
      const people = deps.members();
      const known = b.kind === 'user' ? people.some((p) => p.id === b.target) : people.some((p) => p.departments.includes(b.target));
      if (!known) invalid(b.kind === 'user' ? '委員の中にその人がいません。' : '委員の所属にその部局がありません。', 'target');
    }
    const section = settled(store.setMember(sectionId, b.expectedVersion, b.kind, b.target, b.role, v.user.id, deps.clock()));
    return membersOf(v, section);
  });

  app.get('/api/vault/sections/:sectionId/events', async (request): Promise<VaultEventsResponse> => {
    const v = member(request);
    const { sectionId } = deps.parse(sectionParams, request.params);
    const q = deps.parse(eventsQuery, request.query);
    const { role } = sectionFor(v, sectionId, 'manage', true);
    // Entry names are as private as the list: only for a member of the section who typed the password recently. An
    // administrator off the section, or a device past the window, sees that something happened, not to which entry.
    const showNames = role !== null && isFresh(v);
    const names = new Map<string, string | null>();
    const entryName = (entryId: string | null): string | null => {
      if (entryId === null) return null;
      if (!showNames) return '（項目）';
      if (!names.has(entryId)) {
        const row = store.entry(entryId);
        let name: string | null = '（消した項目）';
        if (row) {
          try {
            name = open(row).name;
          } catch {
            name = '（開けない項目）';
          }
        }
        names.set(entryId, name);
      }
      return names.get(entryId)!;
    };
    const describe = (action: string, d: Record<string, unknown>): string => {
      const role = (r: unknown) => (typeof r === 'string' && (VAULT_ROLES as readonly string[]).includes(r) ? ({ view: '見る', edit: '編集する', manage: '管理する' } as const)[r as VaultRole] : '');
      const who = () => (d.kind === 'user' ? deps.nameOf(String(d.target)) : `部局「${String(d.target)}」`);
      switch (action) {
        case 'member_set':
          return d.from ? `${who()}：${role(d.from)} → ${role(d.role)}` : `${who()}に「${role(d.role)}」`;
        case 'member_removed':
          return `${who()}（${role(d.from)}）`;
        case 'entry_updated': {
          const fields = Array.isArray(d.changed) ? (d.changed as string[]).map((k) => ({ name: '名前', url: 'URL', username: 'ID', password: 'パスワード', notes: 'メモ' })[k as keyof VaultSecret] ?? k) : [];
          const move = d.movedTo ? `（別の区分へ移した）` : d.movedFrom ? `（別の区分から移した）` : '';
          return `${fields.join('・')}${move}`;
        }
        case 'revealed':
        case 'copied':
          return d.field === 'notes' ? 'メモ' : 'パスワード';
        case 'printed':
          return `版 ${String(d.edition ?? '')}・${Number(d.entries ?? 0)} 件`;
        case 'section_created':
        case 'section_deleted':
          return String(d.name ?? '');
        case 'section_updated':
          return d.from !== d.to ? `${String(d.from)} → ${String(d.to)}` : '説明';
        default:
          return '';
      }
    };
    const events: VaultEventItem[] = store.events(sectionId, q.limit).map((e) => ({ at: e.at, actorName: deps.nameOf(e.actorId), action: e.action, entryName: entryName(e.entryId), detail: describe(e.action, e.detail) }));
    return { events };
  });

  // The whole section for the paper copy (the screen prints it with the browser). Recorded as one view of every value.
  app.post('/api/vault/sections/:sectionId/print', async (request): Promise<VaultPrintResponse> => {
    const v = member(request);
    const { sectionId } = deps.parse(sectionParams, request.params);
    deps.parse(z.strictObject({}), request.body);
    const { section } = sectionFor(v, sectionId, 'view', false);
    fresh(v);
    const rows = store.entries([sectionId]);
    const secrets = rows.map((row) => ({ row, secret: opened(row) }));
    const edition = vaultEdition(sectionId, rows);
    const at = deps.clock();
    store.record(at, v.user.id, sectionId, null, 'printed', { edition, entries: rows.length });
    return {
      section: { id: section.id, name: section.name },
      edition,
      printedAt: at,
      printedByName: deps.nameOf(v.user.id),
      entries: secrets.map(({ row, secret }) => ({ ...secret, updatedAt: row.updatedAt })).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    };
  });

  // ---- entries

  app.get('/api/vault/entries', async (request): Promise<VaultEntriesResponse> => {
    const v = user(request);
    const q = deps.parse(entriesQuery, request.query);
    fresh(v);
    const sectionIds = store.sections().filter((s) => roleOf(v, s.id) !== null && (q.sectionId === undefined || s.id === q.sectionId)).map((s) => s.id);
    const entries: VaultEntryItem[] = [];
    let bad = 0;
    for (const row of store.entries(sectionIds)) {
      try {
        entries.push(item(row, open(row)));
      } catch (err) {
        if (!(err instanceof VaultUnreadable)) throw err;
        bad += 1;
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id));
    return { entries, unreadable: bad };
  });

  app.post('/api/vault/entries', async (request, reply) => {
    const v = member(request);
    const b = deps.parse(createBody, request.body);
    sectionFor(v, b.sectionId, 'edit', false);
    fresh(v);
    const secret = normalizedSecret(b, b.password, b.notes);
    const same = store.entryByToken(b.clientToken);
    if (same) {
      // A retried save: the entry the first one made, when it is the same; a different entry under the same token is refused.
      if (same.sectionId === b.sectionId && roleOf(v, same.sectionId) !== null && changedVaultFields(opened(same), secret).length === 0) {
        return reply.code(200).send({ entry: item(same, secret), replayed: true } satisfies VaultEntryResponse);
      }
      throw new DomainError('conflict', '同じ送信がすでに保存されていて、内容が違うため保存できませんでした。一覧で保存された内容を確かめてください。');
    }
    const id = newEntryId();
    const row = settled(store.insertEntry(id, b.sectionId, cipher.seal(b.sectionId, id, secret), b.clientToken, v.user.id, deps.clock()));
    return reply.code(201).send({ entry: item(row, secret), replayed: false } satisfies VaultEntryResponse);
  });

  app.put('/api/vault/entries/:entryId', async (request): Promise<VaultEntryResponse> => {
    const v = member(request);
    const { entryId } = deps.parse(entryParams, request.params);
    const b = deps.parse(updateBody, request.body);
    const { row } = entryFor(v, entryId, 'edit');
    if (b.sectionId !== row.sectionId) sectionFor(v, b.sectionId, 'edit', false);
    fresh(v);
    const before = opened(row);
    const after = normalizedSecret(b, b.password ?? before.password, b.notes ?? before.notes);
    const changed = changedVaultFields(before, after);
    if (changed.length === 0 && b.sectionId === row.sectionId) {
      if (row.version !== b.expectedVersion) throw new DomainError('conflict', REFUSED.conflict);
      return { entry: item(row, before) };
    }
    const saved = settled(store.updateEntry(entryId, b.expectedVersion, b.sectionId, cipher.seal(b.sectionId, entryId, after), changed, v.user.id, deps.clock()));
    return { entry: item(saved, after) };
  });

  app.delete('/api/vault/entries/:entryId', async (request) => {
    const v = member(request);
    const { entryId } = deps.parse(entryParams, request.params);
    const q = deps.parse(versionQuery, request.query);
    entryFor(v, entryId, 'edit');
    fresh(v);
    settled(store.deleteEntry(entryId, q.expectedVersion, v.user.id, deps.clock()));
    return { deleted: true };
  });

  // One value, recorded before it is sent.
  app.post('/api/vault/entries/:entryId/reveal', async (request): Promise<VaultRevealResponse> => {
    const v = member(request);
    const { entryId } = deps.parse(entryParams, request.params);
    const b = deps.parse(revealBody, request.body);
    const { row } = entryFor(v, entryId, b.purpose === 'edit' ? 'edit' : 'view');
    fresh(v);
    const secret = opened(row);
    store.record(deps.clock(), v.user.id, row.sectionId, row.id, b.purpose === 'copy' ? 'copied' : 'revealed', { field: b.field, purpose: b.purpose });
    return { field: b.field, value: secret[b.field] };
  });
}
