import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SITE_EDITOR_CLIENT, SITE_EDITOR_PREFIX, type SiteEditorMetaResponse } from '../../shared/site-editor.js';
import { DomainError, type User } from '../domain/types.js';
import { signedBytesHeaders } from '../tasks/signing.js';
import type { SiteEditorConfig, SiteEditorPeople } from './config.js';

// The website editor over HTTP (2026-11-23). WebGenEngine's editor and save API run in a container of their own (the
// "upstream"), which answers only the requests this app signs (svc-auth/v1, the person's login ID as the actor). Here:
// - only the editor's own paths go through, each by its method and an exact pattern (no query, escape or dot segment);
// - the editor and its saves need the editing right, publishing and taking a publish back the publishing right;
// - the upstream gets the body's bytes and two headers (the JSON type and the editor's X-WGE-Request), never a cookie;
// - the answer is its status, an allowed type and the body: no redirect is followed, with a time and a size limit.
// The published site is not served by this app: it has an origin of its own, so what members write there never shares
// this origin with the mail or the password book. Refusals of the editor's API carry `wge: 1`, a reason and a message,
// which the editor shows as they are and does not retry (WebGenEngine docs/design/server.md §6).

export interface SiteEditorRuntime {
  config: SiteEditorConfig;
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
  /** Milliseconds; the signature's time. */
  now?: () => number;
}

type Kind = 'page' | 'file' | 'api';

const PAGE_ID = '[a-z0-9][a-z0-9-]{0,63}';
const FILE = '(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.(?:html|mjs|js|css|json|txt|svg)';
const P = SITE_EDITOR_PREFIX;
// The first match wins: the editor's page before the files.
const ROUTES: { method: 'GET' | 'POST'; pattern: RegExp; kind: Kind; publish: boolean }[] = [
  { method: 'GET', pattern: new RegExp(`^${P}/editor/(?:index\\.html)?$`), kind: 'page', publish: false },
  { method: 'GET', pattern: new RegExp(`^${P}/(?:editor|source)/${FILE}$`), kind: 'file', publish: false },
  { method: 'GET', pattern: new RegExp(`^${P}/api/ping$`), kind: 'api', publish: false },
  { method: 'POST', pattern: new RegExp(`^${P}/api/pages/${PAGE_ID}/(?:load|draft)$`), kind: 'api', publish: false },
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
]);
// The editor's server answers these itself; anything else (a redirect, its refusal of the signature) is our fault.
const PASSED = new Set([200, 201, 400, 404, 405, 409, 422, 500, 503]);
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

/** What a person may do with the editor: access administrators both; else as named by department or login ID. */
export function siteEditorRights(config: SiteEditorConfig, viewer: SiteEditorViewer): { canEdit: boolean; canPublish: boolean } {
  const named = (p: SiteEditorPeople) => p.userIds.includes(viewer.user.id) || p.departments.some((d) => viewer.departments.includes(d));
  const canPublish = viewer.user.canManageAccess || named(config.publishers);
  return { canEdit: canPublish || named(config.editors), canPublish };
}

function refuse(reply: FastifyReply, kind: Kind, status: number, reason: string, message: string) {
  reply.code(status).header('Cache-Control', 'no-store');
  if (kind === 'api') return reply.send({ wge: 1, ok: false, reason, message });
  if (kind === 'file') return reply.send({ error: reason, message });
  // The editor's page opens in a tab of its own: a short page with the way back, instead of JSON.
  return reply
    .type('text/html; charset=utf-8')
    .send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Webサイトの編集</title></head><body><p>${message}</p><p><a href="/">統合アプリへ</a></p></body></html>`);
}

/** The editor's routes. A null runtime answers the meta route only (enabled: false); the rest do not exist. */
export async function registerSiteEditorRoutes(app: FastifyInstance, runtime: SiteEditorRuntime | null, deps: SiteEditorRouteDeps): Promise<void> {
  app.get('/api/site-editor/meta', async (request): Promise<SiteEditorMetaResponse> => {
    const viewer = deps.viewer(request);
    if (!runtime || !viewer) return { enabled: false, canEdit: false, canPublish: false, editorUrl: null, siteUrl: null };
    const rights = siteEditorRights(runtime.config, viewer);
    return { enabled: true, ...rights, editorUrl: rights.canEdit ? `${P}/editor/` : null, siteUrl: rights.canEdit ? runtime.config.siteUrl : null };
  });
  if (!runtime) return;
  const { config } = runtime;
  const send = runtime.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let keyWarned = false;

  app.get(P, async (_request, reply) => reply.redirect(`${P}/editor/`, 302));
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
        if (request.method === 'GET' && raw === `${P}/`) return reply.redirect(`${P}/editor/`, 302);
        const route = ROUTES.find((r) => r.method === request.method && r.pattern.test(raw));
        if (!route) return refuse(reply, raw.startsWith(`${P}/api/`) ? 'api' : 'file', 404, 'not-found', SAID.notFound);

        let viewer: SiteEditorViewer | null;
        try {
          viewer = deps.viewer(request);
        } catch (err) {
          if (err instanceof DomainError && err.code === 'unauthenticated') return refuse(reply, route.kind, 401, 'unauthenticated', SAID.unauthenticated);
          throw err;
        }
        const rights = viewer ? siteEditorRights(config, viewer) : null;
        if (!viewer || !rights?.canEdit) return refuse(reply, route.kind, 403, 'forbidden', SAID.edit);
        if (route.publish && !rights.canPublish) return refuse(reply, route.kind, 403, 'forbidden', SAID.publish);

        const body = request.method === 'POST' ? request.body : Buffer.alloc(0);
        if (!Buffer.isBuffer(body)) return refuse(reply, route.kind, 400, 'bad-request', 'リクエストの形式が正しくありません。');
        const path = raw.slice(P.length);
        const headers = signedBytesHeaders(config.key, { client: SITE_EDITOR_CLIENT, method: request.method, path, body, actor: viewer.user.id, now: now() });
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
