import { useId, useState, type FormEvent } from 'react';
import { ApiFailure, toFailure } from '../../api';
import { addDays } from '../../../shared/calendar';
import { BULLETIN_LIMITS, bulletinAudienceLabel, bulletinPeriodProblem, type BulletinDetailResponse, type BulletinInput } from '../../../shared/bulletin';
import { compareDepartments } from '../../../shared/departments';
import { newOperationId } from '../tasks/common';
import { bulletinApi } from './bulletinApi';

// The form of a notice: a new one, or a correction of an open one. Its values are kept when a save fails. A new
// notice keeps one token for the whole form, so a retry after a lost answer returns the notice already stored.
// After a version conflict the form offers to read the latest content; that discards what was typed.

interface Props {
  mode: 'new' | 'edit';
  initial: BulletinInput;
  /** Edit: the notice and the version the form was opened from. */
  base?: { id: string; version: number };
  /** Department names offered as 表示対象. */
  departments: string[];
  /** Today in Japan time (YYYY-MM-DD): the quick choices of the last day count from it. */
  today: string;
  onSaved: (detail: BulletinDetailResponse) => void;
  onCancel: () => void;
  /** After a version conflict: closes the form so the latest content is read again (the typed values go). */
  onReload?: () => void;
}

const QUICK_DAYS: { label: string; days: number }[] = [
  { label: '1 週間', days: 7 },
  { label: '2 週間', days: 14 },
  { label: '1 か月', days: 30 },
];

export function BulletinForm({ mode, initial, base, departments, today, onSaved, onCancel, onReload }: Props) {
  const id = useId();
  const [token] = useState(() => newOperationId());
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [important, setImportant] = useState(initial.important);
  const [everyone, setEveryone] = useState(initial.departments.length === 0);
  const [picked, setPicked] = useState<string[]>(initial.departments);
  const [startsOn, setStartsOn] = useState(initial.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(initial.endsOn ?? '');
  const [announce, setAnnounce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  // The choices: the members' departments, plus any name the notice already has (a role renamed since).
  const options = [...new Set([...departments, ...initial.departments])].sort(compareDepartments);
  const chosen = everyone ? [] : options.filter((d) => picked.includes(d));
  const toggle = (name: string) => setPicked((list) => (list.includes(name) ? list.filter((d) => d !== name) : [...list, name]));

  function firstProblem(): string | null {
    if (!title.trim()) return '件名を入力してください。';
    if (!everyone && chosen.length === 0) return '表示する部局を一つ以上選ぶか、「委員全員」にしてください。';
    // A new notice cannot end before today; a correction may keep the days it had.
    return bulletinPeriodProblem(startsOn || null, endsOn || null, mode === 'new' || (endsOn || null) !== initial.endsOn ? today : null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = firstProblem();
    if (problem) {
      setConflict(false);
      setError(problem);
      return;
    }
    const input: BulletinInput = { title: title.trim(), body: body.replace(/\r\n/g, '\n').trimEnd(), important, departments: chosen, startsOn: startsOn || null, endsOn: endsOn || null };
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      onSaved(mode === 'new' ? await bulletinApi.create({ ...input, clientToken: token }) : await bulletinApi.update(base!.id, { ...input, expectedVersion: base!.version, announce }));
    } catch (err) {
      setError(toFailure(err).message);
      setConflict(err instanceof ApiFailure && err.status === 409 && mode === 'edit');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel bulletin-form" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate data-testid="bulletin-form">
      <h2 id={`${id}-title`}>{mode === 'new' ? 'お知らせを書く' : 'お知らせを直す'}</h2>
      {error && (
        <div className="status error" role="alert" data-testid="bulletin-form-error">
          <p>{error}</p>
          {conflict && onReload && (
            <button type="button" className="secondary" onClick={onReload}>
              最新の内容を読み込む（入力は消えます）
            </button>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor={`${id}-title-input`}>件名</label>
        <input id={`${id}-title-input`} type="text" value={title} maxLength={BULLETIN_LIMITS.title} onChange={(e) => setTitle(e.target.value)} required aria-required="true" data-testid="bulletin-title" />
      </div>

      <div className="field">
        <label htmlFor={`${id}-body`}>本文</label>
        <textarea id={`${id}-body`} rows={8} value={body} maxLength={BULLETIN_LIMITS.body} onChange={(e) => setBody(e.target.value)} data-testid="bulletin-body" />
        <p className="hint">改行はそのまま出ます。https:// で始まる URL はリンクになります。</p>
      </div>

      <fieldset className="field">
        <legend>表示対象</legend>
        <div className="chip-row">
          <label className="chip-check">
            <input type="radio" name={`${id}-audience`} checked={everyone} onChange={() => setEveryone(true)} data-testid="bulletin-audience-all" /> 委員全員
          </label>
          <label className="chip-check">
            <input type="radio" name={`${id}-audience`} checked={!everyone} onChange={() => setEveryone(false)} disabled={options.length === 0} data-testid="bulletin-audience-departments" /> 部局を選ぶ
          </label>
        </div>
        {options.length === 0 && <p className="hint">選べる部局がありません（委員の所属がまだ登録されていません）。</p>}
        {!everyone && (
          <>
            <div className="chip-row" role="group" aria-label="表示する部局">
              {options.map((d) => (
                <label key={d} className="chip-check">
                  <input type="checkbox" checked={picked.includes(d)} onChange={() => toggle(d)} /> {d}
                </label>
              ))}
            </div>
            <p className="hint" data-testid="bulletin-audience-note">
              {chosen.length > 0 ? `${bulletinAudienceLabel(chosen)} の委員と、書いた人・権限管理者にだけ表示されます。` : '部局を選んでください。'}
            </p>
          </>
        )}
      </fieldset>

      <fieldset className="field">
        <legend>掲載期間</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-ends`}>掲載期限（この日まで・空欄は期限なし）</label>
            <input id={`${id}-ends`} type="date" value={endsOn} min={startsOn || undefined} onChange={(e) => setEndsOn(e.target.value)} data-testid="bulletin-ends" />
          </div>
          <div className="field">
            <label htmlFor={`${id}-starts`}>掲載開始日（空欄はすぐ掲載）</label>
            <input id={`${id}-starts`} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} data-testid="bulletin-starts" />
          </div>
        </div>
        <div className="actions bulletin-quick" role="group" aria-label="掲載期限をまとめて入れる">
          {QUICK_DAYS.map((q) => (
            <button key={q.days} type="button" className="secondary small" onClick={() => setEndsOn(addDays(startsOn && startsOn > today ? startsOn : today, q.days))}>
              {q.label}
            </button>
          ))}
          <button type="button" className="secondary small" onClick={() => setEndsOn('')}>
            期限なし
          </button>
        </div>
        <p className="hint">期限を過ぎると掲示板とホームから外れ、「終了」の一覧に残ります。</p>
      </fieldset>

      <label className="chip-check">
        <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} data-testid="bulletin-important" /> 重要（一覧の先頭に出す）
      </label>
      {mode === 'edit' && (
        <label className="chip-check">
          <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} data-testid="bulletin-announce" /> 直したことを新着としてもう一度知らせる
        </label>
      )}

      <div className="actions">
        <button type="submit" disabled={busy} data-testid="bulletin-submit">
          {busy ? '保存しています…' : mode === 'new' ? '掲載する' : '保存する'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
    </form>
  );
}
