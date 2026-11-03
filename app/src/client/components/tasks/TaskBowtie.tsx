import { useState, useSyncExternalStore } from 'react';
import type { Department, TaskView } from '../../../shared/tasks';
import { bowtieLayout, linkKey, relatedTo, type BowtieFocus, type BowtieNode, type BowtieSizes } from './bowtie';
import { deadlineInfo, StatusChip } from './common';
import { openCount } from './nesting';

// The connections view (2026-10-28; nested 2026-11-03): parts, sections, assignees, tasks and projects
// in five columns with the lines between them (see bowtie.ts). A part, section or assignee pressed
// brings its lines forward until pressed again; pointing at or focusing anything shows its own lines
// meanwhile, and an opened task shows its lines.

// The rows are placed in px, so the height for fingers (44px targets) is chosen here, not in the CSS.
const FINE: BowtieSizes = { row: 36, department: 32, parent: 50, gap: 4, block: 14 };
const COARSE: BowtieSizes = { row: 50, department: 46, parent: 56, gap: 6, block: 16 };

const COARSE_QUERY = '(pointer: coarse)';
const coarseQuery = () => (typeof window.matchMedia === 'function' ? window.matchMedia(COARSE_QUERY) : null);
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = coarseQuery();
      query?.addEventListener('change', onChange);
      return () => query?.removeEventListener('change', onChange);
    },
    () => coarseQuery()?.matches ?? false,
    () => false,
  );
}

interface Link {
  key: string;
  from: number;
  to: number;
}

export function TaskBowtie({
  rows,
  byId,
  departments,
  shown,
  children,
  today,
  selectedId,
  onOpen,
}: {
  rows: TaskView[];
  byId: Map<string, TaskView>;
  departments: Department[];
  shown: Set<string>;
  children: Map<string, TaskView[]>;
  today: string;
  selectedId: string | null;
  onOpen: (taskId: string) => void;
}) {
  const sizes = useCoarsePointer() ? COARSE : FINE;
  const layout = bowtieLayout(rows, byId, departments, shown, sizes);
  const [traced, setTraced] = useState<string | null>(null);
  const [preview, setPreview] = useState<BowtieFocus | null>(null);
  // What is pointed at, else the node pressed, else the opened task; one no longer drawn (left out by the
  // filters) gives way to the next.
  const related =
    (preview && relatedTo(layout, preview)) ??
    (traced !== null ? relatedTo(layout, { node: traced }) : null) ??
    (selectedId ? relatedTo(layout, { task: selectedId }) : null);
  const is = (node: string) => (related?.nodes.has(node) ? 'is-related' : '');
  const pointing = (f: BowtieFocus) => ({
    onMouseEnter: () => setPreview(f),
    onMouseLeave: () => setPreview(null),
    onFocus: () => setPreview(f),
    onBlur: () => setPreview(null),
  });

  const rowHeight = sizes.row - sizes.gap;
  const centre = (nodes: { key: string; top: number }[]) => new Map(nodes.map((n) => [n.key, n.top + sizes.department / 2]));
  const partAt = centre(layout.parts);
  const sectionAt = centre(layout.sections);
  const personAt = centre(layout.people);
  const taskAt = new Map(layout.tasks.map((t) => [t.task.id, t.top + rowHeight / 2]));
  const parentAt = new Map(layout.parents.map((p) => [p.task.id, p.top + sizes.parent / 2]));
  const down = (nodes: BowtieNode[], above: Map<string, number>, at: Map<string, number>): Link[] => nodes.map((n) => ({ key: linkKey(n.up!, n.key), from: above.get(n.up!)!, to: at.get(n.key)! }));
  const toTasks: Link[] = layout.tasks.flatMap((t) => t.people.map((k) => ({ key: linkKey(k, t.task.id), from: personAt.get(k)!, to: taskAt.get(t.task.id)! })));
  const toParents: Link[] = layout.tasks.flatMap((t) => (t.parentId ? [{ key: linkKey(t.task.id, t.parentId), from: taskAt.get(t.task.id)!, to: parentAt.get(t.parentId)! }] : []));
  // Each gutter is 100 wide and stretched to its column; the strokes keep their width.
  const lines = (links: Link[]) => (
    <svg className="bowtie-links" viewBox={`0 0 100 ${Math.max(layout.height, 1)}`} preserveAspectRatio="none" style={{ height: layout.height }} aria-hidden="true" focusable="false">
      {[...links]
        // The lines brought forward are drawn last, over the others.
        .sort((a, b) => Number(related?.links.has(a.key) ?? false) - Number(related?.links.has(b.key) ?? false))
        .map((l) => (
          <path key={l.key} data-link={l.key} d={`M0 ${l.from} C50 ${l.from} 50 ${l.to} 100 ${l.to}`} vectorEffect="non-scaling-stroke" className={related?.links.has(l.key) ? 'is-related' : undefined} />
        ))}
    </svg>
  );
  const column = (name: string, kind: string, nodes: BowtieNode[]) => (
    <ul className={`bowtie-col bowtie-${kind}`} aria-label={name}>
      {nodes.map((n) => (
        <li key={n.key || 'none'} className={`bowtie-node ${n.placeholder ? 'is-placeholder' : ''} ${n.context ? 'is-context' : ''} ${is(`n:${n.key}`)}`} style={{ top: n.top, height: sizes.department }} data-node={n.key}>
          <button
            type="button"
            aria-pressed={traced === n.key}
            title={`${n.label}（${n.count} 件）`}
            onClick={() => {
              setTraced(traced === n.key ? null : n.key);
              setPreview(null);
            }}
            {...pointing({ node: n.key })}
          >
            <span className="bowtie-name">{n.label}</span>{' '}
            <span className="bowtie-count">{n.count} 件</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={`task-bowtie ${related ? 'has-focus' : ''}`} data-testid="task-bowtie">
      <p className="bowtie-hint">部・課・担当者を押すと、その下のタスクと親タスクへの線を強調します（もう一度押すと戻ります）。</p>
      <div className="bowtie-scroll">
        <div className="bowtie-heads" aria-hidden="true">
          <span>部</span>
          <span />
          <span>課</span>
          <span />
          <span>担当者</span>
          <span />
          <span>タスク {layout.tasks.length} 件</span>
          <span />
          <span>親タスク {layout.parents.length} 件</span>
        </div>
        <div className="bowtie-body" style={{ height: layout.height }}>
          {column('部', 'parts', layout.parts)}
          {lines(down(layout.sections, partAt, sectionAt))}
          {column('課', 'sections', layout.sections)}
          {lines(down(layout.people, sectionAt, personAt))}
          {column('担当者', 'people', layout.people)}
          {lines(toTasks)}
          <ul className="bowtie-col bowtie-tasks" aria-label="タスク">
            {layout.tasks.map((t) => {
              const due = deadlineInfo(t.task, today);
              return (
                <li key={t.task.id} className={`bowtie-task ${is(`t:${t.task.id}`)}`} style={{ top: t.top, height: rowHeight }}>
                  <button
                    type="button"
                    data-task-id={t.task.id}
                    aria-current={selectedId === t.task.id ? 'true' : undefined}
                    title={t.task.title}
                    onClick={() => onOpen(t.task.id)}
                    {...pointing({ task: t.task.id })}
                  >
                    <StatusChip status={t.task.status} />{' '}
                    <span className="bowtie-title">{t.task.title}</span>{' '}
                    <span className={`due due-${due.tone}`}>
                      <strong>{due.label}</strong>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {lines(toParents)}
          <ul className="bowtie-col bowtie-parents" aria-label="親タスク">
            {layout.parents.map((p) => {
              const kids = children.get(p.task.id) ?? [];
              return (
                <li key={p.task.id} className={`bowtie-parent ${p.matches ? '' : 'is-context'} ${is(`p:${p.task.id}`)}`} style={{ top: p.top, height: sizes.parent }}>
                  <button
                    type="button"
                    data-task-id={p.task.id}
                    aria-current={selectedId === p.task.id ? 'true' : undefined}
                    title={p.task.title}
                    onClick={() => onOpen(p.task.id)}
                    {...pointing({ task: p.task.id })}
                  >
                    <span className="bowtie-title">{p.task.title}</span>{' '}
                    <span className="bowtie-parent-meta">
                      <StatusChip status={p.task.status} />{' '}
                      <span>
                        子 {kids.length - openCount(kids)}/{kids.length} 完了{p.matches ? '' : '・条件外'}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
