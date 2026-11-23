import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { compareDepartments } from '../../shared/departments.js';
import { SITE_EDITOR_CLIENT, SITE_EDITOR_LIMITS, SITE_EDITOR_PREFIX, type SiteEditorAccess, type SiteEditorAccessResponse, type SiteEditorMetaResponse } from '../../shared/site-editor.js';
import { DomainError, type User } from '../domain/types.js';
import { signedBytesHeaders } from '../tasks/signing.js';
import { effectiveAccess, type SiteEditorAccessStore } from './access.js';
import type { SiteEditorConfig } from './config.js';

// The website editor over HTTP (2026-11-23). WebGenEngine's editor and save API run in a container of their own (the
// "upstream"), which answers only the requests this app signs (svc-auth/v1, the person's account ID as the actor). Here:
// - only the editor's own paths go through, each by its method and an exact pattern (no query, escape or dot segment);
// - the editor and its saves need the writing right, publishing and taking a publish back the publishing right;
// - the upstream gets the body's bytes and two headers (the JSON type and the editor's X-WGE-Request), never a cookie;
// - the answer is its status, an allowed type and the body: no redirect is followed, with a time and a size limit.
// The published site is not served by this app: it has an origin of its own, so what members write there never shares
// this origin with the mail or the password book. Refusals of the editor's API carry `wge: 1`, a reason and a message,
// which the editor shows as they are and does not retry (WebGenEngine docs/design/server.md §6).
// Who may write and publish is chosen by the access administrators (GET/PUT /api/site-editor/access, access.ts).

export interface SiteEditorRuntime {
  config: SiteEditorConfig;
  /** The access administrators' choice (site-editor-access.json); absent: the configuration's lists, not changeable. */
  access?: SiteEditorAccessStore | null;
  /** Test seam: replaces the global fetch. */
  fetch?: typeof fetch;
}

export interface SiteEditorViewer {
  user: User;
  /** Department names from the person's roles. */
  departments: string[];
}

export interface SiteEditorRouteDeps {
  /** The signed-in committee member, or null for a person who may not use the editor. Throws when nobody is signed in. */
  viewer: (request: FastifyRequest) => SiteEditorViewer | null;
  /** The committee members who could be chosen (no temporary staff, no disabled accounts). */
  members: () => { id: string; name: string; departments: string[] }[];
  /** The roster name of an account, or a placeholder (never an ID). */
  nameOf: (userId: string) => string;
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

type Kind = 'page' | 'file' | 'api';

const PAGE_ID = '[a-z0-9][a-z0-9-]{0,63}';
const FILE = '(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(?:html|mjs|js|css|json|txt|svg)';
const P = SITE_EDITOR_PREFIX;
// The first match wins: the editor's pages before the files.
const ROUTES: { method: 'GET' | 'POST'; pattern: RegExp; kind: Kind; publish: boolean }[] = [
  { method: 'GET', pattern: new RegExp(`^${P}/editor/(?:index\\.html|posts\\.html)?$`), kind: 'page', publish: false },
  { method: 'GET', pattern: new RegExp(`^${P}/(?:editor|source)/${FILE}$`), kind: 'file', publish: false },
  // The pictures of the pages, for the editor's preview (WebGenEngine's blog.md): images only, never SVG.
  { method: 'GET', pattern: new RegExp(`^${P}/media/[0-9a-f]{16}\\.(?:jpg|png|gif|webp)$`), kind: 'file', publish: false },
  { method: 'GET', pattern: new RegExp(`^${P}/api/(?:ping|pages)$`), kind: 'api', publish: false },
  { method: 'POST', pattern: new RegExp(`^${P}/api/pages/${PAGE_ID}/(?:load|draft|meta)$`), kind: 'api', publish: false },
  { method: 'POST', pattern: new RegExp(`^${P}/api/media$`), kind: 'api', publish: false },
  { method: 'GET', pattern: new RegExp(`^${P}/api/pages/${PAGE_ID}/versions(?:/\\d{1,9})?$`), kind: 'api', publish: false },
  { method: 'POST', pattern: new RegExp(`^${P}/api/pages/${PAGE_ID}/(?:publish|undo-publish)$`), kind: 'api', publish: true },
];

const TYPES = new Map([
  ['text/html', 'text/html; charset=utf-8'],
  ['text/javascript', 'text/javascript; charset=utf-8'],
  ['text/css', 'text/css; charset=utf-8'],
  ['application/json', 'application/json; charset=utf-8'],
  ['text/plain', 'text/plain; charset=utf-8'],
  ['image/svg+xml', 'image/svg+xml'],
  ['image/jpeg', 'image/jpeg'],
  ['image/png', 'image/png'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
]);
// The editor's server answers these itself; anything else (a redirect, its refusal of the signature) is our fault.
const PASSED = new Set([200, 201, 400, 404, 405, 409, 413, 415, 422, 500, 503]);
const TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const SAID = {
  unauthenticated: 'ログインが切れています。統合アプリでログインし直してから、もう一度開いてください。書いた内容はこの画面に残っています。',
  edit: 'Webサイトを編集する権限がありません。権限管理者に依頼してください。',
  publish: '公開する権限がありません。公開は、公開の権限を持つ人か権限管理者に頼んでください。書いた内容は下書きとして保存されています。',
  unavailable: 'Webサイトの編集サーバーにつながりません。しばらくしてからもう一度試してください。続くときはシステム課に知らせてください。',
  notFound: 'ページが見つかりません。',
};

/** What a person may do with the editor: access administrators both; else as the lists that apply now say. */
export function siteEditorRights(access: SiteEditorAccess, viewer: SiteEditorViewer): { canEdit: boolean; canPublish: boolean } {
  const named = (p: { departments: string[]; userIds: string[] }) => p.userIds.includes(viewer.user.id) || p.departments.some((d) => viewer.departments.includes(d));
  const canPublish = viewer.user.canManageAccess || named(access.publishers);
  return { canEdit: canPublish || access.editors.everyone || named(access.editors), canPublish };
}

function refuse(reply: FastifyReply, kind: Kind, status: number, reason: string, message: string) {
  reply.code(status).header('Cache-Control', 'no-store');
  if (kind === 'api') return reply.send({ wge: 1, ok: false, reason, message });
  if (kind === 'file') return reply.send({ error: reason, message });
  // The editor's pages open in a tab of their own: a short page with the way back, instead of JSON.
  return reply
    .type('text/html; charset=utf-8')
    .send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Webサイトの編集</title></head><body><p>${message}</p><p><a href="/">統合アプリへ</a></p></body></html>`);
}

// eslint-disable-next-line no-control-regex
const line = z.string().min(1).max(100).refine((s) => !/[\u0000-\u001f\u007f]/.test(s));
const accessBody = z.strictObject({
  editors: z.strictObject({ everyone: z.boolean(), departments: z.array(line).max(SITE_EDITOR_LIMITS.departments), userIds: z.array(line).max(SITE_EDITOR_LIMITS.people) }),
  publishers: z.strictObject({ departments: z.array(line).max(SITE_EDITOR_LIMITS.departments), userIds: z.array(line).max(SITE_EDITOR_LIMITS.people) }),
  expectedVersion: z.number().int().min(0),
});

/** The editor's routes. A null runtime answers the meta route only (enabled: false); the rest do not exist. */
export async function registerSiteEditorRoutes(app: FastifyInstance, runtime: SiteEditorRuntime | null, deps: SiteEditorRouteDeps): Promise<void> {
  const accessNow = () => effectiveAccess(runtime!.config, runtime!.access ?? null, deps.nameOf);

  app.get('/api/site-editor/meta', async (request): Promise<SiteEditorMetaResponse> => {
    const viewer = deps.viewer(request);
    if (!runtime || !viewer) return { enabled: false, canEdit: false, canPublish: false, canAdminister: false, editorUrl: null, siteUrl: null };
    const rights = siteEditorRights(accessNow(), viewer);
    return { enabled: true, ...rights, canAdminister: viewer.user.canManageAccess, editorUrl: rights.canEdit ? `${P}/editor/posts.html` : null, siteUrl: rights.canEdit ? runtime.config.siteUrl : null };
  });
  if (!runtime) return;
  const { config } = runtime;
  const send = runtime.fetch ?? fetch;
  let keyWarned = false;

  // ---- who may write and publish (access administrators)

  const administrator = (request: FastifyRequest): SiteEditorViewer => {
    const viewer = deps.viewer(request);
    if (!viewer || !viewer.user.canManageAccess) throw new DomainError('forbidden', 'Webサイトを書ける人・公開できる人を選べるのは権限管理者だけです。');
    return viewer;
  };
  const accessResponse = (): SiteEditorAccessResponse => {
    const people = deps.members();
    return {
      access: accessNow(),
      choices: {
        departments: [...new Set(people.flatMap((p) => p.departments))].sort(compareDepartments),
        people: [...people].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
      },
    };
  };

  app.get('/api/site-editor/access', async (request): Promise<SiteEditorAccessResponse> => {
    administrator(request);
    return accessResponse();
  });

  app.put('/api/site-editor/access', async (request): Promise<SiteEditorAccessResponse> => {
    const viewer = administrator(request);
    const b = deps.parse(accessBody, request.body);
    const store = runtime.access;
    if (!store) throw new DomainError('conflict', 'このサーバーでは、書ける人・公開できる人を画面から変えられません（site-editor.json で決めています）。');
    const current = accessNow();
    if (current.version !== b.expectedVersion) throw new DomainError('conflict', 'ほかの人が先に変更しました。読み込み直してから、もう一度選んでください。');
    // A new choice names today's members and their departments; a name already chosen may stay (someone who left, a
    // department whose role was renamed), so a save never fails over it.
    const people = deps.members();
    const knownDepartments = new Set([...people.flatMap((p) => p.departments), ...current.editors.departments, ...current.publishers.departments]);
    const knownPeople = new Set([...people.map((p) => p.id), ...current.editors.userIds, ...current.publishers.userIds]);
    const unique = (list: string[]) => [...new Set(list)];
    for (const d of [...b.editors.departments, ...b.publishers.departments]) if (!knownDepartments.has(d)) throw new DomainError('validation', `委員の所属に「${d}」がありません。`);
    for (const id of [...b.editors.userIds, ...b.publishers.userIds]) if (!knownPeople.has(id)) throw new DomainError('validation', '委員の中にいない人が選ばれています。読み込み直してください。');
    store.write(
      {
        editors: { everyone: b.editors.everyone, departments: unique(b.editors.departments), userIds: unique(b.editors.userIds) },
        publishers: { departments: unique(b.publishers.departments), userIds: unique(b.publishers.userIds) },
        updatedAt: deps.clock(),
        updatedBy: viewer.user.id,
      },
      current.version + 1,
    );
    return accessResponse();
  });

  // ---- the editor itself

  app.get(P, async (_request, reply) => reply.redirect(`${P}/editor/posts.html`, 302));
  await app.register(async (scope) => {
    // The body goes on as the bytes it came in (they are signed); only JSON is accepted, as the editor sends.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_REQUEST_BYTES }, (_request, body, done) => done(null, body));
    scope.route({
      method: ['GET', 'POST'],
      url: `${P}/*`,
      bodyLimit: MAX_REQUEST_BYTES,
      handler: async (request, reply) => {
        const raw = request.raw.url ?? '';
        if (request.method === 'GET' && raw === `${P}/`) return reply.redirect(`${P}/editor/posts.html`, 302);
        const route = ROUTES.find((r) => r.method === request.method && r.pattern.test(raw));
        if (!route) return refuse(reply, raw.startsWith(`${P}/api/`) ? 'api' : 'file', 404, 'not-found', SAID.notFound);

        let viewer: SiteEditorViewer | null;
        try {
          viewer = deps.viewer(request);
        } catch (err) {
          if (err instanceof DomainError && err.code === 'unauthenticated') return refuse(reply, route.kind, 401, 'unauthenticated', SAID.unauthenticated);
          throw err;
        }
        const rights = viewer ? siteEditorRights(accessNow(), viewer) : null;
        if (!viewer || !rights?.canEdit) return refuse(reply, route.kind, 403, 'forbidden', SAID.edit);
        if (route.publish && !rights.canPublish) return refuse(reply, route.kind, 403, 'forbidden', SAID.publish);

        const body = request.method === 'POST' ? request.body : Buffer.alloc(0);
        if (!Buffer.isBuffer(body)) return refuse(reply, route.kind, 400, 'bad-request', 'リクエストの形式が正しくありません。');
        const path = raw.slice(P.length);
        const headers = signedBytesHeaders(config.key, { client: SITE_EDITOR_CLIENT, method: request.method, path, body, actor: viewer.user.id, now: Date.parse(deps.clock()) });
        if (request.method === 'POST') {
          headers['content-type'] = 'application/json';
          if (request.headers['x-wge-request'] === '1') headers['x-wge-request'] = '1';
        }

        let upstream: Response;
        try {
          upstream = await send(`${config.upstream}${path}`, {
            method: request.method,
            headers,
            body: request.method === 'POST' ? new Uint8Array(body) : undefined,
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch {
          return refuse(reply, route.kind, 502, 'unavailable', SAID.unavailable);
        }
        const length = Number(upstream.headers.get('content-length') ?? '0');
        if (!PASSED.has(upstream.status) || length > MAX_RESPONSE_BYTES) {
          if (upstream.status === 403 && !keyWarned) {
            // Said once, without the person: the two sides do not share the key or the client ID, or a clock is off.
            keyWarned = true;
            console.error('Webサイトの編集サーバーが署名を受け付けませんでした。site-editor.json の鍵と、編集サーバーの WGE_SVC_KEY_FILE・WGE_SVC_CLIENT・時計を確かめてください。');
          }
          await upstream.body?.cancel().catch(() => undefined);
          return refuse(reply, route.kind, 502, 'unavailable', SAID.unavailable);
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await upstream.arrayBuffer());
        } catch {
          return refuse(reply, route.kind, 502, 'unavailable', SAID.unavailable);
        }
        if (bytes.length > MAX_RESPONSE_BYTES) return refuse(reply, route.kind, 502, 'unavailable', SAID.unavailable);
        const type = TYPES.get((upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()) ?? 'application/octet-stream';
        return reply.code(upstream.status).header('Content-Type', type).header('Cache-Control', 'no-store').send(bytes);
      },
    });
  });
}
