// 公開デモ（GitHub Pages）用に、合成データのサーバーが返す API の応答を録る。
//
//   npm run build
//   node scripts/pages-demo/record.mjs [--out .tmp/pages-demo/data] [--port 5191]
//
// 一時フォルダに合成データを作って demo モードのサーバーを起動し、ペルソナごとに画面を巡回して、
// 画面が読んだ /api/ の応答を JSON に書き出す。巡回は画面を開くだけで、ボタンは押さない。
// 開いただけで画面が送る書き込み（既読にする等）も録り、公開デモではそれだけ同じ応答を返す。
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// page.evaluate などに渡す関数はブラウザの中で動く
/* global window, document */

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 画面の区分（App.tsx・BooksView・BotView・SettingsView の一覧と同じ）。巡回の起点にするだけで、
// 画面の中のリンク（#/ で始まるもの）と応答の中の ID からも行き先を足す。
const BOOKS_SECTIONS = ['claims', 'ledger', 'reports', 'payments', 'yayoi', 'settings'];
const BOT_SECTIONS = ['ask', 'doc', 'mail', 'image', 'remind', 'candidates', 'minutes'];
const SETTINGS_SECTIONS = ['account', 'card', 'theme', 'signature', 'availability', 'managers', 'mail', 'line', 'accounting', 'rental', 'features', 'dayof', 'login', 'bank', 'rollover', 'directory'];
const SEED_ROUTES = [
  '#/home',
  '#/board',
  '#/board?new=1',
  '#/tasks',
  '#/tasks?new=1',
  '#/all',
  '#/all?filter=unhandled',
  '#/all?filter=mine',
  '#/all?compose=1',
  '#/all?approval=list',
  '#/line',
  '#/line?broadcast=1',
  '#/contacts',
  '#/contacts?new=1',
  '#/contacts?import=1',
  '#/decisions',
  '#/decisions?new=1',
  '#/books',
  ...BOOKS_SECTIONS.map((s) => `#/books/${s}`),
  ...BOT_SECTIONS.map((s) => `#/bot/${s}`),
  '#/settings',
  ...SETTINGS_SECTIONS.map((s) => `#/settings/${s}`),
  '#/admin',
];

/** 応答の中の ID から開く画面（形は App.tsx の parseHash と同じ）。 */
const ID_ROUTES = [
  [/^th_[0-9a-f]{16}$/, (id) => `#/all?thread=${id}`],
  [/^ct_[0-9a-f]{16}$/, (id) => `#/contacts?c=${id}`],
  [/^dc_[0-9a-f]{16}$/, (id) => `#/decisions?d=${id}`],
  [/^ar_[0-9a-f]{16}$/, (id) => `#/all?approval=${id}`],
  [/^bb_[0-9a-f]{16}$/, (id) => `#/board?p=${id}`],
  [/^mt_[0-9a-f]{16}$/, (id) => `#/bot/minutes?job=${id}`],
];

const TEXT_TYPES = /^(application\/(json|.*\+json)|text\/)/;

// 一覧の画面では、絞り込み・並べ順・表示件数の選択肢を 1 つずつ選んで録る（組み合わせと検索語は録らない）。
const FILTER_ROUTE = /^#\/(all|mailbox\/[^?]+|contacts|decisions|books\/[a-z]+|tasks\?ws=[^&]+)$/;
const FILTER_SELECTS = '.filter-row select, .filter-chips select, .page-size select, .sort-field select, .pay-year select, .field select';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m) {
      out[m[1]] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function waitForHealth(origin, child, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`サーバーが起動前に終了しました（終了コード ${child.exitCode}）。`);
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return;
    } catch {
      // まだ待ち受けていない
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('サーバーの起動を待ちきれませんでした。');
}

/** 合成データのサーバーを一時フォルダで起動する（demo モード・ループバック）。 */
async function startServer(port) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pages-demo-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
  Object.assign(env, {
    TZ: 'Asia/Tokyo',
    SMM_AUTH_MODE: 'demo',
    SMM_HOST: '127.0.0.1',
    SMM_PORT: String(port),
    SMM_DATA_FILE: path.join(dataDir, 'demo-state.json'),
    SMM_TASK_DATA_FILE: path.join(dataDir, 'tasks.json'),
    SMM_RENTAL_DATA_DIR: path.join(dataDir, 'rental'),
  });
  const child = spawn(process.execPath, [path.join(APP_DIR, 'dist/server/main.js')], { cwd: APP_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(origin, child);
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}\n${stderr}`, { cause: err });
  }
  return {
    origin,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** 応答の本文を、文字なら text、それ以外は base64 で持つ。 */
async function captureResponse(res) {
  const type = res.headers()['content-type'] ?? '';
  let buf;
  try {
    buf = await res.body();
  } catch {
    buf = Buffer.alloc(0);
  }
  const entry = { status: res.status(), type };
  if (buf.length > 0) {
    if (TEXT_TYPES.test(type)) entry.text = buf.toString('utf8');
    else entry.base64 = buf.toString('base64');
  }
  return entry;
}

function collectRoutes(value, found) {
  if (typeof value === 'string') {
    for (const [re, toRoute] of ID_ROUTES) if (re.test(value)) found.add(toRoute(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRoutes(v, found);
    return;
  }
  if (value && typeof value === 'object') {
    // タスク（workspaceId と id を持つもの）と委員会（ws- で始まる id）
    if (typeof value.workspaceId === 'string' && typeof value.id === 'string' && !value.id.startsWith('ws-')) {
      found.add(`#/tasks?ws=${encodeURIComponent(value.workspaceId)}&task=${encodeURIComponent(value.id)}`);
    }
    if (typeof value.id === 'string' && /^ws-[a-z0-9-]+$/.test(value.id)) found.add(`#/tasks?ws=${encodeURIComponent(value.id)}`);
    // 受信箱（/api/mailboxes の mbx- で始まる id）
    if (typeof value.id === 'string' && /^mbx-[a-z0-9-]+$/.test(value.id)) found.add(`#/mailbox/${encodeURIComponent(value.id)}`);
    for (const v of Object.values(value)) collectRoutes(v, found);
  }
}

/** 画面の要求が落ち着くまで待つ（/api/ の要求が 0 件のまま 600 ミリ秒）。 */
async function waitIdle(state, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  let quietSince = 0;
  while (Date.now() < until) {
    if (state.inflight === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 600) return;
    } else {
      quietSince = 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 一覧の絞り込みの選択肢を 1 つずつ選び、終わったら元に戻す。 */
async function driveFilters(page, state) {
  const selects = page.locator(FILTER_SELECTS);
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    if (!(await select.isVisible()) || !(await select.isEnabled())) continue;
    const original = await select.inputValue();
    const values = await select.evaluate((el) => [...el.options].map((o) => o.value));
    for (const value of [...values.filter((v) => v !== original), original]) {
      // 選ぶと選択肢が作り直される一覧がある（件数つきのラベルなど）。消えた選択肢は飛ばす。
      try {
        const present = await select.evaluate((el, v) => [...el.options].some((o) => o.value === v), value);
        if (!present) continue;
        await select.selectOption(value, { timeout: 3_000 });
        await waitIdle(state);
      } catch {
        // 選択肢が画面ごと入れ替わった
      }
    }
  }
}

async function recordPersona(browser, origin, persona, maxVisits) {
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const state = { inflight: 0 };
  const get = {};
  const write = {};
  let session = null;
  const pending = [];

  const isApi = (url) => url.startsWith(`${origin}/api/`);
  page.on('request', (req) => {
    if (isApi(req.url())) state.inflight += 1;
  });
  const done = (req) => {
    if (isApi(req.url())) state.inflight = Math.max(0, state.inflight - 1);
  };
  page.on('requestfailed', done);
  page.on('response', (res) => {
    const req = res.request();
    if (!isApi(req.url())) return;
    const task = (async () => {
      const url = new URL(req.url());
      const entry = await captureResponse(res);
      const method = req.method();
      if (url.pathname === '/api/session') {
        if (method === 'POST' || (method === 'GET' && entry.text?.includes('"user":{'))) session = entry;
      } else if (method === 'GET') {
        get[url.pathname + url.search] = entry;
      } else {
        write[`${method} ${url.pathname}`] = entry;
      }
      done(req);
    })();
    pending.push(task);
  });

  await page.goto(`${origin}/`);
  await page.locator(`[data-persona="${persona.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="current-user"]') !== null, null, { timeout: 15_000 });
  await waitIdle(state);

  const queue = [...SEED_ROUTES];
  const seen = new Set();
  const visited = [];
  while (queue.length > 0 && visited.length < maxVisits) {
    const hash = queue.shift();
    if (seen.has(hash)) continue;
    seen.add(hash);
    await page.evaluate((h) => {
      window.location.hash = h;
    }, hash);
    await waitIdle(state);
    if (FILTER_ROUTE.test(hash)) await driveFilters(page, state);
    visited.push(hash);
    const links = await page.$$eval('a[href^="#/"]', (as) => as.map((a) => a.getAttribute('href')));
    const found = new Set(links);
    await Promise.all(pending);
    for (const entry of Object.values(get)) {
      if (!entry.text || !entry.type.includes('json')) continue;
      try {
        collectRoutes(JSON.parse(entry.text), found);
      } catch {
        // JSON でない本文は飛ばす
      }
    }
    for (const h of found) if (h && !seen.has(h)) queue.push(h);
  }
  await Promise.all(pending);
  await context.close();
  if (!session) throw new Error(`${persona.id} のログインの応答を録れませんでした。`);
  return { session, get, write, visited, unvisited: queue.filter((h) => !seen.has(h)).length };
}

/**
 * 録画して outDir に index.json と <ペルソナ>.json を書く。戻り値は件数の要約。
 * @param {{ outDir: string, port?: number, maxVisits?: number }} options
 */
export async function record({ outDir, port = 5191, maxVisits = 400 }) {
  const server = await startServer(port);
  const browser = await chromium.launch();
  try {
    const anonSession = await fetch(`${server.origin}/api/session`).then((r) => r.json());
    const personas = await fetch(`${server.origin}/api/personas`).then((r) => r.json());
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const summary = [];
    for (const persona of personas) {
      const result = await recordPersona(browser, server.origin, persona, maxVisits);
      await writeFile(path.join(outDir, `${persona.id}.json`), JSON.stringify({ session: result.session, get: result.get, write: result.write }));
      const errors = Object.entries(result.get).filter(([, e]) => e.status >= 400).map(([k, e]) => `${e.status} ${k}`);
      summary.push({ persona: persona.id, visited: result.visited.length, unvisited: result.unvisited, get: Object.keys(result.get).length, write: Object.keys(result.write), errors });
    }
    await writeFile(
      path.join(outDir, 'index.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), anonymousSession: anonSession, personas }),
    );
    return summary;
  } finally {
    await browser.close();
    await server.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(APP_DIR, args.out ?? '.tmp/pages-demo/data');
  const summary = await record({ outDir, port: Number(args.port ?? 5191), maxVisits: Number(args['max-visits'] ?? 400) });
  for (const s of summary) {
    console.log(`${s.persona}: 画面 ${s.visited}（残り ${s.unvisited}）・GET ${s.get}・自動の書き込み ${s.write.length}${s.write.length ? `（${s.write.join(', ')}）` : ''}`);
    for (const e of s.errors) console.log(`  ${e}`);
  }
  console.log(`書き出し先: ${outDir}`);
}
