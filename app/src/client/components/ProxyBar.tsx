import type { SessionUser } from '../../shared/api';

/**
 * Header for trusted-proxy mode: shows the proxy-authenticated application user.
 * No persona switch, sample reset or fault simulation exists in this mode (the server enforces it too).
 */
export function ProxyBar({ user }: { user: SessionUser | null }) {
  return (
    <header className="demo-bar">
      <div className="demo-banner" role="note" data-testid="proxy-auth-banner">
        <strong>テスト版（合成データのみ）</strong>：利用者はリバースプロキシの認証で識別しています。表示されるメール・人物・アドレスはすべて合成データで、実際のメールには接続しておらず送信もできません。
      </div>
      {user && (
        <div className="demo-controls">
          <span className="current-user" data-testid="current-user">
            認証済みの利用者: <strong>{user.displayName}</strong>（{user.roleLabel}）
          </span>
        </div>
      )}
    </header>
  );
}
