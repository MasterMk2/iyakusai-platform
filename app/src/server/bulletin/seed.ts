import { addDays, jstDate } from '../../shared/calendar.js';
import type { BulletinStore } from './store.js';

// Synthetic notices for the demo (SMM_AUTH_MODE=demo): every name, date and place is made up. The writer has read
// them; every other persona sees the ones on the board as new.

/** Fills an empty board with a few demo notices: two on the board (one 重要), one for later, one ended. Does nothing otherwise. */
export function seedBulletinDemo(store: BulletinStore, actorId: string, at: string): void {
  if (store.count() > 0) return;
  const today = jstDate(new Date(at));
  store.create(
    { title: '次回の定例ミーティングは会議室Bに変わります', body: '合成データです。\nいつもの部屋が使えないため、次回だけ会議室Bで行います。開始時刻は変わりません。', important: true, departments: [], startsOn: null, endsOn: addDays(today, 7) },
    actorId,
    at,
    null,
  );
  store.create(
    { title: '備品の棚を整理しました', body: '合成データです。\n延長コードと養生テープは、入口側の棚の 2 段目に移しました。', important: false, departments: [], startsOn: null, endsOn: addDays(today, 14) },
    actorId,
    at,
    null,
  );
  store.create(
    { title: '活動報告の提出について（来週から掲載）', body: '合成データです。\n提出の様式は追って共有します。', important: false, departments: [], startsOn: addDays(today, 5), endsOn: addDays(today, 30) },
    actorId,
    at,
    null,
  );
  store.create(
    { title: '先月の清掃当番のお礼', body: '合成データです。\nご協力ありがとうございました。', important: false, departments: [], startsOn: addDays(today, -30), endsOn: addDays(today, -3) },
    actorId,
    at,
    null,
  );
}
