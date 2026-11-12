import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STATUS_LABELS } from '../../shared/api';
import type { LineConversationDetail, LineHistoryView, LineMessageView, OutboxView } from '../../shared/line';
import { DecisionRegisterLink } from './decisions/DecisionRegisterLink';
import { japanDay, todayInJapan } from './decisions/decisionLinks';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { isLater, laterOf, newestAt, readPlace, rememberedRead, rememberRead } from './lineLastRead';
import { LineReplyPanel } from './LineReplyPanel';
import { LoadStatus } from './LoadStatus';
import { Notes } from './Notes';
import { ThreadStatusButtons } from './ThreadStatusButtons';
import { TriageForm } from './TriageForm';
import { CaseTasks } from './tasks/CaseTasks';

const HISTORY_LABEL: Record<LineHistoryView['action'], string> = {
  assignee: '担当',
  status: '状態',
  labels: 'ラベル',
  note_added: 'メモ追加',
  message_unsent: '送信取消を反映',
  reply_started: '返信の送信を開始',
  reply_retry: '返信の再試行',
  reply_result: '返信の結果',
};

/** The images a send record carries (several since 2026-11-10; older records have the one `image`). */
const sentImages = (o: OutboxView) => o.images ?? (o.image ? [o.image] : []);

/** A received image; if it cannot be read (not kept by the receiver), the placeholder instead. */
function ReceivedImage({ url, mediaType }: { url: string; mediaType: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="line-placeholder">［{mediaType}：画像を取得できませんでした］</span>;
  return (
    <a className="line-image" href={url} target="_blank" rel="noopener">
      <img src={url} alt="受け取った画像" loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}

function Content({ m }: { m: LineMessageView }) {
  switch (m.content.kind) {
    case 'text':
      return <span className="line-text">{m.content.text}</span>;
    case 'unsupported':
      if (m.imageUrl) return <ReceivedImage key={m.imageUrl} url={m.imageUrl} mediaType={m.content.mediaType} />;
      return <span className="line-placeholder">［{m.content.mediaType}：内容は取り込んでいません］</span>;
    case 'unavailable':
      return <span className="line-placeholder">{m.content.reason === 'e2ee' ? '［暗号化のため内容を取得できませんでした］' : '［本文がありません］'}</span>;
    case 'unsent':
      return <span className="line-placeholder">［送信者がこのメッセージの送信を取り消しました］</span>;
  }
}

/** Who wrote a row: a history row says it came from the admin screen's history and, if outgoing, which member sent it. */
function sender(m: LineMessageView, accountName: string): string {
  if (m.provenance !== 'oa_history') return m.senderLabel;
  if (m.direction === 'inbound') return m.senderLabel;
  if (m.history?.autoReply) return `${accountName}（自動応答）`;
  return m.history?.staff ? `${accountName}（${m.history.staff}）` : accountName;
}

/** The day of the conversation's last message (Japan time), for a decision made in it; today when there is no message. */
function dayOfLastMessage(d: LineConversationDetail): string {
  const last = d.messages.reduce<string | null>((latest, m) => (latest === null || m.sentAt > latest ? m.sentAt : latest), null);
  return (last ? japanDay(last) : '') || todayInJapan();
}

/** Received messages and what the app sent, in time order (a sent reply shows where it was written). */
function timeline(d: LineConversationDetail): ({ kind: 'message'; at: string; m: LineMessageView } | { kind: 'sent'; at: string; o: OutboxView })[] {
  const sent = d.outbox.filter((o) => o.status !== 'failed').map((o) => ({ kind: 'sent' as const, at: o.createdAt, o }));
  const received = d.messages.map((m) => ({ kind: 'message' as const, at: m.sentAt, m }));
  return [...received, ...sent].sort((a, b) => a.at.localeCompare(b.at));
}

type TimelineEntry = ReturnType<typeof timeline>[number];

const rowKey = (e: TimelineEntry): string => (e.kind === 'message' ? e.m.id : `sent-${e.o.id}`);

function TimelineRow({ entry: e, accountName }: { entry: TimelineEntry; accountName: string }) {
  if (e.kind === 'message') {
    return (
      <li className={`line-msg ${e.m.direction === 'outbound_legacy' ? 'mine' : ''}`} data-message-id={e.m.id}>
        <span className="note-meta">
          {sender(e.m, accountName)} ・ {fmtDate(e.m.sentAt)}
          {e.m.provenance === 'oa_history' && (
            <span className="history-badge" title="公式アカウントの管理画面の履歴から取り込んだ行です（返信の対象にはなりません）" data-testid="line-history-badge">
              管理画面の履歴より
            </span>
          )}
        </span>
        <Content m={e.m} />
      </li>
    );
  }
  return (
    <li className="line-msg mine" data-outbox-message={e.o.id}>
      <span className="note-meta">
        {accountName}（{e.o.actorName}）・ {fmtDate(e.o.createdAt)} ・ {e.o.statusLabel}
        {e.o.broadcastId ? ' ・ 一斉送信' : ''}
        {e.o.via === 'discord' ? ' ・ Discord から' : ''}
      </span>
      <span className="line-text">{e.o.body}</span>
      {sentImages(e.o).map((img, i) => (
        <img key={img.previewUrl} className="line-image-thumb" src={img.previewUrl} alt={`送った画像 ${i + 1}`} />
      ))}
    </li>
  );
}

/** How long after opening a picture that finishes loading above the place may still move it back (unless the person moved). */
const HOLD_PLACE_MS = 3000;

/**
 * Puts `place` a little below the header (its scroll-margin) and keeps it there while received pictures load,
 * until the person scrolls, touches or types. Returns the cleanup.
 */
function openAt(place: HTMLElement, timeline: HTMLElement | null): () => void {
  place.scrollIntoView({ block: 'start' });
  const pending = [...(timeline?.querySelectorAll('img') ?? [])].filter((img) => !img.complete);
  if (pending.length === 0) return () => {};
  const again = () => place.scrollIntoView({ block: 'start' });
  const moves = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
  const stop = () => {
    clearTimeout(timer);
    pending.forEach((img) => {
      img.removeEventListener('load', again);
      img.removeEventListener('error', again);
    });
    moves.forEach((m) => window.removeEventListener(m, stop));
  };
  const timer = setTimeout(stop, HOLD_PLACE_MS);
  pending.forEach((img) => {
    img.addEventListener('load', again);
    img.addEventListener('error', again);
  });
  moves.forEach((m) => window.addEventListener(m, stop, { passive: true }));
  return stop;
}

function OutboxItem({ item, canRetry, onChanged }: { item: OutboxView; canRetry: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/line/outbox/${item.id}/retry`, { expectedAttempts: item.attempts.length });
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  return (
    <li className={`outbox outbox-${item.status}`} data-outbox-id={item.id}>
      <span className="note-meta">
        {fmtDate(item.createdAt)} ・ {item.actorName} ・ {item.broadcastId ? '一斉送信' : item.mock ? 'プッシュ（模擬）' : 'プッシュ'}・ {item.billableRecipients ?? '?'} 人宛て
        {item.via === 'discord' ? ' ・ Discord から' : ''}
        {sentImages(item).length > 0 ? ` ・ 画像 ${sentImages(item).length} 枚` : ''}
        {(item.files?.length ?? 0) > 0 ? ` ・ ファイル ${item.files!.length} 個` : ''}
      </span>
      <strong className="outbox-status" data-testid="outbox-status">
        {item.statusLabel}
      </strong>
      <span className="hint">{item.statusNote}</span>
      <pre className="mail-text">{item.body}</pre>
      <details>
        <summary>試行の記録（{item.attempts.length} 回）</summary>
        <ul>
          {item.attempts.map((a) => (
            <li key={a.n}>
              {a.n} 回目 {fmtDate(a.startedAt)} {a.actorName}: {a.outcomeLabel}
            </li>
          ))}
        </ul>
      </details>
      {item.retryable && canRetry && (
        <button type="button" className="secondary" disabled={busy} onClick={() => void retry()}>
          {item.retryNotBefore ? `同じ内容で再試行（${fmtDate(item.retryNotBefore)} 以降）` : '同じ内容で再試行'}
        </button>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function LineConversation({
  conversationId,
  refresh,
  onChanged,
  caseTasks = false,
  userId,
}: {
  conversationId: string;
  refresh: number;
  onChanged: () => void;
  /** Show linked tasks and the create-task form (Task gateway enabled and user bound). */
  caseTasks?: boolean;
  /** Whose place is remembered on this browser; none: opens at the latest and remembers nothing. */
  userId: string | null;
}) {
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<LineConversationDetail>('GET', `/api/line/conversations/${encodeURIComponent(conversationId)}`, undefined, signal);
    },
    [conversationId, refresh],
  );
  const conv = useLoader(load);
  const notFound = conv.error && (conv.error.status === 404 || conv.error.status === 400);
  const d = conv.data;
  const basePath = `/api/line/conversations/${conversationId}`;
  const canTriage = d ? (d.canTriage ?? d.access === 'edit') : false;

  // Where this person stopped last time on this device, read once before this visit is remembered (2026-11-13); the
  // server's place (any device) comes with the conversation, and the later of the two counts.
  const [remembered] = useState(() => (userId ? rememberedRead(userId, conversationId) : null));
  const rows = d ? timeline(d) : [];
  const ats = rows.map((e) => e.at);
  const newest = newestAt(ats);
  // The line goes before the first row that came since, decided when the conversation is first shown: rows that come
  // in while it is open (a reply sent from here) stay below it or, with nothing new, add no line. null: nothing new.
  const [firstUnread, setFirstUnread] = useState<string | null | undefined>(undefined);
  if (d && firstUnread === undefined) {
    const place = readPlace(ats, laterOf(d.lastReadAt ?? null, remembered));
    setFirstUnread(place.unread > 0 ? rowKey(rows[place.lastRead + 1]!) : null);
  }
  const placeRef = useRef<HTMLElement | null>(null);
  const setPlace = useCallback((el: HTMLElement | null) => {
    placeRef.current = el;
  }, []);
  const timelineRef = useRef<HTMLOListElement | null>(null);
  const placed = useRef(false);
  // Only on the first showing: a reload after a status change or a reply keeps where the person is.
  useLayoutEffect(() => {
    if (!d || placed.current || !placeRef.current) return;
    placed.current = true;
    return openAt(placeRef.current, timelineRef.current);
  }, [d]);
  // What was on the screen counts as read, as in the LINE app; rows that come in while it is open too. The server is told
  // only when it keeps places (undefined: it does not) and has an older one; a failure leaves this device's copy.
  const serverPlace = d?.lastReadAt;
  useEffect(() => {
    if (!userId || !newest) return;
    rememberRead(userId, conversationId, newest);
    if (serverPlace === undefined || (serverPlace !== null && !isLater(newest, serverPlace))) return;
    void api('PUT', `/api/line/conversations/${encodeURIComponent(conversationId)}/read`, { at: newest }).catch(() => undefined);
  }, [userId, conversationId, newest, serverPlace]);

  return (
    <div className="thread-detail">
      {notFound ? (
        <p className="status error" role="alert" data-testid="thread-not-found">
          会話が見つからないか、閲覧権限がありません。
        </p>
      ) : (
        <LoadStatus loader={conv} what="LINE の会話" />
      )}
      {d && !notFound && (
        <>
          <h2 className="thread-title">
            {d.title}
            <span className="source-badge source-line">LINE</span>
            <span className="mailbox-badge">{d.account.name}</span>
          </h2>
          {/* A mock conversation shows synthetic text: it is not registered as a decision. */}
          {d.sending !== 'mock' && (
            <div className="actions">
              <DecisionRegisterLink prefill={{ title: '', decidedOn: dayOfLastMessage(d), source: { kind: 'line', refId: conversationId, label: d.title || '公式LINE', link: `#/line/${encodeURIComponent(d.account.id)}?conv=${encodeURIComponent(conversationId)}` } }} />
            </div>
          )}
          {d.sending === 'mock' ? (
            <p className="status info" data-testid="line-mock-notice">
              LINE は模擬モードです。表示は合成データで、返信は模擬送信だけです。実際の LINE への送信は接続されていません。
            </p>
          ) : (
            <p className="hint" data-testid="line-live-notice">
              {d.sending === 'live'
                ? '公式LINE への返信はこのアプリから送ります。スマホの公式アカウントアプリから送った返信は、ここには出ません。'
                : d.account.kind === 'legacy_archive'
                  ? '公式アカウントの管理画面の履歴のうち、相手の利用者 ID が分からなかった会話です（閲覧だけ）。'
                  : 'このサーバーでは公式LINE の送信は設定されていません（閲覧だけ）。'}
            </p>
          )}
          <p className="hint">
            {d.target.typeLabel}
            {d.target.maskedId ? `（ID ${d.target.maskedId}）` : ''}
            {d.target.memberCount !== null ? ` ・ 確認済みの参加人数 ${d.target.memberCount} 人` : ''}
          </p>
          {d.origin === 'legacy_export' && (
            <p className="hint">旧履歴から取り込んだ記録です。過去のすべてのやり取りを再現するものではなく、画像などの内容は取り込んでいません。</p>
          )}
          {/* Handling before the messages, as in mail, so it is changed without scrolling past a long conversation. */}
          {canTriage && (
            <section className="thread-status" aria-label="会話の対応状況">
              <h3 className="section-label">
                対応状況<span className="hint">押すとすぐ保存</span>
              </h3>
              <ThreadStatusButtons target={{ kind: 'line', conversationId: d.conversationId, version: d.triage.version }} subject={d.title} statuses={[d.triage.status]} onChanged={onChanged} />
              <p className="hint">「完了」はアプリ内の対応状況です。返信の送信や配信を意味しません。</p>
            </section>
          )}
          <section className="handling" aria-label="対応情報">
            {canTriage ? (
              <TriageForm basePath={basePath} triage={d.triage} onSaved={onChanged} showStatus={false} doneHint="" />
            ) : (
              <div className="triage readonly">
                <p className="status info">閲覧のみの権限です。対応情報とメモは編集できません。</p>
                <p>
                  対応状況: <strong>{STATUS_LABELS[d.triage.status]}</strong> ／ 担当者: {d.triage.assignee?.displayName ?? '担当なし'} ／ ラベル:{' '}
                  {d.triage.labels.join(', ') || 'なし'}
                </p>
              </div>
            )}
          </section>
          <ol className="line-timeline" aria-label="メッセージ" ref={timelineRef}>
            {rows.map((e) => (
              <Fragment key={rowKey(e)}>
                {rowKey(e) === firstUnread && (
                  <li className="line-unread-divider" ref={setPlace} data-testid="line-unread-divider">
                    ここから未読
                  </li>
                )}
                <TimelineRow entry={e} accountName={d.account.name} />
              </Fragment>
            ))}
          </ol>
          {/* Nothing new: the place is the end of the messages, with the last of them above it and the reply below. */}
          {firstUnread === null && <div className="line-read-place" ref={setPlace} aria-hidden="true" />}
          <LineReplyPanel detail={d} onSent={onChanged} />
          {d.outbox.length > 0 && (
            <section className="line-outbox" aria-label="返信の送信記録">
              <h4>返信の送信記録（「受付済み」は配信・既読を意味しません）</h4>
              <ul>
                {d.outbox.map((o) => (
                  <OutboxItem key={o.id} item={o} canRetry={d.reply.canReply} onChanged={onChanged} />
                ))}
              </ul>
            </section>
          )}
          <section className="mail-activity" aria-label="内部メモと変更履歴">
            <Notes basePath={basePath} notes={d.notes} canEdit={d.access === 'edit'} onAdded={onChanged} heading="内部メモ（この LINE アカウントの閲覧者だけに表示・相手には送信されません）" />
            <details className="history">
              <summary>変更履歴（{d.history.length} 件）</summary>
              <ul>
                {[...d.history].reverse().map((h) => (
                  <li key={h.id}>
                    {fmtDate(h.at)} {h.actorName}: {HISTORY_LABEL[h.action]}
                    {(h.from !== null || h.to !== null) && h.action !== 'note_added' && ` 「${h.from ?? 'なし'}」→「${h.to ?? 'なし'}」`}
                  </li>
                ))}
              </ul>
            </details>
          </section>
          {caseTasks && <CaseTasks kind="line" sourceId={conversationId} />}
        </>
      )}
    </div>
  );
}
