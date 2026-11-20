import { addDays, jstDate } from '../../shared/calendar.js';
import { jstMidnight, normalizeCalendarId } from '../../shared/availability.js';
import { ConfigError } from '../auth.js';
import { loadAvailabilityConfig } from '../availability/config.js';
import { FreeBusyError, GoogleFreeBusy } from '../availability/google.js';

// One free/busy query by hand (2026-11-20), to see that the service account, the Calendar API and a member's sharing
// work before anyone connects on the screen. Run inside the app's container:
//
//   node dist/server/ops/availability-check.js <calendar ID>
//
// It reads availability.json next to SMM_MAIL_CONFIG, asks Google for the next 7 days of that calendar, and prints
// the outcome and how many busy periods came back: never their times, and never anything of Google's answer body.

async function main(): Promise<number> {
  const mailConfig = process.env.SMM_MAIL_CONFIG;
  if (!mailConfig) {
    console.error('SMM_MAIL_CONFIG（受信箱の設定ファイル）がありません。アプリのコンテナの中で実行してください。');
    return 2;
  }
  let calendarId: string;
  try {
    calendarId = normalizeCalendarId(process.argv[2]);
  } catch {
    console.error('使い方: node dist/server/ops/availability-check.js <カレンダー ID（Gmail のアドレスなど）>');
    return 2;
  }
  let config;
  try {
    config = loadAvailabilityConfig(mailConfig);
  } catch (err) {
    console.error(`availability.json を使えません: ${err instanceof ConfigError ? err.message : 'error'}`);
    return 2;
  }
  if (!config) {
    console.error('availability.json がありません（空き具合は無効）。');
    return 2;
  }
  const today = jstDate(new Date());
  const client = new GoogleFreeBusy(config.key);
  try {
    const answer = (await client.query([calendarId], jstMidnight(today), jstMidnight(addDays(today, 7)))).get(calendarId);
    console.log(`サービスアカウント: ${config.key.clientEmail}`);
    if (answer?.kind === 'ok') console.log(`読めました。今日から 7 日の「予定あり」は ${answer.busy.length} 件です（時刻は出しません）。`);
    else if (answer?.kind === 'not_shared') console.log('Google の答え: このカレンダーはサービスアカウントに共有されていません。');
    else console.log('Google の答え: このカレンダーについてエラーが返りました。');
    return answer?.kind === 'ok' ? 0 : 1;
  } catch (err) {
    const kind = err instanceof FreeBusyError ? err.failure : 'error';
    const why: Record<string, string> = {
      credential: '鍵で署名できませんでした（鍵のファイルを確かめてください）',
      token: 'Google が鍵を受け付けませんでした（鍵が無効か削除されています）',
      forbidden: '拒否されました（プロジェクトで Google Calendar API が有効か確かめてください）',
      rate_limited: '回数の上限です（しばらく待ってください）',
      server: 'Google 側のエラーです',
      network: 'Google に接続できませんでした（外への通信を確かめてください）',
      timeout: 'Google の応答が時間内にありませんでした',
      invalid: 'Google の応答が想定と違いました',
    };
    console.error(`失敗: ${kind}（${why[kind] ?? '不明'}）`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error('確かめられませんでした。');
    process.exitCode = 1;
  },
);
