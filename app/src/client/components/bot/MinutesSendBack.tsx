import { useState, type RefObject } from 'react';
import { MINUTES_LIMITS, type MinutesDetail, type MinutesReview, type MinutesReviewBodyResponse, type MinutesReviewRequest } from '../../../shared/minutes';
import { api, fmtDate, toFailure } from '../../api';

// Sending the AI's draft back with a comment (2026-11-06): the AI reworks the draft along the comment and writes the
// body anew, and says what it changed. The body before is kept with the comment. Each comment runs the AI again, so a
// meeting takes at most MINUTES_LIMITS.reviews of them.

const STATUS: Record<MinutesReview['status'], { label: string; tone: string }> = {
  pending: { label: 'AI が手直し中', tone: 'info' },
  done: { label: '手直し済み', tone: 'ok' },
  failed: { label: '手直しできず', tone: 'error' },
};

interface Props {
  m: MinutesDetail;
  comment: string;
  onComment: (text: string) => void;
  box: RefObject<HTMLTextAreaElement | null>;
  /** Unsaved changes in the editor: they must be saved first (the AI gets the saved body). */
  dirty: boolean;
  onSent: (next: MinutesDetail) => void;
}

function EarlierBody({ meetingId, reviewId }: { meetingId: string; reviewId: number }) {
  const [state, setState] = useState<{ body?: string; error?: string; loading?: boolean }>({});
  return (
    <details
      className="bot-details"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || state.body !== undefined || state.loading) return;
        setState({ loading: true });
        api<MinutesReviewBodyResponse>('GET', `/api/minutes/${meetingId}/reviews/${reviewId}/body`)
          .then((r) => setState({ body: r.body }))
          .catch((err) => setState({ error: toFailure(err).message }));
      }}
    >
      <summary>差し戻す前の本文を見る</summary>
      {state.loading && <p className="status loading">読み込んでいます…</p>}
      {state.error && <p className="status error">{state.error}</p>}
      {state.body !== undefined && <pre className="minutes-body minutes-earlier">{state.body || '（空）'}</pre>}
    </details>
  );
}

export function MinutesReviewHistory({ m }: { m: MinutesDetail }) {
  if (m.reviews.length === 0) return null;
  return (
    <details className="bot-details minutes-reviews" open={m.reviews.some((r) => r.status !== 'done')}>
      <summary>差し戻しの履歴（{m.reviews.length}）</summary>
      <ol className="minutes-review-list">
        {[...m.reviews].reverse().map((r) => (
          <li key={r.id} data-testid="minutes-review">
            <p className="row-sub">
              <span className={`bot-tag bot-tag-${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span> {r.byName}（{fmtDate(r.at)}）
            </p>
            <p className="minutes-comment">{r.comment}</p>
            {r.reply && <p className="minutes-reply">AI: {r.reply}</p>}
            {r.error && <p className="status error">{r.error}（下書きは前のままです）</p>}
            {r.status !== 'pending' && <EarlierBody meetingId={m.id} reviewId={r.id} />}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function MinutesSendBack({ m, comment, onComment, box, dirty, onSent }: Props) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const used = m.reviews.filter((r) => r.status !== 'failed').length;

  if (m.stage !== 'draft' || !m.draft) return null;
  if (!m.can.review) {
    return (
      <p className="hint" data-testid="minutes-review-limit">
        差し戻しは 1 件の議事録につき {MINUTES_LIMITS.reviews} 回までです。ここからは本文を直接直してください。
      </p>
    );
  }

  const send = async () => {
    if (
      m.bodyEdited &&
      !window.confirm('本文に人が直した所があります。今の本文も AI に渡して直した所を生かすよう伝えますが、AI が本文を書き直すので、書式や書き足しが消えることがあります（差し戻す前の本文は履歴から見られます）。差し戻しますか？')
    ) {
      return;
    }
    setSending(true);
    setFailure(null);
    try {
      const body: MinutesReviewRequest = { expectedVersion: m.version, comment };
      onSent(await api<MinutesDetail>('POST', `/api/minutes/${m.id}/review`, body));
      onComment('');
    } catch (err) {
      setFailure(toFailure(err).message);
    } finally {
      setSending(false);
    }
  };

  const reason = dirty ? '本文の変更を先に保存してください（AI には保存した本文を渡します）。' : null;

  return (
    <div className="minutes-sendback" data-testid="minutes-sendback">
      <label htmlFor="minutes-comment">AI に直してほしいこと</label>
      <textarea
        id="minutes-comment"
        ref={box}
        rows={4}
        value={comment}
        maxLength={MINUTES_LIMITS.comment}
        onChange={(e) => onComment(e.target.value)}
        placeholder="例: 決定事項に「反省会は出欠を取ってから決める」を足して。ToDo の期限は 11/27。"
        data-testid="minutes-comment"
      />
      <p className="field-hint">
        項目の「コメント」を押すと、その項目を引用します。AI は文字起こし（人が直した所を含む）と今の本文を見て下書きを直し、本文を書き直します（出席者の行は引き継ぎます）。あと {MINUTES_LIMITS.reviews - used} 回。
      </p>
      {reason && <p className="status warning">{reason}</p>}
      {failure && (
        <p className="status error" role="alert">
          {failure}
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={() => void send()} disabled={sending || dirty || !comment.trim()} data-testid="minutes-review-send">
          {sending ? '送っています…' : 'コメントを付けて AI に差し戻す'}
        </button>
      </div>
    </div>
  );
}
