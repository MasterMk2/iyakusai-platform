import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, type User } from '../domain/types.js';
import { RENTAL_PERMISSIONS, type Actor, type RentalPermission, type RentalStore } from './store.js';
import { MAX_PHOTO_BYTES, MAX_PHOTOS, RentalError } from './validate.js';
import { IssuerManagement } from './issuer-management.js';
import { CardHistory } from './card-history.js';
import { RentalAccess } from './access.js';
import { IrregularCards } from './irregular-cards.js';
import { ItemEditor } from './item-editor.js';
import { OperationCorrections } from './corrections.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';

// Rental API and phone screen inside the common app. Identity is the common login (requireUser); what a
// person may do is the explicit rental permission of that account: rental.loan for loans and returns,
// rental.issue for planned borrowers and labels, either one to read. The operator may explicitly
// enable rental administration for every active signed-in member. Other modules keep their own roles.
// Paths are the Python server's under /api/rental, and errors keep its `{ error: message, code }` shape,
// which the phone screen shows as is. The screen itself is served at /rental and at /i/<item code>, the
// path written on QR labels and FeliCa cards. /api/rental/overview (the screen's information tab) exists
// only here, not on the Python server.

export interface RentalRuntime {
  store: RentalStore;
  /** Origin written on labels and cards (e.g. https://rental.iyakusai.com); null accepts any https origin. */
  itemOrigin: string | null;
  /** Built phone screen (index.html, app.js, …); null serves the API only. */
  webDir: string | null;
  /** Key of the signed copy to Google Drive (drive-sync.ts); absent or null: no copy, nothing mounted. */
  driveSyncKey?: Buffer | null;
  /** Authenticated active members have every rental operation, including reset. Other modules retain their own access checks. */
  allMembersAdmin?: boolean;
}

export interface RentalRouteContext {
  rental: RentalRuntime | null;
  requireUser: (request: FastifyRequest) => User;
  lookupUser: (userId: string) => User | undefined;
  listUsers?: () => User[];
}

const PREFIX = '/api/rental';
// connect-src allows 物品読取 on the same PC (Windows desk with an RC-S370, clients/issuer/desktop/reader_bridge.py),
// which offers the cards it reads on 127.0.0.1:48731 only.
const RENTAL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' http://127.0.0.1:48731; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const RENTAL_PERMISSIONS_POLICY = 'camera=(self), microphone=(), geolocation=(), payment=()';
const STORAGE_FAILURE = { error: '保存を完了できませんでした。同じ処理を再送してください。', code: 'storage_unavailable' };
const READ: readonly RentalPermission[] = ['rental.loan', 'rental.issue'];
const PRINT_RULES_FILE = 'print-rules.json';

/**
 * The return-place rules the print sheet starts from (print.js). They name the lenders and the places on campus,
 * so they live beside the ledger as print-rules.json, not in the source. Missing or unreadable means none.
 */
function printRules(root: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, PRINT_RULES_FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type Result = readonly [number, unknown];

function errorBody(err: unknown): Result {
  if (err instanceof RentalError) return [err.status, { error: err.message, code: err.code }];
  if (err instanceof DomainError) {
    const status = { unauthenticated: 401, forbidden: 403, not_found: 404, validation: 400, conflict: 409 }[err.code];
    return [status, { error: err.message, code: err.code === 'unauthenticated' ? 'unauthorized' : err.code }];
  }
  const code = (err as { code?: unknown } | null)?.code;
  // Disk and SQLite failures: the transaction was rolled back, so the same operation can be resent.
  if (typeof code === 'string' && (code.startsWith('ERR_SQLITE') || /^E[A-Z]+$/.test(code))) return [503, STORAGE_FAILURE];
  return [500, { error: '処理を完了できませんでした。', code: 'internal_error' }];
}

async function respond(reply: FastifyReply, fn: () => Result | Promise<Result>) {
  let result: Result;
  try {
    result = await fn();
  } catch (err) {
    result = errorBody(err);
  }
  return reply.code(result[0]).header('Cache-Control', 'no-store').send(result[1]);
}

/** Multipart errors from @fastify/multipart, mapped to the Python server's answers. */
function multipartError(err: unknown): never {
  if (err instanceof RentalError) throw err;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
    throw new RentalError(413, '写真は最大 5 枚、各 2 MB 以下です。');
  }
  if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') throw new RentalError(415, 'multipart/form-data 形式で送信してください。');
  throw new RentalError(400, '送信データの区切りが正しくありません。');
}

function jsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) throw new RentalError(400, 'JSON オブジェクトで送信してください。');
  return body as Record<string, unknown>;
}

export async function registerRentalRoutes(app: FastifyInstance, ctx: RentalRouteContext): Promise<void> {
  const rental = ctx.rental;
  const itemEditor = rental ? new ItemEditor(rental.store) : null;
  const corrections = rental ? new OperationCorrections(rental.store) : null;
  const cards = rental ? new CardHistory(rental.store) : null;
  const issuer = rental ? new IssuerManagement(rental.store, rental.itemOrigin) : null;
  const rentalAccess = rental ? new RentalAccess(rental.store, rental.allMembersAdmin === true) : null;
  const irregular = rental ? new IrregularCards(rental.store, rental.itemOrigin, () => issuer!.snapshot().revision) : null;
  const canAdministerRental = (user: User): boolean => rentalAccess?.isAdmin(user) === true;

  /** The signed-in account, its rental permissions, and a check that it holds one of `needed`. */
  function access(request: FastifyRequest, needed: readonly RentalPermission[] | null): { user: User; actor: Actor; permissions: RentalPermission[]; store: RentalStore } {
    if (!rental) throw new RentalError(404, '物品貸出はこのサーバーでは設定されていません。', 'not_found');
    const user = ctx.requireUser(request);
    if (user.disabled) throw new DomainError('forbidden', 'このアカウントは利用できません。');
    const permissions = rentalAccess!.permissions(user.id);
    if (needed && !needed.some((p) => permissions.includes(p))) {
      throw new RentalError(403, needed.includes('rental.issue') && !needed.includes('rental.loan') ? '物品の発行・事前登録の権限がありません。管理者に依頼してください。' : '物品の貸出権限がありません。管理者に依頼してください。', 'forbidden');
    }
    if(request.method!=='GET'&&request.method!=='HEAD'&&(/^\/api\/rental\/(?:issuer\/|card-history\/|preassignments(?:$|\?))/.test(request.url)))
      rental.store.checkLedgerGeneration(request.headers['x-rental-generation']);
    return { user, actor: { id: user.id, name: user.displayName }, permissions, store: rental.store };
  }

  app.get(`${PREFIX}/me`, async (request, reply) =>
    respond(reply, () => {
      const { actor, permissions, user } = access(request, null);
      return [200, { staff: actor, permissions, temporary_staff: isTemporaryStaffLoginId(user.id), mode: rental!.store.mode, ledger_generation:rental!.store.ledgerGeneration(), item_origin: rental!.itemOrigin, trial_short_codes: false, can_edit_items: READ.some((p) => permissions.includes(p)), can_correct: READ.some((p) => permissions.includes(p)), capabilities: ['operation_corrections_v1', 'item_edit_v1', 'irregular_cards_v1', 'item_metadata_v1', 'issuer_management_v1', 'issuer_force_reset_v1', 'issuer_numbering_reset_v1','issuer_reset_code_v1','card_history_v1'], issuer_reset_allowed: canAdministerRental(user), can_manage_permissions: user.canManageAccess }];
    }),
  );

  app.get(`${PREFIX}/card-history`, async (request, reply) => respond(reply, () => {
    access(request, ['rental.issue']); return [200, cards!.snapshot()];
  }));
  app.get(`${PREFIX}/card-history/backup`, async (request, reply) => respond(reply, () => {
    access(request, ['rental.issue']); return [200, cards!.backupIndex()];
  }));
  app.post(`${PREFIX}/card-history/backup-files`, async (request, reply) => respond(reply, () => {
    access(request, ['rental.issue']); return [200, cards!.backupFiles(jsonObject(request.body))];
  }));
  app.post(`${PREFIX}/card-history/import`, { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => respond(reply, () => {
    const { actor, user } = access(request, ['rental.issue']);
    if (!canAdministerRental(user)) throw new RentalError(403, '旧版の履歴の取り込みは物品管理者が行います。');
    return [200, cards!.importLegacy(jsonObject(request.body), actor)];
  }));
  app.post(`${PREFIX}/card-history/claim`, async (request, reply) => respond(reply, () => {
    const { actor } = access(request, ['rental.issue']); return [200, cards!.claim(jsonObject(request.body), actor)];
  }));
  app.post(`${PREFIX}/card-history/transition`, { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => respond(reply, () => {
    const { actor } = access(request, ['rental.issue']); return [200, cards!.transition(jsonObject(request.body), actor)];
  }));
  app.post(`${PREFIX}/card-history/cancel`, { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => respond(reply, () => {
    const { actor } = access(request, ['rental.issue']); return [200, cards!.cancel(jsonObject(request.body), actor)];
  }));
  app.post(`${PREFIX}/card-history/recover`, async (request, reply) => respond(reply, () => {
    const { actor, user } = access(request, ['rental.issue']);
    if (!canAdministerRental(user)) throw new RentalError(403, '未完了の発行の引継ぎは物品管理者が行います。');
    return [200, cards!.recover(jsonObject(request.body), actor)];
  }));

  app.get(`${PREFIX}/borrowers`, async (request, reply) =>
    respond(reply, () => {
      const { store } = access(request, READ);
      return [200, { borrowers: store.borrowers(), groups: store.borrowerGroups() }];
    }),
  );

  app.get(`${PREFIX}/summary`, async (request, reply) =>
    respond(reply, () => [200, access(request, READ).store.summary()]),
  );

  app.get(`${PREFIX}/overview`, async (request, reply) =>
    respond(reply, () => {
      const { store } = access(request, READ);
      return [200, { ...store.overview(), drive_sync: store.driveSyncStatus(), print_rules: printRules(store.root) }];
    }),
  );

  app.get<{ Params: { code: string } }>(`${PREFIX}/items/:code`, async (request, reply) =>
    respond(reply, () => [200, access(request, READ).store.item(request.params.code)]),
  );

  // Editing item details and correcting registrations are open to everyone who handles items
  // (temporary staff included); each change records who made it.
  app.get<{ Params: { code: string } }>(`${PREFIX}/items/:code/metadata`, async (request, reply) => respond(reply, () => {
    access(request, READ);
    return [200, itemEditor!.snapshot(request.params.code)];
  }));
  app.patch<{ Params: { code: string } }>(`${PREFIX}/items/:code/metadata`, { bodyLimit: 8192 }, async (request, reply) => respond(reply, () => {
    const { actor } = access(request, READ);
    return [200, itemEditor!.update(request.params.code, jsonObject(request.body), actor)];
  }));
  app.get<{ Params: { code: string } }>(`${PREFIX}/items/:code/corrections`, async (request, reply) => respond(reply, () => {
    access(request, READ);
    return [200, corrections!.snapshot(request.params.code)];
  }));
  app.post<{ Params: { code: string } }>(`${PREFIX}/items/:code/corrections`, { bodyLimit: 8192 }, async (request, reply) => respond(reply, () => {
    const { actor } = access(request, READ);
    return [200, corrections!.apply(request.params.code, jsonObject(request.body), actor)];
  }));

  app.get<{ Params: { id: string } }>(`${PREFIX}/operations/:id`, async (request, reply) =>
    respond(reply, () => [200, access(request, READ).store.operation(request.params.id)]),
  );

  app.get<{ Params: { code: string } }>(`${PREFIX}/items/:code/inspection`, async (request, reply) =>
    respond(reply, () => [200, access(request, READ).store.inspection(request.params.code)]),
  );

  app.get<{ Params: { id: string; index: string } }>(`${PREFIX}/operations/:id/photos/:index`, async (request, reply) => {
    try {
      const photo = access(request, READ).store.loanPhoto(request.params.id, request.params.index);
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').type(photo.mime).send(photo.data);
    } catch (err) {
      const [status, body] = errorBody(err);
      return reply.code(status).header('Cache-Control', 'no-store').send(body);
    }
  });

  app.get<{ Params: { code: string } }>(`${PREFIX}/issuance/:code`, async (request, reply) =>
    respond(reply, () => [200, access(request, READ).store.issuance(request.params.code)]),
  );

  app.post(`${PREFIX}/borrowers`, async (request, reply) =>
    respond(reply, () => {
      const { store } = access(request, READ);
      const result = store.createBorrower(jsonObject(request.body).name);
      return [result.created ? 201 : 200, result];
    }),
  );

  app.post(`${PREFIX}/preassignments`, { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) =>
    respond(reply, () => {
      const { store, actor } = access(request, ['rental.issue']);
      return [200, store.preassign(jsonObject(request.body).items, actor, rental!.itemOrigin)];
    }),
  );

  app.get(`${PREFIX}/issuer/state`, async (request, reply) => respond(reply, () => {
    const { user } = access(request, ['rental.issue']);
    return [200, { ...issuer!.snapshot(), reset_allowed: canAdministerRental(user) }];
  }));
  app.post(`${PREFIX}/issuer/irregular-cards`, async (request, reply) => respond(reply, () => {
    const { actor } = access(request, ['rental.issue']);
    return [200, irregular!.create(jsonObject(request.body), actor)];
  }));
  app.post(`${PREFIX}/issuer/preview`, { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => respond(reply, () => {
    const { actor, user } = access(request, ['rental.issue']);
    return [200, issuer!.preview(jsonObject(request.body), actor, canAdministerRental(user))];
  }));
  app.post(`${PREFIX}/issuer/apply`, async (request, reply) => respond(reply, () => {
    const { actor, user } = access(request, ['rental.issue']);
    return [200, issuer!.apply(jsonObject(request.body), actor, canAdministerRental(user))];
  }));

  function permissionsAdmin(request: FastifyRequest): { user: User; actor: Actor } {
    const { user, actor } = access(request, null);
    if (!user.canManageAccess) throw new RentalError(403, '物品の権限を変更できるのは共通システムの権限管理者だけです。', 'forbidden');
    return { user, actor };
  }
  const accessSnapshot = () => rentalAccess!.snapshot(ctx.listUsers?.() ?? [], ctx.lookupUser);
  app.get(`${PREFIX}/admin/access`, async (request, reply) => respond(reply, () => {
    permissionsAdmin(request);
    return [200, accessSnapshot()];
  }));
  app.put(`${PREFIX}/admin/access`, async (request, reply) => respond(reply, () => {
    const { actor } = permissionsAdmin(request);
    const body = jsonObject(request.body);
    if (body.kind === 'policy') rentalAccess!.updatePolicy(body.allMembersAdmin, body.expectedRevision, actor);
    else if (body.kind === 'account') {
      if (typeof body.userId !== 'string') throw new RentalError(400, '変更する委員を指定してください。');
      const target = ctx.lookupUser(body.userId);
      if (!target || target.disabled) throw new RentalError(404, '利用できるアカウントが見つかりません。', 'not_found');
      rentalAccess!.updateAccount(target.id, body.permissions, body.expectedRevision, actor);
    } else throw new RentalError(400, '変更する設定を指定してください。');
    return [200, accessSnapshot()];
  }));
  app.get(`${PREFIX}/admin/permissions`, async (request, reply) => respond(reply, () => {
    permissionsAdmin(request);
    return [200, { permissions: RENTAL_PERMISSIONS, accounts: rental!.store.listPermissions(), all_members_admin: rentalAccess!.policy().allMembersAdmin }];
  }));
  app.put<{ Params: { userId: string } }>(`${PREFIX}/admin/permissions/:userId`, async (request, reply) => respond(reply, () => {
    const { actor } = permissionsAdmin(request);
    const target = ctx.lookupUser(request.params.userId);
    if (!target || target.disabled) throw new RentalError(404, 'このアカウントは見つかりません。', 'not_found');
    const body = jsonObject(request.body);
    rentalAccess!.updateAccount(target.id, body.permissions, body.expectedRevision, actor, true);
    return [200, { userId: target.id, permissions: rentalAccess!.permissions(target.id) }];
  }));

  // Loans and returns: one metadata part and up to five photos, streamed with per-part limits.
  await app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS + 1, fields: 2, fieldSize: 16 * 1024, parts: MAX_PHOTOS + 3 } });
    scope.post(`${PREFIX}/operations`, { bodyLimit: MAX_PHOTO_BYTES * MAX_PHOTOS + 128 * 1024 }, async (request, reply) =>
      respond(reply, async () => {
        const { store, actor } = access(request, ['rental.loan']);
        if (!request.isMultipart()) throw new RentalError(415, 'multipart/form-data 形式で送信してください。');
        let metadata: unknown;
        let seenMetadata = false;
        const photos: Buffer[] = [];
        try {
          for await (const part of request.parts()) {
            if (part.fieldname === 'metadata' || part.fieldname === 'metadataJSON') {
              if (seenMetadata) throw new RentalError(400, 'metadata を 1 個送信してください。');
              seenMetadata = true;
              let raw: Buffer;
              if (part.type === 'file') raw = await part.toBuffer();
              else if (part.valueTruncated) throw new RentalError(400, 'metadata を 1 個送信してください。');
              else raw = Buffer.from(String(part.value), 'utf8');
              if (raw.length > 16 * 1024) throw new RentalError(400, 'metadata を 1 個送信してください。');
              try {
                metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
              } catch {
                throw new RentalError(400, 'metadata を読み取れません。');
              }
            } else if (part.fieldname === 'photos' && part.type === 'file') {
              photos.push(await part.toBuffer());
              if (photos.length > MAX_PHOTOS) throw new RentalError(413, '写真は最大 5 枚、各 2 MB 以下です。');
            } else {
              throw new RentalError(400, '送信フィールドを確認してください。');
            }
          }
        } catch (err) {
          multipartError(err);
        }
        if (!seenMetadata) throw new RentalError(400, 'metadata が必要です。');
        const receipt = store.submit(metadata, photos, actor);
        return [receipt.status === 'drive_pending' || receipt.status === 'drive_error' ? 202 : 200, receipt];
      }),
    );
  });

  // ---- phone screen
  const webDir = rental?.webDir;
  if (!webDir || !existsSync(path.join(webDir, 'index.html'))) {
    // The common app always shows the 物品貸出 tab; without the rental screen the page explains why.
    app.get('/rental', async (_request, reply) =>
      reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>物品貸出｜医薬祭 委員会アプリ</title><body style="font-family:system-ui,sans-serif;margin:24px"><h1>物品貸出を開けません</h1><p>このサーバーでは物品貸出が設定されていません。</p><p><a href="/#/home">ホームへ戻る</a></p></body></html>'),
    );
    return;
  }
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
  };
  const files = new Map<string, { data: Buffer; type: string; etag: string }>();
  for (const name of ['index.html', 'app.js', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'vendor/jsQR.js', 'print.html', 'print.js', 'print.css']) {
    const file = path.join(webDir, name);
    if (!existsSync(file)) continue;
    const data = readFileSync(file);
    files.set(name, { data, type: types[path.extname(name)]!, etag: `"${createHash('sha256').update(data).digest('hex')}"` });
  }

  function send(request: FastifyRequest, reply: FastifyReply, name: string) {
    const file = files.get(name);
    if (!file) return reply.code(404).send({ error: 'ファイルが見つかりません。', code: 'not_found' });
    reply.header('Content-Security-Policy', RENTAL_CSP).header('Permissions-Policy', RENTAL_PERMISSIONS_POLICY).header('Cache-Control', 'no-cache').header('ETag', file.etag);
    if (name === 'sw.js') reply.header('Service-Worker-Allowed', '/');
    if (request.headers['if-none-match'] === file.etag) return reply.code(304).send();
    return reply.type(file.type).send(file.data);
  }

  app.get('/rental', async (request, reply) => send(request, reply, 'index.html'));
  app.get('/rental/', async (request, reply) => send(request, reply, 'index.html'));
  app.get<{ Params: { code: string } }>('/i/:code', async (request, reply) => {
    // Same rule as the Python server: any IY- code path opens the screen; the API decides if it exists.
    if (!/^IY-[A-Z0-9-]+$/.test(request.params.code)) return reply.code(404).send({ error: 'ファイルが見つかりません。', code: 'not_found' });
    return send(request, reply, 'index.html');
  });
  app.get('/rental-sw.js', async (request, reply) => send(request, reply, 'sw.js'));
  // 返却チェックシートの印刷（print.js が /api/rental/overview を読んで票にする）
  app.get('/rental/print', async (request, reply) => send(request, reply, 'print.html'));
  for (const name of ['app.js', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'vendor/jsQR.js', 'print.js', 'print.css']) {
    app.get(`/rental/${name}`, async (request, reply) => send(request, reply, name));
  }
}
