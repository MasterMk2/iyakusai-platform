import { useRef, useState, type FormEvent } from 'react';
import { ASSISTANT_LIMITS, cleanText, IMAGE_ASPECTS, type AssistantJob, type AssistantMeta } from '../../../shared/assistant';
import { api, toFailure, type ApiFailure } from '../../api';
import type { BotSection } from './BotView';
import { ErrorLine, operationFor, type OperationSlots, settleOperation } from './common';
import { JobPanel } from './JobPanel';
import { RecentJobs } from './RecentJobs';
import { useJobPoll } from './useJobPoll';

const ASPECT_LABELS: Record<(typeof IMAGE_ASPECTS)[number], string> = {
  '1:1': '正方形（1:1）',
  '16:9': '横長（16:9）',
  '9:16': '縦長（9:16）',
  '4:3': '横（4:3）',
  '3:4': '縦（3:4）',
};

/**
 * The image screen: a description and a shape, the picture when it is made, and its download. Images use
 * the AI usage of the Bot, which is said on the screen.
 */
export function ImageView({ meta, jobId, onNavigate }: { meta: AssistantMeta; jobId: string | null; onNavigate: (section: BotSection, jobId?: string | null) => void }) {
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState<(typeof IMAGE_ASPECTS)[number]>('1:1');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiFailure | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const operation = useRef<OperationSlots>({});
  const poll = useJobPoll(jobId);

  const text = cleanText(prompt);
  const share = meta.shareChannel ? `作成した画像は Discord の #${meta.shareChannel.name} にも投稿されます。` : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text) {
      setFormMessage('どんな画像か説明を入力してください。');
      return;
    }
    if (text.length > ASSISTANT_LIMITS.imagePromptMax) {
      setFormMessage(`説明は ${ASSISTANT_LIMITS.imagePromptMax} 字までです。短くしてから送ってください。`);
      return;
    }
    setFormMessage(null);
    setSubmitError(null);
    const input = { prompt: text, aspect };
    const clientOperationId = operationFor(operation.current, 'submit', JSON.stringify({ kind: 'image', input }));
    setSubmitting(true);
    try {
      const answer = await api<{ job: AssistantJob }>('POST', '/api/assistant/jobs', { clientOperationId, kind: 'image', input });
      operation.current.submit = null;
      setPrompt('');
      setReloadKey((n) => n + 1);
      onNavigate('image', answer.job.id);
    } catch (err) {
      settleOperation(operation.current, 'submit', err);
      setSubmitError(toFailure(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bot-image-view">
      {jobId && (
        <div className="bot-open">
          <JobPanel job={poll.job} loading={poll.loading} error={poll.error} title="画像" shareNote={share} onRetry={poll.reload} />
          <button type="button" className="secondary" onClick={() => onNavigate('image', null)}>
            新しく作る
          </button>
        </div>
      )}
      <section className="panel" aria-labelledby="image-form-title">
        <h2 id="image-form-title">画像を作る</h2>
        <p className="hint">画像を作ると、Bot が使う AI の利用量を消費します。</p>
        <form className="bot-form" onSubmit={submit} noValidate>
          <fieldset disabled={submitting}>
            <label htmlFor="image-prompt">どんな画像か</label>
            <textarea id="image-prompt" rows={4} maxLength={ASSISTANT_LIMITS.imagePromptMax} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-describedby="image-count" data-testid="image-prompt" />
            <p id="image-count" className={`counter ${prompt.length >= ASSISTANT_LIMITS.imagePromptMax ? 'over' : ''}`}>
              {prompt.length}／{ASSISTANT_LIMITS.imagePromptMax}字
            </p>
            <label htmlFor="image-aspect">縦横比</label>
            <select id="image-aspect" value={aspect} onChange={(e) => setAspect(e.target.value as (typeof IMAGE_ASPECTS)[number])}>
              {IMAGE_ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {ASPECT_LABELS[a]}
                </option>
              ))}
            </select>
            {formMessage && (
              <p className="status error" role="alert">
                {formMessage}
              </p>
            )}
            {submitError && <ErrorLine error={submitError} what="画像の依頼を送る" />}
            <button type="submit" className="primary" data-testid="image-submit">
              {submitting ? '送信しています…' : '画像を作る'}
            </button>
          </fieldset>
        </form>
        {share && !jobId && <p className="hint">{share}</p>}
      </section>
      <RecentJobs kind="image" title="最近の画像（全員）" reloadKey={reloadKey} onOpen={(id) => onNavigate('image', id)} />
    </div>
  );
}
