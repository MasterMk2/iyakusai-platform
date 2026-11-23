import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { fmtDate } from '../../api';
import type { VaultPrintResponse } from '../../../shared/vault';

// The paper copy of one section. It is laid out in the page itself (no new window, no PDF on the server), shown only
// to the printer (vault.css hides it on screen and hides the app while printing), and removed as soon as the print
// dialog closes, or after a minute if the browser never says it did.

const BODY_CLASS = 'vault-printing';

/** `onDone` must be stable (useCallback): the print dialog opens once per sheet. */
export function VaultPrintSheet({ data, onDone }: { data: VaultPrintResponse; onDone: () => void }) {
  useEffect(() => {
    document.body.classList.add(BODY_CLASS);
    const done = () => onDone();
    window.addEventListener('afterprint', done);
    const fallback = window.setTimeout(done, 60_000);
    // After this render reaches the page.
    const start = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(fallback);
      window.removeEventListener('afterprint', done);
      document.body.classList.remove(BODY_CLASS);
    };
  }, [data, onDone]);

  return createPortal(
    <div className="vault-print-sheet" data-testid="vault-print-sheet">
      <h1>
        パスワード帳の控え：{data.section.name}
      </h1>
      <p>
        版 <strong>{data.edition}</strong>・印刷 {fmtDate(data.printedAt)}・印刷した人 {data.printedByName}・{data.entries.length} 件
      </p>
      <div className="vault-print-envelope">
        <p>
          <strong>封筒の表に書くこと：</strong>区分「{data.section.name}」・版 {data.edition}・印刷日 {fmtDate(data.printedAt).slice(0, 10)}・封をした人の署名
        </p>
        <p>封に日付と署名を書いて、決めてある金庫へ。開けたら、開けた人・日時・理由を記録して封をし直す。</p>
        <p>これより新しい版の紙を入れたら、この紙は細断する。</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>名前</th>
            <th>URL</th>
            <th>ID</th>
            <th>パスワード</th>
            <th>メモ</th>
            <th>更新</th>
          </tr>
        </thead>
        <tbody>
          {data.entries.map((e, i) => (
            <tr key={i}>
              <td>{e.name}</td>
              <td className="vault-print-url">{e.url}</td>
              <td>
                <code>{e.username}</code>
              </td>
              <td>
                <code>{e.password}</code>
              </td>
              <td className="vault-print-notes">{e.notes}</td>
              <td>{fmtDate(e.updatedAt).slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}
