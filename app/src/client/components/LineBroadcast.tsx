import { useCallback, useMemo, useRef, useState } from 'react';
import { LINE_LIMITS, type BroadcastOptionsResponse, type BroadcastPreviewResponse, type BroadcastSendResponse } from '../../shared/line';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LineImagePicker, type PickedImage } from './LineImagePicker';
import { LoadStatus } from './LoadStatus';

/**
 * Broadcast (2026-11-02): the same text (and one image) to several 1:1 conversations of the official account, or
 * to everyone it can be sent to. The server confirms the exact list, the count against this month's limit and
 * LINE's own count; the sender ticks the box and sends once. Each conversation then shows its own send record.
 */
export function LineBroadcast({ accountId, refresh, onSent, onClose }: { accountId: string; refresh: number; onSent: () => void; onClose: () => void }) {
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<BroadcastOptionsResponse>('GET', `/api/line/accounts/${encodeURIComponent(accountId)}/broadcast`, undefined, signal);
    },
    [accountId, refresh],
  );
  const options = useLoader(load);
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [body, setBody] = useState('');
  const [image, setImage] = useState<PickedImage | null>(null);
  const [preview, setPreview] = useState<BroadcastPreviewResponse | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const sending = useRef(false);

  const o = options.data;
  const shown = useMemo(() => {
    const q = filter.trim();
    return (o?.recipients ?? []).filter((r) => !q || r.title.includes(q));
  }, [o, filter]);

  function changed() {
    setPreview(null);
    setOperationId(null);
    setConfirmed(false);
  }

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    changed();
  }

  const count = all ? (o?.recipients.length ?? 0) : selected.size;
  const length = body.trim().length;

  async function prepare() {
    setBusy(true);
    setMessage(null);
    try {
      const p = await api<BroadcastPreviewResponse>('POST', `/api/line/accounts/${encodeURIComponent(accountId)}/broadcast/preview`, {
        recipients: all ? 'all' : [...selected],
        body,
        imageId: image?.id ?? null,
      });
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
      const res = await api<BroadcastSendResponse>('POST', '/api/line/broadcast/send', { consentId: preview.consentId, operationId, body: preview.body });
      setPreview(null);
      setOperationId(null);
      setConfirmed(false);
      setBody('');
      setImage(null);
      setSelected(new Set());
      setAll(false);
      setMessage({ kind: 'ok', text: res.message });
      onSent();
    } catch (err) {
      const failure = toFailure(err);
      if (failure.status !== 0 && failure.status < 500) changed();
      setMessage({ kind: 'error', text: failure.message });
      onSent();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="thread-detail line-broadcast" data-testid="line-broadcast">
      <h2 className="thread-title">
        一斉送信
        <span className="source-badge source-line">LINE</span>
        {o && <span className="mailbox-badge">{o.account.name}</span>}
      </h2>
      <LoadStatus loader={options} what="一斉送信の宛先" />
      {o && (
        <>
          <p className="hint">
            同じ文（と画像 1 枚）を、選んだ 1:1 の相手にまとめて送ります。宛先にできるのは、利用者 ID が分かっていて友だち解除・ブロックされていない相手です。月の通数は 1 人 1 通ずつ数えます（今月このアプリから {o.monthUsed} 通
            {o.monthlyLimit !== null ? `／上限 ${o.monthlyLimit} 通` : ''}）。
          </p>
          {o.mock && <p className="status info">模擬モードです。実際の LINE には送信されません。</p>}
          <fieldset className="broadcast-recipients" disabled={busy}>
            <legend>宛先（{count} 人）</legend>
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => {
                  setAll(e.target.checked);
                  changed();
                }}
                data-testid="broadcast-all"
              />
              送れる相手すべて（{o.recipients.length} 人）
            </label>
            {!all && (
              <>
                <input type="search" placeholder="名前で絞り込む" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="宛先を名前で絞り込む" />
                {o.recipients.length === 0 ? (
                  <p className="hint">送れる相手がいません。</p>
                ) : (
                  <ul className="broadcast-list">
                    {shown.map((r) => (
                      <li key={r.conversationId}>
                        <label>
                          <input type="checkbox" checked={selected.has(r.conversationId)} onChange={(e) => toggle(r.conversationId, e.target.checked)} data-conversation-id={r.conversationId} />
                          {r.title}
                          <span className="hint">
                            {' '}
                            ID {r.maskedId}
                            {r.friend ? '' : '・友だち登録は未確認'}
                            {r.latestAt ? `・最終 ${fmtDate(r.latestAt)}` : ''}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </fieldset>
          <textarea
            aria-label="一斉送信の本文"
            rows={5}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              changed();
            }}
            disabled={busy}
            placeholder="本文を入力"
          />
          <span className={`counter ${length > LINE_LIMITS.replyMaxLength ? 'over' : ''}`}>
            {length} / {LINE_LIMITS.replyMaxLength}
          </span>
          {o.imagesEnabled ? (
            <LineImagePicker
              accountId={o.account.id}
              image={image}
              onChange={(next) => {
                setImage(next);
                changed();
              }}
              disabled={busy}
            />
          ) : (
            <p className="hint">このサーバーでは画像を送れません（公開 URL が設定されていません）。</p>
          )}
          {!preview && (
            <div className="actions">
              <button type="button" onClick={() => void prepare()} disabled={busy || length === 0 || count === 0} data-testid="broadcast-prepare">
                送信内容を確認
              </button>
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>
                閉じる
              </button>
            </div>
          )}
          {preview && (
            <div className="line-preview" data-testid="broadcast-preview">
              <h5>一斉送信の確認</h5>
              <dl>
                <dt>送信元</dt>
                <dd>{preview.account.name}</dd>
                <dt>宛先</dt>
                <dd data-testid="broadcast-count">{preview.count} 人（通数として {preview.count} 通）</dd>
                <dt>今月の通数</dt>
                <dd data-testid="broadcast-month">
                  このアプリから {preview.monthUsed} 通{preview.monthlyLimit !== null ? `／上限 ${preview.monthlyLimit} 通` : ''}（送ると {preview.monthUsed + preview.count} 通）
                </dd>
                <dt>LINE 側の通数</dt>
                <dd data-testid="broadcast-line">
                  {preview.lineUsage === null ? '読み取れませんでした' : `${preview.lineUsage} 通${preview.lineLimit !== null ? `／上限 ${preview.lineLimit} 通` : ''}`}
                </dd>
                <dt>本文</dt>
                <dd>
                  <pre className="mail-text">{preview.body}</pre>
                </dd>
                {preview.image && (
                  <>
                    <dt>画像</dt>
                    <dd>
                      <img className="line-image-thumb" src={preview.image.previewUrl} alt="送る画像" />
                    </dd>
                  </>
                )}
                <dt>確認の期限</dt>
                <dd>{fmtDate(preview.expiresAt)}</dd>
              </dl>
              <details open={preview.count <= 20}>
                <summary>宛先の一覧（{preview.count} 人）</summary>
                <ul className="broadcast-list" data-testid="broadcast-recipients">
                  {preview.recipients.map((r) => (
                    <li key={r.conversationId}>
                      {r.title} <span className="hint">ID {r.maskedId}</span>
                    </li>
                  ))}
                </ul>
              </details>
              <p className="status warning">送るとすぐ相手の LINE に届き、取り消せません。</p>
              <ul className="notices">
                {preview.notices.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <label className="confirm-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} data-testid="broadcast-confirm" />
                上記の {preview.count} 人に、この内容で送ることを確認しました
              </label>
              <div className="actions">
                <button type="button" onClick={() => void send()} disabled={!confirmed || busy} data-testid="broadcast-send">
                  {busy ? '送信処理中…' : preview.mock ? `${preview.count} 人に模擬送信する` : `${preview.count} 人に LINE で送る`}
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={changed}>
                  確認をやめて編集に戻る
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="broadcast-message">
          {message.text}
        </p>
      )}
    </div>
  );
}
