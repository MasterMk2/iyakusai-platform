import { useRef, useState, type FormEvent } from 'react';
import { ASSISTANT_LIMITS, cleanText, DOC_FORMATS, type AssistantJob, type AssistantMeta } from '../../../shared/assistant';
import { api, toFailure, type ApiFailure } from '../../api';
import type { BotSection } from './BotView';
import { ErrorLine, FeatureOff, operationFor, type OperationSlots, settleOperation } from './common';
import { JobPanel } from './JobPanel';
import { RecentJobs } from './RecentJobs';
import { useJobPoll } from './useJobPoll';

const DOC_FORMAT_LABELS: Record<(typeof DOC_FORMATS)[number], string> = { docx: 'Word（docx）', md: 'Markdown（md）', txt: 'テキスト（txt）' };
const MODEL_FALLBACK = { id: 'auto', label: '自動', ask: true, doc: true };

/**
 * The document screen (the Bot's /doc): kind, content, format, whether the committee's documents are
 * used, and the model. The finished text and its download links appear below the form.
 */
export function DocView({ meta, jobId, onNavigate }: { meta: AssistantMeta; jobId: string | null; onNavigate: (section: BotSection, jobId?: string | null) => void }) {
  const [docType, setDocType] = useState(meta.docTypes[0]?.id ?? 'notice');
  const [content, setContent] = useState('');
  const [format, setFormat] = useState<(typeof DOC_FORMATS)[number]>('docx');
  const [useSources, setUseSources] = useState(true);
  const [model, setModel] = useState('auto');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiFailure | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const operation = useRef<OperationSlots>({});
  const poll = useJobPoll(jobId);

  const enabled = meta.features.doc;
  const docModels = meta.models.filter((m) => m.doc);
  const text = cleanText(content);
  const share = meta.shareChannel ? `作成した文書は Discord の #${meta.shareChannel.name} にも投稿されます。` : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text) {
      setFormMessage('文書の内容を入力してください。');
      return;
    }
    if (text.length > ASSISTANT_LIMITS.docContentMax) {
      setFormMessage(`内容は ${ASSISTANT_LIMITS.docContentMax} 字までです。短くしてから送ってください。`);
      return;
    }
    setFormMessage(null);
    setSubmitError(null);
    const input = { docType, content: text, format, useSources, model };
    const clientOperationId = operationFor(operation.current, 'submit', JSON.stringify({ kind: 'doc', input }));
    setSubmitting(true);
    try {
      const answer = await api<{ job: AssistantJob }>('POST', '/api/assistant/jobs', { clientOperationId, kind: 'doc', input });
      operation.current.submit = null;
      setContent('');
      setReloadKey((n) => n + 1);
      onNavigate('doc', answer.job.id);
    } catch (err) {
      settleOperation(operation.current, 'submit', err);
      setSubmitError(toFailure(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bot-doc">
      {jobId && (
        <div className="bot-open">
          <JobPanel job={poll.job} loading={poll.loading} error={poll.error} title="文書" shareNote={share} onRetry={poll.reload} />
          <button type="button" className="secondary" onClick={() => onNavigate('doc', null)}>
            新しく作る
          </button>
        </div>
      )}
      <section className="panel" aria-labelledby="doc-form-title">
        <h2 id="doc-form-title">文書を作る</h2>
        {!enabled && <FeatureOff reason="文書の作成は、いまこの Bot では使えません。Bot の設定が済むまでお待ちください。" />}
        <form className="bot-form" onSubmit={submit} noValidate>
          <fieldset disabled={!enabled || submitting}>
            <label htmlFor="doc-type">種類</label>
            <select id="doc-type" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {meta.docTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <label htmlFor="doc-content">内容（何を書くか）</label>
            <textarea id="doc-content" rows={6} maxLength={ASSISTANT_LIMITS.docContentMax} value={content} onChange={(e) => setContent(e.target.value)} aria-describedby="doc-count" data-testid="doc-content" />
            <p id="doc-count" className={`counter ${content.length >= ASSISTANT_LIMITS.docContentMax ? 'over' : ''}`}>
              {content.length}／{ASSISTANT_LIMITS.docContentMax}字
            </p>
            <label htmlFor="doc-format">形式</label>
            <select id="doc-format" value={format} onChange={(e) => setFormat(e.target.value as (typeof DOC_FORMATS)[number])}>
              {DOC_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {DOC_FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
            <div className="bot-check">
              <input id="doc-sources" type="checkbox" checked={useSources} onChange={(e) => setUseSources(e.target.checked)} />
              <label htmlFor="doc-sources">委員会の資料を参照する</label>
            </div>
            <label htmlFor="doc-model">モデル</label>
            <select id="doc-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {(docModels.length > 0 ? docModels : [MODEL_FALLBACK]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {formMessage && (
              <p className="status error" role="alert">
                {formMessage}
              </p>
            )}
            {submitError && <ErrorLine error={submitError} what="文書の依頼を送る" />}
            <button type="submit" className="primary" data-testid="doc-submit">
              {submitting ? '送信しています…' : '文書を作る'}
            </button>
          </fieldset>
        </form>
        {share && !jobId && <p className="hint">{share}</p>}
      </section>
      <RecentJobs kind="doc" title="最近の文書（全員）" reloadKey={reloadKey} onOpen={(id) => onNavigate('doc', id)} />
    </div>
  );
}
