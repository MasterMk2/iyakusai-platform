import { useCallback, useState } from 'react';
import type { SessionResponse, SessionUser } from '../../shared/api';
import type { TaskContextResponse } from '../../shared/tasks';
import { TASK_ROLE_LABELS } from '../../shared/tasks';
import { api, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { AdminPanel } from './AdminPanel';
import { DiscordAccountPanel } from './DiscordAccountPanel';
import { LoadStatus } from './LoadStatus';
import { LoginActivityPanel } from './LoginActivityPanel';
import { MailAccessPanel } from './MailAccessPanel';
import { RentalAccessPanel } from './RentalAccessPanel';
import { CardSettingsPanel } from './CardSettingsPanel';
import { storeTheme, THEME_LABELS, useTheme, type ThemeChoice } from '../theme';

interface MockPerson {
  principalId: string;
  label: string;
  email: string;
  provenance: string;
  membership: string;
  active: boolean;
  dm: string;
}

const PROVENANCE: Record<string, string> = { direct: '直接', nested: '入れ子', organization: '全組織' };

/** Settings: account, task-service status, access administration and (mock only) directory controls. */
export function SettingsView({
  session,
  user,
  tasks,
  committeeMail = false,
  committeeLine = false,
  onChanged,
}: {
  session: SessionResponse;
  user: SessionUser;
  tasks: TaskContextResponse | null;
  /** The committee mailbox is configured: its edit grants replace the synthetic access screen. */
  committeeMail?: boolean;
  /** The committee's official LINE account is open here (2026-10-28): its grants below the mailbox's. */
  committeeLine?: boolean;
  onChanged: () => void;
}) {
  const account = 'authMode' in session && session.authMode === 'account' ? session : null;
  const discord = 'authMode' in session && session.authMode === 'discord' ? session : null;
  return (
    <main className="main settings">
      <h2>設定</h2>
      {discord && <CardSettingsPanel admin={user.canManageAccess} onChanged={onChanged} />}
      <section aria-label="アカウント">
        <h3>アカウント</h3>
        <p>
          {user.displayName}（{user.roleLabel}）
        </p>
        {discord ? (
          <DiscordAccountPanel session={discord} onChanged={onChanged} />
        ) : account ? (
          <p className="hint">
            パスワードを変更するときは、ログアウトして「初回登録・パスワード再設定」から、連携済みの Discord に届く確認コードで再設定してください。再設定すると、ほかの端末のログインもすべて終了します。
          </p>
        ) : session.demoAuthentication ? (
          <p className="hint">デモ用モック認証です。ペルソナは画面上部で切り替えます。</p>
        ) : (
          <p className="hint">利用者はリバースプロキシの認証で識別しています。</p>
        )}
      </section>
      <ThemeSection />
      <section aria-label="タスク連携">
        <h3>委員会タスク</h3>
        {!tasks ? (
          <p className="hint">確認中です。</p>
        ) : !tasks.enabled ? (
          <p className="hint">このサーバーではタスク機能が設定されていません。</p>
        ) : !tasks.bound ? (
          <p className="hint">このアカウントはタスク機能の利用者として登録されていません。</p>
        ) : (
          <ul>
            {tasks.memberships.map((m) => (
              <li key={m.workspace.id}>
                {m.workspace.name}: {TASK_ROLE_LABELS[m.role]}
              </li>
            ))}
          </ul>
        )}
        <p className="hint">タスクの保存先は委員会タスク管理サービスだけです。Web と Discord の操作は同じタスク・版・履歴を使います。</p>
      </section>
      {user.canManageAccess && <RentalAccessPanel onChanged={onChanged} />}
      {user.canManageAccess && (committeeMail ? <MailAccessPanel /> : <AdminPanel user={user} onChanged={onChanged} demoControls={session.demoAuthentication === true} />)}
      {user.canManageAccess && committeeMail && committeeLine && <MailAccessPanel variant="line" />}
      {user.canManageAccess && discord && <LoginActivityPanel />}
      {account?.composition === 'mock' && <MockDirectory onChanged={onChanged} />}
    </main>
  );
}

/** The colour theme for this browser (2026-10-28); a choice takes effect at once, with no save. The header's button changes the same choice. */
function ThemeSection() {
  const theme = useTheme();
  const choose = (next: ThemeChoice) => storeTheme(next);
  return (
    <section aria-label="画面の色">
      <h3>画面の色</h3>
      <fieldset className="theme-choice">
        <legend className="sr-only">画面の色</legend>
        {(Object.keys(THEME_LABELS) as ThemeChoice[]).map((key) => (
          <label key={key} className="status-option">
            <input type="radio" name="theme" value={key} checked={theme === key} onChange={() => choose(key)} />
            {THEME_LABELS[key]}
          </label>
        ))}
      </fieldset>
      <p className="hint">はじめは若葉です。画面上の名前の横のボタンでも、若葉・ライト・ダークを順に切り替えられます。この端末のこのブラウザーだけに保存します。</p>
    </section>
  );
}

function MockDirectory({ onChanged }: { onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<{ notice: string; people: MockPerson[] }>('GET', '/api/mock/directory', undefined, signal);
    },
    [refresh],
  );
  const directory = useLoader(load);
  const [message, setMessage] = useState<string | null>(null);
  async function apply(principalId: string, action: string) {
    setMessage(null);
    try {
      const res = await api<{ revoked: { sessions: number } }>('POST', '/api/mock/directory', { principalId, action });
      setMessage(`模擬ディレクトリを変更しました（終了したセッション: ${res.revoked.sessions}）。`);
      setRefresh((n) => n + 1);
      onChanged();
    } catch (err) {
      setMessage(toFailure(err).message);
    }
  }
  return (
    <section className="admin" aria-label="模擬ディレクトリ" data-testid="mock-directory">
      <h3>模擬ディレクトリ（試用専用・合成データ）</h3>
      <p className="hint">会員資格の喪失・利用停止・Discord 連携の置き換えを模擬して、ログインとセッションへの反映を確認できます。本番構成にはこの画面と API はありません。</p>
      <LoadStatus loader={directory} what="模擬ディレクトリ" compact />
      {message && <p className="status info">{message}</p>}
      <table>
        <thead>
          <tr>
            <th>人物</th>
            <th>メール</th>
            <th>会員資格</th>
            <th>状態</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {(directory.data?.people ?? []).map((p) => (
            <tr key={p.principalId} data-mock-person={p.principalId}>
              <td>{p.label}</td>
              <td>{p.email}</td>
              <td>
                {PROVENANCE[p.provenance] ?? p.provenance}・{p.membership === 'member' ? '会員' : p.membership === 'removed' ? '喪失' : '未確定'}
              </td>
              <td>
                {p.active ? '有効' : '停止'}・DM {p.dm === 'open' ? '受信可' : '拒否'}
              </td>
              <td className="admin-actions">
                <button type="button" className="secondary" onClick={() => void apply(p.principalId, p.membership === 'member' ? 'remove_membership' : 'restore_membership')}>
                  {p.membership === 'member' ? '会員資格を外す' : '会員資格を戻す'}
                </button>
                <button type="button" className="secondary" onClick={() => void apply(p.principalId, p.active ? 'disable' : 'enable')}>
                  {p.active ? '利用停止' : '利用再開'}
                </button>
                <button type="button" className="secondary" onClick={() => void apply(p.principalId, 'replace_binding')}>
                  Discord 連携を置き換え
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
