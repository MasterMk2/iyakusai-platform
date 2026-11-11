import { useCallback, useEffect } from 'react';
import { ApiFailure } from '../../api';
import { useLoader } from '../../useLoader';
import type { BulletinSummaryResponse } from '../../../shared/bulletin';
import { BOARD_HREF, bulletinApi } from './bulletinApi';
import { BulletinRowLink } from './BulletinView';

/**
 * 掲示板の新着 on the home screen: the notices on the board this person has not opened yet (重要 first). Shown only
 * while there is one; opening a notice takes it off. Nothing is shown where the board is off or the person is not a
 * committee member. The count is handed up for the attention line (null: nothing to count).
 */
export function BulletinHomePanel({ refresh, onCount }: { refresh: number; onCount: (count: number | null) => void }) {
  const fetcher = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return bulletinApi.summary(signal).catch((err: unknown): BulletinSummaryResponse | null => {
        // Off on this server (404) or not for this person (403): no part on the home screen.
        if (err instanceof ApiFailure && (err.status === 404 || err.status === 403)) return null;
        throw err;
      });
    },
    [refresh],
  );
  const loader = useLoader(fetcher);
  const summary = loader.data;
  const count = loader.loading && !summary ? undefined : (summary?.unreadTotal ?? null);
  useEffect(() => {
    if (count !== undefined) onCount(count);
  }, [count, onCount]);

  if (loader.error && !summary) {
    return (
      <section className="panel bulletin-home" aria-label="掲示板の新着">
        <p className="hint">
          掲示板の新着を確認できませんでした。{' '}
          <button type="button" className="link-button" onClick={loader.retry}>
            もう一度確認する
          </button>
        </p>
      </section>
    );
  }
  if (!summary || summary.unreadTotal === 0) return null;
  return (
    <section className="panel bulletin-home" id="home-bulletin" tabIndex={-1} aria-labelledby="home-bulletin-title" data-testid="home-bulletin">
      <div className="panel-head">
        <h2 id="home-bulletin-title">掲示板の新着（{summary.unreadTotal} 件）</h2>
        <a className="button secondary" href={BOARD_HREF}>
          掲示板を開く
        </a>
      </div>
      <ul className="rows bulletin-rows">
        {summary.items.map((item) => (
          <li key={item.id}>
            <BulletinRowLink item={item} />
          </li>
        ))}
      </ul>
      {summary.unreadTotal > summary.items.length && <p className="hint">ほか {summary.unreadTotal - summary.items.length} 件（掲示板で読めます）</p>}
    </section>
  );
}
