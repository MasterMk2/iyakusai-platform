import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { signedHeaders, verifySignature } from '../tasks/signing.js';
import type { DiscordAuthConfig } from './config.js';
import { type DiscordAccountService, type MemberObservation, type RegistrationEnvelope } from './service.js';
import type { AccountStore } from './store.js';

// The link with the Bot host (IyakusaiBot's registration runtime), unchanged from the production
// minimal runtime so the Bot host needs no change: svc-auth/v1 signatures with one shared key,
// - outbound (client "smm-auth"): POST /v1/discord/member and POST /v1/dm/registration-code;
// - inbound (client "iyakusai-bot"): POST /v1/registration/issue after an authenticated `/register`, and
//   POST /v1/registration/bulk-issue for the committee's bulk issue.
// The Bot host serves TLS with a private CA; the process trusts it through NODE_EXTRA_CA_CERTS.

const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

export function createBotHostClients(config: DiscordAuthConfig, fetchImpl: typeof fetch = fetch) {
  async function post(url: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    const body = JSON.stringify(value);
    const headers = { ...signedHeaders(config.bridgeKey, { client: 'smm-auth', method: 'POST', path: new URL(url).pathname, body, actor: '' }), 'content-type': 'application/json' };
    const response = await fetchImpl(url, { method: 'POST', headers, body, signal, redirect: 'error' });
    if (response.status !== 200) throw new Error('DEPENDENCY_STATUS');
    const text = await response.text();
    if (Buffer.byteLength(text) > 65_536) throw new Error('DEPENDENCY_BODY_LIMIT');
    return JSON.parse(text) as unknown;
  }
  return {
    async member(discordUserId: string, signal: AbortSignal): Promise<MemberObservation> {
      const v = await post(config.memberUrl, { guildId: config.guildId, userId: discordUserId }, signal);
      if (!exact(v, ['userId', 'guildId', 'active', 'human', 'sharedAccount', 'roleIds', 'observedAt', 'linkId', 'linkVersion']) || typeof v.active !== 'boolean' || typeof v.human !== 'boolean' || typeof v.sharedAccount !== 'boolean') {
        throw new Error('MEMBER_CONTRACT_REJECTED');
      }
      return {
        kind: 'discord_member/v1',
        guildId: v.guildId as string,
        discordUserId: v.userId as string,
        linkId: v.linkId as string | null,
        joinEpochMs: v.linkVersion as number | null,
        current: v.active,
        bot: !v.human || v.sharedAccount,
        roleIds: v.roleIds as string[],
        observedAtMs: v.observedAt as number,
        taskUserId: null,
      };
    },
    async deliver(envelope: RegistrationEnvelope, signal: AbortSignal): Promise<{ deliveryId: string; status: 'delivered' | 'failed' }> {
      const v = await post(config.registrationDmUrl, envelope, signal);
      if (exact(v, ['deliveryId', 'status']) && v.deliveryId === envelope.deliveryId && v.status === 'delivered') return { deliveryId: envelope.deliveryId, status: 'delivered' };
      if (exact(v, ['deliveryId', 'status', 'reason']) && v.deliveryId === envelope.deliveryId && v.status === 'failed') return { deliveryId: envelope.deliveryId, status: 'failed' };
      throw new Error('ACK_CONTRACT_REJECTED');
    },
  };
}

export const ISSUER_PATH = '/v1/registration/issue';
export const BULK_ISSUER_PATH = '/v1/registration/bulk-issue';

/**
 * Signed `/v1/registration/issue`, the way a person's own `/register` issues a code, and the committee's
 * signed `/v1/registration/bulk-issue` (open only before `bulkRegistrationUntil`), which returns a code
 * valid for days to the caller for a member who has not registered. Unsigned callers get 401.
 */
export function attachRegistrationIssuer(app: FastifyInstance, o: { service: DiscordAccountService; store: AccountStore; config: DiscordAuthConfig; now?: () => number }): void {
  const now = o.now ?? Date.now;

  /** Checks the svc-auth/v1 signature and spends the nonce; returns the JSON body. Throws on anything else. */
  function verified(request: FastifyRequest, path: string): Record<string, unknown> {
    if (request.headers.origin !== undefined || request.url !== path || !Buffer.isBuffer(request.body)) throw new Error('REJECTED');
    const raw = request.raw.rawHeaders;
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i]!.toLowerCase();
      if (k.startsWith('x-svc-')) {
        if (seen.has(k)) throw new Error('REJECTED');
        seen.add(k);
      }
    }
    const read = (name: string) => {
      const v = request.headers[name];
      if (typeof v !== 'string') throw new Error('REJECTED');
      return v;
    };
    const client = read('x-svc-client');
    const timestamp = read('x-svc-timestamp');
    const nonce = read('x-svc-nonce');
    const signature = read('x-svc-signature');
    const actor = request.headers['x-svc-actor'] ?? '';
    const allowed = ['x-svc-client', 'x-svc-timestamp', 'x-svc-nonce', 'x-svc-actor', 'x-svc-signature'];
    if (client !== 'iyakusai-bot' || actor !== '' || !/^\d{13}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 30_000 || !/^[-_A-Za-z0-9]{24,128}$/.test(nonce) || [...seen].some((k) => !allowed.includes(k))) {
      throw new Error('REJECTED');
    }
    const body = request.body as Buffer;
    const text = body.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(body) || !verifySignature(o.config.bridgeKey, { client, method: 'POST', path, timestamp, nonce, actor: '', body: text }, signature)) throw new Error('REJECTED');
    const b = JSON.parse(text) as Record<string, unknown>;
    // A nonce is accepted once (durably), so a captured request cannot issue another code.
    const digest = createHmac('sha256', o.config.bridgeKey).update(JSON.stringify(['issuer-replay', client, nonce])).digest('hex');
    o.store.transact((s) => {
      for (const [k, e] of Object.entries(s.issuerNonces)) if (e <= now()) delete s.issuerNonces[k];
      if (s.issuerNonces[digest] || Object.keys(s.issuerNonces).length >= 1024) throw new Error('REJECTED');
      s.issuerNonces[digest] = Math.max(now() + 60_001, Number(timestamp) + 30_001);
    });
    return b;
  }

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 2048 }, (_request, body, done) => done(null, body));
    scope.post(ISSUER_PATH, async (request, reply) => {
      try {
        const b = verified(request, ISSUER_PATH);
        if (
          !exact(b, ['discordUserId', 'guildId', 'interactionId', 'source']) ||
          b.guildId !== o.config.guildId ||
          !o.service.permitsRegistrationSubject(b.discordUserId) ||
          b.source !== 'authenticated_discord_self_interaction' ||
          typeof b.interactionId !== 'string' ||
          !/^[1-9]\d{16,19}$/.test(b.interactionId)
        ) {
          throw new Error('REJECTED');
        }
        const result = await o.service.issueRegistration(b.discordUserId);
        return { initialLoginId: result.initialLoginId, deliveryStatus: result.deliveryStatus };
      } catch {
        // One answer for every failure, so the caller learns nothing about accounts.
        return reply.code(401).send({ error: 'Registration request rejected' });
      }
    });
    scope.post(BULK_ISSUER_PATH, async (request, reply) => {
      try {
        const until = o.config.bulkRegistrationUntil;
        if (until === null || now() >= until) throw new Error('REJECTED');
        const b = verified(request, BULK_ISSUER_PATH);
        if (
          !exact(b, ['discordUserId', 'guildId', 'source', 'expiresAt', 'dryRun']) ||
          b.guildId !== o.config.guildId ||
          !o.service.permitsRegistrationSubject(b.discordUserId) ||
          b.source !== 'committee_bulk_issue' ||
          typeof b.expiresAt !== 'number' ||
          typeof b.dryRun !== 'boolean'
        ) {
          throw new Error('REJECTED');
        }
        return await o.service.issueBulkRegistration(b.discordUserId, b.expiresAt, b.dryRun);
      } catch {
        return reply.code(401).send({ error: 'Registration request rejected' });
      }
    });
  });
}
