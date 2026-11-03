import { useId, useRef, useState, type FormEvent } from 'react';
import { DAYOF_LIMITS, DAYOF_VENUE_NAME } from '../../../shared/dayof';
import { DECISION_DEPARTMENT_KEY, DECISION_LIMITS } from '../../../shared/decisions';
import { toFailure } from '../../api';
import { newOperationId } from '../tasks/common';
import { dayofApi } from './dayofApi';

export interface DepartmentChoice {
  key: string;
  label: string;
}

/**
 * A decision made on the spot, in as few fields as the register allows: what was decided, where or whom it concerns
 * (optional, kept in the decision's details) and the departments (the register needs one at least). The server files
 * it as decided today at 当日本部; correcting or revoking it is done in the register, as for any decision.
 */
export function DecisionQuickForm({ departments, onSaved, onCancel }: { departments: DepartmentChoice[]; onSaved: (decisionId: string) => void; onCancel: () => void }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [typedKeys, setTypedKeys] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef<{ key: string; token: string } | null>(null);

  const typed = typedKeys
    .split(/[\s,、]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const chosen = [...new Set([...picked, ...typed])];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const body = { title: title.trim(), place: place.trim(), departments: chosen };
    if (!body.title) return setError('決めたことを 1 行で書いてください。');
    if (body.departments.length === 0) return setError('関係する部局を 1 つ以上選んでください（決定事項の台帳の決まりです）。');
    if (body.departments.some((k) => !DECISION_DEPARTMENT_KEY.test(k))) return setError('一覧にない部局は、英小文字 2〜16 文字の名前で入れてください。');
    const key = JSON.stringify(body);
    if (sent.current?.key !== key) sent.current = { key, token: newOperationId() };
    setBusy(true);
    setError(null);
    try {
      const saved = await dayofApi.decide({ ...body, clientToken: sent.current.token });
      onSaved(saved.decisionId);
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (k: string) => setPicked((list) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]));

  return (
    <form className="dayof-form" onSubmit={submit} aria-label="その場で決めたことを記録" data-testid="dayof-decision-form">
      <label htmlFor={`${id}-title`}>決めたこと（1 行）</label>
      <input id={`${id}-title`} type="text" value={title} maxLength={DECISION_LIMITS.title} onChange={(e) => setTitle(e.target.value)} required />
      <label htmlFor={`${id}-place`}>関係する場所・人（任意）</label>
      <input id={`${id}-place`} type="text" value={place} maxLength={DAYOF_LIMITS.decisionPlace} onChange={(e) => setPlace(e.target.value)} />
      <fieldset className="dayof-departments">
        <legend>関係する部局（1 つ以上）</legend>
        {departments.map((d) => (
          <label key={d.key} className="status-option">
            <input type="checkbox" checked={picked.includes(d.key)} onChange={() => toggle(d.key)} />
            {d.label}
          </label>
        ))}
        {departments.length === 0 && (
          <>
            <label htmlFor={`${id}-keys`} className="hint">
              部局の名前（英小文字。いくつかあるときは空白で区切る）
            </label>
            <input id={`${id}-keys`} type="text" value={typedKeys} onChange={(e) => setTypedKeys(e.target.value)} autoCapitalize="none" />
          </>
        )}
      </fieldset>
      <p className="hint">決定事項の台帳に、決めた日「今日」・決めた場「{DAYOF_VENUE_NAME}」で入ります。直す・取り消すときは台帳の画面で行います。</p>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="dayof-form-actions">
        <button type="submit" disabled={busy} data-testid="dayof-decision-submit">
          {busy ? '記録しています…' : '台帳に記録する'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
    </form>
  );
}
