import { addDays, jstDate, type CalendarEventInput } from '../../shared/calendar.js';
import type { CalendarStore } from './store.js';

// Demo data for the demo mode only (synthetic, marked （例）). The dates are counted from today, so the home screen
// and the month view have something to show on the first start. Written only into an empty calendar file.

const ACTOR = 'demo-seed';

export function seedCalendarDemo(store: CalendarStore, nowIso: string): void {
  if (store.count() > 0) return;
  const today = jstDate(new Date(nowIso));
  const year = today.slice(0, 4);
  const base = (over: Partial<CalendarEventInput>): CalendarEventInput => ({ title: '', kind: 'other', date: today, time: null, departments: [], memo: '', yearly: false, remindDays: [], ...over });
  const samples: CalendarEventInput[] = [
    base({ title: '（例）企画書の提出締切', kind: 'deadline', date: addDays(today, 3), departments: ['企画部'], memo: '合成データの例です。', remindDays: [14, 3] }),
    base({ title: '（例）定例ミーティング', kind: 'meeting', date: addDays(today, 1), time: '18:00' }),
    base({ title: '（例）会場の使用届（学務）', kind: 'procedure', date: addDays(today, 9), departments: ['総務部'], yearly: true, remindDays: [14, 3] }),
    base({ title: '（例）準備会の集まり', kind: 'event', date: addDays(today, 20) }),
    base({ title: '（例）備品の確認', kind: 'other', date: addDays(today, 6), departments: ['渉外部'], remindDays: [1] }),
    base({ title: '（例）年間の会場の仮予約', kind: 'deadline', date: `${year}-04-01`, departments: ['総務部'], yearly: true, remindDays: [14] }),
  ];
  for (const data of samples) store.create(data, ACTOR, nowIso);
}
