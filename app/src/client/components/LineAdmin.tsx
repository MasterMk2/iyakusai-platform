import { useCallback, useState } from 'react';
import type { AuditEntry } from '../../shared/api';
import { MOCK_PUSH_OUTCOMES, type LineAccessMatrixResponse, type LineIngestReport, type LineLevel, type MockPushOutcome } from '../../shared/line';
import { api, ApiFailure, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

const LEVEL_LABEL: Record<LineLevel, string> = { none: '権限なし', read: '閲覧', edit: '編集' };
const OUTCOME_LABEL: Record<MockPushOutcome, string> = {
  accept: '受付',
  fail_before_accept: '送信前に失敗',
  accept_response_lost: '受付後に応答が失われる',
  server_error: 'サーバーエラー（結果不明）',
  rate_limited: '回数制限（429）',
  permission_denied: '権限なし（403）',
  not_configured: '送信経路が未設定',
  ineligible: '送信先の条件を満たさない',
};

/**
 * LINE grants per account. Reply is a separate capability from read/edit.
 * The administrator manages grants only and never sees conversation contents.
 * `demoControls`: synthetic event release and scripted mock send results (demo mode only).
 */
export function LineAdmin({ demoControls, onChanged }: { demoControls: boolean; onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'conflict'; text: string } | null>(null);
  const [outcome, setOutcome] = useState<MockPushOutcome>('accept');

  const loadMatrix = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<LineAccessMatrixResponse>('GET', '/api/admin/line/access', undefined, signal).catch((err: unknown) => {
        if (err instanceof ApiFailure && err.status === 404) return null; // LINE is not enabled
        throw err;
      });
    },
    [refresh],
  );
  const matrix = useLoader(loadMatrix);
  const loadAudit = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<AuditEntry[]>('GET', '/api/admin/line/audit', undefined, signal).catch(() => [] as AuditEntry[]);
    },
    [refresh],
  );
  const audit = useLoader(loadAudit);

  if (matrix.data === null && !matrix.loading && !matrix.error) return null;

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

  const m = matrix.data;
  const grantOf = (userId: string, accountId: string) => m?.grants.find((g) => g.userId === userId && g.accountId === accountId) ?? { level: 'none' as const, reply: false };
  const update = (userId: string, name: string, accountId: string, accountName: string, level: LineLevel, reply: boolean) =>
    void act(async () => {
      await api('PUT', '/api/admin/line/access', { userId, accountId, level, reply: level === 'none' ? false : reply, expectedVersion: m!.version });
      return `${name} の LINE「${accountName}」権限を「${LEVEL_LABEL[level]}${level !== 'none' && reply ? '・返信可' : ''}」に変更しました。`;
    });

  return (
    <section className="line-admin" aria-label="LINE の権限">
      <h3>LINE アカウントごとの権限</h3>
      <p className="hint">
        閲覧・編集と返信は別の権限です。返信には閲覧権限が必要です。権限管理者は会話の内容を閲覧できません。LINE は模擬モードで、実際の LINE には接続していません。
      </p>
      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
      <LoadStatus loader={matrix} what="LINE の権限表" />
      {m && (
        <table className="access-matrix">
          <thead>
            <tr>
              <th>利用者</th>
              {m.accounts.map((a) => (
                <th key={a.id}>{a.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.users.map((u) => (
              <tr key={u.id}>
                <th scope="row">{u.displayName}</th>
                {m.accounts.map((a) => {
                  const g = grantOf(u.id, a.id);
                  return (
                    <td key={a.id}>
                      <select
                        aria-label={`${u.displayName} の LINE「${a.name}」権限`}
                        value={g.level}
                        disabled={busy}
                        onChange={(e) => update(u.id, u.displayName, a.id, a.name, e.target.value as LineLevel, g.reply)}
                      >
                        {(['none', 'read', 'edit'] as const).map((l) => (
                          <option key={l} value={l}>
                            {LEVEL_LABEL[l]}
                          </option>
                        ))}
                      </select>
                      {a.kind === 'official_account' && (
                        <label className="reply-grant">
                          <input
                            type="checkbox"
                            aria-label={`${u.displayName} の LINE「${a.name}」返信権限`}
                            checked={g.reply}
                            disabled={busy || g.level === 'none'}
                            onChange={(e) => update(u.id, u.displayName, a.id, a.name, g.level, e.target.checked)}
                          />
                          返信
                        </label>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {demoControls && (
        <div className="admin-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(async () => {
              const r = await api<{ releasedBatch: number; report: LineIngestReport }>('POST', '/api/demo/line/release');
              const x = r.report;
              return `LINE の模擬イベントを取り込みました: 追加 ${x.imported} ／ 重複 ${x.duplicates} ／ 競合 ${x.conflicts} ／ 抑止 ${x.suppressed} ／ 拒否 ${x.rejected} ／ 送信取消 ${x.unsent}`;
            })}
          >
            LINE の模擬イベントを取り込む
          </button>
          <label>
            次の LINE 模擬送信の結果（デモ）
            <select value={outcome} disabled={busy} onChange={(e) => setOutcome(e.target.value as MockPushOutcome)}>
              {MOCK_PUSH_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABEL[o]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void act(async () => {
              await api('PUT', '/api/demo/line/connector', { next: [outcome] });
              return `次の LINE 模擬送信の結果を「${OUTCOME_LABEL[outcome]}」に設定しました。`;
            })}
          >
            設定する
          </button>
        </div>
      )}
      <h3>監査ログ（LINE）</h3>
      <ul className="line-audit">
        {(audit.data ?? []).map((a) => (
          <li key={a.id}>
            {fmtDate(a.at)} {a.actorName}: {a.detail}
          </li>
        ))}
      </ul>
    </section>
  );
}
