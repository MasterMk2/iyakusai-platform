import { Fragment, useCallback, useEffect, useState } from 'react';
import { ApiFailure, fmtDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { BULLETIN_PHASE_LABELS, bulletinAudienceLabel, bulletinPeriodLabel, type BulletinDetailResponse, type BulletinInput, type BulletinView } from '../../../shared/bulletin';
import { BulletinForm } from './BulletinForm';
import { BOARD_HREF, bulletinApi } from './bulletinApi';

// One notice: its text, who it is for and until when, and the actions the server says this person may take
// (correct, withdraw, put back). Opening a notice that is new for this person records that they have read it.

const URL_IN_TEXT = /(https?:\/\/[^\s<>"'）」』】]+)/g;

/** The body with its line breaks kept and http(s) addresses as links. Nothing else is interpreted. */
function BodyText({ text }: { text: string }) {
  return (
    <p className="bulletin-body" data-testid="bulletin-body-text">
      {text.split(URL_IN_TEXT).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

const inputOf = (p: BulletinView): BulletinInput => ({ title: p.title, body: p.body, important: p.important, departments: p.departments, startsOn: p.startsOn, endsOn: p.endsOn });

interface Props {
  id: string;
  departments: string[];
  today: string;
  /** The board changed (read, corrected, withdrawn, put back): the list is read again. */
  onChanged: () => void;
}

export function BulletinDetail({ id, departments, today, onChanged }: Props) {
  const fetcher = useCallback((signal: AbortSignal) => bulletinApi.get(id, signal), [id]);
  const loader = useLoader(fetcher);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What a save or an action answered, shown at once (the loader's answer replaces it when it is newer).
  const [saved, setSaved] = useState<BulletinView | null>(null);

  const loaded = loader.data?.post ?? null;
  const p: BulletinView | null = saved && (!loaded || saved.version >= loaded.version) ? saved : loaded;
  const missing = loader.error instanceof ApiFailure && loader.error.status === 404;

  // Read once it is on screen. The mark on the list and the home count follow from the list being read again.
  const unread = loaded?.unread === true;
  useEffect(() => {
    if (!unread) return;
    let live = true;
    void bulletinApi.read(id).then(
      () => {
        if (live) onChanged();
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, unread, onChanged]);

  async function run(action: () => Promise<BulletinDetailResponse>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSaved((await action()).post);
      setNotice(done);
      onChanged();
    } catch (err) {
      setError(toFailure(err).message);
      loader.retry();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="bulletin-detail" aria-labelledby={`bulletin-title-${id}`} data-testid="bulletin-detail">
      <p className="detail-back">
        <a href={BOARD_HREF} className="link-button">
          ← 一覧に戻る
        </a>
      </p>
      {!p && !missing && <LoadStatus loader={loader} what="お知らせ" />}
      {missing && (
        <p className="status error" role="alert">
          このお知らせは見つからないか、あなたの所属には表示されていません。
        </p>
      )}

      {p && editing && (
        <BulletinForm
          mode="edit"
          initial={inputOf(p)}
          base={{ id: p.id, version: p.version }}
          departments={departments}
          today={today}
          onCancel={() => setEditing(false)}
          onReload={() => {
            setEditing(false);
            setSaved(null);
            loader.retry();
          }}
          onSaved={(detail) => {
            setSaved(detail.post);
            setEditing(false);
            setError(null);
            setNotice('保存しました。');
            onChanged();
          }}
        />
      )}

      {p && !editing && (
        <>
          <header>
            <h2 id={`bulletin-title-${id}`} className="thread-title">
              {p.title}
            </h2>
            <p className="facts-line">
              <span className={`bulletin-phase bulletin-phase-${p.phase}`} data-testid="bulletin-phase">
                {BULLETIN_PHASE_LABELS[p.phase]}
              </span>
              {p.important && <span className="bulletin-mark bulletin-mark-important">重要</span>}
              <span>対象：{bulletinAudienceLabel(p.departments)}</span>
              <span>掲載：{bulletinPeriodLabel(p.startsOn, p.endsOn)}</span>
            </p>
            <p className="facts-line">
              <span>{p.authorName}</span>
              <span>{fmtDate(p.createdAt)}</span>
              {p.edited && <span>（{fmtDate(p.updatedAt)} に {p.updatedByName} が直した）</span>}
            </p>
          </header>
          {!p.targeted && <p className="hint">あなたの所属は表示対象に入っていません（書いた人・権限管理者として見えています）。</p>}
          {p.body ? <BodyText text={p.body} /> : <p className="hint">本文はありません。</p>}

          {notice && (
            <p className="status ok" role="status" data-testid="bulletin-notice">
              {notice}
            </p>
          )}
          {error && (
            <p className="status error" role="alert">
              {error}
            </p>
          )}

          {p.canEdit && (
            <section className="bulletin-manage" aria-label="このお知らせの管理">
              {p.readers && (
                <p className="hint" data-testid="bulletin-readers">
                  開いた人：対象 {p.readers.audience} 人のうち {p.readers.read} 人
                </p>
              )}
              <div className="actions">
                {p.status === 'open' ? (
                  <>
                    <button type="button" className="secondary" disabled={busy} onClick={() => { setNotice(null); setEditing(true); }} data-testid="bulletin-edit">
                      直す
                    </button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => bulletinApi.withdraw(p.id, p.version), '取り下げました。「掲示板に戻す」で元に戻せます。')} data-testid="bulletin-withdraw">
                      取り下げる
                    </button>
                  </>
                ) : (
                  <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => bulletinApi.restore(p.id, p.version), '掲示板に戻しました。')} data-testid="bulletin-restore">
                    掲示板に戻す
                  </button>
                )}
              </div>
              {p.status === 'withdrawn' && <p className="hint">取り下げたお知らせは、書いた人と権限管理者にだけ見えます。</p>}
              {p.phase === 'scheduled' && <p className="hint">掲載開始日までは、書いた人と権限管理者にだけ見えます。</p>}
            </section>
          )}
        </>
      )}
    </article>
  );
}
