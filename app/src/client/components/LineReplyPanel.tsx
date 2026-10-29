import { useRef, useState } from 'react';
import { LINE_LIMITS, type LineConversationDetail, type LineDraftView, type LinePreviewResponse, type LineSendResponse } from '../../shared/line';
import { api, fmtDate, toFailure } from '../api';

/**
 * Manual reply: save draft -> server preview with a short-lived confirmation ->
 * explicit confirmation -> one send per confirmation. Any edit after the preview
 * discards it, and the send button is disabled while a request is in flight.
 */
export function LineReplyPanel({ detail, onSent }: { detail: LineConversationDetail; onSent: () => void }) {
  const [saved, setSaved] = useState<LineDraftView | null>(detail.reply.draft);
  const [body, setBody] = useState(detail.reply.draft?.body ?? '');
  const [preview, setPreview] = useState<LinePreviewResponse | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editedAfterPreview, setEditedAfterPreview] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const sending = useRef(false);

  if (!detail.reply.available) {
    return (
      <section className="line-reply" aria-label="LINE で返信">
        <h4>LINE で返信</h4>
        <p className="status info" data-testid="line-reply-unavailable">
          {detail.reply.reason ?? 'この会話には返信できません。'}
        </p>
      </section>
    );
  }

  function edit(value: string) {
    setBody(value);
    if (preview) {
      // The confirmation covered the previous text only.
      setPreview(null);
      setOperationId(null);
      setConfirmed(false);
      setEditedAfterPreview(true);
    }
  }

  async function prepare() {
    setBusy(true);
    setMessage(null);
    setEditedAfterPreview(false);
    try {
      let draft = saved;
      if (!draft || draft.body !== body.trim()) {
        draft = await api<LineDraftView>('PUT', `/api/line/conversations/${detail.conversationId}/reply/draft`, { body, expectedVersion: saved?.version ?? null });
        setSaved(draft);
        setBody(draft.body);
      }
      const p = await api<LinePreviewResponse>('POST', `/api/line/conversations/${detail.conversationId}/reply/preview`, { draftId: draft.id, draftVersion: draft.version });
      setPreview(p);
      setOperationId(crypto.randomUUID());
      setConfirmed(false);
    } catch (err) {
      setMessage({ kind: 'error', text: toFailure(err).message });
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!preview || !operationId || !confirmed || sending.current) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<LineSendResponse>('POST', `/api/line/conversations/${detail.conversationId}/reply/send`, {
        consentId: preview.consentId,
        operationId,
        draftId: preview.draftId,
        draftVersion: preview.draftVersion,
        body: preview.body,
      });
      setPreview(null);
      setOperationId(null);
      setConfirmed(false);
      setSaved(null);
      setBody('');
      setMessage({ kind: 'ok', text: `${res.outbox.mock ? '模擬送信の結果' : '送信の結果'}: ${res.outbox.statusLabel}。${res.outbox.statusNote}` });
      onSent();
    } catch (err) {
      const failure = toFailure(err);
      if (failure.status !== 0 && failure.status < 500) {
        setPreview(null);
        setOperationId(null);
        setConfirmed(false);
      }
      setMessage({ kind: 'error', text: failure.message });
      onSent();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const length = body.trim().length;
  const mock = detail.sending !== 'live';
  return (
    <section className="line-reply" aria-label="LINE で返信">
      <h4>{mock ? 'LINE で返信（手動・模擬送信）' : 'LINE で返信'}</h4>
      <p className="hint">
        手動の返信だけを扱います。自動返信や一斉送信はしません。送信前に送信先と本文を確認し、確認した内容だけを 1 回送ります。
      </p>
      <textarea aria-label="返信本文" rows={4} value={body} onChange={(e) => edit(e.target.value)} disabled={busy} placeholder="返信本文を入力" />
      <span className={`counter ${length > LINE_LIMITS.replyMaxLength ? 'over' : ''}`}>
        {length} / {LINE_LIMITS.replyMaxLength}
      </span>
      {editedAfterPreview && <p className="status warning">本文を変更したため、送信前にもう一度確認が必要です。</p>}
      {!preview && (
        <div className="actions">
          <button type="button" onClick={() => void prepare()} disabled={busy || length === 0}>
            下書きを保存して送信内容を確認
          </button>
        </div>
      )}
      {preview && (
        <div className="line-preview" data-testid="line-reply-preview">
          <h5>送信内容の確認</h5>
          <dl>
            <dt>送信元</dt>
            <dd data-testid="preview-account">{preview.account.name}</dd>
            <dt>送信先</dt>
            <dd data-testid="preview-target">
              {preview.target.title}（{preview.target.typeLabel}
              {preview.target.maskedId ? `・ID ${preview.target.maskedId}` : ''}）
            </dd>
            <dt>届く人数</dt>
            <dd data-testid="preview-recipients">{preview.billableRecipients} 人（通数として {preview.billableRecipients} 通）</dd>
            <dt>送信方法</dt>
            <dd data-testid="preview-method">{preview.mock ? 'プッシュメッセージ（模擬）' : 'プッシュメッセージ（公式アカウントから送信）'}</dd>
            <dt>本文</dt>
            <dd>
              <pre className="mail-text" data-testid="preview-body">
                {preview.body}
              </pre>
            </dd>
            <dt>確認の期限</dt>
            <dd>{fmtDate(preview.expiresAt)}</dd>
          </dl>
          <ul className="notices">
            {preview.notices.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <label className="confirm-check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
            上記の送信先・本文で送信することを確認しました
          </label>
          <div className="actions">
            <button type="button" onClick={() => void send()} disabled={!confirmed || busy}>
              {busy ? '送信処理中…' : preview.mock ? '模擬送信する' : 'LINE で送信する'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setOperationId(null);
                setConfirmed(false);
              }}
            >
              確認をやめて編集に戻る
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="line-reply-message">
          {message.text}
        </p>
      )}
    </section>
  );
}
