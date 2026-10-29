import { useState } from 'react';
import type { FaultState, SessionUser } from '../../shared/api';
import { api, toFailure } from '../api';

/**
 * Always-visible demo banner: mock authentication label and persona switch.
 * Sample reset and fault simulation affect every persona, so only the demo administrator gets them.
 */
export function DemoBar({ user, onChanged }: { user: SessionUser | null; onChanged: () => void }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState({ failNextRequests: 1, delayNextRequests: 1, delayMs: 3000 });

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await action() });
    } catch (err) {
      setMessage({ kind: 'error', text: toFailure(err).message });
    } finally {
      setBusy(false);
    }
  }

  async function applyFaults(kind: 'fail' | 'delay' | 'clear') {
    await run(async () => {
      const current = await api<FaultState>('GET', '/api/demo/faults');
      const next: FaultState = {
        ...current,
        failNextRequests: kind === 'fail' ? fault.failNextRequests : kind === 'clear' ? 0 : current.failNextRequests,
        delayNextRequests: kind === 'delay' ? fault.delayNextRequests : kind === 'clear' ? 0 : current.delayNextRequests,
        delayMs: kind === 'delay' ? fault.delayMs : current.delayMs,
        connectorFailMailboxId: kind === 'clear' ? null : current.connectorFailMailboxId,
      };
      await api('PUT', '/api/demo/faults', next);
      if (kind === 'clear') return '障害シミュレーションを解除しました。';
      return kind === 'fail'
        ? `次の ${next.failNextRequests} 件の API 要求を失敗させます。`
        : `次の ${next.delayNextRequests} 件の API 要求を ${next.delayMs} ミリ秒遅らせます。`;
    });
  }

  return (
    <header className="demo-bar">
      <div className="demo-banner" role="note" data-testid="demo-auth-banner">
        <strong>デモ用モック認証</strong>：ペルソナの切り替えは本番の認証ではありません。表示されるメール・人物・アドレスはすべて合成データです。
      </div>
      {user && (
        <div className="demo-controls">
          <span className="current-user" data-testid="current-user">
            ログイン中（デモ）: <strong>{user.displayName}</strong>（{user.roleLabel}）
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => void run(async () => {
              await api('DELETE', '/api/session');
              onChanged();
              return 'ペルソナ選択に戻りました。';
            })}
          >
            ペルソナを切り替える
          </button>
          {!user.canManageAccess && (
            <span className="hint" data-testid="demo-controls-policy">
              サンプルのリセットと障害シミュレーションはデモ管理者だけが実行できます。
            </span>
          )}
          {user.canManageAccess && (confirmReset ? (
            <span className="confirm">
              合成サンプルを初期状態に戻しますか？（全ペルソナの変更が消えます）
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void run(async () => {
                  await api('POST', '/api/demo/reset');
                  setConfirmReset(false);
                  onChanged();
                  return '合成サンプルを初期化しました。';
                })}
              >
                リセットする
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmReset(false)}>
                やめる
              </button>
            </span>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmReset(true)}>
              サンプルをリセット
            </button>
          ))}
          {user.canManageAccess && (
            <details className="fault-panel">
              <summary>障害シミュレーション（デモ）</summary>
              <p className="hint">失敗・遅延・キャンセル・再試行の動作確認用です。設定は全ペルソナの次の要求に適用されます（ペルソナ選択とこの操作自体を除く）。</p>
              <label>
                失敗させる件数
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={fault.failNextRequests}
                  onChange={(e) => setFault({ ...fault, failNextRequests: Number(e.target.value) })}
                />
              </label>
              <button type="button" disabled={busy} onClick={() => void applyFaults('fail')}>
                次の要求を失敗させる
              </button>
              <label>
                遅延させる件数
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={fault.delayNextRequests}
                  onChange={(e) => setFault({ ...fault, delayNextRequests: Number(e.target.value) })}
                />
              </label>
              <label>
                遅延（ミリ秒）
                <input
                  type="number"
                  min={0}
                  max={10000}
                  step={500}
                  value={fault.delayMs}
                  onChange={(e) => setFault({ ...fault, delayMs: Number(e.target.value) })}
                />
              </label>
              <button type="button" disabled={busy} onClick={() => void applyFaults('delay')}>
                次の要求を遅らせる
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void applyFaults('clear')}>
                解除
              </button>
            </details>
          )}
        </div>
      )}
      {message && (
        <p className={`status ${message.kind === 'ok' ? 'ok' : 'error'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </header>
  );
}
