import { useCallback, useState } from 'react';
import type { LoginActivityResponse, LoginEventKind } from '../../shared/api';
import { api, fmtDate } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

const KIND: Record<LoginEventKind, string> = {
  login_ok: 'ログイン成功',
  login_failed: 'ログイン失敗',
  login_blocked: 'ログイン制限',
  password_failed: 'パスワード再入力の誤り',
  register_ok: '登録完了',
  register_failed: '登録失敗',
  register_blocked: '登録制限',
  code_issued: '登録コード発行（/register）',
  code_bulk_issued: '登録コード一斉発行',
};

const REASON: Record<string, string> = {
  unknown_id: '該当するIDなし',
  wrong_password: 'パスワードの誤り',
  not_active: '登録が済んでいない',
  account_limit: 'アカウントの試行回数の上限',
  client_limit: '接続元の失敗回数の上限',
  wrong_code: '登録コードの誤り',
  no_code: '有効な登録コードなし',
};

const STATUS: Record<LoginActivityResponse['accounts'][number]['status'], string> = { active: '登録済み', pending: '登録待ち', retired: '退会' };

const FAILURE_KINDS = new Set<LoginEventKind>(['login_failed', 'login_blocked', 'password_failed', 'register_failed', 'register_blocked']);

/** Access administrators: each account's sign-in record and the sign-in log, to look into failed sign-ins. */
export function LoginActivityPanel() {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<LoginActivityResponse>('GET', '/api/auth/admin/activity', undefined, signal);
    },
    [refresh],
  );
  const activity = useLoader(load);
  const [failuresOnly, setFailuresOnly] = useState(true);
  const data = activity.data;
  const events = (data?.events ?? []).filter((e) => !failuresOnly || FAILURE_KINDS.has(e.kind));

  return (
    <section className="admin login-activity" aria-labelledby="login-activity-title" data-testid="login-activity">
      <h3 id="login-activity-title">ログインの記録</h3>
      <LoadStatus loader={activity} what="ログインの記録" compact />
      {data && (
        <>
          <p className="hint">
            制限: 1 アカウントあたり 10 分に {data.limits.accountTriesPer10Min} 回・24 時間にパスワードの誤り {data.limits.accountFailuresPerDay} 回まで。
            同じ接続元からの失敗は {data.limits.clientWindowMinutes} 分に {data.limits.clientFailures} 回まで（ログインと登録で別々）。パスワードや登録コードそのものは記録していません。
          </p>
          <button type="button" className="secondary" onClick={() => setRefresh((n) => n + 1)}>
            更新
          </button>
          <h4>アカウント</h4>
          <div style={{ overflowX: 'auto' }}>
            <table data-testid="login-activity-accounts">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>ログインID</th>
                  <th>状態</th>
                  <th>最後のログイン</th>
                  <th>その後の失敗</th>
                  <th>24 時間の失敗</th>
                  <th>登録コード</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => (
                  <tr key={a.initialLoginId} data-account={a.initialLoginId}>
                    <td>{a.name ?? '（名簿になし）'}</td>
                    <td>
                      {a.studentId ?? '—'}
                      <br />
                      <small>{a.initialLoginId}</small>
                    </td>
                    <td>
                      {STATUS[a.status]}
                      {a.limited && <strong>（制限中）</strong>}
                    </td>
                    <td>{a.lastLoginAt ? fmtDate(a.lastLoginAt) : '—'}</td>
                    <td>{a.failedSinceLogin > 0 ? <strong>{a.failedSinceLogin} 回</strong> : '0 回'}</td>
                    <td>{a.failures24h} 回</td>
                    <td>
                      {a.pendingCode
                        ? `${a.pendingCode.bulk ? '一斉発行' : '/register'}・${fmtDate(a.pendingCode.expiresAt)} まで${a.pendingCode.attempts ? `（誤り ${a.pendingCode.attempts} 回）` : ''}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>記録（直近 {data.days} 日・新しい順）</h4>
          <label className="checkbox">
            <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} />
            失敗と制限だけ表示
          </label>
          {events.length === 0 ? (
            <p className="empty">{failuresOnly ? 'この期間に失敗はありません。' : 'この期間の記録はありません。'}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table data-testid="login-activity-events">
                <thead>
                  <tr>
                    <th>日時</th>
                    <th>内容</th>
                    <th>入力されたID</th>
                    <th>アカウント</th>
                    <th>接続元</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td>{fmtDate(e.at)}</td>
                      <td>
                        {KIND[e.kind] ?? e.kind}
                        {e.reason && <small>（{REASON[e.reason] ?? e.reason}）</small>}
                      </td>
                      <td>{e.loginId ?? '—'}</td>
                      <td>{e.account ? `${e.name ?? ''} ${e.account}`.trim() : '—'}</td>
                      <td>{e.client ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
