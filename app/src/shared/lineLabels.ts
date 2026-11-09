// Labels on official LINE conversations, set from the list rows (2026-11-10). The labels are the conversation's
// ordinary labels (the same as in the detail pane and the list's ラベル filter); this file only proposes them:
// the exhibit categories of the 2026 festival, then names already used as labels and names in the organizations
// ledger. The server keeps the rules (normalizeLabels); the same normalization here keeps 全角 and 半角 from
// making two labels.
import { LIMITS } from './api.js';

/** The categories of the 2026 exhibit applications (企画書の企画分類 and the fee table): 飲食, ステージ, … */
export const LINE_LABEL_KINDS = ['飲食', 'ステージ', '展示', '物販', '発表', '体験'] as const;

/** A label as the server will keep it (NFKC, trimmed). */
export function normalizeLabelInput(value: string): string {
  return value.normalize('NFKC').trim();
}

/** Text compared case-insensitively, so a search for "abc" finds "ABC". */
const folded = (value: string) => normalizeLabelInput(value).toLowerCase();

export interface LabelSuggestions {
  /** The categories, each with whether the conversation has it now. */
  kinds: { label: string; applied: boolean }[];
  /** Other names to add (used labels first, then the ledger), without the ones already on the conversation. */
  names: string[];
  /** Names that match but are longer than a label may be (shown as a note, never cut short). */
  tooLong: number;
}

/**
 * Proposals for one conversation. `used` is the list's label facet (most used first), `orgNames` the ledger's
 * names for the typed text. With nothing typed, the used labels are offered; with text, the names that contain it.
 */
export function labelSuggestions(input: { applied: string[]; used: string[]; orgNames: string[]; query: string; max?: number }): LabelSuggestions {
  const max = input.max ?? 12;
  const applied = new Set(input.applied.map(normalizeLabelInput));
  const kinds = new Set<string>(LINE_LABEL_KINDS);
  const query = folded(input.query);
  const seen = new Set<string>();
  const names: string[] = [];
  let tooLong = 0;
  for (const raw of [...input.used, ...input.orgNames]) {
    const name = normalizeLabelInput(raw);
    if (!name || seen.has(name) || kinds.has(name) || applied.has(name)) continue;
    seen.add(name);
    if (query && !folded(name).includes(query)) continue;
    if (name.length > LIMITS.labelMaxLength) {
      tooLong += 1;
      continue;
    }
    if (names.length < max) names.push(name);
  }
  return { kinds: LINE_LABEL_KINDS.map((label) => ({ label, applied: applied.has(label) })), names, tooLong };
}
