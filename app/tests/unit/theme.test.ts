import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The dark theme (2026-10-28) is written twice in styles.css: once for a dark device under
// 端末の設定に合わせる, once for ダーク chosen. 若葉 overrides some light names. These checks keep the two
// dark copies equal and every colour name defined.

const css = readFileSync(new URL('../../src/client/styles.css', import.meta.url), 'utf8');

function block(start: string): string {
  const at = css.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

const declarations = (text: string): string[] =>
  text
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.startsWith('--') || d.startsWith('color-scheme'));

const names = (text: string): Set<string> => new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));

describe('colour themes in styles.css', () => {
  const light = block(':root {');
  const followDevice = block(":root[data-theme='system']");
  const chosen = block(":root[data-theme='dark']");
  const wakaba = block(":root[data-theme='wakaba'] {");

  it('writes the same dark colours for the device setting and for the choice in 設定', () => {
    expect(declarations(followDevice)).toEqual(declarations(chosen));
    expect(declarations(chosen)).toContain('color-scheme: dark');
  });

  it('gives a dark or 若葉 colour only to names the light theme defines', () => {
    const defined = names(light);
    expect([...names(chosen)].filter((n) => !defined.has(n))).toEqual([]);
    expect([...names(wakaba)].filter((n) => !defined.has(n))).toEqual([]);
  });

  // Layout names such as --bt-gutter are set on their own rules, so this looks through the whole sheet.
  it('defines every name the rules use', () => {
    const defined = names(css);
    const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!));
    expect([...used].filter((n) => !defined.has(n))).toEqual([]);
  });
});
