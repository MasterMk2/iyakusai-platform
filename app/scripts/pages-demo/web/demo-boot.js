// 公開デモ（GitHub Pages）の起動用スクリプト。アプリより先に読み込む（通常の <script>）。
//
// 静的なページなので API のサーバーが無い。代わりに、画面が /api/ へ送る要求を window.fetch で受け、
// 合成データのサーバーから録った応答（demo-data/）を返す。保存・送信の要求は断る。
// ペルソナの選択はこのタブの sessionStorage に置く（タブを閉じると選び直し）。
(() => {
  'use strict';

  const SCRIPT_URL = document.currentScript ? document.currentScript.src : window.location.href;
  const DATA_URL = new URL('demo-data/', SCRIPT_URL);
  const PERSONA_KEY = 'iyakusai-pages-demo-persona';
  const realFetch = window.fetch.bind(window);
  const misses = [];
  window.__iyakusaiPagesDemo = { misses };

  const READ_ONLY = {
    error: 'demo_read_only',
    message: '公開デモでは保存・送信はできません（表示しているのは合成データで、変わりません）。',
  };
  const NOT_RECORDED = {
    error: 'not_found',
    message: '公開デモには、この表示のデータが入っていません。',
  };
  // 日付の範囲だけが違う要求は、同じ API の録った応答で代わりにする（カレンダー・空き具合）。
  const DATE_PARAMS = new Set(['from', 'to', 'year', 'date', 'month']);

  let indexPromise = null;
  const personaCache = new Map();

  function loadJson(name) {
    return realFetch(new URL(name, DATA_URL), { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`demo-data/${name}: ${res.status}`);
      return res.json();
    });
  }

  function loadIndex() {
    if (!indexPromise) indexPromise = loadJson('index.json');
    return indexPromise;
  }

  function loadPersona(id) {
    if (!personaCache.has(id)) personaCache.set(id, loadJson(`${encodeURIComponent(id)}.json`));
    return personaCache.get(id);
  }

  function readPersona() {
    try {
      return window.sessionStorage.getItem(PERSONA_KEY);
    } catch {
      return null;
    }
  }

  function writePersona(id) {
    try {
      if (id) window.sessionStorage.setItem(PERSONA_KEY, id);
      else window.sessionStorage.removeItem(PERSONA_KEY);
    } catch {
      // 保存できなくても、このページを開いている間は動く
    }
    memoryPersona = id;
  }

  let memoryPersona = readPersona();

  function json(status, body) {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function fromEntry(entry) {
    const noBody = entry.status === 204 || entry.status === 304;
    let body = null;
    if (!noBody && entry.text !== undefined) body = entry.text;
    else if (!noBody && entry.base64 !== undefined) body = Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0));
    const headers = entry.type ? { 'Content-Type': entry.type } : {};
    return new Response(body, { status: entry.status, headers });
  }

  /** 日付の範囲の違いだけなら、同じ API の録った応答を探す。 */
  function findByPath(get, url) {
    const own = [...url.searchParams.keys()].filter((k) => !DATE_PARAMS.has(k));
    if (own.length === [...url.searchParams.keys()].length) return null;
    const rest = (u) => [...u.searchParams.entries()].filter(([k]) => !DATE_PARAMS.has(k)).sort().join('&');
    const wanted = rest(url);
    for (const key of Object.keys(get)) {
      const recorded = new URL(key, url.origin);
      if (recorded.pathname === url.pathname && rest(recorded) === wanted) return get[key];
    }
    return null;
  }

  // 一覧（items と total を持つ応答）の、検索と絞り込みの組み合わせを近似する。
  // 録ってあるのは絞り込みを 1 つずつ選んだ応答なので、条件ごとの録画の共通部分を取り、
  // 検索語は項目の中身（JSON の文字列）に含まれるかで絞る。並べ順（sort）は録画の順に並べ替える。
  const SEARCH_PARAMS = new Set(['q', 'query', 'search']);

  function listBody(entry) {
    if (!entry || entry.status !== 200 || !entry.text) return null;
    try {
      const body = JSON.parse(entry.text);
      return body && Array.isArray(body.items) ? body : null;
    } catch {
      return null;
    }
  }

  function itemKey(item) {
    return (item && (item.threadId || item.id)) || JSON.stringify(item);
  }

  function approximateList(get, url) {
    const wanted = new Map(url.searchParams.entries());
    const candidates = [];
    for (const key of Object.keys(get)) {
      const recorded = new URL(key, url.origin);
      if (recorded.pathname !== url.pathname) continue;
      const params = new Map(recorded.searchParams.entries());
      if ([...params].every(([k, v]) => wanted.get(k) === v)) {
        const body = listBody(get[key]);
        if (body) candidates.push({ params, body });
      }
    }
    if (candidates.length === 0) return null;
    const base = candidates.reduce((a, b) => (b.params.size > a.params.size ? b : a));
    let items = base.body.items;
    for (const [k, v] of wanted) {
      if (base.params.has(k)) continue;
      if (SEARCH_PARAMS.has(k)) {
        const needle = v.trim().toLowerCase();
        if (needle) items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
        continue;
      }
      const other = candidates.find((c) => c.params.get(k) === v);
      if (!other) return null;
      const order = other.body.items.map(itemKey);
      const keep = new Set(order);
      items = items.filter((item) => keep.has(itemKey(item)));
      if (k === 'sort') items = [...items].sort((a, b) => order.indexOf(itemKey(a)) - order.indexOf(itemKey(b)));
    }
    return { status: 200, type: 'application/json; charset=utf-8', text: JSON.stringify({ ...base.body, items, total: items.length }) };
  }

  async function readBody(input, init) {
    const body = init && init.body !== undefined ? init.body : input instanceof Request ? await input.clone().text() : undefined;
    if (typeof body !== 'string') return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  async function answer(url, method, input, init) {
    const index = await loadIndex();
    if (url.pathname === '/api/session') {
      if (method === 'POST') {
        const body = await readBody(input, init);
        const persona = index.personas.find((p) => p.id === (body && body.userId));
        if (!persona) return json(400, { error: 'bad_request', message: 'ペルソナを選んでください。' });
        writePersona(persona.id);
        return fromEntry((await loadPersona(persona.id)).session);
      }
      if (method === 'DELETE') {
        writePersona(null);
        return new Response(null, { status: 204 });
      }
      if (memoryPersona && index.personas.some((p) => p.id === memoryPersona)) return fromEntry((await loadPersona(memoryPersona)).session);
      return json(200, index.anonymousSession);
    }
    if (url.pathname === '/api/personas' && method === 'GET') return json(200, index.personas);
    if (!memoryPersona) return json(401, { error: 'unauthenticated', message: 'ペルソナを選んでください。' });

    const data = await loadPersona(memoryPersona);
    if (method === 'GET' || method === 'HEAD') {
      const entry = data.get[url.pathname + url.search] || findByPath(data.get, url) || approximateList(data.get, url);
      if (entry) return fromEntry(entry);
      misses.push(`GET ${url.pathname}${url.search}`);
      return json(404, NOT_RECORDED);
    }
    const recorded = data.write[`${method} ${url.pathname}`];
    if (recorded) return fromEntry(recorded);
    showNotice(READ_ONLY.message);
    return json(403, READ_ONLY);
  }

  function isLocalDevice(url) {
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  }

  window.fetch = function demoFetch(input, init) {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    } catch {
      return realFetch(input, init);
    }
    // カードの読取機（この PC のソフト）には接続しない
    if (isLocalDevice(url) && !isLocalDevice(new URL(window.location.href))) return Promise.reject(new TypeError('公開デモでは読取機に接続しません。'));
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return answer(url, method, input, init);
  };

  // ---- 画面の上の注記と、使えない操作の知らせ ----

  let noticeTimer = null;
  function showNotice(text) {
    let el = document.getElementById('pages-demo-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pages-demo-notice';
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)', 'z-index:2147483647',
        'max-width:min(560px,calc(100vw - 32px))', 'padding:12px 16px', 'border-radius:8px',
        'background:#1f2a24', 'color:#fff', 'font:14px/1.6 system-ui,sans-serif', 'box-shadow:0 4px 16px rgba(0,0,0,.25)',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      el.hidden = true;
    }, 5000);
  }

  // /api/ のダウンロードと物品貸出の画面（/rental）は、github.io の直下を指して開けないので止める。
  document.addEventListener(
    'click',
    (event) => {
      const a = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!a) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname.startsWith('/api/') || url.pathname === '/rental' || url.pathname.startsWith('/rental/')) {
        event.preventDefault();
        showNotice('公開デモでは、ファイルのダウンロードと物品貸出の画面は使えません。');
      }
    },
    true,
  );
})();
