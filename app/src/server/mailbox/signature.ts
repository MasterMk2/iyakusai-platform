import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  committeeSignatureBody,
  defaultTitle,
  ownSignatureBody,
  type CommitteeSignatureBody,
  type OwnSignatureBody,
  type SignatureParts,
  type SignatureView,
} from '../../shared/signature.js';
import { writeFileDurable } from '../durable-file.js';
import { DomainError, type User } from '../domain/types.js';
import { HttpError } from '../http/http-error.js';

// The signature's settings (2026-11-10): signatures.json in the mail folder. Each person's title and own address,
// and the committee's address line and contact address (access administrators). A single-process JSON file,
// written durably and replaced in memory only after the write. A file that cannot be read turns the settings off
// (503) and leaves the file as it is; the forms then sign with the name alone, so sending never depends on it.

export const SIGNATURE_FILE = 'signatures.json';
const KIND = 'iyakusai-signatures' as const;

interface Own {
  title: string;
  personalEmail: string;
  updatedAt: string;
}

interface SignatureState {
  kind: typeof KIND;
  version: 1;
  committee: { address: string; contactEmail: string; updatedAt: string | null; updatedBy: string | null };
  people: Record<string, Own>;
}

const empty = (): SignatureState => ({ kind: KIND, version: 1, committee: { address: '', contactEmail: '', updatedAt: null, updatedBy: null }, people: {} });

const str = (v: unknown) => typeof v === 'string';
function valid(v: unknown): v is SignatureState {
  const s = v as Partial<SignatureState> | null;
  if (!s || s.kind !== KIND || s.version !== 1 || !s.committee || !s.people || typeof s.people !== 'object' || Array.isArray(s.people)) return false;
  const c = s.committee;
  if (!str(c.address) || !str(c.contactEmail) || !(c.updatedAt === null || str(c.updatedAt)) || !(c.updatedBy === null || str(c.updatedBy))) return false;
  return Object.values(s.people).every((p) => !!p && str(p.title) && str(p.personalEmail) && str(p.updatedAt));
}

export class SignatureStore {
  private constructor(
    private state: SignatureState,
    private readonly file: string | null,
  ) {}

  /** The store in the mail folder; throws when the file is there but cannot be read (the caller turns it off). */
  static open(dataDir: string): SignatureStore {
    const file = join(dataDir, SIGNATURE_FILE);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new SignatureStore(empty(), file);
      throw new Error('署名の設定ファイルを読み込めません。', { cause: err });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('署名の設定ファイルが JSON の形ではありません。', { cause: err });
    }
    if (!valid(parsed)) throw new Error('署名の設定ファイルの形が違います。');
    return new SignatureStore(parsed, file);
  }

  /** In memory only (tests). */
  static memory(): SignatureStore {
    return new SignatureStore(empty(), null);
  }

  private commit(next: SignatureState): void {
    if (this.file) writeFileDurable(this.file, `${JSON.stringify(next, null, 2)}\n`);
    this.state = next;
  }

  parts(user: User, organization: string): SignatureParts {
    const own = this.state.people[user.id];
    return {
      organization,
      name: user.displayName,
      title: own?.title || defaultTitle(user.roleLabel),
      address: this.state.committee.address,
      contactEmail: this.state.committee.contactEmail,
      personalEmail: own?.personalEmail ?? '',
    };
  }

  view(user: User, organization: string): SignatureView {
    const own = this.state.people[user.id];
    return {
      ...this.parts(user, organization),
      defaultTitle: defaultTitle(user.roleLabel),
      own: { title: own?.title ?? '', personalEmail: own?.personalEmail ?? '' },
      canEditCommittee: user.canManageAccess,
      updatedAt: own?.updatedAt ?? null,
      committeeUpdatedAt: this.state.committee.updatedAt,
    };
  }

  setOwn(user: User, body: OwnSignatureBody, at: string): void {
    const people = { ...this.state.people };
    // Both empty: nothing is kept for the person (the default applies).
    if (!body.title && !body.personalEmail) delete people[user.id];
    else people[user.id] = { title: body.title, personalEmail: body.personalEmail, updatedAt: at };
    this.commit({ ...this.state, people });
  }

  setCommittee(user: User, body: CommitteeSignatureBody, at: string): void {
    this.commit({ ...this.state, committee: { address: body.address, contactEmail: body.contactEmail, updatedAt: at, updatedBy: user.displayName } });
  }
}

export interface SignatureRouteDeps {
  /** The signed-in, enabled person (throws otherwise). */
  signedIn: (request: FastifyRequest) => User;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
  clock: () => string;
  /** The committee's name on the From line. */
  organization: string;
}

/** GET and PUT /api/signature (the person's own), PUT /api/signature/committee (access administrators). */
export function registerSignatureRoutes(app: FastifyInstance, store: SignatureStore | null, deps: SignatureRouteDeps): void {
  const opened = (): SignatureStore => {
    if (!store) throw new HttpError(503, { error: 'signature_unavailable', message: '署名の設定ファイルを読み込めないため、署名の設定は使えません（送信はできます）。' });
    return store;
  };

  app.get('/api/signature', async (request): Promise<SignatureView> => {
    const user = deps.signedIn(request);
    return opened().view(user, deps.organization);
  });

  app.put('/api/signature', async (request): Promise<SignatureView> => {
    const user = deps.signedIn(request);
    const body = deps.parse(ownSignatureBody, request.body);
    const s = opened();
    s.setOwn(user, body, deps.clock());
    return s.view(user, deps.organization);
  });

  app.put('/api/signature/committee', async (request): Promise<SignatureView> => {
    const user = deps.signedIn(request);
    if (!user.canManageAccess) throw new DomainError('forbidden', '委員会の署名の行を変えられるのは権限管理者だけです。');
    const body = deps.parse(committeeSignatureBody, request.body);
    const s = opened();
    s.setCommittee(user, body, deps.clock());
    return s.view(user, deps.organization);
  });
}
