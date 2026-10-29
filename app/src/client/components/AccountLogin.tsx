import { useCallback, useState, type FormEvent } from 'react';
import type { AccountSessionResponse } from '../../shared/api';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

type Step = { kind: 'login' } | { kind: 'request' } | { kind: 'code'; challengeId: string; email: string; message: string } | { kind: 'password' };

interface MockDm {
  at: string;
  recipientLabel: string;
  verifiedEmail: string | null;
  code: string;
  expiresAt: string;
}

/**
 * Account login: normal email + own password, or first registration / password reset through a
 * one-time code that the Bot DMs to the verified Discord account linked to the email.
 */
export function AccountLogin({ session, onLoggedIn }: { session: AccountSessionResponse; onLoggedIn: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'login' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
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

  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/api/auth/login', { email, password });
      setPassword('');
      onLoggedIn();
    });
  };

  const submitRequest = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ challengeId: string; message: string }>('POST', '/api/auth/setup/request', { email });
      setCode('');
      setStep({ kind: 'code', challengeId: res.challengeId, email, message: res.message });
    });
  };

  const resend = (challengeId: string) =>
    run(async () => {
      const res = await api<{ message: string }>('POST', '/api/auth/setup/resend', { challengeId });
      setInfo(`再送を受け付けました。${res.message}`);
    });

  const submitCode = (e: FormEvent, challengeId: string) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<{ hasPassword: boolean }>('POST', '/api/auth/setup/verify', { challengeId, code: code.trim() });
      setInfo(res.hasPassword ? '本人確認ができました。新しいパスワードを設定すると、これまでのログイン状態はすべて終了します。' : '本人確認ができました。パスワードを設定してください。');
      setStep({ kind: 'password' });
    });
  };

  const tooShort = [...password].length > 0 && [...password].length < minLength;
  const tooLong = [...password].length > maxLength;
  const mismatch = confirmation.length > 0 && confirmation !== password;
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (tooShort || tooLong || mismatch || password.length === 0) {
      setError('パスワードの条件と確認入力を確認してください。');
      return;
    }
    void run(async () => {
      await api('POST', '/api/auth/setup/password', { password, confirmation });
      setPassword('');
      setConfirmation('');
      onLoggedIn();
    });
  };

  return (
    <main className="login account-login">
      <h1>共有受信・委員会タスク</h1>
      {session.composition === 'mock' && (
        <p className="status warning" role="note" data-testid="mock-composition-banner">
          模擬ログイン構成です。本人紐付け・Group 会員・Discord DM はすべて合成データで、実際の Discord には送信しません。
        </p>
      )}
      <div className="actions" role="tablist">
        <button type="button" role="tab" aria-selected={step.kind === 'login'} className={step.kind === 'login' ? 'active' : 'secondary'} onClick={() => setStep({ kind: 'login' })}>
          ログイン
        </button>
        <button type="button" role="tab" aria-selected={step.kind !== 'login'} className={step.kind !== 'login' ? 'active' : 'secondary'} onClick={() => setStep({ kind: 'request' })}>
          初回登録・パスワード再設定
        </button>
      </div>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {info && step.kind !== 'login' && (
        <p className="status info" role="status">
          {info}
        </p>
      )}

      {step.kind === 'login' && (
        <form onSubmit={submitLogin} aria-label="ログイン" className="account-form">
          <label>
            メールアドレス
            <input type="email" autoComplete="username" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            パスワード
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '確認中…' : 'ログイン'}
          </button>
          <p className="hint">はじめて使う場合やパスワードを忘れた場合は「初回登録・パスワード再設定」へ進んでください。</p>
        </form>
      )}

      {step.kind === 'request' && (
        <form onSubmit={submitRequest} aria-label="確認コードの申請" className="account-form">
          <p className="hint">
            登録済みのメールアドレスを入力すると、連携済みの Discord アカウントへ Bot から DM で短時間だけ有効な確認コードを送ります。DM の宛先は入力では変えられません。パスワードは DM では送りません。
          </p>
          <label>
            メールアドレス
            <input type="email" autoComplete="username" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '送信中…' : '確認コードを申請'}
          </button>
        </form>
      )}

      {step.kind === 'code' && (
        <form onSubmit={(e) => submitCode(e, step.challengeId)} aria-label="確認コードの入力" className="account-form">
          <p className="status info">{step.message}</p>
          <label>
            確認コード（数字）
            <input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={16} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? '確認中…' : 'コードを確認'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void resend(step.challengeId)}>
              コードを再送
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setStep({ kind: 'request' })}>
              最初からやり直す
            </button>
          </div>
          <p className="hint">再送すると前のコードは使えなくなります。コードは一度だけ使えます。</p>
        </form>
      )}

      {step.kind === 'password' && (
        <form onSubmit={submitPassword} aria-label="パスワードの設定" className="account-form">
          <p className="hint">
            自分だけが知るパスワードを設定してください。{minLength}〜{maxLength} 文字（日本語や空白も使えます）。メールアドレスを含めないでください。長すぎる入力は切り詰めずに拒否します。
          </p>
          <label>
            新しいパスワード
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={tooShort || tooLong} required />
          </label>
          {tooShort && <p className="hint">あと {minLength - [...password].length} 文字以上必要です。</p>}
          {tooLong && <p className="hint">{maxLength} 文字を超えています。</p>}
          <label>
            新しいパスワード（確認）
            <input type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} aria-invalid={mismatch} required />
          </label>
          {mismatch && <p className="hint">確認用のパスワードが一致しません。</p>}
          <button type="submit" disabled={busy}>
            {busy ? '設定中…' : 'パスワードを設定してログイン'}
          </button>
        </form>
      )}

      {session.composition === 'mock' && <MockDmOutbox />}
    </main>
  );
}

/** MOCK composition only: the synthetic DM outbox (the server has no such endpoint in production). */
function MockDmOutbox() {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<{ notice: string; messages: MockDm[] }>('GET', '/api/mock/dm-outbox', undefined, signal);
    },
    [refresh],
  );
  const outbox = useLoader(load);
  return (
    <section className="mock-outbox" aria-label="模擬 DM 受信箱" data-testid="mock-dm-outbox">
      <h2>模擬 DM 受信箱（試用専用）</h2>
      <p className="hint">{outbox.data?.notice ?? '模擬 DM です。'}</p>
      <button type="button" className="secondary" onClick={() => setRefresh((n) => n + 1)}>
        更新
      </button>
      <LoadStatus loader={outbox} what="模擬 DM" compact />
      <ul>
        {(outbox.data?.messages ?? []).slice(0, 5).map((m) => (
          <li key={`${m.at}-${m.code}`} data-dm-recipient={m.recipientLabel}>
            {fmtDate(m.at)} {m.recipientLabel} 宛: 登録メール {m.verifiedEmail ?? '—'} ／ 確認コード <strong data-testid="mock-dm-code">{m.code}</strong>（{fmtDate(m.expiresAt)} まで）
          </li>
        ))}
      </ul>
    </section>
  );
}
