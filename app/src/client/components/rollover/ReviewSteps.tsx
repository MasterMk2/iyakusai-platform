import { useCallback, useMemo, useState } from 'react';
import { HOLDER_STATUS_LABELS, type GrantApplyResponse, type GrantHolderView, type GrantPreviewResponse } from '../../../shared/rollover';
import { toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { download, errorCode, requestId, rolloverApi } from './rolloverApi';

// Steps 3 to 5: reading what the next officers take over. The tasks and the handover draft are read only (the files
// are made on request); the grants can be removed, each through the change of its own feature.

function DownloadButton({ label, run, primary = false }: { label: string; run: () => Promise<void>; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const click = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await run();
      setDone(true);
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="rollover-download">
      <button type="button" className={primary ? undefined : 'secondary'} onClick={() => void click()} disabled={busy}>
        {busy ? '書き出し中…' : label}
      </button>
      {done && <span className="hint">書き出しました。ダウンロードしたファイルを確かめてください。</span>}
      {error && (
        <span className="status error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

export function TasksStep({ sourceYear, onChanged }: { sourceYear: number; onChanged: () => void }) {
  const tasks = useLoader(useCallback((signal: AbortSignal) => rolloverApi.tasks(signal), []));
  const data = tasks.data;
  return (
    <div className="rollover-step-inner">
      <LoadStatus loader={tasks} what="未完了のタスク" compact />
      {data && data.state !== 'ok' && (
        <p className="status info" role="status">
          {data.message}
        </p>
      )}
      {data && data.state === 'ok' && (
        <>
          <p className="hint">
            あなたが見られるタスクのうち、完了していないものを部局ごとに並べています（部局が二つあるタスクは両方に出ます）。持ち越すかどうかは、CSV の「持ち越す」の列に書き込んで決めてください。この画面からタスクは変えません。
          </p>
          <p className="rollover-counts">
            未完了 <strong>{data.total}</strong> 件・{data.groups.length} 部局
          </p>
          {data.groups.length === 0 ? (
            <p className="empty">未完了のタスクはありません。</p>
          ) : (
            <ul className="rollover-groups">
              {data.groups.map((g) => {
                const overdue = g.tasks.filter((t) => t.overdue).length;
                return (
                  <li key={g.key}>
                    <details>
                      <summary>
                        {g.label}：{g.tasks.length} 件{overdue > 0 ? `（うち期限超過 ${overdue} 件）` : ''}
                      </summary>
                      <ul className="rollover-items">
                        {g.tasks.map((t) => (
                          <li key={t.id} className="rollover-item">
                            <span className="rollover-item-name">
                              {t.number} {t.title}
                            </span>
                            <span className="rollover-item-meta">
                              {t.status}
                              {t.assignee ? `・担当 ${t.assignee}` : '・担当なし'}
                              {t.deadline ? `・期限 ${t.deadline.slice(0, 10)}` : ''}
                              {t.overdue ? '・期限超過' : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="admin-actions">
            <DownloadButton
              primary
              label="CSV を書き出す"
              run={async () => {
                await download('/api/rollover/tasks/export', { sourceYear }, `未完了のタスク_${sourceYear}年度.csv`);
                onChanged();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function holderNote(h: GrantHolderView): string | null {
  if (h.kind === 'department') return h.members === 0 ? '今この部局の委員がいません（部局ごとの権限だけが残っています）' : `部局（今の委員 ${h.members ?? 0} 人）`;
  return h.status === 'active' ? null : HOLDER_STATUS_LABELS[h.status];
}

export function GrantsStep({ sourceYear, onChanged }: { sourceYear: number; onChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void reload;
      return rolloverApi.grants(signal);
    },
    [reload],
  );
  const grants = useLoader(load);
  const [attentionOnly, setAttentionOnly] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<GrantPreviewResponse | null>(null);
  const [token, setToken] = useState(requestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);
  const [result, setResult] = useState<GrantApplyResponse | null>(null);

  const data = grants.data;
  const onlyAttention = attentionOnly && (data?.counts.attention ?? 0) > 0;
  const holders = useMemo(() => (data ? data.holders.filter((h) => !onlyAttention || h.attention) : []), [data, onlyAttention]);

  const toggle = (key: string) => {
    setSelected((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
    setPreview(null);
    setError(null);
  };

  /** Every removable grant of one holder at once: chosen when some are not, cleared when all are. */
  const toggleAll = (keys: string[]) => {
    setSelected((list) => (keys.every((k) => list.includes(k)) ? list.filter((k) => !keys.includes(k)) : [...new Set([...list, ...keys])]));
    setPreview(null);
    setError(null);
  };

  const makePreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await rolloverApi.grantPreview({ sourceYear, keys: selected }));
      setToken(requestId());
    } catch (err) {
      setError({ text: toFailure(err).message, stale: false });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await rolloverApi.grantApply({ sourceYear, keys: selected, planToken: preview.planToken, requestId: token }));
      setSelected([]);
      setPreview(null);
      setReload((n) => n + 1);
      onChanged();
    } catch (err) {
      setError({ text: toFailure(err).message, stale: errorCode(err) === 'plan_changed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rollover-step-inner">
      <LoadStatus loader={grants} what="権限の一覧" compact />
      {data && (
        <>
          <p className="hint">
            このアプリが持つ権限（{data.sources.join('・')}）を、持っている人・部局ごとに並べています。保存されたアカウントの状態から、Discord のサーバーを抜けた人・しばらく在籍を確かめていない人・委員の名簿にない人・委員がいない部局を先に出します。外した権限は、それぞれの権限の画面で付け直せます。
          </p>
          {data.notes.length > 0 && (
            <ul className="rollover-notes">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <p className="rollover-counts">
            {data.counts.holders} 人・部局、権限 {data.counts.grants} 件・確かめる人と部局 <strong>{data.counts.attention}</strong>
          </p>
          {data.counts.attention > 0 && (
            <label className="rollover-filter">
              <input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />
              確かめる人と部局だけを表示する
            </label>
          )}
          {data.counts.attention === 0 && <p className="status ok">抜けた人・しばらく在籍を確かめていない人・名簿にない人の権限はありません。</p>}
          {holders.length === 0 ? (
            <p className="empty">権限を持っている人はいません。</p>
          ) : (
            <ul className="rollover-holders">
              {holders.map((h) => {
                const note = holderNote(h);
                const removable = h.grants.filter((g) => g.removable).map((g) => g.key);
                const allChosen = removable.length > 0 && removable.every((k) => selected.includes(k));
                const who = h.kind === 'department' ? 'この部局' : 'この人';
                return (
                  <li key={`${h.kind}-${h.id}`} className={`rollover-holder ${h.attention ? 'is-attention' : ''}`}>
                    <div className="rollover-holder-head">
                      <span className="rollover-item-name">{h.name}</span>
                      {h.roleLabel && h.kind === 'person' && <span className="rollover-item-meta">{h.roleLabel}</span>}
                    </div>
                    {note && <p className={h.attention ? 'rollover-attention' : 'hint'}>{h.attention ? `確かめる：${note}` : note}</p>}
                    {h.detail && <p className="hint rollover-holder-detail">{h.detail}</p>}
                    {h.attention && removable.length >= 2 && (
                      <div className="admin-actions">
                        <button type="button" className="secondary" onClick={() => toggleAll(removable)} disabled={busy}>
                          {allChosen ? `${who}の選択をすべて外す` : `${who}の権限をすべて選ぶ（${removable.length} 件）`}
                        </button>
                      </div>
                    )}
                    <ul className="rollover-grants">
                      {h.grants.map((g) => (
                        <li key={g.key}>
                          {g.removable ? (
                            <label className="rollover-item-check">
                              <input type="checkbox" checked={selected.includes(g.key)} onChange={() => toggle(g.key)} disabled={busy} />
                              <span>
                                {g.sourceLabel}：{g.target}・{g.permission}
                              </span>
                            </label>
                          ) : (
                            <span>
                              {g.sourceLabel}：{g.target}・{g.permission}
                              <span className="rollover-item-reason">{g.reason}</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="admin-actions">
            <button type="button" className={preview ? 'secondary' : undefined} onClick={() => void makePreview()} disabled={busy || selected.length === 0}>
              {preview ? '下見を作り直す' : `選んだ ${selected.length} 件の下見を作る`}
            </button>
            {selected.length === 0 && <span className="hint">外す権限を選んでください。</span>}
          </div>
          {preview && (
            <div className="rollover-preview" aria-live="polite">
              <p className="rollover-counts">
                外す <strong>{preview.counts.remove}</strong> 件・すでに外れている {preview.counts.gone} 件・外せない {preview.counts.kept} 件
              </p>
              <ul className="rollover-items">
                {preview.items.map((item) => (
                  <li key={item.key} className={`rollover-item is-${item.action === 'remove' ? 'copy' : 'skip'}`}>
                    <span className="rollover-item-name">{item.holderName || '（すでにない権限）'}</span>
                    {item.sourceLabel && (
                      <span className="rollover-item-meta">
                        {item.sourceLabel}：{item.target}・{item.permission}
                      </span>
                    )}
                    {item.reason && <span className="rollover-item-reason">{item.reason}</span>}
                  </li>
                ))}
              </ul>
              <div className="admin-actions">
                <button type="button" className="danger" onClick={() => void apply()} disabled={busy || preview.counts.remove === 0}>
                  {busy ? '処理中…' : `${preview.counts.remove} 件の権限を外す`}
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className={`status ${error.stale ? 'warning' : 'error'}`} role="alert">
              <span>{error.text}</span>
              {error.stale && (
                <button type="button" className="secondary" onClick={() => void makePreview()}>
                  下見を作り直す
                </button>
              )}
            </div>
          )}
          {result && (
            <div className="rollover-result">
              <div className={`status ${result.failed.length > 0 ? 'warning' : 'ok'}`} role="status">
                <span>{result.run.summary}。</span>
              </div>
              {result.failed.length > 0 && (
                <ul className="rollover-reasons">
                  {result.failed.map((f) => (
                    <li key={f.item.key}>
                      {f.item.holderName}（{f.item.sourceLabel}：{f.item.target}）：{f.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function HandoverStep({ sourceYear, onChanged }: { sourceYear: number; onChanged: () => void }) {
  const load = useCallback((signal: AbortSignal) => rolloverApi.handover(sourceYear, signal), [sourceYear]);
  const handover = useLoader(load);
  const data = handover.data;
  const file = (format: 'markdown' | 'json') => async () => {
    await download('/api/rollover/handover/export', { sourceYear, format }, `引き継ぎ_${sourceYear}年度_下書き.${format === 'json' ? 'json' : 'md'}`);
    onChanged();
  };
  return (
    <div className="rollover-step-inner">
      <LoadStatus loader={handover} what="引き継ぎの資料" compact />
      {data && (
        <>
          <p className="hint">
            {sourceYear}年度の決定事項・団体（最後の段階）・年間の予定・未完了のタスクの件数を、引き継ぎの資料の下書きにします。担当者・作った人・メモの欄と団体の連絡先は入れず、本文にあるメールアドレスと電話番号は伏せます。本文や題名に書かれた名前は残るので、共有する前に読んで確かめてください。Markdown は人が読んで書き足す用、JSON はほかの道具に読ませる用です。
          </p>
          <p className="rollover-counts">
            決定事項 {data.counts.decisions} 件・団体 {data.counts.organizations} 件・予定 {data.counts.events} 件・未完了のタスク {data.counts.openTasks === null ? '読めず' : `${data.counts.openTasks} 件`}
          </p>
          {data.missing.length > 0 && (
            <ul className="rollover-notes">
              {data.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <div className="admin-actions">
            <DownloadButton primary label="Markdown を書き出す" run={file('markdown')} />
            <DownloadButton label="JSON を書き出す" run={file('json')} />
          </div>
          <details>
            <summary>中身を見る</summary>
            <pre className="rollover-md">{data.markdown}</pre>
          </details>
        </>
      )}
    </div>
  );
}
