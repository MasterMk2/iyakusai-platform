import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConfigError } from '../auth.js';
import { LINK_EVIDENCE, type IdentityLink, type LinkEvidence } from '../login/types.js';
import { normalizeEmail } from '../login/service.js';
import { GOOGLE_USER_ID } from './google-directory.js';
import { LocalFileRefused, NODE_LOCAL_FILE_OPS, readStrictLocalFile, type LocalFileOps } from './local-file.js';

// Binding / principal registry for the direct-provider composition. Read-only, kept outside Git,
// owner-only. It is only as authoritative as its origin: no ingestion from an existing verified
// authority exists yet (that authority and its contract are unverified), so a live registry is a
// blocker, not something to write by hand. Each binding links exactly one canonical Google user (stable id +
// primary email), one verified Discord user id, one existing internal principal and that
// principal's Task user (or null for no Task identity). Nothing here creates a person, principal,
// committee or Task user: a binding naming an unknown principal or disagreeing with the Task
// identity map makes the whole registry unusable. The file is re-read on every lookup; a missing,
// unreadable, symlinked, permissive, corrupt or incompatible file denies (never the old content).

export const REGISTRY_KIND = 'smm-identity-registry' as const;
export const REGISTRY_VERSION = 1 as const;

const PRINCIPAL_ID = /^[a-z0-9-]{1,40}$/;
const TASK_USER_ID = /^[a-z0-9-]{1,64}$/;
const LINK_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DISCORD_ID = /^[1-9]\d{16,19}$/;

const bindingSchema = z.strictObject({
  linkId: z.string().regex(LINK_ID),
  /** Incremented on every change of this binding; a different version revokes sessions bound to the old one. */
  linkVersion: z.number().int().min(1).max(1_000_000),
  status: z.enum(['active', 'revoked']),
  evidence: z.enum(LINK_EVIDENCE as unknown as [LinkEvidence, ...LinkEvidence[]]),
  google: z.strictObject({ userId: z.string().regex(GOOGLE_USER_ID), primaryEmail: z.string().max(254) }),
  discord: z.strictObject({ userId: z.string().regex(DISCORD_ID), verified: z.literal(true) }),
  principalId: z.string().regex(PRINCIPAL_ID),
  taskUserId: z.string().regex(TASK_USER_ID).nullable(),
});
const registrySchema = z.strictObject({
  kind: z.literal(REGISTRY_KIND),
  version: z.literal(REGISTRY_VERSION),
  bindings: z.array(bindingSchema).max(10_000),
});

export type RegistryBinding = z.infer<typeof bindingSchema>;

export interface IdentityRegistry {
  readonly digest: string;
  readonly bindings: readonly RegistryBinding[];
  byEmail(email: string): RegistryBinding | undefined;
  byLinkId(linkId: string): RegistryBinding | undefined;
  byPrincipal(principalId: string): RegistryBinding | undefined;
}

/** Checks of the existing application (internal users, Task identity map) that every active binding must pass. */
export interface RegistryCompatibility {
  principalExists(principalId: string): boolean;
  taskUserFor(principalId: string): string | null;
}

/** Strict parse. Messages name the problem and the entry number only, never values. */
export function parseIdentityRegistry(text: string, compat: RegistryCompatibility): IdentityRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('本人紐付けレジストリを JSON として解釈できません。');
  }
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const index = parsed.error.issues[0]?.path[1];
    throw new ConfigError(typeof index === 'number' ? `本人紐付けレジストリの ${index + 1} 番目の形式が正しくありません。` : '本人紐付けレジストリの kind / version / 形式が正しくありません。');
  }
  const unique = { linkId: new Set<string>(), principal: new Set<string>(), google: new Set<string>(), email: new Set<string>(), discord: new Set<string>(), task: new Set<string>() };
  const emails = new Map<string, RegistryBinding>();
  const links = new Map<string, RegistryBinding>();
  const principals = new Map<string, RegistryBinding>();
  parsed.data.bindings.forEach((b, i) => {
    const n = i + 1;
    // Canonical form only: the registry must already hold the exact normalized primary address.
    if (normalizeEmail(b.google.primaryEmail) !== b.google.primaryEmail) throw new ConfigError(`本人紐付けレジストリの ${n} 番目のメールアドレスが正規化されていません。`);
    // One record per person and per account, including revoked history: no ambiguous canonical links.
    const keys: [Set<string>, string | null][] = [
      [unique.linkId, b.linkId],
      [unique.principal, b.principalId],
      [unique.google, b.google.userId],
      [unique.email, b.google.primaryEmail],
      [unique.discord, b.discord.userId],
      [unique.task, b.taskUserId],
    ];
    for (const [set, value] of keys) {
      if (value === null) continue;
      if (set.has(value)) throw new ConfigError(`本人紐付けレジストリの ${n} 番目が他の項目と重複しています（1 人に 1 件）。`);
      set.add(value);
    }
    if (b.status === 'active') {
      if (!compat.principalExists(b.principalId)) throw new ConfigError(`本人紐付けレジストリの ${n} 番目が既存の利用者を指していません（利用者は作成しません）。`);
      if (compat.taskUserFor(b.principalId) !== b.taskUserId) throw new ConfigError(`本人紐付けレジストリの ${n} 番目のタスク利用者がタスク本人対応表と一致しません。`);
    }
    emails.set(b.google.primaryEmail, b);
    links.set(b.linkId, b);
    principals.set(b.principalId, b);
  });
  return {
    digest: createHash('sha256').update(text).digest('hex'),
    bindings: parsed.data.bindings,
    byEmail: (email) => emails.get(email),
    byLinkId: (linkId) => links.get(linkId),
    byPrincipal: (principalId) => principals.get(principalId),
  };
}

/** Registry source re-read (and re-validated) on every call. Throws on any problem: callers deny. */
export class FileIdentityRegistry {
  private cached: { hash: string; registry: IdentityRegistry } | null = null;

  constructor(
    private readonly file: string,
    private readonly compat: RegistryCompatibility,
    private readonly ops: LocalFileOps = NODE_LOCAL_FILE_OPS,
  ) {}

  current(): IdentityRegistry {
    let bytes: Buffer;
    try {
      // Owner-only like the token file: the registry holds primary emails and Discord ids.
      bytes = readStrictLocalFile(this.file, { maxBytes: 4 * 1024 * 1024 }, this.ops);
    } catch (err) {
      this.cached = null;
      if (err instanceof LocalFileRefused) throw new ConfigError(`本人紐付けレジストリを安全に読み込めません（${err.refusal}）。`);
      throw err;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    // Same bytes: the parsed result is reused, but compatibility is re-checked (users may have changed).
    if (this.cached?.hash === hash) {
      this.recheck(this.cached.registry);
      return this.cached.registry;
    }
    this.cached = null;
    const registry = parseIdentityRegistry(bytes.toString('utf8'), this.compat);
    this.cached = { hash, registry };
    return registry;
  }

  private recheck(registry: IdentityRegistry): void {
    for (const b of registry.bindings) {
      if (b.status === 'active' && (!this.compat.principalExists(b.principalId) || this.compat.taskUserFor(b.principalId) !== b.taskUserId)) {
        this.cached = null;
        throw new ConfigError('本人紐付けレジストリが現在の利用者またはタスク本人対応表と一致しません。');
      }
    }
  }
}

/** IdentityLink view of a binding. memberKey is the stable Google user id. */
export function bindingToLink(b: RegistryBinding): IdentityLink {
  return {
    linkId: b.linkId,
    version: b.linkVersion,
    status: b.status,
    email: b.google.primaryEmail,
    // The registry holds only the canonical primary address; the live check of that address against
    // the stable Google id happens in the principal check on every eligibility decision.
    emailVerified: true,
    discordUserId: b.discord.userId,
    memberKey: b.google.userId,
    principalId: b.principalId,
    evidence: b.evidence,
  };
}
