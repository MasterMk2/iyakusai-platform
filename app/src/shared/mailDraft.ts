// The Bot's mail draft (Discord /mail; the Bot tab's メール screen, 2026-10-25). The screen sends an ordinary
// /doc job (docType "mail", format "txt") whose content is the labelled request built here, so the server,
// the Bot host's integration API and its job table need no change. The labels and limits must match the
// Bot's mail_draft.py (compose_request); change both together.

import { cleanText } from './assistant.js';

/** Per-field limits. With the labels, the largest request stays within the /doc content limit (2000). */
export const MAIL_LIMITS = { toMax: 100, senderMax: 60, purposeMax: 900, receivedMax: 800 } as const;

export const MAIL_RELATIONS = { first: '初めて連絡する', ongoing: '以前からやりとりがある' } as const;
export type MailRelation = keyof typeof MAIL_RELATIONS;

const L_TO = '【相手】';
const L_SENDER = '【差出人】';
const L_RELATION = '【これまでのやりとり】';
const L_PURPOSE = '【要件】';
const L_RECEIVED = '【届いたメール(これへの返信を書く)】';

export interface MailRequest {
  to: string;
  purpose: string;
  sender?: string;
  relation?: MailRelation | null;
  received?: string;
}

/** The request text the Bot reads (same order and labels as mail_draft.compose_request; empty parts are left out). */
export function composeMailRequest(request: MailRequest): string {
  const parts = [`${L_TO}${cleanText(request.to)}`];
  const sender = cleanText(request.sender ?? '');
  if (sender) parts.push(`${L_SENDER}${sender}`);
  if (request.relation) parts.push(`${L_RELATION}${MAIL_RELATIONS[request.relation]}`);
  parts.push(`${L_PURPOSE}\n${cleanText(request.purpose)}`);
  const received = cleanText(request.received ?? '');
  if (received) parts.push(`${L_RECEIVED}\n${received}`);
  return parts.join('\n');
}

/** The recipient and the purpose of a request made by composeMailRequest, for list rows. Null for other text. */
export function parseMailRequest(content: string): { to: string; purpose: string } | null {
  if (!content.startsWith(L_TO)) return null;
  const to = content.slice(L_TO.length).split('\n', 1)[0]!.trim();
  const at = content.indexOf(`\n${L_PURPOSE}\n`);
  if (at < 0) return { to, purpose: '' };
  const rest = content.slice(at + L_PURPOSE.length + 2);
  const end = rest.indexOf(`\n${L_RECEIVED}\n`);
  return { to, purpose: (end < 0 ? rest : rest.slice(0, end)).trim() };
}

export interface MailDraft {
  /** The Bot's notes before the draft (warnings, what to fill in, model), Discord Markdown. */
  notes: string;
  subject: string;
  body: string;
}

const SUBJECT_LINE = /^件名[:：]\s*/;

/**
 * Splits a mail job's result text into the notes, the subject and the body. The Bot puts the draft after its
 * notes and the draft's first line is "件名：…" (no note line starts so). Null when there is no such line
 * (an older Bot, or a document that is not a mail), so the screen falls back to showing the text as it is.
 */
export function splitMailDraft(text: string): MailDraft | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((line) => SUBJECT_LINE.test(line));
  if (at < 0) return null;
  const notes = lines
    .slice(0, at)
    .filter((line, i) => !(i === 0 && line.startsWith('✉️')))
    .join('\n')
    .trim();
  return {
    notes,
    subject: lines[at]!.replace(SUBJECT_LINE, '').trim(),
    body: lines
      .slice(at + 1)
      .join('\n')
      .replace(/^\s*\n/, '')
      .trimEnd(),
  };
}
