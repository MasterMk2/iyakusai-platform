import { describe, expect, it } from 'vitest';
import type { AssistantAiStatus } from '../../src/shared/assistant.js';
import { aiStatusView } from '../../src/shared/aiStatus.js';

// The Bot tab's AI line (2026-11-21): what it says for each state of the OpenCode Go reading.

const NOW = Date.parse('2026-11-21T02:30:00+09:00');

function go(over: Partial<AssistantAiStatus> = {}, percents: [number, number, number] = [14, 5, 2]): AssistantAiStatus {
  return {
    provider: 'opencode_go',
    model: 'gemini-4-argon',
    modelLabel: 'Gemini 4 Argon',
    ok: true,
    stale: false,
    error: null,
    fetchedAt: '2026-11-20T17:25:00Z',
    windows: [
      { key: 'rolling', label: '5時間', percent: percents[0], status: 'ok', resetsAt: '2026-11-20T18:49:49Z' },
      { key: 'weekly', label: '週', percent: percents[1], status: 'ok', resetsAt: '2026-11-23T00:00:00Z' },
      { key: 'monthly', label: '月', percent: percents[2], status: 'ok', resetsAt: '2026-12-20T13:11:56Z' },
    ],
    ...over,
  };
}

describe('aiStatusView', () => {
  it('shows nothing for an older Bot or before the first reading', () => {
    expect(aiStatusView(undefined, NOW)).toBeNull();
    expect(aiStatusView(null, NOW)).toBeNull();
  });

  it('reads well: model, route, three windows with reset times in Japan time, no note', () => {
    const v = aiStatusView(go(), NOW)!;
    expect(v.model).toBe('Gemini 4 Argon');
    expect(v.route).toBe('OpenCode Go');
    expect(v.level).toBe('ok');
    expect(v.note).toBeNull();
    expect(v.readAt).toBe('02:25 時点');
    expect(v.windows.map((w) => [w.label, w.percent, w.resets])).toEqual([
      ['5時間', 14, '03:49'],
      ['週', 5, '11/23 09:00'],
      ['月', 2, '12/20 22:11'],
    ]);
  });

  it('warns near a limit and says when it comes back', () => {
    const v = aiStatusView(go({}, [85, 40, 10]), NOW)!;
    expect(v.level).toBe('warn');
    expect(v.windows[0]!.level).toBe('warn');
    expect(v.note).toBe('5時間の枠が残り少なくなっています（03:49 に戻ります）。');
  });

  it('says the AI is stopped when a window is used up (or OpenCode says it is not ok)', () => {
    expect(aiStatusView(go({}, [100, 50, 20]), NOW)!.note).toBe('5時間の枠を使い切ったため、AI は止まっています（03:49 に戻ります）。');
    const limited = go();
    limited.windows[1] = { ...limited.windows[1]!, status: 'limited' };
    const v = aiStatusView(limited, NOW)!;
    expect(v.level).toBe('stopped');
    expect(v.note).toContain('週の枠を使い切った');
  });

  it('marks an old or failed reading instead of showing it as current', () => {
    expect(aiStatusView(go({ stale: true, ok: false, error: 'http_503' }), NOW)!.level).toBe('unknown');
    expect(aiStatusView(go({ fetchedAt: '2026-11-20T16:00:00Z' }), NOW)!.note).toBe('最新の残り枠を読めていません。表示は前に読んだ値です。');
    expect(aiStatusView(go({ windows: [], ok: false, error: 'http_401' }), NOW)!.note).toContain('まだ読めていません');
  });

  it('a stopped window is said even when the reading is old', () => {
    expect(aiStatusView(go({ stale: true }, [100, 60, 30]), NOW)!.level).toBe('stopped');
  });

  it('on a Claude subscription: the route only, no figures', () => {
    const v = aiStatusView({ ...go(), provider: 'claude_subscription', model: null, modelLabel: null, windows: [] }, NOW)!;
    expect(v.route).toBe('Claude のサブスクリプション');
    expect(v.windows).toEqual([]);
    expect(v.note).toBeNull();
  });
});

describe('the last model switch (2026-11-21)', () => {
  const choices = [
    { model: 'gemini-4-argon', label: 'Gemini 4 Argon' },
    { model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  ];

  it('says when, who and what it was before, with the label from the Bot list', () => {
    const view = aiStatusView(go({ choices, lastChange: { model: 'gemini-4-argon', previous: 'claude-haiku-5-5', at: '2026-11-20T17:16:00Z', byName: '委員長' } }), NOW);
    expect(view?.changed).toBe('02:16 に委員長が切り替え（前は Claude Haiku 5.5）');
  });

  it('gives the date for another day, and leaves out what is unknown', () => {
    const view = aiStatusView(go({ choices, lastChange: { model: 'gemini-4-argon', previous: null, at: '2026-11-19T03:00:00Z', byName: null } }), NOW);
    expect(view?.changed).toBe('11/19 12:00 に切り替え');
  });

  it('says nothing before any switch or from an older Bot', () => {
    expect(aiStatusView(go(), NOW)?.changed).toBeNull();
    expect(aiStatusView(go({ lastChange: null }), NOW)?.changed).toBeNull();
  });
});
