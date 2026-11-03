import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { AccountStore } from '../../src/server/discord-auth/store.js';
import { composeServer } from '../../src/server/runtime.js';
import { signedHeaders } from '../../src/server/tasks/signing.js';

// The ledgers added on 2026-11-03 at start-up (the real composition, Discord login): a decisions.sqlite3 that cannot
// be opened turns the decision register off only, and a Discord login without the mail folder keeps no calendar beside
// the state file (where the backup would not reach it). Synthetic values only.

const dir = mkdtempSync(join(tmpdir(), 'iyakusai-ledger-startup-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // an SQLite file may still be open on Windows
  }
});

let n = 0;
function keyFile(): { file: string; value: Buffer } {
  n += 1;
  const file = join(dir, `key-${n}.key`);
  const value = randomBytes(32);
  writeFileSync(file, value.toString('hex'), { mode: 0o600 });
  return { file, value };
}

/** A Discord login environment with the task service and the Bot's signed data route; the mail folder when `mail`. */
function discordEnv(mail: boolean): { env: NodeJS.ProcessEnv; root: string; datasourceKey: Buffer } {
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
      pepperFile: keyFile().file,
      bridgeKeyFile: keyFile().file,
    }),
  );
  AccountStore.open(join(root, 'accounts.json'), { createIfMissing: true });
  const datasource = keyFile();
  const env: NodeJS.ProcessEnv = {
    SMM_AUTH_MODE: 'discord',
    SMM_HOST: '127.0.0.1',
    SMM_PUBLIC_ORIGIN: 'https://app.example.invalid',
    SMM_TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
    SMM_DISCORD_AUTH_CONFIG: login,
    SMM_DATA_FILE: join(root, 'state', 'state.json'),
    SMM_TASK_SERVICE_URL: 'https://tasks.example.invalid',
    SMM_TASK_GATEWAY_KEY_FILE: keyFile().file,
    SMM_BOT_DATASOURCE_KEY_FILE: datasource.file,
  };
  if (mail) {
    const mailConfig = join(root, 'mailbox.json');
    writeFileSync(mailConfig, JSON.stringify({ version: 1, mailboxes: [{ id: 'taro', name: '委員会共用', address: 'taro@committee.example', catchAll: true }], ingestKeyFile: keyFile().file }));
    env.SMM_MAIL_DIR = join(root, 'mailbox');
    env.SMM_MAIL_CONFIG = mailConfig;
  }
  return { env, root, datasourceKey: datasource.value };
}

async function askBot(runtime: Awaited<ReturnType<typeof composeServer>>, key: Buffer, sources: string[]) {
  const body = JSON.stringify({ sources });
  const res = await runtime.app.inject({
    method: 'POST',
    url: '/v1/bot/datasource',
    headers: { host: 'app.example.invalid', 'content-type': 'application/json', ...signedHeaders(key, { client: 'iyakusai-bot-datasource', method: 'POST', path: '/v1/bot/datasource', body, actor: '' }) },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() };
}

describe('ledgers at start-up', () => {
  it('starts with the decision register off when decisions.sqlite3 cannot be opened, and leaves the file as it was', async () => {
    const { env, datasourceKey } = discordEnv(true);
    mkdirSync(env.SMM_MAIL_DIR!, { recursive: true });
    const broken = join(env.SMM_MAIL_DIR!, 'decisions.sqlite3');
    const garbage = Buffer.from('this is not an SQLite database, only synthetic bytes for the test\n'.repeat(64));
    writeFileSync(broken, garbage);
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let runtime: Awaited<ReturnType<typeof composeServer>> | null = null;
    try {
      runtime = await composeServer(loadConfig(env));
      expect(said.mock.calls.some((c) => String(c[0]).includes('決定事項だけを止めました'))).toBe(true);
      // The rest answers: the mailbox through the Bot's route, the decisions as off.
      const answer = await askBot(runtime, datasourceKey, ['mailbox', 'decisions']);
      expect(answer.status).toBe(200);
      expect(answer.json).toMatchObject({ mailbox: { mailboxes: [{ id: 'taro' }] }, decisions: null });
    } finally {
      said.mockRestore();
      await runtime?.app.close();
    }
    expect(readFileSync(broken).equals(garbage)).toBe(true);
  }, 30_000);

  it('keeps no calendar file beside the state file when the Discord login starts without the mail folder', async () => {
    const { env, datasourceKey } = discordEnv(false);
    const runtime = await composeServer(loadConfig(env));
    try {
      const stateDir = join(env.SMM_DATA_FILE!, '..');
      expect(existsSync(join(stateDir, 'calendar.sqlite3'))).toBe(false);
      expect(existsSync(join(stateDir, 'decisions.sqlite3'))).toBe(false);
      expect((await askBot(runtime, datasourceKey, ['decisions'])).json).toMatchObject({ decisions: null });
    } finally {
      await runtime.app.close();
    }
  }, 30_000);
});
