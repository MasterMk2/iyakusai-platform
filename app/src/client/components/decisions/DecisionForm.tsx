import { useId, useState, type FormEvent } from 'react';
import { ApiFailure, toFailure } from '../../api';
import { newOperationId } from '../tasks/common';
import {
  DECISION_DEPARTMENT_KEY,
  DECISION_LIMITS,
  DECISION_SOURCE_KINDS,
  DECISION_SOURCE_LABELS,
  DECISION_VENUE_LABELS,
  DECISION_VENUES,
  isDecisionDate,
  type DecisionDetailResponse,
  type DecisionInput,
  type DecisionSource,
  type DecisionSourceKind,
  type DecisionVenue,
} from '../../../shared/decisions';
import { decisionApi, forgetDecisionMeta } from './decisionsApi';
import { parseWords } from './decisionLinks';

// The form of a decision: a new one, an edit of an active one, or a change (a new decision that replaces it).
// Its values are kept when a save fails. A registration keeps one token for the whole form, so a retry after a
// lost answer returns the decision that was already stored (a retry with other content is refused, not dropped).
// After a version conflict the form offers to read the latest content; that discards what was typed.

export type DecisionFormMode = 'new' | 'edit' | 'change';

export interface DepartmentOption {
  key: string;
  label: string;
}

interface Props {
  mode: DecisionFormMode;
  initial: DecisionInput;
  /** Edit and change: the decision and the version the form was opened from. */
  base?: { id: string; version: number };
  departments: DepartmentOption[];
  onSaved: (detail: DecisionDetailResponse) => void;
  onCancel?: () => void;
  /** After a version conflict: closes the form so the latest content is read again (the typed values go). */
  onReload?: () => void;
}

interface DraftSource {
  kind: DecisionSourceKind;
  label: string;
  refId: string;
  link: string;
}

const TITLES: Record<DecisionFormMode, string> = { new: '決定を登録', edit: '決定を直す', change: '変更として登録' };
const SUBMIT: Record<DecisionFormMode, string> = { new: '登録する', edit: '保存する', change: '変更として登録する' };

const toDraft = (sources: DecisionSource[]): DraftSource[] => sources.map((s) => ({ kind: s.kind, label: s.label, refId: s.refId ?? '', link: s.link ?? '' }));

/** The first thing that stops the save, in words for the screen (the server checks the same rules). */
function firstProblem(f: {
  title: string;
  departments: string[];
  decidedOn: string;
  venue: DecisionVenue;
  venueOther: string;
  sources: DraftSource[];
  changeNote: string;
  mode: DecisionFormMode;
}): string | null {
  if (!f.title.trim()) return '決定の内容を入力してください。';
  if (f.departments.length === 0) return '関係する部局を一つ以上選んでください。';
  if (f.departments.some((k) => !DECISION_DEPARTMENT_KEY.test(k))) return '一覧にない部局は、英小文字 2〜16 文字の名前で入れてください。';
  if (!isDecisionDate(f.decidedOn)) return '決めた日を入れてください。';
  if (f.venue === 'other' && !f.venueOther.trim()) return '決めた場が「その他」のときは、場を書いてください。';
  const bad = f.sources.findIndex((s) => (s.label.trim() === '' && (s.refId.trim() !== '' || s.link.trim() !== '')) || (s.link.trim() !== '' && !s.link.trim().startsWith('#/')));
  if (bad >= 0) return `出典 ${bad + 1} に名前を入れるか、リンクをこのアプリの中の場所（#/ で始まる）にしてください。`;
  if (f.mode === 'change' && !f.changeNote.trim()) return '何を変えたかを一言書いてください。';
  return null;
}

export function DecisionForm({ mode, initial, base, departments, onSaved, onCancel, onReload }: Props) {
  const id = useId();
  const [token] = useState(() => newOperationId());
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [picked, setPicked] = useState<string[]>(initial.departments);
  const [extraKeys, setExtraKeys] = useState('');
  const [decidedOn, setDecidedOn] = useState(initial.decidedOn);
  const [venue, setVenue] = useState<DecisionVenue>(initial.venue);
  const [venueOther, setVenueOther] = useState(initial.venueOther);
  const [sources, setSources] = useState<DraftSource[]>(() => toDraft(initial.sources));
  const [taskText, setTaskText] = useState(initial.taskIds.join(' '));
  const [changeNote, setChangeNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  // The options: the Task service's departments, plus any key the decision already has.
  const options = [...departments, ...initial.departments.filter((k) => !departments.some((d) => d.key === k)).map((key) => ({ key, label: key }))];
  const extra = parseWords(extraKeys).map((k) => k.toLowerCase());
  const chosen = [...new Set([...picked, ...extra])];

  const toggle = (key: string) => setPicked((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));

  const updateSource = (index: number, patch: Partial<DraftSource>) => setSources((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = firstProblem({ title, departments: chosen, decidedOn, venue, venueOther, sources, changeNote, mode });
    if (problem) {
      setConflict(false);
      setError(problem);
      return;
    }
    const input: DecisionInput = {
      title: title.trim(),
      body: body.replace(/\r\n/g, '\n').trimEnd(),
      departments: chosen,
      decidedOn,
      venue,
      venueOther: venue === 'other' ? venueOther.trim() : '',
      sources: sources
        .filter((s) => s.label.trim() !== '')
        .map((s) => ({ kind: s.kind, label: s.label.trim(), refId: s.refId.trim() || null, link: s.link.trim() || null })),
      taskIds: parseWords(taskText),
    };
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      let detail: DecisionDetailResponse;
      if (mode === 'new') detail = await decisionApi.create({ ...input, clientToken: token });
      else if (mode === 'edit') detail = await decisionApi.update(base!.id, { ...input, expectedVersion: base!.version });
      else detail = await decisionApi.change(base!.id, { ...input, expectedVersion: base!.version, changeNote: changeNote.trim() });
      forgetDecisionMeta();
      onSaved(detail);
    } catch (err) {
      setError(toFailure(err).message);
      setConflict(err instanceof ApiFailure && err.status === 409 && mode !== 'new');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel decision-form" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate data-testid="decision-form">
      <h2 id={`${id}-title`}>{TITLES[mode]}</h2>
      {base && mode !== 'new' && (
        <p className="hint">
          {mode === 'change'
            ? '今の決定は「変更された」になり、この内容が新しい決定になります。決めた日は今日、決めた場は元の決定のままです。違うときは直してください。'
            : '直した内容は履歴に残ります。'}
        </p>
      )}
      {error && (
        <div className="status error" role="alert" data-testid="decision-form-error">
          <p>{error}</p>
          {conflict && onReload && (
            <button type="button" className="secondary" onClick={onReload} data-testid="decision-reload">
              最新の内容を読み込む（入力は消えます）
            </button>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor={`${id}-title-input`}>決定の内容（1 行）</label>
        <input id={`${id}-title-input`} type="text" value={title} maxLength={DECISION_LIMITS.title} onChange={(e) => setTitle(e.target.value)} required aria-required="true" data-testid="decision-title" />
      </div>

      <div className="field">
        <label htmlFor={`${id}-body`}>詳しい内容（任意）</label>
        <textarea id={`${id}-body`} rows={5} value={body} maxLength={DECISION_LIMITS.body} onChange={(e) => setBody(e.target.value)} />
      </div>

      <fieldset className="field decision-depts">
        <legend>関係する部局（一つ以上）</legend>
        {options.length === 0 && <p className="hint">部局の一覧がまだありません。下の欄に部局の名前を入れてください。</p>}
        <div className="chip-row">
          {options.map((d) => (
            <label key={d.key} className="chip-check">
              <input type="checkbox" checked={chosen.includes(d.key)} onChange={() => toggle(d.key)} /> {d.label}
            </label>
          ))}
        </div>
        <div className="field">
          <label htmlFor={`${id}-extra`}>一覧にない部局（英小文字の名前。空白かカンマで区切る・任意）</label>
          <input id={`${id}-extra`} type="text" value={extraKeys} onChange={(e) => setExtraKeys(e.target.value)} />
        </div>
      </fieldset>

      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-date`}>決めた日</label>
          <input id={`${id}-date`} type="date" value={decidedOn} onChange={(e) => setDecidedOn(e.target.value)} required aria-required="true" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-venue`}>決めた場</label>
          <select id={`${id}-venue`} value={venue} onChange={(e) => setVenue(e.target.value as DecisionVenue)}>
            {DECISION_VENUES.map((v) => (
              <option key={v} value={v}>
                {DECISION_VENUE_LABELS[v]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {venue === 'other' && (
        <div className="field">
          <label htmlFor={`${id}-venue-other`}>場の名前</label>
          <input id={`${id}-venue-other`} type="text" value={venueOther} maxLength={DECISION_LIMITS.venueOther} onChange={(e) => setVenueOther(e.target.value)} />
        </div>
      )}

      <fieldset className="field decision-sources">
        <legend>出典（任意・{DECISION_LIMITS.sources} 件まで）</legend>
        {sources.map((s, i) => (
          <div key={i} className="source-row">
            <div className="field">
              <label htmlFor={`${id}-kind-${i}`}>出典の種類（{i + 1}）</label>
              <select id={`${id}-kind-${i}`} value={s.kind} onChange={(e) => updateSource(i, { kind: e.target.value as DecisionSourceKind })}>
                {DECISION_SOURCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DECISION_SOURCE_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-label-${i}`}>出典の名前（件名・日付など）</label>
              <input id={`${id}-label-${i}`} type="text" value={s.label} maxLength={DECISION_LIMITS.sourceLabel} onChange={(e) => updateSource(i, { label: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-ref-${i}`}>参照 ID（任意）</label>
              <input id={`${id}-ref-${i}`} type="text" value={s.refId} maxLength={DECISION_LIMITS.sourceRef} onChange={(e) => updateSource(i, { refId: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-link-${i}`}>アプリの中のリンク（任意）</label>
              <input id={`${id}-link-${i}`} type="text" value={s.link} maxLength={DECISION_LIMITS.sourceLink} onChange={(e) => updateSource(i, { link: e.target.value })} />
            </div>
            <button type="button" className="secondary" onClick={() => setSources((list) => list.filter((_, j) => j !== i))}>
              この出典を外す
            </button>
          </div>
        ))}
        <p className="hint">リンクは「#/」で始まる、このアプリの中の場所です（メール・LINE・議事録から開くと自動で入ります）。手入力では空のままで構いません。</p>
        {sources.length < DECISION_LIMITS.sources && (
          <button type="button" className="secondary" onClick={() => setSources((list) => [...list, { kind: 'manual', label: '', refId: '', link: '' }])}>
            出典を追加
          </button>
        )}
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-tasks`}>関係するタスク（ID を空白かカンマで区切る・任意）</label>
        <input id={`${id}-tasks`} type="text" value={taskText} onChange={(e) => setTaskText(e.target.value)} />
      </div>

      {mode === 'change' && (
        <div className="field">
          <label htmlFor={`${id}-change-note`}>何を変えたか（一言・必須）</label>
          <input id={`${id}-change-note`} type="text" value={changeNote} maxLength={DECISION_LIMITS.note} onChange={(e) => setChangeNote(e.target.value)} required aria-required="true" data-testid="decision-change-note" />
        </div>
      )}

      <div className="actions">
        <button type="submit" disabled={busy} data-testid="decision-submit">
          {busy ? '保存しています…' : SUBMIT[mode]}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            やめる
          </button>
        )}
      </div>
    </form>
  );
}
