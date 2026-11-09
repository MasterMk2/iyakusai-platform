import { useRef, useState } from 'react';
import { LINE_ATTACH_LIMITS, LINE_LIMITS, type LineConversationDetail, type LineDraftView, type LinePreviewResponse, type LinePublicDays, type LineSendResponse } from '../../shared/line';
import { composeLineReviewRequest } from '../../shared/lineReview';
import { screenLine } from '../../shared/lineScreen';
import { lineOwnText } from '../../shared/signature';
import { api, fmtDate, toFailure } from '../api';
import { BotReview } from './BotReview';
import { LineAttachPicker, PreviewAttachments, type PickedFile } from './LineAttachPicker';
import type { PickedImage } from './LineImagePicker';
import { LineScreenChecks } from './LineScreenChecks';
import { useLineSignature } from './useLineSignature';

/**
 * Manual reply, shaped like the mail reply (2026-11-09): write → check what will be sent (the draft is saved, the
 * server returns the exact text with a short-lived confirmation; the fixed checks run on that text) → tick → one
 * send per confirmation. The form is hidden while checking ("編集に戻る" brings it back), and the send button is
 * disabled while a request is in flight. The Bot can proofread it below.
 */
export function LineReplyPanel({ detail, onSent }: { detail: LineConversationDetail; onSent: () => void }) {
  const [saved, setSaved] = useState<LineDraftView | null>(detail.reply.draft);
  const [body, setBody] = useState(detail.reply.draft?.body ?? '');
  const draft0 = detail.reply.draft;
  // A draft saved before 2026-11-10 names one image (imageId); newer ones list them.
  const initialImages: PickedImage[] = draft0?.images
    ? draft0.images.map((i) => ({ ...i, expiresAt: '' }))
    : draft0?.imageId && draft0.imagePreviewUrl
      ? [{ id: draft0.imageId, previewUrl: draft0.imagePreviewUrl, expiresAt: '' }]
      : [];
  const [images, setImages] = useState<PickedImage[]>(initialImages);
  const [files, setFiles] = useState<PickedFile[]>(draft0?.files ?? []);
  const [publicDays, setPublicDays] = useState<LinePublicDays>(LINE_ATTACH_LIMITS.defaultPublicDays);
  const [preview, setPreview] = useState<LinePreviewResponse | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const sending = useRef(false);
  const mock = detail.sending !== 'live';
  const title = mock ? 'LINE で返信（模擬送信）' : 'LINE で返信';
  // The committee's short signature at the end (2026-11-10): put in once it is known, unless a saved draft or typing
  // came first. A body with the signature alone counts as empty.
  const signature = useLineSignature();
  const [signed, setSigned] = useState(!!detail.reply.draft);
  if (signature && !signed) {
    setSigned(true);
    if (body === '') setBody(`\n\n${signature}`);
  }
  const fresh = () => (signature ? `\n\n${signature}` : '');

  if (!detail.reply.available) {
    return (
      <section className="mail-compose line-compose line-reply" aria-label="LINE で返信">
        <h3 className="line-reply-title">LINE で返信</h3>
        <p className="status info" data-testid="line-reply-unavailable">
          {detail.reply.reason ?? 'この会話には返信できません。'}
        </p>
      </section>
    );
  }

  function discardPreview() {
    setPreview(null);
    setOperationId(null);
    setConfirmed(false);
  }

  async function prepare() {
    const length = body.trim().length;
    if (lineOwnText(body, signature).length === 0) return setError('本文を入力してください。');
    if (length > LINE_LIMITS.replyMaxLength) return setError(`本文は ${LINE_LIMITS.replyMaxLength.toLocaleString('ja-JP')} 文字以内にしてください（いま ${length.toLocaleString('ja-JP')} 文字）。`);
    setError(null);
    setBusy(true);
    setMessage(null);
    try {
      let draft = saved;
      const imageIds = images.map((i) => i.id);
      const fileIds = files.map((f) => f.id);
      const savedImages = saved?.images?.map((i) => i.id) ?? (saved?.imageId ? [saved.imageId] : []);
      const savedFiles = saved?.files?.map((f) => f.id) ?? [];
      if (!draft || draft.body !== body.trim() || savedImages.join() !== imageIds.join() || savedFiles.join() !== fileIds.join()) {
        draft = await api<LineDraftView>('PUT', `/api/line/conversations/${detail.conversationId}/reply/draft`, {
          body,
          expectedVersion: saved?.version ?? null,
          ...(detail.reply.imagesEnabled || imageIds.length > 0 ? { imageIds } : {}),
          ...(detail.reply.filesEnabled || fileIds.length > 0 ? { fileIds } : {}),
        });
        setSaved(draft);
        setBody(draft.body);
      }
      const p = await api<LinePreviewResponse>('POST', `/api/line/conversations/${detail.conversationId}/reply/preview`, { draftId: draft.id, draftVersion: draft.version, publicDays });
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
      discardPreview();
      setSaved(null);
      setBody(fresh());
      setImages([]);
      setFiles([]);
      setMessage({ kind: 'ok', text: `${res.outbox.mock ? '模擬送信の結果' : '送信の結果'}: ${res.outbox.statusLabel}。${res.outbox.statusNote}` });
      onSent();
    } catch (err) {
      const failure = toFailure(err);
      if (failure.status !== 0 && failure.status < 500) discardPreview();
      setMessage({ kind: 'error', text: failure.message });
      onSent();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const length = body.trim().length;
  const target = detail.target;
  const people = target.type === 'user' ? null : target.memberCount;
  const targetText = `${detail.title}（${target.typeLabel}${people ? `・${people} 人` : ''}${target.maskedId ? `・ID ${target.maskedId}` : ''}）`;
  // One conversation: a name or a greeting in it is meant (in a group, calling one member by name is ordinary).
  const findings = preview ? screenLine({ body: preview.body, recipients: [{ title: detail.title }], attached: (preview.images?.length ?? 0) + (preview.files?.length ?? 0) > 0 }) : [];
  const warnings = findings.filter((f) => f.level === 'warning').length;
  const audience = target.type === 'user' ? '1:1 の相手 1 人' : `${target.typeLabel}${people ? `（${people} 人）` : ''}の全員`;

  return (
    <section className="mail-compose line-compose line-reply" aria-labelledby="line-reply-title">
      <div className="compose-head">
        <div>
          <h3 id="line-reply-title">{title}</h3>
          <p className="hint compose-sub">この会話の相手に、公式アカウントから手動で送ります（自動返信はしません。複数の相手には「公式LINE」タブの「公式LINEを送信」から）。</p>
        </div>
      </div>
      {!preview ? (
        <form
          className="compose-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void prepare();
          }}
        >
          <span className="compose-label">送信先</span>
          <p className="compose-static" data-testid="line-reply-target">
            {targetText}
          </p>
          <label htmlFor="line-reply-body">本文</label>
          <textarea
            id="line-reply-body"
            rows={6}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setError(null);
            }}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'line-reply-body-error' : undefined}
            data-testid="line-reply-body"
          />
          <span className={`counter ${length > LINE_LIMITS.replyMaxLength ? 'over' : ''}`}>
            {length} / {LINE_LIMITS.replyMaxLength}
          </span>
          {error && (
            <p className="field-error" id="line-reply-body-error">
              {error}
            </p>
          )}
          {(detail.reply.imagesEnabled || detail.sending === 'live') && (
            <LineAttachPicker
              accountId={detail.account.id}
              images={images}
              onImages={setImages}
              files={files}
              onFiles={setFiles}
              publicDays={publicDays}
              onPublicDays={setPublicDays}
              imagesEnabled={detail.reply.imagesEnabled === true}
              filesEnabled={detail.reply.filesEnabled === true}
              disabled={busy}
            />
          )}
          <div className="actions">
            <button type="submit" disabled={busy} data-testid="line-reply-prepare">
              {busy ? '確かめています…' : '送信内容を確認'}
            </button>
          </div>
          <p className="field-hint">「送信内容を確認」を押すと、本文は下書きとして保存されます（送るまでは相手に届きません）。</p>
        </form>
      ) : (
        <div className="compose-preview" data-testid="line-reply-preview">
          <h4>送信内容の確認</h4>
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
            <PreviewAttachments images={preview.images ?? (preview.image ? [preview.image] : [])} files={preview.files ?? []} publicUntil={preview.publicUntil ?? null} />
            <dt>期限</dt>
            <dd>この確認は {fmtDate(preview.expiresAt)} まで有効です</dd>
          </dl>
          <pre className="mail-text compose-preview-body" data-testid="preview-body">
            {preview.body}
          </pre>
          <LineScreenChecks findings={findings} />
          {preview.notices.length > 0 && (
            <ul className="notices">
              {preview.notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <label className="confirm-check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} data-testid="line-reply-confirm" />
            {warnings > 0 ? `注意 ${warnings} 件を確かめたうえで、` : ''}この送信先と内容で送ります
          </label>
          <div className="actions">
            <button type="button" onClick={() => void send()} disabled={!confirmed || busy} data-testid="line-reply-send">
              {busy ? '送信しています…' : preview.mock ? '模擬送信する' : 'LINE で送信する'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={discardPreview}>
              編集に戻る
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="line-reply-message">
          {message.text}
        </p>
      )}
      <BotReview
        request={composeLineReviewRequest({ accountName: detail.account.name, audience, body })}
        empty={lineOwnText(body, signature).length === 0}
        intro="誤字・敬語、日付・曜日・金額・名称などを委員会の資料と照らした食い違い、LINE での読みやすさを Bot（AI）が確かめます。送信元の名前・相手の種類と人数・本文が Bot に渡ります。相手の名前と LINE の ID は渡しません。"
        changedWhat="本文"
        testId="line-review"
      />
    </section>
  );
}
