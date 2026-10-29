import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SVC_HEADERS, verifySignature } from '../src/server/tasks/signing.js';
import type { AssistantJob, AssistantJobResult } from '../src/shared/assistant.js';

// TEST-ONLY contract double of the Bot host's assistant integration API (contract §3), at
// /api/integration/v1/assistant/*. It verifies the gateway's svc-auth/v1 signature over the exact path
// on the wire and the exact body, answers committee checks (403 FORBIDDEN for outsiders), keeps jobs in
// memory with the same clientOperationId replay rule, and can inject faults. Discord IDs are strings.

export const COMMITTEE_ACTORS = ['user-member-a1', 'user-member-a2', 'user-chair-b'] as const;
export const OUTSIDER_ACTOR = 'user-outsider';

export type AssistantFault = 'unavailable' | 'slow' | 'unauthorized' | 'not-json';

export interface FakeFile {
  type: string;
  body: Buffer;
}

export interface AssistantFakeCall {
  method: string;
  path: string;
  actor: string;
  body: Record<string, unknown> | null;
}

export interface AssistantFake {
  url: string;
  key: Buffer;
  /** Every signed request that reached the double (after the signature passed). */
  calls: AssistantFakeCall[];
  jobs: Map<string, AssistantJob>;
  /** Files by `${jobId}/${name}`. */
  files: Map<string, FakeFile>;
  /** Applies to the next requests (until cleared). `slow` waits `slowMs` before answering. */
  fault: AssistantFault | null;
  slowMs: number;
  /** Marks a queued job done with a result (the Bot's side of the job table). */
  complete: (jobId: string, result: AssistantJobResult) => void;
  close: () => Promise<void>;
}

const jobIdOf = (seq: number) => `j_${String(seq).padStart(20, '0')}`;

const error = (code: string, message: string) => ({ error: { code, message } });

export const FAKE_META = {
  features: { ask: true, doc: true, image: false, remind: true, screening: true },
  models: [
    { id: 'auto', label: '自動', ask: true, doc: true },
    { id: 'sonnet', label: 'Claude Sonnet', ask: true, doc: true },
    { id: 'gemini', label: 'Gemini', ask: false, doc: false },
  ],
  docTypes: [
    { id: 'request', label: '依頼文（対外）' },
    { id: 'notice', label: 'お知らせ' },
  ],
  reminderChannels: [{ id: '1000000000000000001', name: 'bot-reminders' }],
  shareChannel: { id: '1000000000000000002', name: 'bottest' },
  isAdmin: false,
  bot: { alive: true, lastSeenAt: '2026-10-14T05:00:00+09:00' },
};

export async function startAssistantFake(): Promise<AssistantFake> {
  const key = randomBytes(32);
  const jobs = new Map<string, AssistantJob>();
  const opsByKey = new Map<string, string>();
  const files = new Map<string, FakeFile>();
  const calls: AssistantFakeCall[] = [];
  const nonces = new Set<string>();
  const state = { seq: 0, fault: null as AssistantFault | null, slowMs: 0 };

  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as FastifyRequest & { rawBody?: string }).rawBody = String(body);
    try {
      done(null, body ? JSON.parse(String(body)) : undefined);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    const h = (n: string) => request.headers[n] as string | undefined;
    const actor = h(SVC_HEADERS.actor) ?? '';
    const nonce = h(SVC_HEADERS.nonce) ?? '';
    const signed =
      h(SVC_HEADERS.client) === 'web-gateway' &&
      !nonces.has(nonce) &&
      Math.abs(Date.now() - Number(h(SVC_HEADERS.timestamp))) < 30_000 &&
      verifySignature(
        key,
        {
          client: 'web-gateway',
          method: request.method,
          path: request.raw.url ?? '',
          timestamp: h(SVC_HEADERS.timestamp) ?? '',
          nonce,
          actor,
          body: (request as FastifyRequest & { rawBody?: string }).rawBody ?? '',
        },
        h(SVC_HEADERS.signature) ?? '',
      );
    if (!signed) return reply.code(401).send(error('UNAUTHENTICATED', 'bad signature'));
    nonces.add(nonce);
    calls.push({ method: request.method, path: request.raw.url ?? '', actor, body: (request.body as Record<string, unknown> | null) ?? null });
    if (state.fault === 'unavailable') return reply.code(503).send(error('INTERNAL', 'down'));
    if (state.fault === 'unauthorized') return reply.code(401).send(error('UNAUTHENTICATED', 'key mismatch'));
    if (state.fault === 'slow') await new Promise((resolve) => setTimeout(resolve, state.slowMs));
    if (state.fault === 'not-json') return reply.code(200).type('text/plain').send('not json');
    if (!COMMITTEE_ACTORS.includes(actor as (typeof COMMITTEE_ACTORS)[number])) return reply.code(403).send(error('FORBIDDEN', 'この操作は委員だけができます。'));
  });

  const base = '/api/integration/v1/assistant';
  const job = (id: string) => jobs.get(id);

  app.get(`${base}/meta`, async () => FAKE_META);
  app.get(`${base}/summary`, async () => ({ pendingCandidates: 2, reminders: { overdue: 1, today: 3, upcoming7d: 4 } }));
  app.get(`${base}/members`, async () => ({ members: [{ id: 'discord-1000000000000000001', name: '編集担当A' }] }));

  app.post(`${base}/jobs`, async (request, reply) => {
    const body = request.body as { clientOperationId: string; kind: string; input: Record<string, unknown> };
    const replayId = opsByKey.get(`${request.headers[SVC_HEADERS.actor]}\u0000${body.clientOperationId}`);
    if (replayId) return reply.code(200).send({ job: job(replayId) });
    state.seq += 1;
    const id = jobIdOf(state.seq);
    const created: AssistantJob = {
      id,
      kind: body.kind as AssistantJob['kind'],
      op: null,
      state: 'queued',
      actor: { id: String(request.headers[SVC_HEADERS.actor]), name: '委員' },
      input: body.input,
      progress: null,
      result: null,
      error: null,
      discordUrl: null,
      createdAt: '2026-10-14T05:00:00+09:00',
      startedAt: null,
      finishedAt: null,
    };
    jobs.set(id, created);
    opsByKey.set(`${request.headers[SVC_HEADERS.actor]}\u0000${body.clientOperationId}`, id);
    return reply.code(202).send({ job: created });
  });

  app.get(`${base}/jobs/:jobId`, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const found = job(jobId);
    if (!found) return reply.code(404).send(error('NOT_FOUND', '依頼が見つかりません。'));
    return { job: found };
  });

  app.get(`${base}/jobs`, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const list = [...jobs.values()].filter((j) => (q.kind ? j.kind === q.kind : true)).reverse();
    return { jobs: list.slice(0, Number(q.limit ?? 20)), next: null };
  });

  app.get(`${base}/similar`, async (request) => {
    const q = String((request.query as Record<string, string>).q ?? '');
    const hits = [...jobs.values()].filter((j) => j.kind === 'ask' && j.state === 'done' && String(j.input.question ?? '').includes(q.slice(0, 4)));
    return { jobs: hits.map((j) => ({ job: j, score: 0.5 })) };
  });

  app.post(`${base}/jobs/:jobId/cancel`, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const found = job(jobId);
    if (!found) return reply.code(404).send(error('NOT_FOUND', '依頼が見つかりません。'));
    if (found.state !== 'queued') return reply.code(409).send(error('CONFLICT', 'この依頼はもう取り消せません。'));
    found.state = 'canceled';
    return { job: found };
  });

  app.get(`${base}/files/:jobId/:name`, async (request, reply) => {
    const { jobId, name } = request.params as { jobId: string; name: string };
    const file = files.get(`${jobId}/${name}`);
    if (!file) return reply.code(404).send(error('NOT_FOUND', 'ファイルが見つかりません。'));
    return reply.header('content-type', file.type).send(file.body);
  });

  app.get(`${base}/reminders`, async () => ({ reminders: [], snapshotAt: '2026-10-14T04:59:00+09:00' }));

  const reminderJob = (body: Record<string, unknown>, actor: string): AssistantJob => {
    state.seq += 1;
    const id = jobIdOf(state.seq);
    return {
      id,
      kind: 'remind',
      op: 'create',
      state: 'done',
      actor: { id: actor, name: '委員' },
      input: body,
      progress: null,
      result: {
        text: '',
        files: [],
        message: 'リマインドを登録しました。',
        reminder: {
          id: 7,
          text: String(body.text),
          due: String(body.due),
          repeat: (body.repeat as 'none') ?? 'none',
          creator: { id: actor, name: '委員' },
          target: { id: actor, name: '委員' },
          channel: { id: '1000000000000000001', name: 'bot-reminders' },
          canComplete: true,
          canDelete: true,
        },
      },
      error: null,
      discordUrl: null,
      createdAt: '2026-10-14T05:00:00+09:00',
      startedAt: '2026-10-14T05:00:00+09:00',
      finishedAt: '2026-10-14T05:00:01+09:00',
    };
  };

  app.post(`${base}/reminders`, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const created = reminderJob(body, String(request.headers[SVC_HEADERS.actor]));
    return reply.code(200).send({ job: created });
  });

  app.post(`${base}/reminders/:id/:op`, async (request, reply) => {
    const { op } = request.params as { id: string; op: string };
    return reply.code(200).send({ job: { ...reminderJob({}, String(request.headers[SVC_HEADERS.actor])), op, result: { text: '', files: [], message: op === 'done' ? '完了にしました。' : '削除しました。' } } });
  });

  app.get(`${base}/candidates`, async () => ({
    candidates: [
      {
        id: 3,
        state: 'posted',
        decision: null,
        title: '会場の備品を確認する',
        description: '会場課と備品の数を照合する。',
        deadline: '2026-10-20',
        departments: ['kaijo'],
        assigneeName: '編集担当A',
        sources: [{ label: '議事録（合成）', excerpt: '備品の数を確認する。' }],
        taskNumber: null,
        discordUrl: 'https://discord.com/channels/1000000000000000010/1000000000000000011/1000000000000000012',
        createdAt: '2026-10-14T05:00:00+09:00',
        actions: ['ok', 'ng', 'return'],
      },
    ],
  }));

  app.post(`${base}/candidates/:id/:action`, async (request, reply) => {
    const { action } = request.params as { id: string; action: string };
    const body = request.body as Record<string, unknown>;
    const created = reminderJob(body, String(request.headers[SVC_HEADERS.actor]));
    return reply.code(200).send({ job: { ...created, kind: 'screening', op: action, result: { text: '', files: [], message: '起票しました。', taskNumber: 42 } } });
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const fake: AssistantFake = {
    url: `http://127.0.0.1:${port}`,
    key,
    calls,
    jobs,
    files,
    get fault() {
      return state.fault;
    },
    set fault(value: AssistantFault | null) {
      state.fault = value;
    },
    get slowMs() {
      return state.slowMs;
    },
    set slowMs(value: number) {
      state.slowMs = value;
    },
    complete: (jobId, result) => {
      const found = jobs.get(jobId);
      if (!found) throw new Error(`no job ${jobId}`);
      jobs.set(jobId, { ...found, state: 'done', result, finishedAt: '2026-10-14T05:01:00+09:00' });
    },
    close: () => app.close(),
  };
  return fake;
}
