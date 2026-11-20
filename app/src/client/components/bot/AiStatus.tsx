import { useEffect, useState } from 'react';
import type { AssistantAiStatus, AssistantMeta } from '../../../shared/assistant';
import { aiStatusView } from '../../../shared/aiStatus';
import { api } from '../../api';

// The Bot tab's one line about the AI (2026-11-21): 「AI Gemini 4 Argon（OpenCode Go）  5時間 14% · 週 5% · 月 2%  02:25 時点」.
// Supplementary (it never pushes the sections down much): figures as text with a thin bar each, the colour only
// repeating what the words say. When the AI is stopped (a window at 100%) or near a limit, one sentence says so and
// when it comes back. An older Bot (no `ai`) shows nothing.
// The Bot reads OpenCode every 5 minutes; while the browser tab is visible this asks the meta again at the same pace,
// and the clock ticks each minute so an old reading is said to be old.

/** How often the line asks again while the tab is visible (the Bot reads OpenCode this often). */
export const AI_STATUS_REFRESH_MS = 5 * 60_000;

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function AiStatus({ ai }: { ai: AssistantAiStatus | null | undefined }) {
  const now = useMinuteClock();
  const [fresh, setFresh] = useState<{ value: AssistantAiStatus | null | undefined; from: typeof ai } | null>(null);
  // A newer meta from the screen (it reloads after some actions) replaces what this line asked for itself.
  const current = fresh && fresh.from === ai ? fresh.value : ai;

  useEffect(() => {
    const controller = new AbortController();
    const ask = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const meta = await api<AssistantMeta>('GET', '/api/assistant/meta', undefined, controller.signal);
        setFresh({ value: meta.ai, from: ai });
      } catch {
        // Keep the last line; an old reading is marked old by the clock.
      }
    };
    const timer = window.setInterval(() => void ask(), AI_STATUS_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [ai]);

  const view = aiStatusView(current, now);
  if (!view) return null;
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
      {view.note && (
        <p className="bot-ai-note" role={view.level === 'stopped' ? 'alert' : 'status'} data-testid="bot-ai-note">
          {view.note}
        </p>
      )}
    </section>
  );
}
