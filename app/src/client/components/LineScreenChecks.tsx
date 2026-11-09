import type { ScreenFinding } from '../../shared/mailScreen';

/** The checks before sending an official LINE message, shown like the mail ones (2026-11-09). */
export function LineScreenChecks({ findings }: { findings: ScreenFinding[] }) {
  const warnings = findings.filter((f) => f.level === 'warning').length;
  return (
    <section className="compose-screen" aria-label="送信前のチェック" data-testid="line-screen">
      <h5>送信前のチェック</h5>
      {findings.length === 0 ? (
        <p className="status ok">書きかけ・日付と曜日・画像・宛名で、気になる点は見つかりませんでした。</p>
      ) : (
        <ul>
          {findings.map((f) => (
            <li key={f.text} className={`screen-${f.level}`}>
              <strong>{f.level === 'warning' ? '注意' : '参考'}</strong> {f.text}
            </li>
          ))}
        </ul>
      )}
      {warnings > 0 && <p className="hint">直すときは「編集に戻る」。このままで良ければ、確かめたうえで送れます。</p>}
    </section>
  );
}
