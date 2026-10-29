import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CATEGORY_LABELS,
  CONTACT_CATEGORIES,
  CONTACT_LIMITS,
  ContactValidationError,
  contactTitle,
  normalizeContactSearch,
  validateContact,
  type ContactAddressMatch,
  type ContactDetailResponse,
  type ContactImportResponse,
  type ContactInput,
  type ContactListItem,
  type ContactListResponse,
  type ContactSuggestion,
  type ContactView,
} from '../../shared/contacts.js';
import { departmentsOfLabel, isMailAddress, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { MailSession } from '../mailbox/routes.js';
import type { People } from '../mailbox/service.js';
import { ContactsStore, type ContactRow } from './store.js';

// Browser routes of the committee contacts (Discord login). Every committee member reads, adds and edits;
// access administrators also delete, import and export. Temporary staff are refused here as well as by the
// login's route list. The mail idle limit does not apply: contacts hold no mail.

export interface ContactRouteDeps {
  requireUser: (request: FastifyRequest) => User;
  session: (request: FastifyRequest) => MailSession | null;
  people: People;
  discordUserIdOf: (userId: string) => string | null;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

const contactParams = z.strictObject({ contactId: z.string().regex(/^ct_[0-9a-f]{16}$/) });
const listQuery = z.strictObject({
  q: z.string().max(CONTACT_LIMITS.query).optional(),
  category: z.enum(CONTACT_CATEGORIES).optional(),
  tag: z.string().min(1).max(CONTACT_LIMITS.tag).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(CONTACT_LIMITS.pageSizeMax).default(50),
});
const suggestQuery = z.strictObject({ q: z.string().min(1).max(100) });
const addressQuery = z.strictObject({ addresses: z.string().min(1).max(50 * 256) });
const updateBody = z.strictObject({ expectedVersion: z.number().int().min(1), contact: z.unknown() });
const deleteQuery = z.strictObject({ expectedVersion: z.coerce.number().int().min(1) });
const importBody = z.strictObject({ contacts: z.array(z.unknown()).min(1).max(CONTACT_LIMITS.importMax), dryRun: z.boolean() });
const SUGGESTIONS = 8;

const terms = (q: string | undefined) => (q ? normalizeContactSearch(q).split(/\s+/).filter(Boolean).slice(0, 10) : []);

function checked(input: unknown): ContactInput {
  try {
    return validateContact(input);
  } catch (err) {
    if (err instanceof ContactValidationError) throw new DomainError('validation', err.message, { field: err.field });
    throw err;
  }
}

/** A spreadsheet cell: quoted, and a leading =, +, - or @ (also full-width) made plain text so a spreadsheet never runs it. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r＝＋－＠]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * `opened` is null when contacts.sqlite3 could not be opened: the contacts routes then answer 503 and the rest of
 * the app (mail, tasks, rental) starts as usual.
 */
export function registerContactRoutes(app: FastifyInstance, opened: ContactsStore | null, deps: ContactRouteDeps): void {
  const nameOf = (userId: string) => deps.people.lookup(userId)?.displayName ?? '（不明な利用者）';

  function member(request: FastifyRequest): User {
    const user = deps.requireUser(request);
    const session = deps.session(request);
    if (!session || user.disabled) throw new DomainError('unauthenticated', 'ログインしてください。');
    // Temporary staff, however the login names them: staff:<number>, their login ID iy-<number>, no Discord account, the label.
    const temporary =
      session.discordUserId.startsWith('staff:') ||
      isTemporaryStaffLoginId(user.id) ||
      deps.discordUserIdOf(user.id) === null ||
      departmentsOfLabel(user.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT);
    if (temporary) throw new DomainError('forbidden', '連絡先は委員だけが使えます。');
    return user;
  }

  function administrator(request: FastifyRequest): User {
    const user = member(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', '連絡先の削除・取り込み・書き出しは権限管理者だけができます。');
    return user;
  }

  if (!opened) {
    const unavailable = async (request: FastifyRequest) => {
      member(request);
      throw new HttpError(503, { error: 'contacts_unavailable', message: '連絡先の保存ファイルを開けませんでした。システム課に連絡してください（メールなどほかの機能は使えます）。' });
    };
    app.all('/api/contacts', unavailable);
    app.all('/api/contacts/*', unavailable);
    return;
  }
  const store = opened;

  const view = (row: ContactRow): ContactView => ({
    ...row.data,
    id: row.id,
    source: row.source,
    version: row.version,
    createdAt: row.created_at,
    createdByName: nameOf(row.created_by),
    updatedAt: row.updated_at,
    updatedByName: nameOf(row.updated_by),
  });

  const listItem = (row: ContactRow): ContactListItem => ({
    id: row.id,
    category: row.category,
    organization: row.data.organization,
    section: row.data.section,
    name: row.data.name,
    nameKana: row.data.nameKana,
    email: row.data.emails[0]?.address ?? null,
    phone: row.data.phones[0] ?? null,
    tags: row.data.tags,
  });

  const detail = (row: ContactRow, user: User): ContactDetailResponse => ({
    contact: view(row),
    history: store.history(row.id).map((h) => ({ at: h.at, actorName: nameOf(h.actor_id), action: h.action, changed: h.changed })),
    canAdminister: user.canManageAccess,
  });

  app.get('/api/contacts', async (request): Promise<ContactListResponse> => {
    const user = member(request);
    const q = deps.parse(listQuery, request.query);
    const filter = { terms: terms(q.q), ...(q.category ? { category: q.category } : {}), ...(q.tag ? { tag: q.tag } : {}) };
    const page = store.page(filter, q.pageSize, (q.page - 1) * q.pageSize);
    return { items: page.rows.map(listItem), total: page.total, page: q.page, pageSize: q.pageSize, counts: store.categoryCounts(filter), tags: store.tagCounts(), canAdminister: user.canManageAccess };
  });

  // Addresses offered while a recipient is typed in the mail form.
  app.get('/api/contacts/suggest', async (request): Promise<ContactSuggestion[]> => {
    member(request);
    const { q } = deps.parse(suggestQuery, request.query);
    return store.suggest(terms(q), SUGGESTIONS).map(({ row, idx }) => {
      const email = row.data.emails[idx]!;
      return { contactId: row.id, name: contactTitle(row.data), organization: row.data.name ? row.data.organization : '', address: email.address, label: email.label };
    });
  });

  // Which senders of a thread are already in the contacts (the 連絡先に追加 / 連絡先を見る buttons).
  app.get('/api/contacts/by-address', async (request): Promise<ContactAddressMatch[]> => {
    member(request);
    const { addresses } = deps.parse(addressQuery, request.query);
    // A sender's address that is not one (it happens in received mail) is left out, not refused.
    const list = addresses.split(',').map((a) => a.trim()).filter(isMailAddress).slice(0, 50);
    const seen = new Set<string>();
    return store.byAddresses(list).flatMap(({ address, row }) => {
      if (seen.has(address)) return [];
      seen.add(address);
      return [{ address, contactId: row.id, name: contactTitle(row.data) }];
    });
  });

  app.get('/api/contacts/export.csv', async (request, reply) => {
    const user = administrator(request);
    const head = ['種類', '組織・団体', '部署・役職', '氏名', 'ふりがな', 'メール', '電話', '郵便番号', '住所', 'タグ', 'メモ', '出典', '更新日時', '更新した人'];
    const rows = store.all().map((r) => [
      CATEGORY_LABELS[r.category],
      r.data.organization,
      r.data.section,
      r.data.name,
      r.data.nameKana,
      r.data.emails.map((e) => (e.label ? `${e.label}: ${e.address}` : e.address)).join('\n'),
      r.data.phones.map((p) => (p.label ? `${p.label}: ${p.number}` : p.number)).join('\n'),
      r.data.postalCode,
      r.data.address,
      r.data.tags.join('、'),
      r.data.notes,
      r.source,
      r.updated_at,
      nameOf(r.updated_by),
    ]);
    const now = deps.clock();
    store.recordExport(user.id, now, rows.length);
    const csv = '\ufeff' + [head, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const day = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replaceAll('-', '');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="contacts.csv"; filename*=UTF-8''${encodeURIComponent(`連絡先_${day}.csv`)}`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(csv);
  });

  // A list made from existing files, all at once. dryRun shows what would happen.
  // 3,000 contacts are about 2 MB of JSON. (The sign-in is resolved after the body is read, as for the rental uploads.)
  app.post('/api/contacts/import', { bodyLimit: 4 * 1024 * 1024 }, async (request): Promise<ContactImportResponse> => {
    const user = administrator(request);
    const body = deps.parse(importBody, request.body);
    const invalid: ContactImportResponse['invalid'] = [];
    const items: { index: number; data: ContactInput; source: string }[] = [];
    const labels = new Map<number, string>();
    body.contacts.forEach((raw, index) => {
      const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const label = [o.organization, o.name].filter((v) => typeof v === 'string' && v.trim()).join(' ').slice(0, 100) || `${index + 1} 件目`;
      labels.set(index, label);
      const source = typeof o.source === 'string' ? o.source.replace(/\s+/g, ' ').trim().slice(0, CONTACT_LIMITS.source) : '';
      const { source: _ignored, ...rest } = o;
      void _ignored;
      try {
        items.push({ index, data: validateContact(rest), source });
      } catch (err) {
        if (!(err instanceof ContactValidationError)) throw err;
        invalid.push({ index, label, message: err.message });
      }
    });
    const result = store.import(items, user.id, deps.clock(), body.dryRun);
    return { dryRun: body.dryRun, added: result.added, duplicates: result.duplicates.map((d) => ({ ...d, label: labels.get(d.index) ?? '' })), invalid };
  });

  app.get('/api/contacts/:contactId', async (request): Promise<ContactDetailResponse> => {
    const user = member(request);
    const { contactId } = deps.parse(contactParams, request.params);
    const row = store.get(contactId);
    if (!row) throw notFound();
    return detail(row, user);
  });

  app.post('/api/contacts', async (request, reply) => {
    const user = member(request);
    const data = checked(request.body);
    return reply.code(201).send(detail(store.create(data, user.id, deps.clock()), user));
  });

  app.put('/api/contacts/:contactId', async (request): Promise<ContactDetailResponse> => {
    const user = member(request);
    const { contactId } = deps.parse(contactParams, request.params);
    const body = deps.parse(updateBody, request.body);
    const result = store.update(contactId, body.expectedVersion, checked(body.contact), user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの連絡先を変更しました。最新の内容を読み込み直してから、もう一度変更してください。');
    return detail(result, user);
  });

  app.delete('/api/contacts/:contactId', async (request, reply) => {
    const user = administrator(request);
    const { contactId } = deps.parse(contactParams, request.params);
    const { expectedVersion } = deps.parse(deleteQuery, request.query);
    const result = store.delete(contactId, expectedVersion, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの連絡先を変更しました。最新の内容を確かめてから削除してください。');
    return reply.code(204).send();
  });
}
