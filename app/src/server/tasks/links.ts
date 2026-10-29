import { readFileSync } from 'node:fs';
import type { CaseKind, CaseTaskFields } from '../../shared/tasks.js';
import { writeFileDurable, type DurableFileOps } from '../durable-file.js';

// Gateway-owned provenance and create-from-case operation records. The Task service
// stores nothing about the source case; the link lives here and is only ever shown after
// the viewer's current source ACL has been evaluated. Single-process JSON file, written
// durably (durable-file.ts) and replaced in memory only after a successful write.

export const LINK_STATE_KIND = 'smm-task-links' as const;
const MAX_OPERATIONS = 5_000;

export interface TaskLink {
  id: string;
  taskId: string;
  workspaceId: string;
  source: { kind: CaseKind; id: string };
  createdBy: string;
  createdAt: string;
}

export interface CaseTaskOperation {
  /** SHA-256 of principal + client operation ID. */
  key: string;
  principalId: string;
  clientOperationId: string;
  /** Binds actor, source and the reviewed task fields. */
  fingerprint: string;
  source: { kind: CaseKind; id: string };
  input: CaseTaskFields;
  /** Deterministic Task-service operation ID; a retry can never create a second task. */
  taskOperationId: string;
  state: 'pending' | 'complete';
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkState {
  kind: typeof LINK_STATE_KIND;
  version: 1;
  links: TaskLink[];
  operations: CaseTaskOperation[];
  seq: number;
}

export const emptyLinkState = (): LinkState => ({ kind: LINK_STATE_KIND, version: 1, links: [], operations: [], seq: 0 });

function isLinkState(value: unknown): value is LinkState {
  const v = value as Partial<LinkState> | null;
  return !!v && v.kind === LINK_STATE_KIND && v.version === 1 && Array.isArray(v.links) && Array.isArray(v.operations) && Number.isInteger(v.seq);
}

export type StoredLinks = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; state: LinkState };

export class TaskLinkStore {
  private state: LinkState;

  constructor(
    state: LinkState,
    private readonly file: string | null,
    /** Test-only failure injection; production uses the real file system. */
    private readonly ops?: DurableFileOps,
  ) {
    this.state = state;
  }

  /** Never writes; distinguishes a first boot from an unreadable or invalid file. */
  static inspect(file: string): StoredLinks {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isLinkState(parsed) ? { kind: 'ok', state: parsed } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  get current(): LinkState {
    return this.state;
  }

  transact<T>(fn: (draft: LinkState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    if (draft.operations.length > MAX_OPERATIONS) {
      // Oldest completed records go first; pending ones are kept so they can still be resolved.
      const excess = draft.operations.length - MAX_OPERATIONS;
      const drop = new Set(draft.operations.filter((op) => op.state === 'complete').slice(0, excess));
      draft.operations = draft.operations.filter((op) => !drop.has(op));
    }
    this.persist(draft);
    this.state = draft;
    return result;
  }

  replace(state: LinkState): void {
    this.persist(state);
    this.state = state;
  }

  private persist(state: LinkState): void {
    if (!this.file) return;
    writeFileDurable(this.file, JSON.stringify(state), this.ops);
  }
}
