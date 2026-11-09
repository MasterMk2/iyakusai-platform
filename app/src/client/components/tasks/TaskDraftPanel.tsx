import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { cleanText, TASK_DRAFT_LIMITS, type AssistantJob, type AssistantMeta, type TaskDraft, type TaskDraftItem } from '../../../shared/assistant';
import {
  DEPARTMENT_WORKSPACE_PREFIX,
  REQUIREMENT_FIELDS,
  REQUIREMENT_LABELS,
  TASK_LIMITS,
  taskNumber,
  type Department,
  type Requirements,
  type TaskMember,
  type TaskMutationResponse,
  type TaskView,
} from '../../../shared/tasks';
import { api, ApiFailure, fmtDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { isActive, newOperationId, StateTag } from '../bot/common';
import { useJobPoll } from '../bot/useJobPoll';
import { AssigneeSelect, DepartmentPicker, failureText, HelperPicker, shortDate } from './common';

// Task drafting (2026-11-09, contract docs/contracts/bot-front.md §9): the person writes an outline, the Bot proposes
// how to split it into tasks and who could take each one, and the person checks and corrects the proposal before
// the chosen tasks are created with the ordinary task API (parent first, then its children). Nothing is created
// until "起票する"; the proposal itself is only visible to the person who asked.

export type CreateMode = 'manual' | 'draft';
const MODE_KEY = 'tasks.createMode';

export function storedCreateMode(): CreateMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'draft' ? 'draft' : 'manual';
  } catch {
    return 'manual';
  }
}

export function storeCreateMode(mode: CreateMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // A private window may refuse storage; the choice then lasts until the page is reloaded.
  }
}

/** Whether the Bot can draft, from the Bot meta (one signed request; nothing when the Bot is off on this server). */
export function useDraftAvailability(enabled: boolean) {
  const load = useCallback(
    (signal: AbortSignal) => (enabled ? api<AssistantMeta>('GET', '/api/assistant/meta', undefined, signal) : Promise.resolve(null)),
    [enabled],
  );
  const meta = useLoader(load);
  return { available: meta.data?.features.taskdraft === true, botAlive: meta.data?.bot.alive ?? true };
}

/** 自分で書く / Bot に下書きを頼む, above the create form. */
export function CreateModeSwitch({ value, onChange }: { value: CreateMode; onChange: (mode: CreateMode) => void }) {
  return (
    <div className="view-switch task-create-mode" role="group" aria-label="作り方">
      <button type="button" aria-pressed={value === 'manual'} onClick={() => onChange('manual')}>
        自分で書く
      </button>
      <button type="button" aria-pressed={value === 'draft'} onClick={() => onChange('draft')} data-testid="create-mode-draft">
        Bot に下書きを頼む
      </button>
    </div>
  );
}

interface Row {
  key: string;
  include: boolean;
  title: string;
  tags: string[];
  deadline: string;
  assigneeId: string | null;
  helperIds: string[];
  reqs: Requirements;
  /** What the Bot proposed (its reason, the counts, the other candidates). */
  proposal: TaskDraftItem;
  state: 'idle' | 'saving' | 'done' | 'error';
  error?: string;
  task?: TaskView;
}

function rowFrom(key: string, item: TaskDraftItem, ctx: { members: Set<string>; known: Set<string>; fallbackTags: string[]; tagging: boolean }): Row {
  const assignee = item.assigneeId && ctx.members.has(item.assigneeId) ? item.assigneeId : null;
  const tags = ctx.tagging ? item.tags.filter((t) => ctx.known.has(t)) : [];
  return {
    key,
    include: true,
    title: item.title,
    tags: ctx.tagging ? (tags.length ? tags : ctx.fallbackTags).slice(0, TASK_LIMITS.tagsMax) : [],
    deadline: item.deadline ?? '',
    assigneeId: assignee,
    helperIds: assignee ? item.helperIds.filter((h) => h !== assignee && ctx.members.has(h)) : [],
    reqs: { purpose: item.purpose, deliverable: item.deliverable, completionCriteria: item.completionCriteria, openQuestions: item.openQuestions },
    proposal: item,
    state: 'idle',
  };
}

export function TaskDraftPanel({
  workspaceId,
  departments,
  initialTags,
  parent,
  nesting,
  helping,
  members,
  botAlive,
  onOpenTask,
  onListChanged,
}: {
  /** One-department list: tasks go here. Null with department tags: each task goes under its first department. */
  workspaceId: string | null;
  departments: Department[];
  initialTags: string[];
  /** Drafting from "＋ 子タスクを追加": the tasks go under this parent and no new parent is proposed. */
  parent: TaskView | null;
  /** The Task service has parent tasks. */
  nesting: boolean;
  helping: boolean;
  members: TaskMember[];
  botAlive: boolean;
  onOpenTask: (taskId: string) => void;
  onListChanged: () => void;
}) {
  const tagging = departments.length > 0;
  const [overview, setOverview] = useState('');
  const [deadline, setDeadline] = useState('');
  const [tags, setTags] = useState<string[]>(initialTags);
  const [useSources, setUseSources] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const poll = useJobPoll(jobId);
  const job = poll.job;

  // The last draft this person asked for (it may still be running after they left the screen).
  const loadRecent = useCallback(
    (signal: AbortSignal) => api<{ jobs: AssistantJob[] }>('GET', '/api/assistant/jobs?kind=taskdraft&mine=1&limit=1', undefined, signal).then((a) => a.jobs[0] ?? null),
    [],
  );
  const recent = useLoader(loadRecent);
  const resumable = !jobId && recent.data && (isActive(recent.data) || recent.data.state === 'done') ? recent.data : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = cleanText(overview);
    if (!text) {
      setFormError('概略を入力してください。');
      return;
    }
    setSending(true);
    setFormError(null);
    try {
      const answer = await api<{ job: AssistantJob }>('POST', '/api/assistant/taskdraft', {
        clientOperationId: newOperationId(),
        overview: text,
        deadline: deadline || null,
        ...(tagging ? { tags } : {}),
        ...(parent ? { parentId: parent.id } : {}),
        useSources,
      });
      setJobId(answer.job.id);
    } catch (err) {
      setFormError(failureText(err));
    } finally {
      setSending(false);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      await api('POST', `/api/assistant/jobs/${encodeURIComponent(job.id)}/cancel`, {});
    } catch {
      // Already running: the panel keeps waiting for the result.
    }
    poll.reload();
  }

  const restart = () => {
    setJobId(null);
    recent.retry();
  };

  if (jobId) {
    if (!job) {
      return poll.error ? (
        <p className="status error" role="alert">
          下書きの状態を取得できませんでした: {poll.error.message}
          <button type="button" onClick={poll.reload}>
            再試行
          </button>
        </p>
      ) : (
        <p className="status loading" role="status">
          下書きを読み込み中…
        </p>
      );
    }
    if (job.state === 'done' && job.result?.draft) {
      return (
        <DraftReview
          key={job.id}
          job={job}
          draft={job.result.draft}
          workspaceId={workspaceId}
          departments={departments}
          initialTags={initialTags}
          parent={parent}
          nesting={nesting}
          helping={helping}
          members={members}
          onOpenTask={onOpenTask}
          onListChanged={onListChanged}
          onRestart={restart}
        />
      );
    }
    return (
      <section className="task-draft" aria-labelledby="draft-wait-title" data-testid="task-draft-wait" data-state={job.state}>
        <header className="detail-head">
          <h2 id="draft-wait-title" className="thread-title">
            Bot の下書き <StateTag state={job.state} />
          </h2>
          <p className="hint">依頼の受付 {fmtDate(job.createdAt)}</p>
        </header>
        {job.state === 'queued' && (
          <p className="status loading" role="status">
            順番を待っています。{botAlive ? '' : 'Bot が応答していないため、動き出すまで時間がかかるかもしれません。'}
          </p>
        )}
        {job.state === 'running' && (
          <p className="status loading" role="status" data-testid="task-draft-progress">
            {job.progress?.text || 'Bot がタスクの分け方と担当の案を考えています…'}（ふつう 1〜2 分）
          </p>
        )}
        {job.state === 'failed' && (
          <p className="status error" role="alert">
            {job.error?.message || '下書きを作れませんでした。'}
          </p>
        )}
        {job.state === 'canceled' && <p className="empty">この依頼は取り消しました。</p>}
        {job.state === 'done' && (
          <p className="status error" role="alert">
            下書きを読み取れませんでした。もう一度依頼してください。
          </p>
        )}
        <p className="hint">この画面を離れても下書きは作られます。あとで「＋ 新しいタスク」の「Bot に下書きを頼む」から開けます。</p>
        <div className="actions form-actions">
          {job.state === 'queued' && (
            <button type="button" className="secondary" onClick={() => void cancel()}>
              依頼を取り消す
            </button>
          )}
          {!isActive(job) && (
            <button type="button" onClick={restart}>
              概略を直して頼み直す
            </button>
          )}
        </div>
      </section>
    );
  }

  const length = overview.length;
  return (
    <form className="task-create task-draft" onSubmit={(e) => void submit(e)} aria-label="Bot に下書きを頼む" data-testid="task-draft-form">
      <header className="detail-head">
        <h2 className="thread-title">新しいタスク（Bot の下書き）</h2>
        <p className="hint">
          やりたいことの概略を書くと、Bot がタスクに分けて担当の案を付けます。案はあなたにだけ見え、確かめて直してから起票します。
        </p>
      </header>
      {resumable && (
        <p className="status info" role="status">
          前回の下書き（{fmtDate(resumable.createdAt)}・{isActive(resumable) ? '作成中' : 'できています'}）
          <button type="button" className="link-button" onClick={() => setJobId(resumable.id)}>
            開く
          </button>
        </p>
      )}
      {parent && (
        <p className="hint" data-testid="task-draft-parent">
          {taskNumber(parent.id)}「{parent.title}」の子タスクとして下書きします。
        </p>
      )}
      <div className="form-grid">
        <label className="field-wide" htmlFor="draft-overview">
          概略（必須・{TASK_DRAFT_LIMITS.overviewMax} 文字以内）
          <span className="hint" id="draft-overview-hint">
            何を・いつまでに・誰と（決まっていれば）。例：11/23 の片付け。テントの撤去、ゴミの回収、借りた物品の返却まで。
          </span>
          <textarea
            id="draft-overview"
            rows={6}
            maxLength={TASK_DRAFT_LIMITS.overviewMax}
            value={overview}
            disabled={sending}
            aria-describedby="draft-overview-hint draft-overview-count"
            onChange={(e) => setOverview(e.target.value)}
            data-testid="task-draft-overview"
          />
          <span id="draft-overview-count" className={`counter ${length >= TASK_DRAFT_LIMITS.overviewMax ? 'over' : ''}`}>
            {length}／{TASK_DRAFT_LIMITS.overviewMax}字
          </span>
        </label>
        <label>
          全体の期限の目安（任意）
          <input type="date" value={deadline} disabled={sending} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <label className="task-draft-check">
          <span>
            <input type="checkbox" checked={useSources} disabled={sending} onChange={(e) => setUseSources(e.target.checked)} /> 委員会の資料も参考にする
          </span>
          <span className="hint">過去の年度の段取りを手がかりにします。少し時間が延びます。</span>
        </label>
        {tagging && (
          <div className="field-wide">
            <DepartmentPicker departments={departments} value={tags} onChange={setTags} disabled={sending} legend={`関係する部局（任意・${TASK_LIMITS.tagsMax} つまで）`} />
          </div>
        )}
      </div>
      {!botAlive && (
        <p className="status warning" role="status">
          Bot が応答していません。依頼はできますが、Bot が動き出すまで下書きは作られません。
        </p>
      )}
      {formError && (
        <p className="status error" role="alert">
          {formError}
        </p>
      )}
      <div className="actions form-actions">
        <button type="submit" disabled={sending} data-testid="task-draft-submit">
          {sending ? '依頼しています…' : 'Bot に下書きしてもらう'}
        </button>
      </div>
    </form>
  );
}

function DraftReview({
  job,
  draft,
  workspaceId,
  departments,
  initialTags,
  parent,
  nesting,
  helping,
  members,
  onOpenTask,
  onListChanged,
  onRestart,
}: {
  job: AssistantJob;
  draft: TaskDraft;
  workspaceId: string | null;
  departments: Department[];
  initialTags: string[];
  parent: TaskView | null;
  nesting: boolean;
  helping: boolean;
  members: TaskMember[];
  onOpenTask: (taskId: string) => void;
  onListChanged: () => void;
  onRestart: () => void;
}) {
  const tagging = departments.length > 0;
  const assignable = new Set(members.filter((m) => m.active && m.role !== 'viewer').map((m) => m.userId));
  const ctx = { members: assignable, known: new Set(departments.map((d) => d.key)), fallbackTags: initialTags.length ? initialTags : departments.slice(0, 1).map((d) => d.key), tagging };
  // The existing parent: the one the form was opened from, else the one the draft was asked under.
  const underId = parent?.id ?? draft.parentTask?.id ?? null;
  const [parentRow, setParentRow] = useState<Row | null>(() => (nesting && !underId && draft.parent ? rowFrom('parent', draft.parent, ctx) : null));
  const [rows, setRows] = useState<Row[]>(() => draft.items.map((item, i) => rowFrom(`item-${i}`, item, ctx)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ops = useRef<Record<string, { key: string; id: string }>>({});
  const changed = useRef(false);

  const chosen = rows.filter((r) => r.include);
  const makingParent = parentRow?.include === true;
  const pending = (makingParent && parentRow && parentRow.state !== 'done' ? 1 : 0) + chosen.filter((r) => r.state !== 'done').length;
  const allDone = chosen.length > 0 && pending === 0;

  useEffect(() => {
    if (allDone && changed.current) {
      changed.current = false;
      onListChanged();
    }
  }, [allDone, onListChanged]);

  const update = (key: string, patch: Partial<Row>) => {
    if (key === 'parent') setParentRow((r) => (r ? { ...r, ...patch } : r));
    else setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  async function createRow(row: Row, parentId: string | null): Promise<TaskView | null> {
    const title = row.title.trim();
    if (!title) {
      update(row.key, { state: 'error', error: 'タイトルを入力してください。' });
      return null;
    }
    if (tagging && row.tags.length === 0) {
      update(row.key, { state: 'error', error: '部局を 1 つ以上選んでください。' });
      return null;
    }
    const target = workspaceId ?? DEPARTMENT_WORKSPACE_PREFIX + (row.tags[0] ?? '');
    const payload = {
      title,
      assigneeId: row.assigneeId,
      deadline: row.deadline || null,
      requirements: row.reqs,
      ...(tagging ? { tags: row.tags } : {}),
      ...(parentId ? { parentId } : {}),
      ...(helping && row.assigneeId && row.helperIds.length ? { helperIds: row.helperIds } : {}),
    };
    // A retry of the same content keeps its operation ID, so a lost answer never creates the task twice.
    const key = JSON.stringify({ target, payload });
    const prev = ops.current[row.key];
    const operationId = prev?.key === key ? prev.id : newOperationId();
    ops.current[row.key] = { key, id: operationId };
    update(row.key, { state: 'saving', error: undefined });
    try {
      const res = await api<TaskMutationResponse>('POST', `/api/tasks/workspaces/${encodeURIComponent(target)}/tasks`, { operationId, ...payload });
      update(row.key, { state: 'done', task: res.task });
      changed.current = true;
      return res.task;
    } catch (err) {
      if (err instanceof ApiFailure && err.status >= 400 && err.status < 500) delete ops.current[row.key];
      update(row.key, { state: 'error', error: failureText(toFailure(err)) });
      return null;
    }
  }

  async function createAll() {
    if (chosen.length === 0) {
      setError('起票するタスクを 1 つ以上選んでください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let under = underId;
      if (makingParent && parentRow) {
        const made = parentRow.task ?? (await createRow(parentRow, null));
        if (!made) {
          setError('親タスクを起票できなかったため、子タスクは起票していません。直してから、もう一度押してください。');
          return;
        }
        under = made.id;
      }
      let failed = 0;
      for (const row of chosen) {
        if (row.task) continue;
        if (!(await createRow(row, nesting ? under : null))) failed++;
      }
      if (failed > 0) setError(`${failed} 件を起票できませんでした。各行の理由を見て直し、もう一度押すと残りだけを起票します。`);
    } finally {
      setBusy(false);
    }
  }

  if (allDone) {
    const made = [...(makingParent && parentRow?.task ? [parentRow.task] : []), ...chosen.flatMap((r) => (r.task ? [r.task] : []))];
    // The project the tasks went under (new or existing), else the first task.
    const projectId = underId ?? (makingParent ? (parentRow?.task?.id ?? null) : null);
    const openId = projectId ?? made[0]?.id ?? null;
    return (
      <section className="task-draft" aria-labelledby="draft-done-title" data-testid="task-draft-done">
        <header className="detail-head">
          <h2 id="draft-done-title" className="thread-title">
            起票しました（{made.length} 件）
          </h2>
        </header>
        <p className="status ok" role="status">
          タスクを登録しました。Discord の /todo からも同じタスクが見えます。
        </p>
        <ul className="task-draft-made">
          {made.map((t) => (
            <li key={t.id}>
              <button type="button" className="link-button" onClick={() => onOpenTask(t.id)}>
                {taskNumber(t.id)} {t.title}
              </button>
              <span className="hint">{t.assignee?.displayName ?? '未割当'}</span>
            </li>
          ))}
        </ul>
        <div className="actions form-actions">
          {openId && (
            <button type="button" onClick={() => onOpenTask(openId)} data-testid="task-draft-open">
              {projectId ? '親タスクを開く' : 'タスクを開く'}
            </button>
          )}
          <button type="button" className="secondary" onClick={onRestart}>
            続けて下書きを頼む
          </button>
        </div>
      </section>
    );
  }

  const memberName = (id: string) => members.find((m) => m.userId === id)?.displayName ?? id;
  return (
    <section className="task-create task-draft" aria-labelledby="draft-review-title" data-testid="task-draft-review">
      <header className="detail-head">
        <h2 id="draft-review-title" className="thread-title">
          Bot の下書き（{draft.items.length} 件）
        </h2>
        <p className="hint">
          担当は案です。本人に確かめてから起票してください。起票するまでの修正はこの画面にだけ残ります（依頼の受付 {fmtDate(job.createdAt)}）。
        </p>
      </header>
      {draft.notes && <p className="task-draft-notes">{draft.notes}</p>}
      {draft.questions.length > 0 && (
        <section className="task-draft-questions" aria-labelledby="draft-questions">
          <h3 id="draft-questions">決めておくこと</h3>
          <ul>
            {draft.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </section>
      )}
      {underId && <p className="hint">{taskNumber(underId)}「{parent?.title ?? draft.parentTask?.title ?? ''}」の子タスクとして起票します。</p>}
      {parentRow && (
        <DraftRow
          row={parentRow}
          label="親タスク（全体のまとめ）"
          includeLabel="親タスクを作って、下のタスクをまとめる"
          busy={busy}
          departments={departments}
          helping={false}
          members={members}
          memberName={memberName}
          onChange={(patch) => update('parent', patch)}
        />
      )}
      <ol className="task-draft-rows">
        {rows.map((row, i) => (
          <li key={row.key}>
            <DraftRow
              row={row}
              label={`${makingParent ? '子タスク' : 'タスク'} ${i + 1}`}
              includeLabel="起票する"
              busy={busy}
              departments={departments}
              helping={helping}
              members={members}
              memberName={memberName}
              onChange={(patch) => update(row.key, patch)}
            />
          </li>
        ))}
      </ol>
      {draft.sources.length > 0 && (
        <details className="task-draft-sources">
          <summary>Bot が参考にした資料（{draft.sources.length} 件）</summary>
          <ul>
            {draft.sources.map((s) => (
              <li key={s.label}>
                <span>{s.label}</span>
                <span className="hint">{s.excerpt}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions form-actions task-draft-actions">
        <button type="button" disabled={busy} onClick={() => void createAll()} data-testid="task-draft-create">
          {busy ? '起票しています…' : `選んだ ${pending} 件を起票する`}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onRestart}>
          概略を直して頼み直す
        </button>
      </div>
    </section>
  );
}

function DraftRow({
  row,
  label,
  includeLabel,
  busy,
  departments,
  helping,
  members,
  memberName,
  onChange,
}: {
  row: Row;
  label: string;
  includeLabel: string;
  busy: boolean;
  departments: Department[];
  helping: boolean;
  members: TaskMember[];
  memberName: (id: string) => string;
  onChange: (patch: Partial<Row>) => void;
}) {
  const locked = busy || row.state === 'done' || row.state === 'saving';
  const id = `draft-${row.key}`;
  const p = row.proposal;
  const chooseAssignee = (value: string | null) => onChange({ assigneeId: value, helperIds: value === null ? [] : row.helperIds.filter((h) => h !== value) });
  const others = p.alternatives.filter((a) => a.id !== row.assigneeId && members.some((m) => m.userId === a.id && m.active));
  return (
    <fieldset className={`task-draft-row ${row.include ? '' : 'excluded'}`} data-testid="task-draft-row" data-state={row.state}>
      <legend>{label}</legend>
      <div className="task-draft-include">
        <input id={`${id}-include`} type="checkbox" checked={row.include} disabled={locked} onChange={(e) => onChange({ include: e.target.checked })} />
        <label htmlFor={`${id}-include`}>{includeLabel}</label>
        {row.state === 'done' && row.task && <span className="chip task-status-done">起票済み {taskNumber(row.task.id)}</span>}
        {row.state === 'saving' && <span className="chip task-status-in_progress">起票中</span>}
        {!row.include && <span className="hint">（{row.title}）</span>}
      </div>
      {row.include && (
        <>
          <div className="form-grid">
            <label className="field-wide">
              タイトル（必須・{TASK_LIMITS.titleMax} 文字以内）
              <input value={row.title} maxLength={TASK_LIMITS.titleMax} disabled={locked} onChange={(e) => onChange({ title: e.target.value })} data-testid="task-draft-title" />
            </label>
            <label htmlFor={`${id}-assignee`}>
              {helping ? '主担当' : '担当者'}
              <AssigneeSelect id={`${id}-assignee`} members={members} value={row.assigneeId} disabled={locked} onChange={chooseAssignee} />
            </label>
            <label>
              期限（任意）
              <input type="date" value={row.deadline} disabled={locked} onChange={(e) => onChange({ deadline: e.target.value })} />
              {row.deadline && <span className="hint">{shortDate(row.deadline)}</span>}
            </label>
            <div className="field-wide task-draft-why">
              {p.assigneeName && p.assigneeId && members.some((m) => m.userId === p.assigneeId && m.active) ? (
                <p className="hint" data-testid="task-draft-reason">
                  {p.assigneeBy === 'rule' ? '規則で選んだ案' : 'Bot の案'}：{p.assigneeName}（{p.assigneeFacts}）{p.reason ? `— ${p.reason}` : ''}
                </p>
              ) : p.assigneeName ? (
                <p className="hint" data-testid="task-draft-reason">
                  Bot の案（{p.assigneeName}）はいまの委員の一覧にいないため、選んでいません。
                </p>
              ) : (
                <p className="hint" data-testid="task-draft-reason">
                  {p.reason || '担当の案はありません。'}
                </p>
              )}
              {others.length > 0 && !locked && (
                <p className="task-draft-others">
                  <span className="hint">ほかの候補：</span>
                  {others.map((a) => (
                    <button key={a.id} type="button" className="secondary compact" onClick={() => chooseAssignee(a.id)} title={a.facts}>
                      {a.name}
                      <span className="hint">（{a.facts.split('｜')[1] ?? a.facts}）</span>
                    </button>
                  ))}
                </p>
              )}
            </div>
            {helping && row.assigneeId && (
              <div className="field-wide">
                <label htmlFor={`${id}-helpers`}>副担当（任意）</label>
                <HelperPicker id={`${id}-helpers`} members={members} assignee={row.assigneeId} value={row.helperIds} disabled={locked} onChange={(v) => onChange({ helperIds: v })} known={row.helperIds.map((h) => ({ id: h, displayName: memberName(h) }))} />
              </div>
            )}
            {departments.length > 0 && (
              // The departments the Bot chose, folded: most rows keep them, and ten checkboxes on every row bury the rest.
              <details className="field-wide task-draft-tags" open={row.tags.length === 0}>
                <summary>
                  部局：{departments.filter((d) => row.tags.includes(d.key)).map((d) => d.label).join('・') || '未選択'}
                  <span className="hint">（押すと変えられます）</span>
                </summary>
                <DepartmentPicker departments={departments} value={row.tags} disabled={locked} onChange={(v) => onChange({ tags: v })} />
              </details>
            )}
          </div>
          <details className="task-draft-reqs">
            <summary>内容（目的・成果物・完了条件・不明点）</summary>
            <div className="form-grid">
              {REQUIREMENT_FIELDS.map((f) => (
                <label key={f}>
                  {REQUIREMENT_LABELS[f]}（任意）
                  <textarea rows={3} maxLength={TASK_LIMITS.textMax} value={row.reqs[f]} disabled={locked} onChange={(e) => onChange({ reqs: { ...row.reqs, [f]: e.target.value } })} />
                </label>
              ))}
            </div>
          </details>
          {row.state === 'error' && row.error && (
            <p className="status error" role="alert">
              {row.error}
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
