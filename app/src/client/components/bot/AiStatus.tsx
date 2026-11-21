import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantAiModelChange, AssistantAiStatus, AssistantMeta } from '../../../shared/assistant';
import { aiModelLabel, aiStatusView } from '../../../shared/aiStatus';
import { api, ApiFailure } from '../../api';
import { operationFor, settleOperation, type OperationSlots } from './common';

// The Bot tab's one line about the AI (2026-11-21): 「AI Gemini 4 Argon（OpenCode Go）  5時間 14% · 週 5% · 月 2%  02:25 時点」.
// Supplementary (it never pushes the sections down much): figures as text with a thin bar each, the colour only
// repeating what the words say. When the AI is stopped (a window at 100%) or near a limit, one sentence says so and
// when it comes back. An older Bot (no `ai`) shows nothing.
// The Bot reads OpenCode every 5 minutes; while the browser tab is visible this asks the meta again at the same pace,
// and the clock ticks each minute so an old reading is said to be old.
// Officers (Manage Server on Discord: the meta's isAdmin) can switch the model here: a small link opens the list in
// place. A switch is undone the same way, so there is no confirmation dialog; the list says what it changes (the Bot,
// the scheduled screening and the minutes summaries, for everyone, from their next call).

/** How often the line asks again while the tab is visible (the Bot reads OpenCode this often). */
export const AI_STATUS_REFRESH_MS = 5 * 60_000;
/** After a switch the Bot has accepted but not applied yet, ask again this soon. */
const PENDING_RECHECK_MS = 3_000;

type AiChange = NonNullable<AssistantAiStatus['lastChange']>;

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

interface Props {
  ai: AssistantAiStatus | null | undefined;
  /** An officer: may switch the model. */
  canSwitch?: boolean;
  /** The Bot answers (its heartbeat is recent); a switch needs it. */
  botAlive?: boolean;
}

export function AiStatus({ ai, canSwitch = false, botAlive = true }: Props) {
  const now = useMinuteClock();
  const [fresh, setFresh] = useState<{ value: AssistantAiStatus | null | undefined; from: typeof ai } | null>(null);
  // A newer meta from the screen (it reloads after some actions) replaces what this line asked for itself.
  const current = fresh && fresh.from === ai ? fresh.value : ai;
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const meta = await api<AssistantMeta>('GET', '/api/assistant/meta', undefined, signal);
      setFresh({ value: meta.ai, from: ai });
    } catch {
      // Keep the last line; an old reading is marked old by the clock.
    }
  }, [ai]);

  useEffect(() => {
    controller.current = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, AI_STATUS_REFRESH_MS);
    return () => {
      controller.current?.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const view = aiStatusView(current, now);
  if (!view || !current) return null;
  const choices = current.provider === 'opencode_go' ? (current.choices ?? []) : [];
  const onSwitched = (change: AssistantAiModelChange, record: AiChange) => {
    if (change.state === 'done') {
      setFresh({ value: { ...current, model: change.model, modelLabel: aiModelLabel(current, change.model), lastChange: record }, from: ai });
    }
    window.setTimeout(() => void refresh(), change.state === 'done' ? 0 : PENDING_RECHECK_MS);
  };
  return (
    <section className={`bot-ai-status ${view.level}`} aria-label="Bot の AI の状態" data-testid="bot-ai-status" data-level={view.level}>
      <p className="bot-ai-model">
        <span className="bot-ai-key">AI</span>
        {view.model}
        <span className="bot-ai-route">（{view.route}）</span>
      </p>
      {view.windows.length > 0 && (
        <ul className="bot-ai-windows">
          {view.windows.map((w) => (
            <li key={w.key} className={`bot-ai-window ${w.level}`} data-testid={`bot-ai-window-${w.key}`}>
              <span className="bot-ai-window-label">{w.label}</span>
              <span className="bot-ai-bar" aria-hidden="true">
                <span style={{ width: `${w.percent}%` }} />
              </span>
              <span className="bot-ai-window-figure">{Math.round(w.percent)}%</span>
              {w.resets && <span className="bot-ai-window-resets">{w.resets} に戻る</span>}
            </li>
          ))}
        </ul>
      )}
      {view.readAt && <p className="bot-ai-read">{view.readAt}</p>}
      {view.changed && (
        <p className="bot-ai-changed" data-testid="bot-ai-changed">
          {view.changed}
        </p>
      )}
      {canSwitch && choices.length > 0 && <ModelSwitch ai={current} botAlive={botAlive} onSwitched={onSwitched} />}
      {view.note && (
        <p className="bot-ai-note" role={view.level === 'stopped' ? 'alert' : 'status'} data-testid="bot-ai-note">
          {view.note}
        </p>
      )}
    </section>
  );
}

interface SwitchProps {
  ai: AssistantAiStatus;
  botAlive: boolean;
  onSwitched: (change: AssistantAiModelChange, record: AiChange) => void;
}

/** The officer's part: a link that opens the list in place, and the result with an undo. */
function ModelSwitch({ ai, botAlive, onSwitched }: SwitchProps) {
  const choices = ai.choices ?? [];
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>(ai.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; previous: string | null } | null>(null);
  const slots = useRef<OperationSlots>({});

  const send = async (model: string) => {
    setBusy(true);
    setError(null);
    const clientOperationId = operationFor(slots.current, 'aimodel', model);
    const previous = ai.model;
    try {
      const { change } = await api<{ change: AssistantAiModelChange }>('POST', '/api/assistant/ai-model', { clientOperationId, model });
      slots.current.aimodel = null;
      const label = aiModelLabel(ai, change.model) ?? change.model;
      const before = change.previous ?? previous;
      setOpen(false);
      setResult(
        change.state === 'done'
          ? { text: `${label} に切り替えました。次の依頼から使われます。`, previous: before && before !== change.model ? before : null }
          : { text: `${label} への切り替えを受け付けました。数秒で替わります。`, previous: null },
      );
      onSwitched(change, { model: change.model, previous: before, at: new Date().toISOString(), byName: null });
    } catch (err) {
      settleOperation(slots.current, 'aimodel', err);
      setError(err instanceof ApiFailure ? err.message : '切り替えられませんでした。');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        <p className="bot-ai-switch">
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => {
              setPicked(ai.model ?? '');
              setResult(null);
              setError(null);
              setOpen(true);
            }}
            data-testid="bot-ai-switch-open"
          >
            モデルを替える
          </button>
        </p>
        {result && (
          <p className="bot-ai-result" role="status" data-testid="bot-ai-switch-result">
            {result.text}
            {result.previous && (
              <button type="button" className="link-button" disabled={busy} onClick={() => void send(result.previous!)} data-testid="bot-ai-switch-undo">
                元に戻す（{aiModelLabel(ai, result.previous)}）
              </button>
            )}
          </p>
        )}
        {error && (
          <p className="bot-ai-result field-error" role="alert">
            {error}
          </p>
        )}
      </>
    );
  }

  return (
    <form
      className="bot-ai-picker"
      data-testid="bot-ai-picker"
      onSubmit={(event) => {
        event.preventDefault();
        if (picked && picked !== ai.model) void send(picked);
      }}
    >
      <fieldset disabled={busy}>
        <legend>Bot の AI のモデル</legend>
        {choices.map((c) => (
          <label key={c.model} className="bot-ai-choice">
            <input type="radio" name="ai-model" value={c.model} checked={picked === c.model} onChange={() => setPicked(c.model)} />
            {c.label}
            {c.model === ai.model && <span className="bot-ai-current">いま</span>}
          </label>
        ))}
      </fieldset>
      <p className="bot-ai-picker-note">Bot・定期スクリーニング・議事録の要約の全部が、次の呼び出しから替わります（処理中の議事録は途中から替わります）。</p>
      {!botAlive && <p className="field-error">Bot が応答していないため、いまは切り替えられません。</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="bot-ai-picker-actions">
        <button type="submit" disabled={busy || !botAlive || !picked || picked === ai.model} data-testid="bot-ai-switch-submit">
          {busy ? '切り替えています…' : '切り替える'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>
          やめる
        </button>
      </div>
    </form>
  );
}
