import { formatDateOnly } from '../../shared/dates.js';
import { REQUIREMENT_LABELS, STATUS_LABELS } from '../../shared/labels.js';
import { formatIssues, mockBotMessageSchema } from '../../shared/schemas.js';
import {
  REQUIREMENT_FIELDS,
  TASK_STATUSES,
  type MockBotReply,
  type RequirementField,
  type TaskStatus,
  type TaskView,
} from '../../shared/types.js';
import { AppError } from '../domain/errors.js';
import type { ActorContext, TaskService } from '../domain/taskService.js';
import { BOT_HELP, parseBotCommand } from './commandParser.js';

const FIELD_ALIASES: Record<string, RequirementField> = {
  purpose: 'purpose',
  deliverable: 'deliverable',
  completion: 'completionCriteria',
  completioncriteria: 'completionCriteria',
  questions: 'openQuestions',
  openquestions: 'openQuestions',
};

const STATUS_ALIASES: Record<string, TaskStatus> = {
  ...Object.fromEntries(TASK_STATUSES.map((status) => [status, status])),
  ...Object.fromEntries(TASK_STATUSES.map((status) => [STATUS_LABELS[status], status])),
};

class BotInputError extends Error {}

/**
 * 模擬 Bot の入出力アダプター。テキストコマンドを共通の TaskService 操作に変換し、
 * 結果をテキストの返信にする。実際の Discord には接続せず、外部の履歴や認証情報も読まない。
 * チャンネルと外部アカウントの対応は、サンプルデータ内の架空の対応表だけを使う。
 */
export class MockBotAdapter {
  constructor(private readonly service: TaskService) {}

  async handle(message: unknown): Promise<MockBotReply> {
    const parsedMessage = mockBotMessageSchema.safeParse(message);
    if (!parsedMessage.success) {
      throw new AppError('VALIDATION', '模擬 Bot への入力が正しくありません。', {
        details: formatIssues(parsedMessage.error),
      });
    }
    const { operationId, externalUserId, channelId, content } = parsedMessage.data;
    const directory = this.service.mockBotDirectory();
    const channel = directory.channels.find((candidate) => candidate.channelId === channelId);
    if (!channel) return failure('このチャンネルは模擬 Bot に登録されていません。');
    const account = directory.accounts.find((candidate) => candidate.externalUserId === externalUserId);
    if (!account) return failure('この模擬アカウントは内部の利用者に対応付けられていません。');

    const command = parseBotCommand(content);
    if (!command.ok) return failure(command.message);

    const ctx: ActorContext = {
      actorId: account.userId,
      source: 'mock-bot',
      operationId,
      scopeWorkspaceId: channel.workspaceId,
    };
    try {
      return await this.dispatch(ctx, channel.workspaceId, command.name, command.args, directory.accounts);
    } catch (error) {
      if (error instanceof BotInputError) return failure(error.message);
      if (error instanceof AppError) {
        const details = error.options.details?.map((detail) => `・${detail.message}`).join('\n');
        return failure(details ? `${error.message}\n${details}` : error.message);
      }
      throw error;
    }
  }

  private async dispatch(
    ctx: ActorContext,
    workspaceId: string,
    name: string,
    args: Record<string, string>,
    accounts: Array<{ externalUserId: string; userId: string }>,
  ): Promise<MockBotReply> {
    const resolveAccount = (value: string): string | null => {
      if (value === 'none') return null;
      if (value === 'me') return ctx.actorId;
      const externalId = value.replace(/^@/, '');
      const account = accounts.find((candidate) => candidate.externalUserId === externalId);
      if (!account) throw new BotInputError(`模擬アカウント「${value}」は登録されていません。`);
      return account.userId;
    };
    const version = parseVersion(args.version);
    const id = args.id ?? '';

    switch (name) {
      case 'help':
        return { ok: true, replayed: false, reply: BOT_HELP };
      case 'list': {
        const assignee = args.assignee === undefined ? undefined : (resolveAccount(args.assignee) ?? 'none');
        const status = args.status === undefined ? undefined : parseStatus(args.status);
        const tasks = await this.service.listTasks(ctx.actorId, workspaceId, { status, assignee });
        const reply = tasks.length === 0 ? '該当するタスクはありません。' : tasks.map(summaryLine).join('\n');
        return { ok: true, replayed: false, reply };
      }
      case 'show': {
        const task = await this.service.getTask(ctx.actorId, id, workspaceId);
        return { ok: true, replayed: false, reply: detailText(task) };
      }
      case 'create': {
        const input = {
          title: args.title,
          deadline: args.deadline === undefined ? undefined : parseDeadline(args.deadline),
          assigneeId: args.assignee === undefined ? undefined : resolveAccount(args.assignee),
        };
        const result = await this.service.createTask(ctx, workspaceId, input);
        return mutationReply('作成しました', result);
      }
      case 'assign': {
        const result = await this.service.updateTaskUnversioned(ctx, id, { assigneeId: resolveAccount(args.member ?? '') }, version);
        return mutationReply('担当者を更新しました', result);
      }
      case 'status': {
        const result = await this.service.updateTaskUnversioned(ctx, id, { status: parseStatus(args.to ?? '') }, version);
        return mutationReply('状態を更新しました', result);
      }
      case 'reopen': {
        const result = await this.service.reopenTaskUnversioned(ctx, id, version);
        return mutationReply('再開しました', result);
      }
      case 'deadline': {
        const result = await this.service.updateTaskUnversioned(ctx, id, { deadline: parseDeadline(args.date ?? '') }, version);
        return mutationReply('期限を更新しました', result);
      }
      case 'require': {
        const field = lookup(FIELD_ALIASES, (args.field ?? '').toLowerCase());
        if (!field) throw new BotInputError('field には purpose / deliverable / completion / questions のいずれかを指定してください。');
        const result = await this.service.updateTaskUnversioned(ctx, id, { [field]: args.text ?? '' }, version);
        return mutationReply(`${REQUIREMENT_LABELS[field]}を更新しました`, result);
      }
      default:
        throw new BotInputError('使えない操作です。');
    }
  }
}

function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function failure(message: string): MockBotReply {
  return { ok: false, replayed: false, reply: `⚠ ${message}` };
}

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new BotInputError('version には 1 以上の整数を指定してください。');
  return Number(value);
}

function parseStatus(value: string): TaskStatus {
  const status = lookup(STATUS_ALIASES, value);
  if (!status) throw new BotInputError('状態は todo / in_progress / blocked / done（または 未着手 / 進行中 / 保留 / 完了）で指定してください。');
  return status;
}

function parseDeadline(value: string): string | null {
  return value === 'none' ? null : value;
}

export function summaryLine(task: TaskView): string {
  const assignee = task.assignee ? task.assignee.displayName : '未割当';
  const overdue = task.overdue ? '・期限超過' : '';
  return `${task.id} [${STATUS_LABELS[task.status]}] ${task.title}（担当: ${assignee}／期限: ${formatDateOnly(task.deadline)}${overdue}）`;
}

export function detailText(task: TaskView): string {
  const lines = [summaryLine(task), `版: ${task.version}`];
  for (const field of REQUIREMENT_FIELDS) {
    const value = task.requirements[field];
    lines.push(`${REQUIREMENT_LABELS[field]}: ${value === '' ? '（未入力）' : value}`);
  }
  return lines.join('\n');
}

function mutationReply(action: string, result: { task: TaskView; replayed: boolean }): MockBotReply {
  const head = result.replayed
    ? '（重複配信を検出しました。この操作 ID はすでに処理済みのため、再実行していません）'
    : `✅ ${action}。`;
  return { ok: true, replayed: result.replayed, reply: `${head}\n${summaryLine(result.task)}\n版: ${result.task.version}` };
}
