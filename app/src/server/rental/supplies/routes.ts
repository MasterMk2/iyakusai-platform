import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../../domain/types.js';
import type { Actor, RentalPermission, RentalStore } from '../store.js';
import { SupplyStore } from './store.js';
import { obj } from './validate.js';

// HTTP of the supply extension, under /api/rental/supplies, and its screen at /rental/supplies. The access
// rules are the rental ones (routes.ts access()): defining items, stock corrections and attachment
// definitions need rental.issue; lending, returning, using up, checking attachments and undoing a loan
// need rental.loan; reading needs either. Every check is made here on the server.

type Result = readonly [number, unknown];

export interface SupplyRouteContext {
  store: RentalStore;
  /** The rental access check of routes.ts (signed-in account, rental permission, 403 messages). */
  access: (request: FastifyRequest, needed: readonly RentalPermission[] | null) => { user: User; actor: Actor; permissions: RentalPermission[] };
  /** The rental error mapping of routes.ts, so these answers keep the `{ error, code }` shape. */
  respond: (reply: FastifyReply, fn: () => Result | Promise<Result>) => Promise<FastifyReply>;
  /** Built phone screen directory (dist/rental-web); null serves no screen. */
  webDir: string | null;
  /** The same security headers as the rental screen. */
  csp: string;
  permissionsPolicy: string;
}

const PREFIX = '/api/rental/supplies';
const READ: readonly RentalPermission[] = ['rental.loan', 'rental.issue'];
const LOAN: readonly RentalPermission[] = ['rental.loan'];
const ISSUE: readonly RentalPermission[] = ['rental.issue'];
const PAGE_FILES = ['supplies.html', 'supplies.js', 'supplies.css'] as const;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function registerSupplyRoutes(app: FastifyInstance, ctx: SupplyRouteContext): void {
  const supplies = new SupplyStore(ctx.store);
  const run = (reply: FastifyReply, fn: () => Result | Promise<Result>) => ctx.respond(reply, fn);

  app.get(PREFIX, async (request, reply) => run(reply, () => {
    ctx.access(request, READ);
    return [200, supplies.snapshot()];
  }));

  app.get(`${PREFIX}/movements`, async (request, reply) => run(reply, () => {
    ctx.access(request, READ);
    const q = request.query as Record<string, unknown>;
    const limit = typeof q.limit === 'string' && /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : 40;
    return [200, { movements: supplies.movements(q.item_id, limit) }];
  }));

  app.get(`${PREFIX}/board`, async (request, reply) => run(reply, () => {
    ctx.access(request, READ);
    const q = request.query as Record<string, unknown>;
    return [200, supplies.board(q.group)];
  }));

  app.get(`${PREFIX}/collection`, async (request, reply) => run(reply, () => {
    ctx.access(request, READ);
    return [200, { groups: supplies.collection() }];
  }));

  app.get(`${PREFIX}/shortages`, async (request, reply) => run(reply, () => {
    ctx.access(request, READ);
    return [200, { shortages: supplies.shortages() }];
  }));

  app.get(`${PREFIX}/attachments`, async (request, reply) => run(reply, () => {
    ctx.access(request, READ);
    const q = request.query as Record<string, unknown>;
    return [200, supplies.attachments(q.owner_kind, q.owner_key)];
  }));

  app.post(`${PREFIX}/items`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, ISSUE);
    return [201, supplies.createItem(obj(request.body), actor)];
  }));

  app.patch<{ Params: { id: string } }>(`${PREFIX}/items/:id`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, ISSUE);
    return [200, supplies.updateItem(request.params.id, obj(request.body), actor)];
  }));

  app.post<{ Params: { id: string } }>(`${PREFIX}/items/:id/stock`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, ISSUE);
    return [200, supplies.adjustStock(request.params.id, obj(request.body), actor)];
  }));

  app.post(`${PREFIX}/lend`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, LOAN);
    return [200, supplies.lend(obj(request.body), actor)];
  }));

  app.post(`${PREFIX}/return`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, LOAN);
    return [200, supplies.giveBack(obj(request.body), actor)];
  }));

  app.post(`${PREFIX}/consume`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, LOAN);
    return [200, supplies.consume(obj(request.body), actor)];
  }));

  app.post<{ Params: { id: string } }>(`${PREFIX}/movements/:id/reverse`, async (request, reply) => run(reply, () => {
    const { actor, permissions } = ctx.access(request, [...LOAN, ...ISSUE]);
    return [200, supplies.reverse(request.params.id, obj(request.body), actor, permissions)];
  }));

  app.post(`${PREFIX}/attachments`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, ISSUE);
    return [201, supplies.createAttachment(obj(request.body), actor)];
  }));

  app.patch<{ Params: { id: string } }>(`${PREFIX}/attachments/:id`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, ISSUE);
    return [200, supplies.updateAttachment(request.params.id, obj(request.body), actor)];
  }));

  app.post(`${PREFIX}/attachment-checks`, async (request, reply) => run(reply, () => {
    const { actor } = ctx.access(request, LOAN);
    const result = supplies.recordCheck(obj(request.body), actor);
    return [result.replay ? 200 : 201, result.check];
  }));

  // The screen: the same files for both paths, read once at start (like the phone screen in routes.ts).
  const pages = new Map<string, { data: Buffer; type: string }>();
  if (ctx.webDir) {
    for (const name of PAGE_FILES) {
      const file = path.join(ctx.webDir, name);
      if (existsSync(file)) pages.set(name, { data: readFileSync(file), type: TYPES[path.extname(name)]! });
    }
  }
  const sendPage = (reply: FastifyReply, name: string) => {
    const page = pages.get(name);
    if (!page) return reply.code(404).send({ error: 'ファイルが見つかりません。', code: 'not_found' });
    return reply.header('Content-Security-Policy', ctx.csp).header('Permissions-Policy', ctx.permissionsPolicy).header('Cache-Control', 'no-cache').type(page.type).send(page.data);
  };
  app.get('/rental/supplies', async (_request, reply) => sendPage(reply, 'supplies.html'));
  app.get('/rental/supplies/', async (_request, reply) => sendPage(reply, 'supplies.html'));
  app.get('/rental/supplies.js', async (_request, reply) => sendPage(reply, 'supplies.js'));
  app.get('/rental/supplies.css', async (_request, reply) => sendPage(reply, 'supplies.css'));
}
