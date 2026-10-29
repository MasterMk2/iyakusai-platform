import { useCallback, useState } from 'react';
import type { Persona } from '../../shared/api';
import { api, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const loadPersonas = useCallback((signal: AbortSignal) => api<Persona[]>('GET', '/api/personas', undefined, signal), []);
  const personas = useLoader(loadPersonas);
  const [error, setError] = useState<string | null>(null);

  async function choose(id: string) {
    setError(null);
    try {
      await api('POST', '/api/session', { userId: id });
      onLoggedIn();
    } catch (err) {
      setError(toFailure(err).message);
    }
  }

  return (
    <main className="login">
      <h1>共有メール管理（テスト版）</h1>
      <p>
        このアプリは<strong>合成データだけ</strong>で動くローカルのテスト版です。実際のメールアカウントには接続せず、送信・自動返信・
        接続元での移動・削除・既読化も行いません。
      </p>
      <h2>デモ用ペルソナを選択（モック認証）</h2>
      <p className="hint">パスワードは不要です。本番の認証ではありません。ペルソナごとに閲覧・編集できる受信箱が異なります。</p>
      <LoadStatus loader={personas} what="ペルソナ一覧" />
      {error && <p className="status error" role="alert">{error}</p>}
      <ul className="persona-list">
        {(personas.data ?? []).map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => void choose(p.id)} data-persona={p.id}>
              <span className="persona-name">{p.displayName}</span>
              <span className="persona-role">{p.roleLabel}</span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
