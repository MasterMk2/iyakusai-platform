import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LINE_SCHEMA_VERSION, LINE_STATE_KIND, type LineState } from './types.js';

// Separate single-process JSON store for LINE data, with the same transactional
// rule as the mail store: a mutation runs on a copy and replaces the live state
// only after it was persisted. A failed write leaves both file and memory unchanged.

export type StoredLineState = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; state: LineState };

export type FileWriter = (file: string, text: string) => void;

const ARRAYS = ['accounts', 'grants', 'conversations', 'messages', 'processedEvents', 'tombstones', 'drafts', 'consents', 'outbox', 'audit'] as const;

/** Atomic replace: write a sibling temp file, then rename over the target. */
export const atomicWrite: FileWriter = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
};

/** Accepts only this exact kind and version; anything else (including mail state) is invalid. */
export function isLineState(value: unknown): value is LineState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LineState>;
  return (
    v.kind === LINE_STATE_KIND &&
    v.schemaVersion === LINE_SCHEMA_VERSION &&
    ARRAYS.every((key) => Array.isArray(v[key])) &&
    typeof v.accessVersion === 'number' &&
    typeof v.seq === 'number' &&
    typeof v.feed === 'object' &&
    v.feed !== null
  );
}

export class LineStore {
  private state: LineState;
  private readonly file: string | null;
  private readonly writer: FileWriter;

  constructor(state: LineState, file: string | null, writer: FileWriter = atomicWrite) {
    this.state = state;
    this.file = file;
    this.writer = writer;
  }

  /** Never writes and never reports the cause, so callers can refuse without exposing paths or contents. */
  static inspect(file: string): StoredLineState {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isLineState(parsed) ? { kind: 'ok', state: parsed } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  get current(): LineState {
    return this.state;
  }

  read<T>(fn: (state: LineState) => T): T {
    return fn(this.state);
  }

  transact<T>(fn: (draft: LineState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.persist(draft);
    this.state = draft;
    return result;
  }

  replace(state: LineState): void {
    this.persist(state);
    this.state = state;
  }

  private persist(state: LineState): void {
    if (!this.file) return;
    this.writer(this.file, JSON.stringify(state));
  }
}
