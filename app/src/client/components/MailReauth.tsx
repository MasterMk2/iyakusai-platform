import { useState, type FormEvent } from 'react';
import { api, toFailure } from '../api';

/**
 * Shown in place of the mail screens after `idleHours` without mail use on this device: the password
 * opens mail again. Other screens (tasks, rental, settings) stay signed in.
 */
export function MailReauth({ idleHours, onDone }: { idleHours: number; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/reauth', { password });
      setPassword('');
      onDone();
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="main mail-reauth" aria-labelledby="mail-reauth-title" data-testid="mail-reauth">
      <h2 id="mail-reauth-title">メールを開くにはパスワードが必要です</h2>
      <p className="hint">
        この端末で {idleHours} 時間メールを使っていなかったため、メールの画面だけ鍵をかけています。タスク・物品貸出・設定はこのまま使えます。
      </p>
      <form className="account-form" onSubmit={submit}>
        <label>
          パスワード
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? '確認中…' : 'メールを開く'}
        </button>
      </form>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
