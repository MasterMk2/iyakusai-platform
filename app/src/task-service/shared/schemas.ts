import { z } from 'zod';
import { isValidDateOnly } from './dates.js';
import { TEXT_MAX, TITLE_MAX } from './limits.js';
import { DEADLINE_FILTERS, REQUIREMENT_FIELDS, ROLES, TASK_STATUSES } from './types.js';

// API 入力の検証規則。サーバーが最終判定し、画面は同じ規則で事前に案内する。

export { TEXT_MAX, TITLE_MAX };

// 改行とタブ以外の制御文字を拒否する。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const noControlChars = (value: string) => !CONTROL_CHARS.test(value);

export const idSchema = z.string().regex(/^[a-z0-9-]{1,64}$/, { message: 'ID の形式が正しくありません' });

export const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,80}$/, { message: '操作 ID は英数字・ハイフン・下線の 8〜80 文字で指定してください' });

export const titleSchema = z
  .string({ message: 'タイトルを入力してください' })
  .trim()
  .min(1, { message: 'タイトルを入力してください' })
  .max(TITLE_MAX, { message: `タイトルは ${TITLE_MAX} 文字以内で入力してください` })
  .refine((value) => !/[\r\n]/.test(value), { message: 'タイトルに改行は使えません' })
  .refine(noControlChars, { message: '使用できない制御文字が含まれています' });

export const longTextSchema = z
  .string({ message: '文字列で入力してください' })
  .trim()
  .max(TEXT_MAX, { message: `${TEXT_MAX} 文字以内で入力してください` })
  .refine(noControlChars, { message: '使用できない制御文字が含まれています' });

export const deadlineSchema = z.union(
  [
    z.null(),
    z.string().refine(isValidDateOnly, { message: '期限は 2000〜2100 年の実在する日付（YYYY-MM-DD）で入力してください' }),
  ],
  { message: '期限は YYYY-MM-DD 形式の日付か、未設定（null）で指定してください' },
);

export const statusSchema = z.enum(TASK_STATUSES, { message: '状態は未着手・進行中・保留・完了のいずれかです' });
export const roleSchema = z.enum(ROLES, { message: '役割は閲覧者・編集者・管理者のいずれかです' });

const requirementShape = Object.fromEntries(REQUIREMENT_FIELDS.map((field) => [field, longTextSchema.optional()])) as Record<
  (typeof REQUIREMENT_FIELDS)[number],
  z.ZodOptional<typeof longTextSchema>
>;

export const createTaskSchema = z.strictObject({
  title: titleSchema,
  description: longTextSchema.optional(),
  assigneeId: idSchema.nullable().optional(),
  deadline: deadlineSchema.optional(),
  requirements: z.strictObject(requirementShape).optional(),
  operationId: operationIdSchema.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const taskChangesSchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: longTextSchema.optional(),
    assigneeId: idSchema.nullable().optional(),
    deadline: deadlineSchema.optional(),
    status: statusSchema.optional(),
    ...requirementShape,
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: '変更する項目を 1 つ以上指定してください',
  });
export type TaskChanges = z.infer<typeof taskChangesSchema>;

export const expectedVersionSchema = z
  .number({ message: '更新版（expectedVersion）を数値で指定してください' })
  .int()
  .min(1, { message: '更新版は 1 以上です' });

export const updateTaskSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
  operationId: operationIdSchema.optional(),
  changes: taskChangesSchema,
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const reopenTaskSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
  operationId: operationIdSchema.optional(),
});

export const updateMemberSchema = z
  .strictObject({
    role: roleSchema.optional(),
    active: z.boolean({ message: '有効・無効は true / false で指定してください' }).optional(),
    operationId: operationIdSchema.optional(),
  })
  .refine((input) => input.role !== undefined || input.active !== undefined, {
    message: '役割か有効・無効のどちらかを指定してください',
  });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const taskListQuerySchema = z.strictObject({
  status: statusSchema.optional(),
  assignee: z.union([z.literal('none'), idSchema]).optional(),
  deadline: z.enum(DEADLINE_FILTERS, { message: '期限の絞り込みは overdue / set / none のいずれかです' }).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const faultSettingsSchema = z.strictObject({
  failNextLoads: z.number().int().min(0).max(5),
  failNextSaves: z.number().int().min(0).max(5),
  delayMs: z.number().int().min(0).max(5000),
});

export const mockBotMessageSchema = z.strictObject({
  operationId: operationIdSchema,
  externalUserId: z.string().regex(/^mock-[a-z0-9-]{1,40}$/, { message: '模擬アカウント ID の形式が正しくありません' }),
  channelId: z.string().regex(/^mock-[a-z0-9-]{1,40}$/, { message: '模擬チャンネル ID の形式が正しくありません' }),
  content: z.string().max(1000, { message: 'メッセージは 1000 文字以内です' }),
});
export type MockBotMessage = z.infer<typeof mockBotMessageSchema>;

export function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
