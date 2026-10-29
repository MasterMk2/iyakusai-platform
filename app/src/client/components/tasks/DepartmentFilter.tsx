import { useEffect, useId, useRef, useState } from 'react';
import { DEPARTMENT_WORKSPACE_PREFIX, departmentKey, type Department, type TaskView } from '../../../shared/tasks';

// Showing several departments at once (2026-10-25). The list is read once for every department
// (/api/tasks/all) and the chosen departments filter it in the browser, so choosing departments sends
// nothing to the Task service. A part (部) covers its sections (課), as the department lists always did.

/** Departments that are not a section of another listed department. */
export function topLevelKeys(departments: Department[]): string[] {
  const keys = new Set(departments.map((d) => d.key));
  return departments.filter((d) => !d.parent || !keys.has(d.parent)).map((d) => d.key);
}

/** Known keys in the departments' own order, without a section whose part is chosen too. */
export function canonicalSelection(keys: Iterable<string>, departments: Department[]): string[] {
  const chosen = new Set(keys);
  return departments.filter((d) => chosen.has(d.key) && !(d.parent && chosen.has(d.parent))).map((d) => d.key);
}

/** The chosen keys and the sections of every chosen part. */
export function coveredKeys(keys: string[], departments: Department[]): Set<string> {
  const chosen = new Set(keys);
  return new Set(departments.filter((d) => chosen.has(d.key) || (!!d.parent && chosen.has(d.parent))).map((d) => d.key));
}

export const coversTask = (covered: Set<string>, task: TaskView): boolean => (task.tags ?? []).some((k) => covered.has(k));

/** `ws=` when nothing is chosen (an empty value would mean "not given"). */
export const NO_DEPARTMENTS = 'none';

/** `ws=` for a selection: the department workspaces joined by commas. */
export function selectionParam(keys: string[]): string {
  return keys.length > 0 ? keys.map((k) => DEPARTMENT_WORKSPACE_PREFIX + k).join(',') : NO_DEPARTMENTS;
}

/** The departments a `ws=` names; null when it names none of them (then the saved choice or all). */
export function parseSelection(ws: string | null, departments: Department[]): string[] | null {
  if (ws === null) return null;
  if (ws === NO_DEPARTMENTS) return [];
  const keys = ws.split(',').flatMap((w) => {
    const key = departmentKey(w.trim());
    return key ? [key] : [];
  });
  const selection = canonicalSelection(keys, departments);
  return selection.length > 0 ? selection : null;
}

// The last choice, kept only in this browser so that the tasks tab opens with it. Reading or writing it
// may fail (private windows, blocked storage); the list then opens with every department.
const STORAGE_KEY = 'iyakusai.tasks.departments';

export function storedSelection(departments: Department[]): string[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return null;
    const selection = canonicalSelection(parsed.filter((k): k is string => typeof k === 'string'), departments);
    return selection.length > 0 ? selection : null;
  } catch {
    return null;
  }
}

export function storeSelection(keys: string[]): void {
  if (keys.length === 0) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Not kept; the list still shows the choice through the URL.
  }
}

/**
 * "外務部", "内務部・広報課", "すべての部局"; with `short`, three or more become "総務部ほか2". One department
 * keeps its name even when it is everything this person sees.
 */
export function selectionLabel(keys: string[], departments: Department[], short = false): string {
  if (keys.length === 0) return '部局を選んでいません';
  if (keys.length > 1 && coveredKeys(keys, departments).size === departments.length) return 'すべての部局';
  const labels = keys.map((k) => departments.find((d) => d.key === k)?.label ?? k);
  return short && labels.length > 2 ? `${labels[0]}ほか${labels.length - 1}` : labels.join('・');
}

/**
 * The department choice above the task list: one button that opens the departments as checkboxes over
 * the list (the list does not move). A part's sections are included while the part is chosen; "だけ表示"
 * shows one department alone in one press.
 */
export function DepartmentFilter({
  departments,
  value,
  count,
  onChange,
}: {
  departments: Department[];
  value: string[];
  /** Rows a department would show with the other filters; null while the list loads. */
  count: (key: string) => number | null;
  onChange: (keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  const chosen = new Set(value);
  const tops = new Set(topLevelKeys(departments));
  const set = (key: string, on: boolean) => onChange(canonicalSelection(on ? [...value, key] : value.filter((k) => k !== key), departments));
  const row = (d: Department, part: Department | null) => {
    const included = part !== null && chosen.has(part.key);
    const n = count(d.key);
    return (
      <div className="department-filter-row">
        <label className="department-filter-option">
          <input type="checkbox" checked={included || chosen.has(d.key)} disabled={included} onChange={(e) => set(d.key, e.target.checked)} data-department={d.key} />
          <span>{d.label}</span>
          {included && <span className="department-filter-note">（{part.label}に含む）</span>}
          <span className="option-count" aria-hidden="true">
            {n ?? ''}
          </span>
        </label>
        <button
          type="button"
          className="quiet department-only"
          aria-label={`${d.label}だけ表示`}
          onClick={() => {
            onChange([d.key]);
            close();
          }}
        >
          だけ表示
        </button>
      </div>
    );
  };

  return (
    <div className="department-filter" ref={wrap}>
      <button
        type="button"
        ref={toggle}
        className="department-filter-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        title={selectionLabel(value, departments)}
        data-testid="task-departments"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sr-only">表示する部局: </span>
        <span className="department-filter-label">{selectionLabel(value, departments, true)}</span>
        <span className="department-filter-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div id={panelId} className="department-filter-panel" role="group" aria-label="表示する部局">
          <p className="department-filter-hint">部を選ぶと、その部の課のタスクも出ます。</p>
          <ul>
            {departments
              .filter((d) => tops.has(d.key))
              .map((d) => {
                const sections = departments.filter((s) => s.parent === d.key);
                return (
                  <li key={d.key}>
                    {row(d, null)}
                    {sections.length > 0 && (
                      <ul>
                        {sections.map((s) => (
                          <li key={s.key}>{row(s, d)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
          </ul>
          <div className="department-filter-actions">
            <button type="button" className="secondary small" onClick={() => onChange([...tops])}>
              すべて選ぶ
            </button>
            <button type="button" className="secondary small" onClick={() => onChange([])}>
              すべて外す
            </button>
            <button type="button" className="small" onClick={close}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
