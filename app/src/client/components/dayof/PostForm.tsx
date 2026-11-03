import { useId, useRef, useState, type FormEvent } from 'react';
import { DAYOF_LIMITS, DAYOF_PRIORITIES, DAYOF_PRIORITY_LABELS, dayofEditDrift, type DayOfPostInput, type DayOfPostView, type DayOfPriority } from '../../../shared/dayof';
import { toFailure } from '../../api';
import { newOperationId } from '../tasks/common';
import { dayofApi } from './dayofApi';

/**
 * Writing a notice (or correcting one). Few fields on purpose: the text and the level are what matter on the day; the
 * place, the departments and whether temporary staff see it are optional. A new notice carries a token per content,
 * so sending the same text again after a lost answer does not post it twice.
 *
 * A correction is saved against the version the person began from, not the one the 30-second refresh brings, so a
 * correction someone else saved meanwhile is refused (409) instead of being overwritten. When the refresh shows that
 * the notice moved on, the form says so next to what it now says, keeps what the person typed, and lets them choose:
 * take the current text, or save theirs over it on purpose. A notice resolved or withdrawn meanwhile cannot be saved.
 */
export function PostForm({
  departments,
  editing,
  latest,
  onSaved,
  onCancel,
  onStale,
}: {
  departments: string[];
  /** The notice being corrected, as it was when the person began; absent for a new one. */
  editing?: DayOfPostView;
  /** The same notice as the board has it now (null: no longer on the board). */
  latest?: DayOfPostView | null;
  onSaved: (post: DayOfPostView, message: string) => void;
  onCancel: () => void;
  /** A save was refused as out of date: read the board again so the form can show what changed. */
  onStale?: () => void;
}) {
  const id = useId();
  // The version this correction is based on: fixed when the form opens, moved on only by the person's choice below.
  const [baseVersion, setBaseVersion] = useState(editing?.version ?? 0);
  const [body, setBody] = useState(editing?.body ?? '');
  const [priority, setPriority] = useState<DayOfPriority>(editing?.priority ?? 'normal');
  const [place, setPlace] = useState(editing?.place ?? '');
  const [picked, setPicked] = useState<string[]>(editing?.departments ?? []);
  const [staffVisible, setStaffVisible] = useState(editing?.staffVisible ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last save was refused as out of date; once the refresh shows what changed, the box above says it instead.
  const [stale, setStale] = useState(false);
  const sent = useRef<{ key: string; token: string } | null>(null);

  const options = [...departments, ...picked.filter((d) => !departments.includes(d))];
  const length = [...body.trim()].length;
  const drift = editing ? dayofEditDrift(baseVersion, latest ?? null) : ({ kind: 'none' } as const);

  function takeLatest(post: DayOfPostView) {
    setBody(post.body);
    setPriority(post.priority);
    setPlace(post.place);
    setPicked(post.departments);
    setStaffVisible(post.staffVisible);
    setBaseVersion(post.version);
    setError(null);
    setStale(false);
  }

  async function submit(e: FormEvent | null, version = baseVersion) {
    e?.preventDefault();
    if (busy) return;
    const input: DayOfPostInput = { body: body.trim(), priority, place: place.trim(), departments: picked, staffVisible };
    if (!input.body) {
      setError('連絡の本文を入れてください。');
      return;
    }
    if (length > DAYOF_LIMITS.body) {
      setError(`本文は ${DAYOF_LIMITS.body} 字までにしてください。`);
      return;
    }
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      if (editing) {
        const saved = await dayofApi.update(editing.id, input, version);
        onSaved(saved.post, '連絡を直しました。');
      } else {
        const key = JSON.stringify(input);
        if (sent.current?.key !== key) sent.current = { key, token: newOperationId() };
        const saved = await dayofApi.create(input, sent.current.token);
        onSaved(saved.post, priority === 'urgent' ? '至急の連絡を流しました。' : '連絡を流しました。');
      }
    } catch (err) {
      const failure = toFailure(err);
      setError(failure.message);
      if (editing && failure.status === 409) {
        setStale(true);
        onStale?.();
      }
    } finally {
      setBusy(false);
    }
  }

  const toggle = (d: string) => setPicked((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]));

  return (
    <form className="dayof-form" onSubmit={(e) => void submit(e)} aria-label={editing ? '連絡を直す' : '連絡を書く'} data-testid="dayof-post-form">
      {drift.kind === 'changed' && (
        <div className="dayof-drift" role="status" data-testid="dayof-edit-drift">
          <p>
            <strong>直しているあいだに、ほかの人がこの連絡を変更しました。</strong>いまの内容と比べて、入れ替えるか、自分の文で上書きするかを選んでください。あなたが書いた文は下に残っています。
          </p>
          <p className="hint">
            いまの内容（{DAYOF_PRIORITY_LABELS[drift.latest.priority]}
            {drift.latest.place && `・${drift.latest.place}`}）：
          </p>
          <p className="dayof-drift-body">{drift.latest.body}</p>
          <div className="dayof-form-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => takeLatest(drift.latest)}>
              いまの内容に入れ替える
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void submit(null, drift.latest.version)} data-testid="dayof-edit-overwrite">
              自分の文で上書きして保存
            </button>
          </div>
        </div>
      )}
      {drift.kind === 'closed' && (
        <div className="dayof-drift" role="status" data-testid="dayof-edit-closed">
          <p>
            <strong>
              {drift.status === 'resolved' ? '直しているあいだに、ほかの人がこの連絡を済にしました。' : drift.status === 'withdrawn' ? '直しているあいだに、この連絡は取り下げられました。' : 'この連絡は当日の欄から外れました。'}
            </strong>
            この連絡はもう直せません。あなたが書いた文は下に残っています。必要なら写してから「やめる」を押してください。
          </p>
        </div>
      )}
      <label htmlFor={`${id}-body`}>連絡の本文</label>
      <textarea id={`${id}-body`} value={body} rows={3} maxLength={DAYOF_LIMITS.body * 2} onChange={(e) => setBody(e.target.value)} aria-describedby={`${id}-count`} required />
      <span id={`${id}-count`} className={`hint ${length > DAYOF_LIMITS.body ? 'dayof-over' : ''}`}>
        {length}／{DAYOF_LIMITS.body} 字
      </span>
      <fieldset className="dayof-priority">
        <legend>重要度</legend>
        {DAYOF_PRIORITIES.slice()
          .reverse()
          .map((p) => (
            <label key={p} className={`status-option dayof-priority-${p}`}>
              <input type="radio" name={`${id}-priority`} value={p} checked={priority === p} onChange={() => setPriority(p)} />
              {DAYOF_PRIORITY_LABELS[p]}
            </label>
          ))}
      </fieldset>
      {priority === 'urgent' && <p className="hint">至急は連絡板のいちばん上に固定され、開いている人の画面で目立って知らされます。</p>}
      <label htmlFor={`${id}-place`}>対象の場所（任意）</label>
      <input id={`${id}-place`} type="text" value={place} maxLength={DAYOF_LIMITS.place} onChange={(e) => setPlace(e.target.value)} />
      {options.length > 0 && (
        <fieldset className="dayof-departments">
          <legend>対象の部局（任意）</legend>
          {options.map((d) => (
            <label key={d} className="status-option">
              <input type="checkbox" checked={picked.includes(d)} onChange={() => toggle(d)} disabled={!picked.includes(d) && picked.length >= DAYOF_LIMITS.departments} />
              {d}
            </label>
          ))}
        </fieldset>
      )}
      <label className="checkbox dayof-staff">
        <input type="checkbox" checked={staffVisible} onChange={(e) => setStaffVisible(e.target.checked)} />
        臨時スタッフにも見せる（物品貸出の画面に出ます。書いた人の名前は出ず「本部」と出ます）
      </label>
      {error && !(stale && drift.kind !== 'none') && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="dayof-form-actions">
        <button type="submit" disabled={busy || drift.kind !== 'none'} data-testid="dayof-post-submit">
          {busy ? '送っています…' : editing ? '直して保存' : '本部から流す'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
    </form>
  );
}
