import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_EDITOR_CLIENT } from '../../src/shared/site-editor.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import type { SiteEditorConfig } from '../../src/server/site-editor/config.js';
import { canonicalStringForBodyHash } from '../../src/server/tasks/signing.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SiteEditorAccessStore } from '../../src/server/site-editor/access.js';
import { ADMIN, seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// The website editor over HTTP in the demo composition (persona cookie), with a stand-in for WebGenEngine's server.
// Synthetic people and pages only.

const EDITOR = 'u-site-editor';
const PUBLISHER = 'u-site-publisher';
const OUTSIDER = 'u-site-outsider';
const TEMP = 'u-site-temp';
const KEY = Buffer.from('e5'.repeat(16) + 'f6'.repeat(16), 'hex');
const NOW = Date.parse('2026-11-23T10:00:00.000Z');

const CONFIG: SiteEditorConfig = {
  upstream: 'http://wge.invalid:8080',
  key: KEY,
  siteUrl: 'https://site.example.invalid/wge/',
  editors: { everyone: false, departments: ['広報課'], userIds: [] },
  publishers: { departments: [], userIds: [PUBLISHER] },
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}
let seen: Seen[];
/** What the stand-in answers next: [status, content type, body], or an Error to throw. */
let answer: [number, string, string] | Error;
let app: FastifyInstance;

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  seen.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0) });
  if (answer instanceof Error) throw answer;
  const [status, type, body] = answer;
  return new Response(status === 204 ? null : body, { status, headers: { 'content-type': type } });
}) as typeof fetch;

let accessDir: string;

async function build(siteEditor = true, access: SiteEditorAccessStore | null = null) {
  const seed = await seedState();
  seed.users.push(
    { id: EDITOR, displayName: '合成 広報', roleLabel: '総務部・広報課', email: 'koho@example.invalid', canManageAccess: false },
    { id: PUBLISHER, displayName: '合成 公開', roleLabel: '企画部', email: 'kokai@example.invalid', canManageAccess: false },
    { id: OUTSIDER, displayName: '合成 内務', roleLabel: '内務部', email: 'naimu@example.invalid', canManageAccess: false },
    { id: TEMP, displayName: '合成 臨時', roleLabel: '臨時スタッフ', email: 'temp@example.invalid', canManageAccess: false },
  );
  app = await buildApp({
    store: new StateStore(seed, null),
    listenPort: TEST_PORT,
    clock: () => new Date(NOW).toISOString(),
    siteEditor: siteEditor ? { config: CONFIG, fetch: fakeFetch, access } : null,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(userId: string | null, method: 'GET' | 'POST', url: string, body?: string, extra: Record<string, string> = {}): Promise<{ status: number; type: string; text: string; json: any }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: TEST_HOST,
      ...(method !== 'GET' ? { origin: `http://${TEST_HOST}`, 'content-type': 'application/json', 'x-wge-request': '1' } : {}),
      ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}),
      ...extra,
    },
    ...(body !== undefined ? { payload: body } : {}),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // not JSON
  }
  return { status: res.statusCode, type: String(res.headers['content-type'] ?? ''), text: res.body, json };
}

/** The svc-auth/v1 signature WebGenEngine checks, over what the stand-in received. */
function signedRight(s: Seen, path: string): boolean {
  const bodyHash = createHash('sha256').update(s.body).digest('hex');
  const canonical = canonicalStringForBodyHash(
    { client: s.headers['x-svc-client']!, method: s.method, path, timestamp: s.headers['x-svc-timestamp']!, nonce: s.headers['x-svc-nonce']!, actor: s.headers['x-svc-actor'] ?? '' },
    bodyHash,
  );
  return createHmac('sha256', KEY).update(canonical, 'utf8').digest('hex') === s.headers['x-svc-signature'];
}

beforeEach(async () => {
  seen = [];
  answer = [200, 'application/json; charset=utf-8', '{"wge":1,"ok":true}'];
  accessDir = mkdtempSync(path.join(tmpdir(), 'iyakusai-site-access-'));
  await build();
});
afterEach(async () => {
  await app?.close();
  rmSync(accessDir, { recursive: true, force: true });
});

describe('who may write and publish', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const put = (userId: string, body: unknown) => app.inject({ method: 'PUT', url: '/api/site-editor/access', headers: { host: TEST_HOST, origin: `http://${TEST_HOST}`, 'x-smm-csrf': '1', cookie: `${SESSION_COOKIE}=${userId}` }, payload: body as any });
  const rebuild = async () => {
    await app.close();
    await build(true, new SiteEditorAccessStore(path.join(accessDir, 'site-editor-access.json')));
  };

  it('starts from site-editor.json, and an access administrator can open it to everyone and choose publishers', async () => {
    await rebuild();
    const first = (await call(ADMIN, 'GET', '/api/site-editor/access')).json;
    expect(first.access).toMatchObject({ version: 0, editors: { everyone: false, departments: ['広報課'] }, publishers: { userIds: [PUBLISHER] }, updatedAt: null });
    expect(first.choices.departments).toEqual(expect.arrayContaining(['広報課', '内務部', '企画部']));
    expect(first.choices.people.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([EDITOR, OUTSIDER]));
    expect(first.choices.people.map((p: { id: string }) => p.id)).not.toContain(TEMP);
    expect((await call(OUTSIDER, 'GET', '/api/site-editor/meta')).json.canEdit).toBe(false);

    const saved = await put(ADMIN, { editors: { everyone: true, departments: [], userIds: [] }, publishers: { departments: ['内務部'], userIds: [] }, expectedVersion: 0 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().access).toMatchObject({ version: 1, editors: { everyone: true }, publishers: { departments: ['内務部'], userIds: [] }, updatedByName: expect.any(String) });
    // Everyone writes now; 内務部 publishes; the publisher named in the file no longer does.
    expect((await call(OUTSIDER, 'GET', '/api/site-editor/meta')).json).toMatchObject({ canEdit: true, canPublish: true });
    expect((await call(EDITOR, 'GET', '/api/site-editor/meta')).json).toMatchObject({ canEdit: true, canPublish: false });
    expect((await call(PUBLISHER, 'POST', '/site-editor/api/pages/top/publish', '{"revision":1}')).status).toBe(403);
    expect((await call(TEMP, 'GET', '/site-editor/api/ping')).status).toBe(403);

    // A stale save is refused, and so is a department or a person who is not a member.
    expect((await put(ADMIN, { editors: { everyone: false, departments: [], userIds: [] }, publishers: { departments: [], userIds: [] }, expectedVersion: 0 })).statusCode).toBe(409);
    expect((await put(ADMIN, { editors: { everyone: false, departments: ['存在しない部局'], userIds: [] }, publishers: { departments: [], userIds: [] }, expectedVersion: 1 })).statusCode).toBe(422);
    expect((await put(ADMIN, { editors: { everyone: false, departments: [], userIds: ['u-nobody'] }, publishers: { departments: [], userIds: [] }, expectedVersion: 1 })).statusCode).toBe(422);
  });

  it('is for access administrators only', async () => {
    await rebuild();
    expect((await call(EDITOR, 'GET', '/api/site-editor/access')).status).toBe(403);
    expect((await put(PUBLISHER, { editors: { everyone: true, departments: [], userIds: [] }, publishers: { departments: [], userIds: [] }, expectedVersion: 0 })).statusCode).toBe(403);
    expect((await call(ADMIN, 'GET', '/api/site-editor/meta')).json.canAdminister).toBe(true);
  });

  it('cannot be changed on a server without a place to keep it', async () => {
    expect((await put(ADMIN, { editors: { everyone: true, departments: [], userIds: [] }, publishers: { departments: [], userIds: [] }, expectedVersion: 0 })).statusCode).toBe(409);
  });
});

describe('the website editor', () => {
  it('tells each person what they may do, and nothing to people it does not name', async () => {
    expect((await call(EDITOR, 'GET', '/api/site-editor/meta')).json).toEqual({ enabled: true, canEdit: true, canPublish: false, canAdminister: false, editorUrl: '/site-editor/editor/posts.html', siteUrl: 'https://site.example.invalid/wge/' });
    expect((await call(PUBLISHER, 'GET', '/api/site-editor/meta')).json).toMatchObject({ canEdit: true, canPublish: true });
    expect((await call(ADMIN, 'GET', '/api/site-editor/meta')).json).toMatchObject({ canEdit: true, canPublish: true });
    expect((await call(OUTSIDER, 'GET', '/api/site-editor/meta')).json).toEqual({ enabled: true, canEdit: false, canPublish: false, canAdminister: false, editorUrl: null, siteUrl: null });
    expect((await call(TEMP, 'GET', '/api/site-editor/meta')).json).toMatchObject({ enabled: false, editorUrl: null });
    expect((await call(null, 'GET', '/api/site-editor/meta')).status).toBe(401);
  });

  it('is off without site-editor.json: the meta says so and the editor does not exist', async () => {
    await app.close();
    await build(false);
    expect((await call(ADMIN, 'GET', '/api/site-editor/meta')).json).toMatchObject({ enabled: false });
    expect((await call(ADMIN, 'GET', '/site-editor/editor/')).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('passes the editor and its saves on, signed with the person as the actor, with the body bytes and no cookie', async () => {
    answer = [200, 'text/html; charset=utf-8', '<!doctype html><title>WGE</title>'];
    const page = await call(EDITOR, 'GET', '/site-editor/editor/');
    expect(page.status).toBe(200);
    expect(page.type).toBe('text/html; charset=utf-8');
    expect(page.text).toContain('<title>WGE</title>');
    expect(seen[0]).toMatchObject({ url: 'http://wge.invalid:8080/editor/', method: 'GET' });
    expect(seen[0]!.headers['x-svc-client']).toBe(SITE_EDITOR_CLIENT);
    expect(seen[0]!.headers['x-svc-actor']).toBe(EDITOR);
    expect(seen[0]!.headers['x-svc-timestamp']).toBe(String(NOW));
    expect(signedRight(seen[0]!, '/editor/')).toBe(true);
    expect(seen[0]!.headers.cookie).toBeUndefined();

    answer = [200, 'application/json; charset=utf-8', '{"wge":1,"ok":true,"revision":4}'];
    const source = '{"source":"<Heading level=\\"1\\">合成の見出し</Heading>\\n","baseRevision":3}';
    const saved = await call(EDITOR, 'POST', '/site-editor/api/pages/top/draft', source);
    expect(saved.json).toEqual({ wge: 1, ok: true, revision: 4 });
    const s = seen[1]!;
    expect(s).toMatchObject({ url: 'http://wge.invalid:8080/api/pages/top/draft', method: 'POST' });
    expect(s.body.toString('utf8')).toBe(source);
    expect(s.headers['content-type']).toBe('application/json');
    expect(s.headers['x-wge-request']).toBe('1');
    expect(signedRight(s, '/api/pages/top/draft')).toBe(true);
    expect(Object.keys(s.headers).sort()).toEqual(['content-type', 'x-svc-actor', 'x-svc-client', 'x-svc-nonce', 'x-svc-signature', 'x-svc-timestamp', 'x-wge-request']);
    // Every request has its own nonce.
    expect(s.headers['x-svc-nonce']).not.toBe(seen[0]!.headers['x-svc-nonce']);
  });

  it('asks for the publishing right to publish or take a publish back', async () => {
    for (const action of ['publish', 'undo-publish']) {
      const refused = await call(EDITOR, 'POST', `/site-editor/api/pages/top/${action}`, '{"revision":1}');
      expect(refused.status).toBe(403);
      expect(refused.json).toMatchObject({ wge: 1, ok: false, reason: 'forbidden' });
      expect(refused.json.message).toContain('公開する権限がありません');
    }
    expect(seen).toHaveLength(0);
    expect((await call(PUBLISHER, 'POST', '/site-editor/api/pages/top/publish', '{"revision":1}')).status).toBe(200);
    expect((await call(ADMIN, 'POST', '/site-editor/api/pages/top/undo-publish', '{"versionId":2}')).status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['http://wge.invalid:8080/api/pages/top/publish', 'http://wge.invalid:8080/api/pages/top/undo-publish']);
  });

  it('refuses people it does not name, and people not signed in, before anything goes on', async () => {
    const page = await call(OUTSIDER, 'GET', '/site-editor/editor/');
    expect(page.status).toBe(403);
    expect(page.type).toContain('text/html');
    expect(page.text).toContain('編集する権限がありません');
    expect((await call(OUTSIDER, 'POST', '/site-editor/api/pages/top/draft', '{}')).json).toMatchObject({ wge: 1, ok: false, reason: 'forbidden' });
    expect((await call(TEMP, 'GET', '/site-editor/api/ping')).status).toBe(403);
    const signedOut = await call(null, 'GET', '/site-editor/api/ping');
    expect(signedOut.status).toBe(401);
    expect(signedOut.json).toMatchObject({ wge: 1, ok: false, reason: 'unauthenticated' });
    expect((await call(null, 'GET', '/site-editor/editor/')).text).toContain('ログイン');
    expect(seen).toHaveLength(0);
  });

  it('lets through only the editor\'s own paths', async () => {
    for (const url of [
      '/site-editor/site/index.html',
      '/site-editor/server/Api.php',
      '/site-editor/source/php/Renderer.php',
      '/site-editor/editor/../server/Api.php',
      '/site-editor/editor/%2e%2e/server/Api.php',
      '/site-editor/editor//editor.mjs',
      '/site-editor/editor/editor.mjs?x=1',
      '/site-editor/editor/.hidden.js',
      '/site-editor/api/pages/Top!/draft',
      '/site-editor/api/pages/top/versions?all=1',
    ]) {
      expect((await call(ADMIN, 'GET', url)).status, url).toBe(404);
    }
    for (const url of ['/site-editor/api/ping', '/site-editor/api/pages/top/versions', '/site-editor/editor/editor.mjs']) {
      expect((await call(ADMIN, 'POST', url, '{}')).status, url).toBe(404);
    }
    expect((await call(ADMIN, 'GET', '/site-editor/api/pages/top/load')).status).toBe(404);
    expect(seen).toHaveLength(0);
    for (const url of ['/site-editor/editor/index.html', '/site-editor/editor/editor.mjs', '/site-editor/source/js/source-format.mjs', '/site-editor/source/theme.default.json', '/site-editor/api/pages/top/versions/12']) {
      expect((await call(EDITOR, 'GET', url)).status, url).toBe(200);
    }
  });

  it('sends the bare paths to the editor', async () => {
    for (const url of ['/site-editor', '/site-editor/']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${EDITOR}` } });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe('/site-editor/editor/posts.html');
    }
  });

  it('accepts JSON bodies only, and only from this origin', async () => {
    expect((await call(EDITOR, 'POST', '/site-editor/api/pages/top/draft', 'source=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await call(EDITOR, 'POST', '/site-editor/api/pages/top/draft', '{}', { origin: 'https://evil.example.invalid' })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('says the server is unreachable, in the editor\'s words, when it does not answer or answers what it should not', async () => {
    answer = new Error('connect ECONNREFUSED');
    const down = await call(EDITOR, 'GET', '/site-editor/api/ping');
    expect(down.status).toBe(502);
    expect(down.json).toMatchObject({ wge: 1, ok: false, reason: 'unavailable' });
    for (const [status, type] of [
      [403, 'application/json'],
      [302, 'text/html'],
      [401, 'application/json'],
    ] as const) {
      answer = [status, type, '{"wge":1,"ok":false,"reason":"forbidden"}'];
      expect((await call(EDITOR, 'GET', '/site-editor/api/ping')).status, String(status)).toBe(502);
    }
    // Its own answers about the page pass as they are, with a type from the allowed list.
    answer = [409, 'application/json', '{"wge":1,"ok":false,"reason":"conflict"}'];
    expect((await call(EDITOR, 'POST', '/site-editor/api/pages/top/draft', '{}')).json).toEqual({ wge: 1, ok: false, reason: 'conflict' });
    answer = [200, 'application/x-httpd-php', '<?php'];
    expect((await call(EDITOR, 'GET', '/site-editor/editor/editor.css')).type).toBe('application/octet-stream');
  });

  it('passes the blog\'s paths on: the list of pages, titles, pictures', async () => {
    for (const [method, url] of [
      ['GET', '/site-editor/editor/posts.html'],
      ['GET', '/site-editor/editor/posts.mjs'],
      ['GET', '/site-editor/api/pages'],
      ['POST', '/site-editor/api/pages/20261123-a1b2/meta'],
      ['POST', '/site-editor/api/media'],
      ['GET', '/site-editor/media/0123456789abcdef.jpg'],
    ] as const) {
      expect((await call(EDITOR, method, url, method === 'POST' ? '{}' : undefined)).status, url).toBe(200);
    }
    expect(seen.map((s) => s.url.replace('http://wge.invalid:8080', ''))).toEqual(['/editor/posts.html', '/editor/posts.mjs', '/api/pages', '/api/pages/20261123-a1b2/meta', '/api/media', '/media/0123456789abcdef.jpg']);
    for (const url of ['/site-editor/media/0123456789abcdef.svg', '/site-editor/media/../index.html', '/site-editor/media/x.jpg', '/site-editor/api/media/x']) {
      expect((await call(EDITOR, 'GET', url)).status, url).toBe(404);
    }
    answer = [200, 'image/png', 'png'];
    expect((await call(EDITOR, 'GET', '/site-editor/media/0123456789abcdef.png')).type).toBe('image/png');
    // The editor's own refusals of a picture pass as they are.
    answer = [415, 'application/json', '{"wge":1,"ok":false,"reason":"not-image"}'];
    expect((await call(EDITOR, 'POST', '/site-editor/api/media', '{}')).json).toMatchObject({ reason: 'not-image' });
  });

  it('passes deleting a post and restoring it on with the writing right, and lists the deleted posts', async () => {
    for (const [method, url] of [
      ['POST', '/site-editor/api/pages/20261123-a1b2/delete'],
      ['POST', '/site-editor/api/pages/20261123-a1b2/restore'],
      ['GET', '/site-editor/api/deleted-pages'],
    ] as const) {
      expect((await call(EDITOR, method, url, method === 'POST' ? '{}' : undefined)).status, url).toBe(200);
    }
    expect(seen.map((s) => `${s.method} ${s.url.replace('http://wge.invalid:8080', '')}`)).toEqual(['POST /api/pages/20261123-a1b2/delete', 'POST /api/pages/20261123-a1b2/restore', 'GET /api/deleted-pages']);
    expect(signedRight(seen[0]!, '/api/pages/20261123-a1b2/delete')).toBe(true);
    expect(seen[0]!.headers['x-svc-actor']).toBe(EDITOR);
    // Nobody else, and no other method or shape.
    expect((await call(OUTSIDER, 'POST', '/site-editor/api/pages/20261123-a1b2/delete', '{}')).status).toBe(403);
    for (const [method, url] of [
      ['GET', '/site-editor/api/pages/20261123-a1b2/delete'],
      ['POST', '/site-editor/api/deleted-pages'],
      ['POST', '/site-editor/api/pages/Bad!/delete'],
      ['POST', '/site-editor/api/pages/20261123-a1b2/purge'],
    ] as const) {
      expect((await call(EDITOR, method, url, method === 'POST' ? '{}' : undefined)).status, `${method} ${url}`).toBe(404);
    }
    expect(seen).toHaveLength(3);
    // The editor's server's refusal of a published post passes as it is.
    answer = [409, 'application/json', '{"wge":1,"ok":false,"reason":"published"}'];
    expect((await call(EDITOR, 'POST', '/site-editor/api/pages/20261123-a1b2/delete', '{}')).json).toEqual({ wge: 1, ok: false, reason: 'published' });
  });

  it('never caches what it passes on', async () => {
    const res = await app.inject({ method: 'GET', url: '/site-editor/editor/editor.css', headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${EDITOR}` } });
    expect(res.headers['cache-control']).toBe('no-store');
    // The app's own policy stays on the editor's page (it runs with it: no inline script, frames of this origin).
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
  });
});
