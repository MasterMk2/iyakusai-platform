// Where an official LINE conversation opens (2026-11-13): just below where this person last read, as the LINE app does.
// "Read" is only this browser's note of the newest row that was on the screen when the conversation was last open;
// nothing goes to LINE (the sender sees no 既読) and other members and devices keep their own place.

const KEY_PREFIX = 'iyakusai.line.lastRead.';
/** Conversations remembered per person; the least recently opened are forgotten first. */
export const LAST_READ_LIMIT = 500;

export interface ReadPlace {
  /** Index of the last row already read; -1 when every row is new. */
  lastRead: number;
  /** Rows after it that arrived since; 0 when nothing is new or nothing was remembered. */
  unread: number;
}

const time = (at: string): number => {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Where to open, from the rows' times in display order and the remembered time.
 * Nothing remembered (first open on this browser) or nothing new: the last row, so the latest is in view.
 */
export function readPlace(ats: readonly string[], remembered: string | null): ReadPlace {
  if (ats.length === 0) return { lastRead: -1, unread: 0 };
  if (remembered === null) return { lastRead: ats.length - 1, unread: 0 };
  const seen = time(remembered);
  // Rows are in time order; one that came in late with an older time counts as read.
  let lastRead = -1;
  ats.forEach((at, i) => {
    if (time(at) <= seen) lastRead = i;
  });
  return { lastRead, unread: ats.length - 1 - lastRead };
}

/** The newest time among the rows (what is "read" once the conversation has been open). */
export function newestAt(ats: readonly string[]): string | null {
  return ats.reduce<string | null>((latest, at) => (latest === null || time(at) > time(latest) ? at : latest), null);
}

type Marks = Record<string, string>;

function load(userId: string): Marks {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY_PREFIX + userId) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

export function rememberedRead(userId: string, conversationId: string): string | null {
  return load(userId)[conversationId] ?? null;
}

/** Keeps the newer of the remembered and the given time; the most recently opened conversation goes last. */
export function rememberRead(userId: string, conversationId: string, at: string): void {
  const marks = load(userId);
  const before = marks[conversationId];
  const keep = before !== undefined && time(before) > time(at) ? before : at;
  delete marks[conversationId];
  marks[conversationId] = keep;
  const entries = Object.entries(marks);
  try {
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(Object.fromEntries(entries.slice(-LAST_READ_LIMIT))));
  } catch {
    // Not kept (storage full or blocked): the conversation opens at the latest next time.
  }
}
