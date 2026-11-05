import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BANK_ENVIRONMENT_LABELS, type BankCheckResponse, type BankStartResponse, type BankStatusResponse } from '../../shared/bank.js';
import type { AccountingPermission } from '../../shared/payments.js';
import { committeeMember, type ContactRouteDeps } from '../contacts/routes.js';
import { DomainError, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';
import { BankFlowError, type BankService } from './service.js';

// The bank connection over HTTP (2026-11-06). Committee members only (temporary staff never), and then:
// - 権限管理者 connect and disconnect: it lets the app read the committee's bank account;
// - 会計を見る see the state and check the connection (accounts and balances, account numbers cut to 4 digits).
// No response carries a token, a code, the client secret or the bank's raw answer. The bank sends the browser back to
// the screen /bank/callback (not an API path: the cross-site return would be refused there, and the Strict cookie
// would not come with it); the screen posts the code here at once, as a same-origin request with the CSRF header.

export interface BankRouteDeps extends ContactRouteDeps {
  permissionsOf: (user: User) => AccountingPermission[];
}

const completeBody = z.strictObject({
  state: z.string().max(100),
  code: z.string().max(2048).optional(),
  error: z.string().max(100).optional(),
}).refine((b) => (b.code === undefined) !== (b.error === undefined), { message: 'code か error のどちらか一方を送ってください。' });
const emptyBody = z.strictObject({}).optional();

const FLOW_STATUS: Record<BankFlowError['reason'], number> = { state: 400, busy: 409, not_connected: 409, expired: 409, reconnect: 409, bank: 502 };

export function registerBankRoutes(app: FastifyInstance, service: BankService | null, deps: BankRouteDeps): void {
  const nameOf = (userId: string) => deps.people.lookup(userId)?.displayName ?? '（不明な利用者）';
  const member = (request: FastifyRequest): User => {
    try {
      return committeeMember(deps, request);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'forbidden') throw new DomainError('forbidden', '銀行の連携は委員だけが使えます。');
      throw err;
    }
  };
  const canView = (user: User) => deps.permissionsOf(user).includes('accounting.view');
  const reader = (request: FastifyRequest): User => {
    const user = member(request);
    if (!user.canManageAccess && !canView(user)) throw new DomainError('forbidden', '銀行の連携を見るには「会計を見る」の権限が要ります。');
    return user;
  };
  const administrator = (request: FastifyRequest): User => {
    const user = member(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', '銀行との接続・切断は権限管理者だけができます。');
    return user;
  };
  const checker = (request: FastifyRequest): User => {
    const user = member(request);
    if (!canView(user)) throw new DomainError('forbidden', '接続を確かめるには「会計を見る」の権限が要ります。');
    return user;
  };
  const configured = (): BankService => {
    if (!service) throw new HttpError(404, { error: 'bank_not_configured', message: '銀行の連携は設定されていません（運用者が bank.json を置くと使えます）。' });
    return service;
  };
  const flow = async <T>(run: () => Promise<T> | T): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof BankFlowError) throw new HttpError(FLOW_STATUS[err.reason], { error: `bank_${err.reason}`, message: err.message });
      throw err;
    }
  };

  const statusOf = (user: User): BankStatusResponse => {
    const base = { canConnect: user.canManageAccess, canCheck: canView(user) };
    if (!service) {
      return { configured: false, environment: null, environmentLabel: null, state: 'disconnected', scopes: [], connectedAt: null, connectedBy: null, accessTokenExpiresAt: null, refreshable: false, lastRefreshedAt: null, lastError: null, redirectUri: null, ...base };
    }
    const core = service.status();
    return {
      configured: true,
      environment: service.config.environment,
      environmentLabel: BANK_ENVIRONMENT_LABELS[service.config.environment],
      ...core,
      connectedBy: core.connectedBy ? nameOf(core.connectedBy) : null,
      redirectUri: user.canManageAccess ? service.config.redirectUri : null,
      ...base,
    };
  };

  app.get('/api/bank/status', async (request) => statusOf(reader(request)));

  app.post('/api/bank/oauth/start', async (request): Promise<BankStartResponse> => {
    const user = administrator(request);
    deps.parse(emptyBody, request.body ?? undefined);
    return { authorizeUrl: configured().start(user.id) };
  });

  app.post('/api/bank/oauth/complete', async (request): Promise<BankStatusResponse> => {
    const user = administrator(request);
    const body = deps.parse(completeBody, request.body);
    await flow(() => configured().complete(user.id, body));
    return statusOf(user);
  });

  app.post('/api/bank/check', async (request): Promise<BankCheckResponse> => {
    const user = checker(request);
    deps.parse(emptyBody, request.body ?? undefined);
    return flow(() => configured().check(user.id));
  });

  app.post('/api/bank/disconnect', async (request): Promise<BankStatusResponse> => {
    const user = administrator(request);
    deps.parse(emptyBody, request.body ?? undefined);
    configured().disconnect(user.id);
    return statusOf(user);
  });
}
