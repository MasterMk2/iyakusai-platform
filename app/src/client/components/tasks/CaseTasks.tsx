import { useCallback, useState, type FormEvent } from 'react';
import {
  REQUIREMENT_FIELDS,
  REQUIREMENT_LABELS,
  TASK_LIMITS,
  type CaseKind,
  type CaseTaskFields,
  type CaseTaskResponse,
  type CaseTasksResponse,
  type TaskContextResponse,
} from '../../../shared/tasks';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { AssigneeSelect, failureText, newOperationId, StatusChip, useMembers } from './common';

/** Neutral starting title: the subject or message text is never copied automatically. */
const DEFAULT_TITLE = '受信案件の対応';

/**
 * Tasks linked to one received case (mail receipt or LINE conversation) and the form that
 * creates an assigned task from it. Shown only inside a case the user may already read.
 */
export function CaseTasks({ kind, sourceId }: { kind: CaseKind; sourceId: string }) {
  const [refresh, setRefresh] = useState(0);
  const base = `/api/cases/${kind}/${encodeURIComponent(sourceId)}/tasks`;
  const loadLinks = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<CaseTasksResponse>('GET', base, undefined, signal);
    },
    [base, refresh],
  );
  const links = useLoader(loadLinks);
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function retryPending(p: CaseTasksResponse['pending'][number]) {
    setRetrying(p.clientOperationId);
    setMessage(null);
    try {
      const res = await api<CaseTaskResponse>('POST', base, { clientOperationId: p.clientOperationId, ...p.input });
      setMessage({ kind: 'ok', text: `作成を確定しました（${res.task.id}）。` });
      setRefresh((n) => n + 1);
    } catch (err) {
      setMessage({ kind: 'error', text: failureText(err) });
    } finally {
      setRetrying(null);
    }
  }

  const data = links.data;
  if (links.error?.status === 404 || links.error?.status === 403) return null;
  if (data && !data.canCreate && data.tasks.length === 0 && data.pending.length === 0 && !data.unavailable) return null;
  return (
    <section className="case-tasks" aria-label="関連タスク" data-testid="case-tasks">
      <h4>関連タスク</h4>
      <LoadStatus loader={links} what="関連タスク" compact />
      {data && (
        <>
          {data.unavailable && <p className="status warning">タスクサービスに接続できないため、関連タスクの一部を確認できません。</p>}
          {data.tasks.length === 0 && !data.unavailable && <p className="hint">表示できる関連タスクはありません。</p>}
          <ul>
            {data.tasks.map((t) => (
              <li key={t.id}>
                <a href={`#/tasks?ws=${encodeURIComponent(t.workspaceId)}&task=${encodeURIComponent(t.id)}`} data-linked-task={t.id}>
                  {t.title}
                </a>{' '}
                <StatusChip status={t.status} />
              </li>
            ))}
          </ul>
          {data.pending.map((p) => (
            <div key={p.clientOperationId} className="status warning" role="alert" data-testid="case-task-pending">
              {fmtDate(p.requestedAt)} の作成依頼「{p.input.title}」の結果が未確定です。同じ内容で再試行すると、重複せずに確定します。
              <button type="button" disabled={retrying !== null} onClick={() => void retryPending(p)}>
                {retrying === p.clientOperationId ? '確認中…' : '再試行'}
              </button>
            </div>
          ))}
          {message && (
            <p className={`status ${message.kind}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
              {message.text}
            </p>
          )}
          {data.canCreate &&
            (open ? (
              <CaseTaskForm
                base={base}
                onCancel={() => setOpen(false)}
                onDone={(res) => {
                  setOpen(false);
                  setMessage({ kind: 'ok', text: `タスクを作成しました（${res.task.id}）。` });
                  setRefresh((n) => n + 1);
                }}
                onPendingChanged={() => setRefresh((n) => n + 1)}
              />
            ) : (
              <button type="button" onClick={() => setOpen(true)}>
                この案件からタスクを作成
              </button>
            ))}
        </>
      )}
    </section>
  );
}

function CaseTaskForm({ base, onCancel, onDone, onPendingChanged }: { base: string; onCancel: () => void; onDone: (res: CaseTaskResponse) => void; onPendingChanged: () => void }) {
  const loadContext = useCallback((signal: AbortSignal) => api<TaskContextResponse>('GET', '/api/tasks/context', undefined, signal), []);
  const context = useLoader(loadContext);
  const eligible = (context.data?.memberships ?? []).filter((m) => m.role !== 'viewer');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const ws = workspaceId ?? eligible[0]?.workspace.id ?? null;
  const members = useMembers(ws);
  const [fields, setFields] = useState<Omit<CaseTaskFields, 'workspaceId'>>({
    title: DEFAULT_TITLE,
    assigneeId: null,
    deadline: null,
    requirements: { purpose: '', deliverable: '', completionCriteria: '', openQuestions: '' },
  });
  // One operation per submission: a retry after a failure or lost answer reuses it.
  const [operation, setOperation] = useState<{ id: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ws) return;
    if (fields.title.trim() === '') {
      setError('タイトルを入力してください。');
      return;
    }
    const input: CaseTaskFields = { workspaceId: ws, ...fields };
    const key = JSON.stringify(input);
    const id = operation?.key === key ? operation.id : newOperationId();
    setOperation({ id, key });
    setBusy(true);
    setError(null);
    try {
      onDone(await api<CaseTaskResponse>('POST', base, { clientOperationId: id, ...input }));
    } catch (err) {
      setError(failureText(err));
      onPendingChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="case-task-form" onSubmit={(e) => void submit(e)} aria-label="受信案件からタスクを作成">
      <p className="hint">
        件名・本文・添付はタスクに自動では転記しません。タスクを読める委員に共有してよい内容だけを入力してください。元の案件は、案件を閲覧できる人にだけ表示されます。
      </p>
      <LoadStatus loader={context} what="委員会" compact />
      {context.data && eligible.length === 0 && <p className="status info">タスクを作成できる委員会がありません（編集者以上の役割が必要です）。</p>}
      {eligible.length > 0 && (
        <>
          <label>
            委員会
            <select
              value={ws ?? ''}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setFields({ ...fields, assigneeId: null });
              }}
              data-testid="case-task-workspace"
            >
              {eligible.map((m) => (
                <option key={m.workspace.id} value={m.workspace.id}>
                  {m.workspace.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="case-task-assignee">担当者（選んだ委員会の有効なメンバーのみ・未割当も可）</label>
          <AssigneeSelect id="case-task-assignee" members={members.data ?? []} value={fields.assigneeId} onChange={(v) => setFields({ ...fields, assigneeId: v })} />
          <LoadStatus loader={members} what="担当者の候補" compact />
          <label>
            タイトル
            <input value={fields.title} maxLength={TASK_LIMITS.titleMax} onChange={(e) => setFields({ ...fields, title: e.target.value })} />
          </label>
          <label>
            期限（任意）
            <input type="date" value={fields.deadline ?? ''} onChange={(e) => setFields({ ...fields, deadline: e.target.value || null })} />
          </label>
          {REQUIREMENT_FIELDS.map((f) => (
            <label key={f}>
              {REQUIREMENT_LABELS[f]}
              <textarea
                rows={2}
                maxLength={TASK_LIMITS.textMax}
                value={fields.requirements[f]}
                onChange={(e) => setFields({ ...fields, requirements: { ...fields.requirements, [f]: e.target.value } })}
              />
            </label>
          ))}
        </>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy || !ws}>
          {busy ? '作成中…' : error ? '同じ内容で再試行' : 'タスクを作成'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          キャンセル
        </button>
      </div>
    </form>
  );
}
