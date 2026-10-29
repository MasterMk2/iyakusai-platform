import type { ReactNode } from 'react';
import type { AssistantFile, AssistantJob } from '../../../shared/assistant';
import { fmtDate, type ApiFailure } from '../../api';
import { BotText } from './BotText';
import { ErrorLine, sizeLabel, StateTag } from './common';

/**
 * A job as the user sees it: its state with text, the progress line while it runs, the answer or
 * document or image when done, and the Discord link. Nothing here is HTML from the Bot; the text
 * goes through BotText and the files are links to the server's download URLs. A screen may show a
 * finished text its own way (renderResult; the mail screen splits the subject and the body); when it
 * gives null the text is shown as usual.
 */
export function JobPanel({
  job,
  loading,
  error,
  title,
  shareNote,
  onRetry,
  renderResult,
}: {
  job: AssistantJob | null;
  loading: boolean;
  error: ApiFailure | null;
  title: string;
  shareNote?: string | null;
  onRetry: () => void;
  renderResult?: (job: AssistantJob) => ReactNode;
}) {
  if (!job) {
    if (error) return <ErrorLine error={error} what={`${title}の状態を取得`} onRetry={onRetry} />;
    if (loading) return <p className="status loading" role="status">{title}を読み込み中…</p>;
    return null;
  }
  return (
    <section className="panel bot-job" aria-labelledby={`job-${job.id}`} data-testid="job-panel" data-state={job.state}>
      <div className="panel-head">
        <h2 id={`job-${job.id}`}>{title}</h2>
        <StateTag state={job.state} />
      </div>
      <p className="hint">依頼の受付 {fmtDate(job.createdAt)}</p>
      {job.state === 'queued' && <p className="hint">Bot の応答を待っています。Bot が止まっていると、この依頼はまだ処理されません。</p>}
      {job.state === 'running' && <p className="hint" data-testid="job-progress">{job.progress?.text || '処理しています…'}</p>}
      {job.state === 'failed' && (
        <p className="status error" role="alert" data-testid="job-error">
          {job.error?.message || '処理できませんでした。内容を変えて、もう一度お試しください。'}
        </p>
      )}
      {job.state === 'canceled' && <p className="empty">この依頼は取り消されました。</p>}
      {job.state === 'done' && job.result && (
        <div className="bot-result" data-testid="job-result">
          {renderResult?.(job) ?? (job.result.text && <BotText text={job.result.text} />)}
          {job.result.message && <p className="status ok" role="status">{job.result.message}</p>}
          {job.result.files.length > 0 && <FileList files={job.result.files} jobId={job.id} />}
        </div>
      )}
      {job.discordUrl && (
        <p>
          <a href={job.discordUrl} target="_blank" rel="noopener noreferrer">
            Discord で開く
          </a>
        </p>
      )}
      {shareNote && job.kind !== 'remind' && job.kind !== 'screening' && <p className="hint">{shareNote}</p>}
      {error && <ErrorLine error={error} what="最新の状態を取得" onRetry={onRetry} />}
    </section>
  );
}

function FileList({ files, jobId }: { files: AssistantFile[]; jobId: string }) {
  return (
    <div className="bot-files" data-job={jobId}>
      {files
        .filter((file) => file.mime.startsWith('image/'))
        .map((file) => (
          <figure key={file.url} className="bot-image">
            <img src={file.url} alt={`生成した画像（${file.name}）`} />
          </figure>
        ))}
      <ul className="rows">
        {files.map((file) => (
          <li key={file.url}>
            <a className="button secondary" href={file.url} download={file.name}>
              {file.name} をダウンロード
            </a>
            <span className="row-sub">{sizeLabel(file.size)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
