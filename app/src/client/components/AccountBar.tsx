import { useState } from 'react';
import type { AccountSessionResponse } from '../../shared/api';
import { api, toFailure } from '../api';

/** Header for account login: who is signed in, logout, and the mock-composition label. */
export function AccountBar({ session, onLoggedOut }: { session: AccountSessionResponse; onLoggedOut: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const user = session.user;
  async function logout() {
    setError(null);
    try {
      await api('POST', '/api/auth/logout', {});
      onLoggedOut();
    } catch (err) {
      setError(toFailure(err).message);
    }
  }
  return (
    <header className="demo-bar">
      <div className={session.composition === 'mock' ? 'demo-banner' : 'account-banner'} role="note" data-testid="account-banner">
        {session.composition === 'mock' ? (
          <>
            <strong>模擬ログイン構成（合成データのみ）</strong>：本人紐付け・Group 会員・Discord DM は模擬です。ループバックでの試用専用です。
          </>
        ) : (
          <>ログインは本人確認済みの Discord 連携と Group 会員資格で判定しています。受信箱は許可されたものだけが表示されます。</>
        )}
      </div>
      {user && (
        <div className="demo-controls">
          <span className="current-user" data-testid="current-user">
            ログイン中: <strong>{user.displayName}</strong>（{user.roleLabel}）
          </span>
          <button type="button" className="secondary" onClick={() => void logout()}>
            ログアウト
          </button>
          {error && (
            <span className="status error" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
