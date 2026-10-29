import { useState, type FormEvent } from 'react';
import { LIMITS, type NoteView } from '../../shared/api';
import { api, fmtDate, toFailure } from '../api';

const HEADING = '内部メモ（この受信箱の閲覧者だけに表示・外部には送信されません）';

/** `basePath` is the item's API path, e.g. `/api/receipts/<id>` or `/api/line/conversations/<id>`. */
export function Notes({ basePath, notes, canEdit, onAdded, heading = HEADING, description }: { basePath: string; notes: NoteView[]; canEdit: boolean; onAdded: () => void; heading?: string; description?: string }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<{ text: string; retryable: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  // Notes added here, shown at once until the reloaded item includes them (2026-10-26: a new note seemed lost
  // until the reload). Kept per item, since the same component may show another item next.
  const [added, setAdded] = useState<{ basePath: string; notes: NoteView[] }>({ basePath, notes: [] });
  const shown = [...notes, ...(added.basePath === basePath ? added.notes : []).filter((a) => !notes.some((n) => n.id === a.id))];

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text) {
      setError({ text: 'メモを入力してください。', retryable: false });
      return;
    }
    if (text.length > LIMITS.noteMaxLength) {
      setError({ text: `メモは ${LIMITS.noteMaxLength} 文字以内で入力してください。`, retryable: false });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const note = await api<NoteView>('POST', `${basePath}/notes`, { body: text });
      setAdded((a) => ({ basePath, notes: [...(a.basePath === basePath ? a.notes : []), note] }));
      setBody('');
      onAdded();
    } catch (err) {
      const failure = toFailure(err);
      // Keep the typed text so the user can retry.
      setError({ text: failure.message, retryable: failure.status === 0 || failure.status >= 500 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="notes">
      <h4>{heading}</h4>
      {description && <p className="hint">{description}</p>}
      {description && !canEdit && <p className="hint">メモの追加には、受信箱の編集権限が必要です。</p>}
      {shown.length === 0 && <p className="empty">メモはまだありません。</p>}
      <ul>
        {shown.map((n) => (
          <li key={n.id} className="note">
            <span className="note-meta">
              {n.authorName} ・ {fmtDate(n.createdAt)}
            </span>
            <span className="note-body">{n.body}</span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <form onSubmit={(e) => void submit(e)} aria-label="内部メモの追加">
          <textarea aria-label="内部メモ" value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="内部メモを入力" />
          <span className={`counter ${body.trim().length > LIMITS.noteMaxLength ? 'over' : ''}`}>
            {body.trim().length} / {LIMITS.noteMaxLength}
          </span>
          {error && (
            <div className="status error" role="alert">
              メモを追加できませんでした: {error.text}
              {error.retryable && (
                <button type="button" onClick={() => void submit()} disabled={saving}>
                  再試行
                </button>
              )}
            </div>
          )}
          <button type="submit" disabled={saving}>
            {saving ? '追加中…' : 'メモを追加'}
          </button>
        </form>
      )}
    </div>
  );
}
