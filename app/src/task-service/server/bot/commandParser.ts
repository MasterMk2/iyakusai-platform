// 模擬 Bot のテキストコマンドを解析する。Discord のスラッシュコマンドに近い
// 「/todo <操作> 名前:値 ...」の形式を受け付ける。値には空白を含められる。

export const BOT_COMMANDS = {
  help: { required: [], optional: [] },
  list: { required: [], optional: ['status', 'assignee'] },
  show: { required: ['id'], optional: [] },
  create: { required: ['title'], optional: ['deadline', 'assignee'] },
  assign: { required: ['id', 'member'], optional: ['version'] },
  status: { required: ['id', 'to'], optional: ['version'] },
  reopen: { required: ['id'], optional: ['version'] },
  deadline: { required: ['id', 'date'], optional: ['version'] },
  require: { required: ['id', 'field', 'text'], optional: ['version'] },
} as const satisfies Record<string, { required: readonly string[]; optional: readonly string[] }>;

export type BotCommandName = keyof typeof BOT_COMMANDS;

export type ParseResult =
  | { ok: true; name: BotCommandName; args: Record<string, string> }
  | { ok: false; message: string };

const PREFIX = '/todo';

function isCommandName(value: string): value is BotCommandName {
  return Object.hasOwn(BOT_COMMANDS, value);
}

export function parseBotCommand(content: string): ParseResult {
  const trimmed = content.trim();
  if (trimmed === '') return { ok: false, message: 'コマンドが空です。「/todo help」で使い方を表示できます。' };
  if (trimmed !== PREFIX && !trimmed.startsWith(`${PREFIX} `)) {
    return { ok: false, message: '「/todo」で始まるコマンドだけを受け付けます。「/todo help」で使い方を表示できます。' };
  }
  const rest = trimmed.slice(PREFIX.length).trim();
  if (rest === '') return { ok: true, name: 'help', args: {} };

  const rawName = rest.split(/\s+/)[0] ?? '';
  const name = rawName.toLowerCase();
  if (!isCommandName(name)) {
    return { ok: false, message: `「${rawName}」は使えない操作です。「/todo help」で使い方を表示できます。` };
  }
  const argText = rest.slice(rawName.length).trim();
  const spec = BOT_COMMANDS[name];
  const allowed = new Set<string>([...spec.required, ...spec.optional]);

  const args: Record<string, string> = {};
  if (argText !== '') {
    const pattern = /(?:^|\s)([a-z]+):/g;
    const marks: Array<{ key: string; start: number; valueStart: number }> = [];
    for (let match = pattern.exec(argText); match !== null; match = pattern.exec(argText)) {
      const key = match[1] ?? '';
      if (!allowed.has(key)) continue;
      marks.push({ key, start: match.index, valueStart: match.index + match[0].length });
    }
    if (marks.length === 0 || argText.slice(0, marks[0]?.start ?? 0).trim() !== '') {
      return { ok: false, message: `引数は「名前:値」の形式で指定してください（使える名前: ${[...allowed].join(', ') || 'なし'}）。` };
    }
    for (const [index, mark] of marks.entries()) {
      const end = marks[index + 1]?.start ?? argText.length;
      if (Object.hasOwn(args, mark.key)) return { ok: false, message: `「${mark.key}」が重複しています。` };
      args[mark.key] = argText.slice(mark.valueStart, end).trim();
    }
  }
  const missing = spec.required.filter((key) => !Object.hasOwn(args, key) || (key !== 'text' && args[key] === ''));
  if (missing.length > 0) return { ok: false, message: `必要な引数がありません: ${missing.join(', ')}` };
  return { ok: true, name, args };
}

export const BOT_HELP = [
  '模擬 Bot の使い方（実際の Discord には接続していません）',
  '/todo list [status:todo|in_progress|blocked|done] [assignee:me|none|@模擬アカウント]',
  '/todo show id:task-1',
  '/todo create title:タイトル [deadline:YYYY-MM-DD] [assignee:@模擬アカウント]',
  '/todo assign id:task-1 member:@模擬アカウント|none',
  '/todo status id:task-1 to:todo|in_progress|blocked|done',
  '/todo reopen id:task-1',
  '/todo deadline id:task-1 date:YYYY-MM-DD|none',
  '/todo require id:task-1 field:purpose|deliverable|completion|questions text:内容（空で未入力に戻す）',
  '変更系の操作には version:N を付けると、その版から変わっていない場合だけ反映します。',
].join('\n');
