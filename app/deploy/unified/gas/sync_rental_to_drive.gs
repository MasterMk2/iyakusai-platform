/**
 * 医薬祭 委員会アプリ 物品の Google ドライブ複製  sync_rental_to_drive.gs  (Google Apps Script)
 * ------------------------------------------------------------------------------
 * 委員会アプリ（https://app.iyakusai.com）の物品の貸出・返却の写真と記録を、共有ドライブへ複製する。
 * あわせて、貸出状況の一覧（スプレッドシート）を書き出す。数分ごとに自動で動く。
 *
 *   保存先（初回に自動で作る）:
 *     <物品管理フォルダ>/物品貸出_写真と記録（自動保存）/
 *       物品貸出_状況一覧（アプリから自動更新）   … スプレッドシート（更新情報・物品一覧・団体別・操作履歴）
 *       物品別/IY-100123_No.123_<物品名>/20261017-102345_貸出_<団体>_<操作ID先頭8字>_01.jpg … _記録.json
 *
 * アプリには Google の鍵を置かない。このスクリプトがアプリへ署名付きで取りに行き、Drive に書き、
 * 保存できたことをアプリへ報告する（報告した内容はアプリが写真の SHA-256 で照合する）。
 * 作るだけで、Drive のファイルを上書き・削除・ごみ箱へ移動しない。同じ名前のファイルがあれば中身を
 * 照合して使い回す（二重に作らない）。中身が違えば保存せず、アプリにエラーとして報告する。
 *
 * 署名の鍵は「プロジェクトの設定 → スクリプト プロパティ」に RENTAL_SYNC_KEY（16 進）として置く。
 * コードやシートに書かない。鍵はサーバーの config/rental-drive-sync.key と同じ値（メールの鍵とは別）。
 *
 * 設置するのは 1 つのプロジェクトだけ（LockService はプロジェクトの中でしか効かないので、2 か所に入れると
 * 同じ写真が二重に保存されうる）。
 *
 * 手順: リポジトリ直下の docs/deployment.md §6（設置・確認・止め方）。
 */

// ============================ 設定 ============================
const CONFIG = {
  APP_ORIGIN: 'https://app.iyakusai.com',

  // 保存先を作る親フォルダ（共有ドライブの 2026医薬祭/内務部/会場/物品管理）の ID。
  // フォルダをブラウザで開いたときの URL の folders/ の後ろ。
  PARENT_FOLDER_ID: '',

  // 親フォルダの下に作るフォルダ・ファイルの名前（初回だけ作る。名前を変えたら新しく作られる）。
  ROOT_FOLDER_NAME: '物品貸出_写真と記録（自動保存）',
  ITEMS_FOLDER_NAME: '物品別',
  SHEET_NAME: '物品貸出_状況一覧（アプリから自動更新）',

  // 自動実行の間隔（分）。GAS の許容値は 1 / 5 / 10 / 15 / 30。
  TRIGGER_MINUTES: 5,

  // 写真の複製に使う時間の上限（GAS は 6 分で打ち切られるので、一覧の書き出しの分を残して止める）。
  MAX_RUNTIME_MS: 240000,

  // 1 回に問い合わせる操作の数（アプリの上限は 20）。
  PAGE_SIZE: 10,
};
// ==============================================================

const PROP = {
  key: 'RENTAL_SYNC_KEY',
  rootId: 'driveRootFolderId', // 作った保存先フォルダの ID
  sheetId: 'ledgerSheetId', // 作ったスプレッドシートの ID
  version: 'ledgerVersion', // 最後に書き出した一覧の版
};
const CLIENT = 'rental-drive-sync';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** トリガーと手動実行の入口。 */
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('別の実行が進行中のためスキップ');
    return;
  }
  try {
    const started = Date.now();
    const key = syncKey_();
    const root = rootFolder_();
    const saved = syncFiles_(key, root, started);
    syncLedger_(key, root);
    Logger.log('Drive に保存した操作: %s 件', saved);
  } finally {
    lock.releaseLock();
  }
}

/** 定期実行を設定する（1 回だけ実行）。 */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('run').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  Logger.log('%s 分ごとの実行を設定しました。', CONFIG.TRIGGER_MINUTES);
}

/** 定期実行を止める（複製をやめるとき）。 */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
}

/** 接続の確認だけ（写真は保存しない）: 鍵の形式・保存先フォルダ・アプリへの署名付きの問い合わせ。 */
function checkSetup() {
  const key = syncKey_();
  const root = rootFolder_();
  const res = call_(key, 'GET', '/v1/rental/sync/pending?limit=1');
  if (res.code !== 200) throw new Error('アプリが ' + res.code + ' を返しました（401 なら鍵の違いか時刻のずれ）。');
  const status = JSON.parse(res.text).drive_sync || {};
  Logger.log('接続できました。保存先: %s ／ アプリの保存待ち: %s 件', root.getName(), status.waiting);
}

// ---------------------------------------------------------------- 写真と記録

function syncFiles_(key, root, started) {
  const items = childFolder_(root, CONFIG.ITEMS_FOLDER_NAME);
  const folders = {};
  const seen = {};
  let done = 0;
  while (Date.now() - started < CONFIG.MAX_RUNTIME_MS) {
    const res = call_(key, 'GET', '/v1/rental/sync/pending?limit=' + CONFIG.PAGE_SIZE);
    if (res.code !== 200) throw new Error('保存待ちの一覧を取得できません（' + res.code + '）。次回やり直します。');
    const fresh = JSON.parse(res.text).operations.filter(function (op) {
      return !seen[op.operation_id];
    });
    if (fresh.length === 0) break;
    for (let i = 0; i < fresh.length; i++) {
      if (Date.now() - started >= CONFIG.MAX_RUNTIME_MS) return done;
      const op = fresh[i];
      seen[op.operation_id] = true;
      if (saveOperation_(key, items, folders, op)) done++;
    }
  }
  return done;
}

/** 1 つの操作の写真と記録を保存してアプリへ報告する。全部保存できたら true。 */
function saveOperation_(key, items, folders, op) {
  const saved = [];
  let error = null;
  try {
    const folder = folders[op.folder] || (folders[op.folder] = childFolder_(items, op.folder));
    const existing = filesByName_(folder);
    for (let i = 0; i < op.files.length; i++) {
      const f = op.files[i];
      let file = null;
      const same = existing[f.name] || [];
      for (let j = 0; j < same.length && !file; j++) {
        const bytes = same[j].getBlob().getBytes();
        if (bytes.length === f.size && sha256Hex_(bytes) === f.sha256) file = same[j];
      }
      if (!file && same.length > 0) {
        error = 'name_conflict'; // 同じ名前で中身の違うファイル。上書きしない。
        break;
      }
      if (!file) {
        const res = call_(key, 'GET', '/v1/rental/sync/file?op=' + op.operation_id + '&idx=' + f.idx);
        if (res.code !== 200) {
          error = 'drive';
          break;
        }
        if (res.bytes.length !== f.size || sha256Hex_(res.bytes) !== f.sha256) {
          error = 'integrity';
          break;
        }
        file = folder.createFile(Utilities.newBlob(res.bytes, f.mime, f.name));
      }
      saved.push({ idx: f.idx, drive_id: file.getId(), sha256: f.sha256, size: f.size });
    }
  } catch (e) {
    Logger.log('Drive に保存できませんでした: %s', e);
    error = 'drive';
  }
  const report = { operation_id: op.operation_id, saved: saved };
  if (error) report.error = error;
  const res = call_(key, 'POST', '/v1/rental/sync/ack', Utilities.newBlob(JSON.stringify(report)).getBytes());
  // 報告が届かなくても、保存したファイルは次回に名前と中身で見つけて報告し直す。
  if (res.code === 401 || res.code >= 500) throw new Error('アプリへ報告できません（' + res.code + '）。次回やり直します。');
  // 照合の不一致など（アプリがこの操作をエラーにして、時間をおいて再試行する）。ほかの操作は続ける。
  if (res.code !== 200) {
    Logger.log('アプリが報告を受け付けませんでした（%s）。', res.code);
    return false;
  }
  return !error && JSON.parse(res.text).status === 'complete';
}

/** フォルダ内の（ごみ箱にない）ファイルを名前ごとに。 */
function filesByName_(folder) {
  const out = {};
  const it = folder.getFiles();
  while (it.hasNext()) {
    const file = it.next();
    if (file.isTrashed()) continue;
    (out[file.getName()] = out[file.getName()] || []).push(file);
  }
  return out;
}

// ---------------------------------------------------------------- 状況一覧（スプレッドシート）

function syncLedger_(key, root) {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  const sheetId = props.getProperty(PROP.sheetId);
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      Logger.log('一覧のスプレッドシートを開けないため作り直します: %s', e);
    }
  }
  const known = ss ? props.getProperty(PROP.version) || '' : '';
  const res = call_(key, 'GET', '/v1/rental/sync/ledger?known=' + known);
  if (res.code !== 200) throw new Error('一覧を取得できません（' + res.code + '）。次回やり直します。');
  const data = JSON.parse(res.text);
  if (!ss) {
    ss = SpreadsheetApp.create(CONFIG.SHEET_NAME);
    try {
      DriveApp.getFileById(ss.getId()).moveTo(root);
    } catch (e) {
      Logger.log('一覧を保存先フォルダへ移せませんでした（マイドライブに残っています）: %s', e);
    }
    ss.getSheets()[0].setName(data.stamp.sheet);
    props.setProperty(PROP.sheetId, ss.getId());
  }
  if (!data.unchanged) {
    data.sheets.forEach(function (s) {
      writeSheet_(ss, s.name, s.rows);
    });
    props.setProperty(PROP.version, data.version);
  }
  const info = ss.getSheetByName(data.stamp.sheet);
  if (info) info.getRange(data.stamp.cell).setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'));
}

function writeSheet_(ss, name, rows) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  if (rows.length === 0) return;
  const width = rows[0].length;
  if (sheet.getMaxRows() < rows.length) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  // すべて文字として書く（No. や日時を数値・日付に変えない）。
  sheet.getRange(1, 1, rows.length, width).setNumberFormat('@').setValues(rows);
  sheet.setFrozenRows(1);
}

// ---------------------------------------------------------------- 保存先

/** 保存先フォルダ（初回は親フォルダの下に作る）。 */
function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP.rootId);
  if (id) return DriveApp.getFolderById(id);
  if (!/^[A-Za-z0-9_-]{10,160}$/.test(CONFIG.PARENT_FOLDER_ID)) throw new Error('CONFIG.PARENT_FOLDER_ID（物品管理フォルダの ID）を設定してください。');
  const root = childFolder_(DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID), CONFIG.ROOT_FOLDER_NAME);
  props.setProperty(PROP.rootId, root.getId());
  return root;
}

/** 名前の子フォルダ（無ければ作る）。 */
function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    const folder = it.next();
    if (!folder.isTrashed()) return folder;
  }
  return parent.createFolder(name);
}

// ---------------------------------------------------------------- 署名付きの問い合わせ

/** アプリへの問い合わせ（svc-auth/v1 の署名付き）。body はバイト列（POST のときだけ）。 */
function call_(key, method, path, body) {
  const timestamp = String(Date.now());
  const nonce = Utilities.getUuid().replace(/-/g, '');
  const bodyHash = body ? sha256Hex_(body) : EMPTY_SHA256;
  const canonical = ['svc-auth/v1', CLIENT, method, path, timestamp, nonce, '', bodyHash].join('\n');
  const signature = hex_(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, Utilities.newBlob(canonical).getBytes(), key));
  const options = {
    method: method.toLowerCase(),
    headers: { 'X-Svc-Client': CLIENT, 'X-Svc-Timestamp': timestamp, 'X-Svc-Nonce': nonce, 'X-Svc-Signature': signature },
    muteHttpExceptions: true,
    followRedirects: false,
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = body;
  }
  const res = UrlFetchApp.fetch(CONFIG.APP_ORIGIN + path, options);
  const code = res.getResponseCode();
  return code === 200 && path.indexOf('/v1/rental/sync/file?') === 0 ? { code: code, bytes: res.getContent() } : { code: code, text: res.getContentText() };
}

function syncKey_() {
  const hex = String(PropertiesService.getScriptProperties().getProperty(PROP.key) || '').trim();
  if (!/^([0-9a-fA-F]{2}){32,}$/.test(hex)) throw new Error('スクリプト プロパティ RENTAL_SYNC_KEY（16 進、64 文字以上）がありません。');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.substr(i, 2), 16);
    bytes.push(b > 127 ? b - 256 : b);
  }
  return bytes;
}

function sha256Hex_(bytes) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
}

function hex_(bytes) {
  return bytes
    .map(function (b) {
      const v = b < 0 ? b + 256 : b;
      return (v < 16 ? '0' : '') + v.toString(16);
    })
    .join('');
}
