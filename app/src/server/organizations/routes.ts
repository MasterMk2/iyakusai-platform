import { createHash, randomBytes } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { normalizeContactSearch, recipientText } from '../../shared/contacts.js';
import { departmentsOfLabel, MAIL_ATTACHMENTS_MAX, MAIL_BODY_MAX, MAIL_SUBJECT_MAX, SEND_DUPLICATE, SEND_UNKNOWN, TEMPORARY_STAFF_DEPARTMENT } from '../../shared/mailbox.js';
import {
  defaultStatus,
  IMPORT_FIELDS,
  kindFromText,
  MAIL_PLACEHOLDERS,
  mailValues,
  ORG_FIELD_LABELS,
  ORG_KIND_LABELS,
  ORG_KINDS,
  ORG_LIMITS,
  ORG_STAGES,
  OrgValidationError,
  orgNameKey,
  parseYenText,
  renderMail,
  statusAllowed,
  statusFor,
  validateOrg,
  validateTemplate,
  validDate,
  type OrgDetailResponse,
  type OrgHistoryView,
  type OrgImportPlanRow,
  type OrgImportResponse,
  type OrgInput,
  type OrgKind,
  type OrgListItem,
  type OrgListResponse,
  type OrgMailAttachment,
  type OrgMailBatch,
  type OrgMailBatchSummary,
  type OrgMailItem,
  type OrgMailThreads,
  type OrgMeta,
  type OrgTemplateView,
  type OrgView,
} from '../../shared/organizations.js';
import { type ContactRouteDeps, committeeMember } from '../contacts/routes.js';
import type { ContactsStore } from '../contacts/store.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import type { OutgoingAttachment } from '../mailbox/compose.js';
import type { MailboxService } from '../mailbox/service.js';
import type { MailSender } from '../mailbox/send.js';
import { changedFields, type BatchRow, type HistoryRaw, type ItemStatus, type OrgFilter, type OrgRow, type OrganizationsStore, type TemplateRow } from './store.js';

// Organizations (団体の台帳, 2026-11-03), at /api/organizations on the committee mailbox (Discord login).
// Permissions, checked on the server for every request:
// - reading and editing the list, the import and the templates: every committee member (not temporary staff),
//   the same rule as the contacts;
// - deleting an organization or a template: access administrators;
// - a mail batch (下見・添付・送信): the member, the mail screens' sign-in gate (the same idle limit and trial list),
//   and a send grant on the From mailbox. Only the member who made a batch can look at it, change it or send it.

const SEND_STALE_MS = 10 * 60_000;
const HISTORY_REVERTABLE = ['updated', 'imported', 'reverted'];
/** The most recipients a batch request names. The limit for sending (ORG_LIMITS.batch) is checked with a message. */
const BATCH_REQUEST_MAX = 1000;

export interface OrganizationRouteDeps extends ContactRouteDeps {
  contacts: ContactsStore | null;
  /** Mail sending; null when the server has no sending set up (the batch routes then answer 503). */
  sender: MailSender | null;
  /** The mail screens' gate: throws like the mail routes when the sign-in is too old or the trial list excludes the person. */
  mailGate: (request: FastifyRequest) => User;
  /** The same check without recording the use of the mail (the screens ask it to show or hide the mail entries). */
  mailPeek: (request: FastifyRequest) => User;
  /** The mail listing of the mail screens: threads the person may read (used for the contact's mail). */
  mail: Pick<MailboxService, 'listThreads'>;
  /** The largest total size of the shared attachments of a batch: the sending setting (0 when sending is off). */
  attachmentBytes: number;
  now: () => number;
}

const orgParams = z.strictObject({ orgId: z.string().regex(/^og_[0-9a-f]{16}$/) });
const templateParams = z.strictObject({ templateId: z.string().regex(/^tp_[0-9a-f]{16}$/) });
const batchParams = z.strictObject({ batchId: z.string().regex(/^mb_[0-9a-f]{16}$/) });
const attachmentParams = z.strictObject({ batchId: batchParams.shape.batchId, attachmentIndex: z.string().regex(/^\d{1,3}$/) });
const pageParams = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(ORG_LIMITS.pageSizeMax).default(50) };
const listQuery = z.strictObject({
  q: z.string().max(ORG_LIMITS.query).optional(),
  kind: z.enum(ORG_KINDS).optional(),
  fiscalYear: z.coerce.number().int().min(ORG_LIMITS.fiscalYearMin).max(ORG_LIMITS.fiscalYearMax).optional(),
  status: z.string().min(1).max(ORG_LIMITS.status).optional(),
  department: z.string().min(1).max(ORG_LIMITS.department).optional(),
  owner: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  ...pageParams,
});
const updateBody = z.strictObject({ expectedVersion: z.number().int().min(1), organization: z.unknown() });
const deleteQuery = z.strictObject({ expectedVersion: z.coerce.number().int().min(1) });
const revertBody = z.strictObject({ expectedVersion: z.number().int().min(1), historyId: z.number().int().min(1) });
const templateBody = z.strictObject({ expectedVersion: z.number().int().min(1), template: z.unknown() });
const importBody = z.strictObject({
  dryRun: z.boolean(),
  fiscalYear: z.number().int().min(ORG_LIMITS.fiscalYearMin).max(ORG_LIMITS.fiscalYearMax),
  defaultKind: z.enum(ORG_KINDS),
  mapping: z.record(z.string().max(20), z.number().int().min(0).max(ORG_LIMITS.importColumns - 1).nullable()),
  rows: z.array(z.array(z.string().max(2000)).max(ORG_LIMITS.importColumns)).min(1).max(ORG_LIMITS.importRows),
  /** The physical line of each row in the sheet (a blank line or a line break in a cell moves the numbers). */
  lines: z.array(z.number().int().min(1).max(1_000_000)).max(ORG_LIMITS.importRows).optional(),
  /** The plan token of the dry run the screen shows; the commit is refused when the plan has changed since. */
  planToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
const batchBody = z.strictObject({
  clientToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  mailboxId: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
  templateId: z.string().regex(/^tp_[0-9a-f]{16}$/).nullable(),
  subject: z.string().max(ORG_LIMITS.templateSubject * 2).optional(),
  body: z.string().max(ORG_LIMITS.templateBody * 2).optional(),
  organizationIds: z.array(orgParams.shape.orgId).min(1).max(BATCH_REQUEST_MAX),
});
const sendBody = z.strictObject({
  includeFailed: z.boolean(),
  /** A retry walks the batch forward: only items after this index are tried (-1 at the start). */
  afterIndex: z.number().int().min(-1).max(100_000).optional(),
});

const terms = (q: string | undefined) => (q ? normalizeContactSearch(q).split(/\s+/).filter(Boolean).slice(0, 10) : []);
const ITEM_STATUSES: ItemStatus[] = ['pending', 'sending', 'sent', 'failed', 'unknown', 'skipped'];
/** A write the import makes once every row is checked (a new organization, or the changes to one). */
type ImportWrite = { kind: 'create'; data: OrgInput } | { kind: 'update'; id: string; version: number; data: OrgInput };

/** A committee account in the lists of people (not disabled, not temporary staff). */
const isCommitteeAccount = (u: User) => !u.disabled && !isTemporaryStaffLoginId(u.id) && !departmentsOfLabel(u.roleLabel).includes(TEMPORARY_STAFF_DEPARTMENT);

/** Input errors of the rules (organization, template, import) as the API's validation answer. */
function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OrgValidationError) throw new DomainError('validation', err.message, { field: err.field });
    throw err;
  }
}

// eslint-disable-next-line no-control-regex
const FILENAME_CONTROL = /[\u0000-\u001f\u007f]/g;
const attachmentName = (name: string | undefined) => (name ?? '').replace(FILENAME_CONTROL, '').replace(/[\\/]/g, '_').trim().slice(0, 200) || 'attachment';
const attachmentType = (type: string | undefined) => {
  const t = (type ?? '').toLowerCase().trim();
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(t) ? t : 'application/octet-stream';
};

/** Multipart errors of the attachment form, as validation answers the screen shows. */
function attachmentFormError(err: unknown, maxBytes: number): never {
  if (err instanceof DomainError || err instanceof HttpError) throw err;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
    throw new DomainError('validation', `添付ファイルは ${MAIL_ATTACHMENTS_MAX} 個・合わせて ${Math.floor(maxBytes / 1024 / 1024)} MB までです。`, { field: 'attachments' });
  }
  throw new DomainError('validation', '添付を読み取れませんでした。ファイルを選び直してから、もう一度試してください。');
}

/**
 * `opened` is null when organizations.sqlite3 could not be opened: the routes then answer 503 and the rest of the
 * mail folder (mail, contacts) keeps working.
 */
export function registerOrganizationRoutes(app: FastifyInstance, opened: OrganizationsStore | null, deps: OrganizationRouteDeps): void {
  const nameOf = (userId: string) => deps.people.lookup(userId)?.displayName ?? '（不明な利用者）';
  const member = (request: FastifyRequest): User => committeeMember(deps, request);
  const administrator = (request: FastifyRequest): User => {
    const user = member(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', '団体の削除は権限管理者だけができます。');
    return user;
  };
  /** A mail batch: the member, the mail gate, and the mail sending set up on this server. */
  const mailMember = (request: FastifyRequest): User => {
    const user = member(request);
    deps.mailGate(request);
    return user;
  };
  const mailReadable = (request: FastifyRequest): boolean => {
    try {
      deps.mailPeek(request);
      return true;
    } catch {
      return false;
    }
  };
  const sendingOrFail = (): MailSender => {
    if (!deps.sender) throw new HttpError(503, { error: 'mail_unavailable', message: 'このサーバーではメールの送信が設定されていないため、一斉送信はできません。' });
    return deps.sender;
  };

  if (!opened) {
    const unavailable = async (request: FastifyRequest) => {
      member(request);
      throw new HttpError(503, { error: 'organizations_unavailable', message: '団体の保存ファイルを開けませんでした。システム課に連絡してください（連絡先やメールなどほかの機能は使えます）。' });
    };
    app.all('/api/organizations', unavailable);
    app.all('/api/organizations/*', unavailable);
    return;
  }
  const store = opened;
  const contacts = deps.contacts;

  const contactOf = (contactId: string | null) => (contactId && contacts ? contacts.get(contactId) : null);
  const ownerOf = (ownerId: string | null) => (ownerId ? deps.people.lookup(ownerId) ?? null : null);

  const orgView = (row: OrgRow): OrgView => {
    const contact = contactOf(row.data.contactId);
    const owner = ownerOf(row.data.ownerId);
    return {
      ...row.data,
      id: row.id,
      version: row.version,
      ownerName: owner ? owner.displayName : null,
      contactName: contact ? contact.data.name || null : null,
      contactEmail: contact?.data.emails[0]?.address ?? null,
      createdAt: row.created_at,
      createdByName: nameOf(row.created_by),
      updatedAt: row.updated_at,
      updatedByName: nameOf(row.updated_by),
    };
  };

  const listItem = (row: OrgRow): OrgListItem => ({
    id: row.id,
    kind: row.data.kind,
    fiscalYear: row.data.fiscalYear,
    name: row.data.name,
    department: row.data.department,
    ownerName: ownerOf(row.data.ownerId)?.displayName ?? null,
    status: row.data.status,
    amountYen: row.data.amountYen,
    nextDue: row.data.nextDue,
    contactEmail: contactOf(row.data.contactId)?.data.emails[0]?.address ?? null,
  });

  const historyView = (h: HistoryRaw): OrgHistoryView => ({
    id: h.id,
    at: h.at,
    actorName: nameOf(h.actor_id),
    action: h.action,
    changed: h.changed.map((k) => ORG_FIELD_LABELS[k as keyof OrgInput] ?? k),
    mail: h.action === 'mail_sent' && h.detail?.subject !== undefined ? { subject: h.detail.subject, sent: h.detail.sent ?? 1 } : null,
    canRevert: h.before !== null && HISTORY_REVERTABLE.includes(h.action),
  });

  const detail = (row: OrgRow, user: User): OrgDetailResponse => ({
    org: orgView(row),
    history: store.history(row.id).map(historyView),
    canAdminister: user.canManageAccess,
  });

  /** Owner and contact must exist (the owner is a committee account, the contact is in the contacts). */
  const checkLinks = (data: OrgInput) => {
    if (data.ownerId !== null) {
      const owner = deps.people.lookup(data.ownerId);
      if (!owner || !isCommitteeAccount(owner)) throw new DomainError('validation', '委員会側の担当は委員の中から選んでください。', { field: 'ownerId' });
    }
    if (data.contactId !== null) {
      if (!contacts) throw new DomainError('validation', '連絡先が使えないため、相手の担当者は結べません。', { field: 'contactId' });
      if (!contacts.get(data.contactId)) throw new DomainError('validation', '選んだ連絡先が見つかりません。連絡先を選び直してください。', { field: 'contactId' });
    }
  };

  /** The same name in the same year is one organization (the import's rule): a second one is refused. */
  const checkUnique = (data: OrgInput, exceptId: string | null) => {
    if (store.byNameKey(data.fiscalYear, orgNameKey(data.name)).some((r) => r.id !== exceptId)) {
      throw new DomainError('conflict', `${data.fiscalYear}年度に同じ団体名「${data.name}」の団体が既にあります。既存の団体を開いて編集してください。`, { field: 'name' });
    }
  };

  // ---- meta: the choices the screens need (no organization is read here)

  app.get('/api/organizations/meta', async (request): Promise<OrgMeta> => {
    const user = member(request);
    // Sending and the sender's own address are shown only to a person who may read mail (the mail gate's rule).
    const readable = mailReadable(request);
    const options = readable && deps.sender ? deps.sender.options(user) : null;
    return {
      stages: Object.fromEntries(Object.entries(ORG_STAGES).map(([k, v]) => [k, [...(v ?? [])]])),
      kindLabels: ORG_KIND_LABELS,
      kinds: [...ORG_KINDS],
      placeholders: [...MAIL_PLACEHOLDERS],
      limits: {
        batch: ORG_LIMITS.batch,
        importRows: ORG_LIMITS.importRows,
        sendChunk: ORG_LIMITS.sendChunk,
        templateBody: ORG_LIMITS.templateBody,
        templateSubject: ORG_LIMITS.templateSubject,
        attachments: MAIL_ATTACHMENTS_MAX,
        attachmentBytes: options ? options.maxAttachmentBytes : 0,
      },
      mail: { enabled: options !== null, readable, from: options?.from ?? [] },
      people: deps.people
        .list()
        .filter(isCommitteeAccount)
        .map((u) => ({ id: u.id, name: u.displayName }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
      canAdminister: user.canManageAccess,
    };
  });

  // ---- organizations

  app.get('/api/organizations', async (request): Promise<OrgListResponse> => {
    member(request);
    const q = deps.parse(listQuery, request.query);
    const filter: OrgFilter = {
      terms: terms(q.q),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.fiscalYear !== undefined ? { fiscalYear: q.fiscalYear } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.department ? { department: q.department } : {}),
      ...(q.owner ? { ownerId: q.owner } : {}),
    };
    const page = store.page(filter, q.pageSize, (q.page - 1) * q.pageSize);
    return {
      items: page.rows.map(listItem),
      total: page.total,
      page: q.page,
      pageSize: q.pageSize,
      statusCounts: store.statusCounts(filter),
      departments: store.departments(q.fiscalYear),
      kind: q.kind ?? null,
    };
  });

  app.get('/api/organizations/:orgId', async (request): Promise<OrgDetailResponse> => {
    const user = member(request);
    const { orgId } = deps.parse(orgParams, request.params);
    const row = store.get(orgId);
    if (!row) throw notFound();
    return detail(row, user);
  });

  app.post('/api/organizations', async (request, reply) => {
    const user = member(request);
    const data = checked(() => validateOrg(request.body));
    checkLinks(data);
    checkUnique(data, null);
    return reply.code(201).send(detail(store.create(data, user.id, deps.clock()), user));
  });

  app.put('/api/organizations/:orgId', async (request): Promise<OrgDetailResponse> => {
    const user = member(request);
    const { orgId } = deps.parse(orgParams, request.params);
    const body = deps.parse(updateBody, request.body);
    const data = checked(() => validateOrg(body.organization));
    checkLinks(data);
    checkUnique(data, orgId);
    const result = store.update(orgId, body.expectedVersion, data, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの団体を変更しました。最新の内容を読み込み直してから、もう一度変更してください。');
    return detail(result, user);
  });

  // Puts back the state a history row kept (an update, an import or an earlier revert). It is one more change.
  app.post('/api/organizations/:orgId/revert', async (request): Promise<OrgDetailResponse> => {
    const user = member(request);
    const { orgId } = deps.parse(orgParams, request.params);
    const body = deps.parse(revertBody, request.body);
    if (!store.get(orgId)) throw notFound();
    const past = store.historyRow(orgId, body.historyId);
    if (!past || !past.before || !HISTORY_REVERTABLE.includes(past.action)) {
      throw new DomainError('validation', 'この履歴には戻せる内容がありません。');
    }
    const data = checked(() => validateOrg(past.before));
    checkLinks(data);
    checkUnique(data, orgId);
    const result = store.update(orgId, body.expectedVersion, data, user.id, deps.clock(), 'reverted');
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの団体を変更しました。最新の内容を読み込み直してから、もう一度戻してください。');
    return detail(result, user);
  });

  // The threads of the contact's mail: the mail listing with the contact's address as the search, for the person's
  // own readable mail only (the mail gate applies, as on the mail screens).
  app.get('/api/organizations/:orgId/mail', async (request): Promise<OrgMailThreads> => {
    const user = mailMember(request);
    const { orgId } = deps.parse(orgParams, request.params);
    const row = store.get(orgId);
    if (!row) throw notFound();
    const address = contactOf(row.data.contactId)?.data.emails[0]?.address ?? null;
    if (!address) return { address: null, threads: [] };
    const found = deps.mail.listThreads(user, { q: address, page: 1, pageSize: 10 });
    return {
      address,
      threads: found.items.map((t) => ({ threadId: t.threadId, mailboxId: t.mailbox.id, mailboxName: t.mailbox.name, subject: t.subject, latestReceivedAt: t.latestReceivedAt, senders: t.senders })),
    };
  });

  app.delete('/api/organizations/:orgId', async (request, reply) => {
    const user = administrator(request);
    const { orgId } = deps.parse(orgParams, request.params);
    const { expectedVersion } = deps.parse(deleteQuery, request.query);
    const result = store.delete(orgId, expectedVersion, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこの団体を変更しました。最新の内容を確かめてから削除してください。');
    return reply.code(204).send();
  });

  // ---- import (下見 with dryRun, then the same request without it)

  app.post('/api/organizations/import', { bodyLimit: 2 * 1024 * 1024 }, async (request): Promise<OrgImportResponse> => {
    const user = member(request);
    const body = deps.parse(importBody, request.body);
    if (body.lines && body.lines.length !== body.rows.length) throw new DomainError('validation', '取り込む行の番号と行の数が合いません。CSV を選び直してください。');
    const plan = planImport(body);
    const planToken = createHash('sha256').update(JSON.stringify([plan.rows, plan.writes])).digest('hex');
    if (!body.dryRun) {
      // The commit writes only the plan the person checked: a change to the list since the dry run stops it.
      if (body.planToken !== planToken) throw new DomainError('conflict', '下見のあとに団体の内容が変わりました。下見を見直してから、もう一度取り込んでください。');
      const now = deps.clock();
      for (const write of plan.writes) {
        if (write.kind === 'create') store.create(write.data, user.id, now, 'imported');
        else store.update(write.id, write.version, write.data, user.id, now, 'imported');
      }
    }
    const rows = plan.rows;
    return {
      dryRun: body.dryRun,
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      skip: rows.filter((r) => r.action === 'skip').length,
      rows,
      planToken,
    };
  });

  /** The rows as the screen sent them, checked against the rules and the list as it is now. */
  function planImport(body: z.infer<typeof importBody>): { rows: OrgImportPlanRow[]; writes: ImportWrite[] } {
    const mapping = new Map<string, number>();
    for (const field of IMPORT_FIELDS) {
      const column = body.mapping[field];
      if (typeof column === 'number') mapping.set(field, column);
    }
    if (!mapping.has('name')) throw new DomainError('validation', '団体名の列を選んでください。', { field: 'name' });
    const people = new Map<string, string | null>();
    for (const u of deps.people.list().filter(isCommitteeAccount)) {
      // Two members with the same name cannot be told apart from a sheet: the row is skipped instead.
      people.set(u.displayName, people.has(u.displayName) ? null : u.id);
    }
    const rows: OrgImportPlanRow[] = [];
    const writes: ImportWrite[] = [];
    const seen = new Map<string, number>();
    body.rows.forEach((cells, i) => {
      const line = body.lines?.[i] ?? i + 2;
      const cell = (field: string): string | null => {
        const column = mapping.get(field);
        return column === undefined ? null : (cells[column] ?? '').trim();
      };
      const name = cell('name') ?? '';
      const skip = (message: string) => rows.push({ line, action: 'skip', name, message, changed: [] });
      if (!name) return skip('団体名がありません');
      const key = orgNameKey(name);
      const earlier = seen.get(key);
      if (earlier !== undefined) return skip(`取り込みの ${earlier} 行目と同じ団体名です`);
      seen.set(key, line);
      try {
        const existing = store.byNameKey(body.fiscalYear, key);
        if (existing.length > 1) return skip('同じ団体名が今年度に複数あるため、どれを直すか決められません');
        const current = existing[0] ?? null;
        // A kind in the sheet, else the kind the screen chose (for a new row) or the kept one.
        const kindText = cell('kind');
        let kind: OrgKind = current ? current.data.kind : body.defaultKind;
        if (kindText) {
          const found = kindFromText(kindText);
          if (!found) return skip(`種別「${kindText}」が分かりません（協賛・寄付・出展団体・業者・大学の部署・その他）`);
          kind = found;
        }
        const base: OrgInput = current
          ? { ...current.data }
          : { kind, fiscalYear: body.fiscalYear, name, department: '', ownerId: null, contactId: null, status: defaultStatus(kind), amountYen: null, content: '', nextAction: '', nextDue: null, notes: '' };
        const data: OrgInput = { ...base, kind };
        // A blank cell keeps what the list has (an import never empties a field by accident).
        for (const [field, key2] of [
          ['department', 'department'],
          ['content', 'content'],
          ['nextAction', 'nextAction'],
          ['notes', 'notes'],
        ] as const) {
          const value = cell(field);
          if (value) data[key2] = value;
        }
        const statusText = cell('status');
        if (statusText) data.status = statusFor(kind, statusText);
        else if (!current) data.status = defaultStatus(kind);
        // A kind change keeps the status when the new kind has it (a stage of the kind, or any short text).
        else if (current.data.kind !== kind && !statusAllowed(kind, current.data.status)) data.status = defaultStatus(kind);
        const amountText = cell('amountYen');
        if (amountText) {
          const amount = parseYenText(amountText);
          if (amount === 'invalid') return skip(`金額「${amountText}」が数字になっていません`);
          if (amount !== null) data.amountYen = amount;
        }
        const dueText = cell('nextDue');
        if (dueText) {
          if (!validDate(dueText)) return skip(`期限「${dueText}」は 2026-11-30 の形で書いてください`);
          data.nextDue = dueText;
        }
        const ownerText = cell('ownerName');
        if (ownerText) {
          if (!people.has(ownerText)) return skip(`委員会側の担当「${ownerText}」が委員にいません（名前を一致させてください）`);
          const ownerId = people.get(ownerText);
          if (ownerId === null || ownerId === undefined) return skip(`委員会側の担当「${ownerText}」は同じ名前の委員が複数いるため決められません`);
          data.ownerId = ownerId;
        }
        let note = '';
        const emailText = cell('contactEmail');
        if (emailText) {
          const found = contacts ? contacts.byAddresses([emailText])[0] : undefined;
          if (found) data.contactId = found.row.id;
          else note = `連絡先に「${emailText}」がないため、相手の担当者は結びませんでした`;
        }
        if (!current) data.name = name;
        const valid = checked(() => validateOrg(data));
        checkLinks(valid);
        if (current) {
          const changed = changedFields(current.data, valid).map((k) => ORG_FIELD_LABELS[k as keyof OrgInput] ?? k);
          if (changed.length === 0) return skip('変更はありません（今の内容と同じです）');
          writes.push({ kind: 'update', id: current.id, version: current.version, data: valid });
          rows.push({ line, action: 'update', name, message: changed.join('・') + (note ? `（${note}）` : ''), changed });
        } else {
          writes.push({ kind: 'create', data: valid });
          rows.push({ line, action: 'create', name, message: note, changed: [] });
        }
      } catch (err) {
        if (err instanceof DomainError) return skip(err.message);
        if (err instanceof OrgValidationError) return skip(err.message);
        throw err;
      }
    });
    return { rows, writes };
  }

  // ---- mail templates

  const templateView = (t: TemplateRow): OrgTemplateView => ({ id: t.id, name: t.name, subject: t.subject, body: t.body, version: t.version, updatedAt: t.updated_at, updatedByName: nameOf(t.updated_by) });

  app.get('/api/organizations/templates', async (request): Promise<OrgTemplateView[]> => {
    member(request);
    return store.templates().map(templateView);
  });

  app.post('/api/organizations/templates', async (request, reply) => {
    const user = member(request);
    const input = checked(() => validateTemplate(request.body));
    return reply.code(201).send(templateView(store.createTemplate(input, user.id, deps.clock())));
  });

  app.put('/api/organizations/templates/:templateId', async (request): Promise<OrgTemplateView> => {
    const user = member(request);
    const { templateId } = deps.parse(templateParams, request.params);
    const body = deps.parse(templateBody, request.body);
    const input = checked(() => validateTemplate(body.template));
    const result = store.updateTemplate(templateId, body.expectedVersion, input, user.id, deps.clock());
    if (result === null) throw notFound();
    if (result === 'conflict') throw new DomainError('conflict', 'ほかの人が先にこのテンプレートを変更しました。読み込み直してから、もう一度変更してください。');
    return templateView(result);
  });

  app.delete('/api/organizations/templates/:templateId', async (request, reply) => {
    administrator(request);
    const { templateId } = deps.parse(templateParams, request.params);
    if (!store.deleteTemplate(templateId)) throw notFound();
    return reply.code(204).send();
  });

  // ---- mail batches: 下見 (create a draft with the text checked per organization), 添付 (draft only), 確認 (GET),
  // 送信 (POST send)

  /** The From mailbox the person may send from now (the sending service's own check is repeated when it sends). */
  const fromBox = (user: User, mailboxId: string): { mailboxId: string; address: string } => {
    const sender = sendingOrFail();
    const box = sender.options(user).from.find((m) => m.mailboxId === mailboxId);
    if (!box) throw new DomainError('forbidden', 'この受信箱のアドレスから送る権限がありません。権限管理者に、受信箱の送信権限を依頼してください。');
    return { mailboxId: box.mailboxId, address: box.address };
  };

  const ownerName = (ownerId: string | null): string => ownerOf(ownerId)?.displayName ?? '';

  /** One message of the batch: the text for one organization, or why it is not sent. */
  const batchItem = (org: OrgRow, subject: string, text: string) => {
    const contact = contactOf(org.data.contactId);
    const toAddress = contact?.data.emails[0]?.address ?? '';
    const toName = contact?.data.name ?? '';
    const values = mailValues({
      name: org.data.name,
      fiscalYear: org.data.fiscalYear,
      kind: org.data.kind,
      status: org.data.status,
      amountYen: org.data.amountYen,
      content: org.data.content,
      nextAction: org.data.nextAction,
      nextDue: org.data.nextDue,
      department: org.data.department,
      ownerName: ownerName(org.data.ownerId),
      contactName: toName,
    });
    const s = renderMail(subject, values, true);
    const b = renderMail(text, values);
    const empty = [...new Set([...s.empty, ...b.empty])];
    const reasons: string[] = [];
    if (!toAddress) reasons.push('宛先がありません（相手の担当者の連絡先にメールアドレスを入れてください）');
    if (empty.length > 0) reasons.push(`差し込みが空です（${empty.map((e) => `{${e}}`).join('、')}）。団体の内容を入れてから作り直してください`);
    if (s.text.length > MAIL_SUBJECT_MAX) reasons.push(`件名が ${MAIL_SUBJECT_MAX} 字を超えています（差し込んだあとの長さ）。件名を短くするか、団体の内容を短くしてください`);
    if (b.text.length > MAIL_BODY_MAX) reasons.push(`本文が ${MAIL_BODY_MAX.toLocaleString('ja-JP')} 字を超えています（差し込んだあとの長さ）`);
    // The same subject was sent to this organization before: held back by default (a changed subject sends it).
    const sameBefore = store.mailSentTo(org.id).find((m) => m.subject === s.text);
    if (sameBefore) reasons.push(`同じ件名「${s.text}」を ${sameBefore.at.slice(0, 10)} に送っています。件名を変えると送れます`);
    return { org_id: org.id, org_name: org.data.name, to_address: toAddress, to_name: toName, subject: s.text, body: b.text, skip_reason: reasons.length > 0 ? reasons.join('。') : null };
  };

  /**
   * Why a message is held back at the moment it would go out: another batch sent the same subject to the organization,
   * is sending it, or may have sent it (two previews of one subject made before either was sent). Checked right before
   * each message, with no await in between, so two batches sending at once cannot both send it.
   */
  const sentElsewhere = (orgId: string, subject: string, batchId: string): string | null => {
    const sent = store.mailSentTo(orgId).find((m) => m.batchId !== batchId && m.subject === subject);
    const other = store.sameSubjectInOtherBatches(orgId, subject, batchId).find((m) => m.status === 'sent' || m.status === 'sending' || m.status === 'unknown');
    if (sent || other?.status === 'sent') {
      return `同じ件名「${subject}」を ${(sent?.at ?? other!.at).slice(0, 10)} にこの団体へ送っています（別の一斉送信）。二重に送らないよう、送りませんでした。件名を変えると送れます`;
    }
    if (other) return `別の一斉送信が同じ件名「${subject}」をこの団体へ送っているところか、届いたか確認できていません。二重に送らないよう、送りませんでした`;
    return null;
  };

  /**
   * A note for a message not sent yet (not about this batch): the same subject went out, is going out or waits in
   * another batch (only the first one sent arrives; the later one is held back when it is sent), or a different
   * subject was sent before.
   */
  const priorWarning = (orgId: string, subject: string, batchId: string): string | null => {
    const sent = store.mailSentTo(orgId).filter((m) => m.batchId !== batchId);
    const others = store.sameSubjectInOtherBatches(orgId, subject, batchId);
    const same = sent.find((m) => m.subject === subject) ?? others.find((m) => m.status === 'sent');
    if (same) return `この団体には ${same.at.slice(0, 10)} に同じ件名を別の一斉送信で送っています。送る時点で止めます（二重には送りません）`;
    if (others.some((m) => m.status === 'sending' || m.status === 'unknown')) return '別の一斉送信が同じ件名をこの団体へ送っているところか、届いたか確認できていません。送る時点で止めます（二重には送りません）';
    const waiting = others.find((m) => m.status === 'pending' || m.status === 'failed');
    if (waiting) return `同じ件名でこの団体あての送信待ちが、別の一斉送信（${waiting.at.slice(0, 10)} に作成）にもあります。先に送ったほうだけが届き、あとから送るほうは止めます`;
    const other = sent.find((m) => m.subject !== subject);
    return other ? `この団体には ${other.at.slice(0, 10)} に別の件名「${other.subject}」を送っています` : null;
  };

  const batchView = (b: BatchRow): OrgMailBatch => {
    const items = store.batchItems(b.id);
    const counts = Object.fromEntries(ITEM_STATUSES.map((k) => [k, 0])) as Record<ItemStatus, number>;
    for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
    return {
      id: b.id,
      status: b.status,
      mailboxId: b.mailbox_id,
      mailboxAddress: b.mailbox_address,
      templateName: b.template_name,
      subject: b.subject,
      createdAt: b.created_at,
      counts,
      items: items.map((i): OrgMailItem => ({
        index: i.idx,
        orgId: i.org_id,
        orgName: i.org_name,
        toAddress: i.to_address,
        toName: i.to_name,
        subject: i.subject,
        body: i.body,
        skipReason: i.skip_reason,
        warning: i.status === 'pending' ? priorWarning(i.org_id, i.subject, b.id) : null,
        status: i.status,
        error: i.error,
        sentAt: i.sent_at,
      })),
      attachments: store.batchAttachmentMeta(b.id).map((a): OrgMailAttachment => ({ index: a.index, filename: a.filename, size: a.size })),
      notice: b.notice,
    };
  };

  const batchSummary = (b: BatchRow): OrgMailBatchSummary => {
    const counts = Object.fromEntries(ITEM_STATUSES.map((k) => [k, 0])) as Record<ItemStatus, number>;
    for (const i of store.batchItems(b.id)) counts[i.status] = (counts[i.status] ?? 0) + 1;
    return { id: b.id, subject: b.subject, mailboxAddress: b.mailbox_address, createdAt: b.created_at, counts };
  };

  const ownBatch = (userId: string, batchId: string): BatchRow => {
    const b = store.batch(batchId);
    if (!b || b.created_by !== userId) throw notFound();
    return b;
  };

  app.post('/api/organizations/mail/batches', async (request, reply) => {
    const user = mailMember(request);
    const body = deps.parse(batchBody, request.body);
    if (body.organizationIds.length > ORG_LIMITS.batch) {
      throw new DomainError('validation', `一斉送信は ${ORG_LIMITS.batch} 団体までです（今は ${body.organizationIds.length} 団体）。団体を減らしてください。`, { field: 'organizationIds' });
    }
    const from = fromBox(user, body.mailboxId);
    const known = store.batchByToken(body.clientToken);
    if (known) {
      if (known.created_by !== user.id) throw new DomainError('conflict', 'この下見は別の人が作りました。画面を読み込み直してください。');
      return batchView(known);
    }
    let subject: string;
    let text: string;
    let templateName: string | null = null;
    if (body.templateId) {
      const t = store.template(body.templateId);
      if (!t) throw notFound();
      subject = t.subject;
      text = t.body;
      templateName = t.name;
    } else {
      const t = checked(() => validateTemplate({ name: '一斉送信', subject: body.subject ?? '', body: body.body ?? '' }));
      subject = t.subject;
      text = t.body;
    }
    if (new Set(body.organizationIds).size !== body.organizationIds.length) throw new DomainError('validation', '同じ団体が 2 回選ばれています。');
    const orgs: OrgRow[] = [];
    for (const id of body.organizationIds) {
      const row = store.get(id);
      if (!row) throw new DomainError('validation', '選んだ団体の一部が見つかりません（削除された可能性があります）。一覧を読み直してください。');
      orgs.push(row);
    }
    const nowIso = new Date(deps.now()).toISOString();
    const batch = store.createBatch(
      { id: `mb_${randomBytes(8).toString('hex')}`, client_token: body.clientToken, created_by: user.id, created_at: nowIso, mailbox_id: from.mailboxId, mailbox_address: from.address, template_name: templateName, subject },
      orgs.map((org) => batchItem(org, subject, text)),
    );
    return reply.code(201).send(batchView(batch));
  });

  /** The batches of this person that are started and not finished, for the screen to offer again. */
  // The screen asks for this list on every reload: the mail's sign-in is checked without recording a use (mailPeek),
  // so that looking at the list does not extend the time before the password is asked again.
  app.get('/api/organizations/mail/batches', async (request): Promise<{ items: OrgMailBatchSummary[] }> => {
    const user = member(request);
    deps.mailPeek(request);
    return { items: store.openBatchesOf(user.id).map(batchSummary) };
  });

  app.get('/api/organizations/mail/batches/:batchId', async (request): Promise<OrgMailBatch> => {
    const user = mailMember(request);
    const { batchId } = deps.parse(batchParams, request.params);
    return batchView(ownBatch(user.id, batchId));
  });

  /**
   * Sends up to `sendChunk` messages of the batch in this request (the screen repeats the request until nothing is
   * left). A message goes out alone, to one address, through the sending service with a token of its own: sending
   * it again can never send it twice. A message whose outcome is not known is never sent again. A retry (includeFailed)
   * walks the batch forward with `afterIndex` (the answer's `lastIndex`), so each failed message is tried once per retry.
   */
  app.post('/api/organizations/mail/batches/:batchId/send', async (request): Promise<{ batch: OrgMailBatch; stopped: boolean; lastIndex: number | null }> => {
    const user = mailMember(request);
    const { batchId } = deps.parse(batchParams, request.params);
    const body = deps.parse(sendBody, request.body);
    const batch = ownBatch(user.id, batchId);
    const sender = sendingOrFail();
    fromBox(user, batch.mailbox_id);
    // Finished: nothing is left to send, so the answer is the batch as it stands.
    if (batch.status === 'done') return { batch: batchView(batch), stopped: false, lastIndex: null };
    const startedMs = deps.now();
    const nowIso = new Date(startedMs).toISOString();
    if (!store.claimBatch(batchId, user.id, nowIso, new Date(startedMs - SEND_STALE_MS).toISOString())) {
      throw new DomainError('conflict', 'この一斉送信はいま送信中です。少し待ってから画面を確かめてください。');
    }
    let notice: string | null = null;
    let stopped = false;
    let lastIndex: number | null = null;
    try {
      const attachments: OutgoingAttachment[] = store.batchAttachments(batchId).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content }));
      const items = store.nextItems(batchId, ORG_LIMITS.sendChunk, body.includeFailed, body.afterIndex ?? -1);
      for (const item of items) {
        lastIndex = item.idx;
        const held = sentElsewhere(item.org_id, item.subject, batchId);
        if (held) {
          store.skipItem(batchId, item.idx, held);
          continue;
        }
        store.setItem(batchId, item.idx, { status: 'sending' });
        const to = item.to_name ? recipientText(item.to_name, item.to_address) : item.to_address;
        try {
          const result = await sender.sendMail(
            user,
            { clientToken: item.send_token, mailboxId: batch.mailbox_id, to: [to], cc: [], bcc: [], subject: item.subject, body: item.body, replyToReceiptId: null, markThreadDone: false, replyTo: null },
            attachments,
            new Date(deps.now()),
          );
          const sentAt = new Date(deps.now()).toISOString();
          store.setItem(batchId, item.idx, { status: 'sent', receiptId: result.receiptId, sentAt });
          // The line in the organization's history is written apart: the message is sent, so a failure here changes nothing.
          try {
            store.recordMail(item.org_id, user.id, sentAt, { subject: item.subject, sent: 1, batchId });
          } catch {
            // The history line is missing; the batch still shows the message as sent.
          }
        } catch (err) {
          const code = err instanceof HttpError ? String(err.body.error) : err instanceof DomainError ? err.code : '';
          if (code === 'too_many_sends') {
            // Refused before anything was stored: the message stays pending for a later request.
            store.setItem(batchId, item.idx, { status: 'pending' });
            notice = 'この時間に送れる上限に達したため、ここで止めました。残りは時間をおいてから「続きを送る」で送れます。';
            stopped = true;
            break;
          }
          if (code === 'forbidden' || code === 'mail_unavailable' || code === 'send_unavailable') {
            // The grant or the setting is gone: nothing was sent, and no further message is tried now.
            store.setItem(batchId, item.idx, { status: 'pending' });
            notice = 'この受信箱から送る権限がないか、送信の設定が使えないため、ここで止めました。';
            stopped = true;
            break;
          }
          if (code === SEND_UNKNOWN || code === SEND_DUPLICATE) {
            store.setItem(batchId, item.idx, { status: 'unknown', error: '届いたか確認できていません。再送はしていません。' });
            notice = '届いたか確認できていない宛先があります。その宛先は再送せず、委員会の Gmail の送信済みで確かめてください。';
          } else if (code === 'send_failed' || code === 'validation') {
            // Refused before the message was handed over: it can be sent again with 再送.
            const message = err instanceof Error ? err.message : '送れませんでした。';
            store.setItem(batchId, item.idx, { status: 'failed', error: message });
          } else {
            store.setItem(batchId, item.idx, { status: 'unknown', error: '送信の結果を確かめられませんでした。再送はしていません。' });
            notice = '送信の結果を確かめられなかった宛先があります。その宛先は再送せず、委員会の Gmail の送信済みで確かめてください。';
          }
        }
      }
    } finally {
      store.finishBatch(batchId, notice, new Date(deps.now()).toISOString());
    }
    return { batch: batchView(ownBatch(user.id, batchId)), stopped, lastIndex };
  });

  // Shared attachments of a draft: the same files go with every message of the batch. Multipart, in a scope of its
  // own (the way the mail send takes its files); the limits are the sending setting's.
  void app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: Math.max(deps.attachmentBytes, 1), files: MAIL_ATTACHMENTS_MAX, fields: 0, parts: MAIL_ATTACHMENTS_MAX + 1 } });
    scope.post('/api/organizations/mail/batches/:batchId/attachments', { bodyLimit: deps.attachmentBytes + 1024 * 1024 }, async (request): Promise<OrgMailBatch> => {
      const user = mailMember(request);
      const { batchId } = deps.parse(batchParams, request.params);
      const batch = ownBatch(user.id, batchId);
      fromBox(user, batch.mailbox_id);
      if (batch.status !== 'draft') throw new DomainError('validation', 'この一斉送信は送信が始まっているため、添付は変えられません。');
      if (!request.isMultipart()) throw new DomainError('validation', 'multipart/form-data の形式で添付を送ってください。');
      const files: { filename: string; contentType: string; content: Buffer }[] = [];
      try {
        for await (const part of request.parts()) {
          if (part.type !== 'file' || part.fieldname !== 'attachments') throw new DomainError('validation', '添付の送信フィールドを確認してください。');
          files.push({ filename: attachmentName(part.filename), contentType: attachmentType(part.mimetype), content: await part.toBuffer() });
        }
      } catch (err) {
        attachmentFormError(err, deps.attachmentBytes);
      }
      if (files.length === 0) throw new DomainError('validation', '添付するファイルを選んでください。', { field: 'attachments' });
      const current = store.batchAttachmentMeta(batchId);
      if (current.length + files.length > MAIL_ATTACHMENTS_MAX) throw new DomainError('validation', `添付ファイルは ${MAIL_ATTACHMENTS_MAX} 個までです。`, { field: 'attachments' });
      const total = current.reduce((n, a) => n + a.size, 0) + files.reduce((n, f) => n + f.content.length, 0);
      if (total > deps.attachmentBytes) throw new DomainError('validation', `添付ファイルは合わせて ${Math.floor(deps.attachmentBytes / 1024 / 1024)} MB までです。`, { field: 'attachments' });
      store.addBatchAttachments(batchId, files);
      return batchView(ownBatch(user.id, batchId));
    });
  });

  app.delete('/api/organizations/mail/batches/:batchId/attachments/:attachmentIndex', async (request): Promise<OrgMailBatch> => {
    const user = mailMember(request);
    const { batchId, attachmentIndex } = deps.parse(attachmentParams, request.params);
    const batch = ownBatch(user.id, batchId);
    if (batch.status !== 'draft') throw new DomainError('validation', 'この一斉送信は送信が始まっているため、添付は外せません。');
    if (!store.removeBatchAttachment(batchId, Number(attachmentIndex))) throw notFound();
    return batchView(ownBatch(user.id, batchId));
  });
}
