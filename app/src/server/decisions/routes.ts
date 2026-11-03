import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { normalizeContactSearch } from '../../shared/contacts.js';
import {
  DECISION_APP_LINK,
  DECISION_CLIENT_TOKEN,
  DECISION_DATE,
  DECISION_DEPARTMENT_KEY,
  DECISION_LIMITS,
  DECISION_SOURCE_KINDS,
  DECISION_STATUSES,
  DECISION_TASK_ID,
  DECISION_VENUES,
  isDecisionDate,
  type DecisionDetailResponse,
  type DecisionInput,
  type DecisionListItem,
  type DecisionListResponse,
  type DecisionMetaResponse,
  type DecisionRef,
  type DecisionSource,
  type DecisionView,
} from '../../shared/decisions.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { MINUTES_TOKEN_PREFIX } from './from-minutes.js';
import { DecisionsStore, type DecisionRow, type WriteOutcome } from './store.js';

// Browser routes of the decision register. Every committee member reads and registers, edits and changes an active
// decision (the old one is kept as a changed record). Revoking and restoring are for the registrant and the access
// administrators. Temporary staff are refused here (reads too). Every route answers 404 when the register is off.

export interface DecisionRouteDeps {
  /**
   * The signed-in user, or null for a person who may not use the register (temporary staff, a non-member).
   * Throws when nobody is signed in.
   */
  viewer: (request: FastifyRequest) => User | null;
  /** The roster name of an account, or a placeholder (never an ID). */
  nameOf: (userId: string) => string;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BODY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const decisionParams = z.strictObject({ decisionId: z.string().regex(/^dc_[0-9a-f]{16}$/) });
const sourceSchema = z.strictObject({
  kind: z.enum(DECISION_SOURCE_KINDS),
  refId: z.string().max(DECISION_LIMITS.sourceRef).nullable(),
  label: z.string().max(DECISION_LIMITS.sourceLabel),
  link: z.string().max(DECISION_LIMITS.sourceLink).nullable(),
});
const inputShape = {
  title: z.string().max(DECISION_LIMITS.title).refine((s) => !CONTROL_LINE.test(s), { message: '1行で、使えない文字を入れないでください。' }),
  body: z.string().max(DECISION_LIMITS.body).refine((s) => !CONTROL_BODY.test(s), { message: '使えない文字が入っています。' }),
  departments: z.array(z.string().regex(DECISION_DEPARTMENT_KEY)).min(1).max(DECISION_LIMITS.departments),
  decidedOn: z.string().regex(DECISION_DATE),
  venue: z.enum(DECISION_VENUES),
  venueOther: z.string().max(DECISION_LIMITS.venueOther).refine((s) => !CONTROL_LINE.test(s), { message: '使えない文字が入っています。' }),
  sources: z.array(sourceSchema).max(DECISION_LIMITS.sources),
  taskIds: z.array(z.string().regex(DECISION_TASK_ID)).max(DECISION_LIMITS.taskIds),
};
type RawInput = z.infer<z.ZodObject<typeof inputShape>>;
const createBody = z.strictObject({
  ...inputShape,
  // The token of a minutes item is made by the server (see from-minutes.ts); a form cannot take one.
  clientToken: z
    .string()
    .regex(DECISION_CLIENT_TOKEN)
    .refine((t) => !t.startsWith(MINUTES_TOKEN_PREFIX), { message: '使えない記録の番号です。' }),
});
const updateBody = z.strictObject({ ...inputShape, expectedVersion: z.number().int().min(1) });
const changeBody = z.strictObject({ ...inputShape, expectedVersion: z.number().int().min(1), changeNote: z.string().max(DECISION_LIMITS.note) });
const revokeBody = z.strictObject({ expectedVersion: z.number().int().min(1), note: z.string().max(DECISION_LIMITS.note) });
const restoreBody = z.strictObject({ expectedVersion: z.number().int().min(1) });
const listQuery = z.strictObject({
  q: z.string().max(200).optional(),
  department: z.string().regex(DECISION_DEPARTMENT_KEY).optional(),
  status: z.enum(DECISION_STATUSES).optional(),
  from: z.string().regex(DECISION_DATE).optional(),
  to: z.string().regex(DECISION_DATE).optional(),
  sort: z.enum(['decided', 'changed']).default('decided'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(DECISION_LIMITS.pageSizeMax).default(20),
});

const invalid = (message: string, field?: string): never => {
  throw new DomainError('validation', message, field ? { field } : undefined);
};

/** The body after zod: trimmed, deduplicated, and the rules zod cannot state (a real day, a venue text, a link). */
export function normalizeDecisionInput(raw: RawInput): DecisionInput {
  const title = raw.title.trim();
  if (!title) invalid('決定の内容を入力してください。', 'title');
  if (!isDecisionDate(raw.decidedOn)) invalid('決めた日を正しい日付（YYYY-MM-DD）で入れてください。', 'decidedOn');
  const venueOther = raw.venue === 'other' ? raw.venueOther.trim() : '';
  if (raw.venue === 'other' && !venueOther) invalid('決めた場が「その他」のときは、場を書いてください。', 'venueOther');
  const departments = [...new Set(raw.departments)];
  const sources: DecisionSource[] = raw.sources.map((s, i) => {
    const label = s.label.trim();
    if (!label) invalid(`出典 ${i + 1} の名前を入れてください。`, 'sources');
    if (s.link !== null && s.link.trim() !== '' && !DECISION_APP_LINK.test(s.link.trim())) invalid(`出典 ${i + 1} のリンクはこのアプリの中の場所だけ使えます。`, 'sources');
    if (s.refId !== null && CONTROL_LINE.test(s.refId)) invalid(`出典 ${i + 1} の参照に使えない文字があります。`, 'sources');
    return { kind: s.kind, refId: s.refId?.trim() ? s.refId.trim() : null, label, link: s.link?.trim() ? s.link.trim() : null };
  });
  return {
    title,
    body: raw.body.replace(/\r\n/g, '\n').trimEnd(),
    departments,
    decidedOn: raw.decidedOn,
    venue: raw.venue,
    venueOther,
    sources,
    taskIds: [...new Set(raw.taskIds)],
  };
}

const terms = (q: string | undefined) => (q ? normalizeContactSearch(q).split(/\s+/).filter(Boolean).slice(0, 10) : []);

const REFUSED: Record<'conflict' | 'not_active' | 'not_revoked' | 'chain_busy', string> = {
  conflict: 'ほかの人が先に変更しました。最新の内容を読み込み直してから、もう一度操作してください。',
  not_active: 'この決定はすでに変更されたか、取り消されています。最新の内容を読み込み直してください。',
  not_revoked: 'この決定は取り消されていません。最新の内容を読み込み直してください。',
  chain_busy: '変更元の決定が、ほかの変更を受けているため戻せません。変更の流れを確かめてください。',
};

/** A write's answer as a record: not found, or a refusal, is thrown. */
function settled(outcome: WriteOutcome): DecisionRow {
  if (outcome === null) throw notFound();
  if (typeof outcome === 'string') throw new DomainError('conflict', REFUSED[outcome]);
  return outcome;
}

/** The register's routes. A null store answers the meta route only (enabled: false); the rest do not exist. */
export function registerDecisionRoutes(app: FastifyInstance, store: DecisionsStore | null, deps: DecisionRouteDeps): void {
  app.get('/api/decisions/meta', async (request): Promise<DecisionMetaResponse> => {
    const user = deps.viewer(request);
    const on = store !== null && user !== null;
    return { enabled: on, canRegister: on, canAdminister: on && !!user?.canManageAccess, departments: on ? store.departmentKeys() : [] };
  });
  if (!store) return;

  const member = (request: FastifyRequest): User => {
    const user = deps.viewer(request);
    if (!user) throw new DomainError('forbidden', '決定事項は委員だけが使えます。');
    return user;
  };
  const canRevoke = (user: User, row: DecisionRow) => user.canManageAccess || user.id === row.createdBy;

  const view = (row: DecisionRow, user: User | null): DecisionView => ({
    ...row.input,
    id: row.id,
    status: row.status,
    supersedes: row.supersedes,
    supersededBy: row.supersededBy,
    changeNote: row.changeNote,
    revokeNote: row.revokeNote,
    version: row.version,
    createdAt: row.createdAt,
    createdByName: deps.nameOf(row.createdBy),
    updatedAt: row.updatedAt,
    updatedByName: deps.nameOf(row.updatedBy),
    editable: row.status === 'active',
    canRevoke: !!user && canRevoke(user, row),
  });

  const ref = (row: DecisionRow): DecisionRef => ({ id: row.id, title: row.input.title, status: row.status, decidedOn: row.input.decidedOn, changeNote: row.changeNote });

  const detail = (row: DecisionRow, user: User | null, replayed?: boolean): DecisionDetailResponse => ({
    decision: view(row, user),
    chain: store.chain(row.id).map(ref),
    history: store.history(row.id).map((h) => ({ at: h.at, actorName: deps.nameOf(h.actorId), action: h.action, changed: h.changed })),
    ...(replayed !== undefined ? { replayed } : {}),
  });

  const listItem = (row: DecisionRow): DecisionListItem => ({
    id: row.id,
    title: row.input.title,
    departments: row.input.departments,
    decidedOn: row.input.decidedOn,
    venue: row.input.venue,
    status: row.status,
    supersedes: row.supersedes,
    supersededBy: row.supersededBy,
    changedAt: row.updatedAt,
  });

  app.get('/api/decisions', async (request): Promise<DecisionListResponse> => {
    member(request);
    const q = deps.parse(listQuery, request.query);
    // A day must exist (2026-02-30 is refused, not answered with an empty list).
    if (q.from !== undefined && !isDecisionDate(q.from)) throw new DomainError('validation', '日付は実在する日（YYYY-MM-DD）で入れてください。', { field: 'from' });
    if (q.to !== undefined && !isDecisionDate(q.to)) throw new DomainError('validation', '日付は実在する日（YYYY-MM-DD）で入れてください。', { field: 'to' });
    if (q.from !== undefined && q.to !== undefined && q.from > q.to) throw new DomainError('validation', '期間の終わりは始まりより後にしてください。', { field: 'to' });
    const page = store.page(
      { terms: terms(q.q), ...(q.department ? { department: q.department } : {}), ...(q.status ? { status: q.status } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) },
      q.sort,
      q.pageSize,
      (q.page - 1) * q.pageSize,
    );
    return { items: page.rows.map(listItem), total: page.total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/api/decisions', async (request, reply) => {
    const user = member(request);
    const body = deps.parse(createBody, request.body);
    const { clientToken, ...rest } = body;
    const result = store.create(normalizeDecisionInput(rest), user.id, deps.clock(), clientToken);
    return reply.code(result.replayed ? 200 : 201).send(detail(result.row, user, result.replayed));
  });

  app.get('/api/decisions/:decisionId', async (request): Promise<DecisionDetailResponse> => {
    const user = member(request);
    const { decisionId } = deps.parse(decisionParams, request.params);
    const row = store.get(decisionId);
    if (!row) throw notFound();
    return detail(row, user);
  });

  app.put('/api/decisions/:decisionId', async (request): Promise<DecisionDetailResponse> => {
    const user = member(request);
    const { decisionId } = deps.parse(decisionParams, request.params);
    const body = deps.parse(updateBody, request.body);
    const { expectedVersion, ...rest } = body;
    const row = settled(store.update(decisionId, expectedVersion, normalizeDecisionInput(rest), user.id, deps.clock()));
    return detail(row, user);
  });

  // A change: a new decision that replaces an active one. Answers the new decision (its chain shows the old one).
  app.post('/api/decisions/:decisionId/change', async (request, reply) => {
    const user = member(request);
    const { decisionId } = deps.parse(decisionParams, request.params);
    const body = deps.parse(changeBody, request.body);
    const { expectedVersion, changeNote, ...rest } = body;
    const note = changeNote.trim();
    if (!note) throw new DomainError('validation', '何を変えたかを一言書いてください。', { field: 'changeNote' });
    const result = store.supersede(decisionId, expectedVersion, normalizeDecisionInput(rest), note, user.id, deps.clock());
    if (result === null) throw notFound();
    if (typeof result === 'string') throw new DomainError('conflict', REFUSED[result]);
    return reply.code(201).send(detail(result.row, user));
  });

  app.post('/api/decisions/:decisionId/revoke', async (request): Promise<DecisionDetailResponse> => {
    const user = member(request);
    const { decisionId } = deps.parse(decisionParams, request.params);
    const body = deps.parse(revokeBody, request.body);
    const current = store.get(decisionId);
    if (!current) throw notFound();
    if (!canRevoke(user, current)) throw new DomainError('forbidden', '取り消せるのは登録した人と権限の管理者だけです。');
    const row = settled(store.revoke(decisionId, body.expectedVersion, body.note.trim(), user.id, deps.clock()));
    return detail(row, user);
  });

  app.post('/api/decisions/:decisionId/restore', async (request): Promise<DecisionDetailResponse> => {
    const user = member(request);
    const { decisionId } = deps.parse(decisionParams, request.params);
    const body = deps.parse(restoreBody, request.body);
    const current = store.get(decisionId);
    if (!current) throw notFound();
    if (!canRevoke(user, current)) throw new DomainError('forbidden', '取り消しを戻せるのは登録した人と権限の管理者だけです。');
    const row = settled(store.restore(decisionId, body.expectedVersion, user.id, deps.clock()));
    return detail(row, user);
  });
}
