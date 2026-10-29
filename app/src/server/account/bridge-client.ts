import { z } from 'zod';
import { EFFECTIVE_MEMBERSHIP_KIND, LINK_EVIDENCE, MEMBERSHIP_PROVENANCE, type DeliveryAck, type IdentityLink, type LoginCodeEnvelope, type MembershipObservation } from '../login/types.js';
import { signedHeaders } from '../tasks/signing.js';

// PRODUCTION adapter contract to the operator-provided "identity bridge" service (shared by the
// common Web entry and, through the same canonical principals, the Task gateway). The bridge owns
// the authoritative directory reads (verified email/Discord binding, principal status, effective
// Group membership including nested/all-organization) and the existing Bot's DM delivery.
// Every request is signed (svc-auth/v1, client "smm-auth"); every answer is schema-validated and
// anything unexpected is a provider failure, which the login core always treats as a denial.
// No live bridge exists in this repository: it is a held operator deliverable (docs/unified-integration.md).

const linkSchema = z.strictObject({
  linkId: z.string(),
  version: z.number().int(),
  status: z.enum(['active', 'revoked']),
  email: z.string(),
  emailVerified: z.boolean(),
  discordUserId: z.string(),
  memberKey: z.string(),
  principalId: z.string(),
  evidence: z.enum(LINK_EVIDENCE as unknown as [string, ...string[]]),
});
const linkAnswer = z.strictObject({ link: linkSchema.nullable() });
const principalAnswer = z.strictObject({ principal: z.strictObject({ principalId: z.string(), active: z.boolean() }).nullable() });
const membershipAnswer = z.strictObject({
  kind: z.literal(EFFECTIVE_MEMBERSHIP_KIND),
  groupId: z.string(),
  groupRevision: z.string(),
  memberKey: z.string(),
  subjectType: z.enum(['user', 'group', 'customer']),
  subjectState: z.enum(['active', 'invited', 'suspended', 'archived', 'deleted', 'unknown']),
  resolution: z.enum(['complete', 'incomplete', 'limit_exceeded', 'cycle', 'forbidden', 'unavailable']),
  effectiveMember: z.union([z.boolean(), z.literal('unknown')]),
  provenance: z.array(z.enum(MEMBERSHIP_PROVENANCE as unknown as [string, ...string[]])),
  organizationId: z.string().nullable(),
  observedAt: z.number(),
});
const ackAnswer = z.union([
  z.strictObject({ deliveryId: z.string(), status: z.literal('delivered') }),
  z.strictObject({ deliveryId: z.string(), status: z.literal('failed'), reason: z.enum(['dm_closed', 'blocked', 'rate_limited', 'timeout', 'recipient_mismatch', 'unavailable']) }),
]);

export interface IdentityBridgeOptions {
  /** Origin of the bridge (https, or http only on the same host's loopback literal; see parseServiceUrl). */
  baseUrl: string;
  key: Buffer;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class IdentityBridgeClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IdentityBridgeOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post<T>(path: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const body = JSON.stringify(payload);
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedHeaders(this.options.key, { client: 'smm-auth', method: 'POST', path, body }) },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });
    if (!response.ok) throw new Error('identity bridge refused');
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error('identity bridge answer invalid');
    return parsed.data;
  }

  readonly links = {
    findByVerifiedEmail: async (email: string): Promise<IdentityLink | null> =>
      (await this.post('/v1/links/by-verified-email', { email }, linkAnswer)).link as IdentityLink | null,
    getLink: async (linkId: string): Promise<IdentityLink | null> => (await this.post('/v1/links/get', { linkId }, linkAnswer)).link as IdentityLink | null,
  };

  readonly principals = {
    getPrincipal: async (principalId: string) => (await this.post('/v1/principals/get', { principalId }, principalAnswer)).principal,
  };

  readonly membership = {
    lookup: async (groupId: string, memberKey: string): Promise<MembershipObservation> =>
      (await this.post('/v1/membership/effective', { groupId, memberKey }, membershipAnswer)) as MembershipObservation,
  };

  /** The envelope (with the code) goes only to the bridge, which hands it to the existing Bot. */
  readonly deliver = async (envelope: LoginCodeEnvelope): Promise<DeliveryAck> => (await this.post('/v1/dm/login-code', envelope, ackAnswer)) as DeliveryAck;
}
