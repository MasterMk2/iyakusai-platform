import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LIMITS, type LabelFacet, type TriageView } from '../../shared/api';
import { labelSuggestions, normalizeLabelInput } from '../../shared/lineLabels';
import type { OrgListResponse } from '../../shared/organizations';
import { api, toFailure } from '../api';

/**
 * Labels of one official LINE conversation, opened from its list row (2026-11-10): who the other side is (a group's
 * name) and what kind of exhibit (飲食, ステージ …). Each click saves at once, and × takes a label off again, so there
 * is no save button. The labels are the conversation's ordinary labels (the detail pane and the ラベル filter).
 */
export function LineLabelEditor(props: {
  conversationId: string;
  title: string;
  labels: string[];
  version: number;
  /** The list's label facet (most used first). */
  used: LabelFacet[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState({ labels: props.labels, version: props.version });
  // A reload brought a newer version (this editor's save, or someone else's): show it.
  if (props.version > current.version) setCurrent({ labels: props.labels, version: props.version });
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  // The ledger's names, with the text they were found for (an answer for older text is not used).
  const [found, setFound] = useState<{ query: string; names: string[] }>({ query: '', names: [] });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // With a mouse the name can be typed at once; on a phone the keyboard would cover the categories, so it waits for a tap.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  // The ledger is searched once the typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(normalizeLabelInput(input)), 250);
    return () => clearTimeout(timer);
  }, [input]);

  // Names in the organizations ledger. Temporary staff may not read it (403), and a server without it answers 404:
  // the used labels are proposed alone then.
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query.slice(0, 100), pageSize: '20' });
    api<OrgListResponse>('GET', `/api/organizations?${params.toString()}`, undefined, controller.signal)
      .then((res) => setFound({ query, names: res.items.map((o) => o.name) }))
      .catch(() => {
        if (!controller.signal.aborted) setFound({ query, names: [] });
      });
    return () => controller.abort();
  }, [query]);

  const full = current.labels.length >= LIMITS.labelsPerReceipt;
  const orgNames = query && found.query === query ? found.names : [];
  const proposals = labelSuggestions({ applied: current.labels, used: props.used.map((f) => f.label), orgNames, query: input });

  async function save(next: string[], attempt: string, done: string): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    setMessage(null);
    try {
      const view = await api<TriageView>('PATCH', `/api/line/conversations/${encodeURIComponent(props.conversationId)}/triage`, { expectedVersion: current.version, labels: next });
      setCurrent({ labels: view.labels, version: view.version });
      setMessage({ error: false, text: done });
      props.onSaved();
      return true;
    } catch (err) {
      const failure = toFailure(err);
      if (failure.status === 409 && failure.body?.current) {
        // Someone else changed the conversation first: show their labels and say what was not saved.
        const latest = failure.body.current;
        setCurrent({ labels: latest.labels, version: latest.version });
        setMessage({ error: true, text: `ほかの人が先に変更したため、${attempt}変更は保存していません。最新のラベルを表示しています。` });
        props.onSaved();
      } else {
        setMessage({ error: true, text: `保存できませんでした: ${failure.message}` });
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add(raw: string) {
    const label = normalizeLabelInput(raw);
    if (!label) return;
    if (current.labels.includes(label)) {
      setInput('');
      return;
    }
    if (label.length > LIMITS.labelMaxLength) {
      setMessage({ error: true, text: `ラベルは ${LIMITS.labelMaxLength} 文字までです。略した名前を入力してください。` });
      return;
    }
    if (full) {
      setMessage({ error: true, text: `ラベルは ${LIMITS.labelsPerReceipt} 個までです。どれかを外してから付けてください。` });
      return;
    }
    if (await save([...current.labels, label], `「${label}」を付ける`, `「${label}」を付けました。`)) setInput('');
  }

  function remove(label: string) {
    void save(
      current.labels.filter((l) => l !== label),
      `「${label}」を外す`,
      `「${label}」を外しました。`,
    );
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
    }
  }

  const inputId = `line-label-input-${props.conversationId}`;
  return (
    <section className="line-label-editor" id={`line-labels-${props.conversationId}`} aria-label={`「${props.title}」のラベル`} aria-busy={saving} onKeyDown={onKeyDown}>
      <div className="lle-row">
        <span className="lle-caption">ラベル</span>
        <span className="labels-edit">
          {current.labels.length === 0 && <span className="hint">まだありません</span>}
          {current.labels.map((l) => (
            <span key={l} className="chip label">
              {l}
              <button type="button" className="chip-remove" aria-label={`ラベル「${l}」を外す`} disabled={saving} onClick={() => remove(l)}>
                ×
              </button>
            </span>
          ))}
        </span>
      </div>
      <div className="lle-row" role="group" aria-label="企画の区分">
        <span className="lle-caption">区分</span>
        <span className="lle-choices">
          {proposals.kinds.map((k) => (
            <button
              key={k.label}
              type="button"
              className="label-suggest"
              aria-pressed={k.applied}
              disabled={saving || (!k.applied && full)}
              onClick={() => (k.applied ? remove(k.label) : void add(k.label))}
            >
              {k.applied ? `✓ ${k.label}` : k.label}
            </button>
          ))}
        </span>
      </div>
      <div className="lle-row">
        <label className="lle-caption" htmlFor={inputId}>
          団体名など
        </label>
        <span className="lle-add">
          <input
            ref={inputRef}
            id={inputId}
            value={input}
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // The Enter that ends a Japanese conversion must not save half a name (keyCode 229: Safari, where
              // isComposing is already false), since each Enter here saves at once.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                void add(input);
              }
            }}
          />
          <button type="button" className="secondary small" disabled={saving || !normalizeLabelInput(input)} onClick={() => void add(input)}>
            追加
          </button>
        </span>
      </div>
      {proposals.names.length > 0 && (
        <div className="lle-row" role="group" aria-label={input.trim() ? '入力に合う名前' : 'これまでに使ったラベル'}>
          <span className="lle-caption">{input.trim() ? '候補' : 'よく使う'}</span>
          <span className="lle-choices">
            {proposals.names.map((n) => (
              <button key={n} type="button" className="label-suggest" disabled={saving || full} onClick={() => void add(n)}>
                ＋ {n}
              </button>
            ))}
          </span>
        </div>
      )}
      {proposals.tooLong > 0 && (
        <p className="hint">
          入力に合う名前のうち {proposals.tooLong} 件は {LIMITS.labelMaxLength} 文字を超えるため候補に出していません。略した名前を入力してください。
        </p>
      )}
      {full && <p className="hint">ラベルは {LIMITS.labelsPerReceipt} 個までです。付けるには、どれかを外してください。</p>}
      <p className="hint lle-status" role="status">
        {saving ? '保存中…' : message && !message.error ? message.text : ''}
      </p>
      {message?.error && (
        <p className="status error compact" role="alert">
          {message.text}
        </p>
      )}
    </section>
  );
}
