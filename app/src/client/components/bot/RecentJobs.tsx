import { useCallback, useState } from 'react';
import type { AssistantJob } from '../../../shared/assistant';
import { api, fmtDate, toFailure, type ApiFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { ErrorLine, StateTag, summaryOf } from './common';

interface JobsPage {
  jobs: AssistantJob[];
  next: string | null;
}

/**
 * Jobs of one kind, newest first, from every committee member (../docs/contracts/bot-front.md §3-3).
 * "もっと見る" follows the server's cursor. Reload (reloadKey) starts again from the newest. `filter` keeps
 * only some of the kind (the mail screen shows the doc jobs of docType mail); a page may then show fewer rows.
 */
export function RecentJobs({
  kind,
  title,
  reloadKey,
  onOpen,
  filter,
  testId,
}: {
  kind: 'ask' | 'doc' | 'image';
  title: string;
  reloadKey: number;
  onOpen: (jobId: string) => void;
  filter?: (job: AssistantJob) => boolean;
  testId?: string;
}) {
  const loadFirst = useCallback(
    (signal: AbortSignal) => {
      void reloadKey;
      return api<JobsPage>('GET', `/api/assistant/jobs?kind=${kind}&limit=20`, undefined, signal);
    },
    [kind, reloadKey],
  );
  const first = useLoader(loadFirst);
  // Pages after the first belong to the first page they were read with; a reload drops them.
  const [more, setMore] = useState<{ reloadKey: number; jobs: AssistantJob[]; next: string | null } | null>(null);
  const [moreError, setMoreError] = useState<ApiFailure | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const page = first.data;
  const current = more && more.reloadKey === reloadKey ? more : null;
  const read = page ? [...page.jobs, ...(current?.jobs ?? [])] : [];
  const jobs = filter ? read.filter(filter) : read;
  const next = current ? current.next : (page?.next ?? null);
  const id = testId ?? `recent-${kind}`;

  const loadMore = async () => {
    if (!next) return;
    setMoreLoading(true);
    setMoreError(null);
    try {
      const older = await api<JobsPage>('GET', `/api/assistant/jobs?kind=${kind}&limit=20&before=${encodeURIComponent(next)}`);
      setMore({ reloadKey, jobs: [...(current?.jobs ?? []), ...older.jobs], next: older.next });
    } catch (err) {
      setMoreError(toFailure(err));
    } finally {
      setMoreLoading(false);
    }
  };

  return (
    <section className="panel bot-recent" aria-labelledby={id} data-testid={id}>
      <div className="panel-head">
        <h2 id={id}>{title}</h2>
      </div>
      {first.loading && <p className="status loading" role="status">読み込み中…</p>}
      {first.error && <ErrorLine error={first.error} what={`${title}の一覧を読み込み`} onRetry={first.retry} />}
      {page && jobs.length === 0 && <p className="empty">{read.length > 0 && next ? '最近の依頼の中にはありません。「もっと見る」で前の依頼を探せます。' : 'まだ依頼はありません。'}</p>}
      {jobs.length > 0 && (
        <ul className="bot-recent-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <button type="button" className="bot-recent-item" data-testid="recent-item" data-job={job.id} onClick={() => onOpen(job.id)}>
                <span className="bot-recent-text">{summaryOf(job)}</span>
                <span className="row-sub">
                  {job.actor.name}・{fmtDate(job.createdAt)}
                </span>
                <StateTag state={job.state} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {moreError && <ErrorLine error={moreError} what="続きを読み込み" />}
      {next && (
        <button type="button" className="secondary" onClick={loadMore} disabled={moreLoading} data-testid="recent-more">
          {moreLoading ? '読み込み中…' : 'もっと見る'}
        </button>
      )}
    </section>
  );
}
