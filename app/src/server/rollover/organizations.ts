import { createHash } from 'node:crypto';
import { defaultStatus, ORG_KIND_LABELS, ORG_KINDS, ORG_LIMITS, ORG_STAGES, orgNameKey, OrgValidationError, validateOrg, type OrgInput, type OrgKind } from '../../shared/organizations.js';
import type { OrgChoiceKind, OrgPlanItem, OrgPreviewRequest, RolloverApplyResponse, RolloverUndoResponse } from '../../shared/rollover.js';
import type { OrganizationsStore, OrgRow } from '../organizations/store.js';
import type { RolloverStore, RunRow } from './store.js';

// Step 1: the organizations of one year, copied to the next year by the organizations' own store (each copy has its
// "created" history row). The year's own rows are never written. A copy starts again at the first stage of its kind
// with no amount, content, next action or committee owner; what the year had (the last stage, amount, content, owner,
// notes) goes into the copy's notes as 「前年度の実績」 and into the run's record. The contact stays linked, so the
// February greeting to last year's sponsors can go out from the same ledger.

export interface OrgPlan {
  sourceYear: number;
  targetYear: number;
  items: OrgPlanItem[];
  copies: { source: OrgRow; data: OrgInput }[];
  counts: { copy: number; skip: number; excluded: number };
  planToken: string;
}

const yen = (n: number) => `${n.toLocaleString('en-US')} 円`;

/** The statuses of one kind in the order the screen offers them: the stages in order, then the free ones by name. */
function orderedStatuses(kind: OrgKind, counts: Record<string, number>): { status: string; count: number }[] {
  const stages = ORG_STAGES[kind] ?? [];
  const rest = Object.keys(counts).filter((s) => !stages.includes(s)).sort((a, b) => a.localeCompare(b, 'ja'));
  return [...stages.filter((s) => (counts[s] ?? 0) > 0), ...rest].map((status) => ({ status, count: counts[status] ?? 0 }));
}

/** The kinds and statuses the source year has, with their counts (the choices of the screen). */
export function orgChoices(store: OrganizationsStore, sourceYear: number): OrgChoiceKind[] {
  const out: OrgChoiceKind[] = [];
  for (const kind of ORG_KINDS) {
    const counts = store.statusCounts({ kind, fiscalYear: sourceYear, terms: [] });
    if (Object.keys(counts).length === 0) continue;
    out.push({ kind, label: ORG_KIND_LABELS[kind], statuses: orderedStatuses(kind, counts) });
  }
  return out;
}

/** The 「前年度の実績」 block: what the year ended with, for whoever picks the organization up next year. */
export function previousYearNotes(data: OrgInput, ownerName: string | null): string {
  const lines = [
    `【前年度（${data.fiscalYear}年度）の実績】`,
    `最終の段階：${data.status}`,
    `金額：${data.amountYen === null ? '記入なし' : yen(data.amountYen)}`,
    `協賛の内容：${data.content || 'なし'}`,
    `委員会側：${[data.department, ownerName ? `担当 ${ownerName}` : ''].filter(Boolean).join('・') || '記入なし'}`,
    `相手の担当者：${data.contactId ? '前年度と同じ連絡先を結んでいます' : '結んでいませんでした'}`,
  ];
  if (data.notes) lines.push('前年度のメモ：', data.notes);
  const text = lines.join('\n');
  if (text.length <= ORG_LIMITS.notes) return text;
  const tail = '…（続きは前年度の団体の記録にあります）';
  return text.slice(0, ORG_LIMITS.notes - tail.length) + tail;
}

/** The copy for the next year (checked by the organizations' own rule). */
export function nextYearOrg(data: OrgInput, targetYear: number, ownerName: string | null): OrgInput {
  return validateOrg({
    ...data,
    fiscalYear: targetYear,
    ownerId: null,
    status: defaultStatus(data.kind),
    amountYen: null,
    content: '',
    nextAction: '',
    nextDue: null,
    notes: previousYearNotes(data, ownerName),
  });
}

const kindOrder = (kind: OrgKind) => ORG_KINDS.indexOf(kind);

/**
 * What a confirm would do now. Only the organizations of the chosen kinds and statuses are listed. An organization
 * whose name the next year already has is skipped (the ledger keeps one name per year), so a second pass, or a pass
 * after an interrupted one, never doubles a row. The token is the plan's fingerprint: a confirm goes ahead only when
 * the plan made again at that moment is the same.
 */
export function planOrganizations(store: OrganizationsStore, req: OrgPreviewRequest, ownerNameOf: (userId: string) => string | null): OrgPlan {
  const targetYear = req.sourceYear + 1;
  const wanted = new Map(req.selection.map((s) => [s.kind, new Set(s.statuses)]));
  const excluded = new Set(req.excludeIds);
  const rows = store
    .allOfYear(req.sourceYear)
    .filter((r) => wanted.get(r.data.kind)?.has(r.data.status))
    .sort((a, b) => kindOrder(a.data.kind) - kindOrder(b.data.kind) || a.data.name.localeCompare(b.data.name, 'ja') || a.id.localeCompare(b.id));
  const items: OrgPlanItem[] = [];
  const copies: OrgPlan['copies'] = [];
  const planned = new Set<string>();
  for (const row of rows) {
    const d = row.data;
    const base: Omit<OrgPlanItem, 'action' | 'reason'> = {
      sourceId: row.id,
      name: d.name,
      kind: d.kind,
      kindLabel: ORG_KIND_LABELS[d.kind],
      fromStatus: d.status,
      toStatus: defaultStatus(d.kind),
      amountYen: d.amountYen,
      content: d.content,
      department: d.department,
      hasContact: d.contactId !== null,
    };
    const key = orgNameKey(d.name);
    if (excluded.has(row.id)) {
      items.push({ ...base, action: 'excluded', reason: '写さないものに選びました' });
      continue;
    }
    if (store.byNameKey(targetYear, key).length > 0) {
      items.push({ ...base, action: 'skip', reason: `${targetYear}年度に同じ名前の団体があります` });
      continue;
    }
    if (planned.has(key)) {
      items.push({ ...base, action: 'skip', reason: `${req.sourceYear}年度に同じ名前の団体がもう一つあります（先の一つだけ写します）` });
      continue;
    }
    let data: OrgInput;
    try {
      data = nextYearOrg(d, targetYear, d.ownerId ? ownerNameOf(d.ownerId) : null);
    } catch (err) {
      if (!(err instanceof OrgValidationError)) throw err;
      items.push({ ...base, action: 'skip', reason: `写せない内容があります（${err.message}）` });
      continue;
    }
    planned.add(key);
    copies.push({ source: row, data });
    items.push({ ...base, action: 'copy', reason: null });
  }
  const counts = { copy: 0, skip: 0, excluded: 0 };
  for (const item of items) counts[item.action] += 1;
  const fingerprint = JSON.stringify({ step: 'organizations', year: req.sourceYear, items: items.map((i) => [i.sourceId, i.action]), versions: copies.map((c) => [c.source.id, c.source.version]) });
  return { sourceYear: req.sourceYear, targetYear, items, copies, counts, planToken: createHash('sha256').update(fingerprint).digest('base64url').slice(0, 32) };
}

/**
 * Writes the copies of a plan into a started run, one by one (the run keeps each copy as it is made). A run taken
 * over after an interruption counts the copies it made before (those still in the ledger) as made, not as skipped
 * for the name the next year now has.
 */
export function applyOrganizations(store: OrganizationsStore, rollover: RolloverStore, run: RunRow, plan: OrgPlan, actorId: string, now: string): { run: RunRow; response: Omit<RolloverApplyResponse, 'run'> } {
  const earlier = rollover.items(run.id).filter((i) => i.kind === 'organization' && i.madeId !== null && store.get(i.madeId) !== null);
  const earlierSources = new Set(earlier.map((i) => i.sourceId));
  const made: string[] = earlier.map((i) => i.name);
  const skipped: { name: string; reason: string }[] = plan.items.filter((i) => i.action === 'skip' && !earlierSources.has(i.sourceId)).map((i) => ({ name: i.name, reason: i.reason ?? '' }));
  for (const { source, data } of plan.copies) {
    // Checked again just before the write: an import or another screen may have added the name meanwhile.
    if (store.byNameKey(plan.targetYear, orgNameKey(data.name)).length > 0) {
      skipped.push({ name: data.name, reason: `${plan.targetYear}年度に同じ名前の団体があります` });
      continue;
    }
    const row = store.create(data, actorId, now, 'created');
    const d = source.data;
    rollover.addItem(run.id, {
      kind: 'organization',
      sourceId: source.id,
      madeId: row.id,
      name: data.name,
      data: { previous: { status: d.status, amountYen: d.amountYen, content: d.content, contactId: d.contactId, ownerId: d.ownerId, department: d.department } },
    });
    made.push(data.name);
  }
  const counts = { made: made.length, skipped: skipped.length, excluded: plan.counts.excluded };
  const done = rollover.finish(run.id, `団体 ${made.length} 件を ${plan.targetYear}年度に写した${skipped.length > 0 ? `（${skipped.length} 件は写さなかった）` : ''}`, counts, now);
  return { run: done, response: { made, skipped } };
}

/**
 * Takes a run back: each copy still as it was made is deleted through the store (its history keeps the deletion). A
 * copy changed since (a version above 1), or with anything in its history after its creation, is kept, and said so:
 * a mail sent to it (the February greeting) adds a history row without changing the version, and the copy stays for
 * that record and for the mail batch that points at it.
 */
export function undoOrganizations(store: OrganizationsStore, rollover: RolloverStore, run: RunRow, actorId: string, now: string): Omit<RolloverUndoResponse, 'run'> & { undo: unknown } {
  const removed: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const item of rollover.items(run.id)) {
    if (item.kind !== 'organization' || !item.madeId) continue;
    const current = store.get(item.madeId);
    if (!current) {
      kept.push({ name: item.name, reason: 'すでに削除されています' });
      continue;
    }
    if (current.version !== 1) {
      kept.push({ name: item.name, reason: '写したあとに変更があったため残しました' });
      continue;
    }
    const later = store.history(item.madeId).filter((h) => h.action !== 'created');
    if (later.length > 0) {
      const mailed = later.some((h) => h.action === 'mail_sent');
      kept.push({ name: item.name, reason: mailed ? '写したあとにメールを送った記録があるため残しました（団体の履歴に送信の記録があります）' : '写したあとの記録が団体の履歴にあるため残しました' });
      continue;
    }
    const result = store.delete(item.madeId, 1, actorId, now);
    if (result === 'deleted') removed.push(item.name);
    else kept.push({ name: item.name, reason: '取り消しの途中で変更されたため残しました' });
  }
  return { removed, kept, undo: { removed: removed.length, kept: kept.length } };
}
