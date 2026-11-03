// 数の物品・団体の回収（/rental/supplies）。Plain script, no bundling: the files are served as they are.
// Every number on the screen comes from /api/rental/supplies. Every write sends the 版番号 (expected_version)
// the screen read, so two screens cannot both take the last chair. A lend, a return and a use carry a request
// id made here: sent again with the same content, the server answers the stored result instead of writing
// twice. Text from the ledger is put in with textContent only (never as HTML).
(function () {
  'use strict';

  const API = '/api/rental/supplies';
  const RENTAL = '/api/rental';
  const LOAN = 'rental.loan';
  const ISSUE = 'rental.issue';
  const KIND_LABEL = { lend: '貸し出す物品', consumable: '消耗品' };
  const MOVE_LABEL = { stock: '在庫を補正', lend: '貸出', return: '返却', consume: '使った', reverse: '取り消し' };
  const PHASE_LABEL = { borrow: '貸出時', return: '返却時', check: '随時' };

  const state = {
    perms: [],
    snap: null,
    collect: null,
    shortages: null,
    group: '',
    basket: new Map(),
    // The attachment counts typed for the basket, keyed by "item id|attachment id". Cleared when the item's count changes.
    lendFound: new Map(),
    picking: null,
    busy: false,
    open: null,
    board: null,
    boardGroup: '',
    boardError: '',
    pending: [],
    cardCode: '',
    cardPanel: null,
    view: 'lend',
  };

  const $ = (id) => document.getElementById(id);
  const can = (permission) => state.perms.includes(permission);

  // Builds an element. Text is always a text node; props may set class, text, value, booleans and on* handlers.
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else if (key === 'disabled' || key === 'hidden' || key === 'checked' || key === 'selected') node[key] = true;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const init = { credentials: 'same-origin', cache: 'no-store', method };
    if (method !== 'GET') {
      init.headers = { 'Content-Type': 'application/json', 'X-SMM-CSRF': '1' };
      init.body = JSON.stringify(options.body ?? {});
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw Object.assign(new Error('通信できません。接続を確認して、もう一度押してください。'), { status: 0 });
    }
    let result = {};
    try {
      result = await response.json();
    } catch {
      // An empty or non-JSON answer keeps the default object.
    }
    if (!response.ok) {
      throw Object.assign(new Error(result.error || '処理を完了できませんでした。'), { status: response.status, code: result.code });
    }
    return result;
  }

  function say(text, tone = 'info') {
    const box = $('message');
    box.textContent = text || '';
    box.className = `notice ${tone}`;
    box.hidden = !text;
    if (text && tone === 'error') box.scrollIntoView({ block: 'nearest' });
  }

  function showLogin() {
    $('workspace').hidden = true;
    $('login-panel').hidden = false;
    $('staff-name').textContent = '';
  }

  function uuid() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // The request id of a write the server answers once. A write that got no answer keeps its id, so pressing again
  // sends the same request and the server answers the stored result. Any other answer settles it.
  const pendingIds = new Map();
  function requestId(slot, body) {
    const json = JSON.stringify(body);
    const prior = pendingIds.get(slot);
    if (prior && prior.json === json) return prior.id;
    const id = uuid();
    pendingIds.set(slot, { id, json });
    return id;
  }

  async function sendOnce(slot, path, body) {
    const id = requestId(slot, body);
    try {
      const result = await request(path, { method: 'POST', body: { id, ...body } });
      pendingIds.delete(slot);
      return result;
    } catch (error) {
      if (!(error.status === 0 || error.status >= 500)) pendingIds.delete(slot);
      throw error;
    }
  }

  function fmt(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // A count typed on the screen: a whole number of 0 or more, or null.
  function parseCount(text) {
    const value = String(text).trim();
    return /^\d{1,4}$/.test(value) ? Number(value) : null;
  }

  const findItem = (id) => state.snap?.items.find((item) => item.id === id);
  const isRegistered = (name) => !!name && !!state.snap?.groups.includes(name);
  const stockFlag = (item) => (item.out_of_stock ? '在庫切れ' : item.low ? '残りわずか' : '');

  function retryButton(fn, label = 'もう一度読む') {
    return el('button', { type: 'button', class: 'secondary', onclick: () => fn() }, label);
  }

  function loadFailed(retry, text = '読み込めませんでした。通信を確かめて、もう一度読んでください。') {
    return el('div', { class: 'sub-form' }, el('p', { class: 'small', text }), retryButton(retry));
  }

  // Runs a write and shows its answer. A failed write shows why and reloads the counts.
  async function act(work, done) {
    try {
      const result = await work();
      if (done) say(done(result), 'ok');
      return result;
    } catch (error) {
      await failWrite(error);
      return null;
    }
  }

  async function failWrite(error) {
    if (error.status === 401) return showLogin();
    if (error.code === 'version_conflict') {
      say(`${error.message} 最新の数を読み直しました。もう一度操作してください。`, 'error');
      await loadAll();
      return;
    }
    if (error.code === 'attachments_changed') {
      say(`${error.message} 付属品を読み直しました。`, 'error');
      await loadAll();
      return;
    }
    say(error.message, 'error');
  }

  // A keyed write (lend, return, use) that got no answer can be sent again as it is; other failures explain themselves.
  async function keyedFailure(error) {
    if (error.status === 401) return showLogin();
    if (error.status === 0 || error.status >= 500) {
      say(`${error.message} 同じ内容のまま押し直すと、二重には記録されません。`, 'error');
      return;
    }
    await failWrite(error);
  }

  // Turns the form's buttons off while its write is on the way, so a second tap cannot send the same write again.
  async function busy(form, work) {
    if (!form || form.dataset.busy === '1') return null;
    form.dataset.busy = '1';
    const buttons = [...form.querySelectorAll('button')];
    const was = buttons.map((b) => b.disabled);
    buttons.forEach((b) => { b.disabled = true; });
    try {
      return await work();
    } finally {
      form.dataset.busy = '';
      buttons.forEach((b, i) => { b.disabled = was[i]; });
    }
  }

  // One count per attachment (在った数). `valueOf(a)` gives the number shown; `onType(a, text)` hears every change.
  function attachmentFields(attachments, valueOf, onType) {
    const inputs = attachments.map((a) => ({
      a,
      input: el('input', {
        type: 'number', min: 0, step: 1, inputmode: 'numeric', value: valueOf(a), 'aria-label': `${a.name}の在った数`,
        oninput: (event) => { if (onType) onType(a, event.target.value); },
      }),
    }));
    return {
      inputs,
      node: inputs.length
        ? el('div', { class: 'stack' }, inputs.map(({ a, input }) => el('label', {}, `${a.name}（在った数・1個につき ${a.expected_per_unit} 個）`, input)))
        : null,
    };
  }

  // ---- loading

  async function loadSnapshot() {
    try {
      state.snap = await request(API);
      renderAll();
    } catch (error) {
      if (error.status === 401) return showLogin();
      say(error.message, 'error');
      $('lend-items').replaceChildren(loadFailed(loadAll, '物品の数を読み込めませんでした。通信を確かめて、もう一度読んでください。'));
      $('stock-list').replaceChildren(loadFailed(loadAll, '物品の数を読み込めませんでした。通信を確かめて、もう一度読んでください。'));
    }
  }

  async function loadCollect() {
    try {
      const [collection, shortages] = await Promise.all([request(`${API}/collection`), request(`${API}/shortages`)]);
      state.collect = collection;
      state.shortages = shortages.shortages;
      renderCollect();
    } catch (error) {
      if (error.status === 401) return showLogin();
      say(error.message, 'error');
      $('collect-groups').replaceChildren(loadFailed(loadCollect, '団体の一覧を読み込めませんでした。'));
      $('shortage-list').replaceChildren(loadFailed(loadCollect, '欠品の一覧を読み込めませんでした。'));
    }
  }

  function renderShortages() {
    const list = state.shortages || [];
    $('shortage-summary').textContent = list.length ? `付属品の欠品 ${list.length} 件（開いて確認）` : '付属品の欠品はありません';
    $('shortage-list').replaceChildren(...(list.length ? list.map((s) => el('article', { class: 'item-card' },
      el('div', { class: 'item-head' },
        el('h4', { text: s.owner_name || s.owner_key }),
        el('p', { class: 'small', text: `${s.owner_kind === 'card' ? `個体 ${s.owner_key}` : '数の物品'}・${s.group ? `団体：${s.group}` : '団体なし'}・点検 ${fmt(s.server_at)}（${PHASE_LABEL[s.phase] || s.phase}）` })),
      el('ul', { class: 'plain-list' }, s.lines.map((l) => el('li', { class: 'short', text: `${l.name}：欠品 ${l.missing} 個${l.note ? `（${l.note}）` : ''}` }))))) : [el('p', { class: 'small', text: '欠品はありません。' })]));
  }

  async function loadBoard(group) {
    try {
      state.board = await request(`${API}/board?group=${encodeURIComponent(group)}`);
      state.boardError = '';
      renderBoard();
    } catch (error) {
      if (error.status === 401) return showLogin();
      state.board = null;
      state.boardError = error.message;
      renderBoard();
    }
  }

  async function loadAll() {
    await Promise.all([loadSnapshot(), loadCollect()]);
  }

  function renderAll() {
    renderTabs();
    renderLend();
    renderStock();
    renderCollect();
    renderBoard();
  }

  // ---- tabs

  function showView(view) {
    state.view = view;
    for (const name of ['lend', 'stock', 'collect']) {
      const selected = name === view;
      $(`tab-${name}`).setAttribute('aria-selected', String(selected));
      $(`tab-${name}`).className = selected ? 'selected' : '';
      $(`view-${name}`).hidden = !selected;
    }
  }

  function renderTabs() {
    // A screen the person cannot use is not offered: lending needs rental.loan; the item editor needs rental.issue.
    $('tab-lend').hidden = !can(LOAN);
    $('view-lend').hidden = !can(LOAN) || state.view !== 'lend';
    if (!can(LOAN) && state.view === 'lend') showView('stock');
    $('item-new').hidden = !can(ISSUE);
  }

  // ---- その場で貸す

  function selectGroup(name) {
    state.group = name;
    $('lend-group').value = name;
    renderLend();
  }

  function renderLend() {
    if (!state.snap) return;
    const groups = state.snap.groups;
    const recent = state.snap.recent_groups.filter((g) => groups.includes(g));
    $('group-options').replaceChildren(...groups.map((g) => el('option', { value: g })));
    $('lend-recent').replaceChildren(...recent.map((g) => el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.group === g), onclick: () => selectGroup(g),
    }, g)));
    if (!recent.length) $('lend-recent').replaceChildren(el('p', { class: 'small' }, 'まだ貸していません。団体名を選んでください。'));

    const typed = state.group.trim();
    const unknown = !!typed && !isRegistered(typed);
    $('lend-register-note').hidden = !unknown;
    $('lend-register-note').textContent = unknown ? `「${typed}」は貸出先に登録されていません。登録すると貸し出せます。` : '';
    $('lend-register').hidden = !unknown || !can(LOAN);

    const items = state.snap.items.filter((item) => item.kind === 'lend');
    const empty = can(ISSUE)
      ? '貸し出す物品はまだ登録されていません。「数の物品」で登録できます。'
      : '貸し出す物品はまだ登録されていません。管理者に登録を依頼してください。';
    $('lend-items').replaceChildren(...(items.length ? items.map(pickTile) : [el('p', { class: 'small', text: empty })]));
    renderPickPanel();
    renderBasket();
  }

  function pickTile(item) {
    const picked = state.basket.get(item.id) || 0;
    const flag = stockFlag(item);
    return el('button', {
      type: 'button',
      class: `pick${picked ? ' picked' : ''}`,
      disabled: item.on_hand <= picked,
      'aria-label': `${item.name}の数を入れる。在庫 ${item.on_hand}${item.unit}`,
      onclick: () => openPick(item.id),
    },
    el('span', { class: 'pick-name', text: item.name }),
    el('span', { class: 'pick-stock', text: `在庫 ${item.on_hand} ${item.unit}` }),
    item.attachments.length ? el('span', { class: 'pick-stock', text: `付属品 ${item.attachments.map((a) => `${a.name} ${a.expected_per_unit}`).join('、')}` }) : null,
    flag ? el('span', { class: 'flag', text: flag }) : null,
    picked ? el('span', { class: 'pick-count', text: `${picked} ${item.unit} 入れています` }) : null);
  }

  function openPick(id) {
    const item = findItem(id);
    if (!item) return;
    state.picking = { id, qty: 1 };
    say('');
    renderLend();
    const input = $('lend-pick').querySelector('input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  // The count box that opens when an item is pressed: a number typed (or stepped), then 今回に入れる.
  function renderPickPanel() {
    const box = $('lend-pick');
    const picking = state.picking;
    const item = picking ? findItem(picking.id) : null;
    box.hidden = !item;
    if (!item) return box.replaceChildren();
    const picked = state.basket.get(item.id) || 0;
    const room = Math.max(0, item.on_hand - picked);
    const qty = el('input', {
      type: 'number', min: 1, max: Math.max(room, 1), step: 1, inputmode: 'numeric', value: picking.qty, 'aria-label': `${item.name}を何${item.unit}入れるか`,
    });
    const step = (delta) => { qty.value = String(Math.max(1, Math.min(Math.max(room, 1), (parseCount(qty.value) ?? 1) + delta))); };
    box.replaceChildren(el('form', { class: 'pick-panel-form', onsubmit: (event) => {
      event.preventDefault();
      addToBasket(item.id, parseCount(qty.value));
    } },
    el('h3', { text: `${item.name}を入れる` }),
    el('p', { class: 'small', text: `在庫 ${item.on_hand} ${item.unit}${picked ? `・今回の入れ方 ${picked} ${item.unit}` : ''}・あと ${room} ${item.unit} まで入れられます` }),
    el('label', {}, `何${item.unit}入れますか`, qty),
    el('div', { class: 'action-row' },
      el('button', { type: 'button', class: 'quiet', 'aria-label': '1つ減らす', onclick: () => step(-1) }, '−1'),
      el('button', { type: 'button', class: 'quiet', 'aria-label': '1つ増やす', onclick: () => step(1) }, '＋1'),
      el('button', { type: 'submit', class: 'primary' }, '今回に入れる'),
      el('button', { type: 'button', class: 'quiet', onclick: () => { state.picking = null; renderLend(); } }, 'やめる'))));
  }

  function addToBasket(id, n) {
    const item = findItem(id);
    if (!item) return;
    const picked = state.basket.get(id) || 0;
    if (n === null || n < 1) return say('入れる数は 1 以上の整数で入力してください。', 'error');
    if (picked + n > item.on_hand) return say(`${item.name}は在庫（${item.on_hand} ${item.unit}）を超えて入れられません。`, 'error');
    state.basket.set(id, picked + n);
    clearFound(id);
    state.picking = null;
    say('');
    renderLend();
  }

  function clearFound(itemId) {
    for (const key of [...state.lendFound.keys()]) if (key.startsWith(`${itemId}|`)) state.lendFound.delete(key);
  }

  function unpick(id) {
    const count = (state.basket.get(id) || 0) - 1;
    if (count > 0) state.basket.set(id, count);
    else state.basket.delete(id);
    clearFound(id);
    renderLend();
  }

  function renderBasket() {
    const entries = [...state.basket.entries()];
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    $('basket-list').replaceChildren(...entries.map(([id, n]) => {
      const item = findItem(id);
      return el('li', {},
        el('span', { text: `${item ? item.name : ''} × ${n}${item ? item.unit : ''}` }),
        el('button', { type: 'button', class: 'quiet small-button', 'aria-label': `${item ? item.name : ''}を1つ減らす`, onclick: () => unpick(id) }, '1つ減らす'));
    }));
    if (!entries.length) $('basket-list').replaceChildren(el('li', { class: 'small' }, '押した物品がここに並びます。'));
    // The attachments of each item in the basket are counted at the lend (借用時の点検); they start from the full count.
    $('basket-checks').replaceChildren(...entries.flatMap(([id, n]) => {
      const item = findItem(id);
      if (!item || !item.attachments.length) return [];
      const fields = attachmentFields(item.attachments,
        (a) => state.lendFound.get(`${id}|${a.id}`) ?? String(a.expected_per_unit * n),
        (a, text) => state.lendFound.set(`${id}|${a.id}`, text));
      return [el('div', { class: 'check-block' }, el('h4', { text: `${item.name} ×${n}：付属品の在った数` }), fields.node)];
    }));
    const ready = total > 0 && isRegistered(state.group.trim()) && can(LOAN) && !state.busy;
    $('lend-submit').disabled = !ready;
    $('lend-submit').textContent = state.busy ? '送信中…' : total ? `${state.group.trim() || '団体'}に ${total} 個貸す` : '物品を選んでください';
    $('lend-clear').hidden = !total;
  }

  // Cuts the basket to the stock that is on the shelf now. Returns the names of the items that changed.
  function trimBasket() {
    const cut = [];
    for (const [id, n] of [...state.basket.entries()]) {
      const item = findItem(id);
      if (!item || item.kind !== 'lend') {
        state.basket.delete(id);
        cut.push(item ? item.name : '（なくなった物品）');
      } else if (n > item.on_hand) {
        if (item.on_hand > 0) state.basket.set(id, item.on_hand);
        else state.basket.delete(id);
        clearFound(id);
        cut.push(item.name);
      }
    }
    return cut;
  }

  async function submitLend() {
    if (state.busy) return;
    const group = state.group.trim();
    const lines = [];
    for (const [id, qty] of state.basket.entries()) {
      const item = findItem(id);
      if (!item) return say('物品の数を読み直してから、もう一度選んでください。', 'error');
      const attachments = item.attachments.map((a) => ({
        attachment_id: a.id,
        found: parseCount(state.lendFound.get(`${id}|${a.id}`) ?? String(a.expected_per_unit * qty)),
      }));
      if (attachments.some((x) => x.found === null)) return say(`${item.name}の在った数は 0 以上の整数で入力してください。`, 'error');
      lines.push({ item_id: id, qty, expected_version: item.version, attachments });
    }
    const total = lines.reduce((sum, l) => sum + l.qty, 0);
    state.busy = true;
    renderBasket();
    try {
      const result = await sendOnce('lend', `${API}/lend`, { group, lines });
      state.basket.clear();
      state.lendFound.clear();
      state.picking = null;
      const missing = result.checks.reduce((sum, c) => sum + c.missing_total, 0);
      say(`${group}に ${total} 個貸しました。${missing ? `付属品の欠品 ${missing} 個があります。` : ''}`, missing ? 'warn' : 'ok');
      await loadAll();
    } catch (error) {
      if (error.code === 'version_conflict' || error.code === 'stock_short') {
        await loadAll();
        const cut = trimBasket();
        say(`${error.message}${error.code === 'version_conflict' ? ' 最新の数を読み直しました。' : ''}${cut.length ? ` 在庫が変わったため、${cut.join('、')}の数を直しました。` : ''}`, 'error');
      } else {
        await keyedFailure(error);
      }
      renderLend();
    } finally {
      state.busy = false;
      renderBasket();
    }
  }

  async function registerGroup() {
    const name = state.group.trim();
    const result = await act(() => request(`${RENTAL}/borrowers`, { method: 'POST', body: { name } }), () => `「${name}」を貸出先に登録しました。`);
    if (result) await loadSnapshot();
  }

  // ---- 数の物品

  function renderStock() {
    if (!state.snap) return;
    const items = state.snap.items;
    $('stock-list').replaceChildren(...(items.length ? items.map(stockCard) : [el('p', { class: 'small' }, '数で管理する物品はまだありません。')]));
  }

  function stockCard(item) {
    const open = state.open && state.open.id === item.id ? state.open : null;
    const flag = stockFlag(item);
    const action = (label, mode, extra = {}) => el('button', {
      type: 'button', class: 'quiet small-button', 'aria-expanded': String(!!(open && open.mode === mode)),
      onclick: () => toggle(item, mode), ...extra,
    }, label);
    const buttons = [];
    if (item.kind === 'consumable' && can(LOAN)) buttons.push(action('使った', 'consume'));
    if (item.kind === 'lend' && can(LOAN) && item.lent > 0) buttons.push(action('返却を記録する', 'return'));
    if (can(ISSUE)) buttons.push(action('在庫を補正', 'stock'), action('付属品', 'attachments'));
    buttons.push(action('履歴', 'history'));
    return el('article', { class: 'item-card' },
      el('div', { class: 'item-head' },
        el('h3', { text: item.name }),
        el('p', { class: 'small', text: `${KIND_LABEL[item.kind]}・単位 ${item.unit}${item.note ? `・${item.note}` : ''}` })),
      el('dl', { class: 'counts' },
        el('div', {}, el('dt', { text: '在庫' }), el('dd', { text: `${item.on_hand} ${item.unit}` })),
        item.kind === 'lend' ? el('div', {}, el('dt', { text: '貸出中' }), el('dd', { text: `${item.lent} ${item.unit}` })) : null,
        item.kind === 'consumable' ? el('div', {}, el('dt', { text: '使った累計' }), el('dd', { text: `${item.consumed} ${item.unit}` })) : null,
        el('div', {}, el('dt', { text: 'しきい値' }), el('dd', { text: `${item.low_threshold} ${item.unit} 以下で表示` }))),
      flag ? el('p', { class: 'flag strong', text: flag }) : null,
      el('div', { class: 'action-row wrap' }, buttons),
      open ? openPanel(item, open) : null);
  }

  function toggle(item, mode) {
    state.open = state.open && state.open.id === item.id && state.open.mode === mode ? null : { id: item.id, mode, data: null, error: false, notice: '' };
    renderStock();
    if (state.open && mode === 'attachments') loadItemAttachments(item.id);
    if (state.open && mode === 'history') loadHistory(item.id);
  }

  function openPanel(item, open) {
    if (open.mode === 'consume') return consumeForm(item);
    if (open.mode === 'return') return returnForm(item);
    if (open.mode === 'stock') return stockForm(item);
    if (open.mode === 'attachments') return attachmentPanel(item, open);
    if (open.mode === 'history') return historyPanel(item, open);
    return null;
  }

  function consumeForm(item) {
    const qty = el('input', { type: 'number', min: 1, max: item.on_hand, step: 1, inputmode: 'numeric', value: 1, 'aria-label': '使った数' });
    const memo = el('input', { maxlength: 200, autocomplete: 'off', 'aria-label': 'メモ' });
    return el('form', { class: 'sub-form', onsubmit: (event) => {
      event.preventDefault();
      busy(event.currentTarget, async () => {
        const n = parseCount(qty.value);
        if (n === null || n < 1) return say('使った数は 1 以上の整数で入力してください。', 'error');
        const done = await act(() => sendOnce('consume', `${API}/consume`, { item_id: item.id, qty: n, note: memo.value, expected_version: item.version }),
          () => `${item.name}を ${n} ${item.unit} 使いました。`);
        if (done) await loadSnapshot();
      });
    } },
    el('label', {}, `使った数（${item.unit}）`, qty),
    el('label', {}, 'メモ（任意）', memo),
    el('button', { type: 'submit', class: 'primary full' }, '使ったことを記録する'));
  }

  function returnForm(item) {
    const first = item.lent_by_group[0];
    const select = el('select', { 'aria-label': '返却する団体' },item.lent_by_group.map((g) => el('option', { value: g.group, text: `${g.group}（貸出中 ${g.lent}）` })));
    const ok = el('input', { type: 'number', min: 0, max: item.lent, step: 1, inputmode: 'numeric', value: first ? first.lent : 0, 'aria-label': '返った数' });
    const lost = el('input', { type: 'number', min: 0, max: item.lent, step: 1, inputmode: 'numeric', value: 0, 'aria-label': '紛失・破損の数' });
    const memo = el('input', { maxlength: 200, autocomplete: 'off', 'aria-label': 'メモ' });
    const counts = attachmentFields(item.attachments, (a) => a.expected_per_unit * (first ? first.lent : 0));
    const follow = () => {
      for (const { a, input } of counts.inputs) input.value = String(a.expected_per_unit * Math.max(0, Number(ok.value) || 0));
    };
    ok.addEventListener('input', follow);
    select.addEventListener('change', () => {
      const g = item.lent_by_group.find((x) => x.group === select.value);
      ok.value = g ? g.lent : 0;
      ok.max = g ? g.lent : 0;
      follow();
    });
    return el('form', { class: 'sub-form', onsubmit: (event) => {
      event.preventDefault();
      sendReturn(event.currentTarget, { group: select.value, item, ok, lost, memo, counts });
    } },
    el('label', {}, '団体', select),
    el('div', { class: 'grid-2' }, el('label', {}, '返った数', ok), el('label', {}, '紛失・破損の数', lost)),
    counts.node,
    el('label', {}, 'メモ（任意）', memo),
    el('button', { type: 'submit', class: 'primary full' }, '返却を記録する'));
  }

  // One return of one item from one group. The counts of the attachments of the returned units go in the same
  // request, so the return and its check are kept or lost together. Lost units count as units, so their
  // attachments show as missing unless the screen says otherwise.
  async function sendReturn(form, { group, item, ok, lost, memo, counts }) {
    const okN = parseCount(ok.value);
    const lostN = parseCount(lost.value);
    if (okN === null || lostN === null) return say('返った数と紛失・破損の数は 0 以上の整数で入力してください。', 'error');
    if (okN + lostN < 1) return say('返った数か紛失・破損の数を 1 以上にしてください。', 'error');
    const found = counts.inputs.map(({ a, input }) => ({ attachment_id: a.id, found: parseCount(input.value) }));
    if (found.some((f) => f.found === null)) return say('在った数は 0 以上の整数で入力してください。', 'error');
    const body = { group, lines: [{ item_id: item.id, qty: okN, lost: lostN, note: memo.value, expected_version: item.version, attachments: found }] };
    await busy(form, async () => {
      try {
        const result = await sendOnce('return', `${API}/return`, body);
        const missing = result.checks.reduce((sum, c) => sum + c.missing_total, 0);
        say(`${item.name}を ${okN + lostN} ${item.unit} 返してもらいました。${missing ? `付属品の欠品 ${missing} 個があります。` : ''}`, missing ? 'warn' : 'ok');
      } catch (error) {
        await keyedFailure(error);
      }
      await loadAll();
      if (state.boardGroup) await loadBoard(state.boardGroup);
    });
  }

  function stockForm(item) {
    const delta = el('input', { type: 'number', step: 1, inputmode: 'numeric', value: 1, 'aria-label': '増減数（マイナスで減らす）' });
    const memo = el('input', { maxlength: 200, autocomplete: 'off', 'aria-label': 'メモ' });
    return el('form', { class: 'sub-form', onsubmit: (event) => {
      event.preventDefault();
      busy(event.currentTarget, async () => {
        const n = Number(delta.value);
        await act(() => request(`${API}/items/${encodeURIComponent(item.id)}/stock`, { method: 'POST', body: { delta: n, note: memo.value, expected_version: item.version } }),
          () => `${item.name}の在庫を ${n > 0 ? '+' : ''}${n} しました。`);
        await loadAll();
      });
    } },
    el('label', {}, `増減数（${item.unit}）`, delta),
    el('p', { class: 'small', text: '補充は＋、数え直して減るときは－。減らすときは理由をメモに書いてください。' }),
    el('label', {}, 'メモ（減らすときは必須）', memo),
    el('button', { type: 'submit', class: 'primary full' }, '在庫を補正する'));
  }

  async function loadItemAttachments(itemId) {
    if (state.open && state.open.id === itemId) state.open.error = false;
    try {
      const data = await request(`${API}/attachments?owner_kind=supply&owner_key=${encodeURIComponent(itemId)}`);
      if (state.open && state.open.id === itemId) {
        state.open.data = data;
        renderStock();
      }
    } catch (error) {
      if (error.status === 401) return showLogin();
      if (state.open && state.open.id === itemId) {
        state.open.error = true;
        renderStock();
      } else {
        say(error.message, 'error');
      }
    }
  }

  async function loadHistory(itemId) {
    if (state.open && state.open.id === itemId) state.open.error = false;
    try {
      const data = await request(`${API}/movements?item_id=${encodeURIComponent(itemId)}&limit=30`);
      if (state.open && state.open.id === itemId) {
        state.open.data = data;
        renderStock();
      }
    } catch (error) {
      if (error.status === 401) return showLogin();
      if (state.open && state.open.id === itemId) {
        state.open.error = true;
        renderStock();
      } else {
        say(error.message, 'error');
      }
    }
  }

  function attachmentPanel(item, open) {
    if (open.error) return loadFailed(() => loadItemAttachments(item.id), '付属品を読み込めませんでした。もう一度読んでください。');
    if (!open.data) return el('p', { class: 'sub-form small', text: '付属品を読み込んでいます…' });
    const list = open.data.attachments;
    const archived = open.data.archived || [];
    const rows = list.length
      ? list.map((a) => el('li', {}, el('span', { text: `${a.name}：1 ${item.unit}につき ${a.expected_per_unit} 個` }), can(ISSUE)
        ? el('button', { type: 'button', class: 'quiet small-button', onclick: () => archiveAttachment(a, item) }, 'しまう') : null))
      : [el('li', { class: 'small', text: 'まだ付属品はありません。' })];
    const putAway = archived.length ? el('div', { class: 'stack' },
      el('h4', { text: 'しまった付属品' }),
      el('p', { class: 'small', text: '点検の記録は残っています。戻すと、次の貸出・返却から数えます。' }),
      el('ul', { class: 'plain-list' }, archived.map((a) => el('li', {},
        el('span', { text: `${a.name}：1 ${item.unit}につき ${a.expected_per_unit} 個` }),
        can(ISSUE) ? el('button', { type: 'button', class: 'quiet small-button', onclick: () => restoreAttachment(a, item) }, '戻す') : null)))) : null;
    const name = el('input', { maxlength: 40, autocomplete: 'off', 'aria-label': '付属品の名前' });
    const count = el('input', { type: 'number', min: 1, max: 99, step: 1, inputmode: 'numeric', value: 1, 'aria-label': '1 個につき何個' });
    return el('div', { class: 'sub-form' },
      el('h4', { text: '付属品（1 個につき）' }),
      el('ul', { class: 'plain-list' }, rows),
      putAway,
      can(ISSUE) ? el('form', { class: 'stack', onsubmit: (event) => {
        event.preventDefault();
        busy(event.currentTarget, async () => {
          const done = await act(() => request(`${API}/attachments`, { method: 'POST', body: { owner_kind: 'supply', owner_key: item.id, name: name.value, expected: Number(count.value) } }),
            () => `${name.value} を付属品に追加しました。`);
          if (done) await loadItemAttachments(item.id);
        });
      } },
      el('label', {}, '付属品の名前', name),
      el('label', {}, `1 ${item.unit}につき何個`, count),
      el('button', { type: 'submit', class: 'secondary full' }, '付属品を追加する')) : null);
  }

  async function archiveAttachment(att, item) {
    const done = await act(() => request(`${API}/attachments/${encodeURIComponent(att.id)}`, { method: 'PATCH', body: { archived: true, expected_version: att.version ?? 0 } }),
      () => `${att.name} をしまいました。「しまった付属品」から戻せます。`);
    if (done) await loadItemAttachments(item.id);
  }

  async function restoreAttachment(att, item) {
    const done = await act(() => request(`${API}/attachments/${encodeURIComponent(att.id)}`, { method: 'PATCH', body: { archived: false, expected_version: att.version ?? 0 } }),
      () => `${att.name} を付属品に戻しました。`);
    if (done) await loadItemAttachments(item.id);
  }

  function historyPanel(item, open) {
    if (open.error) return loadFailed(() => loadHistory(item.id), '履歴を読み込めませんでした。もう一度読んでください。');
    if (!open.data) return el('p', { class: 'sub-form small', text: '履歴を読み込んでいます…' });
    const rows = open.data.movements.map((m) => {
      const sign = (n) => (n > 0 ? `+${n}` : String(n));
      const parts = [];
      if (m.delta_on_hand) parts.push(`在庫 ${sign(m.delta_on_hand)}`);
      if (m.delta_lent) parts.push(`貸出 ${sign(m.delta_lent)}`);
      if (m.lost) parts.push(`紛失・破損 ${m.lost}`);
      const undoPermission = m.kind === 'stock' ? ISSUE : LOAN;
      return el('li', {},
        el('p', { class: 'history-head' },
          el('strong', { text: MOVE_LABEL[m.kind] || m.kind }),
          el('span', { class: 'small', text: ` ${fmt(m.server_at)}・${m.actor_name}` }),
          m.reversed ? el('span', { class: 'flag', text: '取り消し済み' }) : null),
        el('p', { class: 'small', text: [m.group ? `団体：${m.group}` : '', parts.join('・'), m.note ? `メモ：${m.note}` : ''].filter(Boolean).join(' ／ ') }),
        m.reversible && can(undoPermission) ? reverseForm(item, m) : null);
    });
    return el('div', { class: 'sub-form' },
      el('h4', { text: '最近の記録（新しい順）' }),
      el('ol', { class: 'plain-list' }, rows.length ? rows : [el('li', { class: 'small', text: 'まだ記録はありません。' })]));
  }

  function reverseForm(item, record) {
    const reason = el('input', { maxlength: 200, autocomplete: 'off', required: true, 'aria-label': '取り消す理由' });
    return el('form', { class: 'stack undo', onsubmit: (event) => {
      event.preventDefault();
      busy(event.currentTarget, async () => {
        const fresh = findItem(item.id);
        const done = await act(() => request(`${API}/movements/${record.id}/reverse`, { method: 'POST', body: { reason: reason.value, expected_version: fresh ? fresh.version : item.version } }),
          () => '取り消しを記録しました。元の記録は残ります。');
        if (done) await loadAll();
        if (done && state.open) await loadHistory(state.open.id);
      });
    } },
    el('label', {}, '取り消す理由（必須）', reason),
    el('button', { type: 'submit', class: 'quiet full' }, 'この記録を取り消す'));
  }

  async function submitNewItem(event) {
    event.preventDefault();
    const form = event.currentTarget;
    await busy(form, async () => {
      const data = new FormData(form);
      const body = {
        name: String(data.get('name') || ''),
        unit: String(data.get('unit') || ''),
        kind: String(data.get('kind') || 'lend'),
        low_threshold: Number(data.get('low_threshold') || 0),
        initial_on_hand: Number(data.get('initial_on_hand') || 0),
        note: String(data.get('note') || ''),
      };
      const done = await act(() => request(API + '/items', { method: 'POST', body }), (r) => `${r.name} を登録しました。`);
      if (done) {
        form.reset();
        await loadSnapshot();
      }
    });
  }

  // ---- 団体の回収

  function renderCollect() {
    if (state.shortages) renderShortages();
    if (!state.collect) return;
    // The groups that still have something out come first; within each part the order is by name.
    const groups = [...state.collect.groups].sort((a, b) => Number(a.collected) - Number(b.collected));
    $('collect-groups').replaceChildren(...(groups.length ? groups.map((g) => el('div', { class: 'group-row' },
      el('div', {},
        el('strong', { text: g.name }),
        el('p', { class: `small${g.collected ? '' : ' flag-text'}`, text: g.collected ? '回収済み（全部戻っています）' : `未回収：個体 ${g.cards_out} 件・数の物品 ${g.units_out} 個` })),
      el('button', { type: 'button', class: 'quiet small-button', 'aria-label': `${g.name}の回収表を開く`, onclick: () => openBoard(g.name) }, '回収表を開く'))) : [el('p', { class: 'small', text: 'まだ貸し出した団体はありません。' })]));
  }

  async function openBoard(group) {
    state.board = null;
    state.boardError = '';
    state.boardGroup = group;
    $('board').hidden = false;
    $('board-title').textContent = group;
    $('board-status').textContent = '読み込み中…';
    $('board-cards').replaceChildren();
    $('board-supplies').replaceChildren();
    // The group is kept in the address, so coming back from a card's own page reopens this board.
    history.replaceState(null, '', `#group=${encodeURIComponent(group)}`);
    await loadBoard(group);
    $('board').scrollIntoView({ block: 'start' });
  }

  function renderBoard() {
    const board = state.board;
    $('board').hidden = !state.boardGroup;
    renderPending();
    if (!board) {
      if (state.boardError) {
        $('board-title').textContent = state.boardGroup;
        $('board-status').textContent = `回収表を読み込めませんでした。${state.boardError}`;
        $('board-status').className = 'board-status open';
        $('board-cards').replaceChildren(loadFailed(() => loadBoard(state.boardGroup)));
        $('board-supplies').replaceChildren();
      }
      return;
    }
    $('board-title').textContent = board.group;
    const status = board.collected ? '回収済み（全部戻っています）' : `未回収：個体 ${board.cards_out} 件・数の物品 ${board.units_out} 個`;
    $('board-status').textContent = `${status}${board.attachment_shortage ? `。付属品の欠品 ${board.attachment_shortage} 件が残っています` : ''}`;
    $('board-status').className = `board-status ${board.collected ? 'done' : 'open'}`;
    $('board-cards').replaceChildren(...(board.cards.length ? board.cards.map(cardRow) : [el('p', { class: 'small', text: 'この団体が借りている個体はありません。' })]));
    $('board-supplies').replaceChildren(...(board.supplies.length ? board.supplies.map(supplyRow) : [el('p', { class: 'small', text: 'この団体が借りている数の物品はありません。' })]));
  }

  // The status of one attachment in this loan. A check of another group is shown as the previous check, not as a shortage.
  function attachmentStatus(a) {
    if (a.missing === null) {
      const before = a.previous_check ? `（前回の点検：${a.previous_check.group || '団体なし'}・${fmt(a.previous_check.server_at)}）` : '';
      return `${a.name}：この貸出の点検はまだ（付属品 ${a.expected} 個）${before}`;
    }
    return a.missing > 0 ? `${a.name}：欠品 ${a.missing} 個${a.check_note ? `（${a.check_note}）` : ''}` : `${a.name}：そろっています`;
  }

  function cardRow(card) {
    const attachments = card.attachments;
    return el('article', { class: 'item-card' },
      el('div', { class: 'item-head' },
        el('h4', { text: `${card.name}` }),
        el('p', { class: 'small', text: `個体 ${card.code}${card.irregular ? `・${card.quantity} ${card.unit}` : ''}${card.lent_at ? `・貸出 ${fmt(card.lent_at)}` : ''}` })),
      attachments.length ? el('ul', { class: 'plain-list' }, attachments.map((a) => el('li', { class: a.missing > 0 ? 'short' : '', text: attachmentStatus(a) }))) : el('p', { class: 'small', text: '付属品は登録されていません。' }),
      el('div', { class: 'action-row wrap' },
        el('a', { class: 'button-link', href: `/i/${encodeURIComponent(card.code)}`, 'data-leave': '' }, '個体の画面で返却する'),
        can(LOAN) && attachments.length ? el('button', { type: 'button', class: 'quiet small-button', onclick: () => openCardCheck(card.code, 'return', state.board.group, card.attachments) }, '付属品を点検する') : null));
  }

  function supplyRow(line) {
    const perUnit = line.attachments.map((a) => `${a.name} ${a.expected_per_unit} 個/1 ${line.unit}`);
    const ok = el('input', { type: 'number', min: 0, max: line.lent, step: 1, inputmode: 'numeric', value: line.lent, 'aria-label': `${line.name}の返った数` });
    const lost = el('input', { type: 'number', min: 0, max: line.lent, step: 1, inputmode: 'numeric', value: 0, 'aria-label': `${line.name}の紛失・破損の数` });
    const memo = el('input', { maxlength: 200, autocomplete: 'off', 'aria-label': `${line.name}のメモ` });
    // The attachments of the returned units start from the returned count; the lost units show as missing.
    const counts = attachmentFields(line.attachments, (a) => a.expected_per_unit * line.lent);
    ok.addEventListener('input', () => {
      for (const { a, input } of counts.inputs) input.value = String(a.expected_per_unit * Math.max(0, Number(ok.value) || 0));
    });
    return el('article', { class: 'item-card' },
      el('div', { class: 'item-head' }, el('h4', { text: line.name }), el('p', { class: 'small', text: `貸出中 ${line.lent} ${line.unit}・在庫 ${line.on_hand} ${line.unit}` })),
      perUnit.length ? el('p', { class: 'small', text: `付属品：${perUnit.join('、')}` }) : null,
      can(LOAN) ? el('form', { class: 'stack', onsubmit: (event) => {
        event.preventDefault();
        sendReturn(event.currentTarget, {
          group: state.board.group,
          item: { id: line.item_id, name: line.name, unit: line.unit, version: line.version },
          ok, lost, memo, counts,
        });
      } },
      el('div', { class: 'grid-2' },
        el('label', {}, '返った数', ok),
        el('label', {}, '紛失・破損', lost)),
      counts.node,
      el('label', {}, 'メモ（任意）', memo),
      el('button', { type: 'submit', class: 'primary full' }, '返却を記録する')) : null);
  }

  function openCardCheck(code, phase, group, attachments) {
    state.cardCode = code;
    state.cardPanel = { code, phase, group, attachments: attachments || null };
    renderCardPanel();
    $('code-panel').scrollIntoView({ block: 'start' });
  }

  // Attachment check of one card: every attachment has a count, and the server works out the missing numbers.
  function cardCheckForm(data, group) {
    const phase = el('select', { 'aria-label': '点検の種類' }, Object.entries(PHASE_LABEL).map(([v, t]) => el('option', { value: v, text: t, selected: v === (state.cardPanel && state.cardPanel.phase) })));
    const inputs = data.attachments.map((a) => ({
      a,
      found: el('input', { type: 'number', min: 0, max: a.expected, step: 1, inputmode: 'numeric', value: a.expected, 'aria-label': `${a.name}の在った数` }),
      note: el('input', { maxlength: 200, autocomplete: 'off', placeholder: '例：1 本見当たらない', 'aria-label': `${a.name}のメモ` }),
    }));
    return el('form', { class: 'stack', onsubmit: (event) => {
      event.preventDefault();
      busy(event.currentTarget, async () => {
        const found = inputs.map((x) => ({ attachment_id: x.a.id, found: parseCount(x.found.value), note: x.note.value }));
        if (found.some((f) => f.found === null)) return say('在った数は 0 以上の整数で入力してください。', 'error');
        const body = { id: uuid(), owner_kind: 'card', owner_key: data.owner_key, phase: phase.value, units: 1, group: group || undefined, lines: found };
        await sendCheck(body, '付属品の点検');
        await renderCardPanelFresh();
        if (state.board) await loadBoard(state.board.group);
      });
    } },
    el('label', {}, '点検の種類', phase),
    inputs.map((x) => el('div', { class: 'check-row' },
      el('p', { class: 'small', text: `${x.a.name}（${x.a.expected} 個のはず）` }),
      el('label', {}, '在った数', x.found),
      el('label', {}, 'メモ', x.note))),
    el('button', { type: 'submit', class: 'primary full' }, '付属品の点検を保存する'));
  }

  // Sends one card check. A check that got no answer is kept in 未保存 and sent again with the same id; a check the
  // server refused is not kept (sending it again would be refused again): its message is shown for the count to be fixed.
  async function sendCheck(body, label) {
    try {
      const result = await request(`${API}/attachment-checks`, { method: 'POST', body });
      say(result.missing_total > 0 ? `${label}を保存しました。欠品 ${result.missing_total} 個があります。` : `${label}を保存しました。そろっています。`, result.missing_total > 0 ? 'warn' : 'ok');
      return true;
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        return false;
      }
      if (error.status === 0 || error.status >= 500) {
        state.pending.push({ body, label, message: error.message });
        say(`${label}は保存できませんでした。下の「未保存の点検」から再送できます。`, 'error');
        renderPending();
      } else {
        say(`${label}は保存されませんでした：${error.message}`, 'error');
      }
      return false;
    }
  }

  async function resendPending(index) {
    const item = state.pending[index];
    if (!item) return;
    try {
      await request(`${API}/attachment-checks`, { method: 'POST', body: item.body });
      state.pending.splice(index, 1);
      say(`${item.label}を保存しました。`, 'ok');
    } catch (error) {
      if (error.status === 0 || error.status >= 500) {
        say(`${item.label}を再送できませんでした：${error.message}`, 'error');
      } else {
        state.pending.splice(index, 1);
        say(`${item.label}は保存されませんでした：${error.message}`, 'error');
      }
    }
    renderPending();
  }

  function renderPending() {
    const box = $('pending-checks');
    box.hidden = state.pending.length === 0;
    box.replaceChildren(...state.pending.map((p, i) => el('div', { class: 'pending-row' },
      el('p', { class: 'small', text: `未保存：${p.label}（${p.message}）` }),
      el('button', { type: 'button', class: 'secondary small-button', onclick: () => resendPending(i) }, '再送する'))));
  }

  async function renderCardPanelFresh() {
    if (!state.cardPanel) return;
    try {
      const data = await request(`${API}/attachments?owner_kind=card&owner_key=${encodeURIComponent(state.cardPanel.code)}`);
      state.cardPanel.attachments = data.attachments;
      state.cardPanel.owner_key = data.owner_key;
      renderCardPanel();
    } catch (error) {
      say(error.message, 'error');
    }
  }

  function renderCardPanel() {
    const panel = state.cardPanel;
    const box = $('code-panel');
    if (!panel) return box.replaceChildren();
    if (!panel.attachments) return box.replaceChildren(el('p', { class: 'small', text: '付属品を読み込んでいます…' }));
    const data = { attachments: panel.attachments, owner_key: panel.code };
    const rows = panel.attachments.length ? panel.attachments.map((a) => el('li', { class: a.missing > 0 ? 'short' : '', text: attachmentStatus(a) })) : [el('li', { class: 'small', text: '付属品は登録されていません。' })];
    const addForm = can(ISSUE) ? el('form', { class: 'stack', onsubmit: (event) => {
      event.preventDefault();
      busy(event.currentTarget, async () => {
        const name = panel.addName.value;
        const count = Number(panel.addCount.value);
        const done = await act(() => request(`${API}/attachments`, { method: 'POST', body: { owner_kind: 'card', owner_key: panel.code, name, expected: count } }), () => `${name} を付属品に追加しました。`);
        if (done) await renderCardPanelFresh();
      });
    } }, el('label', {}, '付属品の名前', (panel.addName = el('input', { maxlength: 40, autocomplete: 'off' }))),
    el('label', {}, '個数', (panel.addCount = el('input', { type: 'number', min: 1, max: 99, step: 1, inputmode: 'numeric', value: 1 }))),
    el('button', { type: 'submit', class: 'secondary full' }, '付属品を追加する')) : null;
    box.replaceChildren(
      el('h4', { text: `個体 ${panel.code} の付属品` }),
      el('ul', { class: 'plain-list' }, rows),
      panel.attachments.length && can(LOAN) ? cardCheckForm(data, panel.group) : null,
      addForm);
  }

  async function openCode(event) {
    event.preventDefault();
    const code = $('code-input').value.trim().toUpperCase();
    if (!/^IY-[A-Z0-9-]+$/.test(code)) return say('個体コードは IY- で始まる番号で入力してください。', 'error');
    state.cardPanel = { code, phase: 'check', group: '', attachments: null };
    renderCardPanel();
    try {
      const data = await request(`${API}/attachments?owner_kind=card&owner_key=${encodeURIComponent(code)}`);
      state.cardPanel.attachments = data.attachments;
      state.cardPanel.owner_key = data.owner_key;
      renderCardPanel();
    } catch (error) {
      if (error.status === 401) return showLogin();
      state.cardPanel = null;
      renderCardPanel();
      say(error.message, 'error');
    }
  }

  // ---- printing: the 団体 sheet on A4 portrait, filled from the board that is on the screen.
  function printBoard() {
    const board = state.board;
    if (!board) return;
    const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const rows = [];
    for (const card of board.cards) {
      rows.push(el('tr', {},
        el('td', { text: '個体' }),
        el('td', { text: `${card.name}（${card.code}）` }),
        el('td', { text: card.irregular ? `${card.quantity} ${card.unit}` : '1' }),
        el('td', { class: 'blank' }),
        el('td', { text: card.attachments.map((a) => `${a.name} ${a.expected}`).join('、') || 'なし' }),
        el('td', { class: 'check', text: '☐' })));
    }
    for (const line of board.supplies) {
      rows.push(el('tr', {},
        el('td', { text: '数' }),
        el('td', { text: line.name }),
        el('td', { text: `${line.lent} ${line.unit}` }),
        el('td', { class: 'blank' }),
        el('td', { text: line.attachments.map((a) => `${a.name} ${a.expected_per_unit}/${line.unit}`).join('、') || 'なし' }),
        el('td', { class: 'check', text: '☐' })));
    }
    const sheet = $('print-sheet');
    sheet.replaceChildren(
      el('h1', { text: `団体の回収表：${board.group}` }),
      el('p', { text: `印刷日 ${today}　状況：${board.collected ? '回収済み' : `未回収（個体 ${board.cards_out} 件・数 ${board.units_out} 個）`}` }),
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: '区分' }), el('th', { text: '名称・個体コード' }), el('th', { text: '貸出数' }), el('th', { text: '返却数' }), el('th', { text: '付属品（1 個につき）' }), el('th', { text: '確認' }))),
        el('tbody', {}, rows.length ? rows : [el('tr', {}, el('td', { colspan: 6, text: 'この団体の貸出はありません。' }))])),
      el('p', { class: 'sign', text: '回収した人：　　　　　　　　　　確認した人：　　　　　　　　　　' }));
    window.print();
  }

  // ---- wiring

  function wire() {
    $('tab-lend').addEventListener('click', () => { showView('lend'); renderLend(); });
    $('tab-stock').addEventListener('click', () => { showView('stock'); renderStock(); });
    $('tab-collect').addEventListener('click', () => { showView('collect'); renderCollect(); });
    $('lend-group').addEventListener('input', (event) => { state.group = event.target.value; renderLend(); });
    $('lend-register').addEventListener('click', registerGroup);
    $('lend-submit').addEventListener('click', submitLend);
    $('lend-clear').addEventListener('click', () => { state.basket.clear(); state.lendFound.clear(); state.picking = null; renderLend(); });
    $('stock-refresh').addEventListener('click', loadAll);
    $('collect-refresh').addEventListener('click', loadCollect);
    $('item-form').addEventListener('submit', submitNewItem);
    $('board-refresh').addEventListener('click', () => state.boardGroup && loadBoard(state.boardGroup));
    $('board-print').addEventListener('click', printBoard);
    $('code-form').addEventListener('submit', openCode);
  }

  async function boot() {
    wire();
    try {
      const me = await request(`${RENTAL}/me`);
      state.perms = me.permissions || [];
      $('staff-name').textContent = me.staff ? me.staff.name || me.staff.id : '';
    } catch (error) {
      if (error.status === 401) return showLogin();
      say(error.message, 'error');
      return;
    }
    if (!can(LOAN) && !can(ISSUE)) {
      say('物品の権限がありません。管理者に依頼してください。', 'error');
      return;
    }
    $('login-panel').hidden = true;
    $('workspace').hidden = false;
    if (!can(LOAN)) showView('stock');
    renderTabs();
    await loadAll();
    // Coming back from a card's own page: reopen the board of the group named in the address.
    try {
      const match = /^#group=(.+)$/.exec(location.hash);
      if (match) openBoard(decodeURIComponent(match[1]));
    } catch {
      // A malformed address keeps the list.
    }
  }

  boot();
})();
