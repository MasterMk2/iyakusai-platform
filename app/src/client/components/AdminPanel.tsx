import { useCallback, useState } from 'react';
import type { AccessLevel, AccessMatrixResponse, AuditEntry, FaultState, SessionUser, SyncReport } from '../../shared/api';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';
import { LineAdmin } from './LineAdmin';

const LEVEL_LABEL: Record<AccessLevel, string> = { none: '権限なし', read: '閲覧', edit: '編集' };

/** `demoControls` is false in trusted-proxy mode, where the connector fault simulation does not exist. */
export function AdminPanel({ user, onChanged, demoControls = true }: { user: SessionUser; onChanged: () => void; demoControls?: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'conflict'; text: string } | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [failMailbox, setFailMailbox] = useState('');

  const loadMatrix = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<AccessMatrixResponse>('GET', '/api/admin/access', undefined, signal);
    },
    [refresh],
  );
  const matrix = useLoader(loadMatrix);
  const loadAudit = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<AuditEntry[]>('GET', '/api/admin/audit', undefined, signal);
    },
    [refresh],
  );
  const audit = useLoader(loadAudit);

  if (!user.canManageAccess) {
    return <p className="status error">この画面はデモ管理者だけが利用できます。</p>;
  }

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await fn() });
    } catch (err) {
      const failure = toFailure(err);
      setMessage({ kind: failure.status === 409 ? 'conflict' : 'error', text: failure.message });
    } finally {
      setBusy(false);
      setRefresh((n) => n + 1);
      onChanged();
    }
  }

  const grantOf = (userId: string, mailboxId: string): AccessLevel =>
    matrix.data?.grants.find((g) => g.userId === userId && g.mailboxId === mailboxId)?.level ?? 'none';

  return (
    <div className="admin">
      <h2>デモ管理（権限とモック同期）</h2>
      <p className="hint">
        権限の変更は次の要求から即時に反映されます。担当者の割り当てでは権限は付与されません。デモ管理者自身はメールを閲覧できません。
      </p>
      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
      <h3>受信箱ごとの権限</h3>
      <LoadStatus loader={matrix} what="権限表" />
      {matrix.data && (
        <table className="access-matrix">
          <thead>
            <tr>
              <th>利用者</th>
              {matrix.data.mailboxes.map((m) => (
                <th key={m.id}>{m.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.data.users.map((u) => (
              <tr key={u.id}>
                <th scope="row">
                  {u.displayName}
                  <span className="persona-role">{u.roleLabel}</span>
                </th>
                {matrix.data!.mailboxes.map((m) => (
                  <td key={m.id}>
                    <select
                      aria-label={`${u.displayName} の ${m.name} 権限`}
                      value={grantOf(u.id, m.id)}
                      disabled={busy}
                      onChange={(e) => {
                        const level = e.target.value as AccessLevel;
                        const version = matrix.data!.version;
                        void act(async () => {
                          await api('PUT', '/api/admin/access', { userId: u.id, mailboxId: m.id, level, expectedVersion: version });
                          return `${u.displayName} の「${m.name}」権限を「${LEVEL_LABEL[level]}」に変更しました。`;
                        });
                      }}
                    >
                      {(['none', 'read', 'edit'] as const).map((l) => (
                        <option key={l} value={l}>
                          {LEVEL_LABEL[l]}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>モック受信コネクター</h3>
      <p className="hint">
        リポジトリ内の合成フィードだけを読み込むモックです。実際のメールサーバーには接続せず、接続元での送信・移動・削除・既読化は行いません。
      </p>
      <div className="admin-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(async () => {
            const r = await api<{ releasedBatch: number }>('POST', '/api/admin/mock/release');
            return `モックの新着バッチ ${r.releasedBatch} を配信しました。同期すると取り込まれます。`;
          })}
        >
          新着を模擬配信
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(async () => {
            const r = await api<SyncReport>('POST', '/api/admin/sync', { mode: 'incremental' });
            setReport(r);
            return r.failed > 0 ? '一部の受信箱で取得に失敗しました。再試行すると失敗分だけ取り込みます。' : 'モック同期が完了しました。';
          })}
        >
          モック同期（差分）
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(async () => {
            const r = await api<SyncReport>('POST', '/api/admin/sync', { mode: 'full' });
            setReport(r);
            return '全件を再取得しました。既存の受信と対応情報は変更されません。';
          })}
        >
          モック同期（全件再取得）
        </button>
        {demoControls && <label>
          同期で失敗させる受信箱（デモ）
          <select
            value={failMailbox}
            disabled={busy}
            onChange={(e) => {
              const value = e.target.value;
              setFailMailbox(value);
              void act(async () => {
                const current = await api<FaultState>('GET', '/api/demo/faults');
                await api('PUT', '/api/demo/faults', { ...current, connectorFailMailboxId: value || null });
                return value ? 'コネクターの模擬障害を設定しました。' : 'コネクターの模擬障害を解除しました。';
              });
            }}
          >
            <option value="">なし</option>
            {(matrix.data?.mailboxes ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>}
      </div>
      {report && (
        <table className="sync-report" data-testid="sync-report">
          <caption>
            同期結果: 取り込み {report.imported} ／ 重複 {report.duplicates} ／ 不正 {report.rejected} ／ 失敗 {report.failed}
          </caption>
          <thead>
            <tr>
              <th>受信箱</th>
              <th>取り込み</th>
              <th>重複</th>
              <th>不正</th>
              <th>結果</th>
            </tr>
          </thead>
          <tbody>
            {report.mailboxes.map((m) => (
              <tr key={m.mailboxId}>
                <td>{matrix.data?.mailboxes.find((x) => x.id === m.mailboxId)?.name ?? m.mailboxId}</td>
                <td>{m.imported}</td>
                <td>{m.duplicates}</td>
                <td>{m.rejected}</td>
                <td>{m.failed ? `失敗: ${m.error ?? ''}` : '成功'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>監査ログ（権限・同期）</h3>
      <LoadStatus loader={audit} what="監査ログ" />
      <ul className="audit">
        {(audit.data ?? []).map((a) => (
          <li key={a.id}>
            {fmtDate(a.at)} {a.actorName}: {a.detail}
          </li>
        ))}
      </ul>

      <LineAdmin demoControls={demoControls} onChanged={onChanged} />
    </div>
  );
}
