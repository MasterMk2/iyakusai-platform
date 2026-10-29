import { addDays, todayInTimeZone } from '../../shared/dates.js';
import type { HistoryEntry, Membership, Requirements, Task, TaskStatus, User, Workspace } from '../../shared/types.js';
import { STATE_SCHEMA_VERSION, type AppState } from './state.js';

// サンプルデータはすべて架空。メールアドレスは予約済みドメイン（.example / .invalid）だけを使う。

const WORKSPACES: Workspace[] = [
  { id: 'ws-planning', name: 'サンプル企画委員会', description: '架空の委員会 A。行事の企画を担当する想定。' },
  { id: 'ws-publicity', name: 'サンプル広報委員会', description: '架空の委員会 B。告知と掲示を担当する想定。' },
];

const USERS: User[] = [
  { id: 'user-chair-a', displayName: '管理役 A', email: 'chair-a@committee-a.example', personaNote: '企画委員会の管理者' },
  {
    id: 'user-member-a1',
    displayName: '委員 A1',
    email: 'member-a1@committee-a.example',
    personaNote: '企画委員会の編集者・広報委員会の閲覧者',
  },
  { id: 'user-member-a2', displayName: '委員 A2', email: 'member-a2@committee-a.example', personaNote: '企画委員会の編集者' },
  { id: 'user-observer-a', displayName: '閲覧役 A', email: 'observer-a@committee-a.example', personaNote: '企画委員会の閲覧者' },
  {
    id: 'user-former-a3',
    displayName: '旧委員 A3',
    email: 'former-a3@committee-a.invalid',
    personaNote: '企画委員会の所属が無効になった元編集者',
  },
  { id: 'user-chair-b', displayName: '管理役 B', email: 'chair-b@committee-b.example', personaNote: '広報委員会の管理者' },
  { id: 'user-member-b1', displayName: '委員 B1', email: 'member-b1@committee-b.example', personaNote: '広報委員会の編集者' },
  { id: 'user-outsider', displayName: '未所属の利用者', email: 'outsider@unaffiliated.invalid', personaNote: 'どの委員会にも所属しない' },
];

const MEMBERSHIPS: Membership[] = [
  { workspaceId: 'ws-planning', userId: 'user-chair-a', role: 'admin', active: true },
  { workspaceId: 'ws-planning', userId: 'user-member-a1', role: 'editor', active: true },
  { workspaceId: 'ws-planning', userId: 'user-member-a2', role: 'editor', active: true },
  { workspaceId: 'ws-planning', userId: 'user-observer-a', role: 'viewer', active: true },
  { workspaceId: 'ws-planning', userId: 'user-former-a3', role: 'editor', active: false },
  { workspaceId: 'ws-publicity', userId: 'user-chair-b', role: 'admin', active: true },
  { workspaceId: 'ws-publicity', userId: 'user-member-b1', role: 'editor', active: true },
  { workspaceId: 'ws-publicity', userId: 'user-member-a1', role: 'viewer', active: true },
];

interface SeedTask {
  workspaceId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  deadlineOffset?: number;
  status: TaskStatus;
  requirements?: Partial<Requirements>;
  createdBy: string;
}

const SEED_TASKS: SeedTask[] = [
  {
    workspaceId: 'ws-planning',
    title: '秋の定例会の議題案をまとめる',
    description: '前回までの持ち越し事項を含めて議題案を作る。',
    assigneeId: 'user-member-a1',
    deadlineOffset: 7,
    status: 'in_progress',
    requirements: {
      purpose: '定例会の進行を事前に共有する',
      deliverable: '議題案（1 ページ）',
      completionCriteria: '管理役 A が確認済みであること',
    },
    createdBy: 'user-chair-a',
  },
  {
    workspaceId: 'ws-planning',
    title: '会場の候補を比較する',
    assigneeId: 'user-member-a2',
    deadlineOffset: -2,
    status: 'todo',
    requirements: { purpose: '参加人数に合う会場を選ぶ' },
    createdBy: 'user-chair-a',
  },
  {
    workspaceId: 'ws-planning',
    title: '配布資料のひな形を作る',
    status: 'todo',
    createdBy: 'user-member-a1',
  },
  {
    workspaceId: 'ws-planning',
    title: '前回の議事録を共有する',
    assigneeId: 'user-former-a3',
    deadlineOffset: -10,
    status: 'done',
    requirements: {
      purpose: '欠席者にも決定事項を伝える',
      deliverable: '議事録の共有',
      completionCriteria: '全員が閲覧できる場所に置いた',
    },
    createdBy: 'user-chair-a',
  },
  {
    workspaceId: 'ws-planning',
    title: '備品の在庫を確認する',
    assigneeId: 'user-member-a1',
    deadlineOffset: 3,
    status: 'blocked',
    requirements: { openQuestions: '在庫表の保管場所が未確認' },
    createdBy: 'user-member-a2',
  },
  {
    workspaceId: 'ws-publicity',
    title: '告知文の下書きを作る',
    assigneeId: 'user-member-b1',
    deadlineOffset: 5,
    status: 'todo',
    requirements: { purpose: '行事の日時と場所を周知する' },
    createdBy: 'user-chair-b',
  },
  {
    workspaceId: 'ws-publicity',
    title: '掲示物のサイズを決める',
    status: 'in_progress',
    createdBy: 'user-chair-b',
  },
];

export function createSeedState(now: Date): AppState {
  const today = todayInTimeZone(now);
  const at = now.toISOString();
  const tasks: Task[] = [];
  const history: HistoryEntry[] = [];

  SEED_TASKS.forEach((seed, index) => {
    const id = `task-${index + 1}`;
    const task: Task = {
      id,
      workspaceId: seed.workspaceId,
      title: seed.title,
      description: seed.description ?? '',
      assigneeId: seed.assigneeId ?? null,
      deadline: seed.deadlineOffset === undefined ? null : addDays(today, seed.deadlineOffset),
      status: seed.status,
      requirements: {
        purpose: seed.requirements?.purpose ?? '',
        deliverable: seed.requirements?.deliverable ?? '',
        completionCriteria: seed.requirements?.completionCriteria ?? '',
        openQuestions: seed.requirements?.openQuestions ?? '',
      },
      version: 1,
      createdAt: at,
      createdBy: seed.createdBy,
      updatedAt: at,
      updatedBy: seed.createdBy,
    };
    tasks.push(task);
    history.push({
      id: `hist-${index + 1}`,
      taskId: id,
      workspaceId: task.workspaceId,
      version: 1,
      action: 'created',
      actorId: seed.createdBy,
      at,
      source: 'system',
      operationId: null,
      changes: [{ field: 'title', before: null, after: task.title }],
    });
  });

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    workspaces: structuredClone(WORKSPACES),
    users: structuredClone(USERS),
    memberships: structuredClone(MEMBERSHIPS),
    tasks,
    history,
    membershipAudit: [],
    operations: [],
    mockBot: {
      channels: [
        { channelId: 'mock-channel-planning', workspaceId: 'ws-planning', name: '#企画-todo（模擬）' },
        { channelId: 'mock-channel-publicity', workspaceId: 'ws-publicity', name: '#広報-todo（模擬）' },
      ],
      accounts: USERS.map((user, index) => ({
        externalUserId: `mock-account-${String(index + 1).padStart(3, '0')}`,
        userId: user.id,
      })),
    },
    counters: { task: tasks.length, history: history.length, audit: 0 },
  };
}
