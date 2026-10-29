import { useCallback, useRef, useState } from 'react';
import type { AssistantJob, AssistantMeta } from '../../shared/assistant';
import { composeMailReviewRequest } from '../../shared/mailReview';
import { ownText } from '../../shared/mailScreen';
import { api, toFailure, type ApiFailure } from '../api';
import { useLoader } from '../useLoader';
import { ErrorLine, operationFor, settleOperation, type OperationSlots } from './bot/common';
import { JobPanel } from './bot/JobPanel';
import { useJobPoll } from './bot/useJobPoll';

/**
 * Proofreading and fact-checking by the Bot while writing a committee mail (2026-10-26). Shown only when the
 * Bot's documents are on. Pressing the button sends the subject, the recipients' names and the person's own
 * text (no quoted mail, no addresses) as a /doc job; the answer stays here while the mail is changed.
 */
export function MailReview({ subject, body, toNames, fromName }: { subject: string; body: string; toNames: string[]; fromName: string }) {
  const loadMeta = useCallback((signal: AbortSignal) => api<AssistantMeta>('GET', '/api/assistant/meta', undefined, signal).catch(() => null), []);
  const meta = useLoader(loadMeta).data;
  const [jobId, setJobId] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ content: string; cut: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const slots = useRef<OperationSlots>({});
  const poll = useJobPoll(jobId);
  if (!meta?.features.doc) return null;

  const share = meta.shareChannel ? `依頼と結果は Discord の #${meta.shareChannel.name} にも投稿されます。` : null;
  const request = composeMailReviewRequest({ subject, toNames, body: ownText(body), fromName });
  const empty = !subject.trim() && !ownText(body).trim();

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
    <section className="mail-review" aria-labelledby="mail-review-title" data-testid="mail-review">
      <h4 id="mail-review-title">Bot に校閲・ファクトチェックを頼む</h4>
      <p className="hint">
        誤字・敬語、日付・曜日・金額・名称などを委員会の資料と照らした食い違い、宛名・署名の有無を Bot（AI）が確かめます。件名・宛先の名前・本文（引用した部分を除く）が Bot に渡ります。メールアドレスは渡しません。{share}
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => void ask()} disabled={busy || empty} data-testid="mail-review-ask">
          {busy ? '依頼しています…' : jobId ? 'いまの本文で、もう一度頼む' : '校閲・ファクトチェックを頼む'}
        </button>
      </div>
      {error && <ErrorLine error={error} what="校閲の依頼を送る" />}
      {jobId && <JobPanel job={poll.job} loading={poll.loading} error={poll.error} title="校閲・ファクトチェックの結果" onRetry={poll.reload} />}
      {asked?.cut && <p className="hint">本文が長いので、最初の部分だけを確かめてもらっています。</p>}
      {asked && asked.content !== request.content && <p className="hint">依頼したあとで件名か本文が変わっています。直した後の文で確かめるときは、もう一度頼んでください。</p>}
    </section>
  );
}
