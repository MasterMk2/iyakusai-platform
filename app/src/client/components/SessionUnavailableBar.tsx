/**
 * Neutral header while the authentication mode is not confirmed (session loading or failed).
 * It claims neither mock nor proxy authentication and offers no operations.
 */
export function SessionUnavailableBar() {
  return (
    <header className="demo-bar">
      <div className="demo-banner" role="note" data-testid="session-unavailable-banner">
        <strong>テスト版（合成データのみ）</strong>：ログイン状態を確認できていません。確認できるまで操作は表示しません。表示されるメール・人物・アドレスはすべて合成データで、実際のメールには接続しておらず送信もできません。
      </div>
    </header>
  );
}
