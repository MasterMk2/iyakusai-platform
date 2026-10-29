/* 医薬祭物品貸出: no analytics, no remote runtime resources. */
'use strict';
const $ = (id) => document.getElementById(id);
const state = { db: null, staff: null, serverMode: '', borrowers: [], config: { mode: 'borrow', borrower: '' }, draft: null, queue: [], cameraMode: null, stream: null, nfcAbort: null, detector: null, uploadBusy: false, commitBusy: false, photoBusy: false, opening: false, photoURLs: [], scanTimer: null, pollTimer: null, pollDelay: 5000, qrLoad: null, visible: true, view: 'work', overview: null, overviewBusy: false, openGroups: new Set(), reader: null, infoOpenedAt: 0, infoInteractedAt: 0, infoTouching: false, overviewForce: null, overviewPending: false, overviewShownSignature: '', infoHasInteracted: false, infoInteractionSeq: 0, infoPointers: new Set(), infoRenderRequested: false, infoRenderTimer: null };
const LABELS = { pending: '端末・未送信', uploading: '送信中', error: '未送信・再送', conflict: '競合・要確認', archived_conflict: '未受付・保管', complete: 'Drive保存済み', drive_pending: '受付済・Drive待ち', local_saved: 'サーバー保存済み', drive_error: '受付済・Driveエラー' };
const STATUS_LABELS = { ready: '貸出可能', available: '貸出可能', loaned: '貸出中', borrowed: '貸出中', review: '要確認', maintenance: '要清掃・整備', damage: '破損・不足', hold: '要確認' };
const CONDITION_LABELS = { normal: '異常なし', maintenance: '要清掃・整備', damage: '破損・不足' };
const clone = (v) => structuredClone(v);
const uuid = () => crypto.randomUUID();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const available = (item) => ['ready', 'available'].includes(item.status);
const loaned = (item) => ['loaned', 'borrowed'].includes(item.status);
function legacyPhotoPolicy(item) {
  // The older cached item did not have this field; the explicit scope follows the same committee rule.
  return item.photo_required === undefined && ['学内', '学外', '委員会'].includes(item.item_scope) ? { ...item, photo_required: item.item_scope === '学外' } : item;
}
let labelDownloadURL;
let labelExport = null;
function clearLabelExport() { labelExport = null; if (labelDownloadURL) URL.revokeObjectURL(labelDownloadURL); labelDownloadURL = null; $('label-download').hidden = true; $('label-export').hidden = true; }
async function labelPDFHash(blob) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function downloadLabelExport() { if (!labelExport) return; const blob = new Blob([labelExport.json], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${labelExport.basename}.issuance.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
let pollCursor = 0;

function message(text, error = false, anchor = state.feedbackAnchor) {
  const box = $('message');
  const target = anchor?.isConnected && !anchor.closest('[hidden]') ? anchor : !$('workspace').hidden ? document.querySelector('.identify') : $('login-panel');
  target.append(box);
  box.textContent = text; box.hidden = !text; box.classList.toggle('error', error); box.setAttribute('role', error ? 'alert' : 'status');
}
function staffKey(key) { return `${key}:${state.staff.id}`; }
async function dbOpen() { return new Promise((resolve, reject) => { const req = indexedDB.open('iyakusai-rental-v1', 1); req.onupgradeneeded = () => { const db = req.result; db.createObjectStore('settings'); db.createObjectStore('items', { keyPath: 'code' }); db.createObjectStore('operations', { keyPath: 'id' }); }; req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

// Store photo bytes in the IndexedDB record, avoiding WebKit's file-backed Blob storage path.
// The database version and existing records stay intact; old Blob records remain readable.
async function recordForStorage(value) {
  if (!value || !Array.isArray(value.photos)) return value;
  const photos = await Promise.all(value.photos.map(async (photo) => photo?.blob instanceof Blob
    ? { ...photo, blob: { format: 'iyakusai-photo-bytes/v1', type: photo.blob.type || 'image/jpeg', bytes: await photo.blob.arrayBuffer() } }
    : photo));
  return { ...value, photos };
}
function recordFromStorage(value) {
  if (!value || !Array.isArray(value.photos)) return value;
  return { ...value, photos: value.photos.map((photo) => photo?.blob?.format === 'iyakusai-photo-bytes/v1' && photo.blob.bytes instanceof ArrayBuffer
    ? { ...photo, blob: new Blob([photo.blob.bytes], { type: photo.blob.type || 'image/jpeg' }) }
    : photo) };
}
async function storageRetry(work) {
  try { return await work(); }
  catch (error) {
    if (!['InvalidStateError', 'UnknownError', 'TransactionInactiveError'].includes(error?.name)) throw error;
    try { state.db.close(); } catch {}
    state.db = await dbOpen();
    return work(); // Same keys and operation UUID: a retry never creates a second operation.
  }
}
function dbGet(store, key) { return storageRetry(() => new Promise((resolve, reject) => { const req = state.db.transaction(store).objectStore(store).get(key); req.onsuccess = () => resolve(recordFromStorage(req.result)); req.onerror = () => reject(req.error); })); }
function dbAll(store) { return storageRetry(() => new Promise((resolve, reject) => { const req = state.db.transaction(store).objectStore(store).getAll(); req.onsuccess = () => resolve(req.result.map(recordFromStorage)); req.onerror = () => reject(req.error); })); }
async function dbWriteBatch(records) {
  // Finish all asynchronous Blob reads BEFORE opening a transaction (Safari may auto-close an idle one).
  const prepared = await Promise.all(records.map(async (r) => ({ ...r, value: await recordForStorage(r.value) })));
  await storageRetry(() => new Promise((resolve, reject) => {
    const tx = state.db.transaction([...new Set(prepared.map(r => r.store))], 'readwrite'); let requestError;
    tx.oncomplete = resolve;
    tx.onerror = (event) => { requestError = event.target?.error || tx.error; };
    tx.onabort = () => reject(requestError || tx.error || new DOMException('端末への保存を完了できませんでした', 'AbortError'));
    try { for (const r of prepared) { const obj = tx.objectStore(r.store); r.key === undefined ? obj.put(r.value) : obj.put(r.value, r.key); } }
    catch (error) { try { tx.abort(); } catch {} reject(error); }
  }));
  if (state.staff && records.some(r => r.store === 'settings' && r.key === staffKey('draft'))) state.localDraftUnsaved = false;
}
function dbPut(store, value, key) { return dbWriteBatch([{store, value, key}]); }
function localSaveMessage(error) {
  const code = ['QuotaExceededError','DataCloneError','InvalidStateError','UnknownError','TransactionInactiveError','AbortError','NotAllowedError','SecurityError'].includes(error?.name) ? error.name : '保存エラー';
  const why = code === 'QuotaExceededError' ? '端末の一時保存領域が足りません。端末のストレージ設定で空き容量を確認してください。' : 'ブラウザの一時保存に失敗しました（' + code + '）。';
  return why + ' 写真と入力はこの画面に保持しています。画面を閉じずに「次へ」または登録をもう一度押してください。サイトデータは削除しないでください。';
}
async function saveDraft() { await dbPut('settings', state.draft, staffKey('draft')); }
async function saveConfig() { await dbPut('settings', state.config, staffKey('config')); }
function saveSelection(config, draft) {
  return dbWriteBatch([{store:'settings', key:staffKey('config'), value:config}, {store:'settings', key:staffKey('draft'), value:draft}]);
}

const registrationMode = () => ['borrow', 'return', 'check'].includes(state.config.mode);
function draftHasContent() { return !!(state.draft && (state.draft.irregularTouched || state.draft.photos.length || state.draft.note?.trim() || $('note').value.trim() || state.draft.damageSelected || (state.draft.condition && state.draft.condition !== 'normal') || (state.draft.stage && state.draft.stage !== flowStages(state.draft)[0]))); }
function lockedDraft() { return state.photoBusy || state.commitBusy || state.opening; }
async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = method === 'GET' ? options.headers : { ...(options.headers || {}), 'X-SMM-CSRF': '1' };
  const response = await fetch(path.replace(/^\/api\//, '/api/rental/'), { credentials: 'same-origin', cache: 'no-store', ...options, headers }).catch(() => { throw new Error('通信できません。接続を確認して再送してください。'); });
  let result; try { result = await response.json(); } catch { throw Object.assign(new Error('サーバーの応答を確認できません。再送できます。'), { status: response.status }); }
  if (!response.ok) { const e = Object.assign(new Error(result.error || '処理を完了できませんでした'), { status: response.status, code: result.code }); if (response.status === 401) showLogin(); throw e; }
  return result;
}
function showLogin(text = '医薬祭アカウントでログインしてください。ログインすると、この画面に戻ります。', canLogin = true) { state.staff = null; if (state.reader) state.reader.readGeneration = (state.reader.readGeneration || 0) + 1; stopCamera(); stopNFC(); $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; $('staff-name').textContent = ''; $('login-text').textContent = text; $('login-button').hidden = !canLogin; }
async function activateSession(result) {
  if (!(result.permissions || []).includes('rental.loan')) { showLogin('この医薬祭アカウントには物品の貸出・返却の権限がありません。権限管理者に付与を依頼してください。', false); return; }
  state.staff = result.staff; state.serverMode = result.mode || ''; if (!state.staff?.id) throw new Error('スタッフ情報を取得できません');
  state.canEditItems = result.can_edit_items === true && (result.capabilities || []).includes('item_edit_v1');
  state.canCorrect = result.can_correct === true && (result.capabilities || []).includes('operation_corrections_v1');
  state.trialShortCodes = result.trial_short_codes === true;
  state.config = (await dbGet('settings', staffKey('config'))) || { mode: 'borrow', borrower: '' };
  state.draft = (await dbGet('settings', staffKey('draft'))) || null;
  if (state.draft) { const item = legacyPhotoPolicy(state.draft.item); if (item !== state.draft.item) { state.draft.item = item; await saveDraft(); } }
  if (state.draft) state.draft.cached = true;
  state.queue = (await dbAll('operations')).filter((op) => op.owner === state.staff.id);
  for (const op of state.queue) if (op.status === 'uploading') { op.status = 'pending'; await dbPut('operations', op); }
  $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = true; $('staff-name').textContent = state.staff.name || state.staff.id;
  if (result.temporary_staff === true) {
    document.querySelectorAll('.global-nav a').forEach(a => { if (a.getAttribute('href') !== '/rental') a.closest('li').hidden = true; });
    document.querySelector('.brand').href = '/rental';
    $('logout').hidden = false;
    $('logout').onclick = async () => {
      if (state.localDraftUnsaved) { message('写真をまだ端末に保存できていません。ログアウトせず、写真の保存または登録を再試行してください。', true); return; }
      if (state.uploadBusy || state.commitBusy || lockedDraft()) { message('処理が終わってからログアウトしてください。', true); return; }
      const pending = state.queue.filter(op => !['complete','drive_pending','local_saved','drive_error'].includes(op.status));
      if ((draftHasContent() || pending.length) && !confirm('入力中・未送信の内容はこの端末に残ります。同じアカウントで再ログインして続けられます。ログアウトしますか？')) return;
      try {
        const response = await fetch('/api/auth/logout', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-SMM-CSRF':'1'}, body:'{}'});
        if (!response.ok) throw new Error();
        showLogin(); location.assign('/');
      } catch { message('ログアウトできませんでした。通信を確認してください。', true); }
    };
  }
  $('borrower').value = state.config.borrower || ''; renderBatch(); renderDraft(); renderQueue(); connection();
  if (state.serverMode === 'demo') message('ローカル試験モードです。Google Driveへの保存は行いません。');
  if (state.serverMode === 'local') message('サーバーに保存します。Googleドライブへの複製は設定されていません。');
  if (state.serverMode === 'mounted_drive') message('共有ドライブの実験フォルダーに保存します。クラウドとの同期完了は、この画面では未確認です。');
  state.borrowers = (await dbGet('settings', staffKey('borrowers'))) || []; renderBorrowers();
  request('/api/borrowers').then(async (v) => { state.borrowers = v.borrowers || []; renderBorrowers(); await dbPut('settings', state.borrowers, staffKey('borrowers')); }).catch(() => {});
  const deepCode = codeFromInput(location.href);
  if (state.draft && deepCode && deepCode !== state.draft.item.code && state.config.mode !== 'check') message(`前の物品 ${state.draft.item.code} が入力中です。登録または「この物品を閉じる」の後、${deepCode} を開いてください。`);
  else if (state.draft && !draftHasContent()) await openItem(deepCode || state.draft.item.code);
  else if (deepCode && !state.draft) await openItem(deepCode);
  void processQueue(); schedulePoll(); void storageInfo();
}
function connection() { $('connection').textContent = navigator.onLine ? (state.staff ? 'オンライン' : 'ログイン前') : '通信なし'; }
function renderBorrowers() { $('borrower-options').replaceChildren(...state.borrowers.map((name) => { const option = document.createElement('option'); option.value = name; return option; })); }
function plannedBorrowerChoice(item, config, mode) {
  if (mode === 'borrow' && available(item) && item.planned_state === 'pending' && item.planned_borrower_id && item.planned_borrower_name) return { borrower: item.planned_borrower_name, borrowerSource: 'planned', plannedFor: item.code };
  if (mode === 'borrow' && config.borrowerSource === 'planned') return { borrower: '', borrowerSource: '', plannedFor: '' };
  return { borrower: config.borrower || '', borrowerSource: config.borrowerSource || 'manual', plannedFor: config.plannedFor || '' };
}
async function applyPlannedBorrower(item) {
  const choice = plannedBorrowerChoice(item, state.config, state.config.mode);
  Object.assign(state.config, choice);
  if (choice.borrower && !state.borrowers.includes(choice.borrower) && choice.borrowerSource === 'planned') { state.borrowers.push(choice.borrower); renderBorrowers(); }
  $('borrower').value = state.config.borrower;
  await saveConfig(); renderBatch();
}
function renderBatch() {
  const borrow = state.config.mode === 'borrow'; $('borrower-row').hidden = !borrow; $('photo-skip-row').hidden = !borrow; $('photo-skip').checked = !!state.config.photoSkip;
  const checking = state.config.mode === 'check'; $('new-batch').hidden = checking;
  const choosing = state.config.mode === 'choose';
  $('batch-title').textContent = choosing ? '物品の処理を選ぶ' : checking ? '物品を確認する' : '連続して処理する';
  $('empty-item').querySelector('p').textContent = '貸出可能な物品は貸出へ切り替わります。貸出中の物品は、返却か随時チェックを選んでください。';
  document.querySelectorAll('[data-mode]').forEach((b) => { const chosen = b.dataset.mode === state.config.mode; b.classList.toggle('selected', chosen); b.setAttribute('aria-pressed', String(chosen)); });
  $('batch-summary').textContent = choosing ? '貸出中：返却か随時チェックを選んでください' : checking ? '随時チェック：今回の破損・写真・メモを記録' : borrow ? `${state.config.borrowerSource === 'planned' ? '予定貸出先' : '貸出先'}：${state.config.borrower.trim() || 'まだ選んでいません'}${state.config.borrowerSource === 'planned' ? '（確認画面で変更できます）' : ''}` : '返却：状態・写真・メモを順に確認して登録';
}
function compactBatch(value) { document.querySelector('.batch').classList.toggle('compact', value); $('edit-batch').hidden = !value; }
function renderDraft() {
  state.photoURLs.forEach((url) => URL.revokeObjectURL(url)); state.photoURLs = [];
  const checking = state.config.mode === 'check';
  const choosing = state.config.mode === 'choose'; const readOnly = checking || choosing;
  $('inspection-panel').hidden = !checking || !state.draft;
  $('operation-choice').hidden = !choosing || !state.draft;
  document.querySelectorAll('[data-choice]').forEach((b) => { b.disabled = lockedDraft(); });
  const d = state.draft; $('edit-current-item').hidden = !state.canEditItems || !d || d.item.card_kind === 'irregular'; $('correct-current-item').hidden = !state.canCorrect || !d; $('irregular-history').hidden = !d || d.item.card_kind !== 'irregular'; $('item-panel').hidden = !d; $('empty-item').hidden = !!d;
  if (!d) { $('note').value = ''; $('photos').replaceChildren(); setCameraDisplay(); renderWorkflow(); return; }
  $('item-origin').textContent = [d.item.item_scope || '区分未確認', d.item.item_owner].filter(Boolean).join(' ／ ');
  $('current-code').textContent = shortNumber(d.item.code) ? `${d.item.code}（No.${shortNumber(d.item.code)}）` : d.item.code; $('item-title').textContent = d.item.name || d.item.code;
  renderIrregular(d);
  const borrower = d.item.current_loan?.borrower; $('item-state').textContent = `${STATUS_LABELS[d.item.status] || d.item.status || '状態不明'}${borrower ? ` ／ ${borrower}` : ''}${d.cached ? ' ／ 端末に保存した情報' : ''}`;
  const planned = d.item.planned_borrower_name; $('planned-borrower').hidden = !planned; $('planned-borrower').textContent = planned ? `事前の割当：${planned}${d.item.planned_state === 'fulfilled' ? '（使用済み・今回は自動選択しません）' : '（貸出登録前の予定）'}` : '';
  // Damage recorded at the loan, shown at the return so the group is not blamed for it.
  const lent = d.item.current_loan; const lentDamage = !!lent && lent.condition === 'damage'; $('lend-note').hidden = readOnly || !lentDamage; $('lend-note').textContent = lentDamage ? `貸出時から損傷あり：${lent.note || '（メモなし）'}` : '';
  const invalid = readOnly ? false : state.config.mode === 'borrow' ? !available(d.item) : !loaned(d.item);
  $('item-warning').hidden = !invalid; $('item-warning').textContent = state.config.mode === 'borrow' ? 'この物品は貸出可能になっていません。確認が必要です。' : 'この物品は貸出中になっていません。確認が必要です。';
  const returning = state.config.mode === 'return'; const abnormal = returning && d.condition !== 'normal'; const lendDamage = !returning && d.condition === 'damage';
  $('return-options').hidden = readOnly || !returning; $('photo-block').hidden = readOnly || (returning && !abnormal); $('note').hidden = readOnly || (returning && !abnormal); document.querySelector('.note-label').hidden = readOnly || (returning && !abnormal);
  $('lend-condition').hidden = readOnly || returning; document.querySelectorAll('[data-lend]').forEach((b) => { const chosen = b.dataset.lend === (lendDamage ? 'damage' : 'normal'); b.classList.toggle('selected', chosen); b.setAttribute('aria-pressed', String(chosen)); b.disabled = readOnly || invalid || lockedDraft(); });
  $('note-title').textContent = lendDamage ? '傷・汚れ・不足の場所と内容' : 'メモ'; $('note-hint').textContent = lendDamage ? '必須' : '任意';
  $('photo-tip').textContent = returning ? '傷・不足の場所を写してください。最大5枚。' : state.config.photoSkip ? '写真は省略できます。傷があれば写してください（最大5枚）。' : '貸出は2枚以上、最大5枚。全体・付属品・傷を写してください。';
  $('return-normal').disabled = readOnly || invalid || lockedDraft(); $('queue-item').hidden = readOnly || (returning && !abnormal); $('queue-item').disabled = readOnly || invalid || lockedDraft(); $('commit-hint').hidden = readOnly;
  $('queue-item').textContent = returning ? `${CONDITION_LABELS[d.condition]}で返却・次へ` : `${lendDamage ? '損傷あり' : '損傷なし'}で貸出・次へ`;
  document.querySelectorAll('[data-condition]').forEach((b) => { b.classList.toggle('selected', b.dataset.condition === d.condition); b.disabled = invalid || lockedDraft(); });
  $('photo-count').textContent = `${d.photos.length}枚`; $('note').value = d.note || '';
  $('photos').replaceChildren(...d.photos.map((photo, index) => { const wrap = document.createElement('div'); wrap.className = 'photo'; const img = document.createElement('img'); const url = URL.createObjectURL(photo.blob); state.photoURLs.push(url); img.src = url; img.alt = `現状写真 ${index + 1}`; const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `写真${index + 1}を削除`); remove.disabled = lockedDraft(); remove.onclick = () => removePhoto(index); const size = document.createElement('small'); size.textContent = `${Math.round(photo.blob.size / 1024)} KB`; wrap.append(img, remove, size); return wrap; }));
  if (checking) renderInspection(d);
  setCameraDisplay();
  renderWorkflow();
}
function renderInspection(d) {
  const data = d.inspection;
  $('check-refresh').disabled = lockedDraft(); $('check-next').disabled = lockedDraft();
  $('check-updated').textContent = `${d.cached ? '通信なし・保存済み情報（現在の状態は未確認）' : 'サーバーの状態'} ／ ${formatTime(data?.generated_at, JST_FULL) || '取得日時不明'}`;
  const pending = state.queue.filter((op) => !op.acknowledged && op.status !== 'archived_conflict');
  $('check-pending').hidden = !pending.length; $('check-pending').textContent = 'この端末に未受付の貸出・返却があります。下の数量には含まれていません。「今回の処理」も確認してください。';
  const lent = data?.loan;
  $('check-loan-title').textContent = lent && !lent.active ? '前回の貸出時の状態（現在は貸出中ではありません）' : '貸出時の状態';
  $('check-loan-state').textContent = lent ? `${lent.borrower || '団体未記録'} ／ ${formatTime(lent.server_at) || '日時未記録'} ／ ${lent.condition === 'damage' ? '貸出時から損傷あり' : lent.condition === 'normal' ? '損傷なし' : '状態未記録'}` : '貸出時の記録はありません。';
  $('check-loan-note').textContent = (lent?.irregular ? `${lent.irregular.name} ／ ${lent.irregular.quantity}${lent.irregular.unit} ／ ${lent.irregular.item_scope} ／ ${lent.irregular.item_owner || ''}\n` : '') + (lent?.note || (lent ? '貸出時メモなし' : ''));
  $('check-photo-hint').textContent = lent?.photos?.length ? '写真を押すと大きく表示します。' : lent?.photo_skip ? '貸出時は写真を省略しています。' : '貸出時の写真は記録されていません。';
  // Keep loaded pictures while other controls rerender; authenticated photo URLs are never cached by the service worker.
  const photoKey = `${lent?.operation_id || ''}:${!!d.cached}`;
  if ($('check-photos').dataset.key !== photoKey) {
    $('check-photos').dataset.key = photoKey;
    $('check-photos').replaceChildren(...(lent?.photos || []).map((photo) => {
      const link = document.createElement('a'); link.href = photo.url; link.target = '_blank'; link.rel = 'noopener';
      const img = document.createElement('img'); img.src = photo.url; img.alt = `貸出時の写真 ${photo.index}`; img.loading = 'lazy';
      const hint = document.createElement('span'); hint.hidden = true; hint.textContent = `写真${photo.index}を読み込めません。通信・ログインを確認して「最新情報に更新」を押してください。`;
      img.onerror = () => { img.hidden = true; hint.hidden = false; }; link.append(img, hint); return link;
    }));
  }
  const group = data?.group;
  const source = { current: '借用団体', planned: '予定貸出先（この物品は未貸出）', last_loan: '前回の借用団体' };
  $('check-group-title').textContent = group ? `${source[group.source] || '団体'}：${group.name}` : '借用団体の記録はありません';
  $('check-group-total').textContent = group ? group.items?.some(item => item.quantity != null) ? `現在貸出中：カード${group.loaned_total}枚（物品の数量は下の内訳）` : `現在貸出中：${group.loaned_total}点（貸出予定・返却済みは含みません）` : '';
  $('check-inventory').replaceChildren(...(group?.inventory || []).map((entry) => {
    const row = document.createElement('details'); row.className = 'check-inventory-row';
    const summary = document.createElement('summary'); const title = document.createElement('span'); title.textContent = [entry.name, entry.item_scope, entry.item_owner].filter(Boolean).join(' ／ ');
    const count = document.createElement('strong'); count.textContent = `${entry.quantity}${entry.unit || '点'}`; summary.append(title, count);
    const codes = document.createElement('div'); codes.className = 'check-codes';
    for (const code of entry.codes) { const button = document.createElement('button'); button.type = 'button'; button.textContent = shortNumber(code) ? `No.${shortNumber(code)}` : code; button.onclick = () => openItem(code); codes.append(button); }
    row.append(summary, codes); return row;
  }));
}
// The number written by hand and printed large on labels: IY-100123 -> 123.
function shortNumber(code) { const m = /^IY-1(\d{5})$/.exec(code); return m && Number(m[1]) ? String(Number(m[1])) : null; }
const itemLabel = (item) => shortNumber(item.code) ? `No.${shortNumber(item.code)}` : item.code;
function codeFromInput(raw) {
  const text = String(raw || '').trim(); let code = text;
  if (/^IR-\d{6}$/i.test(text)) return `IY-${text.toUpperCase()}`;
  const short = /^(?:no\.?\s*)?(\d{1,5})$/i.exec(text); if (short && Number(short[1]) > 0) return `IY-${100000 + Number(short[1])}`; if (/^1\d{5}$/.test(text)) return `IY-${text}`;
  if (/^https?:\/\//i.test(text)) { try { const url = new URL(text); code = url.searchParams.get('item') || url.searchParams.get('iy') || (/^\/i\/([^/]+)\/?$/.exec(url.pathname)?.[1]) || ''; code = decodeURIComponent(code); } catch { return null; } }
  code = code.toUpperCase(); return /^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(code) ? code : null;
}
async function openItem(raw, refresh = false, selectedMode = null) {
  const code = codeFromInput(raw); if (!code) { message('個体コードまたは物品ページのURLを入力してください。', true); return; }
  if (!state.staff || lockedDraft()) return;
  const checking = state.config.mode === 'check';
  const sameItem = state.draft?.item.code === code;
  // Re-reading the displayed card is a new read, even if this tab has stayed open.
  // Only actual input (condition, photos, memo, a later step) blocks replacement. An untouched screen is
  // replaced by the newly read item in every mode: a card read but never registered must not hold the screen.
  if (state.draft && draftHasContent()) {
    const held = itemLabel(state.draft.item);
    // Explain beside the step that has to be finished or closed; the top of the screen scrolls away below.
    const anchor = state.view === 'work' && registrationMode() && !$('workflow').hidden ? $('workflow-navigation') : undefined;
    message(sameItem ? `${held} は入力中です。続きを登録するか「この物品を閉じる」を押してから、カードを読み直してください。` : `${held} の入力（状態・写真・メモ）が残っています。登録するか「この物品を閉じる」を押してから、次の物品を読んでください。`, true, anchor);
    if (state.view === 'work' && registrationMode()) { $('workflow').scrollIntoView({ block: 'start' }); $('workflow-title').focus({ preventScroll: true }); }
    return;
  }
  state.opening = true; $('item-form').querySelector('button').disabled = true;
  renderDraft();
  try {
    let item, cached = false;
    try { const result = await request(`/api/items/${encodeURIComponent(code)}`); item = result.item || result; try { await dbPut('items', item); } catch { /* keep the current server state even if the offline cache is full */ } }
    catch (e) { if (e.status) throw e; item = await dbGet('items', code); if (!item) throw new Error('この物品は端末に保存されていません。通信が戻ってから読み取ってください。'); cached = true; }
    let summary, summaryCached = false;
    try { summary = await request(`/api/items/${encodeURIComponent(code)}/inspection`); item = summary.item; cached = false; try { await dbPut('settings', summary, staffKey(`inspection:${code}`)); } catch { /* show current data even if offline storage is full */ } }
    catch (e) { if (e.status) throw e; summary = await dbGet('settings', staffKey(`inspection:${code}`)); summaryCached = true; }
    item = legacyPhotoPolicy(item);
    // Only a deliberate choice or refresh of this same inspection keeps check mode.
    // A new read always follows the item's state; no previous return choice is reused.
    const mode = selectedMode || (refresh && sameItem && checking ? 'check' : available(item) ? 'borrow' : loaned(item) ? 'choose' : 'check');
    // Another tab may have received or archived a pending operation while this tab stayed open.
    // Reconcile only those receipts; do not replace a current upload or an operator's draft.
    for (const op of state.queue.filter((entry) => entry.meta.item_code === code && !entry.acknowledged && ['pending', 'uploading', 'error', 'conflict'].includes(entry.status))) {
      const saved = await dbGet('operations', op.id);
      if (saved?.owner === state.staff?.id && (saved.acknowledged && statusAccepted(saved.status) || saved.status === 'archived_conflict')) Object.assign(op, saved);
    }
    renderQueue();
    if (state.queue.some((op) => op.meta.item_code === code && !op.acknowledged && ['pending', 'uploading', 'error', 'conflict'].includes(op.status))) { message(`${code} はこの端末で未送信または確認待ちです。「今回の処理」を確認してください。`, true); return; }
    let draft;
    if (mode === 'check') {
      let inspection; cached = false;
      try { inspection = summary && !summaryCached ? summary : await request(`/api/items/${encodeURIComponent(code)}/inspection`); try { await dbPut('settings', inspection, staffKey(`inspection:${code}`)); } catch { /* current server data can still be inspected */ } }
      catch (e) { if (e.status) throw e; inspection = await dbGet('settings', staffKey(`inspection:${code}`)); if (!inspection) throw new Error('通信がありません。この物品のチェック情報は端末に保存されていません。'); cached = true; }
      if (!state.staff) return;
      draft = { item: inspection.item, inspection, photos: [], note: '', condition: 'normal', read_at: inspection.generated_at, cached };
    } else {
      draft = { item, photos: [], note: '', condition: 'normal', read_at: new Date().toISOString(), cached };
    }
    if (summary && mode !== 'check' && summary.item.version === draft.item.version) draft.inspection = summary;
    draft.summaryCached = summaryCached;
    draft.stage = mode === 'borrow' && item.card_kind === 'irregular' ? 'details' : 'condition'; draft.damageSelected = false;
    draft.item = legacyPhotoPolicy(draft.item);
    const config = { ...state.config, mode, ...plannedBorrowerChoice(draft.item, state.config, mode) };
    if (!state.staff) return;
    await saveSelection(config, draft); state.config = config; state.draft = draft;
    if (config.borrowerSource === 'planned' && config.borrower && !state.borrowers.includes(config.borrower)) { state.borrowers.push(config.borrower); renderBorrowers(); }
    $('borrower').value = config.borrower || ''; $('item-code').value = ''; $('check-photos').dataset.key = ''; renderBatch();
    message(cached ? (mode === 'check' ? '保存済み情報を表示しています。団体の現在の貸出数・写真は通信回復後に確認してください。' : '通信なし：以前の状態から処理を選んでいます。登録は未送信として保管し、送信時に状態を照合します。') : '');
    // With the photo skip, the camera stays on the next QR and the screen shows the one-tap loan button.
    state.completion = null; stopCamera();
    if (navigator.vibrate) navigator.vibrate(30);
    return true;
  } catch (e) { message(e.message, true); }
  finally { state.opening = false; $('item-form').querySelector('button').disabled = false; renderDraft(); if (state.draft && state.view === 'work') { compactBatch(true); if (state.config.mode === 'choose') { $('operation-choice').scrollIntoView({ block: 'start' }); $('operation-choice').focus({ preventScroll: true }); } else focusWorkflow(); } }
}
async function refreshUntouchedItem() {
  // Returning to an old tab (including bfcache) must not leave an empty, stale loan screen.
  // Never replace an operator's in-progress condition, photos, memo, or workflow step.
  if (!state.staff || document.hidden || !state.draft || lockedDraft() || draftHasContent()) return;
  await openItem(state.draft.item.code, true);
}
async function removePhoto(index) { if (lockedDraft() || !state.draft) return; const old = state.draft.photos[index]; state.draft.photos.splice(index, 1); try { await saveDraft(); } catch (e) { state.draft.photos.splice(index, 0, old); message('端末への保存に失敗しました。写真を削除できませんでした。', true); } renderDraft(); }
async function canvasJPEG(canvas) { return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('写真を圧縮できませんでした')), 'image/jpeg', .78)); }
async function compressImage(blob) {
  let img, release = () => {}; try { img = await createImageBitmap(blob, { imageOrientation: 'from-image' }); release = () => img.close(); } catch { const url = URL.createObjectURL(blob); img = new Image(); img.src = url; await img.decode(); release = () => URL.revokeObjectURL(url); }
  try { const width = img.width || img.naturalWidth, height = img.height || img.naturalHeight; const scale = Math.min(1, 1600 / Math.max(width, height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); canvas.getContext('2d', { alpha: false }).drawImage(img, 0, 0, canvas.width, canvas.height); return { blob: await canvasJPEG(canvas), width: canvas.width, height: canvas.height }; } finally { release(); }
}
async function addPhotos(files) {
  if (!registrationMode() || !state.draft || lockedDraft()) return; state.photoBusy = true; renderDraft();
  try { for (const file of files) { if (state.draft.photos.length >= 5) { message('1個体は5枚までです。', true); break; } const photo = await compressImage(file); photo.id = uuid(); photo.name = `${photo.id}.jpg`; photo.captured_at = new Date().toISOString(); state.draft.photos.push(photo); try { await saveDraft(); } catch (e) { state.localDraftUnsaved = true; throw new Error(localSaveMessage(e)); } } } catch (e) { message(e.message || '写真を読み込めませんでした。JPEGなどで追加してください。', true, $('photo-block')); } finally { state.photoBusy = false; renderDraft(); void storageInfo(); }
}
async function takePhoto(andNext = false) {
  if (!registrationMode() || !state.draft || lockedDraft() || !state.stream) return;
  if (andNext && state.draft.photos.length >= 5) { await commitItem(); return; }
  const video = $('camera'); if (!video.videoWidth) { message('カメラの準備を待って、もう一度撮ってください。', true); return; }
  const canvas = document.createElement('canvas'); const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight)); canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale); canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
  const before = state.draft.photos.length; try { await addPhotos([await canvasJPEG(canvas)]); if (andNext && state.draft && state.draft.photos.length > before) await commitItem(); } catch (e) { message(e.message, true); }
}
async function commitItem(condition) {
  if (!registrationMode() || !state.draft || lockedDraft()) return; const d = state.draft;
  if (state.queue.some((op) => op.meta.item_code === d.item.code && ['pending', 'uploading', 'error', 'conflict'].includes(op.status))) { message('この物品は未送信または確認待ちです。「今回の処理」から再送・確認してください。', true); return; }
  const borrow = state.config.mode === 'borrow'; if (borrow && !state.config.borrower.trim()) { message('今回の貸出先を選んでください。', true); $('borrower').focus(); return; }
  if (borrow && !state.borrowers.includes(state.config.borrower.trim())) { message('登録済みの貸出先から選んでください。候補が出ないときは通信を確認してください。', true); $('borrower').focus(); return; }
  if (borrow && d.item.card_kind === 'irregular') {
    const error = irregularError(d); if (error) { message(error, true); return; }
    d.item.photo_required = d.irregular.item_scope === '学外';
  }
  const photoSkip = borrow && d.item.photo_required === false && d.photos.length === 0;
  if (d.item.photo_required == null) { message('写真要件が未設定です。管理者に物品区分の登録を依頼してください。', true); return; }
  if (d.item.photo_required && d.photos.length < 1) { message('学外物品は写真を1枚以上追加してください。', true); return; }
  const chosen = condition || d.condition; const note = $('note').value.trim();
  if (!d.damageSelected) { message('破損の有無を選んでください。', true); return; }
  if (chosen === 'damage' && !note) { message('破損の場所と内容をメモに書いてください。', true); $('note').focus(); return; }
  if ((borrow && !available(d.item)) || (state.config.mode === 'return' && !loaned(d.item))) { message('物品の状態を確認してください。この状態では登録できません。', true); return; }
  state.commitBusy = true; renderDraft();
  const op = { id: uuid(), owner: state.staff.id, itemName: displayItem(d), createdAt: new Date().toISOString(), status: 'pending', expectedPhotos: d.photos.length, photos: clone(d.photos), acknowledged: false, meta: { operation_id: '', item_code: d.item.code, item_version: d.item.version, action: state.config.mode, borrower: borrow ? state.config.borrower.trim() : '', condition: chosen, note, client_at: new Date().toISOString(), client_read_at: d.read_at, ...(photoSkip ? { photo_skip: true } : {}), ...(borrow && d.item.card_kind === 'irregular' ? { irregular: { ...d.irregular, quantity: Number(d.irregular.quantity) } } : {}) } }; op.meta.operation_id = op.id;
  try {
    // Queue and draft clear commit atomically: refresh cannot duplicate the active draft.
    await dbWriteBatch([{store:'operations', value:op}, {store:'settings', key:staffKey('draft'), value:null}]);
    state.queue.push(op); state.draft = null; state.completion = op.id; if (state.stream) state.cameraMode = 'scan'; message(''); renderQueue(); renderWorkflow(); $('completion-title').focus(); void processQueue();
  } catch (error) { state.localDraftUnsaved = true; message(localSaveMessage(error), true); }
  finally { state.commitBusy = false; renderDraft(); }
}
function statusAccepted(status) { return ['complete', 'drive_pending', 'local_saved', 'drive_error'].includes(status); }
function receiptNeedsPoll(op) { return op.acknowledged && (['drive_pending', 'drive_error'].includes(op.status) || (op.status === 'local_saved' && ['pending', 'error'].includes(op.mirrorStatus))); }
function receiptLabel(op) { if (op.status === 'local_saved' && op.mirrorStatus) return { pending: '実験フォルダー保存待ち', saved: '実験フォルダー保存済み（クラウド同期未確認）', error: '実験フォルダー保存エラー' }[op.mirrorStatus] || LABELS[op.status]; return LABELS[op.status] || op.status; }
function renderQueue() {
  renderCompletion();
  const unsent = state.queue.filter((o) => !o.acknowledged && o.status !== 'archived_conflict').length; const driveWait = state.queue.filter((o) => o.acknowledged && ['drive_pending', 'drive_error'].includes(o.status)).length; const complete = state.queue.filter((o) => o.status === 'complete').length; const local = state.queue.filter((o) => o.status === 'local_saved' && !o.mirrorStatus).length; const mirrorWait = state.queue.filter((o) => o.status === 'local_saved' && ['pending', 'error'].includes(o.mirrorStatus)).length; const mirrorSaved = state.queue.filter((o) => o.status === 'local_saved' && o.mirrorStatus === 'saved').length;
  $('queue-summary').replaceChildren(...[['端末・未送信', unsent], ['Drive待ち', driveWait], ['Drive済', complete], ...(local ? [['サーバー保存', local]] : []), ...(mirrorWait || mirrorSaved || state.serverMode === 'mounted_drive' ? [['実験待ち', mirrorWait], ['実験保存', mirrorSaved]] : [])].map(([label, count]) => { const span = document.createElement('span'); span.append(document.createTextNode(label)); const strong = document.createElement('strong'); strong.textContent = count; span.append(strong); return span; }));
  // Keep DOM and memory light even after thousands of operations. All receipts remain in IndexedDB.
  $('queue-list').replaceChildren(...[...state.queue].sort((a, b) => { const pendingA = receiptNeedsPoll(a) || !['complete', 'local_saved', 'archived_conflict'].includes(a.status); const pendingB = receiptNeedsPoll(b) || !['complete', 'local_saved', 'archived_conflict'].includes(b.status); return Number(pendingB) - Number(pendingA) || b.createdAt.localeCompare(a.createdAt); }).slice(0, 40).map((op) => {
    const li = document.createElement('li'), left = document.createElement('div'), title = document.createElement('div'), details = document.createElement('div'), status = document.createElement('span'); title.className = 'item-name'; title.textContent = op.itemName || op.meta.item_code; details.className = 'details'; details.textContent = `${op.meta.item_code} ／ ${op.meta.action === 'borrow' ? `${op.meta.borrower}${op.meta.condition === 'damage' ? '・損傷あり' : ''}` : CONDITION_LABELS[op.meta.condition]} ／ ${op.meta.photo_skip && !op.expectedPhotos ? '写真省略' : `${op.expectedPhotos}枚`}${op.error || op.mirrorError ? ` ／ ${op.error || op.mirrorError}` : ''}`; status.className = `status ${op.status}${op.mirrorStatus ? ' mirror' : ''}`; status.textContent = receiptLabel(op); left.append(title, details);
    details.textContent = `${ACTION_TEXT[op.meta.action] || op.meta.action}：${details.textContent}`;
    if (op.status === 'conflict') { const button = document.createElement('button'); button.textContent = '最新状態を確認'; button.onclick = () => inspectConflict(op); const archive = document.createElement('button'); archive.textContent = '未受付記録を保管して読み直す'; archive.onclick = () => archiveConflict(op); left.append(button, archive); }
    li.append(left, status); return li;
  }));
}
async function applyReceipt(op, result) {
  if (!statusAccepted(result.status) || result.operation_id !== op.id || Number(result.photos_count) !== op.expectedPhotos) throw new Error('保存の受付内容が一致しません。写真を端末に残して再確認します。');
  const next = { ...op, status: result.status, serverAt: result.server_at, error: result.error || '', mirrorStatus: result.mirror_status || op.mirrorStatus || null, mirrorError: result.mirror_error || '', cloudSyncVerified: result.cloud_sync_verified === true, acknowledged: true, photos: [] }; // Server durably accepted metadata AND all photo files before this ACK.
  await dbPut('operations', next); Object.assign(op, next);
  if (result.item) { try { await dbPut('items', result.item); } catch {} }
  renderQueue(); void storageInfo();
}
async function processQueue() {
  if (state.uploadBusy || !state.staff || !navigator.onLine || document.hidden) return;
  let ownedRun = false;
  const run = async () => { ownedRun = true; state.uploadBusy = true;
    try { while (state.staff && navigator.onLine && !document.hidden) {
      // Look up the next operation after every completed send, including commits made during that send.
      const op = state.queue.find((o) => o.owner === state.staff.id && o.status === 'pending' && !o.acknowledged); if (!op) break;
      op.status = 'uploading'; await dbPut('operations', op); renderQueue();
      try {
        // If previous POST reached the server but its response was lost, GET recovers the receipt first.
        let receipt; try { receipt = await request(`/api/operations/${encodeURIComponent(op.id)}`); } catch (e) { if (e.status !== 404) throw e; }
        if (receipt) { await applyReceipt(op, receipt); continue; }
        const form = new FormData(); form.append('metadata', JSON.stringify(op.meta)); for (const photo of op.photos) form.append('photos', photo.blob, photo.name);
        const result = await request('/api/operations', { method: 'POST', body: form }); await applyReceipt(op, result); state.pollDelay = 5000;
      } catch (e) { op.status = e.status === 409 ? 'conflict' : 'error'; op.error = e.message; await dbPut('operations', op); renderQueue(); if (e.status === 401 || !navigator.onLine) break; }
    } } finally { state.uploadBusy = false; schedulePoll(); }
  };
  // Prevent same-origin tabs from sending a queue simultaneously when Web Locks is available.
  if (navigator.locks) await navigator.locks.request('iyakusai-rental-upload', { ifAvailable: true }, async (lock) => { if (lock) await run(); }); else await run();
  // A new commit may arrive between the final empty check and lock release.
  if (ownedRun && state.staff && navigator.onLine && !document.hidden && state.queue.some((op) => op.status === 'pending' && !op.acknowledged)) setTimeout(() => void processQueue(), 0);
}
function schedulePoll() { clearTimeout(state.pollTimer); if (state.staff && navigator.onLine && !document.hidden && state.queue.some(receiptNeedsPoll)) state.pollTimer = setTimeout(pollReceipts, state.pollDelay); }
async function pollReceipts() {
  if (!state.staff || !navigator.onLine || document.hidden) return;
  const allPending = state.queue.filter(receiptNeedsPoll);
  const start = allPending.length ? pollCursor % allPending.length : 0; const pending = [...allPending.slice(start), ...allPending.slice(0, start)].slice(0, 15); pollCursor = allPending.length ? (start + pending.length) % allPending.length : 0; let changed = false;
  for (const op of pending) { try { const result = await request(`/api/operations/${encodeURIComponent(op.id)}`); changed ||= op.status !== result.status || op.mirrorStatus !== (result.mirror_status || null); await applyReceipt(op, result); } catch (e) { if (e.status === 401) break; } }
  state.pollDelay = changed ? 5000 : Math.min(60000, state.pollDelay * 2); schedulePoll();
}
async function inspectConflict(op) { try { const result = await request(`/api/items/${encodeURIComponent(op.meta.item_code)}`); const item = result.item || result; await dbPut('items', item); message(`${op.meta.item_code} の現在の状態：${STATUS_LABELS[item.status] || item.status}。この登録は成立していません。写真は端末に保管しています。担当者に確認してください。`, true); } catch (e) { message(e.message, true); } }
async function archiveConflict(op) {
  if (op.status !== 'conflict' || op.acknowledged || lockedDraft()) return;
  try { const preserved = { ...op, status: 'archived_conflict', archivedAt: new Date().toISOString() }; await dbPut('operations', preserved); Object.assign(op, preserved); renderQueue();
    if (state.draft) { message(`${op.meta.item_code} の未受付記録と写真を保管しました。入力中の物品を終えてから、読み直してください。`); return; }
    await openItem(op.meta.item_code); if (state.draft) message('前の未受付記録と写真は保管しています。現在の状態を確認し、新しい写真で改めて登録してください。');
  } catch (e) { message(e.message || '未受付記録を保管できませんでした。', true); }
}
async function storageInfo() { if (!navigator.storage?.estimate) return; try { const info = await navigator.storage.estimate(); $('storage-info').textContent = `端末の使用量 約${Math.round((info.usage || 0) / 1024 / 1024)} MB` + (Number.isFinite(info.quota) ? ` ／ 保存領域の残り 約${Math.max(0, Math.floor((info.quota - (info.usage || 0)) / 1024 / 1024))} MB（目安）` : ''); } catch {} }

// ---- information tab: items per group, so the cards a group hands back can be counted against "貸出中".
const PHASE_LABELS = { loaned: '貸出中', review: '要確認', planned: '予定', returned: '返却済', unassigned: '未割当' };
const PHASE_ORDER = ['loaned', 'review', 'planned', 'returned', 'unassigned'];
const JST_SHORT = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const JST_FULL = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' });
function formatTime(iso, format = JST_SHORT) { const t = iso ? new Date(iso) : null; return t && !Number.isNaN(t.getTime()) ? format.format(t) : ''; }
function showView(view) {
  state.view = view; const info = view === 'info'; $('work-view').hidden = info; $('info-view').hidden = !info;
  for (const [id, chosen] of [['view-work', !info], ['view-info', info]]) { $(id).classList.toggle('selected', chosen); $(id).setAttribute('aria-selected', String(chosen)); }
  if (info) { stopCamera(); stopNFC(); state.infoOpenedAt = Date.now(); state.infoInteractedAt = 0; state.infoTouching = false; state.infoHasInteracted = false; state.infoInteractionSeq++; renderOverview(); void loadOverview(); }
  else infoFreshNotice(false);
}
async function loadOverview(force = false) {
  if (!state.staff) return; if (state.overviewBusy) { if (force) state.overviewForce = state.infoInteractionSeq; return; } const requestedAt = state.infoInteractionSeq; state.overviewBusy = true; $('info-refresh').disabled = true; $('info-refresh').textContent = '読込み中';
  try { const result = await request('/api/overview'); state.overview = { ...result, cached: false }; try { await dbPut('settings', result, staffKey('overview')); } catch { /* still shown on screen */ } }
  catch (e) {
    if (e.status) message(e.message, true);
    else { let cached = null; try { cached = await dbGet('settings', staffKey('overview')); } catch {} if (cached) state.overview = { ...cached, cached: true }; else message('通信がないため物品の情報を読み込めません。通信が戻ってから「更新」を押してください。', true); }
  } finally { state.overviewBusy = false; $('info-refresh').disabled = false; $('info-refresh').textContent = '更新'; const show = (force && requestedAt === state.infoInteractionSeq) || state.overviewForce === state.infoInteractionSeq; state.overviewForce = null; presentOverview(show); }
}
function overviewGroups(items) {
  const groups = new Map();
  for (const item of items) { const id = item.group?.id || ''; let g = groups.get(id); if (!g) { g = { id, name: item.group?.name || '団体の割当なし', items: [], counts: {} }; groups.set(id, g); } g.items.push(item); g.counts[item.phase] = (g.counts[item.phase] || 0) + 1; }
  return [...groups.values()].sort((a, b) => Number(!a.id) - Number(!b.id) || a.name.localeCompare(b.name, 'ja'));
}
function sortedItems(items) { return [...items].sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) || a.code.localeCompare(b.code)); }
function countChips(counts) { return PHASE_ORDER.filter((p) => counts[p]).map((p) => { const span = document.createElement('span'); span.className = `chip ${p}`; span.append(`${PHASE_LABELS[p]} `); const strong = document.createElement('strong'); strong.textContent = counts[p]; span.append(strong); return span; }); }
function itemDetail(item) {
  const parts = [item.code];
  if (item.lent_at) parts.push(`貸出 ${formatTime(item.lent_at)}${item.lent_condition === 'damage' ? `・貸出時から損傷あり：${item.lent_note}` : ''}${item.lent_photo_skip ? '・写真省略' : ''}`);
  if (item.returned_at) parts.push(`返却 ${formatTime(item.returned_at)}・${CONDITION_LABELS[item.return_condition] || item.return_condition}${item.return_note ? `：${item.return_note}` : ''}`);
  return parts.join(' ／ ');
}
// Copy to Google Drive (an Apps Script on a committee account fetches the photos and records every few minutes).
function driveSyncText(o) {
  const d = o?.drive_sync; if (!d?.enabled) return '';
  const quiet = !d.last_seen_at || Date.parse(o.generated_at) - Date.parse(d.last_seen_at) > 15 * 60 * 1000;
  return `Googleドライブへの複製：保存待ち ${d.waiting}件${d.errors ? `（うちエラー ${d.errors}件・自動で再試行）` : ''}${d.last_saved_at ? `・最後の保存 ${formatTime(d.last_saved_at)}` : ''}${quiet ? '・複製の処理から15分以上連絡がありません（管理者に連絡）' : ''}`;
}
function overviewStatusText() { const o = state.overview; const items = o?.items || []; return o ? `${o.cached ? '通信なし：端末に保存した情報' : '最新の情報'}（${formatTime(o.generated_at)} 時点・${items.length}点）` : '読み込み中です。'; }
function overviewSignature(o) { return JSON.stringify(o?.items || []); }
// A list that changes under a finger opens the wrong item (information tab, 2026-10-18). Once the operator has
// touched or scrolled the tab, data that arrives later waits behind a notice and the 「更新」 button: the rows on
// screen change only on the operator's own action (更新, the notice, the filter, or opening the tab again).
function presentOverview(force = false) {
  const shown = $('info-groups').querySelector('.info-group, .info-empty');
  const interacted = state.infoHasInteracted;
  if (force || state.view !== 'info' || !shown || !interacted) { renderOverview(); return; }
  if (overviewSignature(state.overview) === state.overviewShownSignature) { $('info-updated').textContent = overviewStatusText(); return; }
  state.overviewPending = true; infoFreshNotice(true);
}
function infoFreshNotice(show) {
  if (show && infoGestureActive()) return;
  let notice = $('info-fresh');
  if (!notice) {
    notice = document.createElement('div'); notice.id = 'info-fresh'; notice.hidden = true; notice.setAttribute('role', 'status');
    Object.assign(notice.style, { position: 'fixed', left: '12px', right: '12px', bottom: 'calc(12px + env(safe-area-inset-bottom))', zIndex: '20', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', background: '#163960', color: '#fff', padding: '10px 12px', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.25)', fontSize: '.9rem' });
    const text = document.createElement('span'); text.textContent = '新しい情報があります。表示中の一覧はそのままです。';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '最新を表示'; button.style.flexShrink = '0';
    button.onclick = () => { state.feedbackAnchor = null; message(''); renderOverview(); };
    notice.append(text, button); document.body.append(notice);
  }
  notice.hidden = !show;
}
function infoGestureActive() { return state.infoTouching || state.infoPointers.size > 0; }
function settleInfoGesture() {
  clearTimeout(state.infoRenderTimer);
  state.infoRenderTimer = setTimeout(() => {
    if (infoGestureActive()) return;
    if (state.infoRenderRequested) renderOverview();
    else if (state.overviewPending && state.view === 'info') infoFreshNotice(true);
  }, 250);
}
function renderOverview() {
  if (infoGestureActive()) { state.infoRenderRequested = true; return; }
  state.infoRenderRequested = false;
  const o = state.overview; const items = o?.items || [];
  state.overviewPending = false; infoFreshNotice(false); state.overviewShownSignature = overviewSignature(o);
  $('info-updated').textContent = overviewStatusText();
  $('info-drive').hidden = !o?.drive_sync?.enabled; $('info-drive').textContent = driveSyncText(o);
  const total = {}; for (const item of items) total[item.phase] = (total[item.phase] || 0) + 1; $('info-total').replaceChildren(...countChips(total));
  const query = $('info-filter').value.trim(); const lower = query.toLowerCase(); const code = query ? codeFromInput(query) : null; const openOnly = $('info-open-only').checked;
  const groups = overviewGroups(items).filter((g) => !openOnly || g.counts.loaned || g.counts.review);
  const nodes = [];
  for (const g of groups) {
    const groupHit = !query || g.name.toLowerCase().includes(lower);
    const shown = groupHit ? g.items : g.items.filter((i) => i.code === code || i.name.toLowerCase().includes(lower) || i.code.toLowerCase().includes(lower));
    if (!shown.length) continue;
    const details = document.createElement('details'); details.className = 'info-group';
    const summary = document.createElement('summary'); const name = document.createElement('strong'); name.textContent = g.name; const chips = document.createElement('span'); chips.className = 'chips'; chips.append(...countChips(g.counts)); summary.append(name, chips);
    const list = document.createElement('ol'); list.className = 'info-items';
    for (const item of sortedItems(shown)) {
      const li = document.createElement('li'); const open = document.createElement('button'); open.type = 'button'; open.className = 'info-no'; const number = shortNumber(item.code); open.textContent = number ? `No.${number}` : item.code; open.setAttribute('aria-label', `${item.code} ${item.name} を貸出・返却の画面で開く`); open.onclick = async () => {
        // Explain here, beside the row that was tapped, instead of switching to a screen that still shows the previous item.
        state.feedbackAnchor = body;
        if (lockedDraft()) { message(state.opening ? '前の物品の情報を取得中です。表示されてから選び直してください。' : '前の物品を保存しています。終わってから選び直してください。', true); $('message').scrollIntoView({ block: 'nearest' }); return; }
        if (state.draft && draftHasContent()) { message(`${itemLabel(state.draft.item)} の入力（状態・写真・メモ）が残っています。貸出・返却の画面で登録するか「この物品を閉じる」を押してから選んでください。`, true); $('message').scrollIntoView({ block: 'nearest' }); return; }
        message(`${itemLabel(item)} を読み込み中です…`);
        if (await openItem(item.code)) {
          state.feedbackAnchor = null; showView('work');
          if (state.config.mode === 'choose') { $('operation-choice').scrollIntoView({ block: 'start' }); $('operation-choice').focus({ preventScroll: true }); }
          else focusWorkflow();
        }
      };
      const body = document.createElement('div'); const title = document.createElement('div'); title.className = 'item-name'; title.textContent = item.name; const scope = document.createElement('div'); scope.className = 'small'; scope.textContent = [item.item_scope || '区分未確認', item.item_owner].filter(Boolean).join(' ／ '); const detail = document.createElement('div'); detail.className = 'details'; detail.textContent = itemDetail(item); body.append(title, scope, detail);
      const badge = document.createElement('span'); badge.className = `chip ${item.phase}`; badge.textContent = PHASE_LABELS[item.phase] || item.phase;
      li.append(open, body, badge);
      if (state.canEditItems && item.card_kind !== 'irregular' && !item.code.startsWith('IY-IR-')) {
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'quiet item-edit-button'; edit.textContent = '編集';
        edit.setAttribute('aria-label', item.code + ' ' + item.name + ' の物品情報を編集'); edit.onclick = () => void openItemEditor(item.code); li.append(edit);
      }
      list.append(li);
    }
    details.append(summary, list);
    // Remember groups opened by hand across refreshes; groups opened by a search close again when it is cleared.
    details.open = state.openGroups.has(g.id) || !groupHit || groups.length === 1;
    details.addEventListener('click', (e) => { if (e.target.closest('summary')) setTimeout(() => { if (details.open) state.openGroups.add(g.id); else state.openGroups.delete(g.id); }, 0); });
    nodes.push(details);
  }
  if (!nodes.length) { const p = document.createElement('p'); p.className = 'info-empty'; p.textContent = o ? '該当する物品はありません。' : ''; nodes.push(p); }
  // The shared message box must survive the rebuild when it sits beside a row of the list.
  const box = $('message'); if (box && $('info-groups').contains(box)) $('info-view').insertBefore(box, $('info-groups'));
  $('info-groups').replaceChildren(...nodes);
}
function csvCell(value) { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function downloadOverviewCSV() {
  const o = state.overview; if (!o?.items?.length) { message('物品の情報がまだありません。「更新」を押してください。', true); return; }
  const header = ['団体', '状況', 'No.', '個体コード', '物品名', '貸出日時', '貸出時の状態', '貸出時のメモ', '写真の省略', '返却日時', '返却時の状態', '返却時のメモ', '物品区分', '借用元'];
  const rows = overviewGroups(o.items).flatMap((g) => sortedItems(g.items).map((i) => [g.id ? g.name : '', PHASE_LABELS[i.phase] || i.phase, shortNumber(i.code) || '', i.code, i.name, formatTime(i.lent_at, JST_FULL), i.lent_condition ? (i.lent_condition === 'damage' ? '損傷あり' : '損傷なし') : '', i.lent_note, i.lent_photo_skip ? '省略' : '', formatTime(i.returned_at, JST_FULL), i.return_condition ? CONDITION_LABELS[i.return_condition] || i.return_condition : '', i.return_note, i.item_scope || '区分未確認', i.item_owner || '']));
  const text = `﻿${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `物品の貸出状況_${formatTime(o.generated_at, JST_FULL).replace(/\D/g, '')}.csv`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  message(`${rows.length}点の一覧をCSVで保存しました（${o.cached ? '端末に保存した情報' : '最新の情報'}・${formatTime(o.generated_at)} 時点）。`);
}

async function loadQR() { if (window.jsQR) return; if (!state.qrLoad) state.qrLoad = new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/rental/vendor/jsQR.js'; script.onload = resolve; script.onerror = () => { state.qrLoad = null; reject(new Error('QR読取を準備できません。コード入力を使ってください。')); }; document.head.append(script); }); await state.qrLoad; }
async function startCamera(mode) {
  if (mode === 'photo' && !registrationMode()) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { message('カメラにはHTTPS接続が必要です。この端末ではコード入力を使ってください。', true); return; }
  if (mode === 'photo' && !state.draft) { message('物品を読み取ってから撮影してください。', true); return; }
  stopNFC();
  try {
    if (!state.stream) { state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); $('camera').srcObject = state.stream; await $('camera').play(); }
    state.cameraMode = mode;
    if (!state.detector && 'BarcodeDetector' in window) { try { const formats = await BarcodeDetector.getSupportedFormats(); if (formats.includes('qr_code')) state.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch {} }
    if (!state.detector) await loadQR();
    setCameraDisplay(); compactBatch(state.config.mode !== 'borrow' || !!state.config.borrower.trim()); $('camera-panel').scrollIntoView({ block: 'start' }); clearTimeout(state.scanTimer); void scanLoop();
  } catch (e) { stopCamera(); message(e.name === 'NotAllowedError' ? 'カメラの使用を許可してください。個体コードの入力も使えます。' : e.message || 'カメラを開けませんでした。', true); }
}
function stopCamera() { clearTimeout(state.scanTimer); state.stream?.getTracks().forEach((t) => t.stop()); state.stream = null; state.cameraMode = null; $('camera').srcObject = null; setCameraDisplay(); }
function setCameraDisplay() {
  const checking = state.config.mode === 'check'; const readOnly = !registrationMode(); const open = !!state.stream; const photo = !readOnly && state.cameraMode === 'photo'; $('camera-panel').hidden = !open; $('stop-camera').hidden = !open; $('capture-actions').hidden = readOnly || !open || !photo || !state.draft; $('scan-frame').hidden = photo || (!checking && !!state.draft);
  $('capture-photo').disabled = lockedDraft() || (state.draft?.photos.length || 0) >= 5; $('capture-and-next').disabled = lockedDraft() || (state.config.mode === 'borrow' && !state.config.photoSkip && !state.draft?.photos.length); $('capture-and-next').textContent = (state.draft?.photos.length || 0) >= 5 ? '登録・次へ' : state.config.mode === 'borrow' ? '撮って登録・次へ' : '撮って返却・次へ';
  $('camera-label').textContent = photo ? '全体・付属品・傷を写してください' : checking ? '別のQRを写すと、その物品のチェックに切り替わります' : state.draft ? 'この物品を登録すると、次のQRを読み取れます' : '次のQRを写してください';
}
async function scanLoop() {
  if (!state.stream) return; try { const video = $('camera'); if (state.cameraMode === 'scan' && (!state.draft || state.config.mode === 'check') && !lockedDraft() && video.readyState >= 2 && !document.hidden) {
    let raw; if (state.detector) { const codes = await state.detector.detect(video); raw = codes[0]?.rawValue; } else { const canvas = document.createElement('canvas'); const scale = Math.min(1, 640 / video.videoWidth); canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale); const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(video, 0, 0, canvas.width, canvas.height); const image = ctx.getImageData(0, 0, canvas.width, canvas.height); raw = window.jsQR?.(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data; }
    if (raw && codeFromInput(raw)) await openItem(raw);
  } } catch {} state.scanTimer = setTimeout(scanLoop, 240);
}
function stopNFC() { state.nfcAbort?.abort(); state.nfcAbort = null; $('scan-nfc').textContent = 'NFCを連続で読む'; }
async function startNFC() {
  if (state.nfcAbort) { stopNFC(); return; } stopCamera();
  try { const reader = new NDEFReader(); state.nfcAbort = new AbortController(); await reader.scan({ signal: state.nfcAbort.signal }); $('scan-nfc').textContent = 'NFC読取を止める'; reader.onreading = (event) => { for (const record of event.message.records) { if (record.recordType === 'url') { const value = new TextDecoder(record.encoding || 'utf-8').decode(record.data); void openItem(value); break; } } }; reader.onreadingerror = () => message('NFCを読み取れませんでした。QRまたは個体コードを使ってください。', true); } catch (e) { stopNFC(); message(e.message || 'この端末ではNFC読取を開始できません。QRを使ってください。', true); }
}
// Windows desk: 物品読取 (the issuer software) reads cards on the RC-S370 and offers them on this PC only.
const PC_READER = 'http://127.0.0.1:48731';
const PC_READER_KEY = 'iyakusai-rental-pc-reader';
const PC_READER_HELP = 'ブラウザが「ローカル ネットワーク」（このPCの機器）へのアクセスを聞いてきたら「許可」を押してください。';
function pcReaderWanted() { try { return localStorage.getItem(PC_READER_KEY) === '1'; } catch { return false; } }
function setPCReaderWanted(value) { try { if (value) localStorage.setItem(PC_READER_KEY, '1'); else localStorage.removeItem(PC_READER_KEY); } catch { /* private mode: press the button each time */ } }
function readerStatus(text, kind = '') { $('reader-status').hidden = !text; $('reader-status').textContent = text; $('reader-status').dataset.kind = kind; }
function renderPCReader() { const on = !!state.reader; $('scan-pc').textContent = on ? 'PCの読取機を止める' : 'PCの読取機を使う'; $('scan-pc').setAttribute('aria-pressed', String(on)); $('scan-pc').classList.toggle('selected', on); }
function stopPCReader(text = '') { if (state.reader) { state.reader.abort?.abort(); state.reader = null; } renderPCReader(); readerStatus(text, 'paused'); }
function startPCReader() {
  if (state.reader) { setPCReaderWanted(false); stopPCReader(); return; }
  setPCReaderWanted(true); $('scan-pc').hidden = false; $('pc-reader-hint').hidden = false;
  const reader = state.reader = { client: uuid(), after: null, instance: '', claim: true, failures: 0, abort: null, opening: Promise.resolve() };
  renderPCReader(); readerStatus(`PCの読取機に接続しています…　${PC_READER_HELP}`, 'paused'); void pcReaderLoop(reader);
}
async function pcReaderAsk(reader, query) {
  reader.abort = new AbortController(); const timer = setTimeout(() => reader.abort.abort(), 35000);
  try { const response = await fetch(`${PC_READER}/v1/reads?${query}`, { cache: 'no-store', credentials: 'omit', signal: reader.abort.signal }); let body = {}; try { body = await response.json(); } catch { /* shown as not connected */ } return { status: response.status, body }; }
  finally { clearTimeout(timer); }
}
// One screen at a time receives the cards (the last one that connected); cards placed while this screen is hidden or signed out are not opened later.
// Asking for what comes after a card confirms it was received, so items open in turn while the next request is already waiting;
// a card that arrives while hidden is not confirmed, and 物品読取 says it was not handed over.
async function pcReaderLoop(reader) {
  while (state.reader === reader) {
    if (document.hidden || !state.staff) { reader.after = null; reader.claim = true; await wait(500); continue; }
    const query = new URLSearchParams({ client: reader.client, wait: reader.after === null ? '0' : '25' }); if (reader.after !== null) query.set('after', String(reader.after)); if (reader.claim) query.set('claim', '1');
    try {
      const { status, body } = await pcReaderAsk(reader, query);
      if (state.reader !== reader) return;
      if (status === 409 && body.code === 'taken_over') { stopPCReader('別のタブ・ウィンドウでPCの読取機を使い始めたので、この画面では止めました。'); return; }
      if (status === 409 && body.code === 'not_claimed') { reader.claim = true; reader.after = null; continue; }
      if (status !== 200 || !body.ok) throw new Error(body.error || `status ${status}`);
      reader.failures = 0;
      const r = body.reader || {}; readerStatus(`PCの読取機：${r.text || '接続しました。'}`, r.state || '');
      if (document.hidden) { reader.claim = true; reader.after = null; continue; }
      reader.claim = false;
      // A new instance is a restarted 物品読取: start from its current number, never replay earlier cards.
      const fresh = body.instance === reader.instance ? body.reads || [] : []; reader.instance = body.instance; reader.after = body.seq;
      for (const read of fresh) if (read.age_ms <= 15000) {
        const receivedAt = performance.now(), generation = reader.readGeneration || 0, owner = state.staff?.id;
        reader.opening = reader.opening.then(() => {
          if (state.reader !== reader || document.hidden || !state.staff || state.staff.id !== owner || (reader.readGeneration || 0) !== generation) return;
          if (read.age_ms + performance.now() - receivedAt > 15000) { readerStatus('前のカードの読取りから時間が経ちました。カードを外して、置き直してください。', 'paused'); return; }
          return openPCRead(read);
        }).catch(() => {});
      }
    } catch {
      if (state.reader !== reader) return; if (document.hidden) continue;
      reader.failures += 1; reader.claim = true; reader.after = null;
      readerStatus(`PCの読取ソフトに接続できません。このPCで「物品読取」（発行ソフトの「貸出・返却の読取り」）を起動してください。${PC_READER_HELP}拒否した場合は、アドレスバー左のアイコンから許可し直してください。`, 'error');
      await wait(Math.min(5000, 1000 * reader.failures));
    }
  }
}
async function openPCRead(read) {
  if (document.hidden || !state.staff) return;
  if (state.view !== 'work') showView('work');
  if (lockedDraft()) { message(state.opening ? '前の物品の情報を取得中です。表示されてから、カードを置き直してください。' : '前の物品を保存しています。終わってから、カードを置き直してください。', true); return; }
  await openItem(read.url);
}
async function switchMode(mode) {
  if (!['borrow', 'return', 'check'].includes(mode) || mode === state.config.mode || lockedDraft()) return;
  if (draftHasContent()) { message('入力中の写真・メモがあります。登録またはこの物品を閉じてから切り替えてください。', true); return; }
  const reopen = (mode === 'check' || state.config.mode === 'check') && state.draft?.item.code;
  if (reopen) { await openItem(reopen, true, mode); return; }
  state.opening = true; renderDraft();
  try {
    const config = { ...state.config, mode }; const draft = state.draft ? { ...state.draft, condition: 'normal', stage: 'condition', damageSelected: false } : null;
    if (draft) Object.assign(config, plannedBorrowerChoice(draft.item, config, mode));
    await saveSelection(config, draft); state.config = config; state.draft = draft;
    if (state.stream && mode === 'check') state.cameraMode = 'scan';
    $('borrower').value = config.borrower || ''; renderBatch(); renderDraft();
  } catch { message('端末に設定を保存できません。', true); }
  finally { state.opening = false; renderDraft(); }
}
async function closeDraft() {
  if (lockedDraft() || !state.draft) return; if (draftHasContent() && !confirm('この物品の未登録の入力（状態・写真・メモ）を破棄して閉じますか？')) return;
  state.opening = true; renderDraft();
  try { await dbPut('settings', null, staffKey('draft')); state.draft = null; if (state.stream) state.cameraMode = 'scan'; renderDraft(); } catch { message('入力を閉じられませんでした。端末の空き容量を確認してください。', true); }
  finally { state.opening = false; renderDraft(); }
}
const FLOW_STAGES = ['condition', 'photos', 'note', 'review'];
const FLOW_TITLES = { details: '今回貸す物品を入力', condition: '破損の有無を確認', photos: '現状の写真を追加', note: 'メモを入力', review: '内容を確認して登録' };
function flowStages(d) { return state.config.mode === 'borrow' && d.item.card_kind === 'irregular' ? ['details', ...FLOW_STAGES] : FLOW_STAGES; }
function displayItem(d) {
  const info = state.config.mode === 'borrow' ? d.irregular : d.item.current_loan?.irregular;
  return d.item.card_kind === 'irregular' && info?.name ? `${info.name}（${info.quantity || '?'}${info.unit || ''}）` : d.item.name;
}
function irregularError(d) {
  const v = d.irregular || {};
  if (!v.name?.trim() || !v.unit?.trim()) return '品名と数量の単位を入力してください。';
  if (!Number.isInteger(Number(v.quantity)) || Number(v.quantity) < 1 || Number(v.quantity) > 10000) return '数量は1〜10000の整数で入力してください。';
  if (!['学内', '学外', '委員会'].includes(v.item_scope)) return '物品区分を選んでください。';
  if (v.item_scope === '学外' && !v.item_owner?.trim()) return '学外物品の借用元を入力してください。';
  return '';
}
function renderIrregular(d) {
  if (d.item.card_kind !== 'irregular') return;
  if (state.config.mode === 'borrow') {
    const v = d.irregular || {};
    for (const [field, key] of [['name','name'], ['quantity','quantity'], ['unit','unit'], ['scope','item_scope'], ['owner','item_owner']]) {
      const input = $('irregular-' + field); const value = String(v[key] ?? ''); if (input.value !== value) input.value = value;
      input.disabled = lockedDraft();
    }
    d.item.photo_required = v.item_scope ? v.item_scope === '学外' : null;
    $('item-origin').textContent = [v.item_scope || '物品区分を選んでください', v.item_owner].filter(Boolean).join(' ／ ');
  }
  $('item-title').textContent = displayItem(d);
  const history = d.inspection?.irregular_history || [];
  $('irregular-history-values').replaceChildren(...history.map(a => {
    const row = document.createElement('p'); const v = a.irregular;
    row.textContent = `${a.voided ? '【取消済み】' : ''}${formatTime(a.server_at, JST_FULL)} ／ ${ACTION_TEXT[a.action] || a.action} ／ ${v ? `${v.name} ${v.quantity}${v.unit} ／ ${v.item_scope}${v.item_owner ? '・' + v.item_owner : ''}` : '物品情報なし'} ／ ${a.borrower || ''} ／ ${CONDITION_LABELS[a.condition] || a.condition}${a.note ? ' ／ ' + a.note : ''}`;
    return row;
  }));
  if (!history.length) $('irregular-history-values').textContent = 'このカードの貸出履歴はまだありません。';
}
const ACTION_TEXT = { borrow: '貸出', return: '返却', check: 'チェック記録' };
function valuesList(target, rows) {
  target.replaceChildren(...rows.flatMap(([label, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value || '記録なし'; return [dt, dd]; }));
}
function focusWorkflow() {
  $('workflow').scrollIntoView({ block: 'start' }); $('workflow-title').focus({ preventScroll: true });
}
function renderSummary(d) {
  const itemText = `${shortNumber(d.item.code) ? `No.${shortNumber(d.item.code)}` : d.item.code}　${displayItem(d) || d.item.code}`;
  $('operation-choice-item').textContent = itemText;
  $('workflow-context-item').textContent = itemText;
  $('workflow-context-action').textContent = ACTION_TEXT[state.config.mode] || '';
  const loan = d.inspection?.loan || d.item.current_loan;
  const active = loaned(d.item);
  const last = d.inspection?.latest;
  const check = d.inspection?.last_check;
  const rows = [
    ['現在の状態', STATUS_LABELS[d.item.status] || d.item.status],
    ['借用団体', active ? d.item.current_loan?.borrower : '現在の貸出なし'],
    ['写真', d.item.photo_required == null ? '要件未設定・物品区分を確認' : d.item.photo_required ? '必須（貸出・返却・チェック各1枚以上）' : '任意'],
  ];
  if (d.item.planned_state === 'pending' && d.item.planned_borrower_name) rows.push(['予定貸出先', d.item.planned_borrower_name]);
  if (loan) { rows.push([active ? '貸出時の状態' : '前回の貸出時の状態', `${loan.condition === 'damage' ? '破損あり' : loan.condition === 'normal' || d.item.current_loan ? '破損なし' : '未記録'} ／ ${loan.note || 'メモなし'}`]); rows.push(['貸出日時', formatTime(loan.server_at, JST_FULL)]); }
  if (last && last.action !== 'borrow' && last.action !== 'check') rows.push(['最近の記録', `${ACTION_TEXT[last.action] || last.action} ／ ${last.condition === 'damage' ? '破損あり' : CONDITION_LABELS[last.condition] || '未記録'} ／ ${last.note || 'メモなし'}`]);
  if (check) rows.push(['前回のチェック', `${formatTime(check.server_at, JST_FULL)} ／ ${check.condition === 'damage' ? '破損あり' : '破損なし'} ／ ${check.note || 'メモなし'}`]);
  valuesList($('item-summary-values'), rows);
  $('summary-updated').textContent = d.cached ? '通信なし・保存済み情報です。現在の状態は送信時に再確認します。' : `読取時のサーバー情報 ／ ${formatTime(d.read_at, JST_FULL)}${d.summaryCached ? ' ／ 貸出時の写真と履歴は最新未確認です。' : ''}`;
  const photos = $('summary-loan-photos');
  const key = loan?.operation_id || '';
  if (photos.dataset.key !== key) {
    photos.dataset.key = key;
    photos.replaceChildren(...(loan?.photos || []).map((p) => { const a = document.createElement('a'), img = document.createElement('img'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener'; img.src = p.url; img.alt = `貸出時の写真 ${p.index}`; img.loading = 'lazy'; a.append(img); img.onerror = () => { img.hidden = true; a.textContent = '貸出時の写真を開く（通信を確認）'; }; return a; }));
  }
}
function renderCompletion() {
  const op = state.queue.find((o) => o.id === state.completion);
  $('workflow-completion').hidden = !op || !!state.draft;
  if (!op) return;
  const action = ACTION_TEXT[op.meta.action] || op.meta.action;
  $('completion-title').textContent = op.acknowledged ? `${action}${op.meta.action === 'check' ? 'を保存しました' : '処理が完了しました'}` : `${action}を${['conflict','error'].includes(op.status) ? '登録できませんでした' : '送信しています'}`;
  $('completion-item').textContent = `${op.itemName} ／ ${op.meta.item_code}`;
  $('completion-status').textContent = op.acknowledged ? `サーバーに記録しました。写真：${op.expectedPhotos}枚。 ${receiptLabel(op)}` : op.status === 'error' || op.status === 'conflict' ? `${op.error} 写真とメモは端末に保持しています。「今回の処理」から再送・確認してください。` : '端末に保存しました。サーバーの受付を待っています。未送信が0件になるまで画面を開いてください。';
  $('completion-status').classList.toggle('error', ['error', 'conflict'].includes(op.status));
}
function renderWorkflow() {
  $('photo-skip-row').hidden = true;
  $('return-options').hidden = true; $('lend-condition').hidden = true; $('queue-item').hidden = true; $('commit-hint').hidden = true;
  $('capture-and-next').hidden = true;
  const d = state.draft, on = !!d && registrationMode() && !(d.item.card_kind === 'irregular' && state.config.mode === 'check' && !loaned(d.item));
  $('workflow').hidden = !on; renderCompletion();
  if (!d) { $('empty-item').hidden = !!state.completion; return; }
  renderSummary(d);
  if (!on) return;
  const stages = flowStages(d);
  const stage = stages.includes(d.stage) ? d.stage : stages[0];
  const step = stages.indexOf(stage), action = ACTION_TEXT[state.config.mode];
  $('workflow-title').textContent = `${action}：${FLOW_TITLES[stage]}`;
  $('workflow-progress').replaceChildren(...stages.map((value, i) => { const li = document.createElement('li'); li.textContent = `${i + 1}. ${{ details: '物品', condition: '状態', photos: '写真', note: 'メモ', review: '確認' }[value]}`; if (value === stage) li.setAttribute('aria-current', 'step'); return li; }));
  for (const value of ['details', ...FLOW_STAGES]) $('workflow-' + value).hidden = value !== stage;
  $('inspection-panel').hidden = state.config.mode !== 'check' || stage !== 'condition';
  $('check-next').hidden = true;
  $('photo-block').hidden = stage !== 'photos'; $('note').hidden = stage !== 'note'; document.querySelector('.note-label').hidden = stage !== 'note';
  $('photo-tip').textContent = d.item.photo_required ? '必須：1枚以上、最大5枚。全体と破損の場所を写してください。' : d.item.photo_required === false ? '任意：写真なしで次へ進めます。追加する場合は最大5枚です。' : '写真要件が未設定です。管理者に物品区分の登録を依頼してください。';
  $('note-title').textContent = d.condition === 'damage' ? '破損の場所と内容' : 'メモ';
  $('note-hint').textContent = d.condition === 'damage' ? '必須' : '任意';
  $('note').required = d.condition === 'damage';
  for (const b of document.querySelectorAll('[data-damage]')) { const selected = d.damageSelected && b.dataset.damage === d.condition; b.setAttribute('aria-pressed', String(selected)); b.classList.toggle('selected', selected); b.disabled = lockedDraft(); }
  $('workflow-back').hidden = step === 0; $('workflow-back').disabled = lockedDraft(); $('workflow-next').disabled = lockedDraft();
  $('workflow-next').textContent = stage === 'review' ? `${action}を登録する` : stage === 'photos' && !d.item.photo_required ? '次へ（写真は任意）' : stage === 'note' && d.condition !== 'damage' ? '確認画面へ（メモは任意）' : '次へ';
  $('borrower-row').hidden = state.config.mode !== 'borrow' || stage !== 'review';
  valuesList($('workflow-review-values'), [['物品', `${displayItem(d)} ／ ${d.item.code}`], ...(d.item.card_kind === 'irregular' ? [['区分・借用元', [state.config.mode === 'borrow' ? d.irregular?.item_scope : d.item.item_scope, state.config.mode === 'borrow' ? d.irregular?.item_owner : d.item.item_owner].filter(Boolean).join(' ／ ')]] : []), ['処理', action], ['破損', d.condition === 'damage' ? 'あり' : 'なし'], ['写真', `${d.photos.length}枚`], ['メモ', d.note || 'なし']]);
}
async function flowMove(direction) {
  if (!state.draft || lockedDraft()) return;
  const d = state.draft, stages = flowStages(d), stage = d.stage || stages[0];
  if (direction > 0) {
    if (stage === 'details' && irregularError(d)) { message(irregularError(d), true, $('workflow-navigation')); return; }
    if (stage === 'condition' && !d.damageSelected) { message('破損あり・なしを選んでください。', true, $('workflow-navigation')); return; }
    if (stage === 'photos' && d.item.photo_required == null) { message('写真要件が未設定です。管理者に物品区分の登録を依頼してください。', true, $('workflow-navigation')); return; }
    if (stage === 'photos' && d.item.photo_required && !d.photos.length) { message('学外物品は写真を1枚以上追加してください。', true, $('workflow-navigation')); return; }
    if (stage === 'note' && d.condition === 'damage' && !$('note').value.trim()) { message('破損の場所と内容をメモに書いてください。', true, $('workflow-navigation')); $('note').focus(); return; }
    if (stage === 'review') { await commitItem(); return; }
  }
  const next = { ...d, stage: stages[Math.max(0, stages.indexOf(stage) + direction)], note: $('note').value };
  state.opening = true; renderWorkflow();
  try { await dbPut('settings', next, staffKey('draft')); state.draft = next; message(''); if (state.stream) stopCamera(); }
  catch (error) { state.localDraftUnsaved = true; message(localSaveMessage(error), true, $('workflow-navigation')); }
  finally { state.opening = false; renderDraft(); focusWorkflow(); }
}
function installWorkflow() {
  for (const [field, key] of [['name','name'], ['quantity','quantity'], ['unit','unit'], ['scope','item_scope'], ['owner','item_owner']]) {
    $('irregular-' + field).addEventListener('input', async (event) => {
      const d = state.draft; if (!d || lockedDraft() || d.item.card_kind !== 'irregular' || state.config.mode !== 'borrow') return;
      d.irregular = { name: '', quantity: '', unit: '', item_scope: '', item_owner: '', ...d.irregular, [key]: event.target.value };
      d.irregularTouched = true;
      d.item.photo_required = d.irregular.item_scope ? d.irregular.item_scope === '学外' : null;
      $('item-title').textContent = displayItem(d);
      $('workflow-context-item').textContent = `${d.item.code}　${displayItem(d)}`;
      $('item-origin').textContent = [d.irregular.item_scope || '物品区分を選んでください', d.irregular.item_owner].filter(Boolean).join(' ／ ');
      message('');
      try { await saveDraft(); } catch { message('物品情報を端末に保存できません。画面を閉じず、空き容量を確認してください。', true, $('workflow-details')); }
    });
  }
  $('workflow-photos').append($('photo-block'));
  $('workflow-note').append(document.querySelector('.note-label'), $('note'));
  $('workflow-review').append($('borrower-row'));
  for (const selector of ['.identify', '.batch', '.queue-panel', '#info-view', '.label-panel', '#camera-panel', '#operation-choice', '#inspection-panel']) document.querySelector(selector).setAttribute('data-feedback', '');
  document.addEventListener('click', (event) => { const button = event.target.closest('button'); if (button) { state.feedbackAnchor = button.closest('[data-feedback]') || button.parentElement; message(''); } }, true);
  $('workflow-next').onclick = () => flowMove(1); $('workflow-back').onclick = () => flowMove(-1);
  document.querySelectorAll('[data-damage]').forEach((b) => b.onclick = async () => {
    if (!state.draft || lockedDraft()) return;
    const prior = state.draft, next = { ...prior, condition: b.dataset.damage, damageSelected: true };
    state.opening = true; renderWorkflow();
    try { await dbPut('settings', next, staffKey('draft')); state.draft = next; message(`${b.dataset.damage === 'damage' ? '破損あり' : '破損なし'}を選択しました。`, false, $('workflow-condition')); }
    catch { message('選択を端末に保存できませんでした。もう一度選んでください。', true, $('workflow-condition')); }
    finally { state.opening = false; renderDraft(); }
  });
  $('completion-next').onclick = () => { state.completion = null; renderDraft(); compactBatch(false); $('item-code').focus(); message('次の物品を読み取ってください。', false, document.querySelector('.identify')); };
}
async function init() {
  installWorkflow();
  try { state.db = await dbOpen(); } catch { message('端末への保存が使えません。ブラウザの通常モードで開き直してください。', true); $('login-button').disabled = true; return; }
  // Sign-in is the common account's screen; it brings the person back to this item afterwards.
  $('login-button').onclick = () => { try { sessionStorage.setItem('iyakusai-return', location.pathname + location.search); } catch { /* private mode: come back by reading the item again */ } location.assign('/'); };
  // Logging out is done on the common screen; the rental screen stays signed in with the account.
  $('item-form').onsubmit = (e) => { e.preventDefault(); state.feedbackAnchor = document.querySelector('.identify'); message(''); void openItem($('item-code').value); };
  $('borrower').oninput = async () => { if (!state.staff || state.commitBusy) return; state.config.borrower = $('borrower').value; state.config.borrowerSource = 'manual'; state.config.plannedFor = ''; renderBatch(); try { await saveConfig(); } catch { message('貸出先を端末に保存できませんでした。', true); } };
  document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => switchMode(b.dataset.mode));
  document.querySelectorAll('[data-choice]').forEach((b) => b.onclick = async () => { await switchMode(b.dataset.choice); if (state.config.mode === b.dataset.choice) focusWorkflow(); });
  document.querySelectorAll('[data-condition]').forEach((b) => b.onclick = async () => { if (!state.draft || lockedDraft()) return; state.draft.condition = b.dataset.condition; try { await saveDraft(); renderDraft(); } catch { message('返却状態を端末に保存できませんでした。', true); } });
  document.querySelectorAll('[data-lend]').forEach((b) => b.onclick = async () => { if (!state.draft || lockedDraft() || state.config.mode !== 'borrow') return; state.draft.condition = b.dataset.lend; try { await saveDraft(); renderDraft(); if (b.dataset.lend === 'damage' && !$('note').value.trim()) $('note').focus(); } catch { message('貸出時の状態を端末に保存できませんでした。', true); } });
  $('photo-skip').onchange = async () => { if (!state.staff) return; state.config.photoSkip = $('photo-skip').checked; renderBatch(); renderDraft(); try { await saveConfig(); } catch { message('写真の省略の設定を端末に保存できませんでした。', true); } };
  $('view-work').onclick = () => showView('work'); $('view-info').onclick = () => showView('info');
  $('info-refresh').onclick = () => loadOverview(true); $('info-csv').onclick = downloadOverviewCSV; $('info-open-only').onchange = renderOverview;
  // Touches, clicks and wheel scrolling on the information tab: data that arrives afterwards must not move the rows (2026-10-18).
  // A finger scroll always starts with touchstart on the list. The window scroll event is not used: switching tabs can
  // clamp the scroll position, which would count as an interaction without any touch.
  const infoTouched = () => { state.infoHasInteracted = true; state.infoInteractionSeq++; };
  $('info-view').addEventListener('touchstart', () => { state.infoTouching = true; infoTouched(); }, { passive: true });
  for (const type of ['touchend', 'touchcancel']) document.addEventListener(type, () => { state.infoTouching = false; settleInfoGesture(); }, { passive: true });
  $('info-view').addEventListener('pointerdown', (event) => { state.infoPointers.add(event.pointerId); infoTouched(); }, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, (event) => { state.infoPointers.delete(event.pointerId); settleInfoGesture(); }, { passive: true });
  $('info-view').addEventListener('wheel', infoTouched, { passive: true });
  window.addEventListener('blur', () => { state.infoTouching = false; state.infoPointers.clear(); settleInfoGesture(); });
  let filterTimer; $('info-filter').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(renderOverview, 150); };
  $('new-batch').onclick = async () => { if (draftHasContent() || lockedDraft()) { message('入力中の物品を登録または閉じてから、団体を切り替えてください。', true); return; } if (state.draft) await closeDraft(); state.config.borrower = ''; state.config.borrowerSource = ''; state.config.plannedFor = ''; $('borrower').value = ''; await saveConfig(); renderBatch(); $('borrower').focus(); };
  $('edit-batch').onclick = () => { compactBatch(false); document.querySelector('.batch').scrollIntoView({ block: 'start' }); };
  $('skip-item').onclick = closeDraft; $('queue-item').onclick = () => commitItem(); $('return-normal').onclick = () => commitItem('normal');
  $('check-next').onclick = closeDraft; $('check-refresh').onclick = () => { if (state.config.mode === 'check' && state.draft) void openItem(state.draft.item.code, true); };
  $('file-photo').onclick = () => { if (!lockedDraft()) { stopCamera(); $('photo-input').click(); } }; $('photo-input').onchange = async (e) => { await addPhotos([...e.target.files]); e.target.value = ''; };
  $('open-photo-camera').onclick = () => startCamera('photo'); $('scan-qr').onclick = () => startCamera('scan'); $('stop-camera').onclick = stopCamera; $('capture-photo').onclick = () => takePhoto(); $('capture-and-next').onclick = () => takePhoto(true);
  $('scan-nfc').hidden = !('NDEFReader' in window); $('scan-nfc').onclick = startNFC;
  // PC reader: offered on PCs (mouse or touchpad, no Web NFC). 物品読取 opens this screen with ?reader=1, which is removed from the address.
  const params = new URLSearchParams(location.search);
  if (params.get('reader') === '1') { setPCReaderWanted(true); params.delete('reader'); const rest = params.toString(); history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`); }
  $('scan-pc').hidden = !(pcReaderWanted() || (matchMedia('(any-pointer: fine)').matches && !('NDEFReader' in window))); $('pc-reader-hint').hidden = $('scan-pc').hidden;
  $('scan-pc').onclick = startPCReader; if (pcReaderWanted()) startPCReader();
  $('label-current').onclick = () => { if (!state.draft) { message('追加する物品を先に読み取ってください。', true); return; } const item = state.draft.item; const url = item.url || item.public_url || (state.serverMode === 'drive' && location.protocol === 'https:' ? `${location.origin}/i/${encodeURIComponent(item.code)}` : ''); if (!url) { message('この物品の公開HTTPS URLを一覧に入力してください。ローカル接続のURLはラベルに使えません。', true); return; } const line = `${item.code}\t${item.name || ''}\t${url}`; clearLabelExport(); $('label-items').value = `${$('label-items').value.trim()}${$('label-items').value.trim() ? '\n' : ''}${line}`; };
  $('label-items').oninput = clearLabelExport; $('label-export').onclick = downloadLabelExport;
  $('label-form').onsubmit = async (e) => {
    e.preventDefault(); clearLabelExport(); const button = e.submitter; const inputText = $('label-items').value; const lines = inputText.trim().split(/\r?\n/).filter(Boolean); if (!lines.length || lines.length > 200) { message('1〜200個体のラベル一覧を入力してください。', true); return; }
    try { const items = lines.map((line, i) => { const parts = line.split('\t'); if (parts.length !== 3 || !parts[0].trim() || !parts[1].trim() || !/^https:\/\//i.test(parts[2].trim())) throw new Error(`${i + 1}行目は「個体コード・物品名・HTTPS URL」の3項目をタブで区切ってください。`); return { code: parts[0].trim().toUpperCase(), name: parts[1].trim(), url: parts[2].trim() }; }); button.disabled = true; const response = await fetch('/api/rental/labels', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-SMM-CSRF': '1' }, body: JSON.stringify({ items }) }); if (!response.ok) { const result = await response.json(); if (response.status === 401) showLogin(); throw new Error(result.error || 'ラベルを作れませんでした'); } if (!(response.headers.get('content-type') || '').includes('application/pdf')) throw new Error('印刷用PDFの応答を確認できませんでした'); const blob = await response.blob(); const hash = await labelPDFHash(blob); if ($('label-items').value !== inputText) { message('一覧が変更されたため、このPDFと書込み用データは保存できません。もう一度作ってください。', true); return; } const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(/\D/g, ''); const basename = `物品ラベル_${stamp}_${hash.slice(0, 8)}`; labelExport = Object.freeze({ basename, json: JSON.stringify({ format: 'rental-label-issuance-v1', label_mm: [91, 55], page: 'A4', items, pdf_sha256: hash }, null, 2) }); labelDownloadURL = URL.createObjectURL(blob); $('label-download').href = labelDownloadURL; $('label-download').download = `${basename}.pdf`; $('label-download').hidden = false; $('label-export').hidden = false; $('label-download').click(); message(`${items.length}個体の印刷用PDFを作りました。書込み用データも同じフォルダーに保存し、印刷は倍率100%で行ってください。`); } catch (error) { clearLabelExport(); message(error.message, true); } finally { button.disabled = false; }
  };
  let noteSequence = 0; $('note').oninput = () => {
    if (!state.draft || state.commitBusy) return;
    state.draft.note = $('note').value; const seq = ++noteSequence, draft = clone(state.draft);
    $('note-save-status').textContent = '端末に保存しています…';
    void dbPut('settings', draft, staffKey('draft')).then(() => { if (seq === noteSequence) $('note-save-status').textContent = 'メモを端末に保存しました。'; }).catch(() => { if (seq === noteSequence) $('note-save-status').textContent = '保存できませんでした。メモを保持したまま再入力してください。'; });
  };
  $('resend').onclick = async () => {
    let count = 0;
    try { for (const op of state.queue) if (!op.acknowledged && op.status === 'error') { const next = {...op, status:'pending', error:''}; await dbPut('operations', next); Object.assign(op,next); count++; }
      renderQueue(); state.pollDelay = 5000; message(count ? `再送を開始しました（${count}件）。` : '再送する未送信処理はありません。保存待ちの状態を再確認します。', false, document.querySelector('.queue-panel')); void processQueue(); void pollReceipts();
    } catch { message('端末への保存に失敗しました。未送信処理を保持しています。', true, document.querySelector('.queue-panel')); }
  };
  window.addEventListener('online', async () => { connection(); if (!state.staff) return; for (const op of state.queue) if (!op.acknowledged && op.status === 'error') { op.status = 'pending'; op.error = ''; await dbPut('operations', op); } void processQueue(); schedulePoll(); }); window.addEventListener('offline', connection);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshUntouchedItem(); void processQueue(); schedulePoll(); } else { clearTimeout(state.pollTimer); stopNFC(); stopCamera(); if (state.reader) state.reader.readGeneration = (state.reader.readGeneration || 0) + 1; state.reader?.abort?.abort(); } });
  window.addEventListener('pageshow', (event) => { if (event.persisted) void refreshUntouchedItem(); });
  window.addEventListener('beforeunload', (e) => { if (state.photoBusy || state.commitBusy || state.localDraftUnsaved) { e.preventDefault(); e.returnValue = ''; } });
  // Header and tabs lead to the other modules. Unsent registrations stay on the device but are sent only while this screen is open, so say so before leaving.
  document.querySelectorAll('a[data-leave]').forEach((a) => a.addEventListener('click', (e) => { if (state.localDraftUnsaved) { e.preventDefault(); message('写真をまだ端末に保存できていません。画面を移動せず、写真の保存または登録を再試行してください。', true); return; } const unsent = state.staff ? state.queue.filter((o) => !o.acknowledged && o.status !== 'archived_conflict').length : 0; if (!unsent && !state.photoBusy && !state.commitBusy) return; if (!confirm(`未送信の登録が ${unsent} 件あります。この画面を離れると送信が止まります（端末には残り、物品貸出を開き直すと続きから送ります）。\n\n移動しますか？`)) e.preventDefault(); }));
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/rental-sw.js', { scope: '/' }).catch(() => {});
  try { await activateSession(await request('/api/me')); } catch (e) { showLogin(); connection(); if (e.status !== 401) message('サーバーに接続できません。接続先と通信を確認してください。', true); }
}
function itemEditorValues() {
  return { name: $('edit-item-name').value.trim(), item_scope: $('edit-item-scope').value || null, item_owner: $('edit-item-owner').value.trim() };
}
function itemEditorDirty() {
  return !!(state.itemEdit && JSON.stringify(itemEditorValues()) !== JSON.stringify(state.itemEdit.original));
}
function itemEditorStatus(text, error = false) {
  $('item-edit-status').textContent = text;
  $('item-edit-status').classList.toggle('error', error);
  $('item-edit-status').setAttribute('role', error ? 'alert' : 'status');
}
function renderItemEditHistory(history) {
  $('item-edit-history').replaceChildren(...history.map(entry => {
    const p = document.createElement('p');
    const labels = {name:'物品名',item_scope:'物品区分',item_owner:'借用元'};
    const changes = Object.keys(labels).filter(key => entry.before[key] !== entry.after[key]).map(key => `${labels[key]}：${entry.before[key] || '未設定'} → ${entry.after[key] || '未設定'}`);
    p.textContent = `${formatTime(entry.server_at)} ${entry.actor_name} ／ ${changes.join(' ／ ')}`; return p;
  }));
  if (!history.length) $('item-edit-history').textContent = 'この画面からの変更履歴はまだありません。';
}
async function openItemEditor(code) {
  if (!state.canEditItems || state.itemEditLoading || state.itemEditBusy) return;
  if (state.queue.some(op => op.meta.item_code === code && !op.acknowledged && op.status !== 'archived_conflict')) { message('この物品に未送信の登録があります。「今回の処理」を確認してから編集してください。', true); return; }
  if (state.draft?.item.code === code && (lockedDraft() || draftHasContent())) { message('この物品の貸出・返却を入力中です。登録するか「この物品を閉じる」を押してから編集してください。', true); return; }
  state.itemEditLoading = true;
  try {
    const result = await request(`/api/items/${encodeURIComponent(code)}/metadata`);
    if (result.item.card_kind === 'irregular') { message('イレギュラーカードの品名・数量は、貸出時の入力画面で設定してください。', true); return; }
    const item = result.item;
    const original = {name:item.name, item_scope:item.item_scope || null, item_owner:item.item_owner || ''};
    state.itemEdit = {item, generation:result.ledger_generation, original, pending:null};
    $('edit-item-name').value = original.name; $('edit-item-scope').value = original.item_scope || ''; $('edit-item-owner').value = original.item_owner;
    $('item-edit-code').textContent = item.code;
    $('item-edit-current').hidden = true; $('item-edit-compare').hidden = true;
    renderItemEditHistory(result.history); itemEditorStatus('');
    $('item-edit-save').disabled = false;
    stopCamera(); stopNFC(); $('item-editor').showModal(); $('edit-item-name').focus();
  } catch (error) { message(error.message, true); }
  finally { state.itemEditLoading = false; }
}
function closeItemEditor() {
  if (state.itemEditBusy) return;
  if (itemEditorDirty() && !confirm('物品情報の変更を保存せずに閉じますか？')) return;
  $('item-editor').close(); state.itemEdit = null;
}
async function compareItemEditor() {
  const edit = state.itemEdit; if (!edit || state.itemEditBusy) return;
  state.itemEditBusy = true; $('item-edit-save').disabled = true;
  try {
    const result = await request(`/api/items/${encodeURIComponent(edit.item.code)}/metadata`);
    const current = result.item;
    $('item-edit-current').hidden = false;
    if (result.ledger_generation !== edit.generation || current.card_kind === 'irregular') {
      edit.blocked = true;
      $('item-edit-current').textContent = '台帳が初期化されています。この画面を閉じ、現在の物品を開き直してください。入力は上の欄に残しています。'; return;
    }
    $('item-edit-current').textContent = `現在の登録：${current.name} ／ ${current.item_scope || '区分未確認'} ／ ${current.item_owner || '借用元未設定'}。上の入力と照合してから保存してください。`;
    edit.item = current; edit.pending = null; edit.blocked = false;
    renderItemEditHistory(result.history); itemEditorStatus('入力は変更していません。確認後に「変更を保存」を押してください。');
  } catch (error) { itemEditorStatus(error.message, true); }
  finally { state.itemEditBusy = false; $('item-edit-save').disabled = !!edit.blocked; }
}
async function saveItemEditor(event) {
  event.preventDefault(); const edit = state.itemEdit;
  if (!edit || state.itemEditBusy || edit.blocked) return;
  if (!navigator.onLine) { itemEditorStatus('通信がないため保存できません。入力を残しています。接続後に保存してください。', true); return; }
  if (state.draft?.item.code === edit.item.code && (lockedDraft() || draftHasContent())) { itemEditorStatus('この物品の貸出・返却が入力中です。入力を完了してから編集してください。', true); return; }
  const current = itemEditorValues();
  if (current.item_scope === '学外' && !current.item_owner) { itemEditorStatus('学外物品の借用元を入力してください。', true); $('edit-item-owner').focus(); return; }
  const body = {...current, expected_version:edit.item.version, ledger_generation:edit.generation};
  // Reuse the exact request after a lost acknowledgement. Changing any input creates a new request.
  const signature = JSON.stringify(body);
  if (edit.pending?.signature !== signature) edit.pending = {signature, body:{...body, operation_id:uuid()}};
  state.itemEditBusy = true; $('item-edit-save').disabled = true; itemEditorStatus('保存しています…');
  try {
    const result = await request(`/api/items/${encodeURIComponent(edit.item.code)}/metadata`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(edit.pending.body)});
    edit.item = result.item; edit.original = current; edit.pending = null;
    renderItemEditHistory(result.history); $('item-edit-compare').hidden = true; $('item-edit-current').hidden = true;
    if (state.draft?.item.code === edit.item.code && !draftHasContent()) {
      state.draft.item = result.item; state.draft.cached = false;
      try { await saveDraft(); } catch { state.draft.cached = true; }
      renderDraft();
    }
    try { await dbPut('items', result.item); } catch { /* The server has durably saved the edit. */ }
    clearLabelExport();
    itemEditorStatus(result.changed || result.replayed ? '物品情報を保存しました。印刷済みの券面は、必要に応じて作り直してください。' : '変更はありません。');
    void loadOverview();
  } catch (error) {
    itemEditorStatus(error.message + ' 入力はこの画面に残しています。', true);
    if (error.status === 409) { $('item-edit-compare').hidden = false; edit.blocked = true; }
  } finally { state.itemEditBusy = false; $('item-edit-save').disabled = !!edit.blocked; }
}
function initItemEditor() {
  $('item-edit-form').addEventListener('submit', event => void saveItemEditor(event));
  $('item-edit-close').onclick = closeItemEditor;
  $('item-editor').addEventListener('cancel', event => { event.preventDefault(); closeItemEditor(); });
  $('item-edit-compare').onclick = () => void compareItemEditor();
  $('edit-current-item').onclick = () => { if (state.draft) void openItemEditor(state.draft.item.code); };
  window.addEventListener('beforeunload', event => { if (itemEditorDirty() || state.itemEditBusy) { event.preventDefault(); event.returnValue = ''; } });
}

initItemEditor();

// ---- corrections of registrations made by mistake (server: corrections.ts). Nothing is deleted:
// a cancelled registration stays in the history with a mark, and every correction names who made it.
const CORRECTION_KIND_TEXT = { void: '登録の取消', borrower: '貸出先の訂正', release: '要確認の解除' };
const VOID_EFFECT_TEXT = { ready: '取り消すと、この物品は「貸出可能」に戻ります。', unchanged: 'このチェック記録だけを取消済みにします。貸出・返却の状態は変わりません。' };
const CORRECTION_INPUTS = ['correction-void-reason', 'correction-borrower-name', 'correction-borrower-reason', 'correction-release-reason'];
function correctionOperationText(op) {
  const what = op.action === 'borrow' ? `貸出 ／ ${op.borrower || '団体未記録'}${op.condition === 'damage' ? '・損傷あり' : ''}`
    : op.action === 'return' ? `返却 ／ ${CONDITION_LABELS[op.condition] || op.condition || '状態未記録'} ／ ${op.borrower || '団体未記録'}`
    : `チェック記録 ／ ${op.condition === 'damage' ? '破損あり' : '破損なし'}`;
  const irregular = op.irregular ? ` ／ ${op.irregular.name} ${op.irregular.quantity}${op.irregular.unit}` : '';
  return `${formatTime(op.server_at, JST_FULL)} ${what}${irregular}${op.note ? ` ／ ${op.note}` : ''}${op.actor_name ? ` ／ 担当 ${op.actor_name}` : ''}`;
}
function correctionItemState(item) {
  const borrower = loaned(item) ? item.current_loan?.borrower : '';
  return `現在：${STATUS_LABELS[item.status] || item.status}${borrower ? ` ／ ${borrower}` : ''}`;
}
function correctionStatus(text, error = false) {
  $('correction-status').textContent = text;
  $('correction-status').classList.toggle('error', error);
  $('correction-status').setAttribute('role', error ? 'alert' : 'status');
}
function correctionUnsent(code) { return state.queue.some((op) => op.meta.item_code === code && !op.acknowledged && op.status !== 'archived_conflict'); }
function renderCorrection() {
  const c = state.correction; if (!c) return;
  const { item, allowed, operations, corrections } = c.data;
  const number = shortNumber(item.code);
  $('correction-item').textContent = `${number ? `No.${number}　` : ''}${item.code}　${item.name || ''}`;
  $('correction-state').textContent = correctionItemState(item);
  const v = allowed.void, b = allowed.borrower, r = allowed.release;
  $('correction-void').hidden = !v;
  if (v) {
    $('correction-void-target').textContent = `対象：${correctionOperationText(v)}`;
    $('correction-void-effect').textContent = v.effect === 'loaned' ? `取り消すと、この物品は「貸出中（${v.restore_borrower || '団体未記録'}）」に戻ります。` : VOID_EFFECT_TEXT[v.effect] || '';
  }
  $('correction-void-blocked').hidden = !!v || !allowed.void_blocked; $('correction-void-blocked').textContent = allowed.void_blocked || '';
  $('correction-borrower').hidden = !b;
  // The group of a loan still out comes before undoing; the group of a returned loan is rarely needed, so it goes last.
  if (b && !b.active) $('correction-void-blocked').after($('correction-borrower')); else $('correction-release').after($('correction-borrower'));
  if (b) $('correction-borrower-target').textContent = `${formatTime(b.server_at, JST_FULL)} の貸出${b.active ? '（貸出中）' : '（返却済み）'}の団体：${b.borrower || '団体未記録'}`;
  $('correction-release').hidden = !r;
  if (r) $('correction-release-target').textContent = r.last_return ? `返却時の記録：${correctionOperationText(r.last_return)}` : '返却時の記録は見つかりません。';
  const locked = state.correctionBusy || c.blocked;
  for (const id of ['correction-void-submit', 'correction-borrower-submit', 'correction-release-submit', ...CORRECTION_INPUTS]) $(id).disabled = locked;
  $('correction-reload').disabled = state.correctionBusy;
  $('correction-operations').replaceChildren(...operations.map((op) => {
    const li = document.createElement('li'); if (op.voided) li.className = 'voided';
    const what = document.createElement('span'); what.className = 'what'; what.textContent = correctionOperationText(op); li.append(what);
    if (op.voided) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `取消済み（${formatTime(op.voided.server_at)} ${op.voided.actor_name}：${op.voided.reason}）`; li.append(tag); }
    if (op.original_borrower != null) { const tag = document.createElement('span'); tag.className = 'tag fixed'; tag.textContent = `貸出先を訂正（元：${op.original_borrower || '団体未記録'}）`; li.append(tag); }
    return li;
  }));
  if (!operations.length) $('correction-operations').textContent = 'この物品の登録はまだありません。';
  $('correction-history').replaceChildren(...corrections.map((h) => {
    const li = document.createElement('li');
    const detail = h.kind === 'borrower' ? `：${h.from || '団体未記録'} → ${h.to}` : h.kind === 'void' ? `：${ACTION_TEXT[h.action] || h.action || ''}` : '';
    li.textContent = `${formatTime(h.server_at, JST_FULL)} ${CORRECTION_KIND_TEXT[h.kind] || h.kind}${detail} ／ ${h.actor_name}${h.reason ? ` ／ ${h.reason}` : ''}`;
    return li;
  }));
  if (!corrections.length) $('correction-history').textContent = '訂正・取消の履歴はまだありません。';
}
async function openCorrection(code) {
  if (!state.canCorrect || state.correctionBusy) return;
  if (correctionUnsent(code)) { message('この物品に未送信の登録があります。「今回の処理」で受付が済んでから訂正してください。', true); return; }
  if (state.draft?.item.code === code && (lockedDraft() || draftHasContent())) { message('この物品の入力中の状態・写真・メモがあります。登録するか「この物品を閉じる」を押してから訂正してください。', true); return; }
  if (!navigator.onLine) { message('通信がないため訂正できません。接続後にもう一度押してください。', true); return; }
  state.correctionBusy = true;
  try {
    const data = await request(`/api/items/${encodeURIComponent(code)}/corrections`);
    state.correction = { code, data, pending: null, blocked: false, changed: false };
    for (const id of CORRECTION_INPUTS) $(id).value = '';
    $('correction-reload').hidden = true; correctionStatus('');
    stopCamera(); stopNFC(); renderCorrection(); $('correction-dialog').showModal(); $('correction-close').focus();
  } catch (error) { message(error.message, true); }
  finally { state.correctionBusy = false; renderCorrection(); }
}
async function reloadCorrection() {
  const c = state.correction; if (!c || state.correctionBusy) return;
  state.correctionBusy = true; renderCorrection();
  try {
    c.data = await request(`/api/items/${encodeURIComponent(c.code)}/corrections`); c.blocked = false; c.pending = null;
    $('correction-reload').hidden = true; correctionStatus('最新の情報を読み直しました。内容を確認してから操作してください。');
  } catch (error) { correctionStatus(error.message, true); }
  finally { state.correctionBusy = false; renderCorrection(); }
}
async function submitCorrection(kind) {
  const c = state.correction; if (!c || state.correctionBusy || c.blocked) return;
  const allowed = c.data.allowed;
  const target = kind === 'void' ? allowed.void : kind === 'borrower' ? allowed.borrower : null;
  if ((kind === 'release' && !allowed.release) || (kind !== 'release' && !target)) return;
  if (!navigator.onLine) { correctionStatus('通信がないため訂正できません。入力は残しています。接続後にもう一度押してください。', true); return; }
  if (correctionUnsent(c.code)) { correctionStatus('この物品に未送信の登録があります。「今回の処理」で受付が済んでから訂正してください。', true); return; }
  const reasonInput = $(kind === 'void' ? 'correction-void-reason' : kind === 'borrower' ? 'correction-borrower-reason' : 'correction-release-reason');
  const reason = reasonInput.value.trim();
  if (kind !== 'borrower' && !reason) { correctionStatus(kind === 'void' ? '取り消す理由を入力してください。' : '確認した内容を入力してください。', true); reasonInput.focus(); return; }
  const body = { kind, reason, expected_version: c.data.item.version, ledger_generation: c.data.ledger_generation };
  if (target) body.target_operation_id = target.operation_id;
  if (kind === 'borrower') {
    const name = $('correction-borrower-name').value.trim();
    if (!name || !state.borrowers.includes(name)) { correctionStatus(name ? '登録済みの貸出先から選んでください。候補が出ないときは通信を確認してください。' : '正しい貸出先を選んでください。', true); $('correction-borrower-name').focus(); return; }
    if (name === target.borrower) { correctionStatus('今の貸出先と同じです。正しい貸出先を選んでください。', true); return; }
    body.borrower = name;
  }
  const question = kind === 'void' ? `${correctionOperationText(target)}\n\nこの登録を取り消しますか？` : kind === 'borrower' ? `貸出先を「${target.borrower || '団体未記録'}」から「${body.borrower}」に訂正しますか？` : 'この物品を「貸出可能」に戻しますか？';
  if (!confirm(question)) return;
  // A lost answer is resent with the same correction number; changing any input makes a new one.
  const signature = JSON.stringify(body);
  if (c.pending?.signature !== signature) c.pending = { signature, body: { ...body, correction_id: uuid() } };
  state.correctionBusy = true; correctionStatus('保存しています…'); renderCorrection();
  try {
    const result = await request(`/api/items/${encodeURIComponent(c.code)}/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.pending.body) });
    c.data = result; c.pending = null; c.changed = true;
    reasonInput.value = ''; if (kind === 'borrower') $('correction-borrower-name').value = '';
    try { await dbPut('items', result.item); } catch { /* the server holds the correction */ }
    correctionStatus(result.changed || result.replayed ? `${CORRECTION_KIND_TEXT[kind]}を保存しました。${correctionItemState(result.item)}` : '変更はありません。');
    if (state.overview) void loadOverview();
  } catch (error) {
    correctionStatus(`${error.message} 入力はこの画面に残しています。`, true);
    if (error.status === 409) { c.blocked = true; $('correction-reload').hidden = false; }
  } finally { state.correctionBusy = false; renderCorrection(); }
}
async function closeCorrection() {
  if (state.correctionBusy) return;
  const c = state.correction; $('correction-dialog').close(); state.correction = null;
  // Show the item in its corrected state (borrow, return/check choice, or check) unless work was started on it.
  if (c?.changed && state.draft?.item.code === c.code && !draftHasContent() && !lockedDraft()) await openItem(c.code, true);
}
function initCorrections() {
  $('correct-current-item').onclick = () => { if (state.draft) void openCorrection(state.draft.item.code); };
  $('correction-close').onclick = () => void closeCorrection();
  $('correction-dialog').addEventListener('cancel', (event) => { event.preventDefault(); void closeCorrection(); });
  $('correction-reload').onclick = () => void reloadCorrection();
  $('correction-void-submit').onclick = () => void submitCorrection('void');
  $('correction-borrower-submit').onclick = () => void submitCorrection('borrower');
  $('correction-release-submit').onclick = () => void submitCorrection('release');
  window.addEventListener('beforeunload', (event) => { if (state.correctionBusy) { event.preventDefault(); event.returnValue = ''; } });
}

initCorrections();
void init();
