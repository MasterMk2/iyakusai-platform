import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { TaskMember, TaskView } from '../../../shared/tasks';
import type { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { AssigneeSelect, assigneeText, deadlineInfo, failureText, StatusChip } from './common';
import { FREE_LEAD_LIMIT, PEOPLE_SORT_LABELS, peopleListState, personLoads, personTasks, sortPeople, unassignedTasks, type PeopleSort, type PersonLoad } from './people';
import './people.css';

// The people view of the tasks list (人ごと, 2026-11-03). It shows the list the parent has already loaded and
// filtered by department, so choosing a person or a sort sends nothing to the Task service. Assigning an
// unassigned task is the existing update of the task, with its version; the Task service checks the rules.
// The roster is a request of its own: until it has arrived, no person is listed and nobody is called free.

type Focus = { kind: 'people' } | { kind: 'person'; id: string } | { kind: 'unassigned' };

export interface PeopleViewProps {
  /** The tasks of the chosen departments (completed ones are left out of every count). */
  scoped: TaskView[];
  /** Every loaded task; the "手が空いていそう" guide is judged over all of them. */
  whole: TaskView[];
  /** Departments are tags of the tasks: the guide then covers every department; otherwise this committee only. */
  multi: boolean;
  /** The committee's members, with their own loading and failure state. */
  members: ReturnType<typeof useLoader<TaskMember[]>>;
  today: string;
  userId: string | null;
  /** Editors and officers may assign; the Task service refuses anyone else anyway. */
  editable: boolean;
  onOpen: (taskId: string) => void;
  /** Resolves once the change is saved; rejects with the failure, which the row shows. */
  onAssign: (task: TaskView, assigneeId: string) => Promise<void>;
}

const SORTS = Object.keys(PEOPLE_SORT_LABELS) as PeopleSort[];

export function PeopleView({ scoped, whole, multi, members, today, userId, editable, onOpen, onAssign }: PeopleViewProps) {
  const [sort, setSort] = useState<PeopleSort>('load-desc');
  const [focus, setFocus] = useState<Focus>({ kind: 'people' });
  const roster = useMemo(() => members.data ?? [], [members.data]);
  // Null until the first answer arrives: a roster that is still loading or has failed is not an empty committee.
  const rosterKnown = members.data !== null;
  const people = useMemo(() => personLoads(scoped, roster, today, whole), [scoped, roster, today, whole]);
  const unassigned = useMemo(() => unassignedTasks(scoped), [scoped]);
  // Once a task gets its assignee it leaves the unassigned list. The focus then moves to the row now in its place
  // (or to the heading), so that a keyboard user does not start again from the top of the page.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const keepFocusAt = useRef<number | null>(null);
  useEffect(() => {
    if (keepFocusAt.current === null) return;
    const index = keepFocusAt.current;
    keepFocusAt.current = null;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.people-task') ?? []);
    (rows[Math.min(index, rows.length - 1)] ?? headingRef.current)?.focus();
  }, [unassigned]);
  const assignAt = (index: number) => async (task: TaskView, assigneeId: string) => {
    keepFocusAt.current = index;
    try {
      await onAssign(task, assigneeId);
    } catch (err) {
      keepFocusAt.current = null;
      throw err;
    }
  };
  // Assigning needs the roster; while it is unknown, or has no active member, the row says why.
  const assignNote = !rosterKnown ? '委員の名簿が届いていないため、担当を選べません。' : roster.some((m) => m.active) ? null : '担当を付けられる有効な委員がいません。';

  if (focus.kind === 'unassigned') {
    return (
      <div className="people-view people-detail" data-testid="unassigned-tasks">
        <button type="button" className="quiet people-back" onClick={() => setFocus({ kind: 'people' })}>
          ← 人の一覧に戻る
        </button>
        <h2 className="people-heading" ref={headingRef} tabIndex={-1}>
          担当なしの未完了タスク
        </h2>
        <LoadStatus loader={members} what="委員の名簿" />
        <p className="people-note">期限が近い順です。{editable ? '担当者を選び、「担当を付ける」を押すと主担当になります。' : '担当を付けられるのは編集者と管理者です。'}</p>
        {unassigned.length === 0 ? (
          <p className="empty">担当なしの未完了のタスクはありません。</p>
        ) : (
          <ul className="people-task-list" ref={listRef}>
            {unassigned.map((task, index) => (
              <UnassignedRow key={task.id} task={task} today={today} members={roster} editable={editable} assignNote={assignNote} onOpen={onOpen} onAssign={assignAt(index)} />
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (focus.kind === 'person') {
    const person = people.find((p) => p.id === focus.id);
    if (person) return <PersonTasks person={person} tasks={personTasks(scoped, person.id)} today={today} onBack={() => setFocus({ kind: 'people' })} onOpen={onOpen} />;
  }

  const sorted = sortPeople(people, sort);
  const listState = peopleListState(rosterKnown, sorted.length);
  return (
    <div className="people-view" data-testid="people-view">
      <div className="people-tools">
        <button type="button" className="secondary" onClick={() => setFocus({ kind: 'unassigned' })}>
          担当なし {unassigned.length} 件
        </button>
        <label className="sort-field">
          並べ順
          <select value={sort} onChange={(e) => setSort(e.target.value as PeopleSort)}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {PEOPLE_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="people-note">
        未完了のタスクだけを数えます。持ちは主担当と副担当の合計です。「手が空いていそう」は{multi ? '全部局で' : 'この委員会の中で'}未完了の主担当が {FREE_LEAD_LIMIT} 件以下の編集者・管理者に出す目安で、断定ではありません。
      </p>
      <LoadStatus loader={members} what="委員の名簿" />
      {listState === 'empty' && <p className="empty">名簿に委員がいません。</p>}
      {listState === 'rows' && (
        <ul className="people-list" data-testid="people-list">
          {sorted.map((p) => (
            <li key={p.id}>
              <button type="button" className="person-row" onClick={() => setFocus({ kind: 'person', id: p.id })}>
                <span className="person-head">
                  <span className="person-name">
                    {p.name}
                    {p.id === userId && <span className="person-self">（自分）</span>}
                  </span>
                  <span className="person-load">持ち {p.load} 件</span>
                  {!p.active && <span className="chip">無効な所属</span>}
                  {p.free && <span className="chip person-free">手が空いていそう</span>}
                </span>
                <span className="person-stats">
                  <span>主担当 <strong>{p.lead}</strong></span>
                  <span>副担当 <strong>{p.helper}</strong></span>
                  <span>進行中 <strong>{p.inProgress}</strong></span>
                  <span>保留 <strong>{p.blocked}</strong></span>
                  <span className={p.overdue > 0 ? 'count-overdue' : undefined}>期限超過 <strong>{p.overdue}</strong></span>
                  <span>7日以内 <strong>{p.week}</strong></span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonTasks({ person, tasks, today, onBack, onOpen }: { person: PersonLoad; tasks: { lead: TaskView[]; helper: TaskView[] }; today: string; onBack: () => void; onOpen: (taskId: string) => void }) {
  return (
    <div className="people-view people-detail" data-testid="person-tasks">
      <button type="button" className="quiet people-back" onClick={onBack}>
        ← 人の一覧に戻る
      </button>
      <h2 className="people-heading">{person.name}の未完了のタスク</h2>
      <p className="people-note">
        主担当 {tasks.lead.length} 件・副担当 {tasks.helper.length} 件{!person.active ? '（無効な所属）' : ''}。期限が近い順です。
      </p>
      <section aria-labelledby="person-lead">
        <h3 id="person-lead" className="people-subheading">主担当（{tasks.lead.length} 件）</h3>
        {tasks.lead.length === 0 ? <p className="empty">主担当の未完了のタスクはありません。</p> : <TaskLines tasks={tasks.lead} today={today} onOpen={onOpen} />}
      </section>
      <section aria-labelledby="person-helper">
        <h3 id="person-helper" className="people-subheading">副担当（{tasks.helper.length} 件）</h3>
        {tasks.helper.length === 0 ? <p className="empty">副担当の未完了のタスクはありません。</p> : <TaskLines tasks={tasks.helper} today={today} onOpen={onOpen} />}
      </section>
    </div>
  );
}

function TaskLines({ tasks, today, onOpen }: { tasks: TaskView[]; today: string; onOpen: (taskId: string) => void }) {
  return (
    <ul className="people-task-list">
      {tasks.map((task) => {
        const due = deadlineInfo(task, today);
        return (
          <li key={task.id}>
            <button type="button" className="people-task" onClick={() => onOpen(task.id)}>
              <StatusChip status={task.status} />
              <span className="subject" title={task.title}>
                {task.title}
              </span>
              <span className={`due due-${due.tone}`}>
                <strong>{due.label}</strong>
                {due.date && <small>{due.date}</small>}
              </span>
              <span className="people-task-meta">担当: {assigneeText(task)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function UnassignedRow({
  task,
  today,
  members,
  editable,
  assignNote,
  onOpen,
  onAssign,
}: {
  task: TaskView;
  today: string;
  members: TaskMember[];
  editable: boolean;
  /** Why no assignee can be chosen now; null when one can. */
  assignNote: string | null;
  onOpen: (taskId: string) => void;
  onAssign: (task: TaskView, assigneeId: string) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const due = deadlineInfo(task, today);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (chosen === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAssign(task, chosen);
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li>
      <button type="button" className="people-task" onClick={() => onOpen(task.id)}>
        <StatusChip status={task.status} />
        <span className="subject" title={task.title}>
          {task.title}
        </span>
        <span className={`due due-${due.tone}`}>
          <strong>{due.label}</strong>
          {due.date && <small>{due.date}</small>}
        </span>
      </button>
      {editable &&
        (assignNote === null ? (
          <form className="people-assign" onSubmit={(e) => void submit(e)} aria-label={`「${task.title}」の担当`}>
            <label className="people-assign-field">
              <span className="sr-only">担当者</span>
              <AssigneeSelect members={members} value={chosen} onChange={setChosen} disabled={busy} />
            </label>
            <button type="submit" disabled={chosen === null || busy}>
              {busy ? '付けています…' : '担当を付ける'}
            </button>
          </form>
        ) : (
          <p className="people-note">{assignNote}</p>
        ))}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
