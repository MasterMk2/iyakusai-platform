import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankCheckResponse, BankConnectionState, BankStartResponse, BankStatusResponse } from '../../../shared/bank';
import { api, fmtDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { Facts } from '../books/common';
import { LoadStatus } from '../LoadStatus';
import { takeBankReturnResult } from './return-flow';
import '../payments/payments.css';
import './bank.css';

const STATE_LABEL: Record<BankConnectionState, string> = { disconnected: '未接続', connected: '接続済み', expired: '期限切れ', reconnect_required: '要再接続' };
const STATE_TONE: Record<BankConnectionState, string> = { disconnected: '', connected: 'paid', expired: 'partial', reconnect_required: 'short' };
const SCOPE_LABEL: Record<string, string> = { 'private:account': '口座の照会（残高・入出金明細）', 'private:virtual-account': '振込入金口座の照会' };
const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;

type Busy = 'connect' | 'check' | 'disconnect' | null;

/**
 * 銀行の連携 (2026-11-06): the state of the connection to the bank's API and its three actions. 権限管理者 connect
 * (the browser goes to the bank and comes back to /bank/callback) and disconnect; 会計を見る check the connection.
 * Nobody else sees the panel (the status answers 403). No token is ever on this screen.
 */
export function BankPanel() {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<BankStatusResponse>('GET', '/api/bank/status', undefined, signal);
    },
    [refresh],
  );
  const status = useLoader(load);
  const [busy, setBusy] = useState<Busy>(null);
  // The result of the return from the bank (set by the /bank/callback screen) shows here once.
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(() => takeBankReturnResult());
  const [checked, setChecked] = useState<BankCheckResponse | null>(null);
  const ref = useRef<HTMLElement>(null);
  const cameBack = useRef(result !== null);

  useEffect(() => {
    if (cameBack.current && status.data) {
      cameBack.current = false;
      ref.current?.scrollIntoView({ block: 'start' });
    }
  }, [status.data]);

  if (status.error?.status === 403) return null;
  const s = status.data;
  if (s && !s.configured && !s.canConnect) return null;

  const connect = async () => {
    setBusy('connect');
    setResult(null);
    try {
      const { authorizeUrl } = await api<BankStartResponse>('POST', '/api/bank/oauth/start', {});
      window.location.assign(authorizeUrl);
    } catch (err) {
      setResult({ text: toFailure(err).message, error: true });
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy('check');
    setResult(null);
    setChecked(null);
    try {
      setChecked(await api<BankCheckResponse>('POST', '/api/bank/check', {}));
    } catch (err) {
      setResult({ text: toFailure(err).message, error: true });
    } finally {
      setBusy(null);
      setRefresh((n) => n + 1);
    }
  };
  const disconnect = async () => {
    if (!window.confirm('銀行との接続を切ります。基盤に保存したトークンを消し、つなぎ直すには銀行の画面でもう一度許可が要ります。切りますか？')) return;
    setBusy('disconnect');
    setResult(null);
    setChecked(null);
    try {
      await api<BankStatusResponse>('POST', '/api/bank/disconnect', {});
      setResult({ text: '接続を切り、基盤に保存したトークンを消しました。銀行側の許可は期限まで残ります（銀行に取り消しの手段がありません）。', error: false });
    } catch (err) {
      setResult({ text: toFailure(err).message, error: true });
    } finally {
      setBusy(null);
      setRefresh((n) => n + 1);
    }
  };

  const connected = s?.state === 'connected';
  return (
    <section ref={ref} className="bank-panel" aria-label="銀行の連携" id="bank-connection">
      <h3>銀行の連携（GMOあおぞらネット銀行）</h3>
      <LoadStatus loader={status} what="銀行の連携の状態" compact />
      {s && !s.configured && (
        <p className="hint">
          このサーバーには銀行の連携が設定されていません。運用者が bank.json・クライアントシークレットのファイル・トークン用の鍵を置くと、ここから接続できます（手順は docs/bank.md）。
        </p>
      )}
      {s?.configured && (
        <>
          <p>
            <span className={`pay-badge ${STATE_TONE[s.state]}`}>{STATE_LABEL[s.state]}</span> {s.environmentLabel}
          </p>
          <Facts
            items={[
              ['許可の範囲', s.scopes.length > 0 ? s.scopes.map((x) => SCOPE_LABEL[x] ?? x).join('、') : null],
              ['接続した人', s.connectedBy && s.connectedAt ? `${s.connectedBy}（${fmtDate(s.connectedAt)}）` : null],
              ['トークンの期限', s.accessTokenExpiresAt ? `${fmtDate(s.accessTokenExpiresAt)}${s.refreshable ? '（期限前に基盤が自動で更新します）' : '（更新できないので、期限が来たらつなぎ直します）'}` : connected ? '銀行から期限の知らせがありません' : null],
              ['最後の更新', s.lastRefreshedAt ? fmtDate(s.lastRefreshedAt) : null],
            ]}
          />
          {s.lastError && (
            <p className="status error" role="alert">
              {fmtDate(s.lastError.at)}：{s.lastError.message}
            </p>
          )}
          <div className="admin-actions">
            {s.canConnect && !connected && (
              <button type="button" disabled={busy !== null} onClick={() => void connect()}>
                {busy === 'connect' ? '銀行の画面へ移動中…' : s.state === 'disconnected' ? '銀行と接続する' : '銀行とつなぎ直す'}
              </button>
            )}
            {s.canCheck && connected && (
              <button type="button" disabled={busy !== null} onClick={() => void check()}>
                {busy === 'check' ? '確かめています…' : '接続を確かめる'}
              </button>
            )}
          </div>
          {result && (
            <p className={`status ${result.error ? 'error' : 'ok'}`} role={result.error ? 'alert' : 'status'}>
              {result.text}
            </p>
          )}
          {checked && (
            <div role="status">
              <p className="status ok">{fmtDate(checked.checkedAt)} に銀行から口座を {checked.accounts.length} 件読めました。</p>
              {checked.accounts.length > 0 && (
                <table className="bank-accounts">
                  <thead>
                    <tr>
                      <th>支店</th>
                      <th>科目</th>
                      <th>口座番号</th>
                      <th className="num">残高</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checked.accounts.map((a, i) => (
                      <tr key={i}>
                        <td>{a.branchName ?? '—'}</td>
                        <td>{a.accountTypeName ?? '—'}</td>
                        <td>{a.accountNumberLast4 ? `下4桁 ${a.accountNumberLast4}` : '—'}</td>
                        <td className="num">{a.balanceYen === null ? '—' : yen(a.balanceYen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {s.canConnect && !connected && (
            <p className="hint">
              押すと銀行の画面に移ります。銀行のログイン ID とパスワードで入り「許可する」を押すと、ここに戻って接続が終わります。許可は 60 秒以内に戻らないと無効になります。
            </p>
          )}
          {s.canConnect && s.redirectUri && (
            <p className="hint">
              銀行の画面（sunabar ポータルのアカウント設定）の Redirect_uri には <code>{s.redirectUri}</code> を登録してください。スコープは private:account と private:virtual-account だけを ON にします（振込の権限は使いません）。
            </p>
          )}
          <p className="hint">トークンは暗号化してサーバーにだけ保存し、この画面にも Bot にも出しません。バックアップにも含めないので、サーバーを復元したらつなぎ直します。</p>
          {s.canConnect && connected && (
            <div className="bank-disconnect">
              <button type="button" className="secondary" disabled={busy !== null} onClick={() => void disconnect()}>
                {busy === 'disconnect' ? '切っています…' : '接続を切る'}
              </button>
              <p className="hint">基盤に保存したトークンを消します。つなぎ直すには、銀行の画面でもう一度許可が要ります。</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
