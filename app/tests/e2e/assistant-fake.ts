import type { Page, Route } from '@playwright/test';

// TEST-ONLY stateful fake of the Bot browser API (/api/assistant/*, ../docs/contracts/bot-front.md §4),
// installed on the page. It answers with the contract's shapes and synthetic data only: a job moves from
// queued to running to done over two looks, reminders and candidates change as the user acts. The server
// side is covered by tests/api/assistant.test.ts; this fake lets the screens run without a Bot host.

// A 1x1 transparent PNG (synthetic picture).
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export interface BotFakeOptions {
  /** Bot host answers (meta.bot.alive). */
  alive?: boolean;
  /** Feature switches in meta.features. */
  features?: Partial<{ ask: boolean; doc: boolean; image: boolean; remind: boolean; screening: boolean }>;
  /** When set, every /api/assistant/* request answers this status (for the failure states). */
  failAll?: { status: number; body: unknown };
  /** Answer of GET /assistant/summary. */
  summary?: unknown;
}

interface FakeJob {
  id: string;
  kind: 'ask' | 'doc' | 'image';
  state: 'queued' | 'running' | 'done' | 'canceled';
  polls: number;
  input: Record<string, unknown>;
  actor: { id: string; name: string };
  createdAt: string;
  result: { text: string; files: { name: string; mime: string; size: number; url: string }[]; message?: string } | null;
  progress: { phase: string; text: string } | null;
  discordUrl: string | null;
  error: null;
  startedAt: null;
  finishedAt: null;
  op: null;
}

interface FakeReminder {
  id: number;
  text: string;
  due: string;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly';
  creator: { id: string; name: string };
  target: { id: string; name: string };
  channel: { id: string; name: string } | null;
  canComplete: boolean;
  canDelete: boolean;
}

interface FakeCandidate {
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
  actions: ('ok' | 'ng' | 'undo' | 'return')[];
}

export interface BotFake {
  /** Requests that reached the fake, as "METHOD path" (query included). */
  calls: string[];
  jobs: Map<string, FakeJob>;
  reminders: FakeReminder[];
  candidates: FakeCandidate[];
}

/** Today in Japan as YYYY-MM-DD, computed at test time (the screens compare with the browser's clock). */
export function jstTodayForTest(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

const ANSWER = [
  '-# 参照: 会場案内（合成データ）',
  '**受付は 9:00 から** です。',
  '- 入口は北門',
  '- 詳しくは [案内ページ](https://example.org/guide) を見てください。',
  '<b>これは太字にならない</b>',
].join('\n');

// A mail draft as the Bot returns it for a /doc job of docType mail: its notes, then the draft (synthetic).
export const MAIL_SUBJECT = '発電機お見積りのお願い（医学薬学祭実行委員会）';
export const MAIL_BODY = ['株式会社サンプル', '【担当者名】様', '', 'いつもお世話になっております。', '発電機 3 台のお見積りをお願いいたします。', '', '医学薬学祭実行委員会', '【氏名】'].join('\n');
const MAIL_ANSWER = [`✉️ **${MAIL_SUBJECT}**(メールの草案)`, '-# 要記入: 【担当者名】 【氏名】', '-# model: sonnet / 100+50 tokens', '', `件名：${MAIL_SUBJECT}`, '', MAIL_BODY].join('\n');

export async function installBotFake(page: Page, options: BotFakeOptions = {}): Promise<BotFake> {
  const today = jstTodayForTest();
  const features = { ask: true, doc: true, image: true, remind: true, screening: true, ...options.features };
  const fake: BotFake = {
    calls: [],
    jobs: new Map(),
    reminders: [
      { id: 11, text: '資料を印刷する', due: '2000-01-01T09:00:00+09:00', repeat: 'none', creator: { id: 'discord-1000000000000000001', name: '編集担当A' }, target: { id: 'discord-1000000000000000001', name: '編集担当A' }, channel: { id: '1000000000000000001', name: 'bot-reminders' }, canComplete: true, canDelete: true },
      { id: 12, text: '会場の鍵を受け取る', due: `${today}T23:59:00+09:00`, repeat: 'weekly', creator: { id: 'discord-1000000000000000001', name: '編集担当A' }, target: { id: 'discord-1000000000000000001', name: '編集担当A' }, channel: { id: '1000000000000000001', name: 'bot-reminders' }, canComplete: true, canDelete: false },
    ],
    candidates: [
      { id: 3, state: 'posted', decision: null, title: '会場の備品を確認する', description: '会場課と備品の数を照合する。', deadline: '2026-10-20', departments: ['kaijo'], assigneeName: '編集担当A', sources: [{ label: '議事録（合成）', excerpt: '備品の数を確認する。' }], taskNumber: null, discordUrl: 'https://discord.com/channels/1000000000000000010/1000000000000000011/1000000000000000012', createdAt: '2026-10-14T05:00:00+09:00', actions: ['ok', 'ng', 'return'] },
      { id: 4, state: 'created', decision: 'auto', title: '看板の掲示を依頼する', description: '看板の位置を決める。', deadline: null, departments: [], assigneeName: null, sources: [], taskNumber: 57, discordUrl: null, createdAt: '2026-10-14T05:00:00+09:00', actions: ['undo', 'return'] },
    ],
  };
  // One answered question from earlier, for the similar-question list.
  const earlier: FakeJob = {
    id: 'j_00000000000000000001',
    kind: 'ask',
    state: 'done',
    polls: 9,
    input: { question: '会場の受付時間を教えて' },
    actor: { id: 'discord-1000000000000000002', name: '編集担当C' },
    createdAt: '2026-10-13T10:00:00+09:00',
    result: { text: '受付は 9:00 からです。', files: [], message: undefined },
    progress: null,
    discordUrl: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    op: null,
  };
  fake.jobs.set(earlier.id, earlier);
  let seq = 1;

  const meta = () => ({
    features,
    models: [
      { id: 'auto', label: '自動', ask: true, doc: true },
      { id: 'sonnet', label: 'Claude Sonnet', ask: true, doc: true },
      { id: 'gemini', label: 'Gemini', ask: false, doc: false },
    ],
    docTypes: [
      { id: 'request', label: '依頼文（対外）' },
      { id: 'notice', label: 'お知らせ' },
    ],
    reminderChannels: [
      { id: '1000000000000000001', name: 'bot-reminders' },
      { id: '1000000000000000002', name: 'bottest' },
    ],
    shareChannel: { id: '1000000000000000002', name: 'bottest' },
    isAdmin: false,
    bot: { alive: options.alive ?? true, lastSeenAt: options.alive === false ? null : '2026-10-14T05:00:00+09:00' },
  });
  const jobView = (job: FakeJob) => ({
    id: job.id,
    kind: job.kind,
    op: null,
    state: job.state,
    actor: job.actor,
    input: job.input,
    progress: job.progress,
    result: job.result,
    error: null,
    discordUrl: job.discordUrl,
    createdAt: job.createdAt,
    startedAt: null,
    finishedAt: null,
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

  await page.route('**/api/assistant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/assistant', '');
    const method = request.method();
    fake.calls.push(`${method} ${path}${url.search}`);
    if (options.failAll) return json(route, options.failAll.body, options.failAll.status);

    if (method === 'GET' && path === '/meta') return json(route, meta());
    if (method === 'GET' && path === '/summary') {
      return json(route, options.summary ?? { pendingCandidates: 2, reminders: { overdue: 1, today: 1, upcoming7d: 3 } });
    }
    if (method === 'GET' && path === '/members') return json(route, { members: [{ id: 'discord-1000000000000000002', name: '編集担当C' }] });
    if (method === 'GET' && path === '/similar') {
      const q = url.searchParams.get('q') ?? '';
      const hits = [...fake.jobs.values()].filter((j) => j.kind === 'ask' && j.state === 'done' && q.length >= 2 && String(j.input.question).includes(q.slice(0, 2)));
      return json(route, { jobs: hits.map((job) => ({ job: jobView(job), score: 0.6 })) });
    }
    if (method === 'POST' && path === '/jobs') {
      const body = request.postDataJSON() as { kind: 'ask' | 'doc' | 'image'; input: Record<string, unknown> };
      const id = `j_${String(seq++).padStart(20, '0')}`;
      const job: FakeJob = {
        id,
        kind: body.kind,
        state: 'queued',
        polls: 0,
        input: body.input,
        actor: { id: 'discord-1000000000000000001', name: '編集担当A' },
        createdAt: '2026-10-14T06:00:00+09:00',
        result: null,
        progress: null,
        discordUrl: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        op: null,
      };
      fake.jobs.set(id, job);
      return json(route, { job: jobView(job) }, 202);
    }
    const jobMatch = /^\/jobs\/(j_[a-z0-9]{20})$/.exec(path);
    if (method === 'GET' && jobMatch) {
      const job = fake.jobs.get(jobMatch[1]!);
      if (!job) return json(route, { error: { code: 'NOT_FOUND', message: '依頼が見つかりません。' } }, 404);
      job.polls += 1;
      if (job.state === 'queued' || job.state === 'running') {
        if (job.polls >= 2) {
          job.state = 'done';
          job.progress = null;
          job.result =
            job.kind === 'ask'
              ? { text: ANSWER, files: [] }
              : job.kind === 'doc' && job.input.docType === 'mail'
                ? { text: MAIL_ANSWER, files: [{ name: 'メール.txt', mime: 'text/plain; charset=utf-8', size: 120, url: `/api/assistant/files/${job.id}/${encodeURIComponent('メール.txt')}` }] }
                : job.kind === 'doc'
                ? { text: '文書の本文です。', files: [{ name: '文書.md', mime: 'text/markdown; charset=utf-8', size: 42, url: `/api/assistant/files/${job.id}/${encodeURIComponent('文書.md')}` }] }
                : { text: '', files: [{ name: 'image.png', mime: 'image/png', size: PNG_1X1.length, url: `/api/assistant/files/${job.id}/image.png` }], message: undefined };
        } else {
          job.state = 'running';
          job.progress = { phase: 'search', text: '資料を検索しています…' };
        }
      }
      return json(route, { job: jobView(job) });
    }
    if (method === 'GET' && path === '/jobs') {
      const mine = url.searchParams.get('mine') === '1';
      const jobs = [...fake.jobs.values()].filter((j) => (mine ? j.actor.id === 'discord-1000000000000000001' && (j.state === 'queued' || j.state === 'running') : true));
      return json(route, { jobs: jobs.map(jobView).reverse(), next: null });
    }
    const cancelMatch = /^\/jobs\/(j_[a-z0-9]{20})\/cancel$/.exec(path);
    if (method === 'POST' && cancelMatch) {
      const job = fake.jobs.get(cancelMatch[1]!)!;
      job.state = 'canceled';
      return json(route, { job: jobView(job) });
    }
    const fileMatch = /^\/files\/(j_[a-z0-9]{20})\/(.+)$/.exec(path);
    if (method === 'GET' && fileMatch) {
      const name = decodeURIComponent(fileMatch[2]!);
      const mime = name.endsWith('.png') ? 'image/png' : 'text/markdown; charset=utf-8';
      return route.fulfill({ status: 200, contentType: mime, body: name.endsWith('.png') ? PNG_1X1 : Buffer.from('文書の本文です。', 'utf8') });
    }
    if (method === 'GET' && path === '/reminders') {
      return json(route, { reminders: fake.reminders, snapshotAt: new Date(Date.now() - 60_000).toISOString().replace('Z', '+00:00') });
    }
    if (method === 'POST' && path === '/reminders') {
      const body = request.postDataJSON() as { text: string; due: string; repeat?: FakeReminder['repeat'] };
      const reminder: FakeReminder = {
        id: 20 + fake.reminders.length,
        text: body.text,
        due: body.due,
        repeat: body.repeat ?? 'none',
        creator: { id: 'discord-1000000000000000001', name: '編集担当A' },
        target: { id: 'discord-1000000000000000001', name: '編集担当A' },
        channel: { id: '1000000000000000001', name: 'bot-reminders' },
        canComplete: true,
        canDelete: true,
      };
      fake.reminders.push(reminder);
      const job = { ...jobView({ ...earlier, id: `j_${String(seq++).padStart(20, '0')}`, kind: 'ask', input: {}, result: null, state: 'done', polls: 0, progress: null, discordUrl: null, error: null, startedAt: null, finishedAt: null, op: null, actor: earlier.actor, createdAt: '2026-10-14T06:00:00+09:00' }), kind: 'remind' as never, op: 'create', result: { text: '', files: [], message: 'リマインドを登録しました。', reminder } };
      return json(route, { job });
    }
    const reminderAction = /^\/reminders\/(\d+)\/(done|delete)$/.exec(path);
    if (method === 'POST' && reminderAction) {
      const id = Number(reminderAction[1]);
      fake.reminders = fake.reminders.filter((r) => r.id !== id);
      const message = reminderAction[2] === 'done' ? '完了にしました。' : '削除しました。';
      return json(route, { job: { ...jobView({ ...earlier, id: `j_${String(seq++).padStart(20, '0')}`, kind: 'ask', input: {}, result: null, state: 'done', polls: 0, progress: null, discordUrl: null, error: null, startedAt: null, finishedAt: null, op: null, actor: earlier.actor, createdAt: '2026-10-14T06:00:00+09:00' }), kind: 'remind' as never, op: reminderAction[2], result: { text: '', files: [], message } } });
    }
    if (method === 'GET' && path === '/candidates') {
      const state = url.searchParams.get('state') ?? 'open';
      return json(route, { candidates: fake.candidates.filter((c) => state === 'recent' || c.actions.length > 0) });
    }
    const candidateAction = /^\/candidates\/(\d+)\/(ok|ng|undo|return)$/.exec(path);
    if (method === 'POST' && candidateAction) {
      const id = Number(candidateAction[1]);
      const action = candidateAction[2]!;
      const body = request.postDataJSON() as { comment?: string };
      if (action === 'return' && !body.comment) return json(route, { error: { code: 'VALIDATION', message: '差し戻すときは理由を入力してください。' } }, 400);
      fake.candidates = fake.candidates.filter((c) => c.id !== id);
      const message = action === 'ok' ? '起票しました。' : action === 'ng' ? '不要として閉じました。' : action === 'undo' ? '誤起票として閉じました。' : '差し戻しました。';
      return json(route, { job: { ...jobView({ ...earlier, id: `j_${String(seq++).padStart(20, '0')}`, kind: 'ask', input: {}, result: null, state: 'done', polls: 0, progress: null, discordUrl: null, error: null, startedAt: null, finishedAt: null, op: null, actor: earlier.actor, createdAt: '2026-10-14T06:00:00+09:00' }), kind: 'screening' as never, op: action, result: { text: '', files: [], message, taskNumber: action === 'ok' ? 58 : null } } });
    }
    return json(route, { error: { code: 'NOT_FOUND', message: 'API が見つかりません。' } }, 404);
  });
  return fake;
}
