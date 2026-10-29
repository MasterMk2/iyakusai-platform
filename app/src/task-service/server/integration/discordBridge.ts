import { z } from 'zod';
import { REQUIREMENT_LABELS } from '../../shared/labels.js';
import {
  deadlineSchema,
  formatIssues,
  idSchema,
  longTextSchema,
  operationIdSchema,
  statusSchema,
  titleSchema,
} from '../../shared/schemas.js';
import { REQUIREMENT_FIELDS, type TaskView } from '../../shared/types.js';
import { detailText, summaryLine } from '../bot/mockBotAdapter.js';
import { AppError } from '../domain/errors.js';
import type { ActorContext, TaskService } from '../domain/taskService.js';
import type { DiscordBindings } from './config.js';

// Discord 連携の本番用アダプター契約。署名済みの連携 Bot（別プロセス・Bot トークンはそちらだけが持つ）が、
// Discord で検証済みの interaction（guild・channel・利用者の各 ID）と明示的なコマンドを送る。
// ここでは対応表で委員会と内部利用者に対応付け、Web と同じ TaskService の操作を呼ぶ。
// 実際の Discord への接続・送信はこのサービスでは行わない。

const snowflake = z.string().regex(/^[1-9]\d{16,19}$/, { message: 'Discord の ID 形式ではありません' });
const memberRef = z.union([z.literal('me'), z.literal('none'), snowflake]);
// 既存タスクを変更するコマンドは、Web と同じく確認済みの版（version）が必須。省略・数値以外・小数・0 以下は
// どれも同じ VALIDATION エラーにし、タスクを読む前に拒否する（版が古ければ 409 VERSION_CONFLICT）。
export const DISCORD_VERSION_MESSAGE = '変更コマンドには、表示中のタスクの版（1 以上の整数の version）が必要です';
const version = z.number({ message: DISCORD_VERSION_MESSAGE }).refine((v) => Number.isSafeInteger(v) && v >= 1, { message: DISCORD_VERSION_MESSAGE });

export const discordCommandSchema = z.strictObject({
  /** Discord の interaction ID。操作 ID として再配信の判定に使う。 */
  interactionId: operationIdSchema,
  guildId: snowflake,
  channelId: snowflake,
  /** Discord が検証した操作者の利用者 ID（表示名ではない）。 */
  userId: snowflake,
  command: z.discriminatedUnion('name', [
    z.strictObject({ name: z.literal('list'), status: statusSchema.optional(), assignee: memberRef.optional() }),
    z.strictObject({ name: z.literal('show'), taskId: idSchema }),
    z.strictObject({ name: z.literal('create'), title: titleSchema, assignee: memberRef.optional(), deadline: deadlineSchema.optional() }),
    z.strictObject({ name: z.literal('assign'), taskId: idSchema, assignee: memberRef, version }),
    z.strictObject({ name: z.literal('status'), taskId: idSchema, to: statusSchema, version }),
    z.strictObject({ name: z.literal('deadline'), taskId: idSchema, date: deadlineSchema, version }),
    z.strictObject({ name: z.literal('require'), taskId: idSchema, field: z.enum(REQUIREMENT_FIELDS), text: longTextSchema, version }),
    z.strictObject({ name: z.literal('reopen'), taskId: idSchema, version }),
  ]),
});
export type DiscordCommand = z.infer<typeof discordCommandSchema>;

export interface DiscordCommandResult {
  ok: true;
  replayed: boolean;
  /** 連携 Bot がそのまま返信に使える日本語テキスト。 */
  reply: string;
  task?: TaskView;
  tasks?: TaskView[];
}

const NOT_LINKED = 'この Discord チャンネルまたは利用者は委員会タスクに連携されていません。';

export class DiscordBridge {
  constructor(
    private readonly service: TaskService,
    private readonly bindings: DiscordBindings,
  ) {}

  async handle(input: unknown): Promise<DiscordCommandResult> {
    const parsed = discordCommandSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION', 'Discord コマンドの形式が正しくありません。', { details: formatIssues(parsed.error) });
    const { interactionId, guildId, channelId, userId, command } = parsed.data;
    // 対応表にない guild/channel・利用者は、存在の有無を区別せずに拒否する。
    const workspaceId = this.bindings.channels.get(guildId)?.get(channelId);
    const actorId = this.bindings.users.get(userId);
    if (!workspaceId || !actorId) throw new AppError('FORBIDDEN', NOT_LINKED);

    const ctx: ActorContext = {
      actorId,
      source: 'discord',
      operationId: interactionId,
      scopeWorkspaceId: workspaceId,
      scopeKey: `discord:${guildId}:${channelId}`,
    };
    const member = (ref: 'me' | 'none' | string): string | null => {
      if (ref === 'none') return null;
      if (ref === 'me') return actorId;
      const mapped = this.bindings.users.get(ref);
      if (!mapped) throw new AppError('VALIDATION', '指定した Discord 利用者は連携されていません。', { details: [{ path: 'assignee', message: '連携されていない利用者です' }] });
      return mapped;
    };

    // 変更は Web と同じ版付きの入口（expectedVersion 必須）を通す。
    const update = (taskId: string, expectedVersion: number, changes: Record<string, unknown>) =>
      this.service.updateTask(ctx, taskId, { expectedVersion, changes });

    switch (command.name) {
      case 'list': {
        const assignee = command.assignee === undefined ? undefined : (member(command.assignee) ?? 'none');
        const tasks = await this.service.listTasks(actorId, workspaceId, { status: command.status, assignee });
        return { ok: true, replayed: false, reply: tasks.length === 0 ? '該当するタスクはありません。' : tasks.map(summaryLine).join('\n'), tasks };
      }
      case 'show': {
        const task = await this.service.getTask(actorId, command.taskId, workspaceId);
        return { ok: true, replayed: false, reply: detailText(task), task };
      }
      case 'create': {
        const result = await this.service.createTask(ctx, workspaceId, {
          title: command.title,
          ...(command.deadline !== undefined ? { deadline: command.deadline } : {}),
          ...(command.assignee !== undefined ? { assigneeId: member(command.assignee) } : {}),
        });
        return reply('作成しました', result);
      }
      case 'assign':
        return reply('担当者を更新しました', await update(command.taskId, command.version, { assigneeId: member(command.assignee) }));
      case 'status':
        return reply('状態を更新しました', await update(command.taskId, command.version, { status: command.to }));
      case 'deadline':
        return reply('期限を更新しました', await update(command.taskId, command.version, { deadline: command.date }));
      case 'require':
        return reply(`${REQUIREMENT_LABELS[command.field]}を更新しました`, await update(command.taskId, command.version, { [command.field]: command.text }));
      case 'reopen':
        return reply('再開しました', await this.service.reopenTask(ctx, command.taskId, { expectedVersion: command.version }));
    }
  }
}

function reply(action: string, result: { task: TaskView; replayed: boolean }): DiscordCommandResult {
  const head = result.replayed ? '（再配信を検出しました。この interaction はすでに処理済みのため、再実行していません）' : `✅ ${action}。`;
  return { ok: true, replayed: result.replayed, reply: `${head}\n${summaryLine(result.task)}\n版: ${result.task.version}`, task: result.task };
}
