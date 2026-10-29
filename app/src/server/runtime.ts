import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AccountRuntime } from './account/http.js';
import { IdentityBridgeClient } from './account/bridge-client.js';
import { directIdentityProviders, unavailableDmDelivery } from './account/direct-providers.js';
import { fileAccessTokenSource, GoogleDirectoryReader } from './account/google-directory.js';
import { FileIdentityRegistry } from './account/identity-registry.js';
import { NODE_LOCAL_FILE_OPS, type LocalFileOps } from './account/local-file.js';
import { MOCK_GROUP_ID, MOCK_ORGANIZATION_ID, MockAccountProviders } from './account/mock-providers.js';
import { assertMappedUsers, ConfigError } from './auth.js';
import type { ServerConfig } from './config.js';
import { createSeedState } from './domain/seed.js';
import { StateStore } from './domain/store.js';
import type { AppState, User } from './domain/types.js';
import { buildApp } from './http/app.js';
import type { LineRuntime } from './http/line-routes.js';
import { MockLinePushConnector } from './line/connector.js';
import { createLineSeedState } from './line/seed.js';
import { LineStore } from './line/store.js';
import type { LineState } from './line/types.js';
import { FileLoginPersistence, fileAuditSink, LoginService, memoryAuditSink, REFERENCE_STORE_ACK, type LoginServiceOptions } from './login/index.js';
import { parseTaskBridge, SYNTHETIC_TASK_BRIDGE_JSON, type TaskIdentityBridge } from './tasks/bridge.js';
import { TaskServiceClient, type TaskBackend } from './tasks/client.js';
import { InProcessTaskBackend } from './tasks/in-process.js';
import { AssistantServiceClient } from './assistant/client.js';
import type { AssistantRuntime } from './assistant/routes.js';
import { AppError as TaskAppError } from '../task-service/server/domain/errors.js';
import { TaskService } from '../task-service/server/domain/taskService.js';
import { FileStore as TaskFileStore } from '../task-service/server/storage/fileStore.js';
import { emptyLinkState, TaskLinkStore } from './tasks/links.js';
import type { TaskRuntime } from './tasks/routes.js';
import type { RentalRuntime } from './rental/routes.js';
import { RentalStore } from './rental/store.js';
import { LoginAudit } from './discord-auth/audit.js';
import { createBotHostClients } from './discord-auth/bot-host.js';
import type { DiscordAuthRuntime } from './discord-auth/http.js';
import { NameRoster, StudentIdRoster } from './discord-auth/names.js';
import { DiscordAccountService, normalizeStudentId } from './discord-auth/service.js';
import { AccountStore } from './discord-auth/store.js';
import { seedRentalDemo } from './rental/seed.js';
import { CommitteeAddresses } from './mailbox/addresses.js';
import type { MailboxRuntime } from './mailbox/routes.js';
import { MailboxStore } from './mailbox/store.js';

// Server composition from a validated configuration (used by main.ts and by tests that exercise
// the real production composition). Nothing here listens or installs signal handlers.

/** Startup refused; the message is safe to print (no secrets, paths, identities or file contents). */
export class StartupRefusal extends Error {}

/** An inbox with nothing in it (no users, mailboxes, messages or grants), for the unified app's first start. */
function emptyMailState(seed: AppState): AppState {
  const state: AppState = { ...seed, users: [], mailboxes: [], grants: [], messages: [], receipts: [], audit: [], seq: 0, mockConnector: { releasedBatch: 0, cursors: {} } };
  // The sample's approved shared-mail list names sample mailboxes; an absent policy denies mail reads.
  delete state.committeeSharedMailReadPolicy;
  return state;
}

export interface ServerRuntime {
  app: FastifyInstance;
  /** Present in account mode: the login service whose dispatch queue and state are drained on shutdown. */
  account: AccountRuntime | null;
  hosted: boolean;
}

function refuse(message: string): never {
  throw new StartupRefusal(message);
}

/** Injection points for tests of the real composition (never set by main.ts). */
export interface ComposeOverrides {
  /** Transport for the Directory read adapter (direct provider); defaults to the global fetch. */
  directoryFetch?: typeof fetch;
  /**
   * File access for the token and registry files (direct provider); defaults to the real file system,
   * which refuses on Windows. Only tests inject a synthetic view to exercise the composition there.
   */
  localFileOps?: LocalFileOps;
}

export async function composeServer(config: ServerConfig, overrides: ComposeOverrides = {}): Promise<ServerRuntime> {
  const hosted = config.auth.mode === 'trusted-proxy' || config.auth.mode === 'discord' || (config.auth.mode === 'account' && config.auth.composition === 'production');
  const now = new Date().toISOString();
  let existing: AppState | null;
  if (hosted) {
    // Hosted data holds user-entered notes and access changes: only a missing file
    // may be seeded. An existing file that cannot be read or validated is never reseeded or overwritten.
    const stored = StateStore.inspect(config.dataFile);
    if (stored.kind === 'invalid') {
      refuse('既存のデータファイルを読み込めないか、内容が正しくありません。データファイルは変更していません。バックアップからの復元または内容の確認が必要です。');
    }
    if (stored.kind === 'missing' && !config.allowSampleSeed && config.auth.mode !== 'discord') {
      refuse('データファイルがありません。account モードは既定でサンプルデータを作りません（試用だけは SMM_ALLOW_SAMPLE_SEED=synthetic-trial）。');
    }
    existing = stored.kind === 'ok' ? stored.state : null;
    // The unified app starts its inbox empty: no synthetic users, mailboxes or messages in production.
    if (!existing && config.auth.mode === 'discord') existing = emptyMailState(await createSeedState(now));
  } else {
    // Demo and mock compositions keep the demo behaviour: a missing or unusable local demo file is replaced by fresh synthetic data.
    existing = StateStore.load(config.dataFile);
  }
  const initial = existing ?? (await createSeedState(now));
  /** Existing internal users (the live store once it exists); the identity registry is checked against them. */
  let currentUsers = (): readonly User[] => initial.users;
  if (config.auth.mode === 'trusted-proxy') {
    try {
      assertMappedUsers(config.auth.identities, initial.users);
    } catch (err) {
      // Refuse before the seed is persisted, so an invalid map never initializes or overwrites data.
      refuse(err instanceof ConfigError ? err.message : '利用者対応表を検証できませんでした。');
    }
  }
  // LINE (mock connector only) has its own file, kind and version; the mail file is never touched by it.
  // Same rule as mail: hosted mode seeds only a missing file and refuses an unreadable or invalid one.
  let lineExisting: LineState | null = null;
  const lineSeedOptions = { replyGrants: config.auth.mode === 'demo' };
  if (config.line.mode === 'mock') {
    const stored = LineStore.inspect(config.line.dataFile);
    if (stored.kind === 'invalid' && hosted) {
      refuse('既存の LINE データファイルを読み込めないか、内容が正しくありません。データファイルは変更していません。バックアップからの復元または内容の確認が必要です。');
    }
    lineExisting = stored.kind === 'ok' ? stored.state : null;
  }

  // Discord account login: the account file must exist (created by the migration or init command).
  let discord: DiscordAuthRuntime | null = null;
  if (config.auth.mode === 'discord' && config.discord) {
    const d = config.discord;
    let accountStore: AccountStore;
    try {
      accountStore = AccountStore.open(d.stateFile);
    } catch {
      refuse('アカウントの保存ファイル（stateFile）がないか、形式が正しくありません。ファイルは変更していません。移行または初期化の手順を確認してください。');
    }
    const clients = createBotHostClients(d);
    const studentIds = new StudentIdRoster(d.studentIdsFile, normalizeStudentId);
    // Sign-in log next to the account file (appended; read by access administrators).
    const audit = new LoginAudit(path.join(path.dirname(d.stateFile), 'login-events.jsonl'));
    const service = new DiscordAccountService({ config: d, store: accountStore, member: clients.member, deliver: clients.deliver, rosterStudentId: (uid) => studentIds.studentIdOf(uid), audit });
    discord = { service, store: accountStore, config: d, names: new NameRoster(d.namesFile), audit, publicOrigin: config.auth.publicOrigin, publicHost: config.auth.publicHost, trustedProxies: config.auth.trustedProxies };
  }

  // Task gateway: links and pending case->task operations live in their own file.
  let tasks: TaskRuntime | null = null;
  if (config.tasks.mode !== 'off') {
    let bridge: TaskIdentityBridge;
    if (discord) {
      // The IyakusaiBot task API names people discord-<Discord user ID>; derived from the verified account.
      const service = discord.service;
      bridge = {
        taskUserFor: (principalId) => {
          const identity = service.identityByLoginId(principalId);
          // Temporary staff have no Discord identity and no tasks.
          return identity && !identity.temporaryStaff ? `discord-${identity.discordUserId}` : null;
        },
        taskUsers: () => [],
      };
    } else {
      try {
        bridge = parseTaskBridge(config.tasks.bridgeText ?? SYNTHETIC_TASK_BRIDGE_JSON);
      } catch (err) {
        refuse(err instanceof ConfigError ? err.message : 'タスク本人対応表を検証できませんでした。');
      }
    }
    const stored = TaskLinkStore.inspect(config.tasks.linkFile);
    if (stored.kind === 'invalid' && hosted) refuse('既存のタスク関連付けファイルを読み込めないか、内容が正しくありません。ファイルは変更していません。');
    const links = new TaskLinkStore(stored.kind === 'ok' ? stored.state : emptyLinkState(), config.tasks.linkFile);
    if (stored.kind !== 'ok') links.replace(links.current);
    let client: TaskBackend;
    if (config.tasks.mode === 'in-process') {
      // The unified app: the Task service shares this process. Hosted compositions use existing data only
      // (a missing or unreadable file is never seeded or overwritten); demo and mock compositions seed it.
      const taskStore = new TaskFileStore(config.tasks.dataFile, 'タスクの保存ファイル');
      let service: TaskService;
      try {
        service = await TaskService.open({ store: taskStore, seedIfMissing: !hosted });
      } catch (err) {
        if (err instanceof TaskAppError && err.code === 'LOAD_FAILED' && hosted) {
          refuse('タスクの保存ファイル（SMM_TASK_DATA_FILE）がありません。運用者が用意した初期データを配置してから起動してください。');
        }
        refuse('タスクの保存ファイルを読み込めないか、形式が正しくありません。ファイルは変更していません。');
      }
      const taskUsers = new Set(service.snapshotForValidation().users.map((u) => u.id));
      const unknown = discord ? [] : bridge.taskUsers().filter((u) => !taskUsers.has(u));
      if (unknown.length > 0) refuse(`タスク本人対応表に、タスクの保存ファイルにない利用者が ${unknown.length} 件あります。`);
      client = new InProcessTaskBackend(service);
    } else {
      client = new TaskServiceClient({ baseUrl: config.tasks.serviceUrl, key: config.tasks.key });
    }
    tasks = { client, bridge, links };
  }

  // Account login: the mock composition uses synthetic providers in memory; production uses the
  // operator's identity bridge and the durable, integrity-checked login store. Both use the
  // production password KDF profile (LoginService default); nothing here can select a cheaper one.
  let account: AccountRuntime | null = null;
  if (config.auth.mode === 'account' && config.account) {
    try {
      if (config.account.composition === 'mock') {
        const providers = new MockAccountProviders();
        const service = new LoginService({
          groupId: MOCK_GROUP_ID,
          organizationId: MOCK_ORGANIZATION_ID,
          acceptedLinkEvidence: ['verified_roster'],
          pepper: randomBytes(32),
          serviceLabel: '共有受信とタスク 模擬',
          audience: `http://127.0.0.1:${config.port}`,
          membership: providers.membership,
          links: providers.links,
          principals: providers.principals,
          deliver: providers.deliver,
          audit: memoryAuditSink().sink,
          stateStore: REFERENCE_STORE_ACK,
        });
        account = { service, composition: 'mock', publicOrigin: null, publicHost: null, trustedProxies: new Set(), mock: providers };
      } else {
        const a = config.account;
        let providers: Pick<LoginServiceOptions, 'membership' | 'links' | 'principals' | 'deliver'>;
        if (a.provider === 'bridge') {
          const bridge = new IdentityBridgeClient({ baseUrl: a.bridgeUrl, key: a.bridgeKey });
          providers = { membership: bridge.membership, links: bridge.links, principals: bridge.principals, deliver: bridge.deliver };
        } else {
          // Direct providers (explicit opt-in): Directory read + authoritative registry, in process.
          // The registry must agree with the existing users and the Task identity map; nothing is created.
          const taskBridge = tasks?.bridge;
          if (!taskBridge) refuse('direct 構成にはタスク本人対応表（SMM_TASK_BRIDGE_FILE）が必要です。');
          const fileOps = overrides.localFileOps ?? NODE_LOCAL_FILE_OPS;
          if (fileOps.platform === 'win32') refuse('direct 構成は Windows では起動しません（トークンとレジストリの所有者限定の権限を確認できないため）。POSIX 環境で利用してください。');
          const registry = new FileIdentityRegistry(
            a.registryFile,
            {
              principalExists: (principalId) => currentUsers().some((u) => u.id === principalId),
              taskUserFor: (principalId) => taskBridge.taskUserFor(principalId),
            },
            fileOps,
          );
          try {
            registry.current();
          } catch (err) {
            refuse(err instanceof ConfigError ? err.message : '本人紐付けレジストリを検証できませんでした。');
          }
          const token = fileAccessTokenSource(a.tokenFile, fileOps);
          try {
            // Presence, ownership, permission and format only; no Directory request at startup.
            await token();
          } catch {
            refuse('既存の Directory アクセストークンのファイル（SMM_DIRECTORY_TOKEN_FILE）を安全に読み込めないか、形式が正しくありません。');
          }
          const directory = new GoogleDirectoryReader({
            groupId: a.groupId,
            customerId: a.organizationId!,
            token,
            ...(overrides.directoryFetch ? { fetchImpl: overrides.directoryFetch } : {}),
          });
          const direct = directIdentityProviders(registry, directory);
          const deliver = a.dm.transport === 'identity-bridge' ? new IdentityBridgeClient({ baseUrl: a.dm.bridgeUrl, key: a.dm.bridgeKey }).deliver : unavailableDmDelivery;
          providers = { membership: direct.membership, links: direct.links, principals: direct.principals, deliver };
        }
        const service = new LoginService({
          groupId: a.groupId,
          ...(a.organizationId ? { organizationId: a.organizationId } : {}),
          acceptedLinkEvidence: a.linkEvidence,
          pepper: a.pepper,
          serviceLabel: a.serviceLabel,
          audience: config.auth.publicOrigin ?? undefined,
          membership: providers.membership,
          links: providers.links,
          principals: providers.principals,
          deliver: providers.deliver,
          audit: fileAuditSink(a.auditFile),
          stateStore: new FileLoginPersistence(a.storeFile, a.pepper),
        });
        account = { service, composition: 'production', publicOrigin: config.auth.publicOrigin, publicHost: config.auth.publicHost, trustedProxies: config.auth.trustedProxies, mock: null };
      }
    } catch (err) {
      if (err instanceof StartupRefusal) throw err;
      refuse(err instanceof ConfigError ? err.message : 'ログイン状態を読み込めないか、整合性を確認できません。ファイルは変更していません。');
    }
  }

  const store = new StateStore(initial, config.dataFile);
  if (!existing) store.replace(store.current);
  currentUsers = () => store.current.users;

  let line: LineRuntime | undefined;
  if (config.line.mode === 'mock') {
    const lineStore = new LineStore(lineExisting ?? createLineSeedState(now, lineSeedOptions), config.line.dataFile);
    if (!lineExisting) lineStore.replace(lineStore.current);
    line = { store: lineStore, connector: new MockLinePushConnector(), seed: (at) => createLineSeedState(at, lineSeedOptions) };
  }

  let rental: RentalRuntime | null = null;
  if (config.rental.mode === 'on') {
    let rentalStore: RentalStore;
    try {
      rentalStore = new RentalStore(config.rental.dataDir, { demo: config.rental.demo, driveSync: config.rental.driveSyncKey !== null });
    } catch {
      refuse('物品の保存先（SMM_RENTAL_DATA_DIR）を開けないか、試用データと本番データが同じ保存先にあります。');
    }
    if (config.rental.demo) seedRentalDemo(rentalStore);
    rental = { store: rentalStore, itemOrigin: config.rental.itemOrigin, webDir: config.rental.webDir, driveSyncKey: config.rental.driveSyncKey, allMembersAdmin: config.rental.allMembersAdmin };
  }

  // Committee mailbox (Discord login): its own SQLite file and attachment folder, created on first start.
  let mailbox: MailboxRuntime | null = null;
  if (config.mailbox) {
    if (config.line.mode !== 'off') refuse('委員会の受信箱（SMM_MAIL_DIR）と LINE の模擬受信は同時に使えません。');
    try {
      mailbox = { store: new MailboxStore(config.mailbox.dataDir, config.mailbox.restrictedSenderDomains), config: config.mailbox, addresses: new CommitteeAddresses(config.mailbox.mailboxes, config.mailbox.domainAliases) };
    } catch {
      refuse('受信箱の保存先（SMM_MAIL_DIR）を開けないか、保存ファイルの形式が正しくありません。ファイルは変更していません。');
    }
  }

  // Bot tab: the Bot host's signed assistant API, on the task API's host and key, with the same identity bridge.
  const assistant: AssistantRuntime | null =
    config.assistant.mode === 'on' && tasks
      ? { client: new AssistantServiceClient({ baseUrl: config.assistant.serviceUrl, key: config.assistant.key }), bridge: tasks.bridge }
      : null;

  const app = await buildApp({
    store,
    staticDir: config.staticDir,
    listenPort: config.port,
    auth: config.auth,
    tasks,
    assistant,
    rental,
    mailbox,
    botDatasourceKey: config.botDatasourceKey,
    ...(discord ? { discord } : {}),
    ...(account ? { account } : {}),
    ...(line ? { line } : {}),
  });
  return { app, account, hosted };
}
