'use strict';
// 返却チェックシートの印刷（/rental/print）。情報タブと同じ /api/rental/overview を読み、いま貸出中の物品を
// 団体別・返却場所別などの票にして、ブラウザの印刷（PDF保存を含む）に回す。サーバーには何も書き込まない。
const $ = (id) => document.getElementById(id);
const RULES_KEY = 'iyakusai-rental-print-rules-v1';
const FALLBACK = '返却先 要確認（本部へ）';
const FIELD_LABELS = { name: '品名に含む', owner: '借用元が', scope: '物品区分が' };
// 初期の規則。借用元や学内の返却場所は委員会ごとに違うので、物品の台帳と同じ場所の print-rules.json を
// 一覧の応答（print_rules）で受け取って初期の規則にする。無いときは品名だけのこの規則で始める。
const BASE_RULES = [
  { field: 'name', value: '発電機', location: '本部預かり（業者が設置場所から回収）' },
  { field: 'name', value: '配電盤', location: '本部預かり（業者が設置場所から回収）' },
];
// 貸出時のメモのうち、紙に載せても意味のないもの
const EMPTY_NOTES = new Set(['なし', '特になし', 'ありました', '写真のとおりです', '確認しました', '確認しました！']);
const SHEETS = ['guide', 'group', 'location', 'summary', 'progress', 'report'];
const state = { overview: null, defaults: BASE_RULES, saved: false, rules: null, loading: false };
state.rules = loadRules();

// ---- 小さな DOM 部品（文字列は必ず textContent で入れる）
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const cols = (...classes) => el('colgroup', {}, classes.map((c) => el('col', { class: c })));
const headRow = (...labels) => el('thead', {}, el('tr', {}, labels.map((l) => el('th', {}, ...String(l).split('\n').flatMap((part, i) => (i ? [el('br'), part] : [part]))))));
const box = () => el('td', { class: 'box', text: '□' });
const damageCell = (withCount) => el('td', { class: 'dmg' }, 'あり・なし', withCount ? [el('br'), '（　 個）'] : []);

// ---- 規則
const validRules = (rules) => Array.isArray(rules) && rules.every((r) => r && FIELD_LABELS[r.field] && typeof r.value === 'string' && typeof r.location === 'string');
const copyRules = (rules) => rules.map((r) => ({ field: r.field, value: r.value, location: r.location }));
function loadRules() {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) || 'null');
    if (validRules(saved)) { state.saved = true; return saved; }
  } catch { /* 壊れた保存は初期の規則で置き換える */ }
  return copyRules(state.defaults);
}
// 一覧の応答に初期の規則があれば、それを初期にする（この端末で規則を保存していなければ、いまの規則も置き換える）
function adoptDefaults(rules) {
  if (!validRules(rules)) return;
  state.defaults = copyRules(rules);
  if (!state.saved) { state.rules = copyRules(state.defaults); renderRules(); }
}
function locationOf(item) {
  for (const rule of state.rules) {
    const value = rule.value.trim(); const location = rule.location.trim();
    if (!value || !location) continue;
    if (rule.field === 'name' && item.rawName.includes(value)) return location;
    if (rule.field === 'owner' && item.owner === value) return location;
    if (rule.field === 'scope' && item.scope === value) return location;
  }
  return FALLBACK;
}
// 返却場所の並び：丸数字の番号順 → その他 → 要確認
const locationOrder = (a, b) => (a === FALLBACK) - (b === FALLBACK) || (a < b ? -1 : a > b ? 1 : 0);
const isCommittee = (name) => name.startsWith('実行委員会') || name.startsWith('医薬祭委員会');
const groupOrder = (a, b) => isCommittee(a) - isCommittee(b) || a.localeCompare(b, 'ja');

// ---- データ
function shortNumber(code) { const m = /^IY-1(\d{5})$/.exec(code); return m ? String(Number(m[1])) : ''; }
function displayName(name) { return String(name || '').replace(/^\[[A-Z]+\d+\]\s*/, '').trim() || '（品名なし）'; }
function ownerLabel(i) { return i.item_owner || (i.item_scope === '学内' ? '学内' : i.item_scope === '委員会' ? '委員会' : '要確認'); }
function normalize(raw) {
  const note = String(raw.lent_note || '').replace(/\s+/g, ' ').trim();
  const item = {
    code: String(raw.code), no: shortNumber(String(raw.code)), rawName: String(raw.name || ''), name: displayName(raw.name),
    owner: raw.item_owner ? String(raw.item_owner) : '', scope: raw.item_scope ? String(raw.item_scope) : '', ownerLabel: ownerLabel(raw),
    group: raw.group?.name ? String(raw.group.name) : '（団体名なし）', phase: raw.phase,
    damaged: raw.lent_condition === 'damage', note: EMPTY_NOTES.has(note) ? '' : note,
  };
  item.location = locationOf(item);
  return item;
}
function allItems() { return (state.overview?.items || []).map(normalize); }
function loanedItems() {
  const group = $('filter-group').value; const location = $('filter-location').value;
  return allItems().filter((i) => i.phase === 'loaned' && (!group || i.group === group) && (!location || i.location === location));
}
function itemNotes(i) {
  const notes = [];
  if (i.damaged) notes.push({ text: `貸出時から損傷あり${i.note ? '：' + i.note : ''}`, warn: true });
  else if (i.note) notes.push({ text: `貸出時メモ：${i.note}` });
  return notes;
}
function noteNodes(notes) { return notes.map((n) => el('div', { class: n.warn ? 'xs warn' : 'xs', text: n.text })); }
function ranges(numbers) {
  const nums = [...new Set(numbers.filter(Boolean).map(Number))].sort((a, b) => a - b); const out = [];
  for (let i = 0; i < nums.length;) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j += 1; out.push(i === j ? `${nums[i]}` : `${nums[i]}〜${nums[j]}`); i = j + 1; }
  return out.join(', ');
}
const byItem = (a, b) => a.ownerLabel.localeCompare(b.ownerLabel, 'ja') || a.name.localeCompare(b.name, 'ja') || (Number(a.no) || 0) - (Number(b.no) || 0) || (a.code < b.code ? -1 : 1);
function bucket(items, keyOf) { const map = new Map(); for (const i of items) { const k = keyOf(i); if (!map.has(k)) map.set(k, []); map.get(k).push(i); } return map; }
function timeLabel(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '不明';
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const sourceLine = () => `データ時点：${timeLabel(state.overview.generated_at)}（物品管理システムの貸出記録）`;

// ---- 票
function page(title, sub, ...body) { return el('section', { class: 'sheet' }, el('h2', { class: 'title', text: title }), el('p', { class: 'sub', text: `${sourceLine()}　｜　${sub}` }), body); }

function guideSheet(items, groups, locations) {
  const damaged = items.filter((i) => i.damaged).length;
  return page('物品返却チェックシートの使い方', '最初に読む',
    el('p', { text: `対象：貸出中 ${items.length} 点・${groups.length} 団体名義。返却場所は ${locations.length} か所（${locations.join('、')}）。` }),
    el('ol', { class: 'guide' },
      el('li', {}, el('b', { text: '出展場所で確認' }), '（団体別）：団体の物品を1か所に集め、品目ごとに数えて「確認数」に書く。破損・不足は○と個数。委員と団体代表者が署名し、「移動してよい」に✓。'),
      el('li', {}, el('b', { text: '返却場所へ運ぶ' }), '：「返却場所」列の場所へ。1つの団体が複数の場所に分かれて返すことがある。'),
      el('li', {}, el('b', { text: '返却場所で再確認' }), '（返却場所別）：その場所の担当が団体ごとに1点ずつ「受領」に✓し、破損の有無に○。一覧に無い物が来たら空欄に書く。'),
      el('li', {}, el('b', { text: '本部へ報告' }), '（進捗表）：場所ごとの受領が済んだら本部の進捗表に✓。全部そろい、破損の扱いが決まった団体を「完了」にする。'),
      el('li', {}, el('b', { text: 'システムへ入力' }), '：返却場所別一覧を本部で回収し、管理No.ごとにアプリで返却を登録する（破損ありは「破損・不足」）。入力したら「入力済」に✓。'),
      el('li', {}, el('b', { text: '破損・不足・未返却' }), '：その場で報告票に1行ずつ書いて本部へ連絡。戻っていない物品は返却済みにしない。')),
    el('div', { class: 'note' },
      el('b', { text: '注意' }), el('br'),
      `・${timeLabel(state.overview.generated_at)} 時点でシステムに「貸出中」と登録されている物品だけを載せている。未登録の物品は載らない。`, el('br'),
      '・管理No.は物品管理システムの番号（例：IY-100221 ＝ No.221）。物品に貼ったラベルと照合する。', el('br'),
      `・「貸出時から損傷あり」（${damaged} 点）は貸出のときに記録済みの傷。新しい破損と区別する。`, el('br'),
      '・返却場所は、印刷画面の「返却場所の決め方（規則）」で借用元・区分・品名から決めている。'));
}

function groupSheets(items, groups, blankPages) {
  const pages = [];
  const table = (rows) => el('table', {}, cols('w6', '', 'w22', 'w11', 'w33', 'w15', 'w17', 'w44'),
    headRow('#', '品目', '貸出元', '数量', '返却場所', '出展場所\n確認数', '破損', '備考'), el('tbody', {}, rows));
  const footer = () => [
    el('div', { class: 'note' }, '・品目ごとに数を数え「確認数」に書く。破損・不足があれば○と個数を書き、「破損・不足・未返却 報告票」にも1行書く。', el('br'),
      '・「貸出時から損傷あり」は貸出の時点で記録済みの傷。今回の破損と区別する。', el('br'), '・確認が済んだら、返却場所ごとに物品を運ぶ（複数の場所に分かれることがある）。'),
    el('table', { class: 'sign' }, cols('p24', 'p28', 'p16', 'p32'),
      el('tbody', {}, el('tr', {}, el('td', { text: '点検した委員（署名）' }), el('td'), el('td', { text: '時刻' }), el('td', { text: '　　　：' })),
        el('tr', {}, el('td', { text: '団体代表者（署名）' }), el('td'), el('td', { text: '返却場所へ' }), el('td', { text: '□ 移動してよい　□ 保留' }))))];
  for (const g of groups) {
    const mine = items.filter((i) => i.group === g);
    const kinds = [...bucket(mine.sort((a, b) => locationOrder(a.location, b.location) || byItem(a, b)), (i) => `${i.location}\u0000${i.ownerLabel}\u0000${i.name}`).values()];
    const rows = kinds.map((its, n) => {
      const first = its[0]; const nums = ranges(its.map((i) => i.no));
      const notes = [];
      const damaged = its.filter((i) => i.damaged);
      if (damaged.length) notes.push({ text: `貸出時から損傷あり：${ranges(damaged.map((i) => i.no)) ? 'No.' + ranges(damaged.map((i) => i.no)) : damaged.length + ' 点'}`, warn: true });
      return el('tr', {}, el('td', { class: 'c s', text: n + 1 }),
        el('td', {}, first.name, el('div', { class: 'xs', text: `管理No. ${nums || its.map((i) => i.code).join(', ')}` })),
        el('td', { class: 's', text: first.ownerLabel }), el('td', { class: 'qty', text: its.length }), el('td', { class: 's', text: first.location }),
        el('td', { class: 'r s', text: `／${its.length}` }), damageCell(true), el('td', {}, noteNodes(notes)));
    });
    for (let k = 0; k < 2; k += 1) rows.push(el('tr', { class: 'blank' }, el('td', { class: 'c xs', text: '追加' }), el('td'), el('td'), el('td'), el('td'), el('td'), damageCell(false), el('td')));
    pages.push(page('返却チェック表（団体別）', '出展場所で、返却場所へ運ぶ前に使う',
      el('div', { class: 'big' }, g, el('span', { text: `　計 ${mine.length} 点・${kinds.length} 品目` })), table(rows), footer()));
  }
  for (let p = 0; p < blankPages; p += 1) {
    const rows = Array.from({ length: 18 }, (_, n) => el('tr', { class: 'blank' }, el('td', { class: 'c s', text: n + 1 }), el('td'), el('td'), el('td'), el('td'), el('td'), damageCell(true), el('td')));
    pages.push(el('section', { class: 'sheet' }, el('h2', { class: 'title', text: '返却チェック表（団体別・手書き用）' }), el('p', { class: 'sub', text: '一覧に無い団体・物品が見つかったときに使う' }),
      el('div', { class: 'big', text: '団体名：' }), table(rows), footer()[1]));
  }
  return pages;
}

function locationSheets(items, groups, locations) {
  return locations.map((loc) => {
    const here = items.filter((i) => i.location === loc); const rows = [];
    for (const g of groups) {
      const mine = here.filter((i) => i.group === g).sort(byItem);
      if (!mine.length) continue;
      rows.push(el('tr', { class: 'grp' }, el('td', { colspan: 8, text: `${g}（${mine.length} 点）　受け取った委員：　　　　　　　時刻　　：` })));
      for (const i of mine) {
        rows.push(el('tr', {}, box(), el('td', { class: 's' }, i.no ? `No.${i.no}` : '－', el('div', { class: 'xs', text: i.code })),
          el('td', {}, i.name, noteNodes(itemNotes(i))), el('td', { class: 's', text: g }), el('td', { class: 'xs', text: loc }), damageCell(false), el('td'), box()));
      }
    }
    for (let k = 0; k < 4; k += 1) rows.push(el('tr', { class: 'blank' }, box(), el('td'), el('td'), el('td'), el('td'), damageCell(false), el('td'), box()));
    return page('返却物品一覧（返却場所別）', '返却場所で、受け取るときに1点ずつ確認する',
      el('div', { class: 'loc' }, loc, el('span', { text: `　計 ${here.length} 点` })),
      el('table', {}, cols('w9', 'w20', '', 'w33', 'w22', 'w19', 'w26', 'w10'),
        headRow('受領', '管理No.', '物品名', '団体名義', '返却先', '破損', '備考', '入力\n済'), el('tbody', {}, rows)));
  });
}

function summarySheet(items, locations) {
  const ledger = bucket(allItems().filter((i) => i.phase !== 'archived'), (i) => `${i.location}\u0000${i.ownerLabel}\u0000${i.name}`);
  const rows = [];
  for (const loc of locations) {
    const kinds = [...bucket(items.filter((i) => i.location === loc).sort(byItem), (i) => `${i.ownerLabel}\u0000${i.name}`).entries()];
    rows.push(el('tr', { class: 'grp' }, el('td', { colspan: 7, text: `${loc}（団体から ${kinds.reduce((n, [, its]) => n + its.length, 0)} 点）` })));
    for (const [key, its] of kinds) {
      const total = ledger.get(`${loc}\u0000${key}`)?.length ?? its.length;
      rows.push(el('tr', {}, el('td', { class: 's', text: its[0].ownerLabel }), el('td', { text: its[0].name }), el('td', { class: 'qty', text: its.length }),
        el('td', { class: 'c', text: total }), el('td'), el('td'), el('td')));
    }
  }
  return page('返却場所別 品目集計', '返却場所の締めに使う',
    el('div', { class: 'note' }, '「団体から戻る数」＝システムで貸出中の数。「台帳の総数」＝同じ品目としてシステムに登録された個体の総数（貸出していない物・返却済みも含む）。業者・学務への引き渡しは実物を数えて「受領数」に書く。'),
    el('table', {}, cols('w28', '', 'w17', 'w15', 'w16', 'w12', 'w40'), headRow('貸出元', '品目', '団体から\n戻る数', '台帳の\n総数', '受領数', '差', '備考（破損・不足）'), el('tbody', {}, rows)));
}

function progressSheet(items, groups, locations) {
  const head = locations.map((l) => (/^[①-⑳]/.test(l) ? l[0] : l.slice(0, 4)));
  const rows = groups.map((g) => {
    const mine = items.filter((i) => i.group === g);
    return el('tr', {}, el('td', { class: 's', text: g }), el('td', { class: 'r', text: mine.length }), box(),
      locations.map((l) => { const n = mine.filter((i) => i.location === l).length; return n ? el('td', { class: 'c' }, '□', el('span', { class: 'xs', text: n })) : el('td', { class: 'c xs', text: '－' }); }),
      el('td', { class: 'c s', text: '有・無' }), box());
  });
  for (let k = 0; k < 5; k += 1) rows.push(el('tr', { class: 'blank' }, el('td'), el('td'), box(), locations.map(() => el('td')), el('td', { class: 'c s', text: '有・無' }), box()));
  return page('返却 進捗表（本部用）', '□の右の数字＝その場所へ返す点数。受領が済んだら□に✓',
    el('table', {}, cols('', 'w10', 'w14', locations.map(() => 'w12'), 'w13', 'w11'), headRow('団体名義', '点数', '出展場所\n点検済', ...head, '破損\n不足', '完了'), el('tbody', {}, rows)),
    el('div', { class: 'note' }, locations.join('　'), el('br'), '「完了」＝全返却場所で受領済みで、破損・不足の扱いが決まった状態。'));
}

function reportSheet() {
  const rows = Array.from({ length: 18 }, () => el('tr', { class: 'tall' }, el('td'), el('td'), el('td'), el('td'), el('td', { class: 'xs c' }, '破損・不足', el('br'), '未返却・他'), el('td'), el('td'), box(), box()));
  return el('section', { class: 'sheet' }, el('h2', { class: 'title', text: '破損・不足・未返却 報告票' }), el('p', { class: 'sub', text: '各点検場所・各返却場所に1枚ずつ置き、最後に本部で回収する。1行に1物品' }),
    el('table', {}, cols('w12', 'w30', '', 'w17', 'w17', 'w44', 'w16', 'w10', 'w10'), headRow('時刻', '団体名義', '物品名', '管理No.', '区分（○）', '状況（どこが・いくつ）', '記入者', '本部\n連絡', '入力\n済'), el('tbody', {}, rows)));
}

// ---- 画面
function render() {
  const out = $('sheets'); out.replaceChildren();
  if (!state.overview) return;
  const items = loanedItems();
  const groups = [...new Set(items.map((i) => i.group))].sort(groupOrder);
  const locations = [...new Set(items.map((i) => i.location))].sort(locationOrder);
  const chosen = new Set([...document.querySelectorAll('input[name=sheet]:checked')].map((c) => c.value));
  const blankPages = Math.max(0, Math.min(10, Number($('blank-pages').value) || 0));
  const pages = [];
  if (chosen.has('guide')) pages.push(guideSheet(items, groups, locations));
  if (chosen.has('group')) pages.push(...groupSheets(items, groups, blankPages));
  if (chosen.has('location')) pages.push(...locationSheets(items, groups, locations));
  if (chosen.has('summary')) pages.push(summarySheet(items, locations));
  if (chosen.has('progress')) pages.push(progressSheet(items, groups, locations));
  if (chosen.has('report')) pages.push(reportSheet());
  out.append(...pages);
  const fallback = items.filter((i) => i.location === FALLBACK).length;
  $('status').textContent = `${timeLabel(state.overview.generated_at)} 時点：貸出中 ${items.length} 点・${groups.length} 団体名義・返却場所 ${locations.length} か所。`
    + (fallback ? `返却先が決まらない物品が ${fallback} 点あります（規則を確認）。` : '') + (items.length ? '' : '印刷する物品がありません。');
  $('print').disabled = !pages.length;
  renderRuleCheck();
}
function fillFilters() {
  const items = allItems().filter((i) => i.phase === 'loaned');
  for (const [id, values] of [['filter-group', [...new Set(items.map((i) => i.group))].sort(groupOrder)], ['filter-location', [...new Set(items.map((i) => i.location))].sort(locationOrder)]]) {
    const select = $(id); const keep = select.value;
    select.replaceChildren(select.options[0], ...values.map((v) => el('option', { value: v, text: v })));
    select.value = values.includes(keep) ? keep : '';
  }
}
function renderRules() {
  $('rules').replaceChildren(...state.rules.map((rule, index) => {
    const field = el('select', { 'aria-label': `規則${index + 1}の見る項目` }, Object.entries(FIELD_LABELS).map(([k, v]) => el('option', { value: k, text: v })));
    field.value = rule.field; field.addEventListener('change', () => { rule.field = field.value; });
    const value = el('input', { value: rule.value, 'aria-label': `規則${index + 1}の値` }); value.addEventListener('input', () => { rule.value = value.value; });
    const location = el('input', { value: rule.location, 'aria-label': `規則${index + 1}の返却場所` }); location.addEventListener('input', () => { rule.location = location.value; });
    const up = el('button', { type: 'button', class: 'mini', text: '↑', 'aria-label': `規則${index + 1}を上へ` }); up.disabled = index === 0;
    up.addEventListener('click', () => { [state.rules[index - 1], state.rules[index]] = [state.rules[index], state.rules[index - 1]]; renderRules(); });
    const del = el('button', { type: 'button', class: 'mini', text: '削除', 'aria-label': `規則${index + 1}を削除` });
    del.addEventListener('click', () => { state.rules.splice(index, 1); renderRules(); });
    return el('tr', {}, el('td', {}, field), el('td', {}, value), el('td', {}, location), el('td', { class: 'nowrap' }, up, del));
  }));
}
function renderRuleCheck() {
  const items = allItems().filter((i) => i.phase === 'loaned');
  const kinds = [...bucket(items, (i) => `${i.owner}\u0000${i.scope}\u0000${i.location}`).values()].sort((a, b) => locationOrder(a[0].location, b[0].location) || b.length - a.length);
  $('rule-check').replaceChildren(...kinds.map((its) => el('tr', { class: its[0].location === FALLBACK ? 'warn-row' : '' },
    el('td', { text: its[0].owner || '（空欄）' }), el('td', { text: its[0].scope || '（空欄）' }),
    el('td', { text: [...new Set(its.map((i) => i.name))].slice(0, 3).join('、') }), el('td', { class: 'r', text: its.length }), el('td', { text: its[0].location }))));
}
async function load() {
  if (state.loading) return; state.loading = true; $('reload').disabled = true; $('status').textContent = '読み込み中…';
  try {
    const response = await fetch('/api/rental/overview', { credentials: 'same-origin', cache: 'no-store' });
    let body = null; try { body = await response.json(); } catch { /* 下で扱う */ }
    if (response.status === 401) throw new Error('ログインが必要です。「物品の画面へ戻る」からログインしてから、この画面を開き直してください。');
    if (response.status === 403) throw new Error(body?.error || 'この医薬祭アカウントには物品の情報を見る権限がありません。');
    if (!response.ok || !Array.isArray(body?.items)) throw new Error(body?.error || '物品の情報を読み込めませんでした。もう一度「最新の情報を読み込む」を押してください。');
    state.overview = body; adoptDefaults(body.print_rules); fillFilters(); render();
  } catch (err) {
    $('status').textContent = err instanceof TypeError ? '通信できません。接続を確認して「最新の情報を読み込む」を押してください。' : err.message;
    if (!state.overview) $('print').disabled = true;
  } finally { state.loading = false; $('reload').disabled = false; }
}

document.addEventListener('DOMContentLoaded', () => {
  renderRules();
  $('reload').addEventListener('click', load);
  $('print').addEventListener('click', () => window.print());
  for (const input of document.querySelectorAll('input[name=sheet], #filter-group, #filter-location, #blank-pages')) input.addEventListener('change', render);
  $('rule-add').addEventListener('click', () => { state.rules.push({ field: 'owner', value: '', location: '' }); renderRules(); });
  $('rule-save').addEventListener('click', () => {
    state.rules = state.rules.filter((r) => r.value.trim() && r.location.trim()).map((r) => ({ field: r.field, value: r.value.trim(), location: r.location.trim() }));
    state.saved = true;
    try { localStorage.setItem(RULES_KEY, JSON.stringify(state.rules)); } catch { /* 保存できなくても今回の表示には反映する */ }
    renderRules(); fillFilters(); render();
  });
  $('rule-reset').addEventListener('click', () => {
    state.saved = false; state.rules = copyRules(state.defaults);
    try { localStorage.removeItem(RULES_KEY); } catch { /* 無視 */ }
    renderRules(); fillFilters(); render();
  });
  load();
});
