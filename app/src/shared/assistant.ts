// The Bot ("assistant") feature shared by the server and the screens: the browser API
// (../docs/contracts/bot-front.md §4) and the shapes of the Bot host's integration API (§3) that
// the server relays. Discord IDs are JSON strings: `1000000000000000001` is above
// Number.MAX_SAFE_INTEGER and would lose precision in JSON.parse.

export const ASSISTANT_LIMITS = {
  questionMax: 1000,
  toneMax: 100,
  docContentMax: 2000,
  imagePromptMax: 1000,
  reminderTextMax: 500,
  returnCommentMax: 1000,
  /** Largest file the browser API relays (contract §3-3 / §4). */
  fileMaxBytes: 20 * 1024 * 1024,
} as const;

export const ASK_MODELS = ['auto', 'sonnet', 'opus', 'gemini'] as const;
export const ASK_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh'] as const;
export const ASK_FORMATS = ['docx', 'md', 'txt'] as const;
export const DOC_TYPES = ['request', 'notice', 'report', 'minutes', 'mail', 'free'] as const;
export const DOC_FORMATS = ['docx', 'md', 'txt'] as const;
export const IMAGE_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
export const REMINDER_REPEATS = ['none', 'daily', 'weekly', 'monthly'] as const;
export const CANDIDATE_ACTIONS = ['ok', 'ng', 'undo', 'return'] as const;

/** taskdraft (2026-11-09): task drafting, read by the person who asked only (contract §9). */
export type AssistantJobKind = 'ask' | 'doc' | 'image' | 'remind' | 'screening' | 'taskdraft';
export type AssistantJobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
/** Jobs a browser may create (remind and screening have their own routes). */
export type BrowserJobKind = 'ask' | 'doc' | 'image';
export type ReminderRepeat = (typeof REMINDER_REPEATS)[number];
export type CandidateAction = (typeof CANDIDATE_ACTIONS)[number];

export interface AssistantNamed {
  id: string;
  name: string;
}

export interface AssistantFile {
  name: string;
  mime: string;
  size: number;
  /** Browser URL: `/api/assistant/files/<jobId>/<name>` (rewritten by the server). */
  url: string;
}

export interface AssistantReminder {
  id: number;
  text: string;
  /** ISO 8601 with +09:00. */
  due: string;
  repeat: ReminderRepeat;
  creator: AssistantNamed;
  target: AssistantNamed;
  channel: AssistantNamed | null;
  canComplete: boolean;
  canDelete: boolean;
}

export interface AssistantJobResult {
  /** Discord Markdown subset (bold, `-#` small lines, bullets, links). Rendered as text, never as HTML. */
  text: string;
  files: AssistantFile[];
  reminder?: AssistantReminder;
  message?: string;
  taskNumber?: number | null;
  /** taskdraft: the proposed tasks (checked by this server before the browser sees it). */
  draft?: TaskDraft;
}

// ---- task drafting (taskdraft, 2026-11-09, contract §9): an outline in, tasks and proposed assignees out

export const TASK_DRAFT_LIMITS = {
  overviewMax: 2000,
  /** People the Bot may propose (the Bot host's limit). */
  rosterMax: 80,
  /** Open tasks sent so the Bot does not propose the same work again (the Bot host's limit). */
  openTasksMax: 40,
  itemsMax: 10,
} as const;

/** Someone the Bot could also ask, with the counts the code (not the AI) took from the task list. */
export interface TaskDraftPerson {
  id: string;
  name: string;
  /** "企画課｜主担当 2・副担当 1・期限超過 1". */
  facts: string;
}

export interface TaskDraftItem {
  title: string;
  tags: string[];
  deadline: string | null;
  purpose: string;
  deliverable: string;
  completionCriteria: string;
  openQuestions: string;
  /** A Task user from the roster sent with the request, or null. */
  assigneeId: string | null;
  assigneeName: string | null;
  /** 'ai': the Bot chose; 'rule': the code chose (department, then fewest open tasks); null: no proposal. */
  assigneeBy: 'ai' | 'rule' | null;
  assigneeFacts: string;
  reason: string;
  helperIds: string[];
  helperNames: string[];
  alternatives: TaskDraftPerson[];
}

export interface TaskDraft {
  /** A new parent task (project) for the items, or null (one item, or drafting under an existing parent). */
  parent: TaskDraftItem | null;
  items: TaskDraftItem[];
  notes: string;
  /** Things to decide that the outline did not say. */
  questions: string[];
  /** The existing parent the items go under, when the draft was asked for from one. */
  parentTask: { id: string; title: string } | null;
  /** Committee documents the Bot read for hints. */
  sources: { label: string; excerpt: string }[];
  model?: string;
}

/** POST /api/assistant/taskdraft: the browser sends the outline; the server adds the roster and the open tasks. */
export interface TaskDraftRequest {
  clientOperationId: string;
  overview: string;
  deadline?: string | null;
  tags?: string[];
  parentId?: string | null;
  useSources?: boolean;
}

export interface AssistantJob {
  id: string;
  kind: AssistantJobKind;
  op: string | null;
  state: AssistantJobState;
  actor: AssistantNamed;
  input: Record<string, unknown>;
  progress: { phase: string; text: string } | null;
  result: AssistantJobResult | null;
  error: { code: string; message: string } | null;
  /** Discord message the job posted (ask, doc, image). Only Discord links pass through. */
  discordUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AssistantModelOption {
  id: string;
  label: string;
  ask: boolean;
  doc: boolean;
}

export interface AssistantMeta {
  /** taskdraft is absent from a Bot from before 2026-11-09 (read it as false). */
  features: { ask: boolean; doc: boolean; image: boolean; remind: boolean; screening: boolean; taskdraft?: boolean };
  models: AssistantModelOption[];
  docTypes: { id: string; label: string }[];
  reminderChannels: AssistantNamed[];
  shareChannel: AssistantNamed | null;
  isAdmin: boolean;
  bot: { alive: boolean; lastSeenAt: string | null };
  /** Added by this server (not the Bot): the committee address mail drafts put in BCC to keep a copy, from the mailbox settings. */
  mailBcc?: string;
}

/** Answer of GET /assistant/members: the people a reminder can be for (`id` is `discord-<ID>`). */
export interface AssistantMemberListResponse {
  members: AssistantNamed[];
}

export interface AssistantSummary {
  pendingCandidates: number;
  reminders: { overdue: number; today: number; upcoming7d: number };
}

export interface AssistantCandidate {
  id: number;
  state: string;
  decision: string | null;
  title: string;
  description: string;
  deadline: string | null;
  departments: string[];
  assigneeName: string | null;
  sources: { label: string; excerpt: string }[];
  taskNumber: number | null;
  discordUrl: string | null;
  createdAt: string;
  actions: CandidateAction[];
}

/** Trims the text and removes control characters except tab, CR and LF (contract §3-4). */
export function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
