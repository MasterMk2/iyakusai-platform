import { describe, expect, it } from 'vitest';
import { bowtieLayout, relatedTo, type BowtieLayout, type BowtieNode } from '../../src/client/components/tasks/bowtie.js';
import type { Department, TaskView } from '../../src/shared/tasks.js';

// The connections view (2026-10-28; nested 2026-11-03): parts → sections → assignees → tasks → projects,
// where each node goes, and what a node or a task brings forward.

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
// A row is 8 high (10 apart), a node 6 and a project 10, 2 kept between nodes, 4 between blocks.
const SIZES = { row: 10, department: 6, parent: 10, gap: 2, block: 4 };

const task = (id: string, tags: string[], who: string | null, parentId: string | null = null) =>
  ({ id, tags, parentId, assigneeId: who, assignee: who ? { id: who, displayName: who.toUpperCase(), active: true } : null }) as TaskView;
const byId = (tasks: TaskView[]) => new Map(tasks.map((t) => [t.id, t]));
const nodes = (list: BowtieNode[]) =>
  list.map((n) => `${n.label} ${n.top} ${n.count}${n.up !== null ? ` <${n.up || '(none)'}` : ''}${n.placeholder ? ' *' : ''}${n.context ? ' ~' : ''}`);
const middle = (l: BowtieLayout) => l.tasks.map((t) => `${t.task.id} ${t.top} ${t.people.join(',')}${t.parentId ? ` >${t.parentId}` : ''}`);
const right = (l: BowtieLayout) => l.parents.map((p) => `${p.matches ? '' : '~'}${p.task.id} ${p.top}`);

// Rows in the list's order; q is a project left out by the filters (loaded, not a row).
const q = task('q', ['koho'], 'b');
const rows = [
  task('t1', ['kaikei', 'shogai'], 'a'),
  task('t2', ['soumu'], 'b'),
  task('p', ['shogai'], 'a'),
  task('c1', ['shogai'], 'b', 'p'),
  task('t3', ['kaikei'], 'b'),
  task('t5', ['kaikei'], 'a'),
  task('c2', ['koho'], null, 'q'),
  task('t4', [], null),
];
const layout = bowtieLayout(rows, byId([...rows, q]), DEPARTMENTS, ALL, SIZES);

describe('the connections view', () => {
  it('puts projects with children on the right and groups the rest by section, then by assignee', () => {
    // 総務部's own (部全体), 会計課 (A's two together, then B), 広報課, 渉外課, none; a block is 4 below the one before.
    expect(middle(layout)).toEqual(['t2 0 soumu#all|b', 't1 14 kaikei|a,shogai|a', 't5 24 kaikei|a', 't3 34 kaikei|b', 'c2 48 koho| >q', 'c1 62 shogai|b >p', 't4 76 #all|']);
    expect(right(layout)).toEqual(['~q 47', 'p 61']);
    expect(layout.height).toBe(84);
  });

  it('sets each assignee level with their rows, under each section they have rows in', () => {
    // A under 渉外課 has only t1, which is in 会計課's block: level with it would overlap, so it is pushed down.
    expect(nodes(layout.people)).toEqual(['B 1 1 <soumu#all', 'A 20 2 <kaikei', 'B 35 1 <kaikei', '未割当 49 1 <koho *', 'A 57 1 <shogai', 'B 65 1 <shogai', '未割当 77 1 <#all *']);
  });

  it('sets each section level with its assignees and each part with its sections, a part’s own tasks under 部全体', () => {
    // 役員会 and システム課 have nothing and are left out; a part counts its sections' tasks, each once.
    expect(nodes(layout.sections)).toEqual(['部全体 1 1 <soumu *', '会計課 27.5 3 <soumu', '広報課 49 1 <gaimu', '渉外課 61 2 <gaimu', 'なし 77 1 <(none) *']);
    expect(nodes(layout.parts)).toEqual(['総務部 14.25 4', '外務部 55 3', '部局なし 77 1 *']);
  });

  it('shows a section’s part dimmed when only the section is shown', () => {
    const l = bowtieLayout(rows, byId([...rows, q]), DEPARTMENTS, new Set(['koho']), SIZES);
    expect(l.parts.map((n) => `${n.label}${n.context ? ' ~' : ''}`)).toEqual(['外務部 ~', '部局なし']);
  });

  it('keeps a project’s children under one assignee together and pushes a project down only as far as needed', () => {
    const together = [task('a', ['kaikei'], 'x', 'p'), task('b', ['kaikei'], 'x'), task('c', ['kaikei'], 'x', 'p')];
    expect(middle(bowtieLayout(together, byId([...together, task('p', ['kaikei'], 'x')]), DEPARTMENTS, ALL, SIZES))).toEqual(['a 0 kaikei|x >p', 'c 10 kaikei|x >p', 'b 20 kaikei|x']);
    // Two projects one row apart: the first cannot go above the top, the second clears it.
    const close = [task('a', ['kaikei'], 'x', 'p'), task('b', ['kaikei'], 'x', 'r')];
    expect(right(bowtieLayout(close, byId([...close, task('p', ['kaikei'], 'x'), task('r', ['kaikei'], 'x')]), DEPARTMENTS, ALL, SIZES))).toEqual(['~p 0', '~r 12']);
  });

  it('brings forward everything under a node with the path up to it, or a task with its assignees, sections, parts and project', () => {
    const forward = (f: Parameters<typeof relatedTo>[1]) => {
      const r = relatedTo(layout, f);
      return r && { nodes: [...r.nodes].sort(), links: [...r.links].sort() };
    };
    expect(forward({ node: 'gaimu' })).toEqual({
      nodes: ['n:gaimu', 'n:koho', 'n:koho|', 'n:shogai', 'n:shogai|a', 'n:shogai|b', 'p:p', 'p:q', 't:c1', 't:c2', 't:t1'],
      links: ['c1>p', 'c2>q', 'gaimu>koho', 'gaimu>shogai', 'koho>koho|', 'koho|>c2', 'shogai>shogai|a', 'shogai>shogai|b', 'shogai|a>t1', 'shogai|b>c1'],
    });
    // An assignee brings forward only their own lines (t1's line from 渉外課's A stays back).
    expect(forward({ node: 'kaikei|a' })).toEqual({
      nodes: ['n:kaikei', 'n:kaikei|a', 'n:soumu', 't:t1', 't:t5'],
      links: ['kaikei>kaikei|a', 'kaikei|a>t1', 'kaikei|a>t5', 'soumu>kaikei'],
    });
    expect(forward({ task: 't1' })).toEqual({
      nodes: ['n:gaimu', 'n:kaikei', 'n:kaikei|a', 'n:shogai', 'n:shogai|a', 'n:soumu', 't:t1'],
      links: ['gaimu>shogai', 'kaikei>kaikei|a', 'kaikei|a>t1', 'shogai>shogai|a', 'shogai|a>t1', 'soumu>kaikei'],
    });
    expect(forward({ task: 'p' })).toEqual({ nodes: ['n:gaimu', 'n:shogai', 'n:shogai|b', 'p:p', 't:c1'], links: ['c1>p', 'gaimu>shogai', 'shogai>shogai|b', 'shogai|b>c1'] });
    // Not drawn: nothing to bring forward.
    expect(forward({ node: 'system' })).toBeNull();
    expect(forward({ task: 'gone' })).toBeNull();
  });

  it('draws nothing for no rows', () => {
    expect(bowtieLayout([], new Map(), DEPARTMENTS, ALL, SIZES)).toEqual({ parts: [], sections: [], people: [], tasks: [], parents: [], height: 0 });
  });
});
