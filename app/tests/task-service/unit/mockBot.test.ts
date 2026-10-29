import { describe, expect, it } from 'vitest';
import { parseBotCommand } from '../../../src/task-service/server/bot/commandParser.js';
import { MockBotAdapter } from '../../../src/task-service/server/bot/mockBotAdapter.js';
import { AppError } from '../../../src/task-service/server/domain/errors.js';
import { setup } from '../helpers.js';

// 模擬アカウントはサンプルの利用者の並び順に対応する（seed.ts）。
const ACCOUNT_EDITOR_A1 = 'mock-account-002';
const ACCOUNT_EDITOR_A2 = 'mock-account-003';
const ACCOUNT_VIEWER_A = 'mock-account-004';
const ACCOUNT_EDITOR_B1 = 'mock-account-007';
const CHANNEL_A = 'mock-channel-planning';
const CHANNEL_B = 'mock-channel-publicity';

let counter = 0;
const message = (content: string, overrides: Partial<{ externalUserId: string; channelId: string; operationId: string }> = {}) => ({
  operationId: `bot-op-${String((counter += 1)).padStart(6, '0')}`,
  externalUserId: ACCOUNT_EDITOR_A1,
  channelId: CHANNEL_A,
  content,
  ...overrides,
});

async function setupBot() {
  const { service } = await setup();
  return { service, bot: new MockBotAdapter(service) };
}

describe('模擬 Bot コマンドの解析', () => {
  it('名前:値 の引数を空白込みで読み取る', () => {
    expect(parseBotCommand('/todo create title:会場 の 下見 deadline:2026-11-01')).toEqual({
      ok: true,
      name: 'create',
      args: { title: '会場 の 下見', deadline: '2026-11-01' },
    });
    expect(parseBotCommand('/todo')).toEqual({ ok: true, name: 'help', args: {} });
    expect(parseBotCommand('/todo require id:task-1 field:purpose text:')).toMatchObject({
      ok: true,
      args: { id: 'task-1', field: 'purpose', text: '' },
    });
  });

  it.each([
    ['', 'コマンドが空'],
    ['hello', '「/todo」で始まる'],
    ['/todos list', '「/todo」で始まる'],
    ['/todo delete id:task-1', '使えない操作'],
    ['/todo status id:task-1', '必要な引数'],
    ['/todo status task-1 done', '名前:値'],
    ['/todo show id:task-1 id:task-2', '重複'],
    ['/todo create title:', '必要な引数'],
  ])('不正なコマンド %j を説明付きで拒否する', (content, expected) => {
    const result = parseBotCommand(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(expected);
  });
});

describe('模擬 Bot アダプター', () => {
  it('共通操作でタスクを作成し、重複配信では再実行しない', async () => {
    const { service, bot } = await setupBot();
    const first = message('/todo create title:Bot から作成 deadline:2026-10-31');
    const reply = await bot.handle(first);
    expect(reply).toMatchObject({ ok: true, replayed: false });
    expect(reply.reply).toContain('作成しました');
    const duplicate = await bot.handle({ ...first });
    expect(duplicate).toMatchObject({ ok: true, replayed: true });
    expect(duplicate.reply).toContain('重複配信');
    const tasks = await service.listTasks('user-member-a1', 'ws-planning');
    const created = tasks.filter((task) => task.title === 'Bot から作成');
    expect(created).toHaveLength(1);
    const history = await service.getHistory('user-member-a1', created[0]!.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ source: 'mock-bot', operationId: first.operationId });
  });

  it('同じ操作 ID で内容が異なる場合は拒否する', async () => {
    const { bot } = await setupBot();
    const first = message('/todo status id:task-3 to:in_progress');
    await bot.handle(first);
    const reused = await bot.handle({ ...first, content: '/todo status id:task-3 to:blocked' });
    expect(reused.ok).toBe(false);
    expect(reused.reply).toContain('同じ操作 ID');
  });

  it('別チャンネルで同じ操作 ID を再送しても、他チャンネルのタスクを返さず履歴も変えない', async () => {
    const { service, bot } = await setupBot();
    const first = message('/todo status id:task-1 to:blocked', { operationId: 'coordinator-scope-replay-001' });
    expect(await bot.handle(first)).toMatchObject({ ok: true, replayed: false });
    const historyBefore = await service.getHistory('user-member-a1', 'task-1');
    const taskBefore = await service.getTask('user-member-a1', 'task-1');

    const crossChannel = await bot.handle({ ...first, channelId: CHANNEL_B });
    expect(crossChannel).toMatchObject({ ok: false, replayed: false });
    expect(crossChannel.reply).not.toContain('task-1');
    expect(await service.getHistory('user-member-a1', 'task-1')).toEqual(historyBefore);
    expect(await service.getTask('user-member-a1', 'task-1')).toEqual(taskBefore);

    // 元のチャンネルでの重複配信は、引き続き再実行せずに処理済みとして返す。
    const sameChannel = await bot.handle({ ...first });
    expect(sameChannel).toMatchObject({ ok: true, replayed: true });
    expect(sameChannel.reply).toContain('task-1');
    expect(await service.getHistory('user-member-a1', 'task-1')).toEqual(historyBefore);
  });

  it('割当・状態・期限・要件・再開を操作できる', async () => {
    const { service, bot } = await setupBot();
    expect((await bot.handle(message(`/todo assign id:task-3 member:@${ACCOUNT_EDITOR_A2}`))).ok).toBe(true);
    expect((await bot.handle(message('/todo status id:task-3 to:進行中'))).ok).toBe(true);
    expect((await bot.handle(message('/todo deadline id:task-3 date:2026-12-01'))).ok).toBe(true);
    expect((await bot.handle(message('/todo require id:task-3 field:completion text:印刷して配布'))).ok).toBe(true);
    expect((await bot.handle(message('/todo status id:task-3 to:done'))).ok).toBe(true);
    expect((await bot.handle(message('/todo reopen id:task-3'))).ok).toBe(true);
    expect((await bot.handle(message('/todo assign id:task-3 member:none'))).ok).toBe(true);
    expect((await bot.handle(message('/todo deadline id:task-3 date:none'))).ok).toBe(true);
    const task = await service.getTask('user-member-a1', 'task-3');
    expect(task).toMatchObject({ status: 'todo', assigneeId: null, deadline: null });
    expect(task.requirements.completionCriteria).toBe('印刷して配布');
    expect(await service.getHistory('user-member-a1', 'task-3')).toHaveLength(9);
  });

  it('一覧と詳細を返し、未入力の要件を示す', async () => {
    const { bot } = await setupBot();
    const list = await bot.handle(message('/todo list assignee:me'));
    expect(list.reply.split('\n')).toHaveLength(2);
    const blocked = await bot.handle(message('/todo list status:blocked'));
    expect(blocked.reply).toContain('task-5');
    const detail = await bot.handle(message('/todo show id:task-3'));
    expect(detail.reply).toContain('目的: （未入力）');
    const empty = await bot.handle(message('/todo list status:done assignee:none'));
    expect(empty.reply).toBe('該当するタスクはありません。');
  });

  it('チャンネルの委員会外のタスクや権限のない操作を拒否する', async () => {
    const { bot } = await setupBot();
    // 委員 A1 は広報委員会を閲覧できるが、企画チャンネルから広報のタスクは扱えない。
    const crossChannel = await bot.handle(message('/todo show id:task-6'));
    expect(crossChannel).toMatchObject({ ok: false });
    expect(crossChannel.reply).toContain('見つからない');
    // 広報チャンネルでは閲覧者のため変更できない。
    const viewerChange = await bot.handle(message('/todo status id:task-6 to:done', { channelId: CHANNEL_B }));
    expect(viewerChange.reply).toContain('閲覧者は変更できません');
    expect((await bot.handle(message('/todo show id:task-6', { channelId: CHANNEL_B }))).ok).toBe(true);
    // 所属していない委員会のチャンネル。
    const outsider = await bot.handle(message('/todo list', { externalUserId: ACCOUNT_EDITOR_B1 }));
    expect(outsider.reply).toContain('権限がありません');
    const viewer = await bot.handle(message('/todo create title:閲覧者の作成', { externalUserId: ACCOUNT_VIEWER_A }));
    expect(viewer.ok).toBe(false);
  });

  it('未登録のチャンネル・アカウントと不正な値を説明付きで拒否する', async () => {
    const { bot } = await setupBot();
    expect((await bot.handle(message('/todo list', { channelId: 'mock-channel-unknown' }))).reply).toContain('登録されていません');
    expect((await bot.handle(message('/todo list', { externalUserId: 'mock-account-999' }))).reply).toContain('対応付けられていません');
    expect((await bot.handle(message('/todo assign id:task-3 member:@mock-account-999'))).reply).toContain('登録されていません');
    expect((await bot.handle(message('/todo status id:task-3 to:constructor'))).reply).toContain('状態は');
    expect((await bot.handle(message('/todo require id:task-3 field:__proto__ text:x'))).reply).toContain('field には');
    expect((await bot.handle(message('/todo deadline id:task-3 date:2026-13-01'))).reply).toContain('実在する日付');
    expect((await bot.handle(message('/todo status id:task-1 to:blocked version:9'))).reply).toContain('先に更新されています');
    expect((await bot.handle(message('/todo status id:task-1 to:blocked version:abc'))).reply).toContain('version');
  });

  it('メッセージ形式が正しくない場合は入力エラーにする', async () => {
    const { bot } = await setupBot();
    await expect(bot.handle({ content: '/todo list' })).rejects.toBeInstanceOf(AppError);
    await expect(bot.handle(message('/todo list', { operationId: 'short' }))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(bot.handle(message('/todo list', { externalUserId: '123456789012345678' }))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('保存に失敗した操作は再送で適用できる', async () => {
    const { service, bot } = await setupBot();
    service.faults.set({ failNextLoads: 0, failNextSaves: 1, delayMs: 0 });
    const first = message('/todo status id:task-3 to:blocked');
    const failed = await bot.handle(first);
    expect(failed.ok).toBe(false);
    expect(failed.reply).toContain('保存に失敗');
    const retried = await bot.handle({ ...first });
    expect(retried).toMatchObject({ ok: true, replayed: false });
    expect((await service.getTask('user-member-a1', 'task-3')).status).toBe('blocked');
  });
});
