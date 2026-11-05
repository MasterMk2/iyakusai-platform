import { useEffect, useState } from 'react';
import { storeBankReturnResult, type BankReturnResult } from './return-flow';

const SETTINGS = '/#/settings';

/**
 * The screen the bank sends the browser back to. The code was already posted by main.tsx; this shows that it is
 * being finished, then goes to the settings, whose bank panel shows the outcome. When the browser keeps no session
 * storage the outcome stays here with a link instead.
 */
export function BankReturn({ completion }: { completion: Promise<BankReturnResult> }) {
  const [result, setResult] = useState<BankReturnResult | null>(null);
  useEffect(() => {
    let live = true;
    void completion.then((r) => {
      if (!live) return;
      if (storeBankReturnResult(r)) window.location.replace(SETTINGS);
      else setResult(r);
    });
    return () => {
      live = false;
    };
  }, [completion]);
  return (
    <main className="main settings">
      <h2>銀行の連携</h2>
      {result ? (
        <>
          <p className={`status ${result.error ? 'error' : 'ok'}`} role={result.error ? 'alert' : 'status'}>
            {result.text}
          </p>
          <p>
            <a href={SETTINGS}>設定に戻る</a>
          </p>
        </>
      ) : (
        <p className="status loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          銀行との接続を仕上げています…
        </p>
      )}
    </main>
  );
}
