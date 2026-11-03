import { createHash } from 'node:crypto';
import { CALENDAR_KIND_LABELS, CALENDAR_LIMITS, dateLabel, validateCalendarEvent, type CalendarEventInput } from '../../shared/calendar.js';
import { DATE_CHECK_MARK, shiftByRule, weekdayOfMonthLabel, yearWindow, type CalendarPlanItem, type CalendarPreviewRequest, type DateRule, type RolloverApplyResponse, type RolloverUndoResponse } from '../../shared/rollover.js';
import type { CalendarEventRow, CalendarStore } from '../calendar/store.js';
import type { RolloverStore, RunItem, RunRow } from './store.js';

// Step 2: the yearly schedule (毎年) of one year, copied to the next year by the calendar's own store. The copy keeps
// the title, kind, time, departments and reminders, takes the 毎年 mark over from the original, records where it came
// from (copiedFrom) and starts its memo with 「前年から写した・日付を確かめる」. The original keeps its date, title,
// departments and memo; only its 毎年 mark goes to the copy (one history row), so the year shows it once and the next
// year shows the copy once. An undo puts the mark back.
//
// Only yearly events stored in the source year are copied. One stored in an earlier year already shows in every later
// year by itself; moving its mark would take it away from the source year, so it is listed and left alone.

export interface CalendarPlan {
  sourceYear: number;
  targetYear: number;
  items: CalendarPlanItem[];
  copies: { source: CalendarEventRow; toDate: string; rule: DateRule; flipOnly: boolean }[];
  counts: { copy: number; skip: number; excluded: number };
  planToken: string;
}

/** The memo of a copy: the mark and the original date first, then the original memo (cut to the calendar's limit). */
export function markedMemo(memo: string, fromDate: string): string {
  const head = `${DATE_CHECK_MARK}元の日付は${dateLabel(fromDate)}。日付を確かめたら、この行を消してください。`;
  const text = memo ? `${head}\n${memo}` : head;
  const chars = [...text];
  return chars.length <= CALENDAR_LIMITS.memoMax ? text : chars.slice(0, CALENDAR_LIMITS.memoMax).join('');
}

export function planCalendar(store: CalendarStore, req: CalendarPreviewRequest, today: string): CalendarPlan {
  const targetYear = req.sourceYear + 1;
  const source = yearWindow(req.sourceYear);
  const target = yearWindow(targetYear);
  const weekday = new Set(req.weekdayIds);
  const skip = new Set(req.skipIds);
  const inTarget = store.range(target.from, target.to);
  const items: CalendarPlanItem[] = [];
  const copies: CalendarPlan['copies'] = [];
  for (const row of store.yearly()) {
    const d = row.data;
    if (d.date > source.to) continue;
    const rule: DateRule = weekday.has(row.id) ? 'same-weekday' : 'same-date';
    const toDate = shiftByRule(d.date, targetYear, rule);
    const base = { eventId: row.id, title: d.title, kindLabel: CALENDAR_KIND_LABELS[d.kind], departments: d.departments, fromDate: d.date, toDate, rule, weekdayLabel: weekdayOfMonthLabel(d.date) };
    const notes: string[] = [];
    if (rule === 'same-date' && d.date.slice(5) === '02-29' && toDate.slice(5) === '02-28') notes.push('2月29日は、この年にないので2月28日にしました');
    if (toDate < today) notes.push('この日付はもう過ぎています');
    if (d.date < source.from) {
      items.push({ ...base, toDate: d.date, action: 'skip', reason: `${d.date.slice(0, 4)}年に登録した毎年の予定で、${targetYear}年にもそのまま表示されます（写さなくても出ます）`, notes: [] });
      continue;
    }
    if (skip.has(row.id)) {
      items.push({ ...base, action: 'excluded', reason: '写さないものに選びました', notes });
      continue;
    }
    const copied = inTarget.find((e) => e.copiedFrom === row.id);
    if (copied) {
      // A copy from an interrupted run: only the 毎年 mark is still to move, else the next year shows it twice.
      notes.push('写した予定は前回の実行でできています。元の予定の「毎年」の印だけを移します');
      copies.push({ source: row, toDate: copied.data.date, rule, flipOnly: true });
      items.push({ ...base, toDate: copied.data.date, action: 'copy', reason: null, notes });
      continue;
    }
    if (inTarget.some((e) => e.data.date === toDate && e.data.title === d.title)) {
      items.push({ ...base, action: 'skip', reason: '写す先の日に同じ題名の予定があります', notes });
      continue;
    }
    copies.push({ source: row, toDate, rule, flipOnly: false });
    items.push({ ...base, action: 'copy', reason: null, notes });
  }
  const counts = { copy: 0, skip: 0, excluded: 0 };
  for (const item of items) counts[item.action] += 1;
  const fingerprint = JSON.stringify({ step: 'calendar', year: req.sourceYear, items: items.map((i) => [i.eventId, i.action, i.toDate]), versions: copies.map((c) => [c.source.id, c.source.version]) });
  return { sourceYear: req.sourceYear, targetYear, items, copies, counts, planToken: createHash('sha256').update(fingerprint).digest('base64url').slice(0, 32) };
}

/**
 * The last record of each original in a run (a run taken over after an interruption may record an original twice:
 * once when its mark could not move, once when it did), with the copy's ID from any of them.
 */
function lastItems(rollover: RolloverStore, runId: string): RunItem[] {
  const bySource = new Map<string, RunItem>();
  for (const item of rollover.items(runId)) {
    if (item.kind !== 'event' || !item.sourceId) continue;
    const before = bySource.get(item.sourceId);
    bySource.set(item.sourceId, { ...item, madeId: item.madeId ?? before?.madeId ?? null });
  }
  return [...bySource.values()];
}

/** The copy of a run's item: by its ID, or (a copy made before an interruption) by where it came from. */
function copyOf(store: CalendarStore, item: RunItem, targetYear: number): CalendarEventRow | null {
  if (item.madeId) return store.get(item.madeId);
  const target = yearWindow(targetYear);
  return store.range(target.from, target.to).find((e) => e.copiedFrom === item.sourceId) ?? null;
}

/**
 * Copies first, then moves the 毎年 mark, one event at a time (the run keeps each as it is done). A run taken over
 * after an interruption counts the events it finished before as made: their originals are no longer 毎年, so the
 * plan does not list them again.
 */
export function applyCalendar(store: CalendarStore, rollover: RolloverStore, run: RunRow, plan: CalendarPlan, actorId: string, now: string): { run: RunRow; response: Omit<RolloverApplyResponse, 'run'> } {
  const made: string[] = lastItems(rollover, run.id)
    .filter((i) => typeof i.data.sourceVersionAfter === 'number' && copyOf(store, i, plan.targetYear) !== null)
    .map((i) => i.name);
  const skipped: { name: string; reason: string }[] = plan.items.filter((i) => i.action === 'skip').map((i) => ({ name: i.title, reason: i.reason ?? '' }));
  for (const copy of plan.copies) {
    const original = store.get(copy.source.id);
    if (!original || !original.data.yearly) {
      skipped.push({ name: copy.source.data.title, reason: '下見のあとに、元の予定が削除されたか「毎年」が外されました' });
      continue;
    }
    let madeId: string | null = null;
    if (!copy.flipOnly) {
      const data: CalendarEventInput = validateCalendarEvent({ ...original.data, date: copy.toDate, memo: markedMemo(original.data.memo, original.data.date), yearly: true });
      madeId = store.create(data, actorId, now, original.id).id;
    }
    const flipped = store.update(original.id, original.version, { ...original.data, yearly: false }, actorId, now);
    const versionAfter = flipped !== null && flipped !== 'conflict' ? flipped.version : null;
    rollover.addItem(run.id, { kind: 'event', sourceId: original.id, madeId, name: original.data.title, data: { fromDate: original.data.date, toDate: copy.toDate, rule: copy.rule, flipOnly: copy.flipOnly, sourceVersionAfter: versionAfter } });
    if (versionAfter === null) skipped.push({ name: original.data.title, reason: '元の予定の「毎年」を外せませんでした（ほかの人が同時に変更しました）。カレンダーで確かめてください' });
    else made.push(original.data.title);
  }
  const counts = { made: made.length, skipped: skipped.length, excluded: plan.counts.excluded };
  const done = rollover.finish(run.id, `毎年の予定 ${made.length} 件を ${plan.targetYear}年に写した${skipped.length > 0 ? `（${skipped.length} 件は写さなかった）` : ''}`, counts, now);
  return { run: done, response: { made, skipped } };
}

/**
 * Takes a run back. Everything is decided before the copy is deleted, so the event never drops out of the later
 * years: a copy is deleted only when it is as it was made and either its original can get the 毎年 mark back
 * (unchanged since the mark moved) or already has it again. A copy changed since, or whose original was changed or
 * deleted since, is kept with the mark. Each event is listed once, as removed or as kept.
 */
export function undoCalendar(store: CalendarStore, rollover: RolloverStore, run: RunRow, actorId: string, now: string): Omit<RolloverUndoResponse, 'run'> & { undo: unknown } {
  const removed: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const item of lastItems(rollover, run.id)) {
    const copy = copyOf(store, item, run.targetYear);
    if (!copy) {
      kept.push({ name: item.name, reason: '写した予定はすでに削除されています（元の予定の「毎年」は戻していません）' });
      continue;
    }
    if (copy.version !== 1) {
      kept.push({ name: item.name, reason: '写した予定に変更があったため残しました（「毎年」は写した予定のままです）' });
      continue;
    }
    const original = store.get(item.sourceId!);
    const versionAfter = typeof item.data.sourceVersionAfter === 'number' ? item.data.sourceVersionAfter : null;
    const markedAgain = original !== null && original.data.yearly;
    const restorable = original !== null && !original.data.yearly && versionAfter !== null && original.version === versionAfter;
    if (!markedAgain && !restorable) {
      kept.push({ name: item.name, reason: `元の予定が写したあとに${original ? '変更' : '削除'}されていたため、写した予定を残しました（「毎年」は写した予定のままです）。カレンダーで確かめてください` });
      continue;
    }
    if (store.delete(copy.id, 1, actorId, now) !== 'deleted') {
      kept.push({ name: item.name, reason: '取り消しの途中で写した予定が変更されたため残しました' });
      continue;
    }
    if (restorable) {
      const back = store.update(original.id, original.version, { ...original.data, yearly: true }, actorId, now);
      if (back === null || back === 'conflict') {
        kept.push({ name: item.name, reason: '写した予定は消しましたが、元の予定の「毎年」を戻せませんでした。カレンダーで元の予定に「毎年」を付けてください' });
        continue;
      }
    }
    removed.push(item.name);
  }
  return { removed, kept, undo: { removed: removed.length, kept: kept.length } };
}
