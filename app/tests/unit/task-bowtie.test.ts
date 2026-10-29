import { describe, expect, it } from 'vitest';
import { bowtieLayout, relatedTo, type BowtieLayout } from '../../src/client/components/tasks/bowtie.js';
import type { Department, TaskView } from '../../src/shared/tasks.js';

// The connections view (2026-10-28): which side each task is on, where the nodes go, and what a
// department or a task brings forward.

const DEPARTMENTS: Department[] = [
  { key: 'yakuin', label: '役員会', parent: null },
  { key: 'soumu', label: '総務部', parent: null },
  { key: 'kaikei', label: '会計課', parent: 'soumu' },
  { key: 'system', label: 'システム課', parent: 'soumu' },
  { key: 'gaimu', label: '外務部', parent: null },
  { key: 'koho', label: '広報課', parent: 'gaimu' },
  { key: 'shogai', label: '渉外課', parent: 'gaimu' },
];
const ALL = new Set(DEPARTMENTS.map((d) => d.key));
// A row is 8 high (10 apart), a department 6 and a project 10, 2 kept between nodes, 4 between blocks.
const SIZES = { row: 10, department: 6, parent: 10, gap: 2, block: 4 };

const task = (id: string, tags: string[], parentId: string | null = null) => ({ id, tags, parentId }) as TaskView;
const byId = (tasks: TaskView[]) => new Map(tasks.map((t) => [t.id, t]));
const left = (l: BowtieLayout) => l.departments.map((d) => `${d.key || '(none)'} ${d.top} ${d.count}${d.part ? ` in ${d.part}` : ''}`);
const middle = (l: BowtieLayout) => l.tasks.map((t) => `${t.task.id} ${t.top} ${t.departments.join(',')}${t.parentId ? ` >${t.parentId}` : ''}`);
const right = (l: BowtieLayout) => l.parents.map((p) => `${p.matches ? '' : '~'}${p.task.id} ${p.top}`);

// Rows in the list's order; q is a project left out by the filters (loaded, not a row).
const q = task('q', ['koho']);
const rows = [task('t1', ['kaikei', 'shogai']), task('t2', ['soumu']), task('p', ['shogai']), task('c1', ['shogai'], 'p'), task('t3', ['kaikei']), task('c2', ['koho'], 'q'), task('t4', [])];
const layout = bowtieLayout(rows, byId([...rows, q]), DEPARTMENTS, ALL, SIZES);

describe('the connections view', () => {
  it('puts projects with children on the right and groups the rest by their first department', () => {
    // 総務部, then 会計課 (t1 first in the list), 広報課, 渉外課, none; a block is 4 below the one before.
    expect(middle(layout)).toEqual(['t2 0 soumu', 't1 14 kaikei,shogai', 't3 24 kaikei', 'c2 38 koho >q', 'c1 52 shogai >p', 't4 66 ']);
    expect(right(layout)).toEqual(['~q 37', 'p 51']);
    expect(layout.height).toBe(74);
  });

  it('sets each department level with its block, a part without rows above its first section', () => {
    // Centres: t2 4 | t1 18, t3 28 | c2 42 | c1 56 | t4 70. A part counts its sections' tasks, each once;
    // 役員会 and システム課 have nothing and are left out.
    expect(left(layout)).toEqual(['soumu 1 3', 'kaikei 20 2 in soumu', 'gaimu 31 3', 'koho 39 1 in gaimu', 'shogai 53 2 in gaimu', '(none) 67 1']);
  });

  it('keeps a project’s children together and pushes a project down only as far as needed', () => {
    const together = [task('a', ['kaikei'], 'p'), task('b', ['kaikei']), task('c', ['kaikei'], 'p')];
    expect(middle(bowtieLayout(together, byId([...together, task('p', ['kaikei'])]), DEPARTMENTS, ALL, SIZES))).toEqual(['a 0 kaikei >p', 'c 10 kaikei >p', 'b 20 kaikei']);
    // Two projects one row apart: the first cannot go above the top, the second clears it.
    const close = [task('a', ['kaikei'], 'p'), task('b', ['kaikei'], 'r')];
    expect(right(bowtieLayout(close, byId([...close, task('p', ['kaikei']), task('r', ['kaikei'])]), DEPARTMENTS, ALL, SIZES))).toEqual(['~p 0', '~r 12']);
  });

  it('places a child where its project is when only the project’s department is shown, and keeps a project without shown children in the middle', () => {
    const some = [task('p', ['shogai']), task('c', ['kaikei'], 'p'), task('p2', ['koho'])];
    const l = bowtieLayout(some, byId([...some, task('c2', ['koho'], 'p2')]), DEPARTMENTS, new Set(['gaimu', 'koho', 'shogai']), SIZES);
    expect(middle(l)).toEqual(['p2 0 koho', 'c 14 shogai >p']);
    expect(right(l)).toEqual(['p 13']);
    expect(left(l).map((d) => d.split(' ')[0])).toEqual(['gaimu', 'koho', 'shogai']);
  });

  it('brings forward a part with its sections’ tasks and their projects, or a task with its departments and project', () => {
    const forward = (f: Parameters<typeof relatedTo>[1]) => {
      const r = relatedTo(layout, f);
      return r && { nodes: [...r.nodes].sort(), links: [...r.links].sort() };
    };
    expect(forward({ department: 'gaimu' })).toEqual({
      nodes: ['d:gaimu', 'd:koho', 'd:shogai', 'p:p', 'p:q', 't:c1', 't:c2', 't:t1'],
      links: ['c1>p', 'c2>q', 'koho>c2', 'shogai>c1', 'shogai>t1'],
    });
    // A section brings forward only its own lines (t1's line from 渉外課 stays back).
    expect(forward({ department: 'kaikei' })).toEqual({ nodes: ['d:kaikei', 't:t1', 't:t3'], links: ['kaikei>t1', 'kaikei>t3'] });
    expect(forward({ task: 't1' })).toEqual({ nodes: ['d:kaikei', 'd:shogai', 't:t1'], links: ['kaikei>t1', 'shogai>t1'] });
    expect(forward({ task: 'p' })).toEqual({ nodes: ['d:shogai', 'p:p', 't:c1'], links: ['c1>p', 'shogai>c1'] });
    // Not drawn: nothing to bring forward.
    expect(forward({ department: 'system' })).toBeNull();
    expect(forward({ task: 'gone' })).toBeNull();
  });

  it('draws nothing for no rows', () => {
    expect(bowtieLayout([], new Map(), DEPARTMENTS, ALL, SIZES)).toEqual({ departments: [], tasks: [], parents: [], height: 0 });
  });
});
