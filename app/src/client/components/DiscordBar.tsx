import { useState } from 'react';
import type { DiscordSessionResponse } from '../../shared/api';
import { api, fmtDate, toFailure } from '../api';
import { Masthead } from './AppShell';

/** Header for the Discord account login: who is signed in and logout, then any warning that needs action. */
export function DiscordBar({ session, onLoggedOut, onOpenSettings }: { session: DiscordSessionResponse; onLoggedOut: () => void; onOpenSettings: () => void }) {
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
    <>
      <Masthead>
        {user && (
          <div className="session">
            <span className="current-user" data-testid="current-user">
              <strong>{user.displayName}</strong>
              <small>{user.roleLabel}</small>
            </span>
            <button type="button" className="quiet" onClick={() => void logout()}>
              ログアウト
            </button>
          </div>
        )}
      </Masthead>
      {error && (
        <p className="banner banner-error" role="alert">
          ログアウトできませんでした: {error}
        </p>
      )}
      {session.degraded && (
        <div className="banner banner-warning" role="alert" data-testid="degraded-banner">
          いま Discord との確認ができないため、最後に確認できた所属で動いています。新しいログインや登録・パスワード変更はできません。
        </div>
      )}
      {user && session.account && <SignInNotice account={session.account} onOpenSettings={onOpenSettings} />}
      {user && session.account && !session.account.studentId && (
        // Accounts registered before the student ID login (the minimal runtime) have none yet.
        <div className="banner banner-info" role="note" data-testid="student-id-banner">
          <span>学籍番号がまだ登録されていません。登録すると、次回から学籍番号でログインできます（今は iy- で始まるログインIDを使っています）。</span>
          <button type="button" className="secondary" onClick={onOpenSettings}>
            学籍番号を登録する
          </button>
        </div>
      )}
    </>
  );
}

const DISMISSED_KEY = 'iy-signin-notice-dismissed';

/**
 * After a sign-in: when the person last signed in and how many wrong passwords the account had since
 * then. Shown until closed; closing is remembered on this device for that sign-in only.
 */
function SignInNotice({ account, onOpenSettings }: { account: NonNullable<DiscordSessionResponse['account']>; onOpenSettings: () => void }) {
  const { previousLoginAt, failedSince } = account.signIn;
  const key = `${account.initialLoginId}|${previousLoginAt ?? '-'}|${failedSince}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISSED_KEY) === key;
    } catch {
      return false;
    }
  });
  if (dismissed || (previousLoginAt === null && failedSince === 0)) return null;
  const close = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, key);
    } catch {
      // not remembered; closed for now
    }
    setDismissed(true);
  };
  const since = previousLoginAt ? `前回のログイン（${fmtDate(previousLoginAt)}）以降` : 'これまでに';
  return failedSince > 0 ? (
    <div className="banner banner-warning" role="alert" data-testid="signin-notice">
      <span>
        {since}、このアカウントでパスワードの誤りが <strong>{failedSince} 回</strong>ありました。心当たりがなければ、設定からパスワードを変更してください。
      </span>
      <button type="button" className="secondary" onClick={onOpenSettings}>
        設定を開く
      </button>
      <button type="button" className="quiet" onClick={close}>
        閉じる
      </button>
    </div>
  ) : (
    <div className="banner banner-info" role="note" data-testid="signin-notice">
      <span>前回のログイン: {fmtDate(previousLoginAt!)}。それ以降、ログインの失敗はありません。</span>
      <button type="button" className="quiet" onClick={close}>
        閉じる
      </button>
    </div>
  );
}
