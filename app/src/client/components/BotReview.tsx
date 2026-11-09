import { useCallback, useId, useRef, useState } from 'react';
import type { AssistantJob, AssistantMeta } from '../../shared/assistant';
import { api, toFailure, type ApiFailure } from '../api';
import { useLoader } from '../useLoader';
import { ErrorLine, operationFor, settleOperation, type OperationSlots } from './bot/common';
import { JobPanel } from './bot/JobPanel';
import { useJobPoll } from './bot/useJobPoll';

/**
 * Proofreading and fact-checking by the Bot while writing something to send (mail 2026-10-26, official LINE
 * 2026-11-09). Shown only when the Bot's documents are on. Pressing the button sends `request.content` as a /doc
 * job; the answer stays here while the text is changed, and says so when it was for an earlier text.
 */
export function BotReview({
  request,
  empty,
  intro,
  changedWhat,
  testId,
}: {
  /** What the Bot is asked (built by the caller without addresses or IDs), and whether the text was cut. */
  request: { content: string; cut: boolean };
  /** Nothing written yet: the button waits. */
  empty: boolean;
  /** What is checked and what goes to the Bot, in a sentence or two. */
  intro: string;
  /** What may have changed since asking, e.g. "件名か本文". */
  changedWhat: string;
  testId: string;
}) {
  const loadMeta = useCallback((signal: AbortSignal) => api<AssistantMeta>('GET', '/api/assistant/meta', undefined, signal).catch(() => null), []);
  const meta = useLoader(loadMeta).data;
  const [jobId, setJobId] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ content: string; cut: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const slots = useRef<OperationSlots>({});
  const poll = useJobPoll(jobId);
  const titleId = useId();
  if (!meta?.features.doc) return null;

  const share = meta.shareChannel ? `依頼と結果は Discord の #${meta.shareChannel.name} にも投稿されます。` : null;

  async function ask() {
    const input = { docType: 'free', content: request.content, format: 'txt', useSources: true, model: 'auto' };
    const clientOperationId = operationFor(slots.current, 'review', JSON.stringify(input));
    setBusy(true);
    setError(null);
    try {
      const answer = await api<{ job: AssistantJob }>('POST', '/api/assistant/jobs', { clientOperationId, kind: 'doc', input });
      slots.current.review = null;
      setJobId(answer.job.id);
      setAsked(request);
    } catch (err) {
      settleOperation(slots.current, 'review', err);
      setError(toFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mail-review" aria-labelledby={titleId} data-testid={testId}>
      <h4 id={titleId}>Bot に校閲・ファクトチェックを頼む</h4>
      <p className="hint">
        {intro}
        {share}
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => void ask()} disabled={busy || empty} data-testid={`${testId}-ask`}>
          {busy ? '依頼しています…' : jobId ? 'いまの本文で、もう一度頼む' : '校閲・ファクトチェックを頼む'}
        </button>
      </div>
      {error && <ErrorLine error={error} what="校閲の依頼を送る" />}
      {jobId && <JobPanel job={poll.job} loading={poll.loading} error={poll.error} title="校閲・ファクトチェックの結果" onRetry={poll.reload} />}
      {asked?.cut && <p className="hint">本文が長いので、最初の部分だけを確かめてもらっています。</p>}
      {asked && asked.content !== request.content && <p className="hint">依頼したあとで{changedWhat}が変わっています。直した後の文で確かめるときは、もう一度頼んでください。</p>}
    </section>
  );
}
