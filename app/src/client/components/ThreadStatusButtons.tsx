import { useState } from 'react';
import { HANDLING_STATUSES, STATUS_LABELS, type HandlingStatus, type ThreadStatusResponse, type TriageView } from '../../shared/api';
import { api, toFailure } from '../api';

/** A committee-mail thread, or an official LINE conversation (its status changes from the version shown). */
export type StatusTarget = { kind: 'thread'; threadId: string } | { kind: 'line'; conversationId: string; version: number };

async function saveStatus(target: StatusTarget, status: HandlingStatus): Promise<HandlingStatus[]> {
  if (target.kind === 'thread') return (await api<ThreadStatusResponse>('PATCH', `/api/threads/${encodeURIComponent(target.threadId)}/status`, { status })).statuses;
  const triage = await api<TriageView>('PATCH', `/api/line/conversations/${encodeURIComponent(target.conversationId)}/triage`, { expectedVersion: target.version, status });
  return [triage.status];
}

/**
 * One click sets the status of every message of a committee-mail thread, or of a LINE conversation (list rows and
 * the top of a thread). The pressed button is the status; none is pressed while a thread's messages differ.
 */
export function ThreadStatusButtons({ target, subject, statuses, onChanged }: { target: StatusTarget; subject: string; statuses: HandlingStatus[]; onChanged: () => void }) {
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
      setSaved({ from: key, statuses: await saveStatus(target, status) });
      onChanged();
    } catch (err) {
      setError(toFailure(err).message);
      // Someone else changed the conversation first: reload so the next click starts from their version.
      if (target.kind === 'line') onChanged();
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
