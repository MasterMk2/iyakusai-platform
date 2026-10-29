import { useState, useSyncExternalStore } from 'react';
import type { Department, TaskView } from '../../../shared/tasks';
import { bowtieLayout, linkKey, relatedTo, type BowtieFocus, type BowtieSizes } from './bowtie';
import { deadlineInfo, StatusChip } from './common';
import { openCount } from './nesting';

// The connections view (2026-10-28): departments, tasks and projects in three columns with the lines
// between them (see bowtie.ts). A department pressed brings its lines forward until pressed again;
// pointing at or focusing anything shows its own lines meanwhile, and an opened task shows its lines.

// The rows are placed in px, so the height for fingers (44px targets) is chosen here, not in the CSS.
const FINE: BowtieSizes = { row: 36, department: 38, parent: 50, gap: 4, block: 14 };
const COARSE: BowtieSizes = { row: 50, department: 48, parent: 56, gap: 6, block: 16 };

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
  // What is pointed at, else the department pressed, else the opened task; one no longer drawn (left out
  // by the filters) gives way to the next.
  const related =
    (preview && relatedTo(layout, preview)) ??
    (traced !== null ? relatedTo(layout, { department: traced }) : null) ??
    (selectedId ? relatedTo(layout, { task: selectedId }) : null);
  const is = (node: string) => (related?.nodes.has(node) ? 'is-related' : '');
  const pointing = (f: BowtieFocus) => ({
    onMouseEnter: () => setPreview(f),
    onMouseLeave: () => setPreview(null),
    onFocus: () => setPreview(f),
    onBlur: () => setPreview(null),
  });

  const rowHeight = sizes.row - sizes.gap;
  const departmentAt = new Map(layout.departments.map((d) => [d.key, d.top + sizes.department / 2]));
  const taskAt = new Map(layout.tasks.map((t) => [t.task.id, t.top + rowHeight / 2]));
  const parentAt = new Map(layout.parents.map((p) => [p.task.id, p.top + sizes.parent / 2]));
  const left: Link[] = layout.tasks.flatMap((t) => t.departments.map((k) => ({ key: linkKey(k, t.task.id), from: departmentAt.get(k)!, to: taskAt.get(t.task.id)! })));
  const right: Link[] = layout.tasks.flatMap((t) => (t.parentId ? [{ key: linkKey(t.task.id, t.parentId), from: taskAt.get(t.task.id)!, to: parentAt.get(t.parentId)! }] : []));
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

  return (
    <div className={`task-bowtie ${related ? 'has-focus' : ''}`} data-testid="task-bowtie">
      <p className="bowtie-hint">部局を押すと、そのタスクと親タスクへの線を強調します（もう一度押すと戻ります）。</p>
      <div className="bowtie-heads" aria-hidden="true">
        <span>部局</span>
        <span />
        <span>タスク {layout.tasks.length} 件</span>
        <span />
        <span>親タスク {layout.parents.length} 件</span>
      </div>
      <div className="bowtie-body" style={{ height: layout.height }}>
        <ul className="bowtie-col bowtie-departments" aria-label="部局">
          {layout.departments.map((d) => (
            <li key={d.key || 'none'} className={`bowtie-department ${d.part ? 'is-section' : ''} ${is(`d:${d.key}`)}`} style={{ top: d.top, height: sizes.department }} data-department={d.key}>
              <button
                type="button"
                aria-pressed={traced === d.key}
                title={d.part ? undefined : `${d.label}（課の分も含む）`}
                onClick={() => {
                  setTraced(traced === d.key ? null : d.key);
                  setPreview(null);
                }}
                {...pointing({ department: d.key })}
              >
                <span className="bowtie-name">{d.label}</span>{' '}
                <span className="bowtie-count">{d.count} 件</span>
              </button>
            </li>
          ))}
        </ul>
        {lines(left)}
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
        {lines(right)}
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
  );
}
