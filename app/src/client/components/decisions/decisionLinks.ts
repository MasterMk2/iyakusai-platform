import { DECISION_APP_LINK, DECISION_LIMITS, DECISION_SOURCE_KINDS, isDecisionDate, type DecisionSource, type DecisionSourceKind } from '../../../shared/decisions.js';

// The register's hash addresses and the memory-free hand-over from the mail, LINE and minutes screens: a link
// that opens the form with the title, the day and the source already in it. Pure functions, no React.

export interface DecisionPrefill {
  title: string;
  /** YYYY-MM-DD, or '' when unknown. */
  decidedOn: string;
  source: DecisionSource | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** One line of text, cut to a limit (a subject or a name pasted into a form). */
export function oneLine(text: string, max: number): string {
  return text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const decisionHref = (id: string) => `#/decisions?d=${encodeURIComponent(id)}`;

export const DECISIONS_LIST_HREF = '#/decisions';

/**
 * The form, with the prefill (when there is one) and the screen it was opened from (`back`, an in-app hash) in the
 * address, so "やめる" returns there.
 */
export function decisionNewHref(prefill?: DecisionPrefill | null, back?: string | null): string {
  const q = new URLSearchParams({ new: '1' });
  if (back && DECISION_APP_LINK.test(back)) q.set('back', back);
  if (prefill) {
    const title = oneLine(prefill.title, DECISION_LIMITS.title);
    if (title) q.set('title', title);
    if (isDecisionDate(prefill.decidedOn)) q.set('date', prefill.decidedOn);
    if (prefill.source) {
      q.set('src', prefill.source.kind);
      const label = oneLine(prefill.source.label, DECISION_LIMITS.sourceLabel);
      if (label) q.set('label', label);
      if (prefill.source.refId) q.set('ref', prefill.source.refId);
      if (prefill.source.link && DECISION_APP_LINK.test(prefill.source.link)) q.set('link', prefill.source.link);
    }
  }
  return `#/decisions?${q.toString()}`;
}

const isSourceKind = (value: string): value is DecisionSourceKind => (DECISION_SOURCE_KINDS as readonly string[]).includes(value);

/** The prefill in an address (`#/decisions?new=1&title=…`), or null when there is none. Anything wrong is dropped. */
export function parseDecisionPrefill(params: URLSearchParams): DecisionPrefill | null {
  const title = oneLine(params.get('title') ?? '', DECISION_LIMITS.title);
  const date = isDecisionDate(params.get('date') ?? '') ? (params.get('date') ?? '') : '';
  const kind = params.get('src') ?? '';
  const label = oneLine(params.get('label') ?? '', DECISION_LIMITS.sourceLabel);
  const link = params.get('link') ?? '';
  const source: DecisionSource | null =
    isSourceKind(kind) && label
      ? {
          kind,
          refId: (params.get('ref') ?? '').slice(0, DECISION_LIMITS.sourceRef) || null,
          label,
          link: DECISION_APP_LINK.test(link) ? link : null,
        }
      : null;
  if (!title && !source && !date) return null;
  return { title, decidedOn: date, source };
}

/** A UTC instant as its day in Japan (YYYY-MM-DD), or '' for a value that is not a date. */
export function japanDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export const todayInJapan = (): string => japanDay(new Date().toISOString());

/** Where "やめる" goes: the screen the form was opened from (`back` in the address), or the list when there is none. */
export function returnHref(hash: string): string {
  const back = new URLSearchParams(hash.split('?')[1] ?? '').get('back') ?? '';
  return DECISION_APP_LINK.test(back) ? back : DECISIONS_LIST_HREF;
}

/** A department's name on the screens (the key itself when the Task service has no name for it). */
export function departmentLabel(key: string, departments: { key: string; label: string }[]): string {
  return departments.find((d) => d.key === key)?.label ?? key;
}

/** Words typed by hand (department keys, task IDs), separated by spaces, commas or Japanese commas. */
export function parseWords(text: string): string[] {
  return text
    .split(/[\s,、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
