import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EFFECTIVE_MEMBERSHIP_KIND, type MembershipObservation, type MembershipProvenance, type MembershipResolution, type SubjectState } from '../login/types.js';
import { LocalFileRefused, NODE_LOCAL_FILE_OPS, readStrictLocalFile, type LocalFileOps } from './local-file.js';

// Google Workspace Directory READ adapter for the direct-provider composition
// (SMM_IDENTITY_PROVIDER=direct). Reads only, through fixed official GET paths on the fixed origin
// https://admin.googleapis.com, with an EXISTING access token (injected source or a token file whose
// supplier is unverified). No OAuth flow, token minting/refresh, scope or role is
// created here. Redirects, other origins, oversized bodies, timeouts, 401/403/404/429/5xx and any
// response outside the schema are failures; a failure is never turned into "not a member".
// Neither the token nor any response body is logged or placed in an error message.
//
// Effective membership: the configured group (stable id) is read member list by member list, every
// page, every nested GROUP (bounded depth/groups/pages/members/bytes/time, cycles skipped), and
// CUSTOMER entries (organization-wide membership, keyed by customer id, never a person/email).
// Only a whole read is `complete`; anything else is incomplete/limit/forbidden/unavailable.
//
// Freshness: nothing is shared between calls. Every principal check reads the user again and every
// membership lookup reads the user and the whole group tree again, under ONE deadline per lookup;
// there is no user/group cache and no joining of a read started by another request. A removal,
// suspension, archive, deletion or email change is therefore seen by the next authenticated request.
// Cost (accepted): per authenticated request two user reads (principal + membership slot), one group
// read and at least one member page per group in the tree. The token source is called (the token file
// re-read) before every HTTP request, pages included. The principal check and the membership lookup
// run one after the other, each under its own deadline (so about two deadlines per request).

export const DIRECTORY_ORIGIN = 'https://admin.googleapis.com';
const API_ROOT = '/admin/directory/v1';

/** Google stable user id (numeric), group id (lower-case alphanumeric) and customer id ("C..."). */
export const GOOGLE_USER_ID = /^\d{6,32}$/;
export const GOOGLE_GROUP_ID = /^[0-9a-z]{6,64}$/;
export const GOOGLE_CUSTOMER_ID = /^C[0-9A-Za-z]{4,20}$/;
const MEMBER_ID = /^[0-9A-Za-z]{1,64}$/;
const PAGE_TOKEN = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/-]{16,4096}=*$/;
const USER_FIELDS = 'id,primaryEmail,customerId,suspended,archived,deletionTime';

export type DirectoryFailure =
  | 'credential'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'too_large'
  | 'invalid'
  | 'budget';

/** Carries only the failure kind: never the token, URL, body or identifiers. */
export class DirectoryError extends Error {
  constructor(readonly failure: DirectoryFailure) {
    super(`directory read failed: ${failure}`);
  }
}

/** Existing access token (never created, refreshed or stored by this application). */
export type AccessTokenSource = () => Promise<string>;

/**
 * Re-reads the token file on every call. Owner-only regular file, no symlink (POSIX only; refused on
 * Windows); the content is validated, never logged. This application has NO credential lifecycle: it
 * never mints or refreshes the token, and whether any existing process keeps the file current is
 * unverified. Once the token expires every check is denied.
 */
export function fileAccessTokenSource(file: string, ops: LocalFileOps = NODE_LOCAL_FILE_OPS): AccessTokenSource {
  return async () => {
    let text: string;
    try {
      text = readStrictLocalFile(file, { maxBytes: 8192 }, ops).toString('utf8');
    } catch (err) {
      throw err instanceof LocalFileRefused ? new DirectoryError('credential') : err;
    }
    const token = text.replace(/\r?\n$/, '');
    if (!ACCESS_TOKEN.test(token)) throw new DirectoryError('credential');
    return token;
  };
}

export interface DirectoryBudgets {
  /** One whole lookup (user read + all groups and pages) or one principal check must finish within this time. */
  readDeadlineMs: number;
  /** Per HTTP request; never more than what is left of readDeadlineMs. */
  requestTimeoutMs: number;
  maxResponseBytes: number;
  /** Nesting depth below the configured group (the configured group is depth 0). */
  maxDepth: number;
  maxGroups: number;
  maxPages: number;
  maxMembers: number;
}

/**
 * Upper bound of readDeadlineMs: below the login core's provider timeout (PROPOSED_LOGIN_POLICY,
 * 5 s per provider call) so a slow lookup is reported as a limit by this reader, not cut off.
 */
export const MAX_DIRECTORY_DEADLINE_MS = 4_500;

export const DEFAULT_DIRECTORY_BUDGETS: DirectoryBudgets = {
  readDeadlineMs: 4_000,
  requestTimeoutMs: 2_000,
  maxResponseBytes: 512 * 1024,
  maxDepth: 8,
  maxGroups: 64,
  maxPages: 256,
  maxMembers: 50_000,
};

const userSchema = z.object({
  id: z.string().regex(GOOGLE_USER_ID),
  primaryEmail: z.string().min(3).max(254),
  customerId: z.string().regex(GOOGLE_CUSTOMER_ID),
  suspended: z.boolean(),
  archived: z.boolean(),
  deletionTime: z.string().max(64).optional(),
});
const groupSchema = z.object({ id: z.string().regex(GOOGLE_GROUP_ID), etag: z.string().max(256).optional() });
const memberSchema = z
  .object({
    id: z.string().regex(MEMBER_ID),
    type: z.enum(['USER', 'GROUP', 'CUSTOMER']),
    role: z.enum(['OWNER', 'MANAGER', 'MEMBER']),
    status: z.string().regex(/^[A-Z_]{1,32}$/).optional(),
    email: z.string().max(254).optional(),
  })
  // An all-users entry is an organization (customer id), never a person: it has no email.
  .refine((m) => m.type !== 'CUSTOMER' || (GOOGLE_CUSTOMER_ID.test(m.id) && m.email === undefined));
const membersPageSchema = z.object({
  members: z.array(memberSchema).max(200).optional(),
  nextPageToken: z.string().regex(PAGE_TOKEN).optional(),
});

export interface VerifiedDirectoryUser {
  id: string;
  /** Lower-cased primary address as the directory reports it. */
  primaryEmail: string;
  customerId: string;
  state: SubjectState;
  observedAt: number;
}

interface GroupGraph {
  resolution: MembershipResolution;
  /** USER id -> paths with ACTIVE member status. */
  activeUsers: Map<string, Set<'direct' | 'nested'>>;
  /** USER ids present only with a non-ACTIVE or missing member status. */
  otherUsers: Set<string>;
  customers: Set<string>;
  revision: string;
  observedAt: number;
}

export interface GoogleDirectoryOptions {
  /** Stable id of the eligible group (not an email or alias). */
  groupId: string;
  /** Customer id of the organization; principals must belong to it. */
  customerId: string;
  token: AccessTokenSource;
  fetchImpl?: typeof fetch;
  budgets?: Partial<DirectoryBudgets>;
  now?: () => number;
}

/** Stateless between calls: no user or group result and no in-flight read is kept or shared. */
export class GoogleDirectoryReader {
  private readonly fetchImpl: typeof fetch;
  private readonly budgets: DirectoryBudgets;
  private readonly now: () => number;

  constructor(private readonly options: GoogleDirectoryOptions) {
    if (!GOOGLE_GROUP_ID.test(options.groupId)) throw new Error('directory group id invalid');
    if (!GOOGLE_CUSTOMER_ID.test(options.customerId)) throw new Error('directory customer id invalid');
    if (typeof options.token !== 'function') throw new Error('directory token source missing');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.budgets = { ...DEFAULT_DIRECTORY_BUDGETS, ...options.budgets };
    this.now = options.now ?? Date.now;
    const b = this.budgets;
    if (Object.values(b).some((v) => !Number.isInteger(v) || v < 1)) throw new Error('directory budgets invalid');
    if (b.readDeadlineMs > MAX_DIRECTORY_DEADLINE_MS || b.requestTimeoutMs > b.readDeadlineMs) throw new Error('directory deadline invalid');
  }

  // ---- transport

  private async get(path: string, query: Record<string, string>, deadline: number): Promise<unknown> {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new DirectoryError('budget');
    const url = new URL(`${API_ROOT}${path}`, DIRECTORY_ORIGIN);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (url.origin !== DIRECTORY_ORIGIN || !url.pathname.startsWith(`${API_ROOT}/`)) throw new DirectoryError('invalid');
    let token: string;
    try {
      token = await this.options.token();
    } catch {
      throw new DirectoryError('credential');
    }
    if (typeof token !== 'string' || !ACCESS_TOKEN.test(token)) throw new DirectoryError('credential');
    let response: Response;
    try {
      response = await this.fetchImpl(url.href, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(this.budgets.requestTimeoutMs, remaining)),
      });
    } catch (err) {
      throw new DirectoryError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network');
    }
    try {
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.redirected) throw new DirectoryError('redirect');
      if (response.url && new URL(response.url).origin !== DIRECTORY_ORIGIN) throw new DirectoryError('redirect');
      if (response.status !== 200) {
        const s = response.status;
        throw new DirectoryError(s === 401 ? 'unauthorized' : s === 403 ? 'forbidden' : s === 404 ? 'not_found' : s === 429 ? 'rate_limited' : s >= 500 ? 'server' : 'invalid');
      }
      if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) throw new DirectoryError('invalid');
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > this.budgets.maxResponseBytes) throw new DirectoryError('too_large');
      const text = await this.readBounded(response);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new DirectoryError('invalid');
      }
    } finally {
      // Unread bodies are discarded, never logged.
      if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
    }
  }

  private async readBounded(response: Response): Promise<string> {
    if (!response.body) throw new DirectoryError('invalid');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.budgets.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DirectoryError('too_large');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof DirectoryError) throw err;
      throw new DirectoryError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network');
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DirectoryError('invalid');
    return parsed.data;
  }

  // ---- principal verification

  /** Fresh live user record by stable id (never cached). Throws DirectoryError on any failure (including not found). */
  async verifyUser(userId: string, deadline = this.now() + this.budgets.readDeadlineMs): Promise<VerifiedDirectoryUser> {
    if (!GOOGLE_USER_ID.test(userId)) throw new DirectoryError('invalid');
    const user = this.parse(userSchema, await this.get(`/users/${encodeURIComponent(userId)}`, { projection: 'basic', fields: USER_FIELDS }, deadline));
    if (user.id !== userId) throw new DirectoryError('invalid');
    return {
      id: user.id,
      primaryEmail: user.primaryEmail.toLowerCase(),
      customerId: user.customerId,
      state: user.deletionTime !== undefined ? 'deleted' : user.archived ? 'archived' : user.suspended ? 'suspended' : 'active',
      observedAt: this.now(),
    };
  }

  /**
   * True only for the exact live user: same stable id, same primary email, the configured customer
   * and an active state. A mismatch or inactive state is false; a read failure throws.
   */
  async verifyPrincipal(userId: string, primaryEmail: string): Promise<boolean> {
    const user = await this.verifyUser(userId);
    return user.id === userId && user.primaryEmail === primaryEmail && user.customerId === this.options.customerId && user.state === 'active';
  }

  // ---- effective membership

  /** One whole read of the group tree for one lookup, under the lookup's deadline. */
  private async readGraph(deadline: number): Promise<GroupGraph> {
    const b = this.budgets;
    const started = this.now();
    const graph: GroupGraph = { resolution: 'complete', activeUsers: new Map(), otherUsers: new Set(), customers: new Set(), revision: '', observedAt: started };
    const digest = createHash('sha256');
    try {
      const root = this.parse(groupSchema, await this.get(`/groups/${encodeURIComponent(this.options.groupId)}`, {}, deadline));
      // An email or alias would come back with a different id: only the stable id is accepted.
      if (root.id !== this.options.groupId) throw new DirectoryError('invalid');
      digest.update(`group\0${root.id}\0${root.etag ?? ''}\n`);
      const queue: { id: string; depth: number }[] = [{ id: root.id, depth: 0 }];
      const visited = new Set([root.id]);
      let pages = 0;
      let members = 0;
      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        const tokens = new Set<string>();
        let pageToken: string | undefined;
        do {
          pages += 1;
          if (pages > b.maxPages) throw new DirectoryError('budget');
          const query: Record<string, string> = { maxResults: '200' };
          if (pageToken) query.pageToken = pageToken;
          const page = this.parse(membersPageSchema, await this.get(`/groups/${encodeURIComponent(id)}/members`, query, deadline));
          for (const m of page.members ?? []) {
            members += 1;
            if (members > b.maxMembers) throw new DirectoryError('budget');
            digest.update(`${id}\0${m.type}\0${m.id}\0${m.role}\0${m.status ?? ''}\n`);
            if (m.type === 'USER') {
              if (m.status === 'ACTIVE') {
                const paths = graph.activeUsers.get(m.id) ?? new Set();
                paths.add(depth === 0 ? 'direct' : 'nested');
                graph.activeUsers.set(m.id, paths);
              } else {
                graph.otherUsers.add(m.id);
              }
            } else if (m.type === 'CUSTOMER') {
              graph.customers.add(m.id);
            } else if (!visited.has(m.id)) {
              if (!GOOGLE_GROUP_ID.test(m.id)) throw new DirectoryError('invalid');
              if (depth + 1 > b.maxDepth || visited.size >= b.maxGroups) throw new DirectoryError('budget');
              visited.add(m.id);
              queue.push({ id: m.id, depth: depth + 1 });
            }
            // An already visited group (cycle or diamond) adds nothing new and is not read again.
          }
          pageToken = page.nextPageToken;
          if (pageToken !== undefined) {
            // A repeated page token would never finish: the read is not complete.
            if (tokens.has(pageToken)) throw new DirectoryError('invalid');
            tokens.add(pageToken);
          }
        } while (pageToken !== undefined);
      }
    } catch (err) {
      const failure = err instanceof DirectoryError ? err.failure : 'invalid';
      graph.resolution =
        failure === 'budget' || failure === 'timeout'
          ? 'limit_exceeded'
          : failure === 'forbidden' || failure === 'not_found'
            ? 'forbidden'
            : failure === 'invalid' || failure === 'too_large' || failure === 'redirect'
              ? 'incomplete'
              : 'unavailable';
      return graph;
    }
    graph.revision = `gdir-${digest.digest('hex').slice(0, 32)}`;
    graph.observedAt = this.now();
    return graph;
  }

  private unresolved(groupId: string, memberKey: string, resolution: MembershipResolution, state: SubjectState): MembershipObservation {
    return {
      kind: EFFECTIVE_MEMBERSHIP_KIND,
      groupId,
      groupRevision: 'gdir-unresolved',
      memberKey,
      subjectType: 'user',
      subjectState: state,
      resolution,
      effectiveMember: 'unknown',
      provenance: [],
      organizationId: null,
      observedAt: this.now(),
    };
  }

  /**
   * GroupMembershipReader.lookup: memberKey is the stable Google user id from the registry. The user
   * read and the whole group read share one deadline (readDeadlineMs) and are made for this call only.
   */
  readonly lookup = async (groupId: string, memberKey: string): Promise<MembershipObservation> => {
    if (groupId !== this.options.groupId || !GOOGLE_USER_ID.test(memberKey)) return this.unresolved(groupId, memberKey, 'unavailable', 'unknown');
    const deadline = this.now() + this.budgets.readDeadlineMs;
    let user: VerifiedDirectoryUser;
    try {
      user = await this.verifyUser(memberKey, deadline);
    } catch (err) {
      const failure = err instanceof DirectoryError ? err.failure : 'invalid';
      return this.unresolved(
        groupId,
        memberKey,
        failure === 'forbidden' || failure === 'not_found' ? 'forbidden' : failure === 'budget' || failure === 'timeout' ? 'limit_exceeded' : 'unavailable',
        'unknown',
      );
    }
    // Inactive users and users of another organization are never resolved as members.
    if (user.state !== 'active') return this.unresolved(groupId, memberKey, 'incomplete', user.state);
    if (user.customerId !== this.options.customerId) return this.unresolved(groupId, memberKey, 'incomplete', 'unknown');

    const graph = await this.readGraph(deadline);
    if (graph.resolution !== 'complete') return this.unresolved(groupId, memberKey, graph.resolution, 'active');
    const provenance: MembershipProvenance[] = [];
    const paths = graph.activeUsers.get(memberKey);
    if (paths?.has('direct')) provenance.push('direct');
    if (paths?.has('nested')) provenance.push('nested');
    // CUSTOMER = everyone in that organization; compared with the VERIFIED customer of this user.
    if (graph.customers.has(user.customerId)) provenance.push('organization');
    if (provenance.length === 0 && graph.otherUsers.has(memberKey)) return this.unresolved(groupId, memberKey, 'incomplete', 'active');
    return {
      kind: EFFECTIVE_MEMBERSHIP_KIND,
      groupId,
      groupRevision: graph.revision,
      memberKey,
      subjectType: 'user',
      subjectState: 'active',
      resolution: 'complete',
      effectiveMember: provenance.length > 0,
      provenance,
      organizationId: provenance.includes('organization') ? user.customerId : null,
      observedAt: Math.min(graph.observedAt, user.observedAt),
    };
  };
}
