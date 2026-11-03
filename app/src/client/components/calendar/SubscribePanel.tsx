import { useState } from 'react';
import type { SubscriptionIssued, SubscriptionResponse } from '../../../shared/calendar';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';

// A personal iCal address for Google Calendar and the like. The address is shown once, right after it is made: the
// server keeps only its hash, so a later visit cannot show it again (make a new one, and the old one stops).

const loadSubscription = (signal: AbortSignal) => api<SubscriptionResponse>('GET', '/api/calendar/subscription', undefined, signal);

export function SubscribePanel() {
  const subscription = useLoader(loadSubscription);
  const [issued, setIssued] = useState<{ url: string; createdAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const data = subscription.data;
  // The feed is off in this server: the whole panel is left out (not shown as a control that does not work).
  if (data && !data.available) return null;

  async function make() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await api<SubscriptionIssued>('POST', '/api/calendar/subscription', {});
      setIssued({ url: new URL(res.path, window.location.origin).toString(), createdAt: res.rotatedAt });
      subscription.retry();
    } catch {
      setError('取り込み用の URL を作れませんでした。通信状態を確認して、もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api<null>('DELETE', '/api/calendar/subscription');
      setIssued(null);
      subscription.retry();
    } catch {
      setError('取り込みを止められませんでした。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
    } catch {
      setCopied(false);
      setError('コピーできませんでした。URL を選んで、手でコピーしてください。');
    }
  }

  return (
    <section className="cal-subscribe panel" aria-labelledby="cal-subscribe-title">
      <h3 id="cal-subscribe-title">自分のカレンダーに取り込む</h3>
      <p className="hint">
        Google カレンダーなどの「URL で追加」に、下の URL を貼ります。中身は、自分の部局の予定と委員会全体の予定、自分が担当・副担当のタスクの期限です。題名と日付だけで、時刻・メモ・担当者は入らず、すべて終日の予定になります。URL は本人だけのものなので、ほかの人に教えないでください。
      </p>
      {subscription.loading && !data && <p className="hint">状態を確認しています…</p>}
      {subscription.error && (
        <p className="status error" role="alert">
          状態を取得できませんでした。
          <button type="button" className="quiet" onClick={subscription.retry}>
            再読み込み
          </button>
        </p>
      )}
      {data && !issued && (
        <p className="hint">{data.subscribed ? `取り込み用の URL を作成済みです（作成: ${fmtDate(data.createdAt ?? '')}、作り直し: ${fmtDate(data.rotatedAt ?? '')}）。URL は作成したときだけ表示されるため、忘れたら作り直してください。` : 'まだ取り込み用の URL はありません。'}</p>
      )}
      {issued && (
        <div className="cal-url">
          <label htmlFor="cal-url">取り込み用の URL（この画面を閉じると、もう表示できません）</label>
          <div className="cal-add-row">
            <input id="cal-url" readOnly value={issued.url} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="secondary" onClick={copy}>
              {copied ? 'コピーしました' : 'コピー'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="cal-actions">
        <button type="button" onClick={make} disabled={busy || !data}>
          {data?.subscribed ? '取り込み用の URL を作り直す' : '取り込み用の URL を作る'}
        </button>
        {data?.subscribed && (
          <button type="button" className="secondary" onClick={stop} disabled={busy}>
            取り込みを止める
          </button>
        )}
      </div>
    </section>
  );
}
