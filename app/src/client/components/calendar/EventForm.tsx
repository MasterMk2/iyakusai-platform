import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CALENDAR_KINDS,
  CALENDAR_KIND_LABELS,
  CALENDAR_LIMITS,
  defaultRemindDays,
  REMIND_CHOICES,
  REMIND_LABELS,
  type CalendarEventInput,
  type CalendarEventView,
  type CalendarKind,
} from '../../../shared/calendar';
import { needsDateCheck } from '../../../shared/rollover';
import { api, ApiFailure } from '../../api';

// The form for one event: a new one (from a day, or a yearly one) or a change of an existing one. A change is saved
// against the version the form holds. When someone else saved first (409), the latest version is read into the form
// and the typed text stays, so the person checks it and saves again. A new event carries one request ID per form
// (kept while the content does not change), so a save whose answer was lost does not make a second event.

export function EventForm({
  initial,
  date,
  yearly,
  departments,
  onSaved,
  onDeleted,
  onReload,
  onClose,
}: {
  /** The event being changed (an occurrence comes with its base date as `date`), or null for a new one. */
  initial: CalendarEventView | null;
  /** The day a new event starts on. */
  date: string;
  /** A new event on the yearly schedule. */
  yearly: boolean;
  departments: string[];
  onSaved: (event: CalendarEventView) => void;
  onDeleted: () => void;
  /** The list is out of date (someone else changed it): reload it. */
  onReload: () => void;
  onClose: () => void;
}) {
  // The event as last read: its version is what a save is made against.
  const [base, setBase] = useState<CalendarEventView | null>(initial);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [kind, setKind] = useState<CalendarKind>(initial?.kind ?? 'other');
  const [day, setDay] = useState(initial?.date ?? date);
  const [allDay, setAllDay] = useState(initial ? initial.time === null : true);
  const [time, setTime] = useState(initial?.time ?? '09:00');
  const [chosen, setChosen] = useState<string[]>(initial?.departments ?? []);
  const [extra, setExtra] = useState('');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [isYearly, setYearly] = useState(initial?.yearly ?? yearly);
  const [remind, setRemind] = useState<number[]>(initial?.remindDays ?? defaultRemindDays(kind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The request ID of the create being sent, kept while the content stays the same.
  const sent = useRef<{ key: string; id: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // The form sits above the table and the day list: bring it into view and move the focus to it.
    heading.current?.scrollIntoView({ block: 'start' });
    heading.current?.focus({ preventScroll: true });
  }, []);

  // The reminder days follow the kind until the person changes them.
  const pickKind = (next: CalendarKind) => {
    setKind(next);
    if (!initial) setRemind(defaultRemindDays(next));
  };
  const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((v) => v !== value));
  const options = [...new Set([...departments, ...chosen])].sort((a, b) => a.localeCompare(b, 'ja'));

  const body = (): CalendarEventInput => ({
    title: title.trim(),
    kind,
    date: day,
    time: allDay ? null : time,
    departments: chosen,
    memo,
    yearly: isYearly,
    remindDays: [...remind].sort((a, b) => a - b),
  });

  /** Reads the event as it is now into the form (the typed text stays). */
  async function readLatest(id: string, message: string) {
    try {
      const latest = await api<{ event: CalendarEventView }>('GET', `/api/calendar/events/${id}`);
      setBase(latest.event);
      setError(message);
    } catch (err) {
      setError(failureText(err));
    }
    onReload();
  }

  async function failed(err: unknown, conflictMessage: string) {
    if (base && err instanceof ApiFailure && err.status === 409) {
      await readLatest(base.id, conflictMessage);
      return;
    }
    if (err instanceof ApiFailure && err.status === 404) onReload();
    setError(failureText(err));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = body();
    try {
      let res: { event: CalendarEventView };
      if (base) {
        res = await api<{ event: CalendarEventView }>('PUT', `/api/calendar/events/${base.id}`, { expectedVersion: base.version, event: payload });
      } else {
        const key = JSON.stringify(payload);
        const previous = sent.current;
        const current = previous && previous.key === key ? previous : { key, id: newRequestId() };
        sent.current = current;
        res = await api<{ event: CalendarEventView }>('POST', `/api/calendar/events?requestId=${current.id}`, payload);
      }
      onSaved(res.event);
    } catch (err) {
      await failed(err, 'ほかの人が先に変更しました。最新の内容を読み込みました。入力した内容は残しています。確かめて、もう一度保存してください。');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      await api<null>('DELETE', `/api/calendar/events/${base.id}?expectedVersion=${base.version}`);
      onDeleted();
    } catch (err) {
      setConfirming(false);
      await failed(err, 'ほかの人が先に変更しました。最新の内容を読み込みました。確かめてから、もう一度削除してください。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cal-form panel" onSubmit={save} aria-labelledby="cal-form-title" noValidate>
      <h3 id="cal-form-title" ref={heading} tabIndex={-1}>
        {base ? '予定を変更する' : isYearly ? '毎年の予定を追加する' : '予定を追加する'}
      </h3>
      {base && base.version > 1 && <p className="hint">最後に変更したのは {base.updatedByName} さんです。</p>}
      <div className="cal-field">
        <label htmlFor="cal-title">題名</label>
        <input id="cal-title" value={title} maxLength={CALENDAR_LIMITS.titleMax} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="cal-field-row">
        <div className="cal-field">
          <label htmlFor="cal-kind">種類</label>
          <select id="cal-kind" value={kind} onChange={(e) => pickKind(e.target.value as CalendarKind)}>
            {CALENDAR_KINDS.map((k) => (
              <option key={k} value={k}>
                {CALENDAR_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="cal-field">
          <label htmlFor="cal-date">日付</label>
          <input id="cal-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
          {base?.yearly && <p className="hint">毎年の予定です。日付（月日）を変えると、すべての年の表示が変わります。</p>}
          {base && needsDateCheck(base) && <p className="hint">前の年から写した予定です。この日付で合っているか確かめて、メモの先頭の行を消してから保存してください。</p>}
        </div>
      </div>
      <div className="cal-field-row">
        <label className="cal-check">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 終日
        </label>
        {!allDay && (
          <div className="cal-field">
            <label htmlFor="cal-time">時刻</label>
            <input id="cal-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        )}
      </div>
      <fieldset className="cal-fieldset">
        <legend>部局（選ばない場合は委員会全体）</legend>
        <div className="cal-checks">
          {options.map((d) => (
            <label key={d} className="cal-check">
              <input type="checkbox" checked={chosen.includes(d)} onChange={(e) => setChosen(toggle(chosen, d, e.target.checked))} /> {d}
            </label>
          ))}
        </div>
        <div className="cal-add">
          <label htmlFor="cal-extra">ほかの部局を追加</label>
          <div className="cal-add-row">
            <input id="cal-extra" value={extra} maxLength={CALENDAR_LIMITS.departmentMax} onChange={(e) => setExtra(e.target.value)} />
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const name = extra.trim();
                if (name) setChosen([...new Set([...chosen, name])]);
                setExtra('');
              }}
            >
              追加
            </button>
          </div>
        </div>
      </fieldset>
      <fieldset className="cal-fieldset">
        <legend>前もって知らせる（ホームに出す日）</legend>
        <div className="cal-checks">
          {REMIND_CHOICES.map((n) => (
            <label key={n} className="cal-check">
              <input type="checkbox" checked={remind.includes(n)} onChange={(e) => setRemind(e.target.checked ? [...remind, n] : remind.filter((v) => v !== n))} /> {REMIND_LABELS[n]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="cal-check">
        <input type="checkbox" checked={isYearly} onChange={(e) => setYearly(e.target.checked)} /> 毎年の予定にする（次の年度へ写す対象）
      </label>
      <div className="cal-field">
        <label htmlFor="cal-memo">メモ</label>
        <textarea id="cal-memo" rows={3} value={memo} maxLength={CALENDAR_LIMITS.memoMax} onChange={(e) => setMemo(e.target.value)} />
      </div>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="cal-actions">
        <button type="submit" disabled={busy}>
          {busy ? '保存しています…' : '保存する'}
        </button>
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>
          閉じる
        </button>
        {base?.canDelete && (
          <>
            {!confirming ? (
              <button type="button" className="quiet danger" onClick={() => setConfirming(true)} disabled={busy}>
                この予定を削除する
              </button>
            ) : (
              <span className="cal-confirm">
                <span>
                  {base.yearly ? 'この予定を削除します。毎年の予定なので、すべての年で表示されなくなります。' : 'この予定を削除します。'}
                  削除は取り消せません。誤って消したときは、システム課に連絡してください。
                </span>
                <button type="button" className="danger" onClick={remove} disabled={busy}>
                  削除する
                </button>
                <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={busy}>
                  やめる
                </button>
              </span>
            )}
          </>
        )}
      </div>
    </form>
  );
}

/** A request ID for one create: 32 hex characters (the server takes 16 to 64 letters, digits, - and _). */
function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function failureText(err: unknown): string {
  if (err instanceof ApiFailure) {
    if (err.status === 404) return 'この予定は見つかりませんでした。削除されたかもしれません。';
    return err.message;
  }
  return 'サーバーに接続できませんでした。通信状態を確認して、もう一度お試しください。';
}
