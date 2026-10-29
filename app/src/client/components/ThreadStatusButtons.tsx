import { useState } from 'react';
import { HANDLING_STATUSES, STATUS_LABELS, type HandlingStatus, type ThreadStatusResponse } from '../../shared/api';
import { api, toFailure } from '../api';

/**
 * One click sets the status of every message of a committee-mail thread (list rows and the top of a thread).
 * The pressed button is the thread's status; none is pressed while its messages differ.
 */
export function ThreadStatusButtons({ threadId, subject, statuses, onChanged }: { threadId: string; subject: string; statuses: HandlingStatus[]; onChanged: () => void }) {
  const [saving, setSaving] = useState<HandlingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server's answer is shown until the reloaded list or thread brings newer statuses.
  const [saved, setSaved] = useState<{ from: string; statuses: HandlingStatus[] } | null>(null);
  const key = statuses.join(',');
  const shown = saved && saved.from === key ? saved.statuses : statuses;
  const current = shown.length === 1 ? shown[0] : null;

  async function choose(status: HandlingStatus) {
    if (saving || status === current) return;
    setSaving(status);
    setError(null);
    try {
      const result = await api<ThreadStatusResponse>('PATCH', `/api/threads/${encodeURIComponent(threadId)}/status`, { status });
      setSaved({ from: key, statuses: result.statuses });
      onChanged();
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="status-buttons" role="group" aria-label={`「${subject || '（件名なし）'}」の対応状況`} aria-busy={saving !== null}>
      {HANDLING_STATUSES.map((s) => (
        <button key={s} type="button" className={`status-button status-${s}`} aria-pressed={current === s} disabled={saving !== null} onClick={() => void choose(s)}>
          {STATUS_LABELS[s]}
        </button>
      ))}
      {saving && <span className="hint" role="status">保存中…</span>}
      {error && (
        <span className="status error compact" role="alert">
          変更できませんでした: {error}
        </span>
      )}
    </div>
  );
}
