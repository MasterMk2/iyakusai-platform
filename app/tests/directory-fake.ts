import type { Stats } from 'node:fs';
import type { RegistryBinding } from '../src/server/account/identity-registry.js';
import { NODE_LOCAL_FILE_OPS, type LocalFileOps } from '../src/server/account/local-file.js';

// Synthetic Google Directory (read API shape only) served through an injected fetch. Made-up
// numeric user ids, group ids, customer ids and reserved .invalid addresses; no network at all.

export const SYN_CUSTOMER = 'C0synth01';
export const OTHER_CUSTOMER = 'C0other99';
export const SYN_TOKEN = 'synthetic-access-token-0123456789abcdef';
export const ROOT_GROUP = 'grpsynthroot';

export const uid = (n: number): string => `1000000000000000000${String(n).padStart(2, '0')}`;

/** Synthetic registry binding for synthetic directory user n. */
export const binding = (n: number, principalId: string, taskUserId: string | null, extra: Partial<RegistryBinding> = {}): RegistryBinding => ({
  linkId: `link-${n}`,
  linkVersion: 1,
  status: 'active',
  evidence: 'verified_roster',
  google: { userId: uid(n), primaryEmail: `person-${n}@synthetic.invalid` },
  discord: { userId: `30000000000000000${String(n).padStart(2, '0')}`, verified: true },
  principalId,
  taskUserId,
  ...extra,
});
export const registryDoc = (bindings: unknown[]): string => JSON.stringify({ kind: 'smm-identity-registry', version: 1, bindings });

const SYN_UID = 4242;

/**
 * File access for tests that read real temporary files through the strict local-file reader.
 * POSIX hosts: the real file system with its real owner/mode checks (tests write files as 0600).
 * Windows hosts: the real reader refuses (no POSIX owner/mode there). This TEST-ONLY synthetic view
 * passes real bytes, type, identity and size through but REPORTS the owner as the process user and
 * the mode as 0600; Windows file permissions are NOT checked by it. Synthetic trials only.
 */
export function hostFileOps(): LocalFileOps {
  if (process.platform !== 'win32') return NODE_LOCAL_FILE_OPS;
  const view = (st: Stats): Stats => Object.assign(Object.create(Object.getPrototypeOf(st) as object) as Stats, st, { uid: SYN_UID, mode: (st.mode & 0o170000) | 0o600 });
  return {
    ...NODE_LOCAL_FILE_OPS,
    platform: 'linux',
    uid: () => SYN_UID,
    lstat: (file) => view(NODE_LOCAL_FILE_OPS.lstat(file)),
    fstat: (fd) => view(NODE_LOCAL_FILE_OPS.fstat(fd)),
  };
}

export interface SynUser {
  id: string;
  primaryEmail: string;
  customerId: string;
  suspended: boolean;
  archived: boolean;
  deletionTime?: string;
}

export interface SynMember {
  id: string;
  type: 'USER' | 'GROUP' | 'CUSTOMER' | string;
  role?: string;
  status?: string;
  email?: string;
}

export type Fault =
  | { kind: 'status'; status: number }
  | { kind: 'redirect' }
  | { kind: 'throw'; name: string }
  | { kind: 'body'; body: string; contentType?: string }
  | { kind: 'stream'; bytes: number }
  | { kind: 'declared'; length: number }
  | { kind: 'hang' }
  /** Answers normally after a delay (aborts like a real transport). */
  | { kind: 'delay'; ms: number };

export class SyntheticGoogleDirectory {
  users = new Map<string, SynUser>();
  groups = new Map<string, SynMember[]>();
  pageSize = 200;
  /** Requests seen: method, full URL and whether the expected bearer token was presented. */
  requests: { method: string; url: string; authorized: boolean }[] = [];
  /** Fault per path (exact pathname) or per path + page token. */
  faults = new Map<string, Fault>();
  token = SYN_TOKEN;
  /** Optional fixed page token loop for a group (the same token forever). */
  loopTokens = new Set<string>();
  /** Answers held back until the promise settles (exact pathname). The answer reflects the data at request time. */
  holds = new Map<string, Promise<void>>();

  addUser(n: number, overrides: Partial<SynUser> = {}): SynUser {
    const user: SynUser = { id: uid(n), primaryEmail: `person-${n}@synthetic.invalid`, customerId: SYN_CUSTOMER, suspended: false, archived: false, ...overrides };
    this.users.set(user.id, user);
    return user;
  }

  group(id: string, members: SynMember[] = []): void {
    this.groups.set(id, members);
  }

  member(groupId: string, m: SynMember): void {
    this.groups.get(groupId)!.push({ role: 'MEMBER', ...(m.type === 'USER' ? { status: 'ACTIVE' } : {}), ...m });
  }

  remove(groupId: string, memberId: string): void {
    this.groups.set(groupId, this.groups.get(groupId)!.filter((m) => m.id !== memberId));
  }

  membersRequests(groupId: string): number {
    return this.requests.filter((r) => new URL(r.url).pathname === `/admin/directory/v1/groups/${groupId}/members`).length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const answer = await this.answer(input, init);
    const hold = this.holds.get(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname);
    if (hold) await hold;
    return answer;
  };

  private async answer(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url: url.href, authorized: headers.get('authorization') === `Bearer ${this.token}` });
    if (url.origin !== 'https://admin.googleapis.com' || method !== 'GET') return json(404, { error: 'unexpected' });
    if (headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { error: { code: 401 } });
    const fault = this.faults.get(`${url.pathname}#${url.searchParams.get('pageToken') ?? ''}`) ?? this.faults.get(url.pathname);
    if (fault?.kind === 'delay') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, fault.ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal!.reason instanceof Error ? init.signal!.reason : Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    } else if (fault) {
      return applyFault(fault, init?.signal ?? undefined);
    }

    const parts = url.pathname.replace('/admin/directory/v1/', '').split('/').map(decodeURIComponent);
    if (parts[0] === 'users' && parts.length === 2) {
      const user = this.users.get(parts[1]!);
      if (!user) return json(404, { error: { code: 404 } });
      return json(200, { kind: 'admin#directory#user', ...user });
    }
    if (parts[0] === 'groups' && parts.length === 2) {
      return this.groups.has(parts[1]!) ? json(200, { kind: 'admin#directory#group', id: parts[1], email: `${parts[1]}@groups.synthetic.invalid`, etag: '"e1"' }) : json(404, {});
    }
    if (parts[0] === 'groups' && parts[2] === 'members' && parts.length === 3) {
      const all = this.groups.get(parts[1]!);
      if (!all) return json(404, {});
      if (url.searchParams.get('includeDerivedMembership') !== null) return json(400, {});
      const start = Number(url.searchParams.get('pageToken')?.replace('p', '') ?? '0');
      const slice = all.slice(start, start + this.pageSize);
      const next = start + this.pageSize < all.length ? `p${start + this.pageSize}` : undefined;
      const loop = this.loopTokens.has(parts[1]!) ? 'p0' : undefined;
      return json(200, { kind: 'admin#directory#members', ...(slice.length > 0 ? { members: slice } : {}), ...(loop ?? next ? { nextPageToken: loop ?? next } : {}) });
    }
    return json(404, {});
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
}

async function applyFault(fault: Fault, signal: AbortSignal | undefined): Promise<Response> {
  switch (fault.kind) {
    case 'status':
      return json(fault.status, { error: { code: fault.status, message: 'synthetic failure body' } });
    case 'redirect':
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example.invalid/x' } });
    case 'throw': {
      const err = new Error('synthetic transport failure');
      err.name = fault.name;
      throw err;
    }
    case 'body':
      return new Response(fault.body, { status: 200, headers: { 'content-type': fault.contentType ?? 'application/json' } });
    case 'declared':
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(fault.length) } });
    case 'stream': {
      let sent = 0;
      const chunk = new Uint8Array(64 * 1024).fill(0x20);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= fault.bytes) return controller.close();
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    case 'hang':
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    case 'delay':
      throw new Error('handled by the caller');
  }
}
