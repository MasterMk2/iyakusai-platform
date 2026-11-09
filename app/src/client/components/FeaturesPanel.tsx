import { useCallback, useEffect, useState } from 'react';
import type { RentalSwitchResponse } from '../../shared/rental-access';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

const SWITCH_URL = '/api/rental/admin/switch';

/**
 * Features the committee can stop for a while (2026-11-09: rental, 「しばらく使わない」). Access administrators only.
 * Stopping asks once, with what is out now; starting again does not ask (nothing is lost either way). The panel uses
 * the server's answer instead of reloading, and tells the rest of the screen so the tab goes at once.
 */
export function FeaturesPanel({ onChanged, onAvailable }: { onChanged: () => void; onAvailable?: (available: boolean) => void }) {
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      return await api<RentalSwitchResponse>('GET', SWITCH_URL, undefined, signal);
    } catch (error) {
      if (toFailure(error).status === 404) return null;
      throw error;
    }
  }, []);
  const loader = useLoader(load);
  const [saved, setSaved] = useState<RentalSwitchResponse | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const data = saved ?? loader.data;

  // A server without rental (404) leaves the part out of the settings.
  const absent = !loader.loading && !loader.error && !data;
  useEffect(() => {
    if (!loader.loading) onAvailable?.(!absent);
  }, [loader.loading, absent, onAvailable]);
  if (absent) return null;

  async function change(enabled: boolean) {
    setSaving(true);
    setMessage(null);
    try {
      const next = await api<RentalSwitchResponse>('PUT', SWITCH_URL, { enabled });
      setSaved(next);
      setConfirm(false);
      setMessage({ text: enabled ? '物品貸出を再開しました。タブとホームの欄が戻ります。' : '物品貸出を止めました。ほかの人の画面からは、開き直したときにタブとホームの欄が消えます。', error: false });
      onChanged();
    } catch (error) {
      setMessage({ text: toFailure(error).message, error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="admin features" aria-labelledby="features-title" data-testid="features">
      <h3 id="features-title">使う機能</h3>
      <p className="hint">しばらく使わない機能は止めておけます。止めた機能はタブとホームから消え、その画面と操作も使えなくなります。記録と権限は消えないので、再開すれば元どおりに使えます。</p>
      <LoadStatus loader={loader} what="使う機能" compact />
      {message && (
        <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'} data-testid="features-message">
          {message.text}
        </p>
      )}
      {data && (
        <>
          <div className="rental-access-policy" data-testid="feature-rental">
            <div className="rental-access-policy-title">
              <h4>物品貸出</h4>
              <span className={`status ${data.enabled ? 'ok' : 'info'}`} data-testid="feature-rental-state">
                {data.enabled ? '使用中' : '停止中'}
              </span>
            </div>
            <p className="hint">
              いま貸出中 {data.loaned} 件・要確認 {data.review} 件
            </p>
            {!data.enabled ? (
              <button type="button" disabled={saving} onClick={() => void change(true)}>
                {saving ? '再開しています…' : '物品貸出を再開する'}
              </button>
            ) : confirm ? (
              <div className="status warning" role="alert">
                <p>
                  止めると、物品貸出のタブとホームの欄が消えます。スマホの貸出・返却の画面、QR ラベルとカードからの読み取り、団体の回収表、返却チェックシートも使えなくなります。台帳・権限・写真は消えません。
                </p>
                {data.loaned + data.review > 0 && (
                  <p>
                    <strong>
                      貸出中 {data.loaned} 件・要確認 {data.review} 件が残っています。
                    </strong>
                    止めている間は返却も記録できません。
                  </p>
                )}
                <button type="button" className="danger" disabled={saving} onClick={() => void change(false)}>
                  {saving ? '止めています…' : '止める'}
                </button>{' '}
                <button type="button" className="secondary" disabled={saving} onClick={() => setConfirm(false)}>
                  やめる
                </button>
              </div>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirm(true)}>
                物品貸出を止める
              </button>
            )}
          </div>
          <details className="rental-access-history">
            <summary>最近の切り替え（{data.history.length} 件）</summary>
            {data.history.length ? (
              <ol>
                {data.history.map((event) => (
                  <li key={event.id}>
                    <strong>物品貸出：{event.enabled ? '再開' : '停止'}</strong>
                    <span className="hint">
                      {fmtDate(event.at)}・{event.actorName}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">まだ切り替えていません。</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
