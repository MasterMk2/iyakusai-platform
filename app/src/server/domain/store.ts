import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppState } from './types.js';

// Local demo persistence: one JSON file (default data/demo-state.json, which is
// git-ignored) or memory only. This is single-process demo storage, not
// multi-user production storage. Writes are transactional: a mutation runs on a
// copy and only replaces the live state after it succeeded and was persisted.

export type StoredState = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; state: AppState };

const STATE_ARRAYS = ['users', 'mailboxes', 'grants', 'messages', 'receipts', 'audit'] as const;

function isAppState(value: Partial<AppState> | null): value is AppState {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.schemaVersion === 1 &&
    STATE_ARRAYS.every((key) => Array.isArray(value[key])) &&
    typeof value.mockConnector === 'object' &&
    value.mockConnector !== null
  );
}

export class StateStore {
  private state: AppState;
  private readonly file: string | null;

  constructor(state: AppState, file: string | null) {
    this.state = state;
    this.file = file;
  }

  /** Demo loader: a missing or unusable file yields null, and the caller reseeds it. */
  static load(file: string): AppState | null {
    const result = StateStore.inspect(file);
    return result.kind === 'ok' ? result.state : null;
  }

  /**
   * Distinguishes a missing file (first boot) from one that exists but cannot be
   * read or does not hold a valid state. Never writes and never reports the cause,
   * so callers can refuse without exposing paths or contents.
   */
  static inspect(file: string): StoredState {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
    }
    try {
      const parsed = JSON.parse(text) as Partial<AppState> | null;
      return isAppState(parsed) ? { kind: 'ok', state: parsed } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  get current(): AppState {
    return this.state;
  }

  read<T>(fn: (state: AppState) => T): T {
    return fn(this.state);
  }

  transact<T>(fn: (draft: AppState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.persist(draft);
    this.state = draft;
    return result;
  }

  replace(state: AppState): void {
    this.persist(state);
    this.state = state;
  }

  private persist(state: AppState): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, this.file);
  }
}
