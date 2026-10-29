import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssistantServiceClient } from '../../src/server/assistant/client.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { parseTaskBridge } from '../../src/server/tasks/bridge.js';
import { EDITOR_A, EDITOR_C, TEST_HOST, TEST_PORT, VIEWER_B, seedState } from '../helpers.js';
import { startAssistantFake, OUTSIDER_ACTOR, type AssistantFake } from '../assistant-fake.js';

type Method = 'GET' | 'POST';

// Bot tab API (../docs/contracts/bot-front.md §4) against the synthetic Bot-host double. The double
// verifies every signature, so a call that reaches it proves the signed path and actor are right.
// VIEWER_B is bound to an actor the double refuses (not a committee member); EDITOR_C has no binding.

const BRIDGE = parseTaskBridge(
  JSON.stringify({
    version: 1,
    bindings: [
      { principalId: EDITOR_A, taskUserId: 'user-member-a1' },
      { principalId: VIEWER_B, taskUserId: OUTSIDER_ACTOR },
    ],
  }),
);
const JOB = /^j_[a-z0-9]{20}$/;

let fake: AssistantFake;
let app: FastifyInstance;

async function start(options: { enabled?: boolean; timeoutMs?: number; longTimeoutMs?: number } = {}) {
  fake = await startAssistantFake();
  const store = new StateStore(await seedState(), null);
  const client = new AssistantServiceClient({ baseUrl: fake.url, key: fake.key, timeoutMs: options.timeoutMs ?? 2_000, longTimeoutMs: options.longTimeoutMs ?? 3_000 });
  app = await buildApp({
    store,
    listenPort: TEST_PORT,
    clock: () => new Date().toISOString(),
    ...(options.enabled === false ? {} : { assistant: { client, bridge: BRIDGE } }),
  });
}

beforeEach(async () => {
  await start();
});
afterEach(async () => {
  // Some tests close the double or the app themselves to simulate an outage; closing twice is harmless here.
  await app.close().catch(() => undefined);
  await fake.close().catch(() => undefined);
});

async function call(userId: string | null, method: Method, url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { host: TEST_HOST, ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}) },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

const askBody = (question: string, extra: Record<string, unknown> = {}) => ({
  clientOperationId: randomUUID(),
  kind: 'ask',
  input: { question, ...extra },
});

describe('access and feature state', () => {
  it('requires a signed-in committee member', async () => {
    const res = await call(null, 'GET', '/api/assistant/meta');
    expect(res.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it('answers ASSISTANT_DISABLED (404) when the Bot host is not configured', async () => {
    await app.close();
    await fake.close();
    await start({ enabled: false });
    const res = await call(EDITOR_A, 'GET', '/api/assistant/meta');
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('ASSISTANT_DISABLED');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a signed-in person without a Discord task identity (403, nothing is sent)', async () => {
    const res = await call(EDITOR_C, 'GET', '/api/assistant/summary');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('forbidden');
    expect(fake.calls).toHaveLength(0);
  });

  it('passes the Bot host answer through, signed for the bound actor', async () => {
    const meta = await call(EDITOR_A, 'GET', '/api/assistant/meta');
    expect(meta.status).toBe(200);
    expect(meta.json.features.ask).toBe(true);
    expect(meta.json.reminderChannels[0].id).toBe('1000000000000000001');
    const summary = await call(EDITOR_A, 'GET', '/api/assistant/summary');
    expect(summary.json).toEqual({ pendingCandidates: 2, reminders: { overdue: 1, today: 3, upcoming7d: 4 } });
    expect(fake.calls.every((c) => c.actor === 'user-member-a1')).toBe(true);
    expect(fake.calls[0]!.path).toBe('/api/integration/v1/assistant/meta');
  });

  it('keeps the Bot host message for a refusal of the committee check (its own 403 code)', async () => {
    const res = await call(VIEWER_B, 'GET', '/api/assistant/summary');
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('FORBIDDEN');
    expect(res.json.message).toBe('この操作は委員だけができます。');
  });

  it.each(['unavailable', 'unauthorized', 'not-json'] as const)('answers ASSISTANT_UNAVAILABLE (503) when the Bot host fails: %s', async (fault) => {
    fake.fault = fault;
    const res = await call(EDITOR_A, 'GET', '/api/assistant/meta');
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('ASSISTANT_UNAVAILABLE');
  });

  it('answers 503 when the Bot host is not running at all', async () => {
    await fake.close();
    const res = await call(EDITOR_A, 'GET', '/api/assistant/summary');
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('ASSISTANT_UNAVAILABLE');
  });
});

describe('input checks (contract §3-2, §3-4)', () => {
  it('rejects empty, overlong and out-of-list input before anything is sent', async () => {
    const bad = [
      askBody('   \u0007  '),
      askBody('あ'.repeat(1001)),
      askBody('質問', { model: 'gpt' }),
      askBody('質問', { effort: 'extreme' }),
      askBody('質問', { tone: 'x'.repeat(101) }),
      { clientOperationId: randomUUID(), kind: 'remind', input: { question: '質問' } },
      { clientOperationId: randomUUID(), kind: 'ask', input: { question: '質問', extra: true } },
      { clientOperationId: 'short', kind: 'ask', input: { question: '質問' } },
    ];
    for (const body of bad) {
      const res = await call(EDITOR_A, 'POST', '/api/assistant/jobs', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('removes control characters before counting, and keeps tabs and line breaks', async () => {
    const res = await call(EDITOR_A, 'POST', '/api/assistant/jobs', askBody(`${'a'.repeat(999)}\u0007\u0007`));
    expect(res.status).toBe(202);
    expect(res.json.job.input.question).toBe('a'.repeat(999));
    const multi = await call(EDITOR_A, 'POST', '/api/assistant/jobs', askBody('一行目\n\t二行目\u0000'));
    expect(multi.json.job.input.question).toBe('一行目\n\t二行目');
  });

  it('sends the browser operation ID with the ui- prefix, and replays the same job on a retry', async () => {
    const body = askBody('同じ質問');
    const first = await call(EDITOR_A, 'POST', '/api/assistant/jobs', body);
    const again = await call(EDITOR_A, 'POST', '/api/assistant/jobs', body);
    expect(first.status).toBe(202);
    expect(again.json.job.id).toBe(first.json.job.id);
    expect(fake.calls.filter((c) => c.method === 'POST').every((c) => String(c.body?.clientOperationId).startsWith('ui-'))).toBe(true);
    expect(first.json.job.id).toMatch(JOB);
  });

  it('checks the doc, image and remind limits', async () => {
    const id = () => randomUUID();
    const doc = (content: string, extra: Record<string, unknown> = {}) => ({
      clientOperationId: id(),
      kind: 'doc',
      input: { docType: 'notice', content, format: 'docx', useSources: true, ...extra },
    });
    expect((await call(EDITOR_A, 'POST', '/api/assistant/jobs', doc('a'.repeat(2000)))).status).toBe(202);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/jobs', doc('a'.repeat(2001)))).status).toBe(400);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/jobs', doc('本文', { docType: 'letter' }))).status).toBe(400);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/jobs', doc('本文', { format: 'pdf' }))).status).toBe(400);
    const image = (aspect: string) => ({ clientOperationId: id(), kind: 'image', input: { prompt: '医薬祭のポスター', aspect } });
    expect((await call(EDITOR_A, 'POST', '/api/assistant/jobs', image('16:9'))).status).toBe(202);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/jobs', image('2:1'))).status).toBe(400);
    const reminder = (extra: Record<string, unknown>) => ({ clientOperationId: id(), text: '資料を印刷', due: '2026-10-20T18:00:00+09:00', ...extra });
    expect((await call(EDITOR_A, 'POST', '/api/assistant/reminders', reminder({ text: 'x'.repeat(501) }))).status).toBe(400);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/reminders', reminder({ targetId: '1000000000000000001' }))).status).toBe(400);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/reminders', reminder({ repeat: 'hourly' }))).status).toBe(400);
    const noDue = { clientOperationId: id(), text: '資料を印刷' };
    expect((await call(EDITOR_A, 'POST', '/api/assistant/reminders', noDue)).status).toBe(400);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/reminders', reminder({ targetId: 'discord-1000000000000000001', repeat: 'weekly', channelId: '1000000000000000001' }))).status).toBe(200);
  });

  it('needs a comment of at most 1000 characters to return a candidate, and nothing else for ok', async () => {
    const act = (action: string, body: Record<string, unknown>) => call(EDITOR_A, 'POST', `/api/assistant/candidates/3/${action}`, { clientOperationId: randomUUID(), ...body });
    expect((await act('return', {})).status).toBe(400);
    expect((await act('return', { comment: '   ' })).status).toBe(400);
    expect((await act('return', { comment: 'c'.repeat(1001) })).status).toBe(400);
    expect((await act('return', { comment: '日程を確認してください' })).status).toBe(200);
    expect((await act('ok', {})).status).toBe(200);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/candidates/3/merge', { clientOperationId: randomUUID() })).status).toBe(400);
    expect((await call(EDITOR_A, 'POST', '/api/assistant/candidates/abc/ok', { clientOperationId: randomUUID() })).status).toBe(400);
  });

  it('checks job IDs, similar questions and list paging', async () => {
    expect((await call(EDITOR_A, 'GET', '/api/assistant/jobs/not-a-job')).status).toBe(400);
    expect((await call(EDITOR_A, 'GET', '/api/assistant/similar')).status).toBe(400);
    expect((await call(EDITOR_A, 'GET', '/api/assistant/jobs?kind=remind')).status).toBe(400);
    expect((await call(EDITOR_A, 'GET', '/api/assistant/jobs?limit=500')).status).toBe(400);
    const list = await call(EDITOR_A, 'GET', '/api/assistant/jobs?kind=ask&mine=1&limit=5');
    expect(list.status).toBe(200);
    expect(list.json).toEqual({ jobs: [], next: null });
    expect(fake.calls.at(-1)!.path).toBe('/api/integration/v1/assistant/jobs?kind=ask&mine=1&limit=5');
  });
});

describe('job results and links', () => {
  it('rebuilds file links, keeps only allowed files and drops badly named ones', async () => {
    const created = await call(EDITOR_A, 'POST', '/api/assistant/jobs', askBody('資料の質問'));
    const jobId = created.json.job.id as string;
    fake.complete(jobId, {
      text: '-# 参照: 資料\n**結論**',
      files: [
        { name: '回答 (1).docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 12, url: `/assistant/files/${jobId}/x` },
        { name: 'draw.svg', mime: 'image/svg+xml', size: 1, url: `/assistant/files/${jobId}/draw.svg` },
        { name: '../secret.txt', mime: 'text/plain', size: 1, url: '/assistant/files/x' },
      ],
    });
    const res = await call(EDITOR_A, 'GET', `/api/assistant/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.json.job.state).toBe('done');
    expect(res.json.job.result.text).toBe('-# 参照: 資料\n**結論**');
    expect(res.json.job.result.files).toEqual([
      {
        name: '回答 (1).docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 12,
        url: `/api/assistant/files/${jobId}/${encodeURIComponent('回答 (1).docx')}`,
      },
    ]);
  });
});

describe('files (contract §4: Content-Type allow-list, attachment, 20 MB)', () => {
  const FILE = `j_${'0'.repeat(20)}`;
  const cases: [string, string, string][] = [
    ['image.png', 'image/png', 'image/png'],
    ['photo.jpg', 'image/jpeg', 'image/jpeg'],
    ['card.webp', 'image/webp', 'image/webp'],
    ['回答.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['memo.md', 'text/markdown; charset=utf-8', 'text/markdown; charset=utf-8'],
    ['memo.txt', 'text/plain', 'text/plain; charset=utf-8'],
  ];

  it.each(cases)('passes %s as %s with attachment headers and nosniff', async (name, sent, expected) => {
    fake.files.set(`${FILE}/${name}`, { type: sent, body: Buffer.from('synthetic') });
    const res = await call(EDITOR_A, 'GET', `/api/assistant/files/${FILE}/${encodeURIComponent(name)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(expected);
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="/);
    expect(String(res.headers['content-disposition'])).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.raw).toBe('synthetic');
  });

  it.each([
    ['page.html', 'text/html'],
    ['draw.svg', 'image/svg+xml'],
    ['data.json', 'application/json'],
  ])('refuses %s (%s) with 502 ASSISTANT_FILE_REJECTED', async (name, type) => {
    fake.files.set(`${FILE}/${name}`, { type, body: Buffer.from('<script>x</script>') });
    const res = await call(EDITOR_A, 'GET', `/api/assistant/files/${FILE}/${name}`);
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('ASSISTANT_FILE_REJECTED');
    expect(res.raw).not.toContain('<script>');
  });

  it('refuses a file over 20 MB', async () => {
    fake.files.set(`${FILE}/big.png`, { type: 'image/png', body: Buffer.alloc(20 * 1024 * 1024 + 1) });
    const res = await call(EDITOR_A, 'GET', `/api/assistant/files/${FILE}/big.png`);
    expect(res.status).toBe(502);
    expect(res.json.error).toBe('ASSISTANT_FILE_REJECTED');
  });

  it('answers 404 for a file the Bot host does not have', async () => {
    const res = await call(EDITOR_A, 'GET', `/api/assistant/files/${FILE}/missing.png`);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('NOT_FOUND');
  });
});

describe('timeouts (contract §4: 8 s; 12 s for reminder and candidate writes)', () => {
  it('gives up on a read after its timeout, but waits longer for a reminder write', async () => {
    await app.close();
    await fake.close();
    await start({ timeoutMs: 80, longTimeoutMs: 800 });
    fake.fault = 'slow';
    fake.slowMs = 300;
    const read = await call(EDITOR_A, 'GET', '/api/assistant/meta');
    expect(read.status).toBe(503);
    expect(read.json.error).toBe('ASSISTANT_UNAVAILABLE');
    const write = await call(EDITOR_A, 'POST', '/api/assistant/reminders', { clientOperationId: randomUUID(), text: '資料を印刷', due: '2026-10-20T18:00:00+09:00' });
    expect(write.status).toBe(200);
  });
});

describe('reminders and candidates', () => {
  it('creates a reminder and returns the finished job with its reminder', async () => {
    const res = await call(EDITOR_A, 'POST', '/api/assistant/reminders', {
      clientOperationId: randomUUID(),
      text: '資料を印刷',
      due: '2026-10-20T18:00:00+09:00',
      repeat: 'none',
    });
    expect(res.status).toBe(200);
    expect(res.json.job.result.reminder.text).toBe('資料を印刷');
    expect(res.json.job.result.message).toBe('リマインドを登録しました。');
  });

  it('completes and deletes a reminder by its ID', async () => {
    const done = await call(EDITOR_A, 'POST', '/api/assistant/reminders/7/done', { clientOperationId: randomUUID() });
    expect(done.json.job.result.message).toBe('完了にしました。');
    const del = await call(EDITOR_A, 'POST', '/api/assistant/reminders/7/delete', { clientOperationId: randomUUID() });
    expect(del.json.job.result.message).toBe('削除しました。');
    expect((await call(EDITOR_A, 'POST', '/api/assistant/reminders/seven/done', { clientOperationId: randomUUID() })).status).toBe(400);
  });

  it('lists open candidates, with only https Discord links', async () => {
    const res = await call(EDITOR_A, 'GET', '/api/assistant/candidates?state=open');
    expect(res.status).toBe(200);
    expect(res.json.candidates[0]).toMatchObject({ id: 3, actions: ['ok', 'ng', 'return'], discordUrl: 'https://discord.com/channels/1000000000000000010/1000000000000000011/1000000000000000012' });
    expect((await call(EDITOR_A, 'GET', '/api/assistant/candidates?state=all')).status).toBe(400);
  });

  it('cancels my queued request through the Bot host; a request that is no longer queued cannot be cancelled', async () => {
    const created = await call(EDITOR_A, 'POST', '/api/assistant/jobs', askBody('取り消す依頼'));
    const id = created.json.job.id as string;
    const cancelled = await call(EDITOR_A, 'POST', `/api/assistant/jobs/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.job.state).toBe('canceled');
    const again = await call(EDITOR_A, 'POST', `/api/assistant/jobs/${id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('CONFLICT');
  });

  it('approves a candidate and shows the task message from the Bot host', async () => {
    const res = await call(EDITOR_A, 'POST', '/api/assistant/candidates/3/ok', { clientOperationId: randomUUID() });
    expect(res.status).toBe(200);
    expect(res.json.job.result.message).toBe('起票しました。');
    expect(res.json.job.result.taskNumber).toBe(42);
  });
});
