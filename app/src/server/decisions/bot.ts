import { DECISION_LIMITS, DECISION_VENUE_LABELS, type DecisionStatus } from '../../shared/decisions.js';
import type { DecisionsStore } from './store.js';

// The decision register as the Bot reads it (docs/contracts/bot-datasource.md §3): the newest changes first, up to
// DECISION_LIMITS.botItems. Names of people, IDs and the history never go out; a link opens the record in the app.

export interface BotDecisionItem {
  id: string;
  title: string;
  body: string;
  departments: string[];
  /** YYYY-MM-DD (Japan time). */
  decidedAt: string;
  /** The place's label (the free text when it is 'other'). */
  venue: string;
  status: DecisionStatus;
  supersededBy: string | null;
  changeNote: string;
  /** UTC: the last change of the record. */
  changedAt: string;
  /** The record in the app, or null when the origin is not known. */
  url: string | null;
}

export interface BotDecisionsResponse {
  items: BotDecisionItem[];
}

/** The Bot's view of the register. `origin` is the app's public origin (https://…), or null. */
export function botDecisions(store: DecisionsStore, origin: string | null): BotDecisionsResponse {
  return {
    items: store.latestChanged(DECISION_LIMITS.botItems).map((row) => ({
      id: row.id,
      title: row.input.title,
      body: row.input.body,
      departments: row.input.departments,
      decidedAt: row.input.decidedOn,
      venue: row.input.venue === 'other' ? row.input.venueOther : DECISION_VENUE_LABELS[row.input.venue],
      status: row.status,
      supersededBy: row.supersededBy,
      changeNote: row.changeNote,
      changedAt: row.updatedAt,
      url: origin ? `${origin}/#/decisions?d=${row.id}` : null,
    })),
  };
}
