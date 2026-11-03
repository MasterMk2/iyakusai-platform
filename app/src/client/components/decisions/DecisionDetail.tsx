import { useCallback, useState, type FormEvent } from 'react';
import { fmtDate, toFailure, ApiFailure } from '../../api';
import { LoadStatus } from '../LoadStatus';
import { useLoader } from '../../useLoader';
import {
  DECISION_ACTION_LABELS,
  DECISION_LIMITS,
  DECISION_SOURCE_LABELS,
  DECISION_STATUS_LABELS,
  DECISION_VENUE_LABELS,
  type DecisionDetailResponse,
  type DecisionInput,
  type DecisionView,
} from '../../../shared/decisions';
import { DecisionForm, type DecisionFormMode, type DepartmentOption } from './DecisionForm';
import { decisionApi, forgetDecisionMeta } from './decisionsApi';
import { decisionHref, departmentLabel, DECISIONS_LIST_HREF, todayInJapan } from './decisionLinks';

// One decision: its facts, the chain of changes it belongs to, the history of its record, and the actions the
// server says this person may take (edit and change while it is active; revoke by the registrant or the access
// administrator, and restore a revoked one).

const FIELD_NAMES: Record<string, string> = {
  title: '内容',
  body: '詳しい内容',
  departments: '部局',
  decidedOn: '決めた日',
  venue: '決めた場',
  venueOther: '場の名前',
  sources: '出典',
  taskIds: '関係するタスク',
};

const inputOf = (d: DecisionView): DecisionInput => ({
  title: d.title,
  body: d.body,
  departments: d.departments,
  decidedOn: d.decidedOn,
  venue: d.venue,
  venueOther: d.venueOther,
  sources: d.sources,
  taskIds: d.taskIds,
});

interface Props {
  id: string;
  departments: DepartmentOption[];
  /** The register changed (revoked, restored, edited, changed): the list is read again. */
  onChanged?: () => void;
}

export function DecisionDetail({ id, departments, onChanged }: Props) {
  const fetcher = useCallback((signal: AbortSignal) => decisionApi.get(id, signal), [id]);
  const loader = useLoader(fetcher);
  const [mode, setMode] = useState<'view' | DecisionFormMode>('view');
  const [revokeNote, setRevokeNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const notFound = loader.error instanceof ApiFailure && loader.error.status === 404;
  const shown: DecisionDetailResponse | null = loader.data;
  const d: DecisionView | null = shown?.decision ?? null;

  // Leaving an edit or a change reads the decision again, so the form's version is the latest one.
  const closeForm = () => {
    setMode('view');
    loader.retry();
  };

  async function run(action: () => Promise<DecisionDetailResponse>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      forgetDecisionMeta();
      onChanged?.();
      loader.retry();
    } catch (err) {
      setError(toFailure(err).message);
      loader.retry();
    } finally {
      setBusy(false);
    }
  }

  function onRevoke(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    void run(() => decisionApi.revoke(d.id, { expectedVersion: d.version, note: revokeNote.trim() }), '取り消しました。取り消しは「取り消しを戻す」で元に戻せます。');
  }

  return (
    <article className="decision-detail" aria-labelledby={`decision-title-${id}`} data-testid="decision-detail">
      <p className="detail-back">
        <a href={DECISIONS_LIST_HREF} className="link-button">
          ← 一覧に戻る
        </a>
      </p>
      {loader.loading && !shown && <LoadStatus loader={loader} what="決定事項" />}
      {notFound && (
        <p className="status error" role="alert">
          この決定は見つからないか、見る権限がありません。
        </p>
      )}
      {!notFound && loader.error && !shown && <LoadStatus loader={loader} what="決定事項" />}

      {d && shown && (
        <>
          {mode === 'view' && (
            <>
              <header className="decision-head">
                <h2 id={`decision-title-${id}`} className="thread-title">
                  {d.title}
                </h2>
                <p className="facts-line">
                  <span className={`decision-status decision-status-${d.status}`} data-testid="decision-status">
                    {DECISION_STATUS_LABELS[d.status]}
                  </span>
                  <span>決めた日 {d.decidedOn}</span>
                  <span>{d.venue === 'other' ? d.venueOther : DECISION_VENUE_LABELS[d.venue]}</span>
                  {d.departments.map((k) => (
                    <span key={k} className="mailbox-badge">
                      {departmentLabel(k, departments)}
                    </span>
                  ))}
                </p>
              </header>

              {notice && (
                <p className="status ok" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="status error" role="alert">
                  {error}
                </p>
              )}

              {d.status === 'revoked' && (
                <p className="status warn">
                  この決定は取り消し済みです。{d.revokeNote ? `理由：${d.revokeNote}` : ''}
                </p>
              )}
              {d.status === 'changed' && d.supersededBy && (
                <p className="status info">
                  この決定は変更されました。
                  <a href={decisionHref(d.supersededBy)}>新しい決定を見る</a>
                </p>
              )}

              {d.body && <p className="decision-body">{d.body}</p>}

              <section className="decision-section" aria-label="出典">
                <h3 className="section-label">出典</h3>
                {d.sources.length === 0 ? (
                  <p className="hint">出典は書かれていません。</p>
                ) : (
                  <ul className="rows">
                    {d.sources.map((s, i) => (
                      <li key={i}>
                        {DECISION_SOURCE_LABELS[s.kind]}：{s.label}
                        {s.refId ? `（${s.refId}）` : ''}
                        {s.link && (
                          <>
                            {' '}
                            <a href={s.link}>開く</a>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {d.taskIds.length > 0 && (
                <section className="decision-section" aria-label="関係するタスク">
                  <h3 className="section-label">関係するタスク</h3>
                  <ul className="rows">
                    {d.taskIds.map((t) => (
                      <li key={t}>
                        <a href={`#/tasks?task=${encodeURIComponent(t)}`}>{t}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="decision-section" aria-label="変更の流れ">
                <h3 className="section-label">変更の流れ</h3>
                {shown.chain.length <= 1 ? (
                  <p className="hint">この決定は、ほかの決定から変更されたことも、変更したこともありません。</p>
                ) : (
                  <ol className="decision-chain">
                    {shown.chain.map((c) => (
                      <li key={c.id} aria-current={c.id === d.id ? 'true' : undefined}>
                        <span className="hint">{c.decidedOn}</span>{' '}
                        {c.id === d.id ? <strong>{c.title}（この決定）</strong> : <a href={decisionHref(c.id)}>{c.title}</a>}{' '}
                        <span className={`decision-status decision-status-${c.status}`}>{DECISION_STATUS_LABELS[c.status]}</span>
                        {c.changeNote && <div className="hint">変更の内容：{c.changeNote}</div>}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="decision-section" aria-label="履歴">
                <h3 className="section-label">履歴</h3>
                <ul className="rows decision-history">
                  {shown.history.map((h, i) => (
                    <li key={`${h.at}-${i}`}>
                      <span className="hint">{fmtDate(h.at)}</span> {h.actorName}：{DECISION_ACTION_LABELS[h.action]}
                      {h.changed.length > 0 && <span className="hint">（{h.changed.map((f) => FIELD_NAMES[f] ?? f).join('・')}）</span>}
                    </li>
                  ))}
                </ul>
              </section>

              <footer className="actions decision-actions">
                {d.editable && (
                  <button type="button" className="secondary" onClick={() => setMode('edit')} data-testid="decision-edit">
                    内容を直す
                  </button>
                )}
                {d.editable && (
                  <button type="button" onClick={() => setMode('change')} data-testid="decision-change">
                    変更として登録
                  </button>
                )}
              </footer>

              {d.canRevoke && d.status === 'active' && (
                <form className="decision-revoke" onSubmit={onRevoke} aria-label="取り消し">
                  <div className="field">
                    <label htmlFor={`revoke-note-${id}`}>取り消す理由（任意・あとで戻せます）</label>
                    <input id={`revoke-note-${id}`} type="text" value={revokeNote} maxLength={DECISION_LIMITS.note} onChange={(e) => setRevokeNote(e.target.value)} />
                  </div>
                  <button type="submit" className="secondary" disabled={busy} data-testid="decision-revoke">
                    取り消す
                  </button>
                </form>
              )}
              {d.canRevoke && d.status === 'revoked' && (
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => decisionApi.restore(d.id, { expectedVersion: d.version }), '取り消しを戻しました。')}
                    data-testid="decision-restore"
                  >
                    取り消しを戻す
                  </button>
                </div>
              )}
            </>
          )}

          {mode === 'edit' && (
            <DecisionForm
              mode="edit"
              initial={inputOf(d)}
              base={{ id: d.id, version: d.version }}
              departments={departments}
              onCancel={closeForm}
              onReload={closeForm}
              onSaved={() => {
                setMode('view');
                setNotice('保存しました。履歴に残しました。');
                onChanged?.();
                loader.retry();
              }}
            />
          )}

          {/* A change is a new decision made now: its day starts as today (the venue stays as it was, and the form says so). */}
          {mode === 'change' && (
            <DecisionForm
              mode="change"
              initial={{ ...inputOf(d), decidedOn: todayInJapan() }}
              base={{ id: d.id, version: d.version }}
              departments={departments}
              onCancel={closeForm}
              onReload={closeForm}
              onSaved={(detail) => {
                // The new decision is the one to show; the old one keeps its place in the chain.
                onChanged?.();
                window.location.hash = decisionHref(detail.decision.id);
              }}
            />
          )}
        </>
      )}
    </article>
  );
}
