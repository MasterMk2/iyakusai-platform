// With extensions, so that the unit tests (Node's module resolution) can import this file too.
import type { TaskMember, TaskView } from '../../../shared/tasks.js';
import { addDays } from '../../../task-service/shared/dates.js';

// The people view (人ごと, 2026-11-03): who holds which open tasks, from the list already loaded and the
// committee's roster. It sends nothing to the Task service. A completed task is never counted.

/**
 * The guide for "手が空いていそう": an active editor or officer whose open main assignments across the whole
 * committee are this many or fewer. It only suggests; the screen never says a person is free.
 */
export const FREE_LEAD_LIMIT = 1;

export type PeopleSort = 'load-desc' | 'load-asc' | 'name';
export const PEOPLE_SORT_LABELS: Record<PeopleSort, string> = { 'load-desc': '持ちが多い順', 'load-asc': '持ちが少ない順', name: '名前順' };

export interface PersonLoad {
  id: string;
  name: string;
  /** Still an active member. A former member who keeps open tasks is listed, not active. */
  active: boolean;
  /** Open tasks as the main assignee (主担当). */
  lead: number;
  /** Open tasks as a helper (副担当). */
  helper: number;
  /** lead + helper: "持ち", the sort key. */
  load: number;
  inProgress: number;
  blocked: number;
  overdue: number;
  /** Due within seven days from today, not overdue (the list's "7日以内" rule). */
  week: number;
  /** Shown as "手が空いていそう": see FREE_LEAD_LIMIT. Never for a viewer or a former member. */
  free: boolean;
}

const isOpen = (t: TaskView): boolean => t.status !== 'done';
const helperIdsOf = (t: TaskView): string[] => t.helperIds ?? [];

/** The people with their counts. `scoped` is the list the view shows (the chosen departments); `whole` is every loaded task, used only for the guide. */
export function personLoads(scoped: TaskView[], roster: TaskMember[], today: string, whole: TaskView[] = scoped): PersonLoad[] {
  const roles = new Map(roster.map((m) => [m.userId, m.role]));
  const leadAcrossCommittee = new Map<string, number>();
  for (const t of whole) {
    if (isOpen(t) && t.assigneeId !== null) leadAcrossCommittee.set(t.assigneeId, (leadAcrossCommittee.get(t.assigneeId) ?? 0) + 1);
  }
  const rows = new Map<string, PersonLoad>();
  const row = (id: string, name: string | undefined, active: boolean): PersonLoad => {
    const existing = rows.get(id);
    if (existing) return existing;
    const created: PersonLoad = { id, name: name || '（名前なし）', active, lead: 0, helper: 0, load: 0, inProgress: 0, blocked: 0, overdue: 0, week: 0, free: false };
    rows.set(id, created);
    return created;
  };
  // The roster lists every active member, so someone with no task yet is shown with zero counts.
  for (const m of roster) if (m.active) row(m.userId, m.displayName, true);
  const weekEnd = addDays(today, 7);
  const count = (r: PersonLoad, t: TaskView) => {
    r.load++;
    if (t.status === 'in_progress') r.inProgress++;
    if (t.status === 'blocked') r.blocked++;
    if (t.deadline !== null && t.deadline < today) r.overdue++;
    else if (t.deadline !== null && t.deadline >= today && t.deadline <= weekEnd) r.week++;
  };
  for (const t of scoped) {
    if (!isOpen(t)) continue;
    if (t.assigneeId !== null) {
      const r = row(t.assigneeId, t.assignee?.displayName, t.assignee?.active ?? true);
      r.lead++;
      count(r, t);
    }
    for (const id of helperIdsOf(t)) {
      const helper = t.helpers?.find((h) => h.id === id);
      const r = row(id, helper?.displayName, helper?.active ?? true);
      r.helper++;
      count(r, t);
    }
  }
  for (const r of rows.values()) {
    const role = roles.get(r.id);
    r.free = r.active && role !== undefined && role !== 'viewer' && (leadAcrossCommittee.get(r.id) ?? 0) <= FREE_LEAD_LIMIT;
  }
  return [...rows.values()];
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ja');

export function sortPeople(people: PersonLoad[], sort: PeopleSort): PersonLoad[] {
  if (sort === 'name') return [...people].sort(byName);
  const direction = sort === 'load-desc' ? -1 : 1;
  return [...people].sort((a, b) => direction * (a.load - b.load) || byName(a, b));
}

/** Earliest deadline first; no deadline last; then by ID so the order is stable. */
export function byDue(a: TaskView, b: TaskView): number {
  if (a.deadline === b.deadline) return a.id.localeCompare(b.id, 'en');
  if (a.deadline === null) return 1;
  if (b.deadline === null) return -1;
  return a.deadline.localeCompare(b.deadline);
}

/** Open tasks with no main assignee, earliest deadline first. */
export function unassignedTasks(scoped: TaskView[]): TaskView[] {
  return scoped.filter((t) => isOpen(t) && t.assigneeId === null).sort(byDue);
}

/** One person's open tasks, split into the main ones and the ones they help with, each earliest deadline first. */
export function personTasks(scoped: TaskView[], personId: string): { lead: TaskView[]; helper: TaskView[] } {
  const open = scoped.filter(isOpen);
  return {
    lead: open.filter((t) => t.assigneeId === personId).sort(byDue),
    helper: open.filter((t) => t.assigneeId !== personId && helperIdsOf(t).includes(personId)).sort(byDue),
  };
}

/**
 * What the people list shows: nothing while the roster is not known yet (it is loading or has failed), so no empty
 * note is said for a roster that has not arrived. Otherwise the empty note when no one is listed, else the rows.
 */
export function peopleListState(rosterKnown: boolean, rows: number): 'unknown' | 'empty' | 'rows' {
  if (!rosterKnown) return 'unknown';
  return rows === 0 ? 'empty' : 'rows';
}
