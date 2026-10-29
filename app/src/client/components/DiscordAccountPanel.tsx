import { useState, type FormEvent } from 'react';
import type { DiscordSessionResponse } from '../../shared/api';
import { api, toFailure } from '../api';

/** Settings for the Discord account: student ID (the login ID), password, and signing out everywhere. */
export function DiscordAccountPanel({ session, onChanged }: { session: DiscordSessionResponse; onChanged: () => void }) {
  const [studentId, setStudentId] = useState(session.account?.studentId ?? '');
  const [studentPassword, setStudentPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const { minLength, maxLength } = session.passwordPolicy;

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ text: success, error: false });
      onChanged();
    } catch (err) {
      setMessage({ text: toFailure(err).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const saveStudentId = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/api/auth/student-id', { studentId: studentId.trim(), password: studentPassword });
      setStudentPassword('');
    }, '学籍番号を保存しました。次回からこの番号でログインします。');
  };

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/api/auth/password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
    }, 'パスワードを変更しました。ほかの端末のログインはすべて終了しました。');
  };

  const logoutEverywhere = () =>
    void run(async () => {
      await api('POST', '/api/auth/logout', { everywhere: true });
    }, 'すべての端末からログアウトしました。');

  return (
    <div className="discord-account" data-testid="discord-account">
      <p className="hint">
        ログインID: {session.account?.initialLoginId}
        {session.account?.departments.length ? ` ／ 部署: ${session.account.departments.join('・')}` : ''}
      </p>
      <form onSubmit={saveStudentId} className="account-form">
        <h4>学籍番号（ログインID）</h4>
        <label>
          学籍番号
          <input value={studentId} onChange={(e) => setStudentId(e.target.value)} autoCapitalize="characters" maxLength={32} required />
        </label>
        <label>
          パスワード（確認のため）
          <input type="password" value={studentPassword} onChange={(e) => setStudentPassword(e.target.value)} autoComplete="current-password" maxLength={1024} required />
        </label>
        <button type="submit" disabled={busy}>
          保存
        </button>
      </form>
      <form onSubmit={changePassword} className="account-form">
        <h4>パスワードの変更</h4>
        <label>
          今のパスワード
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" maxLength={1024} required />
        </label>
        <label>
          新しいパスワード（{minLength}〜{maxLength} 文字）
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" maxLength={1024} required />
        </label>
        <button type="submit" disabled={busy}>
          変更する
        </button>
      </form>
      <h4>端末をなくしたとき</h4>
      <p className="hint">すべての端末のログインを終了します。この端末も再ログインが必要になります。</p>
      <button type="button" className="secondary" disabled={busy} onClick={logoutEverywhere}>
        すべての端末からログアウト
      </button>
      {message && (
        <p className={message.error ? 'status error' : 'status'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
