import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { idSchema } from '../../shared/schemas.js';
import type { ApiErrorBody } from '../../shared/types.js';
import { AppError } from '../domain/errors.js';
import type { ActorContext, TaskService } from '../domain/taskService.js';
import { normalizeAddress, type DiscordBindings } from './config.js';
import { DiscordBridge } from './discordBridge.js';
import { NonceCache, verifySignedRequest, type ClientId } from './signing.js';

// 保護モードの HTTP。共通 Web のゲートウェイと Discord 連携 Bot だけが、署名付き要求で使う内部 API。
// 模擬ログイン（X-Demo-User）・人物一覧・模擬 Bot・障害注入・初期化・画面配信はここには存在しない。

export const INTEGRATION_PREFIX = '/api/integration/v1';

export interface IntegrationAppOptions {
  service: TaskService;
  keys: ReadonlyMap<ClientId, Buffer>;
  trustedClients: ReadonlySet<string>;
  discord: DiscordBindings | null;
  now?: () => number;
}

interface Caller {
  client: ClientId;
  actor: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const raw = request.raw.rawHeaders;
  const values: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!);
  return values;
}

const error = (code: ApiErrorBody['error']['code'], message: string): ApiErrorBody => ({ error: { code, message } });

export async function buildIntegrationApp(options: IntegrationAppOptions): Promise<FastifyInstance> {
  const { service } = options;
  const now = options.now ?? Date.now;
  const nonces = new NonceCache();
  const callers = new WeakMap<FastifyRequest, Caller>();
  const bridge = options.discord ? new DiscordBridge(service, options.discord) : null;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  // 署名は送られた本文そのものに対して確認するため、JSON は文字列のまま受け取ってから解析する。
  app.removeContentTypeParser(['application/json', 'text/plain']);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = text;
    if (text === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const failure = new Error('invalid json') as Error & { statusCode: number };
      failure.statusCode = 400;
      done(failure, undefined);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const remote = normalizeAddress(request.raw.socket.remoteAddress);
    if (!remote || !options.trustedClients.has(remote)) {
      return reply.status(403).send(error('FORBIDDEN', '許可された送信元からの要求ではありません。'));
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    const path = request.raw.url ?? '';
    if (!path.startsWith(`${INTEGRATION_PREFIX}/`)) return;
    const result = verifySignedRequest(
      { method: request.method, path, body: request.rawBody ?? '', header: (name) => rawHeaderValues(request, name) },
      options.keys,
      nonces,
      now(),
    );
    if (!result.ok) {
      const status = result.reason === 'capacity' ? 503 : 401;
      return reply.status(status).send(error(status === 503 ? 'INTERNAL' : 'UNAUTHENTICATED', '署名付きのサービス要求として確認できません。'));
    }
    callers.set(request, { client: result.client, actor: result.actor });
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.httpStatus).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.options.details ? { details: err.options.details } : {}),
          ...(err.options.current ? { current: err.options.current } : {}),
        },
      } satisfies ApiErrorBody);
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(error('VALIDATION', '要求の形式が正しくありません。'));
    }
    return reply.status(500).send(error('INTERNAL', 'サーバーで予期しないエラーが発生しました。'));
  });

  /** ゲートウェイからの要求。操作者は署名済みのヘッダーだけから取り、本文の申告は使わない。 */
  function gateway(request: FastifyRequest, body?: unknown): ActorContext {
    const caller = callers.get(request);
    if (!caller || caller.client !== 'web-gateway') throw new AppError('FORBIDDEN', 'この操作は共通 Web のゲートウェイだけが使えます。');
    if (!caller.actor || !idSchema.safeParse(caller.actor).success) throw new AppError('UNAUTHENTICATED', '操作する利用者を確認できません。');
    const operationId = typeof body === 'object' && body !== null ? (body as { operationId?: unknown }).operationId : undefined;
    return { actorId: caller.actor, source: 'web', ...(typeof operationId === 'string' ? { operationId } : {}) };
  }

  app.get('/api/health', async () => ({ ok: true }));

  type P = { workspaceId: string; taskId: string };

  app.get(`${INTEGRATION_PREFIX}/me`, async (request) => {
    const me = service.getMe(gateway(request).actorId);
    return { user: { id: me.user.id, displayName: me.user.displayName }, memberships: me.memberships };
  });

  app.get<{ Params: Pick<P, 'workspaceId'> }>(`${INTEGRATION_PREFIX}/workspaces/:workspaceId/tasks`, async (request) =>
    service.listTasks(gateway(request).actorId, request.params.workspaceId, request.query),
  );

  app.post<{ Params: Pick<P, 'workspaceId'> }>(`${INTEGRATION_PREFIX}/workspaces/:workspaceId/tasks`, async (request, reply) => {
    const ctx = gateway(request, request.body);
    // ゲートウェイからの作成は再試行で重複しないよう操作 ID を必須にする。
    if (ctx.operationId === undefined) throw new AppError('VALIDATION', '操作 ID（operationId）が必要です。', { details: [{ path: 'operationId', message: '必須です' }] });
    const result = await service.createTask(ctx, request.params.workspaceId, request.body);
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.get<{ Params: Pick<P, 'taskId'> }>(`${INTEGRATION_PREFIX}/tasks/:taskId`, async (request) => service.getTask(gateway(request).actorId, request.params.taskId));

  app.patch<{ Params: Pick<P, 'taskId'> }>(`${INTEGRATION_PREFIX}/tasks/:taskId`, async (request) =>
    service.updateTask(gateway(request, request.body), request.params.taskId, request.body),
  );

  app.post<{ Params: Pick<P, 'taskId'> }>(`${INTEGRATION_PREFIX}/tasks/:taskId/reopen`, async (request) =>
    service.reopenTask(gateway(request, request.body), request.params.taskId, request.body),
  );

  app.get<{ Params: Pick<P, 'taskId'> }>(`${INTEGRATION_PREFIX}/tasks/:taskId/history`, async (request) =>
    service.getHistory(gateway(request).actorId, request.params.taskId),
  );

  app.get<{ Params: Pick<P, 'workspaceId'> }>(`${INTEGRATION_PREFIX}/workspaces/:workspaceId/members`, async (request) => {
    const members = await service.listMembers(gateway(request).actorId, request.params.workspaceId);
    // メールアドレスは共通画面に不要なので返さない。
    return members.map(({ userId, displayName, role, active }) => ({ userId, displayName, role, active }));
  });

  app.post(`${INTEGRATION_PREFIX}/discord/commands`, async (request) => {
    const caller = callers.get(request);
    if (!caller || caller.client !== 'discord-bridge' || caller.actor !== null) {
      throw new AppError('FORBIDDEN', 'この操作は Discord 連携 Bot だけが使えます。');
    }
    if (!bridge) throw new AppError('NOT_FOUND', 'Discord 連携は設定されていません。');
    return bridge.handle(request.body);
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send(error('NOT_FOUND', '見つかりません。')));
  return app;
}
