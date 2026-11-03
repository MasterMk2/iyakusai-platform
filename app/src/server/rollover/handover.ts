import { CALENDAR_KIND_LABELS, dateLabel, occurrenceInYear, sortByDateTime } from '../../shared/calendar.js';
import { DECISION_STATUS_LABELS, DECISION_VENUE_LABELS } from '../../shared/decisions.js';
import { ORG_KIND_LABELS, ORG_KINDS, ORG_STAGES, type OrgKind } from '../../shared/organizations.js';
import { ROLLOVER_STEP_LABELS, yearWindow, type RolloverTasksResponse } from '../../shared/rollover.js';
import type { CalendarStore } from '../calendar/store.js';
import type { DecisionsStore } from '../decisions/store.js';
import type { OrganizationsStore } from '../organizations/store.js';
import type { RunRow } from './store.js';

// Step 5: the handover draft of one year, as Markdown (for people: the start of the handover document) and JSON (for
// a program). Both are made from the same data: no contact (the organizations keep only "linked or not"), no owner,
// creator or assignee field, no notes or memos, and every free text that goes in is scrubbed of anything that looks
// like a mail address or a phone number. A name written inside a title or a body stays (it cannot be told from other
// words), so the document says to read it before sharing. Nothing is kept on the server.

const DECISIONS_MAX = 2000;
const BODY_MAX = 300;

export const OMITTED = '（連絡先を省略）';
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const PHONE = /(?<![\d０-９])(?:[+＋]81[-\s‐－]?[(（]?[0０]?|[(（]?[0０])[\d０-９]{1,4}[)）]?[-\s‐－]?[\d０-９]{1,4}[-\s‐－]?[\d０-９]{3,4}(?![\d０-９])/g;

/** Free text without mail addresses and phone numbers (10 or 11 digits starting with 0 or +81, hyphens and spaces allowed). */
export function scrubContacts(text: string): string {
  return text.replace(EMAIL, OMITTED).replace(PHONE, (match) => {
    const digits = match.normalize('NFKC').replace(/\D/g, '').replace(/^81/, '0');
    return digits.length >= 10 && digits.length <= 11 ? OMITTED : match;
  });
}

export interface HandoverSources {
  decisions: DecisionsStore | null;
  organizations: OrganizationsStore | null;
  calendar: CalendarStore | null;
  /** The department name of a Task service key (decisions keep keys). */
  departmentLabel: (key: string) => string;
}

export interface HandoverDocument {
  format: 'iyakusai-handover';
  version: 1;
  fiscalYear: number;
  generatedAt: string;
  missing: string[];
  decisions: { title: string; body: string; decidedOn: string; venue: string; departments: string[]; status: string }[];
  organizations: { kind: string; name: string; status: string; amountYen: number | null; content: string; department: string; hasContact: boolean }[];
  events: { date: string; time: string | null; title: string; kind: string; departments: string[]; yearly: boolean }[];
  tasks: { state: RolloverTasksResponse['state']; total: number | null; byDepartment: { department: string; open: number; overdue: number }[] };
  rollover: { step: string; status: string; targetYear: number; at: string; summary: string }[];
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max).join('')}…` : text);
const clean = (text: string, max = 2000) => cut(oneLine(scrubContacts(text)), max);

/** The handover data of a year (the JSON as written; the Markdown is made from it). */
export function handoverDocument(sources: HandoverSources, year: number, tasks: RolloverTasksResponse | null, runs: RunRow[], now: string): HandoverDocument {
  const { from, to } = yearWindow(year);
  const missing: string[] = [];
  const decisions: HandoverDocument['decisions'] = [];
  if (sources.decisions) {
    const page = sources.decisions.page({ terms: [], from, to }, 'decided', DECISIONS_MAX, 0);
    const order = { active: 0, changed: 1, revoked: 2 } as const;
    for (const row of [...page.rows].sort((a, b) => order[a.status] - order[b.status] || b.input.decidedOn.localeCompare(a.input.decidedOn))) {
      decisions.push({
        title: clean(row.input.title, 100),
        body: clean(row.input.body, BODY_MAX),
        decidedOn: row.input.decidedOn,
        venue: row.input.venue === 'other' ? clean(row.input.venueOther, 40) || DECISION_VENUE_LABELS.other : DECISION_VENUE_LABELS[row.input.venue],
        departments: row.input.departments.map(sources.departmentLabel),
        status: DECISION_STATUS_LABELS[row.status],
      });
    }
  } else missing.push('決定事項の台帳がこのサーバーにないため、決定事項は入っていません。');

  const organizations: HandoverDocument['organizations'] = [];
  if (sources.organizations) {
    const kindIndex = (k: OrgKind) => ORG_KINDS.indexOf(k);
    for (const row of [...sources.organizations.allOfYear(year)].sort((a, b) => kindIndex(a.data.kind) - kindIndex(b.data.kind) || a.data.name.localeCompare(b.data.name, 'ja'))) {
      const d = row.data;
      organizations.push({ kind: ORG_KIND_LABELS[d.kind], name: clean(d.name, 100), status: d.status, amountYen: d.amountYen, content: clean(d.content, 200), department: d.department, hasContact: d.contactId !== null });
    }
  } else missing.push('団体の台帳がこのサーバーにないため、団体は入っていません。');

  const events: HandoverDocument['events'] = [];
  if (sources.calendar) {
    const listed = sources.calendar.range(from, to).map((row) => ({ row, date: row.data.date }));
    for (const row of sources.calendar.yearly()) {
      const own = Number(row.data.date.slice(0, 4));
      // The same rule as the calendar: a copy from an earlier year's rollover is not shown before its own year.
      if (own === year || (row.copiedFrom !== null && year < own)) continue;
      listed.push({ row, date: occurrenceInYear(row.data.date, year) });
    }
    const rows = sortByDateTime(listed.map(({ row, date }) => ({ date, time: row.data.time, title: row.data.title, row })));
    for (const { row, date } of rows) events.push({ date, time: row.data.time, title: clean(row.data.title, 120), kind: CALENDAR_KIND_LABELS[row.data.kind], departments: row.data.departments, yearly: row.data.yearly });
  } else missing.push('カレンダーを開けなかったため、年間の予定は入っていません。');

  let taskPart: HandoverDocument['tasks'] = { state: 'off', total: null, byDepartment: [] };
  if (tasks) {
    taskPart = { state: tasks.state, total: tasks.state === 'ok' ? tasks.total : null, byDepartment: tasks.groups.map((g) => ({ department: g.label, open: g.tasks.length, overdue: g.tasks.filter((t) => t.overdue).length })) };
    if (tasks.state !== 'ok' && tasks.message) missing.push(`未完了のタスクの件数は入っていません（${tasks.message}）`);
  } else missing.push('このサーバーではタスク機能が設定されていないため、未完了のタスクの件数は入っていません。');

  const rollover = runs
    .filter((r) => r.sourceYear === year && (r.step === 'organizations' || r.step === 'calendar'))
    .map((r) => ({ step: ROLLOVER_STEP_LABELS[r.step], status: r.status === 'done' ? '済み' : r.status === 'undone' ? '取り消した' : '途中', targetYear: r.targetYear, at: r.finishedAt ?? r.startedAt, summary: r.summary }));

  return { format: 'iyakusai-handover', version: 1, fiscalYear: year, generatedAt: now, missing, decisions, organizations, events, tasks: taskPart, rollover };
}

/** A table cell: one line, the pipe escaped. */
const cell = (text: string) => oneLine(text).replaceAll('|', '\\|') || '—';
const yen = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('en-US')} 円`);
const jstDay = (iso: string) => dateLabel(new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10));

export function handoverMarkdown(doc: HandoverDocument): string {
  const out: string[] = [];
  const y = doc.fiscalYear;
  out.push(`# ${y}年度の引き継ぎ（下書き）`, '');
  out.push(`- 作成：${jstDay(doc.generatedAt)}（委員会アプリの「年度の切り替え」で書き出したもの）`);
  out.push('- 下書きです。読んで直し、足りないこと（各場所と各仕事のやり方、来年への注意）を書き足してから使ってください。');
  out.push('- 担当者・作った人・メモの欄と、団体の連絡先は入れていません。本文や内容にあったメールアドレスと電話番号も伏せています。決定事項・団体・予定の題名や本文に書かれた名前は残るので、共有する前に読んで確かめてください。');
  for (const m of doc.missing) out.push(`- ${m}`);
  out.push('');

  out.push(`## 1. 決定事項（${doc.decisions.length} 件）`, '');
  if (doc.decisions.length === 0) out.push('この年に決めた日の決定事項はありません。', '');
  for (const status of ['有効', '変更された', '取り消し']) {
    const list = doc.decisions.filter((d) => d.status === status);
    if (list.length === 0) continue;
    out.push(`### ${status}（${list.length} 件）`, '');
    for (const d of list) {
      out.push(`- ${d.decidedOn} ${d.venue}：${d.title}${d.departments.length > 0 ? `（${d.departments.join('・')}）` : ''}`);
      if (d.body) out.push(`  - ${d.body}`);
    }
    out.push('');
  }

  out.push(`## 2. 団体（${doc.organizations.length} 件）`, '');
  if (doc.organizations.length === 0) out.push('この年度の団体はありません。', '');
  for (const kind of ORG_KINDS) {
    const label = ORG_KIND_LABELS[kind];
    const list = doc.organizations.filter((o) => o.kind === label);
    if (list.length === 0) continue;
    const counts = new Map<string, number>();
    for (const o of list) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
    const stages = ORG_STAGES[kind] ?? [];
    const order = [...counts.keys()].sort((a, b) => (stages.indexOf(a) + 1 || 99) - (stages.indexOf(b) + 1 || 99) || a.localeCompare(b, 'ja'));
    out.push(`### ${label}（${list.length} 件）`, '', `最終の段階：${order.map((s) => `${s} ${counts.get(s)} 件`).join('・')}`, '');
    out.push('| 団体名 | 最終の段階 | 金額 | 内容 | 委員会側の部局 | 相手の担当者 |', '|---|---|---:|---|---|---|');
    for (const o of list) out.push(`| ${cell(o.name)} | ${cell(o.status)} | ${yen(o.amountYen)} | ${cell(o.content)} | ${cell(o.department)} | ${o.hasContact ? '連絡先に登録あり' : '—'} |`);
    out.push('');
  }

  out.push(`## 3. 年間の予定（${doc.events.length} 件）`, '');
  if (doc.events.length === 0) out.push('この年の予定はありません。', '');
  else {
    out.push('「毎年」の予定は、次の年度へ写す対象です。', '', '| 日付 | 時刻 | 題名 | 種類 | 部局 | 毎年 |', '|---|---|---|---|---|---|');
    for (const e of doc.events) out.push(`| ${e.date} | ${e.time ?? '終日'} | ${cell(e.title)} | ${e.kind} | ${cell(e.departments.join('・'))} | ${e.yearly ? '毎年' : ''} |`);
    out.push('');
  }

  out.push('## 4. 未完了のタスク', '');
  if (doc.tasks.total === null) out.push('件数を読めませんでした（上の注記を見てください）。', '');
  else {
    out.push(`未完了は ${doc.tasks.total} 件です（部局が二つあるタスクは両方に数えています）。持ち越すかどうかは、設定の「年度の切り替え」から書き出す CSV で決めてください。`, '');
    if (doc.tasks.byDepartment.length > 0) {
      out.push('| 部局 | 未完了 | うち期限超過 |', '|---|---:|---:|');
      for (const d of doc.tasks.byDepartment) out.push(`| ${cell(d.department)} | ${d.open} | ${d.overdue} |`);
      out.push('');
    }
  }

  out.push('## 5. 次の年度への切り替え', '');
  if (doc.rollover.length === 0) out.push('団体の台帳と毎年の予定は、まだ次の年度へ写していません。', '');
  for (const r of doc.rollover) out.push(`- ${r.step}（${r.targetYear}年度へ）：${r.status}・${jstDay(r.at)}・${r.summary}`);
  out.push('');
  return out.join('\n');
}
