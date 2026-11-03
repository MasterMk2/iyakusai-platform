import { useState, type FormEvent } from 'react';
import { addDays, DUE_SOON_DAYS, japaneseDay, jstDay, replyDueMin, type MessageDueView } from '../../shared/mailDue';
import { api, toFailure } from '../api';

// The deadlines of one mail (2026-11-03): 対応期限 (a response due, any received mail) and 回答期限 (a reply
// deadline, which makes the thread 返事待ち; only a mail the committee sent has one). Changing them needs the
// mailbox edit grant, as notes do; the server answers the rest read-only. A version the screen does not have is a
// conflict: the thread reloads, and the newer deadlines are shown (what was typed is not saved).

/** The line that says how a deadline stands today (text, not colour alone). */
export function dueNote(day: string | null, today: string, overdue: boolean): string | null {
  if (day === null) return null;
  if (overdue) return `${japaneseDay(day, today)}（期限を過ぎています）`;
  if (day <= addDays(today, DUE_SOON_DAYS)) return `${japaneseDay(day, today)}（期限が近い）`;
  return japaneseDay(day, today);
}

export function DueForm({ basePath, due, onSaved }: { basePath: string; due: MessageDueView; onSaved: () => void }) {
  const today = jstDay(new Date());
  const [base, setBase] = useState<MessageDueView>(due);
  const [responseDue, setResponseDue] = useState(due.responseDue ?? '');
  const [replyDue, setReplyDue] = useState(due.replyWait?.dueOn ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A reload brought a newer version (another person saved, or a reply cleared the wait): adopt it. The typed
  // values stay unless the save was refused as a conflict, when the newer values are shown.
  const [seenVersion, setSeenVersion] = useState(due.version);
  if (due.version !== seenVersion) {
    setSeenVersion(due.version);
    if (due.version > base.version) {
      setBase(due);
      if (conflict || (responseDue === (base.responseDue ?? '') && replyDue === (base.replyWait?.dueOn ?? ''))) {
        setResponseDue(due.responseDue ?? '');
        setReplyDue(due.replyWait?.dueOn ?? '');
      }
      setConflict(false);
    }
  }

  const dirty = responseDue !== (base.responseDue ?? '') || replyDue !== (base.replyWait?.dueOn ?? '');

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    setConflict(false);
    setSaved(false);
    const body: { expectedVersion: number; responseDue?: string | null; replyDue?: string | null } = { expectedVersion: base.version };
    if ((responseDue || null) !== base.responseDue) body.responseDue = responseDue || null;
    if ((replyDue || null) !== (base.replyWait?.dueOn ?? null)) body.replyDue = replyDue || null;
    try {
      const next = await api<MessageDueView>('PATCH', `${basePath}/due`, body);
      setBase(next);
      setResponseDue(next.responseDue ?? '');
      setReplyDue(next.replyWait?.dueOn ?? '');
      setSeenVersion(next.version);
      setSaved(true);
      onSaved();
    } catch (err) {
      const failure = toFailure(err);
      if (failure.status === 409) {
        setConflict(true);
        onSaved();
      } else {
        setError(failure.message);
      }
    } finally {
      setSaving(false);
    }
  }

  // Without the edit grant the screen only reads: the deadlines that exist are shown, and nothing when there are none.
  if (!due.canEdit) {
    if (base.responseDue === null && base.replyWait === null) return null;
    return (
      <section className="due-panel" aria-label="期限">
        <h4>期限</h4>
        {base.responseDue !== null && <p>対応期限：{dueNote(base.responseDue, today, base.responseOverdue) ?? ''}</p>}
        {base.replyWait && (
          <p>
            返事待ち：{japaneseDay(base.replyWait.dueOn, today)}まで（
            {base.replyWait.overdue ? '回答期限を過ぎています。電話など別の方法で、届いているかを確かめることを考えてください' : '相手の返信を待っています'}）
          </p>
        )}
        <p className="hint">期限の付与と変更は、この受信箱の編集権限が要ります。</p>
      </section>
    );
  }

  return (
    <section className="due-panel" aria-label="期限">
      <h4>期限</h4>
      {base.replyWait?.overdue && (
        <p className="status warning" role="status">
          回答期限を過ぎています。電話など別の方法で、相手に届いているかを確かめることを考えてください。
        </p>
      )}
      <form className="due-form" onSubmit={(e) => void save(e)} aria-label="期限の編集">
        <div className="triage-row">
          <label className="triage-field">
            対応期限
            <input type="date" value={responseDue} onChange={(e) => setResponseDue(e.target.value)} disabled={saving} />
          </label>
          {/* Only a mail the committee sent can wait for a reply. A wait already set stays visible, so it can be removed. */}
          {(base.replyWaitAllowed || base.replyWait !== null) && (
            <label className="triage-field">
              回答期限
              <input type="date" min={replyDueMin(today, base.replyWait?.dueOn ?? null, replyDue)} value={replyDue} onChange={(e) => setReplyDue(e.target.value)} disabled={saving} />
            </label>
          )}
        </div>
        {base.replyWaitAllowed && <p className="hint">回答期限は、このメールを送ったときに付きます。ここでも付け直せます。相手の返信が届くと、返事待ちは自動で外れます。</p>}
        {conflict && (
          <div className="status conflict" role="alert">
            他の利用者が先に更新したため保存しませんでした。最新の期限を表示しています。
          </div>
        )}
        {error && (
          <div className="status error" role="alert">
            保存できませんでした: {error}
          </div>
        )}
        {saved && !dirty && <p className="status ok" role="status">保存しました。</p>}
        <div className={`actions triage-actions ${dirty || saving ? '' : 'idle'}`}>
          <span className="draft-indicator" aria-live="polite">{dirty ? '未保存の期限があります' : ''}</span>
          <button type="submit" disabled={saving || !dirty}>
            {saving ? '保存中…' : '期限を保存'}
          </button>
          <button
            type="button"
            className="quiet"
            disabled={saving || !dirty}
            onClick={() => {
              setResponseDue(base.responseDue ?? '');
              setReplyDue(base.replyWait?.dueOn ?? '');
              setError(null);
            }}
          >
            変更を取り消す
          </button>
        </div>
      </form>
    </section>
  );
}
