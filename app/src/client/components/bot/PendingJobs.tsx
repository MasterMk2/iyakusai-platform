import { useCallback, useState } from 'react';
import type { AssistantJob } from '../../../shared/assistant';
import { api, fmtDate, toFailure, type ApiFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { ErrorLine, isActive, KIND_LABELS, StateTag, summaryOf } from './common';

const kindLabel = (job: AssistantJob) => (job.kind === 'ask' || job.kind === 'doc' || job.kind === 'image' ? KIND_LABELS[job.kind] : job.kind);

/**
 * My requests still waiting for the Bot (shown while the Bot does not answer): they are kept and
 * handled when it runs again. A request still queued can be cancelled here.
 */
export function PendingJobs({ openedJobId }: { openedJobId: string | null }) {
  const [version, setVersion] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      // A new request (its job ID is opened) is read again, so the list shows it.
      void version;
      void openedJobId;
      return api<{ jobs: AssistantJob[]; next: string | null }>('GET', '/api/assistant/jobs?mine=1&limit=20', undefined, signal);
    },
    [version, openedJobId],
  );
  const list = useLoader(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const waiting = (list.data?.jobs ?? []).filter(isActive);

  async function cancel(job: AssistantJob) {
    setBusy(job.id);
    setError(null);
    try {
      await api<{ job: AssistantJob }>('POST', `/api/assistant/jobs/${encodeURIComponent(job.id)}/cancel`, {});
      setVersion((n) => n + 1);
    } catch (err) {
      setError(toFailure(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel bot-waiting" aria-labelledby="waiting-title" data-testid="bot-waiting">
      <h2 id="waiting-title">待機中の依頼（あなたのもの）</h2>
      {list.loading && <p className="status loading" role="status">読み込み中…</p>}
      {list.error && <ErrorLine error={list.error} what="待機中の依頼を読み込み" onRetry={list.retry} />}
      {list.data && waiting.length === 0 && <p className="empty">待機中の依頼はありません。</p>}
      {waiting.length > 0 && (
        <>
          <p className="hint">Bot が動き出すと、順に処理されます。まだ待機中の依頼は取り消せます。</p>
          <ul className="rows">
            {waiting.map((job) => (
              <li key={job.id} data-testid="waiting-job">
                <span className="row-main">
                  {kindLabel(job)}：{summaryOf(job)}
                </span>
                <span className="row-sub">依頼 {fmtDate(job.createdAt)}</span>
                <StateTag state={job.state} />
                {job.state === 'queued' && (
                  <button type="button" className="secondary" disabled={busy !== null} onClick={() => cancel(job)}>
                    取り消す
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <ErrorLine error={error} what="取り消し" />}
    </section>
  );
}
