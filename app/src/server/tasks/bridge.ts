import { ConfigError } from '../auth.js';

// Shared identity bridge: canonical principal (the server-verified application user)
// -> Task service user. Operator-maintained; never derived from email domains, display
// names or browser input. A principal without a binding has no task access at all.

const PRINCIPAL = /^[a-z0-9-]{1,40}$/;
const TASK_USER = /^[a-z0-9-]{1,64}$/;

export interface TaskIdentityBridge {
  taskUserFor(principalId: string): string | null;
  /** Every bound Task user, for checking the map against the in-process Task data at startup. */
  taskUsers(): string[];
}

export function parseTaskBridge(text: string): TaskIdentityBridge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError('タスク本人対応表を JSON として解釈できません。');
  }
  const root = parsed as { version?: unknown; bindings?: unknown };
  if (!root || typeof root !== 'object' || Array.isArray(root) || Object.keys(root).some((k) => k !== 'version' && k !== 'bindings')) {
    throw new ConfigError('タスク本人対応表の形式が正しくありません。');
  }
  if (root.version !== 1 || !Array.isArray(root.bindings)) throw new ConfigError('タスク本人対応表の version / bindings が正しくありません。');
  const map = new Map<string, string>();
  const taskUsers = new Set<string>();
  root.bindings.forEach((entry: unknown, index: number) => {
    const e = entry as { principalId?: unknown; taskUserId?: unknown };
    if (!e || typeof e !== 'object' || Object.keys(e).some((k) => k !== 'principalId' && k !== 'taskUserId')) throw new ConfigError(`タスク本人対応表の ${index + 1} 番目が正しくありません。`);
    if (typeof e.principalId !== 'string' || !PRINCIPAL.test(e.principalId) || typeof e.taskUserId !== 'string' || !TASK_USER.test(e.taskUserId)) {
      throw new ConfigError(`タスク本人対応表の ${index + 1} 番目の ID が正しくありません。`);
    }
    if (map.has(e.principalId) || taskUsers.has(e.taskUserId)) throw new ConfigError(`タスク本人対応表の ${index + 1} 番目が重複しています（1 人に 1 対応）。`);
    map.set(e.principalId, e.taskUserId);
    taskUsers.add(e.taskUserId);
  });
  return { taskUserFor: (principalId) => map.get(principalId) ?? null, taskUsers: () => [...taskUsers] };
}

/**
 * Synthetic bridge for the loopback demo and mock compositions only (fixture users of both apps).
 * Inbox-only: u-viewer-b. Task-only: u-noaccess-d. Both: u-editor-a (planning), u-editor-c (publicity).
 * The access administrator has no task identity.
 */
export const SYNTHETIC_TASK_BRIDGE_JSON = JSON.stringify({
  version: 1,
  bindings: [
    { principalId: 'u-editor-a', taskUserId: 'user-member-a1' },
    { principalId: 'u-editor-c', taskUserId: 'user-chair-b' },
    { principalId: 'u-noaccess-d', taskUserId: 'user-member-a2' },
  ],
});
