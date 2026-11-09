import { useCallback, useRef, useState } from 'react';
import { LINE_LIMITS, type BroadcastOptionsResponse, type BroadcastPreviewResponse, type BroadcastSendResponse } from '../../shared/line';
import { composeLineReviewRequest } from '../../shared/lineReview';
import { screenLine } from '../../shared/lineScreen';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { BotReview } from './BotReview';
import { LineImagePicker, type PickedImage } from './LineImagePicker';
import { LineRecipientField } from './LineRecipientField';
import { LineScreenChecks } from './LineScreenChecks';
import { LoadStatus } from './LoadStatus';

/**
 * Sending from the official account (broadcast 2026-11-02; the form shaped like the mail one 2026-11-09): the same
 * text (and one image) to the 1:1 conversations picked in 宛先, or to everyone it can be sent to. Write → check
 * what will be sent (the server confirms the exact list, this month's count and LINE's own count; the fixed checks
 * run on that text) → tick → send once. The Bot can proofread it below. Each conversation shows its own record.
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
  const [selected, setSelected] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [image, setImage] = useState<PickedImage | null>(null);
  const [preview, setPreview] = useState<BroadcastPreviewResponse | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'to' | 'body', string>>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const sending = useRef(false);

  const o = options.data;
  const count = all ? (o?.recipients.length ?? 0) : selected.length;
  const length = body.trim().length;
  const friendOf = new Map((o?.recipients ?? []).map((r) => [r.conversationId, r.friend]));

  function changed() {
    setPreview(null);
    setOperationId(null);
    setConfirmed(false);
  }

  function check(): boolean {
    const next: typeof errors = {};
    if (count === 0) next.to = '宛先を選んでください。名前を入れて候補から選ぶか、「一覧から選ぶ」から選びます。';
    if (length === 0) next.body = '本文を入力してください。';
    else if (length > LINE_LIMITS.replyMaxLength) next.body = `本文は ${LINE_LIMITS.replyMaxLength.toLocaleString('ja-JP')} 文字以内にしてください（いま ${length.toLocaleString('ja-JP')} 文字）。`;
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function prepare() {
    if (!check()) return;
    setBusy(true);
    setMessage(null);
    try {
      const p = await api<BroadcastPreviewResponse>('POST', `/api/line/accounts/${encodeURIComponent(accountId)}/broadcast/preview`, {
        recipients: all ? 'all' : selected,
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
      changed();
      setBody('');
      setImage(null);
      setSelected([]);
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

  const findings = preview ? screenLine({ body: preview.body, recipients: preview.recipients.map((r) => ({ title: r.title, friend: friendOf.get(r.conversationId) })), hasImage: !!preview.image }) : [];
  const warnings = findings.filter((f) => f.level === 'warning').length;
  const field = (name: keyof typeof errors) => (errors[name] ? { 'aria-invalid': true as const, 'aria-describedby': `line-send-${name}-error` } : {});
  const errorOf = (name: keyof typeof errors) =>
    errors[name] ? (
      <p className="field-error" id={`line-send-${name}-error`}>
        {errors[name]}
      </p>
    ) : null;

  return (
    <section className="mail-compose line-compose" aria-labelledby="line-send-title" data-testid="line-broadcast">
      <div className="compose-head">
        <div>
          <h3 id="line-send-title">
            公式LINEを送信 <span className="source-badge source-line">LINE</span>
          </h3>
          <p className="hint compose-sub">公式アカウントから、選んだ相手に 1 人ずつ送ります（1 人でも複数でも）。送ったものは、それぞれの会話に送信記録として残ります。</p>
        </div>
        <button type="button" className="quiet" onClick={onClose} disabled={busy}>
          閉じる
        </button>
      </div>
      <LoadStatus loader={options} what="公式LINE の宛先" />
      {o?.mock && <p className="status info">模擬モードです。実際の LINE には送信されません。</p>}
      {o &&
        (!preview ? (
          <form
            className="compose-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void prepare();
            }}
          >
            <span className="compose-label">送信元</span>
            <p className="compose-static" data-testid="line-send-account">
              {o.account.name}
            </p>
            <label htmlFor="line-send-to">宛先</label>
            <LineRecipientField
              id="line-send-to"
              recipients={o.recipients}
              selected={selected}
              onSelected={(ids) => {
                setSelected(ids);
                changed();
              }}
              all={all}
              onAll={(next) => {
                setAll(next);
                changed();
              }}
              disabled={busy}
              invalid={!!errors.to}
              describedBy={errors.to ? 'line-send-to-error' : 'line-send-to-hint'}
              below={
                <>
                  <p className="field-hint" id="line-send-to-hint">
                    名前の一部を入れると候補が出ます。宛先にできるのは、利用者 ID が分かっていて友だち解除・ブロックされていない 1:1 の相手です。
                  </p>
                  {errorOf('to')}
                </>
              }
            />
            <label htmlFor="line-send-body">本文</label>
            <textarea
              id="line-send-body"
              rows={10}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                changed();
              }}
              disabled={busy}
              {...field('body')}
              data-testid="line-send-body"
            />
            <span className={`counter ${length > LINE_LIMITS.replyMaxLength ? 'over' : ''}`}>
              {length} / {LINE_LIMITS.replyMaxLength}
            </span>
            {errorOf('body')}
            <div className="compose-files">
              <span className="compose-files-label">画像（任意）</span>
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
            </div>
            <p className="hint">
              月の通数は 1 人 1 通ずつ数えます（今月このアプリから {o.monthUsed} 通{o.monthlyLimit !== null ? `／上限 ${o.monthlyLimit} 通` : ''}）。
            </p>
            <div className="actions">
              <button type="submit" disabled={busy} data-testid="broadcast-prepare">
                {busy ? '確かめています…' : '送信内容を確認'}
              </button>
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>
                やめる
              </button>
            </div>
          </form>
        ) : (
          <div className="compose-preview" data-testid="broadcast-preview">
            <h4>送信内容の確認</h4>
            <dl>
              <dt>送信元</dt>
              <dd>{preview.account.name}</dd>
              <dt>宛先</dt>
              <dd data-testid="broadcast-count">
                {preview.count} 人（通数として {preview.count} 通）
                {preview.count <= 5 && <span className="hint">：{preview.recipients.map((r) => r.title).join('、')}</span>}
              </dd>
              <dt>今月</dt>
              <dd data-testid="broadcast-month">
                このアプリから {preview.monthUsed} 通{preview.monthlyLimit !== null ? `／上限 ${preview.monthlyLimit} 通` : ''}（送ると {preview.monthUsed + preview.count} 通）
              </dd>
              <dt>LINE 側</dt>
              <dd data-testid="broadcast-line">
                {preview.lineUsage === null ? '読み取れませんでした' : `${preview.lineUsage} 通${preview.lineLimit !== null ? `／上限 ${preview.lineLimit} 通` : ''}`}
              </dd>
              {preview.image && (
                <>
                  <dt>画像</dt>
                  <dd>
                    <img className="line-image-thumb" src={preview.image.previewUrl} alt="送る画像" />
                  </dd>
                </>
              )}
              <dt>期限</dt>
              <dd>この確認は {fmtDate(preview.expiresAt)} まで有効です</dd>
            </dl>
            {preview.count > 5 && (
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
            )}
            <pre className="mail-text compose-preview-body" data-testid="broadcast-body">
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
            <p className="status warning">送るとすぐ相手の LINE に届き、取り消せません。</p>
            <label className="confirm-check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} data-testid="broadcast-confirm" />
              {warnings > 0 ? `注意 ${warnings} 件を確かめたうえで、` : ''}上記の {preview.count} 人に、この内容で送ります
            </label>
            <div className="actions">
              <button type="button" onClick={() => void send()} disabled={!confirmed || busy} data-testid="broadcast-send">
                {busy ? '送信しています…' : preview.mock ? `${preview.count} 人に模擬送信する` : `${preview.count} 人に LINE で送る`}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={changed}>
                編集に戻る
              </button>
            </div>
          </div>
        ))}
      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="broadcast-message">
          {message.text}
        </p>
      )}
      {o && (
        <BotReview
          request={composeLineReviewRequest({ accountName: o.account.name, audience: audienceOf(count), body })}
          empty={length === 0}
          intro="誤字・敬語、日付・曜日・金額・名称などを委員会の資料と照らした食い違い、LINE での読みやすさを Bot（AI）が確かめます。送信元の名前・相手の人数・本文が Bot に渡ります。相手の名前と LINE の ID は渡しません。"
          changedWhat="本文か宛先の人数"
          testId="line-review"
        />
      )}
    </section>
  );
}

/** Whom it goes to, without names (for the Bot). */
function audienceOf(count: number): string {
  if (count === 0) return '未定（1:1 の相手に 1 人ずつ送る）';
  return count === 1 ? '1:1 の相手 1 人' : `1:1 の相手 ${count} 人（同じ文を 1 人ずつ送る）`;
}
