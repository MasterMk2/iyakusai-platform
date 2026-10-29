import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/server/auth.js';
import { loadConfig } from '../../src/server/config.js';
import { AccountStore } from '../../src/server/discord-auth/store.js';
import { composeServer } from '../../src/server/runtime.js';
import { signedHeaders } from '../../src/server/tasks/signing.js';

// SMM_BOT_DATASOURCE_KEY_FILE: off when unset, discord login only, and never the same value as another key
// the app holds. Plus the real composition (composeServer) answering the route, so a key that loads is a
// route that exists. Synthetic values only.

const dir = mkdtempSync(join(tmpdir(), 'iyakusai-bot-datasource-config-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // an SQLite file may still be open on Windows
  }
});

let n = 0;
/** A key file (hex, owner-only); `value` makes two files hold the same key. */
function keyFile(value: Buffer = randomBytes(32)): { file: string; value: Buffer } {
  n += 1;
  const file = join(dir, `key-${n}.key`);
  writeFileSync(file, value.toString('hex'), { mode: 0o600 });
  return { file, value };
}

interface Keys {
  pepper?: Buffer;
  bridge?: Buffer;
  task?: Buffer;
  ingest?: Buffer;
  /** Given: the rental is on, with its copy to Drive keyed by this value. */
  drive?: Buffer;
}

/** A complete discord-mode environment (login config, task service, mailbox), with the given key values. */
function discordEnv(keys: Keys = {}, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  n += 1;
  const root = join(dir, `env-${n}`);
  mkdirSync(root, { recursive: true });
  const login = join(root, 'discord-auth.json');
  writeFileSync(
    login,
    JSON.stringify({
      guildId: '1000000000000000001',
      bootstrapDiscordUserId: '1000000000000001001',
      registrationAudience: 'https://task.example.invalid',
      memberUrl: 'https://bot-host.example.invalid/v1/discord/member',
      registrationDmUrl: 'https://bot-host.example.invalid/v1/dm/registration-code',
      stateFile: join(root, 'accounts.json'),
      pepperFile: keyFile(keys.pepper).file,
      bridgeKeyFile: keyFile(keys.bridge).file,
    }),
  );
  const mailConfig = join(root, 'mailbox.json');
  writeFileSync(mailConfig, JSON.stringify({ version: 1, mailboxes: [{ id: 'taro', name: '委員会共用', address: 'taro@committee.example', catchAll: true }], ingestKeyFile: keyFile(keys.ingest).file }));
  return {
    SMM_AUTH_MODE: 'discord',
    SMM_HOST: '127.0.0.1',
    SMM_PUBLIC_ORIGIN: 'https://app.example.invalid',
    SMM_TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
    SMM_DISCORD_AUTH_CONFIG: login,
    SMM_DATA_FILE: join(root, 'state.json'),
    SMM_TASK_SERVICE_URL: 'https://tasks.example.invalid',
    SMM_TASK_GATEWAY_KEY_FILE: keyFile(keys.task).file,
    SMM_MAIL_DIR: join(root, 'mailbox'),
    SMM_MAIL_CONFIG: mailConfig,
    ...(keys.drive
      ? { SMM_RENTAL_DATA_DIR: join(root, 'rental'), SMM_RENTAL_ITEM_ORIGIN: 'https://app.example.invalid', SMM_RENTAL_DRIVE_SYNC_KEY_FILE: keyFile(keys.drive).file }
      : {}),
    ...extra,
  };
}

describe('SMM_BOT_DATASOURCE_KEY_FILE', () => {
  it('is off when unset and loads a key of its own', () => {
    expect(loadConfig(discordEnv()).botDatasourceKey).toBeNull();
    const own = keyFile();
    const config = loadConfig(discordEnv({}, { SMM_BOT_DATASOURCE_KEY_FILE: own.file }));
    expect(config.botDatasourceKey?.equals(own.value)).toBe(true);
  });

  it.each([
    ['the pepper', 'pepper'],
    ['the identity bridge key (registration codes)', 'bridge'],
    ['the task gateway key', 'task'],
    ['the mail collector key', 'ingest'],
    ['the rental Drive copy key', 'drive'],
  ] as const)('refuses to start when it is the same value as %s', (_label, which) => {
    const shared = randomBytes(32);
    const copy = keyFile(shared);
    let message = '';
    try {
      loadConfig(discordEnv({ [which]: shared }, { SMM_BOT_DATASOURCE_KEY_FILE: copy.file }));
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('SMM_BOT_DATASOURCE_KEY_FILE');
    // No path and no key material in the message.
    expect(message).not.toContain(copy.file);
    expect(message).not.toContain(shared.toString('hex'));
  });

  it('accepts a value that differs from the others by one bit', () => {
    const base = randomBytes(32);
    const near = Buffer.from(base);
    near[0] = near[0]! ^ 1;
    const own = keyFile(near);
    const config = loadConfig(discordEnv({ pepper: base, task: base, ingest: base }, { SMM_BOT_DATASOURCE_KEY_FILE: own.file }));
    expect(config.botDatasourceKey?.equals(near)).toBe(true);
  });

  it('refuses a missing, empty or too short key file', () => {
    const short = join(dir, 'short.key');
    writeFileSync(short, 'abcd', { mode: 0o600 });
    for (const value of [join(dir, 'does-not-exist.key'), '', short]) {
      expect(() => loadConfig(discordEnv({}, { SMM_BOT_DATASOURCE_KEY_FILE: value }))).toThrow(ConfigError);
    }
  });

  it('is accepted only with the Discord login', () => {
    const own = keyFile();
    for (const env of [{ SMM_BOT_DATASOURCE_KEY_FILE: own.file }, { SMM_AUTH_MODE: 'account-mock', SMM_BOT_DATASOURCE_KEY_FILE: own.file }]) {
      expect(() => loadConfig(env)).toThrow(/SMM_AUTH_MODE=discord/);
    }
    expect(loadConfig({}).botDatasourceKey).toBeNull();
  });
});

describe('the real composition', () => {
  it('answers the signed route when the key is set, and has no route when it is not', async () => {
    const own = keyFile();
    const env = discordEnv({}, { SMM_BOT_DATASOURCE_KEY_FILE: own.file, SMM_RENTAL_ITEM_ORIGIN: 'https://app.example.invalid' });
    env.SMM_RENTAL_DATA_DIR = join(dir, 'rental');
    // The login's account file must exist before the first start (created by the init command).
    AccountStore.open((JSON.parse(readFileSync(env.SMM_DISCORD_AUTH_CONFIG!, 'utf8')) as { stateFile: string }).stateFile, { createIfMissing: true });
    const call = async (runtime: Awaited<ReturnType<typeof composeServer>>, key: Buffer) => {
      const body = '{"sources":["rental","mailbox"]}';
      const res = await runtime.app.inject({
        method: 'POST',
        url: '/v1/bot/datasource',
        // Through the trusted proxy (127.0.0.1) with the canonical host and no Origin, as the Bot host arrives.
        headers: { host: 'app.example.invalid', 'content-type': 'application/json', ...signedHeaders(key, { client: 'iyakusai-bot-datasource', method: 'POST', path: '/v1/bot/datasource', body, actor: '' }) },
        payload: body,
      });
      return { status: res.statusCode, json: res.json() };
    };
    const on = await composeServer(loadConfig(env));
    try {
      const ok = await call(on, own.value);
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ version: 1, rental: { summary: { total: 0 }, items: [] }, mailbox: { mailboxes: [{ id: 'taro', threads: 0, unhandled: 0 }], messages: [] } });
      expect((await call(on, randomBytes(32))).status).toBe(401);
    } finally {
      await on.app.close();
    }
    const off = await composeServer(loadConfig({ ...env, SMM_BOT_DATASOURCE_KEY_FILE: undefined }));
    try {
      expect((await call(off, own.value)).status).toBe(404);
    } finally {
      await off.app.close();
    }
  }, 30_000);
});
