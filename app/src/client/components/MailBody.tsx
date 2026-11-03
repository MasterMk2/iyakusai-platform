import { useCallback, useState } from 'react';
import type { ReceiptImagesView, ReceiptView } from '../../shared/api';
import { api } from '../api';
import { useLoader } from '../useLoader';

// Layers 2–4 of the HTML defence (layer 1 is the server-side sanitizer):
// - sandbox="" iframe: no scripts, forms, popups, top navigation or same-origin access;
// - a CSP inside the document blocks every fetch (default-src 'none'); images only as data: URIs the server built
//   from bytes it checked (the mail's own images, and those on other servers when the reader asks);
// - no-referrer and the page-wide CSP inherited by srcdoc documents.
// Links are inert text spans; their URL is shown as text via CSS, never followed.
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";

const FRAME_STYLE = `
body { font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2933; margin: 8px; overflow-wrap: anywhere; }
.mail-link { color: #1d4ed8; text-decoration: underline dotted; }
.mail-link::after { content: " ‹" attr(data-href) "›"; color: #52606d; font-size: 12px; }
img { max-width: 100%; height: auto; }
.blocked-image::before { content: "［画像をブロックしました］"; color: #9a3412; font-size: 12px; border: 1px dashed #fdba74; padding: 0 4px; }
table { border-collapse: collapse; } td, th { border: 1px solid #cbd2d9; padding: 2px 6px; }
`;

export function buildSrcDoc(sanitizedHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="referrer" content="no-referrer"><style>${FRAME_STYLE}</style></head><body>${sanitizedHtml}</body></html>`;
}

export function MailBody({ receipt }: { receipt: ReceiptView }) {
  const [mode, setMode] = useState<'html' | 'text'>(receipt.sanitizedHtml ? 'html' : 'text');
  const inline = receipt.inlineImages ?? 0;
  const remote = receipt.remoteImages ?? 0;
  // The mail's own images (cid:) are shown at once: nothing outside the app is contacted. Those on other servers
  // only after the reader asks, for this mail.
  const [remoteFor, setRemoteFor] = useState<string | null>(null);
  const withRemote = remoteFor === receipt.receiptId;
  const { receiptId } = receipt;
  const fetchImages = useCallback(
    async (signal: AbortSignal) =>
      inline > 0 || withRemote ? { receiptId, view: await api<ReceiptImagesView>('GET', `/api/receipts/${receiptId}/images${withRemote ? '?remote=1' : ''}`, undefined, signal) } : null,
    [receiptId, inline, withRemote],
  );
  const loader = useLoader(fetchImages);
  const images = loader.data?.receiptId === receiptId ? loader.data.view : null;
  const html = images?.sanitizedHtml ?? receipt.sanitizedHtml;
  return (
    <div className="mail-body">
      {receipt.hasHtml && (
        <div className="body-toggle" role="group" aria-label="本文の表示方法">
          <button type="button" className={mode === 'html' ? 'active' : 'secondary'} aria-pressed={mode === 'html'} onClick={() => setMode('html')}>
            安全化した HTML
          </button>
          <button type="button" className={mode === 'text' ? 'active' : 'secondary'} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
            テキスト表示
          </button>
        </div>
      )}
      {mode === 'html' && html !== null ? (
        <>
          {receipt.remoteImages === undefined ? (
            <p className="hint safety-note">
              HTML はスクリプト・フォーム・イベントを除去し、隔離した枠内に表示しています。外部画像などは読み込みません
              {receipt.blockedRemoteResources > 0 ? `（${receipt.blockedRemoteResources} 件をブロック）` : ''}
              。リンクは自動で開かず、URL を文字で表示します。
            </p>
          ) : (
            <div className="hint safety-note mail-images">
              <p>HTML はスクリプト・フォーム・イベントを除去し、隔離した枠内に表示しています。リンクは自動で開かず、URL を文字で表示します。</p>
              {images?.remote ? (
                <p>外部の画像はアプリのサーバーが取得して表示しています（送り主に、このメールが開かれたことが伝わる場合があります）。</p>
              ) : remote > 0 ? (
                <p>
                  {inline > 0 ? 'メールに含まれる画像は表示しています。' : ''}外部の画像（{remote} 件）は読み込んでいません。
                  <button type="button" className="secondary" disabled={withRemote && loader.loading} onClick={() => setRemoteFor(receiptId)}>
                    {withRemote && loader.loading ? '読み込み中…' : '外部の画像を表示'}
                  </button>
                </p>
              ) : null}
              {images && images.failed > 0 && <p>表示できなかった画像が {images.failed} 件あります（見つからない・画像でない・大きすぎる・取得できない）。</p>}
              {loader.error && (
                <p role="alert">
                  画像を読み込めませんでした: {loader.error.message}
                  <button type="button" className="secondary" onClick={loader.retry}>
                    再試行
                  </button>
                </p>
              )}
            </div>
          )}
          <iframe
            className="html-frame"
            title={`メール本文（安全化 HTML）: ${receipt.subject}`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={buildSrcDoc(html)}
          />
        </>
      ) : (
        <pre className="mail-text" data-testid="mail-text">
          {receipt.text || '（本文なし）'}
        </pre>
      )}
    </div>
  );
}
