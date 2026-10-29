import { useState, type FormEvent } from 'react';
import type { DiscordSessionResponse } from '../../shared/api';
import { api, toFailure } from '../api';
import { CardReaderLogin } from './CardLogin';

/**
 * Sign-in with the student ID and password, and first registration with the code that the Bot sends by
 * Discord DM after `/register`. The registration form opens at /register (the link in that DM).
 */
export function DiscordLogin({ session, onLoggedIn }: { session: DiscordSessionResponse; onLoggedIn: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>(window.location.pathname === '/register' ? 'register' : 'login');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [initialLoginId, setInitialLoginId] = useState('');
  const [code, setCode] = useState('');
  const [studentId, setStudentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { minLength, maxLength } = session.passwordPolicy;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  const done = () => {
    setPassword('');
    setConfirmation('');
    if (window.location.pathname === '/register' || window.location.pathname === '/login') window.history.replaceState(null, '', '/');
    onLoggedIn();
  };

  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/api/auth/login', { loginId: loginId.trim(), password });
      done();
    });
  };

  const length = [...password].length;
  const passwordProblem = length > 0 && length < minLength ? `パスワードは ${minLength} 文字以上にしてください。` : length > maxLength ? `パスワードは ${maxLength} 文字以内にしてください。` : null;
  const mismatch = confirmation.length > 0 && confirmation !== password;
  const submitRegister = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/api/auth/register', { initialLoginId: initialLoginId.trim().toLowerCase(), code: code.trim(), studentId: studentId.trim(), password });
      done();
    });
  };

  return (
    <main className="login account-login" data-testid="discord-login">
      {mode === 'login' && <CardReaderLogin onLoggedIn={onLoggedIn} />}
      {mode === 'login' ? (
        <form className="account-form" onSubmit={submitLogin}>
          <h2>ログイン</h2>
          <p className="hint">医薬祭アカウントの学籍番号とパスワードを入力してください。この端末では {session.sessionDays} 日間ログインしたままになります。</p>
          <label>
            学籍番号
            <input value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" inputMode="text" autoCapitalize="characters" required maxLength={64} />
          </label>
          <label>
            パスワード
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required maxLength={1024} />
          </label>
          <button type="submit" disabled={busy}>
            ログイン
          </button>
          {error && (
            <p className="status error" role="alert">
              {error}
            </p>
          )}
          <p className="hint">
            はじめて使うとき・パスワードを忘れたときは、医薬祭の Discord サーバーで <code>/register</code> を実行してください。Bot から届く DM のログインID（iy- で始まる番号）と登録コードで、下の初回登録（再設定）をします。
          </p>
          <button type="button" className="secondary" onClick={() => setMode('register')}>
            初回登録へ
          </button>
        </form>
      ) : (
        <form className="account-form" onSubmit={submitRegister}>
          <h2>初回登録</h2>
          <p className="hint">
            Bot から届いた DM のログインIDと登録コードを入力し、学籍番号とパスワードを決めます。<code>/register</code> で届くコードは 5 分、委員会が一斉に送ったコードは DM に書かれた期限まで使えます。
          </p>
          <label>
            ログインID（DM に書かれた iy- で始まる番号）
            <input value={initialLoginId} onChange={(e) => setInitialLoginId(e.target.value)} placeholder="iy-00000000" autoComplete="off" required maxLength={16} />
          </label>
          <label>
            登録コード（8 桁）
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required maxLength={16} />
          </label>
          <label>
            学籍番号（次回からのログインID）
            <input value={studentId} onChange={(e) => setStudentId(e.target.value)} autoComplete="username" autoCapitalize="characters" maxLength={32} placeholder="登録済みの人・委員会の名簿にある人は空欄でも可" />
          </label>
          <label>
            パスワード（{minLength}〜{maxLength} 文字）
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required maxLength={1024} />
          </label>
          <label>
            パスワード（確認）
            <input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" required maxLength={1024} />
          </label>
          {(passwordProblem || mismatch) && <p className="status error">{passwordProblem ?? 'パスワードが一致しません。'}</p>}
          <button type="submit" disabled={busy || !!passwordProblem || mismatch || confirmation.length === 0}>
            登録してログイン
          </button>
          {error && (
            <p className="status error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="secondary" onClick={() => setMode('login')}>
            ログインへ戻る
          </button>
        </form>
      )}
    </main>
  );
}
