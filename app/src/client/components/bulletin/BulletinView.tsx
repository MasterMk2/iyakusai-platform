import { useCallback, useState } from 'react';
import { fmtListDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import {
  BULLETIN_LIST_LABELS,
  BULLETIN_LISTS,
  BULLETIN_PHASE_LABELS,
  bulletinAudienceLabel,
  bulletinPeriodLabel,
  defaultBulletinEndsOn,
  type BulletinInput,
  type BulletinList,
  type BulletinListItem,
} from '../../../shared/bulletin';
import { BulletinDetail } from './BulletinDetail';
import { BulletinForm } from './BulletinForm';
import { BOARD_HREF, BOARD_NEW_HREF, boardPostHref, bulletinApi, useBulletinMeta } from './bulletinApi';

// The board's screen: the list (on the board now, for later, ended) beside the notice opened or the form. On a
// phone the list and the notice take turns, as the other two-pane screens do.

const PAGE_SIZE = 20;

const EMPTY: Record<BulletinList, string> = {
  current: 'いま掲載中のお知らせはありません。',
  scheduled: '掲載開始日を先の日にしたお知らせはありません（書いた人と権限管理者にだけ、ここに出ます）。',
  ended: '掲載が終わったお知らせはありません。',
};

interface Props {
  postId: string | null;
  creating: boolean;
}

export function BulletinView({ postId, creating }: Props) {
  const meta = useBulletinMeta();
  // Every read, save, withdrawal and return counts up; the list reads the board again when the count moves.
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  const [list, setList] = useState<BulletinList>('current');

  if (meta === null || !meta.enabled) {
    return (
      <div className="layout home-layout">
        <main className="main" aria-labelledby="board-title">
          <h2 id="board-title">掲示板</h2>
          {meta === null ? (
            <p className="status loading" role="status">
              読み込み中…
            </p>
          ) : (
            <p className="status error" role="alert" data-testid="board-unavailable">
              掲示板は、このサーバーでは使えないか、委員だけが使えます。
            </p>
          )}
        </main>
      </div>
    );
  }

  const blank: BulletinInput = { title: '', body: '', important: false, departments: [], startsOn: null, endsOn: defaultBulletinEndsOn(meta.today) };
  const showingDetail = creating || postId !== null;
  return (
    <div className={`layout bulletin-layout ${showingDetail ? 'has-detail' : ''}`}>
      <BulletinListPane list={list} onList={setList} selectedId={postId} canPost={meta.canPost} creating={creating} revision={revision} onChanged={changed} />
      <section className="bulletin-pane" aria-label="選んだお知らせ">
        {creating ? (
          <BulletinForm
            mode="new"
            initial={blank}
            departments={meta.departments}
            today={meta.today}
            onCancel={() => {
              window.location.hash = BOARD_HREF;
            }}
            onSaved={(detail) => {
              // The list shows where the new notice went: for later, or on the board.
              setList(detail.post.phase === 'scheduled' ? 'scheduled' : 'current');
              changed();
              window.location.hash = boardPostHref(detail.post.id);
            }}
          />
        ) : postId ? (
          <BulletinDetail key={postId} id={postId} departments={meta.departments} today={meta.today} onChanged={changed} />
        ) : (
          <div className="detail-placeholder">
            <h2>お知らせを選択</h2>
            <p>一覧から選ぶと、本文がここに出ます。開いたお知らせは新着から外れます。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function BulletinListPane({
  list,
  onList,
  selectedId,
  canPost,
  creating,
  revision,
  onChanged,
}: {
  list: BulletinList;
  onList: (list: BulletinList) => void;
  selectedId: string | null;
  canPost: boolean;
  creating: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcher = useCallback(
    (signal: AbortSignal) => {
      void revision;
      return bulletinApi.list(list, page, PAGE_SIZE, signal);
    },
    [list, page, revision],
  );
  const loader = useLoader(fetcher);
  // The answer for the list on screen (while another list loads, the old rows are not shown under the new name).
  const data = loader.data && loader.data.list === list ? loader.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const unreadTotal = loader.data?.unreadTotal ?? 0;

  const choose = (next: BulletinList) => {
    setPage(1);
    onList(next);
  };

  async function readAll() {
    setBusy(true);
    setError(null);
    try {
      await bulletinApi.readAll();
      onChanged();
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel bulletin-list" aria-labelledby="board-title">
      <div className="panel-head">
        <h2 id="board-title">掲示板</h2>
        {canPost && (
          <a className="button" href={BOARD_NEW_HREF} aria-current={creating ? 'page' : undefined} data-testid="bulletin-new">
            お知らせを書く
          </a>
        )}
      </div>

      <div className="bulletin-tools">
        <div className="view-switch" role="group" aria-label="表示するお知らせ">
          {BULLETIN_LISTS.map((key) => (
            <button key={key} type="button" aria-pressed={list === key} onClick={() => choose(key)} data-testid={`bulletin-list-${key}`}>
              {BULLETIN_LIST_LABELS[key]}
              {key === 'current' && unreadTotal > 0 && (
                <span className="count-badge" aria-label={`新着 ${unreadTotal} 件`}>
                  {unreadTotal}
                </span>
              )}
            </button>
          ))}
        </div>
        {unreadTotal > 0 && (
          <button type="button" className="secondary small" disabled={busy} onClick={() => void readAll()} data-testid="bulletin-read-all">
            すべて既読にする
          </button>
        )}
      </div>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}

      <LoadStatus loader={loader} what="掲示板" />
      {data && data.total === 0 && (
        <div className="empty-state" data-testid="bulletin-empty">
          <p>{EMPTY[list]}</p>
          {list === 'current' && canPost && (
            <a className="button secondary" href={BOARD_NEW_HREF}>
              お知らせを書く
            </a>
          )}
        </div>
      )}
      {data && data.total > 0 && (
        <>
          <ul className="rows bulletin-rows" aria-label={`${BULLETIN_LIST_LABELS[list]}のお知らせ`}>
            {data.items.map((item) => (
              <li key={item.id}>
                <BulletinRowLink item={item} selected={item.id === selectedId} showPhase={list === 'ended'} />
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="pager" aria-label="ページ">
              <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                前のページ
              </button>
              <span className="hint">
                {page} / {pages} ページ
              </span>
              <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                次のページ
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

/** A row of a list of notices (the board and the home screen): marks, the title, then who it is for and until when. */
export function BulletinRowLink({ item, selected = false, showPhase = false }: { item: BulletinListItem; selected?: boolean; showPhase?: boolean }) {
  return (
    <a href={boardPostHref(item.id)} className={`bulletin-row ${item.unread ? 'is-unread' : ''}`} aria-current={selected ? 'true' : undefined} data-testid="bulletin-row">
      <span className="bulletin-row-title">
        {item.unread && <span className="bulletin-mark bulletin-mark-new">新着</span>}
        {item.important && <span className="bulletin-mark bulletin-mark-important">重要</span>}
        {showPhase && item.phase === 'withdrawn' && <span className={`bulletin-phase bulletin-phase-${item.phase}`}>{BULLETIN_PHASE_LABELS[item.phase]}</span>}
        <span className="bulletin-row-text">{item.title}</span>
      </span>
      {item.excerpt && <span className="bulletin-row-excerpt">{item.excerpt}</span>}
      <span className="facts-line">
        <span>対象：{bulletinAudienceLabel(item.departments)}</span>
        <span>{bulletinPeriodLabel(item.startsOn, item.endsOn)}</span>
        <span>
          {item.authorName}・{fmtListDate(item.announcedAt)}
        </span>
      </span>
    </a>
  );
}
