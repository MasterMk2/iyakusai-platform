import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/shared/api.js';
import { LINE_LABEL_KINDS, labelSuggestions, normalizeLabelInput } from '../../src/shared/lineLabels.js';

// Proposals for the labels of a LINE conversation set from its list row (2026-11-10). Synthetic names only.

describe('labels proposed on a LINE conversation row', () => {
  it('offers every exhibit category and marks the ones the conversation has', () => {
    const s = labelSuggestions({ applied: ['飲食', '団体サンプルA'], used: [], orgNames: [], query: '' });
    expect(s.kinds.map((k) => k.label)).toEqual([...LINE_LABEL_KINDS]);
    expect(s.kinds.filter((k) => k.applied).map((k) => k.label)).toEqual(['飲食']);
  });

  it('offers used labels first, then ledger names, without categories, applied labels or repeats', () => {
    const s = labelSuggestions({
      applied: ['団体サンプルA'],
      used: ['団体サンプルA', 'ステージ', '団体サンプルB', '要確認'],
      orgNames: ['団体サンプルB', '業者サンプルC'],
      query: '',
    });
    expect(s.names).toEqual(['団体サンプルB', '要確認', '業者サンプルC']);
  });

  it('keeps only the names containing the typed text, ignoring width and case', () => {
    const s = labelSuggestions({ applied: [], used: ['Ｔｅｎｎｉｓ部サンプル', '団体サンプルB'], orgNames: ['tennis愛好会サンプル'], query: 'TENNIS' });
    expect(s.names).toEqual(['Tennis部サンプル', 'tennis愛好会サンプル']);
  });

  it('never cuts a long name short: it is counted and left out', () => {
    const long = 'あ'.repeat(LIMITS.labelMaxLength + 1);
    const s = labelSuggestions({ applied: [], used: [], orgNames: [long, '短い団体サンプル'], query: '' });
    expect(s.names).toEqual(['短い団体サンプル']);
    expect(s.tooLong).toBe(1);
  });

  it('treats 全角 and 半角 forms as the same label, as the server does', () => {
    expect(normalizeLabelInput('　ＡＢＣ１２３ ')).toBe('ABC123');
    const s = labelSuggestions({ applied: ['ABC'], used: ['ＡＢＣ'], orgNames: [], query: '' });
    expect(s.names).toEqual([]);
  });

  it('stops at the given number of names', () => {
    const used = Array.from({ length: 20 }, (_, i) => `団体サンプル${i}`);
    expect(labelSuggestions({ applied: [], used, orgNames: [], query: '', max: 5 }).names).toHaveLength(5);
  });
});
