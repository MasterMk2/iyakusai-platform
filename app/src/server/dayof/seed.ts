import { addDays, jstDate } from '../../shared/calendar.js';
import { DAYOF_VENUE_NAME, jstDayStartIso } from '../../shared/dayof.js';
import type { DecisionsStore } from '../decisions/store.js';
import type { DayOfStore } from './store.js';

// Synthetic festival-day board for the demo (SMM_AUTH_MODE=demo): the period starts today (Japan time) so the home
// panel can be tried at once, with a notice of each level, one resolved, and one decision on the spot in the register.
// Every name and place is made up. The demo persona u-editor-a is a poster besides the administrator.

export const DAYOF_DEMO_POSTER = 'u-editor-a';

const RULES = [
  '安全（けが・急病・迷子・避難）に関わることは本部長が決める（合成データ）',
  '物品の貸出・返却の例外は物品課が決める',
  '時間割・会場の変更は企画課と本部長で決め、本部から全員に流す',
  '迷ったら本部に連絡し、決めたことは本部が「その場で決めたこと」に残す',
].join('\n');

/**
 * Fills an empty board once. A demo board whose period is over (the demo folder was kept for days) gets its period
 * moved to start today, the same length, and the synthetic notices again (the board leaves out the notices of an
 * earlier period), so the panel can still be tried; a period set in the future is left alone.
 */
export function seedDayOfDemo(store: DayOfStore, decisions: DecisionsStore | null, adminId: string, now: string): void {
  const today = jstDate(new Date(now));
  const current = store.settings();
  if (store.count() > 0 || current.version > 1) {
    if (current.startDate && current.endDate && current.endDate < today) {
      const length = Math.round((Date.parse(current.endDate) - Date.parse(current.startDate)) / 86_400_000);
      store.saveSettings({ startDate: today, endDate: addDays(today, length), rules: current.rules }, current.version, adminId, now);
      seedNotices(store, decisions, adminId, now, today);
    }
    return;
  }
  store.saveSettings({ startDate: today, endDate: addDays(today, 1), rules: RULES }, 1, adminId, now);
  store.setPosterGrant('user', DAYOF_DEMO_POSTER, true, adminId, now);
  seedNotices(store, decisions, adminId, now, today);
}

function seedNotices(store: DayOfStore, decisions: DecisionsStore | null, adminId: string, now: string, today: string): void {
  // Never before 00:00 JST of today, the period's first day: the board shows only the notices written in the period.
  const dayStart = Date.parse(jstDayStartIso(today));
  const minutesAgo = (m: number) => new Date(Math.max(Date.parse(now) - m * 60_000, dayStart)).toISOString();
  store.create({ body: '正門前のテントは強風のため 14 時から 15 時まで畳みます（合成データ）', priority: 'urgent', place: '正門', departments: [], staffVisible: true }, adminId, minutesAgo(5), null);
  store.create({ body: '模擬店の売上の回収は 16 時に本部で行います。各団体の代表に伝えてください。', priority: 'important', place: '本部テント', departments: [], staffVisible: false }, adminId, minutesAgo(40), null);
  store.create({ body: '延長コードの追加の貸出は物品の窓口へ。在庫は残り少なめです。', priority: 'normal', place: '物品の窓口', departments: [], staffVisible: true }, DAYOF_DEMO_POSTER, minutesAgo(70), null);
  const lost = store.create({ body: '体育館の入口に落とし物（青い傘）が届いています。', priority: 'normal', place: '体育館', departments: [], staffVisible: true }, DAYOF_DEMO_POSTER, minutesAgo(120), null).row;
  store.changeStatus(lost.id, 'resolve', lost.version, adminId, minutesAgo(20));

  if (decisions) {
    decisions.create(
      {
        title: '雨天のため 13 時の屋外ステージは体育館に移す（合成データ）',
        body: '関係する場所・人：屋外ステージ・体育館',
        departments: ['planning'],
        decidedOn: today,
        venue: 'other',
        venueOther: DAYOF_VENUE_NAME,
        sources: [{ kind: 'manual', refId: null, label: `当日の画面（${DAYOF_VENUE_NAME}）`, link: '#/home' }],
        taskIds: [],
      },
      adminId,
      minutesAgo(30),
      null,
    );
  }
}
