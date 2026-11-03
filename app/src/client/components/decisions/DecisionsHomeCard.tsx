import { useCallback } from 'react';
import { fmtListDate } from '../../api';
import { LoadStatus } from '../LoadStatus';
import { useLoader } from '../../useLoader';
import { DECISION_STATUS_LABELS } from '../../../shared/decisions';
import { decisionApi, useDecisionMeta } from './decisionsApi';
import { decisionHref, DECISIONS_LIST_HREF } from './decisionLinks';

/**
 * 最近の決定・変更 on the home screen: the five decisions changed last, with their state as text. Nothing is shown
 * while the register is off or the person is not a committee member.
 */
export function DecisionsHomeCard() {
  const meta = useDecisionMeta();
  if (!meta?.enabled) return null;
  return <RecentDecisions />;
}

function RecentDecisions() {
  const fetcher = useCallback((signal: AbortSignal) => decisionApi.list(new URLSearchParams({ sort: 'changed', pageSize: '5' }), signal), []);
  const loader = useLoader(fetcher);
  const items = loader.data?.items ?? [];
  return (
    <section className="panel home-decisions" id="home-decisions" aria-labelledby="home-decisions-title" data-testid="home-decisions">
      <div className="panel-head">
        <h2 id="home-decisions-title">最近の決定・変更</h2>
        <a className="button secondary" href={DECISIONS_LIST_HREF}>
          一覧を開く
        </a>
      </div>
      <LoadStatus loader={loader} what="決定事項" />
      {loader.data && items.length === 0 && <p className="hint">決定事項はまだありません。</p>}
      {items.length > 0 && (
        <ul className="rows">
          {items.map((item) => (
            <li key={item.id}>
              <a href={decisionHref(item.id)}>{item.title}</a>{' '}
              <span className={`decision-status decision-status-${item.status}`}>{DECISION_STATUS_LABELS[item.status]}</span>{' '}
              <span className="hint">{fmtListDate(item.changedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
