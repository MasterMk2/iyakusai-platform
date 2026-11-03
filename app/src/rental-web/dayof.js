// 本部からの連絡 on the rental screen (festival-day board, 2026-11-03): the open notices, read only. Temporary staff
// get only the notices the poster marked for them, with 本部 as the sender (the server decides, GET /api/dayof/notices).
// The box stays hidden before login, outside the festival days and when there is nothing to show; 至急 stays open,
// the others fold into one line so the scanning tools are not pushed down. DOM APIs and textContent only (the rental
// CSP allows no inline script or style, and notice text is never parsed as HTML).
//
// The list is built again only when the notices change (a refresh that brings the same ones only moves the "時点"
// time), so a focused fold keeps its focus; when it is rebuilt, the focus goes back to the new fold. A new 至急 is read
// out through one status line kept outside the box (the box itself is hidden when empty, and a status line inserted
// with its text already in it is often not read).
(() => {
  'use strict';
  const box = document.getElementById('dayof-notices');
  if (!box) return;
  const ACTIVE_MS = 30000;
  const IDLE_MS = 300000;
  const LABELS = { urgent: '至急', important: '重要', normal: '通常' };
  let timer = null;
  let busy = false;
  let urgentSeen = null; // ids of the open 至急 notices at the last read; null before the first read
  let delay = ACTIVE_MS;
  let shownKey = null; // what the list on screen was built from; null while the box is empty
  let stampNode = null;

  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  box.after(live);

  const timeFmt = (() => {
    try { return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return null; }
  })();
  const time = (iso) => { try { return timeFmt ? timeFmt.format(new Date(iso)) : ''; } catch { return ''; } };
  const dateFmt = (() => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { return null; }
  })();
  // The time, with the date in front for a notice of an earlier day (an open notice stays for the rest of the period).
  const stamp = (iso, today) => {
    try {
      const day = dateFmt ? dateFmt.format(new Date(iso)) : today;
      return day === today ? time(iso) : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} ${time(iso)}`;
    } catch { return time(iso); }
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function item(post, fresh, today) {
    const li = el('li', `dayof-n-item dayof-n-${post.priority}${fresh ? ' dayof-n-fresh' : ''}`);
    const head = el('p', 'dayof-n-line');
    if (post.priority !== 'normal') head.append(el('span', `dayof-n-tag dayof-n-tag-${post.priority}`, LABELS[post.priority] || ''));
    if (fresh) head.append(el('span', 'dayof-n-tag dayof-n-tag-new', '新着'));
    // 直しあり: the same words as the home screen.
    head.append(el('span', 'small', `${stamp(post.createdAt, today)}・${post.authorName}${post.edited ? '・直しあり' : ''}`));
    li.append(head, el('p', 'dayof-n-body', post.body));
    const where = [post.place, ...(post.departments || [])].filter(Boolean).join('・');
    if (where) li.append(el('p', 'small dayof-n-where', `関係：${where}`));
    return li;
  }

  /** The fold's line: "ほかの連絡 N 件" under 至急, otherwise the count with the levels that are there. */
  function foldLabel(others, afterUrgent) {
    if (afterUrgent) return `ほかの連絡 ${others.length} 件`;
    const levels = ['important', 'normal']
      .map((level) => [level, others.filter((p) => p.priority === level).length])
      .filter(([, n]) => n > 0)
      .map(([level, n]) => `${LABELS[level]} ${n}`);
    return `連絡 ${others.length} 件（${levels.join('・')}）`;
  }

  function announce(text) {
    // Emptied first, so the same words for a second arrival are read again.
    live.textContent = '';
    if (text) setTimeout(() => { live.textContent = text; }, 100);
  }

  function hide() {
    box.hidden = true;
    box.replaceChildren();
    shownKey = null;
    stampNode = null;
    live.textContent = '';
  }

  function render(data) {
    const posts = Array.isArray(data.posts) ? data.posts.filter((p) => p.status === 'open') : [];
    if (!data.active || posts.length === 0) {
      urgentSeen = data.active ? new Set() : null;
      hide();
      return;
    }
    const urgent = posts.filter((p) => p.priority === 'urgent');
    const others = posts.filter((p) => p.priority !== 'urgent');
    const fresh = new Set(urgentSeen ? urgent.filter((p) => !urgentSeen.has(p.id)).map((p) => p.id) : []);
    urgentSeen = new Set(urgent.map((p) => p.id));

    const day = data.day ? `当日 ${data.day.index}日目・` : '';
    const at = `${day}${time(new Date().toISOString())} 時点`;
    const key = JSON.stringify([data.today, posts.map((p) => [p.id, p.version, p.priority]), [...fresh]]);
    if (key === shownKey) {
      if (stampNode) stampNode.textContent = at;
      return;
    }

    const nodes = [];
    const head = el('div', 'dayof-n-head');
    head.append(el('h2', '', '本部からの連絡'));
    stampNode = el('span', 'small', at);
    head.append(stampNode);
    nodes.push(head);
    if (urgent.length > 0) {
      const list = el('ul', 'dayof-n-list');
      for (const p of urgent) list.append(item(p, fresh.has(p.id), data.today));
      nodes.push(list);
    }
    const before = box.querySelector('details.dayof-n-more');
    const hadFocus = !!before && before.contains(document.activeElement);
    let details = null;
    if (others.length > 0) {
      details = el('details', 'dayof-n-more');
      details.append(el('summary', '', foldLabel(others, urgent.length > 0)));
      const list = el('ul', 'dayof-n-list');
      for (const p of others) list.append(item(p, false, data.today));
      details.append(list);
      // Keep the fold open across refreshes when the person opened it.
      if (before && before.open) details.open = true;
      nodes.push(details);
    }
    box.replaceChildren(...nodes);
    box.classList.toggle('dayof-n-urgent', urgent.length > 0);
    box.hidden = false;
    shownKey = key;
    // The fold was rebuilt under the person's focus: give it back to the new fold.
    if (hadFocus && details) details.querySelector('summary').focus({ preventScroll: true });
    if (fresh.size > 0) announce(`本部から至急の連絡が ${fresh.size} 件届きました。`);
    else live.textContent = '';
  }

  async function load() {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const response = await fetch('/api/dayof/notices', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.status === 404) { hide(); delay = 0; return; } // the server has no board: stop asking
      if (response.status === 401 || response.status === 403) { hide(); delay = IDLE_MS; return; }
      if (!response.ok) return; // a passing failure keeps the last list on screen
      const data = await response.json();
      render(data);
      delay = data.active ? ACTIVE_MS : IDLE_MS;
    } catch {
      // Offline: keep what is on screen and try again at the next tick.
    } finally {
      busy = false;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (delay > 0 && document.visibilityState === 'visible') timer = setTimeout(load, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (delay > 0) void load(); }
    else { clearTimeout(timer); timer = null; }
  });
  void load();
})();
