import { useCallback, useRef, useState } from 'react';
import { ASSISTANT_LIMITS, cleanText, type AssistantCandidate, type AssistantJob, type AssistantMeta, type CandidateAction } from '../../../shared/assistant';
import { api, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { ErrorLine, FeatureOff, isActive, operationFor, type OperationSlots, type Outcome, OutcomeLine, settleOperation } from './common';
import { useJobPoll } from './useJobPoll';

/** The state words of a candidate (the Bot's ledger values); the colour only repeats them. */
const STATE_WORDS: Record<string, { label: string; tone: 'warn' | 'info' | 'none' }> = {
  posted: { label: '承認待ち', tone: 'warn' },
  created: { label: '自動起票（差し戻し・取り消しできます）', tone: 'info' },
  returned: { label: '差し戻し中', tone: 'none' },
  revised: { label: '修正済み', tone: 'none' },
  rejected: { label: '不要として閉じた', tone: 'none' },
  undone: { label: '誤起票として閉じた', tone: 'none' },
};

/** The button words follow the Discord buttons: 起票する, 不要, 誤起票として閉じる, and returning with a comment. */
function actionLabel(candidate: AssistantCandidate, action: CandidateAction): string {
  if (action === 'ok') return '起票する';
  if (action === 'ng') return '不要';
  if (action === 'undo') return '誤起票として閉じる';
  return candidate.state === 'created' ? '差し戻す' : 'コメントして差し戻す';
}

/**
 * Task candidates the Bot found in the committee's documents: approve, mark as not needed, close an
 * automatic task as a mistake, or return it with a comment. Each action is the Discord button's action,
 * so the Discord post changes the same way. The buttons are the ones the Bot says are possible.
 */
export function CandidatesView({ meta }: { meta: AssistantMeta }) {
  const [view, setView] = useState<'open' | 'recent'>('open');
  const [version, setVersion] = useState(0);
  const [watchId, setWatchId] = useState<string | null>(null);
  const watch = useJobPoll(watchId);
  const watchDone = watch.job && !isActive(watch.job) ? watch.job.id : '';
  const load = useCallback(
    (signal: AbortSignal) => {
      void version;
      void watchDone;
      return api<{ candidates: AssistantCandidate[] }>('GET', `/api/assistant/candidates?state=${view}`, undefined, signal);
    },
    [view, version, watchDone],
  );
  const list = useLoader(load);
  const [returning, setReturning] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [returnMessage, setReturnMessage] = useState<string | null>(null);
  // Only the candidate being handled waits, and its result shows on its row, or above the list once the row has
  // left it (2026-10-26: every row's buttons stopped while one was handled, and the result was above the list).
  const [busy, setBusy] = useState<Record<number, true>>({});
  const [results, setResults] = useState<Record<number, Outcome>>({});
  const [last, setLast] = useState<number | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const operations = useRef<OperationSlots>({});
  const enabled = meta.features.screening;
  const watched = watch.job && !isActive(watch.job) ? (watch.job.result?.message ?? watch.job.error?.message ?? null) : null;
  const outcome = (id: number): Outcome | undefined => (id === watching && watched !== null ? { text: watched } : results[id]);
  const put = (id: number, value: Outcome) => setResults((r) => ({ ...r, [id]: value }));

  /** The answer of an action: done now, or still working and watched until it is. */
  function take(id: number, job: AssistantJob) {
    if (isActive(job)) {
      setWatchId(job.id);
      setWatching(id);
      put(id, { text: 'Bot が処理しています。終わると一覧に反映されます。' });
      return;
    }
    put(id, { text: job.result?.message ?? job.error?.message ?? '' });
    setVersion((n) => n + 1);
  }

  async function act(candidate: AssistantCandidate, action: CandidateAction, text?: string) {
    const body = text !== undefined ? { comment: text } : {};
    const slot = `${candidate.id}:${action}`;
    const clientOperationId = operationFor(operations.current, slot, JSON.stringify({ slot, ...body }));
    setBusy((b) => ({ ...b, [candidate.id]: true }));
    // The results of rows that are still listed stay; the rest were already read.
    const listed = new Set(candidates.map((c) => c.id));
    setResults((r) => Object.fromEntries(Object.entries(r).filter(([id]) => Number(id) !== candidate.id && listed.has(Number(id)))));
    if (watching === candidate.id) setWatching(null);
    setLast(candidate.id);
    try {
      const answer = await api<{ job: AssistantJob }>('POST', `/api/assistant/candidates/${candidate.id}/${action}`, { clientOperationId, ...body });
      operations.current[slot] = null;
      if (returning === candidate.id) {
        setReturning(null);
        setComment('');
        setReturnMessage(null);
      }
      take(candidate.id, answer.job);
    } catch (err) {
      settleOperation(operations.current, slot, err);
      put(candidate.id, { error: toFailure(err) });
    } finally {
      setBusy((b) => {
        const rest = { ...b };
        delete rest[candidate.id];
        return rest;
      });
    }
  }

  function submitReturn(candidate: AssistantCandidate) {
    const text = cleanText(comment);
    if (!text) {
      setReturnMessage('差し戻すときは理由（コメント）を入力してください。');
      return;
    }
    if (text.length > ASSISTANT_LIMITS.returnCommentMax) {
      setReturnMessage(`コメントは ${ASSISTANT_LIMITS.returnCommentMax} 字までです。`);
      return;
    }
    void act(candidate, 'return', text);
  }

  const candidates = list.data?.candidates ?? [];
  // The latest result whose row has left the list (approved, closed, returned) shows above the list.
  const away = last !== null && !candidates.some((c) => c.id === last) ? outcome(last) : undefined;

  return (
    <div className="bot-candidates">
      {!enabled && <FeatureOff reason="タスク候補の操作は、いまこの Bot では使えません。Bot の設定が済むまでお待ちください。" />}
      <section className="panel" aria-labelledby="candidates-title">
        <div className="panel-head">
          <h2 id="candidates-title">タスク候補</h2>
        </div>
        <div className="bot-filter">
          <label htmlFor="candidates-view">表示</label>
          <select id="candidates-view" value={view} onChange={(e) => setView(e.target.value as 'open' | 'recent')}>
            <option value="open">承認待ち・自動起票のもの</option>
            <option value="recent">直近7日の全状態</option>
          </select>
        </div>
        <p className="hint">操作すると、Discord の候補の投稿も同じように書き換わります。</p>
        {list.loading && <p className="status loading" role="status">読み込み中…</p>}
        {list.error && <ErrorLine error={list.error} what="タスク候補の一覧を読み込み" onRetry={list.retry} />}
        {away && <OutcomeLine outcome={away} testId="candidate-notice" what="タスク候補の操作" />}
        {list.data && candidates.length === 0 && <p className="empty">{view === 'open' ? '承認待ちの候補はありません。' : '直近7日の候補はありません。'}</p>}
        <ul className="bot-candidate-list">
          {candidates.map((c) => {
            const words = STATE_WORDS[c.state] ?? { label: '処理済み', tone: 'none' as const };
            return (
              <li key={c.id} className="bot-candidate" data-testid="candidate" data-id={c.id}>
                <h3>{c.title}</h3>
                <div className="bot-candidate-meta">
                  <span className={`bot-tag bot-tag-${words.tone}`}>{words.label}</span>
                  <span className="row-sub">期限 {c.deadline ?? 'なし'}・担当候補 {c.assigneeName ?? '未定'}</span>
                </div>
                {c.departments.length > 0 && (
                  <ul className="bot-chips" aria-label="部局">
                    {c.departments.map((d) => (
                      <li key={d} className="chip">
                        {d}
                      </li>
                    ))}
                  </ul>
                )}
                {c.description && <p className="bot-description">{c.description}</p>}
                {c.sources.length > 0 && (
                  <details className="bot-sources">
                    <summary>根拠の抜粋（{c.sources.length}件）</summary>
                    <ul>
                      {c.sources.map((s, i) => (
                        <li key={i}>
                          <strong>{s.label}</strong>
                          <p>{s.excerpt}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {c.discordUrl && (
                  <p>
                    <a href={c.discordUrl} target="_blank" rel="noopener noreferrer">
                      Discord の候補投稿を開く
                    </a>
                  </p>
                )}
                {returning === c.id ? (
                  <div className="bot-return" role="group" aria-label="差し戻しのコメント">
                    <label htmlFor={`return-${c.id}`}>差し戻しの理由（必須・{ASSISTANT_LIMITS.returnCommentMax}字まで）</label>
                    <textarea id={`return-${c.id}`} rows={3} maxLength={ASSISTANT_LIMITS.returnCommentMax} value={comment} onChange={(e) => setComment(e.target.value)} />
                    {returnMessage && (
                      <p className="status error" role="alert">
                        {returnMessage}
                      </p>
                    )}
                    <div className="bot-actions">
                      <button type="button" className="primary" disabled={!enabled || !!busy[c.id]} onClick={() => submitReturn(c)}>
                        {busy[c.id] ? '処理中…' : '差し戻す'}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setReturning(null);
                          setComment('');
                          setReturnMessage(null);
                        }}
                      >
                        やめる
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="bot-actions">
                    {c.actions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className={action === 'ok' ? 'primary' : 'secondary'}
                        disabled={!enabled || !!busy[c.id]}
                        onClick={() => {
                          if (action === 'return') {
                            setReturning(c.id);
                            setComment('');
                            setReturnMessage(null);
                          } else {
                            void act(c, action);
                          }
                        }}
                      >
                        {actionLabel(c, action)}
                      </button>
                    ))}
                    {busy[c.id] && (
                      <span className="hint" role="status">
                        処理中…
                      </span>
                    )}
                  </div>
                )}
                {outcome(c.id) && <OutcomeLine outcome={outcome(c.id)!} testId="candidate-result" what="タスク候補の操作" />}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
