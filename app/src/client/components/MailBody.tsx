import { useState } from 'react';
import type { ReceiptView } from '../../shared/api';

// Layers 2–4 of the HTML defence (layer 1 is the server-side sanitizer):
// - sandbox="" iframe: no scripts, forms, popups, top navigation or same-origin access;
// - a CSP inside the document blocks every fetch (default-src 'none', img-src 'none');
// - no-referrer and the page-wide CSP inherited by srcdoc documents.
// Links are inert text spans; their URL is shown as text via CSS, never followed.
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";

const FRAME_STYLE = `
body { font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2933; margin: 8px; overflow-wrap: anywhere; }
.mail-link { color: #1d4ed8; text-decoration: underline dotted; }
.mail-link::after { content: " ‹" attr(data-href) "›"; color: #52606d; font-size: 12px; }
.blocked-image::before { content: "［画像をブロックしました］"; color: #9a3412; font-size: 12px; border: 1px dashed #fdba74; padding: 0 4px; }
table { border-collapse: collapse; } td, th { border: 1px solid #cbd2d9; padding: 2px 6px; }
`;

export function buildSrcDoc(sanitizedHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="referrer" content="no-referrer"><style>${FRAME_STYLE}</style></head><body>${sanitizedHtml}</body></html>`;
}

export function MailBody({ receipt }: { receipt: ReceiptView }) {
  const [mode, setMode] = useState<'html' | 'text'>(receipt.sanitizedHtml ? 'html' : 'text');
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
      {mode === 'html' && receipt.sanitizedHtml !== null ? (
        <>
          <p className="hint safety-note">
            HTML はスクリプト・フォーム・イベントを除去し、隔離した枠内に表示しています。外部画像などは読み込みません
            {receipt.blockedRemoteResources > 0 ? `（${receipt.blockedRemoteResources} 件をブロック）` : ''}
            。リンクは自動で開かず、URL を文字で表示します。
          </p>
          <iframe
            className="html-frame"
            title={`メール本文（安全化 HTML）: ${receipt.subject}`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={buildSrcDoc(receipt.sanitizedHtml)}
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
