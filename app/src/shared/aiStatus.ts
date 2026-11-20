import type { AssistantAiStatus } from './assistant.js';

// The Bot tab's status line for the AI (2026-11-21): which model answers, and how much of the OpenCode Go allowance is
// used. The Bot reads OpenCode every 5 minutes and the Bot host hands the last reading over with the meta, so the line
// says when it was read, and says plainly when the AI is stopped (a window at 100%) or the reading is old.

/** At or above this, a window is shown as close to the limit. */
export const AI_WARN_PERCENT = 80;
/** A reading older than this (the Bot reads every 5 minutes) is shown as old. */
export const AI_STALE_MINUTES = 20;

export type AiLevel = 'ok' | 'warn' | 'stopped' | 'unknown';

export interface AiWindowView {
  key: string;
  label: string;
  percent: number;
  level: AiLevel;
  /** 「03:49」 today, 「11/23 09:00」 another day (Japan time); null when OpenCode did not say. */
  resets: string | null;
}

export interface AiStatusView {
  /** 「Gemini 4 Argon」, or the model id, or 「Claude」 on a subscription. */
  model: string;
  /** 「OpenCode Go」 or 「Claude のサブスクリプション」. */
  route: string;
  level: AiLevel;
  windows: AiWindowView[];
  /** 「02:25 時点」 (Japan time), null without a reading. */
  readAt: string | null;
  /** The one sentence to show beside the figures, or null when all is well. */
  note: string | null;
}

const JST = 'Asia/Tokyo';
const day = (d: Date) => d.toLocaleDateString('ja-JP', { timeZone: JST, month: 'numeric', day: 'numeric' });
const time = (d: Date) => d.toLocaleTimeString('ja-JP', { timeZone: JST, hour: '2-digit', minute: '2-digit' });

function when(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return day(d) === day(now) ? time(d) : `${day(d)} ${time(d)}`;
}

function windowLevel(percent: number, status: string): AiLevel {
  if (percent >= 100 || (status !== '' && status !== 'ok')) return 'stopped';
  return percent >= AI_WARN_PERCENT ? 'warn' : 'ok';
}

/** What the status line shows, or null when there is nothing to show (an older Bot, or no reading yet). */
export function aiStatusView(ai: AssistantAiStatus | null | undefined, nowMs: number): AiStatusView | null {
  if (!ai) return null;
  const now = new Date(nowMs);
  if (ai.provider !== 'opencode_go') {
    return { model: ai.modelLabel ?? ai.model ?? 'Claude', route: 'Claude のサブスクリプション', level: 'ok', windows: [], readAt: null, note: null };
  }
  const windows = ai.windows.map((w) => ({
    key: w.key,
    label: w.label,
    percent: Math.max(0, Math.min(100, w.percent)),
    level: windowLevel(w.percent, w.status),
    resets: when(w.resetsAt, now),
  }));
  const readAt = ai.fetchedAt ? `${when(ai.fetchedAt, now)} 時点` : null;
  const ageMin = ai.fetchedAt ? (nowMs - new Date(ai.fetchedAt).getTime()) / 60_000 : Infinity;
  const model = ai.modelLabel ?? ai.model ?? '不明なモデル';
  const base = { model, route: 'OpenCode Go', windows, readAt };
  if (windows.length === 0) {
    return { ...base, level: 'unknown', note: '残り枠をまだ読めていません。OpenCode のコンソールで確かめてください。' };
  }
  const stopped = windows.find((w) => w.level === 'stopped');
  if (stopped) {
    return { ...base, level: 'stopped', note: `${stopped.label}の枠を使い切ったため、AI は止まっています${stopped.resets ? `（${stopped.resets} に戻ります）` : ''}。` };
  }
  if (ai.stale || ageMin > AI_STALE_MINUTES) {
    return { ...base, level: 'unknown', note: '最新の残り枠を読めていません。表示は前に読んだ値です。' };
  }
  const near = windows.filter((w) => w.level === 'warn');
  if (near.length > 0) {
    const first = near[0]!;
    return { ...base, level: 'warn', note: `${near.map((w) => w.label).join('・')}の枠が残り少なくなっています${first.resets ? `（${first.resets} に戻ります）` : ''}。` };
  }
  return { ...base, level: 'ok', note: null };
}
