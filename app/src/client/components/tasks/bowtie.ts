// With extensions, so that the unit tests (Node's module resolution) can import this file too.
import type { Department, TaskView } from '../../../shared/tasks.js';
import { NO_DEPARTMENT, shownPlaces } from './tree.js';

// The connections view (2026-10-28): the departments on the left, the tasks themselves in the middle and
// their projects (parent tasks) on the right, a line from each department to its tasks and from each
// task to its project, so the picture narrows at both ends. Built from the rows already filtered and
// sorted, like the tree; every position is in px from the top of the picture.

export interface BowtieSizes {
  /** The middle rows' pitch (a row is this less `gap` high). */
  row: number;
  /** A department's and a project's height. */
  department: number;
  parent: number;
  /** Room kept between two nodes of a side, and between two departments' blocks of rows. */
  gap: number;
  block: number;
}

export interface BowtieDepartment {
  key: string;
  label: string;
  /** The shown part this section is drawn under, or null. */
  part: string | null;
  /** The tasks linked to it (for a part, with its shown sections' too), each once. */
  count: number;
  top: number;
}

export interface BowtieTask {
  task: TaskView;
  /** The departments linked to it (where the tree puts it). */
  departments: string[];
  /** Its project when that is on the right. */
  parentId: string | null;
  top: number;
}

export interface BowtieParent {
  task: TaskView;
  /** False when the project is shown only for its children (it is left out by the filters). */
  matches: boolean;
  top: number;
}

export interface BowtieLayout {
  departments: BowtieDepartment[];
  tasks: BowtieTask[];
  parents: BowtieParent[];
  height: number;
}

/**
 * Where everything goes. A project with children among the rows is on the right (dimmed when it does
 * not match itself); every other row is in the middle, grouped by its first department and then by its
 * project, otherwise in the list's order. A department sits level with its block of rows and a project
 * with its children, each side pushed down only as far as needed to keep its nodes apart.
 */
export function bowtieLayout(rows: TaskView[], byId: Map<string, TaskView>, departments: Department[], shown: Set<string>, sizes: BowtieSizes): BowtieLayout {
  // The left side's order: as in the tree, each shown part followed by its shown sections.
  const order: { key: string; label: string; part: string | null }[] = [];
  for (const d of departments) {
    if (!shown.has(d.key) || (d.parent && shown.has(d.parent))) continue;
    order.push({ key: d.key, label: d.label, part: null });
    for (const s of departments) if (s.parent === d.key && shown.has(s.key)) order.push({ key: s.key, label: s.label, part: d.key });
  }
  order.push({ key: NO_DEPARTMENT, label: '部局なし', part: null });
  const rank = new Map(order.map((d, i) => [d.key, i]));

  const listed = new Set(rows.map((t) => t.id));
  const projects = new Map<string, TaskView>();
  for (const t of rows) {
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    if (parent) projects.set(parent.id, parent);
  }
  const middle = rows
    .filter((t) => !projects.has(t.id))
    .map((task, index) => {
      const keys = shownPlaces(task, byId, departments, shown).sort((a, b) => rank.get(a)! - rank.get(b)!);
      return { task, departments: keys, parentId: task.parentId && projects.has(task.parentId) ? task.parentId : null, index, first: rank.get(keys[0]!)! };
    });
  // A project's children in one department stay together, where the first of them is.
  const anchor = new Map<string, number>();
  for (const m of middle) if (m.parentId && !anchor.has(`${m.first}:${m.parentId}`)) anchor.set(`${m.first}:${m.parentId}`, m.index);
  const at = (m: (typeof middle)[number]) => (m.parentId ? anchor.get(`${m.first}:${m.parentId}`)! : m.index);
  middle.sort((a, b) => a.first - b.first || at(a) - at(b) || a.index - b.index);

  const tasks: BowtieTask[] = [];
  let y = 0;
  for (const [i, m] of middle.entries()) {
    if (i > 0 && m.first !== middle[i - 1]!.first) y += sizes.block;
    tasks.push({ task: m.task, departments: m.departments, parentId: m.parentId, top: y });
    y += sizes.row;
  }
  const rowHeight = sizes.row - sizes.gap;
  const centre = (t: BowtieTask) => t.top + rowHeight / 2;
  const mean = (list: BowtieTask[]) => list.reduce((sum, t) => sum + centre(t), 0) / list.length;

  // Left: a department level with its own block (or with all its rows, when each is first elsewhere); a
  // part without rows of its own just above its first section.
  const linked = (key: string) => tasks.filter((t) => t.departments.includes(key));
  const wanted = new Map<string, number>();
  for (const d of order) {
    const own = linked(d.key);
    if (own.length === 0) continue;
    const block = own.filter((t) => t.departments[0] === d.key);
    wanted.set(d.key, mean(block.length > 0 ? block : own) - sizes.department / 2);
  }
  const left: BowtieDepartment[] = [];
  let bottom = -sizes.gap;
  for (const d of order) {
    const sections = order.filter((s) => s.part === d.key && wanted.has(s.key));
    if (!wanted.has(d.key) && sections.length === 0) continue;
    const want = wanted.get(d.key) ?? wanted.get(sections[0]!.key)! - sizes.department - sizes.gap;
    const top = Math.max(want, bottom + sizes.gap, 0);
    const ids = new Set([d, ...sections].flatMap((s) => linked(s.key).map((t) => t.task.id)));
    left.push({ key: d.key, label: d.label, part: d.part, count: ids.size, top });
    bottom = top + sizes.department;
  }

  // Right: each project level with its children, in that order.
  const right = [...projects.values()]
    .map((task) => {
      const kids = tasks.filter((t) => t.parentId === task.id);
      return { task, matches: listed.has(task.id), want: mean(kids) - sizes.parent / 2, first: tasks.indexOf(kids[0]!) };
    })
    .sort((a, b) => a.want - b.want || a.first - b.first);
  const parents: BowtieParent[] = [];
  let edge = -sizes.gap;
  for (const p of right) {
    const top = Math.max(p.want, edge + sizes.gap, 0);
    parents.push({ task: p.task, matches: p.matches, top });
    edge = top + sizes.parent;
  }

  const height = Math.max(tasks.length > 0 ? tasks[tasks.length - 1]!.top + rowHeight : 0, bottom, edge, 0);
  return { departments: left, tasks, parents, height };
}

/** A link's key: department then task on the left, task then project on the right. */
export const linkKey = (from: string, to: string): string => `${from}>${to}`;

export type BowtieFocus = { department: string } | { task: string };

/**
 * What to bring forward for a department (its tasks and their projects; a part with its sections') or a
 * task (its departments and project; a project with its children and theirs). Keys are `d:`, `t:` and
 * `p:` with the department key or the task id, and linkKey for the lines. Null when it is not drawn.
 */
export function relatedTo(layout: BowtieLayout, focus: BowtieFocus): { nodes: Set<string>; links: Set<string> } | null {
  const nodes = new Set<string>();
  const links = new Set<string>();
  const take = (t: BowtieTask, through: string[]) => {
    nodes.add(`t:${t.task.id}`);
    for (const key of through) {
      nodes.add(`d:${key}`);
      links.add(linkKey(key, t.task.id));
    }
    if (t.parentId) {
      nodes.add(`p:${t.parentId}`);
      links.add(linkKey(t.task.id, t.parentId));
    }
  };
  if ('department' in focus) {
    if (!layout.departments.some((d) => d.key === focus.department)) return null;
    const keys = new Set([focus.department, ...layout.departments.filter((d) => d.part === focus.department).map((d) => d.key)]);
    nodes.add(`d:${focus.department}`);
    for (const t of layout.tasks) {
      const through = t.departments.filter((k) => keys.has(k));
      if (through.length > 0) take(t, through);
    }
    return { nodes, links };
  }
  const own = layout.tasks.find((t) => t.task.id === focus.task);
  if (own) {
    take(own, own.departments);
    return { nodes, links };
  }
  if (!layout.parents.some((p) => p.task.id === focus.task)) return null;
  nodes.add(`p:${focus.task}`);
  for (const t of layout.tasks) if (t.parentId === focus.task) take(t, t.departments);
  return { nodes, links };
}
