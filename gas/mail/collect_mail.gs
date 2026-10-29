/**
 * 医薬祭 メールアーカイブ 収集スクリプト  collect_mail.gs  (Google Apps Script)
 * ------------------------------------------------------------------------------
 * 収集用の委員会アカウントのメールを「広告除外」で JSONL 化し、
 * 共有ドライブ _目録/mail/raw/ に月別ファイル( mail_YYYY-MM.jsonl )で書き出す。
 *
 *  ・Discord の collect_discord_v2.py に相当する「収集係」。要約は一切しない。
 *  ・差分収集(前回以降の新着) + 過去メールのバックフィル(1回の実行で1バッチ)。
 *  ・完全無料。時間主導トリガーで定期実行(既定 TRIGGER_MINUTES=10。2026-10-25 実測も約10分ごと)。
 *  ・読み取り専用(Gmail には一切書き込まない)。
 *
 * 設置の手順はリポジトリ直下の docs/deployment.md §6。
 * フォルダの ID はコードに書かず、スクリプト プロパティ RAW_FOLDER_ID・ATT_FOLDER_ID に置く
 * (プロジェクトの設定 → スクリプト プロパティ)。
 * 要約(digest)は Claude セッション側で raw を読んで生成する(GAS はやらない)。
 */

// ============================ 設定 ============================
const CONFIG = {
  // ① 共有ドライブ _目録/mail/raw フォルダの ID
  //    ★ `python _目録/tools/drive_id.py "_目録/mail/raw"` で引ける(2026-07-24 追加)。
  //    ブラウザでフォルダを開いて URL の .../folders/【この部分】を写す必要は無い。
  //    値はスクリプト プロパティ RAW_FOLDER_ID に置く(コードには書かない)。
  RAW_FOLDER_ID: PropertiesService.getScriptProperties().getProperty('RAW_FOLDER_ID'),

  // ② 収集クエリ。原則すべて収集する。理由: 広告はほとんど来ず、category:promotions 等での
  //    除外は「必要メールの取りこぼし(誤分類)」リスクの方が大きいため。スパム/ゴミ箱は
  //    GmailApp.search が既定で除外。ここでは下書きだけ外す。
  //    もし特定の広告送信元が目立ってきたら '-from:foo@example.com' を足す(送信元ブロック方式)。
  QUERY: '-in:draft',

  // ③ バックフィル1バッチあたりの最大スレッド数(検索・処理のチャンク単位)。
  BATCH_THREADS: 120,

  // ③' 1回の実行の最大稼働時間(ミリ秒)。この枠内でバックフィルのバッチを繰り返す。
  //     GAS の上限は6分/回なので安全側で5分。履歴が多いと1回で終わらない → run を数回押す/定期トリガーで埋まる。
  MAX_RUNTIME_MS: 300000,

  // ④ 過去メールをどこまで遡るか。これより古いメールは収集しない。もっと古い年度も
  //    取り込みたいなら日付を早める(例 '2024/01/01')。
  BACKFILL_AFTER: '2025/01/01',

  // ⑤ 本文の最大保存文字数(長大メール/署名地獄の対策)。
  MAX_BODY_CHARS: 20000,

  // ⑤-b 添付ファイルの実体保存(2026-07-24 追加)。runAttachments() が使う。
  //     raw jsonl には添付の「名前」しか無く中身が読めなかった(添付の多くは
  //     ドライブにも無く、メールにしか残っていなかった)。
  //     共有ドライブ _目録/mail/attachments フォルダの ID。
  //     ★ ID は `python _目録/tools/drive_id.py "_目録/mail/attachments"` で引ける
  //       (ブラウザで開いてURLからコピーする必要は無い)。
  //     値はスクリプト プロパティ ATT_FOLDER_ID に置く(コードには書かない)。
  ATT_FOLDER_ID: PropertiesService.getScriptProperties().getProperty('ATT_FOLDER_ID'),
  //     1ファイルの上限(バイト)。これを超える添付は保存しない(台帳には残す)。
  ATT_MAX_BYTES: 25 * 1024 * 1024,
  //     保存しない拡張子。p7s は S/MIME 署名で中身に意味が無い(実測171個)。
  ATT_SKIP_EXT: ['p7s', 'ics', 'vcf', 'ico'],
  //     ★ 埋め込み画像も拾う(true)。本文に貼られたスクショ(例「分離型ガスコンロ_スクリーンショット.png」)
  //     を落とさないため。代わりに署名ロゴ等の小さい画像は下の ATT_MIN_IMG_BYTES で切る。
  ATT_INCLUDE_INLINE: true,
  //     画像がこれ未満なら保存しない(署名ロゴ・favicon・QRバッジ等のノイズ対策)。
  ATT_MIN_IMG_BYTES: 15 * 1024,

  //     ★★ 本人確認書類は「共有ドライブにも保存しない」。共有ドライブは委員が閲覧できるため、
  //     保存した時点で露出になる(索引に載せる/載せないの話より手前の問題)。
  //     本人確認書類のスキャン画像がメールで届くことがあり、ファイル名からは判別できないことが多い
  //     (スキャンアプリの既定の名前など)。
  //     → 件名・ファイル名のどちらかが該当したら保存せず、台帳に skipped_identity として記録する。
  ATT_IDENTITY_RE: /免許証|免許|身分証|学生証|保険証|パスポート|マイナンバー|個人番号|住民票|印鑑証明|通帳の?(写|コピー)/,
  //     添付収集トリガーの間隔(分)。本文側 TRIGGER_MINUTES と揃えるのが素直。
  //     許容値は 1 / 5 / 10 / 15 / 30。
  ATT_TRIGGER_MINUTES: 10,

  // ⑥ 自動収集の間隔(分)。GAS の許容値は 1 / 5 / 10 / 15 / 30、または 60=1時間。
  //    バックフィル完了後は毎回数秒なので短くて可。推奨 10。値を変えたら installTrigger を再実行。
  TRIGGER_MINUTES: 10,

  // タイムゾーン(月別ファイル名の判定に使う)。
  TZ: 'Asia/Tokyo',
};
// ==============================================================

/** トリガー/手動から呼ぶメイン。差分収集 + バックフィルを時間の許す限り繰り返す。 */
function run() {
  // 多重起動ガード: 前の実行中に別トリガーが発火しても、二重取得せずスキップする。
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('別の実行が進行中のためスキップ'); return; }
  try {
  const startMs = Date.now();
  const props = PropertiesService.getScriptProperties();
  const afterEpoch = Math.floor(new Date(CONFIG.BACKFILL_AFTER).getTime() / 1000);

  // ---- (A) 差分収集: 前回の最終処理時刻より後の新着 ----
  const lastForward = Number(props.getProperty('lastForwardEpoch') || 0);
  if (lastForward > 0) {
    const fwd = {};
    collect_(CONFIG.QUERY + ' after:' + lastForward, CONFIG.BATCH_THREADS, fwd);
    flush_(fwd);
  }
  // 初回は「今」を基準に据えて、以降は新着だけを差分で拾う。
  props.setProperty('lastForwardEpoch', String(nowEpoch_()));

  // ---- (B) バックフィル: MAX_RUNTIME_MS の枠内でバッチを繰り返し、過去へ遡る ----
  let batches = 0, total = 0;
  while (props.getProperty('backfillDone') !== 'true') {
    if (Date.now() - startMs > CONFIG.MAX_RUNTIME_MS) break;     // 6分制限の手前で中断(続きは次回の run)
    const cursor = Number(props.getProperty('backfillCursorEpoch') || nowEpoch_());
    if (cursor <= afterEpoch) { props.setProperty('backfillDone', 'true'); break; }
    const chunk = {};
    const r = collect_(CONFIG.QUERY + ' after:' + afterEpoch + ' before:' + cursor, CONFIG.BATCH_THREADS, chunk);
    if (r.count === 0 || r.oldest === null || r.oldest >= cursor) {
      props.setProperty('backfillDone', 'true'); break;         // これ以上古いメールは無い / 進めない
    }
    flush_(chunk);                                              // バッチごとに書き出し(途中で切れても安全)
    props.setProperty('backfillCursorEpoch', String(r.oldest)); // 次はここより古い分の続き
    batches++; total += r.count;
  }

  Logger.log('done. elapsed=%ss backfillBatches=%s backfillThreads=%s backfillDone=%s cursor=%s',
             Math.round((Date.now() - startMs) / 1000), batches, total,
             props.getProperty('backfillDone'), props.getProperty('backfillCursorEpoch'));
  } finally {
    lock.releaseLock();
  }
}

/** query に一致するスレッドを最大 maxThreads 件だけ処理し、行を linesByMonth に貯める。
 *  戻り値 { count: 処理スレッド数, oldest: 処理した最古メッセージの epoch秒 or null } */
function collect_(query, maxThreads, linesByMonth) {
  let start = 0, count = 0, oldest = null;
  const PAGE = 50;
  while (count < maxThreads) {
    const threads = GmailApp.search(query, start, Math.min(PAGE, maxThreads - count));
    if (!threads.length) break;
    for (let i = 0; i < threads.length; i++) {
      const th = threads[i];
      let labels = [];
      try { labels = th.getLabels().map(function (l) { return l.getName(); }); } catch (e) {}
      const msgs = th.getMessages();
      for (let j = 0; j < msgs.length; j++) {
        const m = msgs[j];
        const epoch = Math.floor(m.getDate().getTime() / 1000);
        if (oldest === null || epoch < oldest) oldest = epoch;
        const ym = Utilities.formatDate(m.getDate(), CONFIG.TZ, 'yyyy-MM');
        (linesByMonth[ym] = linesByMonth[ym] || []).push(toJsonl_(m, th.getId(), labels));
      }
      count++;
    }
    start += threads.length;
    if (threads.length < PAGE) break;
  }
  return { count: count, oldest: oldest };
}

/** 1メッセージ → JSONL 1行。 */
function toJsonl_(m, threadId, labels) {
  let body = m.getPlainBody() || '';
  body = body.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length > CONFIG.MAX_BODY_CHARS) body = body.slice(0, CONFIG.MAX_BODY_CHARS) + ' …(truncated)';
  let attachments = [];
  try { attachments = m.getAttachments().map(function (a) { return a.getName(); }); } catch (e) {}
  const obj = {
    id: m.getId(),
    threadId: threadId,
    date: m.getDate().toISOString(),
    from: m.getFrom(),
    to: m.getTo(),
    cc: m.getCc(),
    subject: m.getSubject(),
    labels: labels,
    attachments: attachments,
    body: body,
  };
  return JSON.stringify(obj);
}

/** 月別ファイルへ追記(既存があれば末尾に足す)。戻り値=書いた行数。 */
function flush_(linesByMonth) {
  if (!CONFIG.RAW_FOLDER_ID) {
    throw new Error('スクリプト プロパティ RAW_FOLDER_ID が未設定です。_目録/mail/raw フォルダの ID を入れてください。');
  }
  const folder = DriveApp.getFolderById(CONFIG.RAW_FOLDER_ID);
  let total = 0;
  for (const ym in linesByMonth) {
    const arr = linesByMonth[ym];
    if (!arr.length) continue;
    const name = 'mail_' + ym + '.jsonl';
    const chunk = arr.join('\n') + '\n';
    const it = folder.getFilesByName(name);
    if (it.hasNext()) {
      const f = it.next();
      const existing = f.getBlob().getDataAsString('UTF-8');
      f.setContent(existing + chunk);
    } else {
      folder.createFile(name, chunk, 'text/plain');
    }
    total += arr.length;
  }
  return total;
}

function nowEpoch_() { return Math.floor(Date.now() / 1000); }

// ==================== 添付ファイルの実体保存(2026-07-24 追加) ====================
/**
 * 添付の「中身」を _目録/mail/attachments/ に保存する。run() とは独立に動かす。
 *
 *  ・なぜ別関数か: run() は本文収集で6分枠をほぼ使い切る。添付DLは重いので分離し、
 *    自前のカーソル(attCursorEpoch)で新しい順に遡る。何度か回せば過去分が埋まる。
 *  ・resumable: 保存先に同名ファイルがあればスキップ。カーソルは1バッチごとに保存。
 *  ・台帳 _index.tsv を同フォルダに追記(いつ・誰から・どのメールの添付か)。
 *    Discord 側 `discord/attachments/_index.tsv` と役割は同じ。
 *  ・Gmail には一切書き込まない(読み取りのみ)。
 *
 * 使い方: Apps Script エディタで runAttachments を選んで実行。
 *         埋まりきるまで数回押す(ログの attDone=true で完了)。
 *         定期実行したいなら installAttachmentTrigger() を1回実行。
 */
function runAttachments() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('別の実行が進行中のためスキップ'); return; }
  try {
    if (!CONFIG.ATT_FOLDER_ID) {
      throw new Error('スクリプト プロパティ ATT_FOLDER_ID が未設定です。_目録/mail/attachments フォルダの ID を入れてください。');
    }
    const startMs = Date.now();
    const props = PropertiesService.getScriptProperties();
    const folder = DriveApp.getFolderById(CONFIG.ATT_FOLDER_ID);
    const afterEpoch = Math.floor(new Date(CONFIG.BACKFILL_AFTER).getTime() / 1000);

    // 既存ファイル名の集合(resumable判定)。
    // ★ 2026-07-24: 当初は毎回フォルダ全走査していたが、**数分おきに回すとこれが主コスト**に
    //   なる(添付が増えるほど重くなる=Drive API を無駄打ちする)。差分フェーズは通常
    //   「新着ゼロ」なので走査ごと不要 → **バックフィルに入るときだけ遅延構築**し、
    //   差分フェーズは候補が出たときだけ getFilesByName で1件ずつ引く。
    let existing = null;   // null = 未構築(= per-name lookup にフォールバック)

    const ctr = { saved: 0, skipped: 0, tooBig: 0 };
    let ledger = [];

    // ---- (A) 差分収集: 前回以降に届いた新着の添付 ----
    // ★ 2026-07-24 修正: 当初これが無く、バックフィル完了(attDone=true)後は
    //   **新着メールの添付を永久に拾わなくなる**バグだった(本文側 run() には元からある処理)。
    //   トリガーを何分間隔にしても、この処理が無ければ新着は入らない。
    const lastFwd = Number(props.getProperty('attForwardEpoch') || 0);
    if (lastFwd > 0) {
      const fwdThreads = GmailApp.search('has:attachment -in:draft after:' + lastFwd, 0, 50);
      saveAttachments_(fwdThreads, folder, existing, ledger, ctr);
      appendLedger_(folder, ledger); ledger = [];
    }
    props.setProperty('attForwardEpoch', String(nowEpoch_()));

    // ---- (B) バックフィル: 過去へ遡る(枠内で繰り返し) ----
    // ここは大量に処理するので、フォルダ走査を1回だけして名前集合を作った方が安い。
    if (props.getProperty('attDone') !== 'true') {
      existing = {};
      const it = folder.getFiles();
      while (it.hasNext()) existing[it.next().getName()] = true;
    }
    while (props.getProperty('attDone') !== 'true') {
      if (Date.now() - startMs > CONFIG.MAX_RUNTIME_MS) break;
      const cursor = Number(props.getProperty('attCursorEpoch') || nowEpoch_());
      if (cursor <= afterEpoch) { props.setProperty('attDone', 'true'); break; }

      const q = 'has:attachment -in:draft after:' + afterEpoch + ' before:' + cursor;
      const threads = GmailApp.search(q, 0, 25);
      if (!threads.length) { props.setProperty('attDone', 'true'); break; }

      const oldest = saveAttachments_(threads, folder, existing, ledger, ctr);
      if (oldest === null || oldest >= cursor) { props.setProperty('attDone', 'true'); break; }
      props.setProperty('attCursorEpoch', String(oldest));
      appendLedger_(folder, ledger); ledger = [];
    }
    appendLedger_(folder, ledger);
    Logger.log('attachments: saved=%s skipped=%s tooBig=%s attDone=%s cursor=%s',
               ctr.saved, ctr.skipped, ctr.tooBig, props.getProperty('attDone'),
               props.getProperty('attCursorEpoch'));
  } finally {
    lock.releaseLock();
  }
}

/** スレッド群の添付を保存する。戻り値=処理した最古メッセージの epoch秒(無ければ null)。 */
function saveAttachments_(threads, folder, existing, ledger, ctr) {
  let oldest = null;
  for (let i = 0; i < threads.length; i++) {
    const msgs = threads[i].getMessages();
    for (let j = 0; j < msgs.length; j++) {
          const m = msgs[j];
          const epoch = Math.floor(m.getDate().getTime() / 1000);
          if (oldest === null || epoch < oldest) oldest = epoch;
          let atts = [];
          try {
            atts = m.getAttachments({ includeInlineImages: CONFIG.ATT_INCLUDE_INLINE });
          } catch (e) { continue; }
          const day = Utilities.formatDate(m.getDate(), CONFIG.TZ, 'yyyy-MM-dd');
          const subj = m.getSubject() || '';
          const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic'];
          for (let k = 0; k < atts.length; k++) {
            const a = atts[k];
            const nm = a.getName() || ('attachment_' + k);
            const ext = nm.indexOf('.') >= 0 ? nm.split('.').pop().toLowerCase() : '';
            if (CONFIG.ATT_SKIP_EXT.indexOf(ext) >= 0) { ctr.skipped++; continue; }
            const size = a.getSize();
            // 署名ロゴ・favicon・QRバッジ等の小さい画像は捨てる(本文の実スクショは残る)
            if (IMG_EXT.indexOf(ext) >= 0 && size < CONFIG.ATT_MIN_IMG_BYTES) { ctr.skipped++; continue; }
            // 本人確認書類は共有ドライブにも置かない(台帳に痕跡だけ残す)
            if (CONFIG.ATT_IDENTITY_RE.test(subj) || CONFIG.ATT_IDENTITY_RE.test(nm)) {
              ledger.push([day + '_' + m.getId() + '_' + k + '_(未保存)', m.getId(),
                           m.getDate().toISOString(), m.getFrom(), subj, nm, size,
                           'skipped_identity'].join('\t'));
              ctr.skipped++; continue;
            }
            const safe = nm.replace(/[\\\/:*?"<>|]+/g, '_');
            const outName = day + '_' + m.getId() + '_' + k + '_' + safe;
            // existing が未構築(差分フェーズ)なら Drive に1件だけ問い合わせる
            if (existing ? existing[outName] : folder.getFilesByName(outName).hasNext()) {
              ctr.skipped++; continue;
            }
            if (size > CONFIG.ATT_MAX_BYTES) {
              ledger.push([outName, m.getId(), m.getDate().toISOString(), m.getFrom(),
                           m.getSubject(), nm, size, 'error:too_large'].join('\t'));
              ctr.tooBig++; continue;
            }
            folder.createFile(a.copyBlob().setName(outName));
            if (existing) existing[outName] = true;
            ledger.push([outName, m.getId(), m.getDate().toISOString(), m.getFrom(),
                         m.getSubject(), nm, size, 'ok'].join('\t'));
            ctr.saved++;
      }
    }
  }
  return oldest;
}

/** 添付の回収台帳(_index.tsv)へ追記。 */
function appendLedger_(folder, rows) {
  if (!rows.length) return;
  const name = '_index.tsv';
  const header = ['saved_name', 'msg_id', 'date', 'from', 'subject',
                  'filename', 'size', 'status'].join('\t') + '\n';
  const chunk = rows.join('\n') + '\n';
  const it = folder.getFilesByName(name);
  if (it.hasNext()) {
    const f = it.next();
    f.setContent(f.getBlob().getDataAsString('UTF-8') + chunk);
  } else {
    folder.createFile(name, header + chunk, 'text/plain');
  }
}

/** 添付収集の定期トリガー。既定は CONFIG.ATT_TRIGGER_MINUTES(=本文側と同じ10分)。
 *
 *  なぜ本文と同じ間隔でよいか(2026-07-24):
 *   ・バックフィル完了後の1回は「新着があるか Gmail を1回検索するだけ」で**数秒**。
 *     フォルダ全走査はバックフィル時のみに変えたので、回数を増やしても重くならない。
 *   ・`run()` と同じ ScriptLock を取るので**同時実行にはならず**、衝突時は次のtickへ回る。
 *   ・共有ドライブを使っている=Google Workspace なので実行時間は 6時間/日。10分間隔でも余裕。
 *  ⚠ バックフィル進行中だけは1回あたり最大5分(MAX_RUNTIME_MS)使う。埋まりきるまでは
 *    手動で数回押すか、間隔を広めにしておくのが無難。
 *
 *  引数: 分(1/5/10/15/30)。省略時は CONFIG.ATT_TRIGGER_MINUTES。
 *        例) installAttachmentTrigger(5) / 時間単位にしたいなら installAttachmentTriggerHours(1)
 */
function installAttachmentTrigger(minutes) {
  const allowed = [1, 5, 10, 15, 30];
  const m = allowed.indexOf(minutes) >= 0 ? minutes : CONFIG.ATT_TRIGGER_MINUTES;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runAttachments') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runAttachments').timeBased()
    .everyMinutes(allowed.indexOf(m) >= 0 ? m : 10).create();
  Logger.log('installed trigger: runAttachments every %s min', m);
}

/** 時間間隔で貼りたいとき(バックフィル中など)。hours: 1/2/4/6/8/12 */
function installAttachmentTriggerHours(hours) {
  const h = [1, 2, 4, 6, 8, 12].indexOf(hours) >= 0 ? hours : 1;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runAttachments') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runAttachments').timeBased().everyHours(h).create();
  Logger.log('installed trigger: runAttachments every %s hour(s)', h);
}

/** 添付バックフィルをやり直す(保存済みファイルは消さない=同名はスキップされる)。 */
function resetAttachmentState() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('attCursorEpoch');
  p.deleteProperty('attDone');
  Logger.log('attachment state reset.');
}

/** 自動収集トリガーを作る/貼り替える。間隔は CONFIG.TRIGGER_MINUTES。一度手動実行すればOK。 */
function installTrigger() {
  // 既存の run トリガーを消してから作り直す(間隔変更を反映するため)。
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  const m = CONFIG.TRIGGER_MINUTES;
  const tb = ScriptApp.newTrigger('run').timeBased();
  if (m >= 60) {
    tb.everyHours(Math.max(1, Math.round(m / 60))).create();
  } else {
    const allowed = [1, 5, 10, 15, 30];
    tb.everyMinutes(allowed.indexOf(m) >= 0 ? m : 10).create();  // 許容外の値は10分に丸め
  }
  Logger.log('installed trigger: run every %s min', m);
}

/** 自動収集トリガーを全部止める(raw データは消さない)。手動で止めたいとき用。
 *  ※ 既に貼ってあるスクリプトにこの関数が無い場合は、トリガー画面から削除すればよい。 */
function deleteTriggers() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log('deleted %s trigger(s). 自動収集を停止(raw は保持)。', n);
}

/** バックフィルをやり直したいとき用: 状態をリセット(raw ファイルは消さない)。 */
function resetState() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('lastForwardEpoch');
  p.deleteProperty('backfillCursorEpoch');
  p.deleteProperty('backfillDone');
  Logger.log('state reset. 次の run() で 今=差分基準 に再設定し、過去分を再バックフィルします。');
}
