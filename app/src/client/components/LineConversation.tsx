import { useCallback, useState } from 'react';
import { STATUS_LABELS } from '../../shared/api';
import type { LineConversationDetail, LineHistoryView, LineMessageView, OutboxView } from '../../shared/line';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LineReplyPanel } from './LineReplyPanel';
import { LoadStatus } from './LoadStatus';
import { Notes } from './Notes';
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

function Content({ m }: { m: LineMessageView }) {
  switch (m.content.kind) {
    case 'text':
      return <span className="line-text">{m.content.text}</span>;
    case 'unsupported':
      return <span className="line-placeholder">［{m.content.mediaType}：内容は取り込んでいません］</span>;
    case 'unavailable':
      return <span className="line-placeholder">{m.content.reason === 'e2ee' ? '［暗号化のため内容を取得できませんでした］' : '［本文がありません］'}</span>;
    case 'unsent':
      return <span className="line-placeholder">［送信者がこのメッセージの送信を取り消しました］</span>;
  }
}

/** Received messages and what the app sent, in time order (a sent reply shows where it was written). */
function timeline(d: LineConversationDetail): ({ kind: 'message'; at: string; m: LineMessageView } | { kind: 'sent'; at: string; o: OutboxView })[] {
  const sent = d.outbox.filter((o) => o.status !== 'failed').map((o) => ({ kind: 'sent' as const, at: o.createdAt, o }));
  const received = d.messages.map((m) => ({ kind: 'message' as const, at: m.sentAt, m }));
  return [...received, ...sent].sort((a, b) => a.at.localeCompare(b.at));
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
        {fmtDate(item.createdAt)} ・ {item.actorName} ・ {item.mock ? 'プッシュ（模擬）' : 'プッシュ'}・ {item.billableRecipients ?? '?'} 人宛て
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
}: {
  conversationId: string;
  refresh: number;
  onChanged: () => void;
  /** Show linked tasks and the create-task form (Task gateway enabled and user bound). */
  caseTasks?: boolean;
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
          {d.sending === 'mock' ? (
            <p className="status info" data-testid="line-mock-notice">
              LINE は模擬モードです。表示は合成データで、返信は模擬送信だけです。実際の LINE への送信は接続されていません。
            </p>
          ) : (
            <p className="hint" data-testid="line-live-notice">
              {d.sending === 'live'
                ? '公式LINE への返信はこのアプリから送ります。スマホの公式アカウントアプリから送った返信は、ここには出ません。'
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
          <ol className="line-timeline" aria-label="メッセージ">
            {timeline(d).map((e) =>
              e.kind === 'message' ? (
                <li key={e.m.id} className={`line-msg ${e.m.direction === 'outbound_legacy' ? 'mine' : ''}`} data-message-id={e.m.id}>
                  <span className="note-meta">
                    {e.m.senderLabel} ・ {fmtDate(e.m.sentAt)}
                  </span>
                  <Content m={e.m} />
                </li>
              ) : (
                <li key={e.o.id} className="line-msg mine" data-outbox-message={e.o.id}>
                  <span className="note-meta">
                    {d.account.name}（{e.o.actorName}）・ {fmtDate(e.o.createdAt)} ・ {e.o.statusLabel}
                  </span>
                  <span className="line-text">{e.o.body}</span>
                </li>
              ),
            )}
          </ol>
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
          <section className="handling" aria-label="対応情報">
            <h4>対応情報（この会話に適用）</h4>
            {(d.canTriage ?? d.access === 'edit') ? (
              <TriageForm basePath={basePath} triage={d.triage} onSaved={onChanged} doneHint="「完了」はアプリ内の対応状況です。返信の送信や配信を意味しません。" />
            ) : (
              <div className="triage readonly">
                <p className="status info">閲覧のみの権限です。対応情報とメモは編集できません。</p>
                <p>
                  対応状況: <strong>{STATUS_LABELS[d.triage.status]}</strong> ／ 担当者: {d.triage.assignee?.displayName ?? '担当なし'} ／ ラベル:{' '}
                  {d.triage.labels.join(', ') || 'なし'}
                </p>
              </div>
            )}
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
