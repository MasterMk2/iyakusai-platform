/**
 * 医薬祭 委員会アプリ メール送り出し  send_mail_to_app.gs  (Google Apps Script)
 * ------------------------------------------------------------------------------
 * Gmail のメールを 1 通ずつ元の形（RFC 5322）のまま、委員会アプリの受け口
 *   https://app.iyakusai.com/v1/mail/ingest
 * へ署名付きで送る。Gmail には一切書き込まない（送信・移動・削除・既読化をしない）。
 *
 * 同じスクリプトを 2 つのアカウントで使う（設定 SOURCE だけ変える）。
 *   1. 委員会の共用アカウント（新着とその受信箱の過去分）  SOURCE: 'collector'
 *      → 届いたメールはすべて送る。アプリが To/Cc/List-Id から受信箱を決める。
 *   2. 委員長のアカウント（2025-08 以降の過去分を 1 回だけ） SOURCE: 'backfill'
 *      → 委員会のアドレス（下の COMMITTEE_ADDRESSES）が To・Cc・差出人のどこにも無く、グループ経由の印
 *        （List-Id か件名の先頭のグループの印）も無いメールは、Google の外に出さずにここで飛ばす
 *        （個人宛のメールは送らない）。アプリ側でも同じ判定をする。
 *
 * 署名の鍵は「プロジェクトの設定 → スクリプト プロパティ」に INGEST_KEY（16 進）として置く。
 * コードやシートに書かない。鍵はサーバーの config/mail-ingest.key と同じ値。
 *
 * 手順: リポジトリ直下の docs/deployment.md §6（設置・認可・止め方）。gas/mail/collect_mail.gs とは別物で、
 * そちらの run() は変えない。
 */

// ============================ 設定 ============================
const CONFIG = {
  // 'collector'（委員会の共用アカウント）または 'backfill'（委員長のアカウント・過去分 1 回）。
  SOURCE: 'collector',

  ENDPOINT: 'https://app.iyakusai.com/v1/mail/ingest',

  // これより前のメールは送らない（要件: 2025-08 以降）。
  START_AFTER: '2025/08/01',

  // 1 回の実行の上限（GAS は 6 分で打ち切られるので手前で止める）。
  MAX_RUNTIME_MS: 270000,

  // 1 回の検索で読むスレッド数。
  PAGE_THREADS: 50,

  // アプリが受け付ける 1 通の大きさの上限（40MB）。超えるメールは送らず、記録だけ残す。
  MAX_RAW_BYTES: 40 * 1024 * 1024,

  // backfill のときだけ使う: 委員会のアドレス（グループと共用アカウント）。個人名のアドレスは入れない。
  // アプリの config/mailbox.json と同じ一覧にすること（委員長が確認した版）。
  COMMITTEE_ADDRESSES: [
    // '<委員会のアドレス>@iyakusai.com',
  ],
  // backfill のときだけ使う: グループが件名の先頭に付ける印（[sps] なら 'sps'）。config/mailbox.json の subjectTag と同じ。
  COMMITTEE_SUBJECT_TAGS: [
    // 'sps',
  ],
  // 別ドメイン → 正規ドメイン（.jp は .com と同じ扱い）。
  DOMAIN_ALIASES: { 'iyakusai.jp': 'iyakusai.com' },

  // 自動実行の間隔（分）。GAS の許容値は 1 / 5 / 10 / 15 / 30。
  TRIGGER_MINUTES: 10,
};
// ==============================================================

const PROP = {
  key: 'INGEST_KEY',
  watermark: 'sendWatermarkMs', // collector: ここまで送った受信時刻（ミリ秒）
  recent: 'sendRecentIds', // collector: 直近に送った ID（重なり分の二重送信よけ）
  backfillCursor: 'sendBackfillCursorEpoch', // 過去分: ここより古い分が残っている（秒）
  backfillDone: 'sendBackfillDone',
  dayDone: 'sendBackfillDayDone', // 過去分: いまの 1 日のうち送り済みの ID
  failed: 'sendFailedIds', // 解析できない・大きすぎて送らなかった ID（最大 200）
};

const OVERLAP_MS = 10 * 60 * 1000;

/** トリガーと手動実行の入口。 */
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('別の実行が進行中のためスキップ');
    return;
  }
  try {
    const started = Date.now();
    const key = ingestKey_();
    let sent = 0;
    if (CONFIG.SOURCE === 'collector') sent += forward_(key, started);
    sent += backfill_(key, started);
    const props = PropertiesService.getScriptProperties();
    Logger.log('送信 %s 通。過去分: %s（カーソル %s）', sent, props.getProperty(PROP.backfillDone) === 'true' ? '完了' : '途中', props.getProperty(PROP.backfillCursor));
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

/** 定期実行を止める。backfill は過去分が終わったら止める。 */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
}

/** 接続の確認だけ（メールは送らない）: 鍵の形式と、受け口に届くか（署名なしで 401 が返れば到達）。 */
function checkSetup() {
  ingestKey_();
  const res = UrlFetchApp.fetch(CONFIG.ENDPOINT + '?source=' + CONFIG.SOURCE + '&id=check&at=' + Date.now(), { method: 'post', contentType: 'message/rfc822', payload: 'x', muteHttpExceptions: true });
  Logger.log('受け口の応答: %s（401 なら到達できています）', res.getResponseCode());
}

// ---------------------------------------------------------------- 新着（collector のみ）

function forward_(key, started) {
  const props = PropertiesService.getScriptProperties();
  let watermark = Number(props.getProperty(PROP.watermark) || 0);
  if (!watermark) {
    // 初回: 今を起点にする。それより前は backfill_ が古い方へたどる。
    watermark = Date.now();
    props.setProperty(PROP.watermark, String(watermark));
    if (!props.getProperty(PROP.backfillCursor)) props.setProperty(PROP.backfillCursor, String(Math.floor(watermark / 1000)));
    return 0;
  }
  const recent = JSON.parse(props.getProperty(PROP.recent) || '[]');
  const since = watermark - OVERLAP_MS;
  const query = '-in:draft after:' + Math.floor(since / 1000);
  let sent = 0;
  let newest = watermark;
  let complete = false;
  const keep = [];
  const save = function () {
    // 透かし（ここまで送った時刻）は、検索結果を最後まで送り終えたときだけ進める。
    if (complete) props.setProperty(PROP.watermark, String(newest));
    props.setProperty(PROP.recent, JSON.stringify(keep.concat(recent).slice(0, 300)));
  };
  for (let start = 0; Date.now() - started < CONFIG.MAX_RUNTIME_MS; start += CONFIG.PAGE_THREADS) {
    const threads = GmailApp.search(query, start, CONFIG.PAGE_THREADS);
    for (let i = 0; i < threads.length; i++) {
      const msgs = threads[i].getMessages();
      for (let j = 0; j < msgs.length; j++) {
        const m = msgs[j];
        const at = m.getDate().getTime();
        if (at < since || m.isDraft()) continue;
        const id = m.getId();
        if (recent.indexOf(id) >= 0 || keep.indexOf(id) >= 0) continue;
        if (!send_(key, m)) {
          save(); // 送れなかった: 透かしを進めずに止める（次回やり直す）
          return sent;
        }
        sent++;
        keep.push(id);
        if (at > newest) newest = at;
      }
    }
    if (threads.length < CONFIG.PAGE_THREADS) {
      complete = true;
      break;
    }
  }
  save();
  return sent;
}

// ---------------------------------------------------------------- 過去分（1 日ずつ、新しい方から古い方へ）

/**
 * 1 日分の検索結果を最後まで送り終えてから、前の日へ進む（途中で時間切れになったら、
 * 同じ日を次回やり直す。送り済みの ID は飛ばす）。
 */
function backfill_(key, started) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.backfillDone) === 'true') return 0;
  const after = Math.floor(new Date(CONFIG.START_AFTER).getTime() / 1000);
  let cursor = Number(props.getProperty(PROP.backfillCursor) || Math.floor(Date.now() / 1000));
  let done = JSON.parse(props.getProperty(PROP.dayDone) || '[]');
  let sent = 0;
  while (Date.now() - started < CONFIG.MAX_RUNTIME_MS) {
    if (cursor <= after) {
      props.setProperty(PROP.backfillDone, 'true');
      break;
    }
    const from = Math.max(after, cursor - 86400);
    const query = '-in:draft after:' + from + ' before:' + cursor;
    let finished = false;
    for (let start = 0; ; start += CONFIG.PAGE_THREADS) {
      if (Date.now() - started >= CONFIG.MAX_RUNTIME_MS) break;
      const threads = GmailApp.search(query, start, CONFIG.PAGE_THREADS);
      for (let i = 0; i < threads.length; i++) {
        const msgs = threads[i].getMessages();
        for (let j = 0; j < msgs.length; j++) {
          const m = msgs[j];
          const epoch = Math.floor(m.getDate().getTime() / 1000);
          if (epoch >= cursor || epoch < from || m.isDraft()) continue;
          const id = m.getId();
          if (done.indexOf(id) >= 0) continue;
          if (CONFIG.SOURCE === 'backfill' && !committeeMail_(m)) continue; // 個人宛は送らない
          if (!send_(key, m)) {
            props.setProperty(PROP.dayDone, JSON.stringify(done.slice(-450)));
            return sent; // 同じ日を次回やり直す
          }
          sent++;
          done.push(id);
        }
      }
      props.setProperty(PROP.dayDone, JSON.stringify(done.slice(-450)));
      if (threads.length < CONFIG.PAGE_THREADS) {
        finished = true;
        break;
      }
    }
    if (!finished) break;
    cursor = from;
    done = [];
    props.setProperty(PROP.backfillCursor, String(cursor));
    props.setProperty(PROP.dayDone, '[]');
  }
  return sent;
}

// ---------------------------------------------------------------- 送信

/** 1 通を送る。true: 受け口が受け取った（保存・重複・対象外を含む）。false: 送れなかった（次回やり直す）。 */
function send_(key, m) {
  const id = m.getId();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return true;
  const raw = Utilities.newBlob(m.getRawContent()).getBytes();
  if (raw.length > CONFIG.MAX_RAW_BYTES) {
    remember_(PROP.failed, id + ':large');
    return true;
  }
  const path = '/v1/mail/ingest?source=' + CONFIG.SOURCE + '&id=' + id + '&at=' + m.getDate().getTime();
  const timestamp = String(Date.now());
  const nonce = Utilities.getUuid().replace(/-/g, '');
  const bodyHash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw));
  const canonical = ['svc-auth/v1', 'mail-collector', 'POST', path, timestamp, nonce, '', bodyHash].join('\n');
  const signature = hex_(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, Utilities.newBlob(canonical).getBytes(), key));
  const url = CONFIG.ENDPOINT.replace(/\/v1\/mail\/ingest$/, '') + path;
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'message/rfc822',
      payload: raw,
      headers: { 'X-Svc-Client': 'mail-collector', 'X-Svc-Timestamp': timestamp, 'X-Svc-Nonce': nonce, 'X-Svc-Signature': signature },
      muteHttpExceptions: true,
      followRedirects: false,
    });
  } catch (e) {
    Logger.log('送信できませんでした（通信）: %s', e);
    return false;
  }
  const code = res.getResponseCode();
  if (code === 200) return true;
  if (code === 422 || code === 413) {
    remember_(PROP.failed, id + ':' + code);
    return true;
  }
  // 401（鍵の違い・時刻のずれ）や 5xx は止めて、次回やり直す。内容は記録しない。
  Logger.log('受け口が %s を返しました。次回やり直します。', code);
  return false;
}

// ---------------------------------------------------------------- 判定と補助

/** 委員会のメールか（backfill のとき）: To・Cc・差出人に委員会のアドレス、またはグループ経由の印がある。 */
function committeeMail_(m) {
  const listed = {};
  const lists = {};
  CONFIG.COMMITTEE_ADDRESSES.forEach(function (a) {
    const n = normalize_(a);
    listed[n] = true;
    // Google グループは List-Id に <local.domain> を書く。
    const parts = n.split('@');
    lists[parts[0] + '.' + parts[1]] = true;
    Object.keys(CONFIG.DOMAIN_ALIASES).forEach(function (alias) {
      if (CONFIG.DOMAIN_ALIASES[alias] === parts[1]) lists[parts[0] + '.' + alias] = true;
    });
  });
  const text = [m.getFrom(), m.getTo(), m.getCc()].join(',');
  const found = text.match(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+/g) || [];
  if (found.some(function (a) {
    return listed[normalize_(a)] === true;
  })) return true;
  const listId = String(m.getHeader('List-Id') || '');
  const inner = (listId.match(/<([^<>\s]+)>/) || [null, listId.trim()])[1].toLowerCase();
  if (inner && lists[inner] === true) return true;
  // 件名の先頭の印だけを見る（Re: の後ろに残った古い印は、グループ経由の証拠にならない）。
  const lead = (String(m.getSubject() || '').match(/^\s*((?:\[[^\]\s]{1,20}\]\s*)+)/) || [null, ''])[1];
  const tags = lead.match(/\[([^\]]+)\]/g) || [];
  return tags.some(function (t) {
    return CONFIG.COMMITTEE_SUBJECT_TAGS.map(function (x) {
      return String(x).toLowerCase();
    }).indexOf(t.slice(1, -1).toLowerCase()) >= 0;
  });
}

function normalize_(address) {
  const value = String(address).trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return value;
  let local = value.slice(0, at);
  let domain = value.slice(at + 1);
  domain = CONFIG.DOMAIN_ALIASES[domain] || domain;
  const committeeDomains = {};
  CONFIG.COMMITTEE_ADDRESSES.forEach(function (a) {
    committeeDomains[String(a).split('@')[1]] = true;
  });
  if (committeeDomains[domain]) local = local.split('+')[0];
  return local + '@' + domain;
}

function ingestKey_() {
  const hex = String(PropertiesService.getScriptProperties().getProperty(PROP.key) || '').trim();
  if (!/^([0-9a-fA-F]{2}){32,}$/.test(hex)) throw new Error('スクリプト プロパティ INGEST_KEY（16 進、64 文字以上）がありません。');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.substr(i, 2), 16);
    bytes.push(b > 127 ? b - 256 : b);
  }
  return bytes;
}

function hex_(bytes) {
  return bytes
    .map(function (b) {
      const v = b < 0 ? b + 256 : b;
      return (v < 16 ? '0' : '') + v.toString(16);
    })
    .join('');
}

function remember_(name, value) {
  const props = PropertiesService.getScriptProperties();
  const list = JSON.parse(props.getProperty(name) || '[]');
  list.unshift(value);
  props.setProperty(name, JSON.stringify(list.slice(0, 200)));
}
