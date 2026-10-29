import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Runs the real server entry point with invalid configurations: startup must be
// refused before any data file is created or overwritten, with secret-free output.

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'startup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeMap(name: string, identities: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ version: 1, identities }), 'utf8');
  return file;
}

function start(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    env: { ...clean, SMM_PORT: '5197', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Starts the real entry point, waits for its listening line, then stops it. */
async function runUntilListening(env: Record<string, string>): Promise<void> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { env: { ...clean, SMM_PORT: '5197', ...env } });
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 30_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (/待ち受け中|http:\/\/127\.0\.0\.1:5197\//.test(output)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited (${code}): ${output}`));
      });
    });
    expect(await portOpen(5197)).toBe(true);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}

const base = {
  SMM_AUTH_MODE: 'trusted-proxy',
  SMM_PUBLIC_ORIGIN: 'https://mail.example.invalid',
  SMM_TRUSTED_PROXY_ADDRESSES: '10.0.0.2',
};

describe('startup refusal', () => {
  it('refuses invalid configuration without creating or overwriting the data file', { timeout: 120_000 }, () => {
    const fresh = join(dir, 'fresh-state.json');
    const existing = join(dir, 'existing-state.json');
    writeFileSync(existing, '{"schemaVersion":1,"marker":"keep-me"}', 'utf8');
    const cases: [string, Record<string, string>][] = [
      ['ambiguous mode', { SMM_AUTH_MODE: 'proxy' }],
      ['demo with public origin', { SMM_PUBLIC_ORIGIN: 'https://mail.example.invalid' }],
      ['demo on a non-loopback bind', { SMM_HOST: '0.0.0.0' }],
      ['proxy without origin', { ...base, SMM_PUBLIC_ORIGIN: '', SMM_USER_MAP_FILE: writeMap('ok.json', [{ identity: 'a@idp.example', userId: 'u-editor-a' }]) }],
      ['proxy without map', { ...base }],
      ['unknown mapped user', { ...base, SMM_USER_MAP_FILE: writeMap('ghost.json', [{ identity: 'ghost@idp.example', userId: 'u-ghost' }]) }],
    ];
    for (const [label, env] of cases) {
      for (const file of [fresh, existing]) {
        const result = start({ ...env, SMM_DATA_FILE: file });
        expect(result.status, `${label}: ${result.stderr}`).toBe(1);
        expect(result.stderr, label).toContain('起動を中止しました');
        expect(result.stderr + result.stdout, label).not.toMatch(/idp\.example|startup-|at .*\.ts/);
      }
      expect(existsSync(fresh), label).toBe(false);
      expect(readFileSync(existing, 'utf8'), label).toBe('{"schemaVersion":1,"marker":"keep-me"}');
    }
  });

  it('refuses trusted-proxy startup on an existing unreadable or invalid data file without touching it', { timeout: 120_000 }, async () => {
    const env = { ...base, SMM_HOST: '127.0.0.1', SMM_USER_MAP_FILE: writeMap('data-check.json', [{ identity: 'a@idp.example', userId: 'u-editor-a' }]) };
    const cases: [string, string][] = [
      ['malformed JSON', '{"schemaVersion":1,"receipts":[{"note":"運用者のメモ"'],
      ['wrong schema version', '{"schemaVersion":2,"users":[],"mailboxes":[],"grants":[],"messages":[],"receipts":[],"audit":[],"mockConnector":{}}'],
      ['missing collections', '{"schemaVersion":1,"receipts":[],"grants":[]}'],
      ['JSON null', 'null'],
      ['empty file', ''],
    ];
    for (const [i, [label, content]] of cases.entries()) {
      const file = join(dir, `invalid-${i}.json`);
      writeFileSync(file, content, 'utf8');
      const before = readFileSync(file);
      const result = start({ ...env, SMM_DATA_FILE: file });
      expect(result.status, `${label}: ${result.stderr}`).toBe(1);
      expect(result.stderr, label).toContain('データファイルは変更していません');
      expect(result.stdout, label).not.toContain('待ち受け中');
      expect(result.stderr + result.stdout, label).not.toMatch(/idp\.example|startup-|invalid-|運用者のメモ|u-editor|at .*\.ts|SyntaxError|ENOENT|EISDIR/);
      expect(readFileSync(file).equals(before), label).toBe(true);
      expect(existsSync(`${file}.tmp`), label).toBe(false);
      expect(await portOpen(5197), label).toBe(false);
    }

    // A path that exists but cannot be read as a file is refused, not replaced.
    const unreadable = join(dir, 'unreadable-state');
    mkdirSync(unreadable);
    const result = start({ ...env, SMM_DATA_FILE: unreadable });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('データファイルは変更していません');
    expect(result.stderr + result.stdout).not.toMatch(/unreadable|EISDIR|startup-/);
    expect(statSync(unreadable).isDirectory()).toBe(true);
    expect(readdirSync(unreadable)).toEqual([]);
    expect(existsSync(`${unreadable}.tmp`)).toBe(false);
  });

  it('seeds synthetic data only for a missing file, and keeps an existing valid file as is', { timeout: 120_000 }, async () => {
    const env = { ...base, SMM_HOST: '127.0.0.1', SMM_USER_MAP_FILE: writeMap('data-ok.json', [{ identity: 'a@idp.example', userId: 'u-editor-a' }]) };
    const fresh = join(dir, 'first-boot', 'state.json');
    await runUntilListening({ ...env, SMM_DATA_FILE: fresh });
    const seeded = readFileSync(fresh);
    expect(JSON.parse(seeded.toString('utf8')).schemaVersion).toBe(1);

    // Second boot on the now-existing valid file: listens again and leaves the bytes unchanged.
    await runUntilListening({ ...env, SMM_DATA_FILE: fresh });
    expect(readFileSync(fresh).equals(seeded)).toBe(true);
  });

  it('keeps the demo behaviour of replacing an unusable local demo file with synthetic data', { timeout: 60_000 }, async () => {
    const file = join(dir, 'demo-broken.json');
    writeFileSync(file, '{"schemaVersion":1', 'utf8');
    await runUntilListening({ SMM_DATA_FILE: file });
    expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(1);
  });

  it('refuses the demo reset script in trusted-proxy mode', { timeout: 30_000 }, () => {
    const file = join(dir, 'reset-state.json');
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/reset.ts'], {
      env: { ...clean, ...base, SMM_USER_MAP_FILE: writeMap('reset.json', [{ identity: 'a@idp.example', userId: 'u-editor-a' }]), SMM_DATA_FILE: file },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});
