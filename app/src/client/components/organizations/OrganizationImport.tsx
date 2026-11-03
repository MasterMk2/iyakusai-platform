import { useState } from 'react';
import {
  CsvError,
  decodeCsvBytes,
  guessMapping,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  ORG_KIND_LABELS,
  ORG_KINDS,
  parseCsvRecords,
  type ImportField,
  type ImportMapping,
  type OrgImportResponse,
  type OrgKind,
  type OrgMeta,
} from '../../../shared/organizations';
import { api, toFailure } from '../../api';

// The CSV import (協賛マスターなど): a file from the sheet (Excel's CSV, UTF-8 or Shift_JIS), the columns matched by
// their headers (changeable), then the plan (新規・更新・飛ばす行) shown before anything is written. The row numbers are
// the sheet's own lines. The commit sends back the plan token of the checked plan: a list that changed since is refused.

const THIS_YEAR = new Date().getFullYear();
const ACTION_LABEL = { create: '新規', update: '更新', skip: '飛ばす' } as const;

interface Table {
  fileName: string;
  encoding: string;
  headers: string[];
  rows: string[][];
  /** The sheet line of each row (the header is line 1). */
  lines: number[];
}

export function OrganizationImport({ meta, onDone }: { meta: OrgMeta; onDone: () => void }) {
  const [table, setTable] = useState<Table | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [year, setYear] = useState(THIS_YEAR);
  const [defaultKind, setDefaultKind] = useState<OrgKind>('sponsor');
  const [plan, setPlan] = useState<OrgImportResponse | null>(null);
  const [result, setResult] = useState<OrgImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPlan(null);
    setResult(null);
    setError(null);
  };

  const readFile = async (file: File) => {
    reset();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text, encoding } = decodeCsvBytes(bytes);
      const all = parseCsvRecords(text);
      if (all.length < 2) throw new CsvError('見出しの行のほかに、取り込む行が 1 行以上必要です。');
      if (all.length - 1 > meta.limits.importRows) throw new CsvError(`一度に取り込めるのは ${meta.limits.importRows} 行までです。ファイルを分けてください。`);
      const headers = (all[0]?.cells ?? []).map((h) => h.trim());
      const body = all.slice(1);
      setTable({
        fileName: file.name,
        encoding,
        headers,
        rows: body.map((r) => r.cells.slice(0, 60)),
        lines: body.map((r) => r.line),
      });
      setMapping(guessMapping(headers));
    } catch (err) {
      setTable(null);
      setError(err instanceof CsvError ? err.message : 'CSV を読めませんでした。ファイルの形式を確かめてください。');
    }
  };

  const wire = () => Object.fromEntries(IMPORT_FIELDS.map((f) => [f, mapping[f] ?? null]));

  const send = async (dryRun: boolean) => {
    if (!table || busy) return;
    if (mapping.name === undefined || mapping.name === null) {
      setError('団体名の列を選んでください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = dryRun
        ? { dryRun, fiscalYear: year, defaultKind, mapping: wire(), rows: table.rows, lines: table.lines }
        : { dryRun, fiscalYear: year, defaultKind, mapping: wire(), rows: table.rows, lines: table.lines, planToken: plan?.planToken };
      const answer = await api<OrgImportResponse>('POST', '/api/organizations/import', body);
      if (dryRun) setPlan(answer);
      else setResult(answer);
    } catch (err) {
      // A refused commit means the list changed since the check: the plan is shown again from a new check.
      if (!dryRun) setPlan(null);
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="orgs-form">
        <div className="pane-head">
          <div className="pane-title">
            <h2>取り込みました</h2>
          </div>
        </div>
        <p className="status ok" role="status">
          新規 {result.create} 件・更新 {result.update} 件を書き込みました。飛ばした {result.skip} 件は書き込んでいません。
        </p>
        <div className="actions">
          <button type="button" onClick={onDone}>
            団体の一覧を見る
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="orgs-form">
      <div className="pane-head">
        <div className="pane-title">
          <h2>CSV から取り込む</h2>
          <span className="pane-sub">協賛マスターなど。見出しの名前で列を合わせます</span>
        </div>
      </div>
      <p className="hint">
        Excel で「CSV（コンマ区切り）」として保存したファイルをそのまま選べます（Shift_JIS でも UTF-8 でも読めます）。同じ団体名と年度の行は更新になり、空欄の項目は今の内容を残します。
      </p>

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

      {table && (
        <>
          <p className="status info" role="status">
            {table.fileName}（{table.encoding === 'utf-8' ? 'UTF-8' : 'Shift_JIS'}）· {table.rows.length} 行
          </p>
          <div className="form-grid">
            <label>
              年度
              <select
                value={year}
                onChange={(e) => {
                  setYear(Number(e.target.value));
                  reset();
                }}
              >
                {[THIS_YEAR, THIS_YEAR - 1, THIS_YEAR + 1].map((y) => (
                  <option key={y} value={y}>
                    {y}年度
                  </option>
                ))}
              </select>
            </label>
            <label>
              種別（種別の列がない行に使う）
              <select
                value={defaultKind}
                onChange={(e) => {
                  setDefaultKind(e.target.value as OrgKind);
                  reset();
                }}
              >
                {ORG_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ORG_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>列の対応（どの列をどの項目に使うか）</legend>
            <div className="orgs-mapping">
              {IMPORT_FIELDS.map((field: ImportField) => (
                <label key={field}>
                  {IMPORT_FIELD_LABELS[field]}
                  <select
                    value={mapping[field] === undefined || mapping[field] === null ? '' : String(mapping[field])}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMapping((m) => ({ ...m, [field]: v === '' ? null : Number(v) }));
                      reset();
                    }}
                  >
                    <option value="">使わない</option>
                    {table.headers.map((h, i) => (
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
            <button type="button" className="secondary" disabled={busy} onClick={() => void send(true)} data-testid="org-import-check">
              {busy && !plan ? '下見を作っています…' : '下見を見る（まだ書き込みません）'}
            </button>
          </div>

          {plan && (
            <section aria-labelledby="org-import-plan">
              <h3 id="org-import-plan">下見の結果</h3>
              <p className="status info" role="status">
                新規 {plan.create} 件 · 更新 {plan.update} 件 · 飛ばす {plan.skip} 件
              </p>
              <div className="orgs-plan-wrap">
                <table className="orgs-plan">
                  <thead>
                    <tr>
                      <th scope="col">行</th>
                      <th scope="col">結果</th>
                      <th scope="col">団体名</th>
                      <th scope="col">内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.rows.map((r) => (
                      <tr key={r.line}>
                        <td>{r.line}</td>
                        <td>{ACTION_LABEL[r.action]}</td>
                        <td>{r.name || '（名前なし）'}</td>
                        <td>{r.message || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || plan.create + plan.update === 0}
                  onClick={() => void send(false)}
                  data-testid="org-import-commit"
                >
                  {busy ? '取り込んでいます…' : `この内容で取り込む（新規 ${plan.create}・更新 ${plan.update}）`}
                </button>
                <button type="button" className="secondary" onClick={() => setPlan(null)} disabled={busy}>
                  列の対応を直す
                </button>
              </div>
              {plan.create + plan.update === 0 && <p className="hint">新規も更新もないため、取り込むものがありません。列の対応や行を確かめてください。</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
