import { DECISION_LIMITS, type DecisionInput, type DecisionSource, type DecisionVenue } from '../../shared/decisions.js';

// Registering the AI's decision items of a confirmed meeting (2026-11-03). The server reads the items from the meeting
// and builds the register's text itself, so the screen only names the items. The token of an item names the meeting
// and the item's number: the same item is one decision however many times it is sent.

export const MINUTES_TOKEN_PREFIX = 'minutes-';

export function minutesItemToken(meetingId: string, index: number): string {
  return `${MINUTES_TOKEN_PREFIX}${meetingId}-${index}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** One line of text, cut to a limit (counted in characters, so a pair of surrogates is never split). */
export function oneLineText(text: string, max: number): string {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of flat) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trimEnd();
}

/** The title (the first characters, up to the title limit) and the body (the rest, if the text is longer). */
export function decisionTextsOf(text: string): { title: string; body: string } {
  const title = oneLineText(text, DECISION_LIMITS.title);
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const rest = flat.slice(title.length).trim();
  return { title, body: rest.slice(0, DECISION_LIMITS.body) };
}

export interface MeetingForDecision {
  id: string;
  title: string;
  /** YYYY-MM-DD, checked by the caller. */
  heldOn: string;
}

/** The register input of one decision item of a confirmed meeting: its source is the meeting. */
export function decisionInputOfMinutesItem(meeting: MeetingForDecision, text: string, departments: string[], venue: DecisionVenue): DecisionInput {
  const { title, body } = decisionTextsOf(text);
  const source: DecisionSource = {
    kind: 'minutes',
    refId: meeting.id,
    label: oneLineText(`議事録：${meeting.title}`, DECISION_LIMITS.sourceLabel),
    link: `#/bot/minutes?job=${encodeURIComponent(meeting.id)}`,
  };
  return { title, body, departments, decidedOn: meeting.heldOn, venue, venueOther: '', sources: [source], taskIds: [] };
}
