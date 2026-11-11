import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BULLETIN_ID,
  BULLETIN_LIMITS,
  BULLETIN_LISTS,
  BULLETIN_TOKEN,
  bulletinExcerpt,
  bulletinPeriodProblem,
  bulletinPhase,
  bulletinTargets,
  type BulletinDetailResponse,
  type BulletinInput,
  type BulletinListItem,
  type BulletinListResponse,
  type BulletinMetaResponse,
  type BulletinReadResponse,
  type BulletinSummaryResponse,
  type BulletinView,
} from '../../shared/bulletin.js';
import { jstDate } from '../../shared/calendar.js';
import { compareDepartments } from '../../shared/departments.js';
import { DomainError, notFound, type User } from '../domain/types.js';
import { BulletinStore, type BulletinOutcome, type BulletinRow } from './store.js';

// Browser routes of the notice board. Every committee member reads the notices that are for them and writes
// notices; the writer and the access administrators correct, withdraw and put back, and see a notice whoever it is
// for. A notice for chosen departments is not shown to the other members (404, as if it did not exist). Temporary
// staff are refused, reads too. Every route but meta answers 404 when the board is off.

export interface BulletinViewer {
  user: User;
  /** The person's departments (names from their roles), temporary staff left out. */
  departments: string[];
}

export interface BulletinRouteDeps {
  /** The signed-in member, or null for a person who may not use the board. Throws when nobody is signed in. */
  viewer: (request: FastifyRequest) => BulletinViewer | null;
  /** The committee members (no temporary staff, no disabled accounts) with their departments. */
  members: () => { id: string; departments: string[] }[];
  /** The roster name of an account, or a placeholder (never an ID). */
  nameOf: (userId: string) => string;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BODY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const postParams = z.strictObject({ postId: z.string().regex(BULLETIN_ID) });
const inputShape = {
  title: z.string().max(BULLETIN_LIMITS.title).refine((s) => !CONTROL_LINE.test(s), { message: '1行で、使えない文字を入れないでください。' }),
  body: z.string().max(BULLETIN_LIMITS.body).refine((s) => !CONTROL_BODY.test(s), { message: '使えない文字が入っています。' }),
  important: z.boolean(),
  departments: z.array(z.string().min(1).max(BULLETIN_LIMITS.department).refine((s) => !CONTROL_LINE.test(s), { message: '使えない文字が入っています。' })).max(BULLETIN_LIMITS.departments),
  startsOn: z.string().regex(DATE).nullable(),
  endsOn: z.string().regex(DATE).nullable(),
};
type RawInput = z.infer<z.ZodObject<typeof inputShape>>;
const createBody = z.strictObject({ ...inputShape, clientToken: z.string().regex(BULLETIN_TOKEN) });
const updateBody = z.strictObject({ ...inputShape, expectedVersion: z.number().int().min(1), announce: z.boolean() });
const versionBody = z.strictObject({ expectedVersion: z.number().int().min(1) });
const listQuery = z.strictObject({
  list: z.enum(BULLETIN_LISTS).default('current'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(BULLETIN_LIMITS.pageSizeMax).default(20),
});

const invalid = (message: string, field: string): never => {
  throw new DomainError('validation', message, { field });
};

/** The body after zod: trimmed, deduplicated, and the rules zod cannot state (real days in order). */
export function normalizeBulletinInput(raw: RawInput, today: string | null): BulletinInput {
  const title = raw.title.trim();
  if (!title) invalid('件名を入力してください。', 'title');
  const departments = [...new Set(raw.departments.map((d) => d.trim()).filter(Boolean))].sort(compareDepartments);
  const problem = bulletinPeriodProblem(raw.startsOn, raw.endsOn, today);
  if (problem) invalid(problem, problem.startsWith('掲載開始日') ? 'startsOn' : 'endsOn');
  return { title, body: raw.body.replace(/\r\n/g, '\n').trimEnd(), important: raw.important, departments, startsOn: raw.startsOn, endsOn: raw.endsOn };
}

const REFUSED: Record<'conflict' | 'not_open' | 'not_withdrawn', string> = {
  conflict: 'ほかの人が先に変更しました。最新の内容を読み込み直してから、もう一度操作してください。',
  not_open: 'このお知らせは取り下げられています。最新の内容を読み込み直してください。',
  not_withdrawn: 'このお知らせは取り下げられていません。最新の内容を読み込み直してください。',
};

function settled(outcome: BulletinOutcome): BulletinRow {
  if (outcome === null) throw notFound();
  if (typeof outcome === 'string') throw new DomainError('conflict', REFUSED[outcome]);
  return outcome;
}

/** The board's routes. A null store answers the meta route only (enabled: false); the rest do not exist. */
export function registerBulletinRoutes(app: FastifyInstance, store: BulletinStore | null, deps: BulletinRouteDeps): void {
  const today = () => jstDate(new Date(deps.clock()));
  const choices = () => [...new Set(deps.members().flatMap((m) => m.departments))].sort(compareDepartments);

  app.get('/api/bulletin/meta', async (request): Promise<BulletinMetaResponse> => {
    const viewer = deps.viewer(request);
    const on = store !== null && viewer !== null;
    return { enabled: on, canPost: on, departments: on ? choices() : [], myDepartments: on ? viewer.departments : [], today: today() };
  });
  if (!store) return;

  const member = (request: FastifyRequest): BulletinViewer => {
    const viewer = deps.viewer(request);
    if (!viewer) throw new DomainError('forbidden', '掲示板は委員だけが使えます。');
    return viewer;
  };
  const canEdit = (v: BulletinViewer, row: BulletinRow) => v.user.canManageAccess || v.user.id === row.createdBy;
  const targeted = (v: BulletinViewer, row: BulletinRow) => bulletinTargets(row.input.departments, v.departments);
  /** May open it: an editor always; anyone it is for, once it is on the board (and after it ended), never while withdrawn. */
  const canSee = (v: BulletinViewer, row: BulletinRow, day: string) => {
    if (canEdit(v, row)) return true;
    const phase = bulletinPhase({ status: row.status, ...row.input }, day);
    return targeted(v, row) && (phase === 'current' || phase === 'ended');
  };
  const isUnread = (v: BulletinViewer, row: BulletinRow, day: string, reads: Map<string, string>) => {
    if (!targeted(v, row) || bulletinPhase({ status: row.status, ...row.input }, day) !== 'current') return false;
    const readAt = reads.get(row.id);
    return readAt === undefined || readAt < row.announcedAt;
  };
  /** The notices on the board that are new for this person, in the board's order. */
  const unreadRows = (v: BulletinViewer, day: string): BulletinRow[] => {
    const reads = store.readsOf(v.user.id);
    return store.list('current', day).filter((row) => isUnread(v, row, day, reads));
  };

  const listItem = (row: BulletinRow, v: BulletinViewer, day: string, reads: Map<string, string>): BulletinListItem => ({
    id: row.id,
    title: row.input.title,
    excerpt: bulletinExcerpt(row.input.body),
    important: row.input.important,
    departments: row.input.departments,
    startsOn: row.input.startsOn,
    endsOn: row.input.endsOn,
    phase: bulletinPhase({ status: row.status, ...row.input }, day),
    unread: isUnread(v, row, day, reads),
    announcedAt: row.announcedAt,
    authorName: deps.nameOf(row.createdBy),
  });

  const view = (row: BulletinRow, v: BulletinViewer, day: string): BulletinView => {
    const editor = canEdit(v, row);
    let readers: BulletinView['readers'] = null;
    if (editor) {
      const audience = deps.members().filter((m) => bulletinTargets(row.input.departments, m.departments)).map((m) => m.id);
      const read = new Set(store.readersSince(row.id, row.announcedAt));
      readers = { read: audience.filter((id) => read.has(id)).length, audience: audience.length };
    }
    return {
      ...row.input,
      id: row.id,
      status: row.status,
      phase: bulletinPhase({ status: row.status, ...row.input }, day),
      unread: isUnread(v, row, day, store.readsOf(v.user.id)),
      targeted: targeted(v, row),
      createdAt: row.createdAt,
      authorName: deps.nameOf(row.createdBy),
      updatedAt: row.updatedAt,
      updatedByName: deps.nameOf(row.updatedBy),
      edited: row.version > 1 && store.history(row.id).some((h) => h.action === 'updated'),
      announcedAt: row.announcedAt,
      version: row.version,
      canEdit: editor,
      readers,
    };
  };

  /** The notice, for a person who may open it; otherwise 404 (a notice for other departments is not revealed). */
  const visible = (request: FastifyRequest): { viewer: BulletinViewer; row: BulletinRow; day: string } => {
    const viewer = member(request);
    const { postId } = deps.parse(postParams, request.params);
    const row = store.get(postId);
    const day = today();
    if (!row || !canSee(viewer, row, day)) throw notFound();
    return { viewer, row, day };
  };
  const editable = (request: FastifyRequest) => {
    const found = visible(request);
    if (!canEdit(found.viewer, found.row)) throw new DomainError('forbidden', '直す・取り下げる・戻すことができるのは、書いた人と権限の管理者だけです。');
    return found;
  };

  app.get('/api/bulletin', async (request): Promise<BulletinListResponse> => {
    const viewer = member(request);
    const q = deps.parse(listQuery, request.query);
    const day = today();
    const reads = store.readsOf(viewer.user.id);
    const rows = store.list(q.list, day).filter((row) => canSee(viewer, row, day));
    const offset = (q.page - 1) * q.pageSize;
    return {
      list: q.list,
      items: rows.slice(offset, offset + q.pageSize).map((row) => listItem(row, viewer, day, reads)),
      total: rows.length,
      page: q.page,
      pageSize: q.pageSize,
      unreadTotal: q.list === 'current' ? rows.filter((row) => isUnread(viewer, row, day, reads)).length : unreadRows(viewer, day).length,
      today: day,
    };
  });

  app.get('/api/bulletin/summary', async (request): Promise<BulletinSummaryResponse> => {
    const viewer = member(request);
    const day = today();
    const reads = store.readsOf(viewer.user.id);
    const rows = unreadRows(viewer, day);
    return { unreadTotal: rows.length, items: rows.slice(0, BULLETIN_LIMITS.homeItems).map((row) => listItem(row, viewer, day, reads)) };
  });

  // Everything on the board for this person is read (the button above the list).
  app.post('/api/bulletin/read-all', async (request): Promise<BulletinReadResponse> => {
    const viewer = member(request);
    deps.parse(z.strictObject({}), request.body);
    const day = today();
    store.markRead(unreadRows(viewer, day).map((row) => row.id), viewer.user.id, deps.clock());
    return { unreadTotal: unreadRows(viewer, day).length };
  });

  app.post('/api/bulletin', async (request, reply) => {
    const viewer = member(request);
    const { clientToken, ...rest } = deps.parse(createBody, request.body);
    const day = today();
    const result = store.create(normalizeBulletinInput(rest, day), viewer.user.id, deps.clock(), clientToken);
    return reply.code(result.replayed ? 200 : 201).send({ post: view(result.row, viewer, day), replayed: result.replayed } satisfies BulletinDetailResponse);
  });

  app.get('/api/bulletin/:postId', async (request): Promise<BulletinDetailResponse> => {
    const { viewer, row, day } = visible(request);
    return { post: view(row, viewer, day) };
  });

  // Opening a notice on the screen: it is no longer new for this person.
  app.post('/api/bulletin/:postId/read', async (request): Promise<BulletinReadResponse> => {
    const { viewer, row, day } = visible(request);
    deps.parse(z.strictObject({}), request.body);
    if (isUnread(viewer, row, day, store.readsOf(viewer.user.id))) store.markRead([row.id], viewer.user.id, deps.clock());
    return { unreadTotal: unreadRows(viewer, day).length };
  });

  app.put('/api/bulletin/:postId', async (request): Promise<BulletinDetailResponse> => {
    const { viewer, row, day } = editable(request);
    const { expectedVersion, announce, ...rest } = deps.parse(updateBody, request.body);
    // The last day may stay in the past here: a correction of an ended notice does not have to move its days.
    const input = normalizeBulletinInput(rest, row.input.endsOn === rest.endsOn ? null : day);
    return { post: view(settled(store.update(row.id, expectedVersion, input, announce, viewer.user.id, deps.clock())), viewer, day) };
  });

  app.post('/api/bulletin/:postId/withdraw', async (request): Promise<BulletinDetailResponse> => {
    const { viewer, row, day } = editable(request);
    const body = deps.parse(versionBody, request.body);
    return { post: view(settled(store.withdraw(row.id, body.expectedVersion, viewer.user.id, deps.clock())), viewer, day) };
  });

  app.post('/api/bulletin/:postId/restore', async (request): Promise<BulletinDetailResponse> => {
    const { viewer, row, day } = editable(request);
    const body = deps.parse(versionBody, request.body);
    return { post: view(settled(store.restore(row.id, body.expectedVersion, viewer.user.id, deps.clock())), viewer, day) };
  });
}
