import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { BroadcastRecipientView } from '../../shared/line';
import { fmtDate } from '../api';

// The 宛先 field of the official LINE send form (2026-11-09), shaped like the mail form's: type part of a name and
// pick from the people below the field. Only the account's own 1:1 conversations can be picked (no free text).
// Nothing is chosen until an arrow key moves to it (so Enter keeps its usual meaning and ends a Japanese
// conversion); then Enter or Tab picks it, Escape closes. The chosen people show as chips. For people whose name
// is not remembered, the whole list can be unfolded below, and "everyone it can go to" stays one tick.

const SHOWN = 8;
const fold = (s: string) => s.normalize('NFKC').toLowerCase();

export function LineRecipientField({
  id,
  recipients,
  selected,
  onSelected,
  all,
  onAll,
  disabled,
  invalid,
  describedBy,
  below,
}: {
  id: string;
  recipients: BroadcastRecipientView[];
  /** The chosen conversations, in the order they were picked. */
  selected: string[];
  onSelected: (ids: string[]) => void;
  all: boolean;
  onAll: (all: boolean) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  /** The hint and the error, right under the field (above the everyone tick and the list). */
  below?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [listFilter, setListFilter] = useState('');
  const listId = useId();
  const field = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(recipients.map((r) => [r.conversationId, r])), [recipients]);
  const chosen = new Set(selected);

  // The most recent conversations first; typing narrows them by name.
  const items = useMemo(() => {
    const q = fold(query.trim());
    const picked = new Set(selected);
    const recent = [...recipients].sort((a, b) => (b.latestAt ?? '').localeCompare(a.latestAt ?? ''));
    return recent.filter((r) => !picked.has(r.conversationId) && (!q || fold(r.title).includes(q))).slice(0, SHOWN);
  }, [recipients, query, selected]);
  const showList = open && !all && items.length > 0;
  const listed = useMemo(() => {
    const q = fold(listFilter.trim());
    return recipients.filter((r) => !q || fold(r.title).includes(q));
  }, [recipients, listFilter]);

  function pick(r: BroadcastRecipientView) {
    onSelected([...selected, r.conversationId]);
    setQuery('');
    setActive(-1);
    setOpen(false);
    field.current?.focus();
  }

  function remove(conversationId: string) {
    onSelected(selected.filter((s) => s !== conversationId));
  }

  function keys(e: KeyboardEvent<HTMLInputElement>) {
    // keyCode 229: the Enter that ends a Japanese conversion in Safari (isComposing is already false there).
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (composing || !plain) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showList) {
        setOpen(true);
        setActive(e.key === 'ArrowDown' ? 0 : items.length - 1);
        return;
      }
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1));
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && showList && active >= 0 && active < items.length) {
      e.preventDefault();
      pick(items[active]!);
      return;
    }
    if (e.key === 'Enter') {
      // Enter alone never sends the form from this field.
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && showList) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
      return;
    }
    if (e.key === 'Backspace' && query === '' && selected.length > 0) remove(selected[selected.length - 1]!);
  }

  const unconfirmed = (r: BroadcastRecipientView | undefined) => (r && !r.friend ? '・友だち未確認' : '');

  return (
    <div className="line-to" data-testid="line-to">
      {all ? (
        <p className="line-to-all" data-testid="line-to-all">
          送れる相手すべて（{recipients.length} 人）
        </p>
      ) : (
        <>
          {selected.length > 0 && (
            <ul className="line-chips" aria-label={`選んだ宛先（${selected.length} 人）`} data-testid="line-chips">
              {selected.map((s) => {
                const r = byId.get(s);
                const name = r?.title ?? '（会話が見つかりません）';
                return (
                  <li key={s} className={`line-chip ${r && !r.friend ? 'unconfirmed' : ''}`}>
                    <span className="line-chip-name">{name}</span>
                    {r && !r.friend && <span className="line-chip-note">友だち未確認</span>}
                    <button type="button" className="line-chip-remove" onClick={() => remove(s)} disabled={disabled} aria-label={`${name} を外す`}>
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="recipient-field">
            <input
              ref={field}
              id={id}
              type="text"
              value={query}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showList}
              aria-controls={listId}
              aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              autoComplete="off"
              disabled={disabled}
              placeholder={selected.length > 0 ? '続けて名前を入れる' : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setActive(-1);
              }}
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onBlur={() => {
                setOpen(false);
                setActive(-1);
              }}
              onKeyDown={keys}
              data-testid="line-to-input"
            />
            <ul id={listId} role="listbox" className="recipient-suggestions" hidden={!showList} aria-label="宛先の候補">
              {items.map((r, i) => (
                <li
                  key={r.conversationId}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'active' : undefined}
                  // Picking with the mouse must not blur the field first (the list would close before the click).
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(r);
                  }}
                  onMouseEnter={() => setActive(i)}
                  data-testid="line-to-suggestion"
                >
                  <span className="suggestion-name">{r.title}</span>
                  <span className="suggestion-address">
                    ID {r.maskedId}
                    {unconfirmed(r)}
                    {r.latestAt ? `・最終 ${fmtDate(r.latestAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {open && query.trim() !== '' && items.length === 0 && (
            <p className="field-hint" role="status">
              「{query.trim()}」に当たる相手がいません（選び済みの相手は出ません）。下の「一覧から選ぶ」も使えます。
            </p>
          )}
        </>
      )}
      {below}
      <label className="confirm-check plain">
        <input type="checkbox" checked={all} onChange={(e) => onAll(e.target.checked)} disabled={disabled || recipients.length === 0} data-testid="broadcast-all" />
        送れる相手すべて（{recipients.length} 人）に送る
      </label>
      {!all && (
        <details className="line-to-list">
          <summary>一覧から選ぶ（{recipients.length} 人）</summary>
          <input type="search" value={listFilter} onChange={(e) => setListFilter(e.target.value)} aria-label="一覧を名前で絞り込む" placeholder="名前で絞り込む" disabled={disabled} />
          {recipients.length === 0 ? (
            <p className="hint">送れる相手がいません。</p>
          ) : (
            <ul className="broadcast-list">
              {listed.map((r) => (
                <li key={r.conversationId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(r.conversationId)}
                      onChange={(e) => (e.target.checked ? onSelected([...selected, r.conversationId]) : remove(r.conversationId))}
                      disabled={disabled}
                      data-conversation-id={r.conversationId}
                    />
                    {r.title}
                    <span className="hint">
                      {' '}
                      ID {r.maskedId}
                      {unconfirmed(r)}
                      {r.latestAt ? `・最終 ${fmtDate(r.latestAt)}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}
