import { useCallback, useState } from 'react';
import { ACCOUNT_KIND_LABELS, yen, type YayoiExportPlan, type YayoiImportResponse } from '../../../shared/books';
import { api, apiForm, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { failureOf, YearSelect } from './common';

// 弥生 (2026-11-05), for the time both books run side by side: the entries made here go to 弥生 as its import file
// (書き出す — each entry once; one changed after it was sent is listed to be fixed in 弥生 by hand), and what was
// entered only in 弥生 comes back (取り込む — a look first, then the import; entries already here are skipped).

interface Imports {
  imports: { id: string; at: string; actorName: string; label: string; kind: 'journals' | 'openings'; added: number; changed: number }[];
}

export function YayoiSection({ year, onYear, onChanged }: { year: number; onYear: (year: number) => void; onChanged: () => void }) {
  const [to, setTo] = useState('');
  const [refresh, setRefresh] = useState(0);
  const loadPlan = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      const p = new URLSearchParams({ fiscalYear: String(year) });
      if (to) p.set('to', to);
      return api<YayoiExportPlan>('GET', `/api/books/yayoi/plan?${p.toString()}`, undefined, signal);
    },
    [year, to, refresh],
  );
  const plan = useLoader(loadPlan);
  const loadImports = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<Imports>('GET', '/api/books/yayoi/imports', undefined, signal);
    },
    [refresh],
  );
  const imports = useLoader(loadImports);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<{ id: string; count: number } | null>(null);
  const reload = () => {
    setRefresh((n) => n + 1);
    onChanged();
  };

  const p = plan.data;
  const exportNow = async () => {
    if (busy || !p) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ exportId: string; count: number }>('POST', '/api/books/yayoi/export', { fiscalYear: year, to: to || null, expectedCount: p.count });
      setExported({ id: res.exportId, count: res.count });
      reload();
    } catch (err) {
      const f = failureOf(err);
      setError(f.message);
      if (f.conflict) setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  const fixed = async (id: string) => {
    setError(null);
    try {
      await api('POST', `/api/books/journals/${encodeURIComponent(id)}/yayoi-fixed`, {});
      reload();
    } catch (err) {
      setError(failureOf(err).message);
    }
  };

  return (
    <div className="pay-view" data-testid="books-yayoi">
      <div className="pay-head">
        <div className="pane-title">
          <h2>弥生</h2>
          <span className="pane-sub">移行期間のあいだ、弥生会計と帳簿をそろえる</span>
        </div>
        <div className="actions">
          <YearSelect
            year={year}
            onChange={(y) => {
              onYear(y);
              setExported(null);
            }}
          />
        </div>
      </div>
      <section className="books-report" aria-labelledby="yayoi-out">
        <h3 id="yayoi-out">弥生へ書き出す</h3>
        <p className="hint">ここで記帳した仕訳を、弥生会計の「弥生インポート形式」のファイルにします。弥生会計で仕訳のインポートから読み込んでください。一度書き出した仕訳は、次から出ません。</p>
        <label className="books-inline-field">
          この日までの仕訳
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          {to && (
            <button type="button" className="link-button pay-link" onClick={() => setTo('')}>
              日付で区切らない
            </button>
          )}
        </label>
        <LoadStatus loader={plan} what="書き出す仕訳" />
        {p && (
          <>
            {exported && (
              <p className="status ok" role="status">
                {exported.count} 件の仕訳を書き出しました。
                <a className="button" href={`/api/books/yayoi/exports/${encodeURIComponent(exported.id)}`} download data-testid="yayoi-download">
                  ファイルを保存する
                </a>
              </p>
            )}
            {p.unencodable.length > 0 && (
              <div className="status error" role="alert">
                弥生が読めない文字があります。仕訳を直してから書き出してください。
                <ul>
                  {p.unencodable.map((u, i) => (
                    <li key={i}>
                      {u.number} の{u.field}「{u.chars}」
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="books-export">
              <p>
                {year}年度で、まだ書き出していない仕訳 <strong>{p.count} 件</strong>
                {p.count > 0 && `（弥生の ${p.rows} 行）`}
              </p>
              <div className="actions">
                <button type="button" disabled={busy || p.count === 0 || p.unencodable.length > 0} onClick={() => void exportNow()} data-testid="yayoi-export">
                  {busy ? '書き出しています…' : p.count === 0 ? '書き出す仕訳はありません' : `${p.count} 件を書き出す`}
                </button>
              </div>
            </div>
            {error && (
              <p className="status error" role="alert">
                {error}
              </p>
            )}
            {p.changed.length > 0 && (
              <div className="books-changed" data-testid="yayoi-changed">
                <h4>弥生で手で直す仕訳（{p.changed.length} 件）</h4>
                <p className="hint">書き出したあとで直したか取り消した仕訳です。二重にならないよう、もう一度は書き出しません。弥生の同じ仕訳（摘要に番号があります）を直したら「弥生で直した」を押してください。</p>
                <ul className="pay-plan">
                  {p.changed.map((c) => (
                    <li key={c.id}>
                      <span className="pay-plan-head">
                        <span>
                          {c.number} · {c.date} · {yen(c.amountYen)}
                        </span>
                        <button type="button" className="secondary" onClick={() => void fixed(c.id)}>
                          弥生で直した
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {p.batches.length > 0 && (
              <details className="books-more">
                <summary>これまでの書き出し（{p.batches.length} 回）</summary>
                <ul className="pay-plan">
                  {p.batches.map((b) => (
                    <li key={b.id}>
                      <span className="pay-plan-head">
                        <span>
                          {fmtDate(b.at)} · {b.actorName} · {b.count} 件{b.from ? `（${b.from}〜${b.to}）` : ''}
                        </span>
                        <a className="link-button pay-link" href={`/api/books/yayoi/exports/${encodeURIComponent(b.id)}`} download>
                          もう一度保存
                        </a>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
      <section className="books-report" aria-labelledby="yayoi-in">
        <h3 id="yayoi-in">弥生から取り込む</h3>
        <p className="hint">弥生会計だけで記帳した仕訳を、帳簿にも入れます。弥生会計から「弥生インポート形式」で書き出したファイルを選んでください。もう帳簿にある仕訳（ここから書き出した仕訳を含む）は入りません。</p>
        <ImportForm
          onImported={() => {
            reload();
          }}
        />
        {imports.data && imports.data.imports.length > 0 && (
          <details className="books-more">
            <summary>これまでの取り込み（{imports.data.imports.length} 回）</summary>
            <ul className="pay-plan">
              {imports.data.imports.map((i) => (
                <li key={i.id}>
                  {fmtDate(i.at)} · {i.actorName} · {i.kind === 'journals' ? '仕訳' : '期首残高'} · {i.label || '（ファイル名なし）'} · {i.kind === 'journals' ? `${i.added} 件を追加${i.changed > 0 ? `・${i.changed} 件を弥生に合わせて変更` : ''}` : `${i.added} 科目`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

function ImportForm({ onImported }: { onImported: () => void }) {
  const [kind, setKind] = useState<'journals' | 'openings'>('journals');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<YayoiImportResponse | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const choose = (next: { kind?: 'journals' | 'openings'; file?: File | null }) => {
    if (next.kind !== undefined) setKind(next.kind);
    if (next.file !== undefined) setFile(next.file);
    setPreview(null);
    setError(null);
  };

  const send = async (dryRun: boolean) => {
    if (busy || !file) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const q = new URLSearchParams({ kind, dryRun: dryRun ? '1' : '0' });
      if (!dryRun && preview) q.set('planToken', preview.planToken);
      const res = await apiForm<YayoiImportResponse>(`/api/books/yayoi/import?${q.toString()}`, form);
      if (dryRun) {
        setPreview(res);
      } else {
        setDone(kind === 'journals' ? `${res.counts.new} 件の仕訳を取り込みました。` : '期首残高を取り込みました。');
        setPreview(null);
        setFile(null);
        setInputKey((n) => n + 1);
        onImported();
      }
    } catch (err) {
      const f = failureOf(err);
      setError(f.message);
      if (f.conflict) setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const unknownKinds = preview?.newAccounts.filter((a) => a.kind === null) ?? [];
  const problems = preview?.rows.filter((r) => r.action === 'unreadable') ?? [];
  const changes = preview?.rows.filter((r) => r.action === 'new' && r.reason) ?? [];
  const canImport = preview !== null && unknownKinds.length === 0 && (kind === 'openings' ? preview.counts.new > 0 : preview.counts.new + preview.counts.ours > 0);

  return (
    <div className="pay-form books-import" data-testid="yayoi-import">
      <fieldset className="books-forms">
        <legend>取り込むもの</legend>
        <label className="books-form-choice">
          <input type="radio" name="yayoi-kind" checked={kind === 'journals'} onChange={() => choose({ kind: 'journals' })} />
          <span>
            <strong>仕訳</strong>
            <span className="hint">弥生の仕訳日記帳を書き出したファイル</span>
          </span>
        </label>
        <label className="books-form-choice">
          <input type="radio" name="yayoi-kind" checked={kind === 'openings'} onChange={() => choose({ kind: 'openings' })} />
          <span>
            <strong>期首残高</strong>
            <span className="hint">年度の始めの残高（入れ直すと置き換わります）</span>
          </span>
        </label>
      </fieldset>
      <label>
        ファイル（CSV・5 MB まで）
        <input key={inputKey} type="file" accept=".csv,.txt,text/csv" onChange={(e) => choose({ file: e.target.files?.[0] ?? null })} data-testid="yayoi-file" />
      </label>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="status ok" role="status">
          {done}
        </p>
      )}
      {!preview ? (
        <div className="actions">
          <button type="button" disabled={busy || !file} onClick={() => void send(true)} data-testid="yayoi-preview">
            {busy ? '読んでいます…' : file ? '下見を見る' : 'ファイルを選んでください'}
          </button>
        </div>
      ) : (
        <div className="books-preview" data-testid="yayoi-preview-result">
          <h4>下見</h4>
          <ul className="books-counts">
            {kind === 'journals' ? (
              <>
                <li>
                  取り込む仕訳 <strong>{preview.counts.new} 件</strong>
                </li>
                <li>もう帳簿にある仕訳 {preview.counts.duplicate} 件（入れません）</li>
                <li>ここから書き出した仕訳 {preview.counts.ours} 件（弥生の伝票番号だけ控えます）</li>
              </>
            ) : (
              <li>
                期首残高の行 <strong>{preview.counts.new} 行</strong>
              </li>
            )}
            {problems.length > 0 && <li className="books-over">読めない行 {problems.length} 行（入れません）</li>}
            <li className="hint">文字コード: {preview.encoding === 'shift_jis' ? 'Shift_JIS（弥生の標準）' : 'UTF-8'}</li>
          </ul>
          {changes.length > 0 && (
            <details className="books-more">
              <summary>弥生で変わった仕訳（{changes.length} 件）</summary>
              <ul className="pay-plan">
                {changes.map((r) => (
                  <li key={r.line}>
                    {r.line} 行目 · {r.date} · {r.amountYen === null ? '' : yen(r.amountYen)} · {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {problems.length > 0 && (
            <details className="books-more" open>
              <summary>読めない行</summary>
              <ul className="pay-plan">
                {problems.map((r) => (
                  <li key={r.line}>
                    {r.line} 行目: {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.newAccounts.length > 0 && (
            <div className={unknownKinds.length > 0 ? 'status error' : 'status warning'} role="note">
              帳簿にまだない科目を足します: {preview.newAccounts.map((a) => `${a.name}${a.sub ? `（${a.sub}）` : ''}${a.kind ? `〈${ACCOUNT_KIND_LABELS[a.kind]}〉` : '〈種類が分からない〉'}`).join('、')}
              {unknownKinds.length > 0 && <p>種類が分からない科目は、先に「科目と設定」で同じ名前の科目を種類を選んで足してください。</p>}
            </div>
          )}
          <div className="actions">
            <button type="button" disabled={busy || !canImport} onClick={() => void send(false)} data-testid="yayoi-import-run">
              {busy ? '取り込んでいます…' : kind === 'openings' ? '期首残高を取り込む' : preview.counts.new === 0 ? '弥生の伝票番号を控える' : `${preview.counts.new} 件を取り込む`}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
