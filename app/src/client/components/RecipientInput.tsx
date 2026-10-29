import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref, type TextareaHTMLAttributes } from 'react';
import { recipientText, type ContactSuggestion } from '../../shared/contacts';
import { isMailAddress } from '../../shared/mailbox';
import { api } from '../api';

// A recipient field of the mail form with addresses from the committee contacts (2026-10-26): typing a name, a
// company, a reading or part of an address offers matching addresses below the field. Nothing is chosen until an
// arrow key moves to it (so Enter and Tab keep their usual meaning); then Enter or Tab picks it, Escape closes.
// A finished address offers nothing. The field stays plain text, so addresses can still be typed or pasted.

const SEPARATOR = /[,;、，；\n]/;

/** Where the recipient being typed starts (after the last separator outside quotes). */
function tokenStart(text: string): number {
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && SEPARATOR.test(ch)) start = i + 1;
  }
  return start;
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  /** The field itself (the mail form moves the focus to CC when it unfolds). */
  ref?: Ref<HTMLTextAreaElement>;
};

export function RecipientInput({ id, value, onValueChange, onKeyDown, onBlur, ref, ...rest }: Props) {
  // The recipient being typed (empty when nothing should be offered) and the answer for it.
  const [token, setToken] = useState('');
  const [result, setResult] = useState<{ token: string; items: ContactSuggestion[] } | null>(null);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const setField = (el: HTMLTextAreaElement | null) => {
    field.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  const items = token && result?.token === token ? result.items : [];
  const open = items.length > 0;

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<ContactSuggestion[]>('GET', `/api/contacts/suggest?q=${encodeURIComponent(Array.from(token).slice(0, 100).join(''))}`, undefined, controller.signal).then(
        (found) => {
          setResult({ token, items: found });
          setActive(-1);
        },
        () => setResult({ token, items: [] }),
      );
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [token]);

  function typed(text: string) {
    const t = text.slice(tokenStart(text)).trim();
    // A finished "名前 <address>" or address, or nothing typed yet, offers nothing.
    setToken(t.length >= 1 && !t.includes('<') && !isMailAddress(t) ? t : '');
  }

  function close() {
    setToken('');
    setActive(-1);
  }

  function pick(s: ContactSuggestion) {
    const before = value.slice(0, tokenStart(value)).replace(/[^\S\n]+$/, '');
    const glue = before && !before.endsWith('\n') ? ' ' : '';
    onValueChange(`${before}${glue}${recipientText(s.name, s.address)}, `);
    close();
    field.current?.focus();
  }

  function keys(e: KeyboardEvent<HTMLTextAreaElement>) {
    // keyCode 229: the Enter that ends a Japanese conversion in Safari (isComposing is already false there).
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (open && !composing && plain) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && active < items.length) {
        e.preventDefault();
        pick(items[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="recipient-field">
      <textarea
        {...rest}
        ref={setField}
        id={id}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        onChange={(e) => {
          onValueChange(e.target.value);
          typed(e.target.value);
        }}
        onKeyDown={keys}
        onBlur={(e) => {
          close();
          onBlur?.(e);
        }}
      />
      <ul id={listId} role="listbox" className="recipient-suggestions" hidden={!open} aria-label="連絡先からの候補">
        {items.map((s, i) => (
          <li
            key={`${s.contactId}-${s.address}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'active' : undefined}
            // Picking with the mouse must not blur the field first (the list would close before the click).
            onMouseDown={(e) => {
              e.preventDefault();
              pick(s);
            }}
            onMouseEnter={() => setActive(i)}
            data-testid="recipient-suggestion"
          >
            <span className="suggestion-name">
              {s.name}
              {s.organization && <span className="suggestion-org">（{s.organization}）</span>}
            </span>
            <span className="suggestion-address">
              {s.label && <span className="suggestion-label">{s.label}</span>}
              {s.address}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
