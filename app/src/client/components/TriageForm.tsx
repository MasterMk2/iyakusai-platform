import { useCallback, useState, type FormEvent } from 'react';
import { HANDLING_STATUSES, LIMITS, STATUS_LABELS, type AssigneeCandidate, type HandlingStatus, type TriageView } from '../../shared/api';
import { api, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

interface Draft {
  status: HandlingStatus;
  assigneeId: string;
  labels: string[];
}

function draftOf(t: TriageView): Draft {
  return { status: t.status, assigneeId: t.assignee?.id ?? '', labels: [...t.labels] };
}

function describe(d: Draft, names: Map<string, string>): string {
  return `状態=${STATUS_LABELS[d.status]}、担当=${d.assigneeId ? (names.get(d.assigneeId) ?? d.assigneeId) : 'なし'}、ラベル=${d.labels.join(', ') || 'なし'}`;
}

export const DONE_HINT = '「完了」にしても返信は送信されません。返信は Gmail で行ってください。';

/**
 * `basePath` is the item's API path, e.g. `/api/receipts/<id>` or `/api/line/conversations/<id>`.
 * `showStatus` is off where buttons above set the status of the whole thread (committee mail), so the
 * status is not offered twice; the save buttons appear only once something was changed.
 */
export function TriageForm({
  basePath,
  triage,
  onSaved,
  doneHint = DONE_HINT,
  canEditStatus = true,
  showStatus = true,
  scopeHint,
}: {
  basePath: string;
  triage: TriageView;
  onSaved: () => void;
  doneHint?: string;
  canEditStatus?: boolean;
  showStatus?: boolean;
  /** Where the handling applies (e.g. every mailbox the message is in). */
  scopeHint?: string;
}) {
  const [base, setBase] = useState<TriageView>(triage);
  const [draft, setDraft] = useState<Draft>(() => draftOf(triage));
  const [labelInput, setLabelInput] = useState('');
  const [error, setError] = useState<{ text: string; retryable: boolean } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadCandidates = useCallback(
    (signal: AbortSignal) => api<AssigneeCandidate[]>('GET', `${basePath}/assignees`, undefined, signal),
    [basePath],
  );
  const candidates = useLoader(loadCandidates);
  const names = new Map((candidates.data ?? []).map((c) => [c.id, c.displayName]));
  if (base.assignee) names.set(base.assignee.id, base.assignee.displayName);

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(base));

  // A reload brought a newer server version (e.g. another persona saved): adopt it,
  // but never discard an unsaved draft; the version check will report the conflict on save.
  const [seenVersion, setSeenVersion] = useState(triage.version);
  if (triage.version !== seenVersion) {
    setSeenVersion(triage.version);
    if (triage.version > base.version) {
      setBase(triage);
      if (!dirty) setDraft(draftOf(triage));
    }
  }

  function addLabel() {
    const label = labelInput.normalize('NFKC').trim();
    if (!label) return;
    if (label.length > LIMITS.labelMaxLength) {
      setError({ text: `ラベルは ${LIMITS.labelMaxLength} 文字以内で入力してください。`, retryable: false });
      return;
    }
    if (!draft.labels.includes(label) && draft.labels.length >= LIMITS.labelsPerReceipt) {
      setError({ text: `ラベルは ${LIMITS.labelsPerReceipt} 個までです。`, retryable: false });
      return;
    }
    setError(null);
    setDraft({ ...draft, labels: draft.labels.includes(label) ? draft.labels : [...draft.labels, label] });
    setLabelInput('');
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    setConflict(null);
    setSaved(false);
    try {
      const next = await api<TriageView>('PATCH', `${basePath}/triage`, {
        expectedVersion: base.version,
        ...(canEditStatus && showStatus && draft.status !== base.status ? { status: draft.status } : {}),
        ...(draft.assigneeId !== (base.assignee?.id ?? '') ? { assigneeId: draft.assigneeId || null } : {}),
        ...(JSON.stringify(draft.labels) !== JSON.stringify(base.labels) ? { labels: draft.labels } : {}),
      });
      setBase(next);
      setDraft(draftOf(next));
      setSaved(true);
      onSaved();
    } catch (err) {
      const failure = toFailure(err);
      if (failure.status === 409 && failure.body?.current) {
        // Show the newer state; keep what the user attempted visible so nothing is silently lost or overwritten.
        const latest = failure.body.current;
        setConflict(`保存できなかった変更: ${describe(draft, names)}`);
        setBase(latest);
        setDraft(draftOf(latest));
        onSaved();
      } else {
        setError({ text: failure.message, retryable: failure.status === 0 || failure.status >= 500 });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="triage" onSubmit={(e) => void save(e)} aria-label="対応情報の編集">
      <div className="triage-row">
        {showStatus && (
          <label className="triage-field">
            対応状況
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as HandlingStatus })} disabled={!canEditStatus}>
              {HANDLING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="triage-field">
          担当者
          <select value={draft.assigneeId} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })} disabled={!candidates.data}>
            <option value="">担当なし</option>
            {(candidates.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
            {base.assignee && !(candidates.data ?? []).some((c) => c.id === base.assignee?.id) && (
              <option value={base.assignee.id}>{base.assignee.displayName}（担当対象外）</option>
            )}
          </select>
        </label>
        <div className="triage-field triage-labels">
          <span className="triage-label-caption">ラベル</span>
          <span className="labels-edit">
            {draft.labels.map((l) => (
              <span key={l} className="chip label">
                {l}
                <button type="button" className="chip-remove" aria-label={`ラベル「${l}」を外す`} onClick={() => setDraft({ ...draft, labels: draft.labels.filter((x) => x !== l) })}>
                  ×
                </button>
              </span>
            ))}
            <span className="label-input-row">
              <input
                aria-label="追加するラベル"
                placeholder="例：要確認"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLabel();
                  }
                }}
              />
              <button type="button" className="secondary small" onClick={addLabel}>
                追加
              </button>
            </span>
          </span>
        </div>
      </div>
      <LoadStatus loader={candidates} what="担当者候補" compact />
      {base.assignee?.hasMailboxAccess === false && (
        <p className="status warning">現在の担当者はこの受信箱の閲覧権限を失っています。担当を付けても権限は付与されません。</p>
      )}
      {canEditStatus && showStatus && doneHint && <p className="hint">{doneHint}</p>}
      {scopeHint && <p className="hint">{scopeHint}</p>}
      {conflict && (
        <div className="status conflict" role="alert">
          他の利用者が先に更新したため保存しませんでした。最新の内容を表示しています。{conflict}
        </div>
      )}
      {error && (
        <div className="status error" role="alert">
          保存できませんでした: {error.text}
          {error.retryable && (
            <button type="button" onClick={() => void save()} disabled={saving}>
              再試行
            </button>
          )}
        </div>
      )}
      {saved && !dirty && <p className="status ok" role="status">保存しました。</p>}
      <div className={`actions triage-actions ${dirty || saving ? '' : 'idle'}`}>
        <span className="draft-indicator" aria-live="polite">{dirty ? '未保存の変更があります' : ''}</span>
        <button type="submit" disabled={saving || !dirty}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={saving || !dirty}
          onClick={() => {
            setDraft(draftOf(base));
            setError(null);
            setLabelInput('');
          }}
        >
          変更を取り消す
        </button>
      </div>
    </form>
  );
}
