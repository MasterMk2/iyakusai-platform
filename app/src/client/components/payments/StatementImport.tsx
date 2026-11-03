import { useState } from 'react';
import { CsvError, decodeCsvBytes, parseCsvRecords } from '../../../shared/organizations';
import {
  guessHeaderRow,
  guessStatementMapping,
  PAYMENT_LIMITS,
  STATEMENT_FIELD_LABELS,
  STATEMENT_FIELDS,
  yen,
  type StatementField,
  type StatementImportResponse,
  type StatementMapping,
  type StatementPlanRow,
} from '../../../shared/payments';
import { api } from '../../api';
import { failureOf } from './common';

// 明細を取り込む: the bank's 入出金明細 as CSV (Shift_JIS or UTF-8, as the bank gives it). The header row and the
// columns are guessed and can be changed; only the chosen columns are sent. The 下見 sorts every row into a new
// deposit, one imported before (the same day, description, amount and balance), a withdrawal (not kept) and a row that
// cannot be read, and nothing is written until 取り込む — with the plan token of that 下見.

const ACTION_LABEL: Record<StatementPlanRow['action'], string> = { new: '新しい入金', duplicate: '取り込み済み', withdrawal: '出金（取り込まない）', unreadable: '読めない行' };
const REQUIRED: StatementField[] = ['date', 'description', 'deposit'];

interface Sheet {
  fileName: string;
  encoding: 'utf-8' | 'shift_jis';
  records: { line: number; cells: string[] }[];
}

export function StatementImport({ onDone, onCancel }: { onDone: (added: number) => void; onCancel: () => void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<StatementMapping>({});
  const [plan, setPlan] = useState<StatementImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readFile = async (file: File) => {
    setPlan(null);
    setError(null);
    try {
      const { text, encoding } = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
      const records = parseCsvRecords(text).map((r) => ({ line: r.line, cells: r.cells.slice(0, 40) }));
      if (records.length < 2) throw new CsvError('見出しの行のほかに、取り込む行が 1 行以上必要です。');
      const head = guessHeaderRow(records.map((r) => r.cells));
      setSheet({ fileName: file.name, encoding, records });
      setHeaderRow(head);
      setMapping(guessStatementMapping(records[head]?.cells ?? []));
    } catch (err) {
      setSheet(null);
      setError(err instanceof CsvError ? err.message : 'CSV を読めませんでした。銀行の画面から「CSV」で保存したファイルか確かめてください。');
    }
  };

  const headers = sheet?.records[headerRow]?.cells ?? [];
  const body = sheet ? sheet.records.slice(headerRow + 1) : [];
  const missing = REQUIRED.filter((f) => mapping[f] === undefined || mapping[f] === null);
  const cell = (cells: string[], field: StatementField) => {
    const i = mapping[field];
    return i === undefined || i === null ? '' : (cells[i] ?? '').slice(0, PAYMENT_LIMITS.statementCell * 2);
  };
  // Only the chosen columns leave the browser; rows with nothing in them (the bank's blank lines) are left out.
  const rows = body
    .map((r) => ({ line: r.line, date: cell(r.cells, 'date'), description: cell(r.cells, 'description'), deposit: cell(r.cells, 'deposit'), withdrawal: cell(r.cells, 'withdrawal'), balance: cell(r.cells, 'balance') }))
    .filter((r) => `${r.date}${r.description}${r.deposit}${r.withdrawal}${r.balance}`.trim() !== '');
  const tooMany = rows.length > PAYMENT_LIMITS.statementRows;

  const send = async (dryRun: boolean) => {
    if (!sheet || busy) return;
    if (missing.length > 0) {
      setError(`${missing.map((f) => STATEMENT_FIELD_LABELS[f].replace(/（.*$/, '')).join('・')}の列を選んでください。`);
      return;
    }
    if (rows.length === 0 || tooMany) {
      setError(tooMany ? `一度に取り込めるのは ${PAYMENT_LIMITS.statementRows} 行までです。期間を分けて保存してください。` : '取り込む行がありません。見出しの行を確かめてください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await api<StatementImportResponse>('POST', '/api/payments/statements/import', { dryRun, label: sheet.fileName, rows, ...(dryRun ? {} : { planToken: plan?.planToken }) });
      if (dryRun) setPlan(answer);
      else onDone(answer.counts.new);
    } catch (err) {
      const f = failureOf(err);
      // A refused commit: someone imported since the 下見. The 下見 is made again.
      if (!dryRun) setPlan(null);
      setError(f.message);
    } finally {
      setBusy(false);
    }
  };

  const changeMapping = (field: StatementField, value: string) => {
    setMapping((m) => ({ ...m, [field]: value === '' ? null : Number(value) }));
    setPlan(null);
  };

  const listed = plan ? plan.rows.filter((r) => r.action === 'new' || r.action === 'unreadable') : [];
  const folded = plan ? plan.rows.filter((r) => r.action === 'duplicate' || r.action === 'withdrawal') : [];

  return (
    <div className="pay-form" data-testid="accounting-statement-import">
      <h2>入出金明細を取り込む</h2>
      <p className="hint">ネットバンキングの入出金明細を CSV で保存し、そのまま選んでください（Shift_JIS でも UTF-8 でも読めます）。入金の行だけを取り込みます。明細は会計の権限がある人だけが見られます。</p>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <label>
        CSV ファイル
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f);
          }}
        />
      </label>

      {sheet && (
        <>
          <p className="status info" role="status">
            {sheet.fileName}（{sheet.encoding === 'utf-8' ? 'UTF-8' : 'Shift_JIS'}）· 見出しのあと {rows.length} 行
          </p>
          <label>
            見出しの行（銀行によっては上に口座の情報の行があります）
            <select
              value={headerRow}
              onChange={(e) => {
                const next = Number(e.target.value);
                setHeaderRow(next);
                setMapping(guessStatementMapping(sheet.records[next]?.cells ?? []));
                setPlan(null);
              }}
            >
              {sheet.records.slice(0, 10).map((r, i) => (
                <option key={r.line} value={i}>
                  {r.line} 行目: {r.cells.filter(Boolean).slice(0, 4).join('・').slice(0, 40) || '（空）'}
                </option>
              ))}
            </select>
          </label>
          <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>列の対応（どの列をどの項目に使うか）</legend>
            <div className="orgs-mapping">
              {STATEMENT_FIELDS.map((field) => (
                <label key={field}>
                  {STATEMENT_FIELD_LABELS[field]}
                  <select value={mapping[field] === undefined || mapping[field] === null ? '' : String(mapping[field])} onChange={(e) => changeMapping(field, e.target.value)}>
                    <option value="">使わない</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {i + 1}列目: {h || '（見出しなし）'}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void send(true)} data-testid="accounting-import-check">
              {busy && !plan ? '下見を作っています…' : '下見を見る（まだ取り込みません）'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
              やめる
            </button>
          </div>
        </>
      )}

      {plan && (
        <section className="pay-section" aria-labelledby="pay-plan-title">
          <h3 id="pay-plan-title">下見の結果</h3>
          <p className="status info" role="status">
            新しい入金 {plan.counts.new} 件 · 取り込み済み {plan.counts.duplicate} 件 · 出金 {plan.counts.withdrawal} 件 · 読めない行 {plan.counts.unreadable} 件
          </p>
          {listed.length > 0 && (
            <ul className="pay-plan" aria-label="新しい入金と読めない行">
              {listed.map((r) => (
                <li key={r.line}>
                  <span className="pay-plan-head">
                    <span>{r.line} 行目</span>
                    <span className={`pay-badge ${r.action === 'unreadable' ? 'short' : ''}`}>{ACTION_LABEL[r.action]}</span>
                    {r.bookedOn && <span>{r.bookedOn}</span>}
                    {r.amountYen !== null && <span className="pay-amount">{yen(r.amountYen)}</span>}
                  </span>
                  {r.description && <span className="pay-desc">{r.description}</span>}
                  {r.reason && <span className="hint">{r.reason}</span>}
                </li>
              ))}
            </ul>
          )}
          {folded.length > 0 && (
            <details>
              <summary>取り込み済み・出金の行（{folded.length} 件）</summary>
              <ul className="pay-plan">
                {folded.map((r) => (
                  <li key={r.line}>
                    <span className="pay-plan-head">
                      <span>{r.line} 行目</span>
                      <span className="pay-badge">{ACTION_LABEL[r.action]}</span>
                      {r.bookedOn && <span>{r.bookedOn}</span>}
                      {r.amountYen !== null && <span className="pay-amount">{yen(r.amountYen)}</span>}
                    </span>
                    {r.description && <span className="pay-desc">{r.description}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="actions">
            <button type="button" disabled={busy || plan.counts.new === 0} onClick={() => void send(false)} data-testid="accounting-import-commit">
              {busy ? '取り込んでいます…' : `新しい入金 ${plan.counts.new} 件を取り込む`}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setPlan(null)}>
              列の対応を直す
            </button>
          </div>
          {plan.counts.new === 0 && <p className="hint">新しい入金がないため、取り込むものがありません。</p>}
        </section>
      )}
    </div>
  );
}
