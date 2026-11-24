import { useState } from 'react';
import { VaultPanel } from './VaultPanel';

// The パスワード帳 tab (2026-11-23): the book on a page of its own. The page exists only while it is shown, so leaving the
// tab drops every value (VaultPanel). Someone who reaches the address without the tab is told why it is empty.
export function VaultView() {
  const [available, setAvailable] = useState<boolean | null>(null);
  return (
    <main className="main vault-main" aria-label="パスワード帳">
      <VaultPanel active onAvailable={setAvailable} />
      {available === false && (
        <section className="vault-panel">
          <h3>パスワード帳</h3>
          <p className="hint">このサーバーではパスワード帳を使っていないか、あなたが見られるグループがありません。見られるようにするには、グループを管理する人か権限管理者に依頼してください。</p>
        </section>
      )}
    </main>
  );
}
