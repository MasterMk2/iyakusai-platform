// With extensions, so that the unit tests (Node's module resolution) can import this file too.
import type { Department, TaskView } from '../../../shared/tasks.js';
import { NO_DEPARTMENT, shownPlaces } from './tree.js';

// The connections view (2026-10-28; nested 2026-11-03): from the left, parts (部), their sections (課),
// the assignees in each section, the tasks themselves and their projects (parent tasks), each column
// one level of the nesting with a line to the next. A task placed on a part itself (or a part without
// sections) goes through a "部全体" node in the section column, so that no line skips a column; an
// assignee sits under each section they have tasks in. Only the assignee (主担当) is drawn, not the
// helpers. Built from the rows already filtered and sorted, like the tree; every position is in px from
// the top of the picture.

export interface BowtieSizes {
  /** The middle rows' pitch (a row is this less `gap` high). */
  row: number;
  /** A part's, section's or assignee's height, and a project's. */
  department: number;
  parent: number;
  /** Room kept between two nodes of a column, and between two sections' blocks of rows. */
  gap: number;
  block: number;
}

/** The section node standing for a part's own tasks. */
export const WHOLE_PART = '#all';
/** The assignee key of the tasks without one. */
export const NO_ASSIGNEE = '';

export interface BowtieNode {
  /** Node key: the department key for a part or a section (`<part>#all` for a part's own tasks), `<section>|<assignee>` for an assignee. */
  key: string;
  label: string;
  /** The node it hangs from in the column to the left (null for a part). */
  up: string | null;
  /** The tasks under it, each once. */
  count: number;
  top: number;
  /** A part shown only for its sections (it is left out by the department filter). */
  context?: boolean;
  /** A placeholder: 部全体, 部局なし (with its section なし) or 未割当. */
  placeholder?: boolean;
}

export interface BowtieTask {
  task: TaskView;
  /** The assignee nodes linked to it (one per section it is placed in). */
  people: string[];
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
  parts: BowtieNode[];
  sections: BowtieNode[];
  people: BowtieNode[];
  tasks: BowtieTask[];
  parents: BowtieParent[];
  height: number;
}

export const personKey = (section: string, assignee: string): string => `${section}|${assignee}`;

/**
 * Where everything goes. A project with children among the rows is on the right (dimmed when it does
 * not match itself); every other row is in the middle, grouped by its first section, then by its
 * assignee, then by its project, otherwise in the list's order. Each node on the left sits level with
 * the rows (or nodes) under it, each column pushed down only as far as needed to keep its nodes apart.
 */
export function bowtieLayout(rows: TaskView[], byId: Map<string, TaskView>, departments: Department[], shown: Set<string>, sizes: BowtieSizes): BowtieLayout {
  const label = new Map(departments.map((d) => [d.key, d.label]));
  const partOf = new Map(departments.map((d) => [d.key, d.parent ?? null]));
  // The section column's order: each part's own node first, then its sections in the departments' order.
  const sectionOrder: { key: string; part: string }[] = [];
  for (const d of departments) {
    if (d.parent) continue;
    sectionOrder.push({ key: `${d.key}${WHOLE_PART}`, part: d.key });
    for (const s of departments) if (s.parent === d.key) sectionOrder.push({ key: s.key, part: d.key });
  }
  sectionOrder.push({ key: `${NO_DEPARTMENT}${WHOLE_PART}`, part: NO_DEPARTMENT });
  const rank = new Map(sectionOrder.map((s, i) => [s.key, i]));
  // A place (a department key) as a section node: a section as it is, a part (or an unknown key) as its own node.
  const sectionNode = (key: string) => (partOf.get(key) ? key : `${key}${WHOLE_PART}`);
  const partNode = (section: string) => sectionOrder.find((s) => s.key === section)?.part ?? NO_DEPARTMENT;

  const listed = new Set(rows.map((t) => t.id));
  const projects = new Map<string, TaskView>();
  for (const t of rows) {
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    if (parent) projects.set(parent.id, parent);
  }
  const middle = rows
    .filter((t) => !projects.has(t.id))
    .map((task, index) => {
      const sections = [...new Set(shownPlaces(task, byId, departments, shown).map(sectionNode))].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
      const assignee = task.assigneeId ?? NO_ASSIGNEE;
      return { task, sections, people: sections.map((s) => personKey(s, assignee)), parentId: task.parentId && projects.has(task.parentId) ? task.parentId : null, index, first: rank.get(sections[0]!) ?? Infinity };
    });
  // An assignee's rows in one section stay together, where the first of them is; so do a project's
  // children under one assignee.
  const anchor = new Map<string, number>();
  const anchored = (key: string, index: number) => {
    if (!anchor.has(key)) anchor.set(key, index);
    return anchor.get(key)!;
  };
  const order = middle.map((m) => ({ m, person: anchored(m.people[0]!, m.index), project: m.parentId ? anchored(`${m.people[0]}>${m.parentId}`, m.index) : m.index }));
  order.sort((a, b) => a.m.first - b.m.first || a.person - b.person || a.project - b.project || a.m.index - b.m.index);

  const tasks: BowtieTask[] = [];
  let y = 0;
  for (const [i, { m }] of order.entries()) {
    if (i > 0 && m.sections[0] !== order[i - 1]!.m.sections[0]) y += sizes.block;
    tasks.push({ task: m.task, people: m.people, parentId: m.parentId, top: y });
    y += sizes.row;
  }
  const rowHeight = sizes.row - sizes.gap;
  const half = sizes.department / 2;
  const mean = (centres: number[]) => centres.reduce((sum, c) => sum + c, 0) / centres.length;
  /** Nodes in their order, each level with what it wants and pushed below the one before. */
  const stack = <T extends { want: number }>(wanted: T[], height: number) => {
    let bottom = -sizes.gap;
    return wanted.map((n) => {
      const top = Math.max(n.want, bottom + sizes.gap, 0);
      bottom = top + height;
      return { ...n, top, bottom };
    });
  };

  // Assignees: each (section, person) level with its own block of rows (or all its rows, when each is first elsewhere).
  const personKeys = [...new Set(tasks.flatMap((t) => t.people))];
  const centreOf = (t: BowtieTask) => t.top + rowHeight / 2;
  const people = stack(
    personKeys
      .map((key) => {
        const own = tasks.filter((t) => t.people.includes(key));
        const block = own.filter((t) => t.people[0] === key);
        return { key, own, want: mean((block.length > 0 ? block : own).map(centreOf)) - half, first: tasks.indexOf(own[0]!) };
      })
      .sort((a, b) => (rank.get(a.key.split('|')[0]!) ?? Infinity) - (rank.get(b.key.split('|')[0]!) ?? Infinity) || a.want - b.want || a.first - b.first),
    sizes.department,
  ).map((n) => {
    const [section, assignee] = n.key.split('|') as [string, string];
    const name = assignee === NO_ASSIGNEE ? '未割当' : (n.own[0]!.task.assignee?.displayName ?? assignee);
    return { key: n.key, label: name, up: section, count: n.own.length, top: n.top, ...(assignee === NO_ASSIGNEE ? { placeholder: true } : {}) };
  });

  // Sections and parts: level with the nodes under them.
  const level = (children: BowtieNode[]) => mean(children.map((c) => c.top + half)) - half;
  const sectionKeys = sectionOrder.map((s) => s.key).filter((k) => people.some((p) => p.up === k));
  const sections = stack(
    sectionKeys.map((key) => ({ key, want: level(people.filter((p) => p.up === key)) })),
    sizes.department,
  ).map((n): BowtieNode => {
    const part = partNode(n.key);
    const whole = n.key.endsWith(WHOLE_PART);
    const ids = new Set(tasks.filter((t) => t.people.some((p) => p.startsWith(`${n.key}|`))).map((t) => t.task.id));
    return { key: n.key, label: whole ? (part === NO_DEPARTMENT ? 'なし' : '部全体') : (label.get(n.key) ?? n.key), up: part, count: ids.size, top: n.top, ...(whole ? { placeholder: true } : {}) };
  });
  const partKeys = [...new Set(sections.map((s) => s.up!))];
  const parts = stack(
    partKeys.map((key) => ({ key, want: level(sections.filter((s) => s.up === key)) })),
    sizes.department,
  ).map((n): BowtieNode => {
    const ids = new Set(tasks.filter((t) => t.people.some((p) => partNode(p.split('|')[0]!) === n.key)).map((t) => t.task.id));
    const context = n.key !== NO_DEPARTMENT && !shown.has(n.key);
    return { key: n.key, label: n.key === NO_DEPARTMENT ? '部局なし' : (label.get(n.key) ?? n.key), up: null, count: ids.size, top: n.top, ...(context ? { context } : {}), ...(n.key === NO_DEPARTMENT ? { placeholder: true } : {}) };
  });

  // Right: each project level with its children, in that order.
  const right = stack(
    [...projects.values()]
      .map((task) => {
        const kids = tasks.filter((t) => t.parentId === task.id);
        return { task, matches: listed.has(task.id), want: mean(kids.map(centreOf)) - sizes.parent / 2, first: tasks.indexOf(kids[0]!) };
      })
      .sort((a, b) => a.want - b.want || a.first - b.first),
    sizes.parent,
  );
  const parents: BowtieParent[] = right.map((p) => ({ task: p.task, matches: p.matches, top: p.top }));

  const bottoms = [tasks.length > 0 ? tasks[tasks.length - 1]!.top + rowHeight : 0, ...[parts, sections, people].flatMap((c) => c.map((n) => n.top + sizes.department)), ...right.map((p) => p.bottom), 0];
  return { parts, sections, people, tasks, parents, height: Math.max(...bottoms) };
}

/** A link's key: from the left node to the right one (part>section, section>person, person>task, task>project). */
export const linkKey = (from: string, to: string): string => `${from}>${to}`;

/** A part, a section or an assignee pressed or pointed at (its node key), or a task. */
export type BowtieFocus = { node: string } | { task: string };

/**
 * What to bring forward for a node (everything under it: sections, assignees, tasks and their projects,
 * and the line up to it) or a task (its assignees, sections and parts, and its project; a project with
 * its children and theirs). Keys are `n:` with the node key, `t:` and `p:` with the task id, and linkKey
 * for the lines. Null when it is not drawn.
 */
export function relatedTo(layout: BowtieLayout, focus: BowtieFocus): { nodes: Set<string>; links: Set<string> } | null {
  const nodes = new Set<string>();
  const links = new Set<string>();
  const up = new Map([...layout.sections, ...layout.people].map((n) => [n.key, n.up!]));
  const climb = (key: string) => {
    nodes.add(`n:${key}`);
    const above = up.get(key);
    if (above === undefined) return;
    links.add(linkKey(above, key));
    climb(above);
  };
  const take = (t: BowtieTask, through: string[]) => {
    nodes.add(`t:${t.task.id}`);
    for (const key of through) {
      climb(key);
      links.add(linkKey(key, t.task.id));
    }
    if (t.parentId) {
      nodes.add(`p:${t.parentId}`);
      links.add(linkKey(t.task.id, t.parentId));
    }
  };
  if ('node' in focus) {
    const all = [...layout.parts, ...layout.sections, ...layout.people];
    if (!all.some((n) => n.key === focus.node)) return null;
    // The node itself and every node below it.
    const below = new Set([focus.node]);
    for (const n of [...layout.sections, ...layout.people]) if (below.has(n.up!)) below.add(n.key);
    nodes.add(`n:${focus.node}`);
    for (const t of layout.tasks) {
      const through = t.people.filter((k) => below.has(k));
      if (through.length > 0) take(t, through);
    }
    return { nodes, links };
  }
  const own = layout.tasks.find((t) => t.task.id === focus.task);
  if (own) {
    take(own, own.people);
    return { nodes, links };
  }
  if (!layout.parents.some((p) => p.task.id === focus.task)) return null;
  nodes.add(`p:${focus.task}`);
  for (const t of layout.tasks) if (t.parentId === focus.task) take(t, t.people);
  return { nodes, links };
}
