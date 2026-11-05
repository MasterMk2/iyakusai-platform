import { useState } from 'react';
import { lineDiff, type MinutesDetail, type MinutesVersionResponse } from '../../../shared/minutes';
import { api, fmtDate, toFailure } from '../../api';

// The confirmed versions of the minutes (2026-11-06): the first confirmation is version 1, and each correction after it
// makes the next one with a note of what it changed. Each version can be read, compared with the one before, and
// written out as Markdown as it was confirmed.

function Changes({ before, after }: { before: string; after: string }) {
  const diff = lineDiff(before, after);
  if (!diff) return <p className="hint">長すぎるため、違いを出せません。</p>;
  const changed = diff.filter((d) => d.kind !== 'same');
  if (changed.length === 0) return <p className="hint">前の版と本文は同じです。</p>;
  return (
    <ul className="minutes-diff" aria-label="前の版との違い">
      {changed.map((d, i) => (
        <li key={i} className={d.kind === 'add' ? 'is-add' : 'is-del'}>
          <span className="minutes-diff-mark">{d.kind === 'add' ? '＋ 足した' : '− 消した'}</span> {d.text || '（空行）'}
        </li>
      ))}
    </ul>
  );
}

function VersionRow({ meetingId, no, current }: { meetingId: string; no: number; current: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MinutesVersionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'changes' | 'body'>(no > 1 ? 'changes' : 'body');

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data) {
      setError(null);
      api<MinutesVersionResponse>('GET', `/api/minutes/${meetingId}/versions/${no}`)
        .then(setData)
        .catch((err) => setError(toFailure(err).message));
    }
  };

  return (
    <>
      <div className="actions minutes-version-actions">
        <button type="button" className="secondary" aria-expanded={open} onClick={toggle} data-testid="minutes-version-open">
          {open ? '閉じる' : `第${no}版を見る`}
        </button>
        <a className="button secondary" href={`/api/minutes/${meetingId}/export.md?version=${no}`} download>
          第{no}版を書き出す
        </a>
        {current && <span className="bot-tag bot-tag-ok">いま正式な版</span>}
      </div>
      {open && !data && !error && <p className="status loading">読み込んでいます…</p>}
      {error && <p className="status error">{error}</p>}
      {open && data && (
        <div className="minutes-version-view" data-testid="minutes-version-view">
          {data.previousBody !== null && (
            <div className="view-switch" role="group" aria-label="版の見せ方">
              <button type="button" aria-pressed={view === 'changes'} onClick={() => setView('changes')}>
                第{no - 1}版との違い
              </button>
              <button type="button" aria-pressed={view === 'body'} onClick={() => setView('body')}>
                本文
              </button>
            </div>
          )}
          {view === 'changes' && data.previousBody !== null ? <Changes before={data.previousBody} after={data.body} /> : <pre className="minutes-body">{data.body}</pre>}
        </div>
      )}
    </>
  );
}

export function MinutesVersions({ m }: { m: MinutesDetail }) {
  if (m.versions.length === 0) return null;
  const last = m.versions.at(-1)!.no;
  return (
    <section className="panel minutes-versions" aria-labelledby="minutes-versions-title" data-testid="minutes-versions">
      <h3 id="minutes-versions-title">確定の履歴（{m.versions.length} 版）</h3>
      <ol className="minutes-version-list">
        {[...m.versions].reverse().map((v) => (
          <li key={v.no}>
            <p className="row-sub">
              <strong>第{v.no}版</strong> {v.confirmedByName}（{fmtDate(v.confirmedAt)}）{v.no === 1 ? '最初の確定' : `訂正: ${v.note}`}
            </p>
            <VersionRow meetingId={m.id} no={v.no} current={v.no === last} />
          </li>
        ))}
      </ol>
    </section>
  );
}
