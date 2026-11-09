import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// The return check sheet (/rental/print): its script must run to the end when it loads. Until 2026-11-10 it read the
// rules before the helpers were defined (const), threw on load, and the page stayed at 「読み込み中…」.
const source = readFileSync(path.resolve(import.meta.dirname, '../../src/rental-web/print.js'), 'utf8');

function load(saved: string | null) {
  const listeners: string[] = [];
  const context = vm.createContext({
    document: { addEventListener: (type: string) => listeners.push(type), getElementById: () => null },
    localStorage: { getItem: () => saved },
  });
  vm.runInContext(`${source}\n;globalThis.__state = state;`, context, { filename: 'print.js' });
  return { state: context.__state as { rules: unknown[]; saved: boolean }, listeners };
}

describe('the return check sheet script', () => {
  it('runs to the end on load and waits for the page', () => {
    const { state, listeners } = load(null);
    expect(listeners).toContain('DOMContentLoaded');
    expect(state.saved).toBe(false);
    expect(state.rules.length).toBeGreaterThan(0);
  });

  it('starts from the rules saved on this device', () => {
    const rules = [{ field: 'owner', value: '合成の借用元', location: '合成の返却場所' }];
    const { state } = load(JSON.stringify(rules));
    expect(state.saved).toBe(true);
    expect(state.rules).toEqual(rules);
  });

  it('starts from the first rules when the saved ones are broken', () => {
    const { state } = load('{');
    expect(state.saved).toBe(false);
    expect(state.rules.length).toBeGreaterThan(0);
  });
});
