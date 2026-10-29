import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ASK_EFFORTS, ASK_FORMATS, ASSISTANT_LIMITS, cleanText, type AssistantJob, type AssistantMeta } from '../../../shared/assistant';
import { api, toFailure, type ApiFailure } from '../../api';
import type { BotSection } from './BotView';
import { ErrorLine, FeatureOff, operationFor, type OperationSlots, settleOperation, summaryOf } from './common';
import { JobPanel } from './JobPanel';
import { RecentJobs } from './RecentJobs';
import { useJobPoll } from './useJobPoll';

/** Similar questions wait this long after the last keystroke (contract §5: before sending). */
const SIMILAR_DELAY_MS = 500;
const EFFORT_LABELS: Record<(typeof ASK_EFFORTS)[number], string> = { auto: '自動', low: '浅く', medium: '標準', high: '深く', xhigh: '最も深く' };
const FORMAT_LABELS: Record<'' | (typeof ASK_FORMATS)[number], string> = { '': '本文（この画面に表示）', docx: 'Word（docx）', md: 'Markdown（md）', txt: 'テキスト（txt）' };

interface SimilarAnswer {
  q: string;
  jobs: { job: AssistantJob; score: number }[];
}

/**
 * The question screen: a question with its similar earlier questions shown before sending, the options
 * under 詳細, the answer as it is produced, and the list of everyone's recent questions.
 */
export function AskView({ meta, jobId, onNavigate }: { meta: AssistantMeta; jobId: string | null; onNavigate: (section: BotSection, jobId?: string | null) => void }) {
  const [question, setQuestion] = useState('');
  const [model, setModel] = useState('auto');
  const [effort, setEffort] = useState<(typeof ASK_EFFORTS)[number]>('auto');
  const [tone, setTone] = useState('');
  const [format, setFormat] = useState<'' | (typeof ASK_FORMATS)[number]>('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiFailure | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [similar, setSimilar] = useState<SimilarAnswer | null>(null);
  const [similarError, setSimilarError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const operation = useRef<OperationSlots>({});
  const poll = useJobPoll(jobId);

  const q = cleanText(question);
  useEffect(() => {
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ jobs: { job: AssistantJob; score: number }[] }>('GET', `/api/assistant/similar?q=${encodeURIComponent(q)}`, undefined, controller.signal)
        .then((answer) => {
          setSimilar({ q, jobs: answer.jobs });
          setSimilarError(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSimilarError(true);
        });
    }, SIMILAR_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q]);
  // Answers for an earlier text are not shown for the current one.
  const shown = similar && similar.q === q ? similar : null;

  const askModels = meta.models.filter((m) => m.ask);
  const enabled = meta.features.ask;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!q) {
      setFormMessage('質問を入力してください。');
      return;
    }
    if (q.length > ASSISTANT_LIMITS.questionMax) {
      setFormMessage(`質問は ${ASSISTANT_LIMITS.questionMax} 字までです。短くしてから送ってください。`);
      return;
    }
    setFormMessage(null);
    setSubmitError(null);
    const toneText = cleanText(tone);
    const input = { question: q, model, effort, ...(toneText ? { tone: toneText } : {}), format: format || null };
    const clientOperationId = operationFor(operation.current, 'submit', JSON.stringify({ kind: 'ask', input }));
    setSubmitting(true);
    try {
      const answer = await api<{ job: AssistantJob }>('POST', '/api/assistant/jobs', { clientOperationId, kind: 'ask', input });
      operation.current.submit = null;
      setQuestion('');
      setReloadKey((n) => n + 1);
      onNavigate('ask', answer.job.id);
    } catch (err) {
      settleOperation(operation.current, 'submit', err);
      setSubmitError(toFailure(err));
    } finally {
      setSubmitting(false);
    }
  }

  const share = meta.shareChannel ? `回答は Discord の #${meta.shareChannel.name} にも投稿されます。` : null;

  return (
    <div className="bot-ask">
      {jobId && (
        <div className="bot-open">
          <JobPanel job={poll.job} loading={poll.loading} error={poll.error} title="回答" shareNote={share} onRetry={poll.reload} />
          <button type="button" className="secondary" onClick={() => onNavigate('ask', null)}>
            新しく質問する
          </button>
        </div>
      )}
      <section className="panel" aria-labelledby="ask-form-title">
        <h2 id="ask-form-title">質問する</h2>
        {!enabled && <FeatureOff reason="質問は、いまこの Bot では使えません。Bot の設定が済むまでお待ちください。" />}
        <form className="bot-form" onSubmit={submit} noValidate>
          <fieldset disabled={!enabled || submitting}>
            <label htmlFor="ask-question">質問</label>
            <textarea
              id="ask-question"
              rows={4}
              maxLength={ASSISTANT_LIMITS.questionMax}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              aria-describedby="ask-count"
              data-testid="ask-question"
            />
            <p id="ask-count" className={`counter ${question.length >= ASSISTANT_LIMITS.questionMax ? 'over' : ''}`}>
              {question.length}／{ASSISTANT_LIMITS.questionMax}字
            </p>

            {q.length >= 2 && shown && shown.jobs.length > 0 && (
              <section className="bot-similar" aria-labelledby="ask-similar" data-testid="ask-similar">
                <h3 id="ask-similar">似た質問（アプリから過去に出した質問）</h3>
                <ul className="rows">
                  {shown.jobs.map(({ job }) => (
                    <li key={job.id}>
                      <span className="row-main">{summaryOf(job)}</span>
                      <button type="button" className="secondary" onClick={() => onNavigate('ask', job.id)}>
                        回答を開く
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {q.length >= 2 && shown && shown.jobs.length === 0 && <p className="hint">似た質問は見つかりませんでした。</p>}
            {q.length >= 2 && similarError && <p className="hint" role="status">似た質問を取得できませんでした。送信はできます。</p>}

            <details className="bot-details">
              <summary>詳細（モデル・考える深さ・口調・形式）</summary>
              <label htmlFor="ask-model">モデル</label>
              <select id="ask-model" value={model} onChange={(e) => setModel(e.target.value)}>
                {(askModels.length > 0 ? askModels : [{ id: 'auto', label: '自動', ask: true, doc: true }]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <label htmlFor="ask-effort">考える深さ</label>
              <select id="ask-effort" value={effort} onChange={(e) => setEffort(e.target.value as (typeof ASK_EFFORTS)[number])}>
                {ASK_EFFORTS.map((value) => (
                  <option key={value} value={value}>
                    {EFFORT_LABELS[value]}
                  </option>
                ))}
              </select>
              <label htmlFor="ask-tone">口調（任意）</label>
              <input id="ask-tone" type="text" maxLength={ASSISTANT_LIMITS.toneMax} value={tone} onChange={(e) => setTone(e.target.value)} />
              <label htmlFor="ask-format">回答の形式</label>
              <select id="ask-format" value={format} onChange={(e) => setFormat(e.target.value as '' | (typeof ASK_FORMATS)[number])}>
                {(['', ...ASK_FORMATS] as const).map((value) => (
                  <option key={value || 'plain'} value={value}>
                    {FORMAT_LABELS[value]}
                  </option>
                ))}
              </select>
            </details>

            {formMessage && (
              <p className="status error" role="alert">
                {formMessage}
              </p>
            )}
            {submitError && <ErrorLine error={submitError} what="質問を送る" />}
            <button type="submit" className="primary" data-testid="ask-submit">
              {submitting ? '送信しています…' : '質問する'}
            </button>
          </fieldset>
        </form>
        {share && !jobId && <p className="hint">{share}</p>}
      </section>
      <RecentJobs kind="ask" title="最近の質問（全員）" reloadKey={reloadKey} onOpen={(id) => onNavigate('ask', id)} />
    </div>
  );
}
