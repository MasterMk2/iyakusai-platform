import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Real entry point: LINE settings and an unusable LINE data file must refuse
// hosted startup before anything is written, and never touch the mail data file.

mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.tmp', 'line-startup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const map = join(dir, 'map.json');
writeFileSync(map, JSON.stringify({ version: 1, identities: [{ identity: 'a@idp.example', userId: 'u-editor-a' }] }), 'utf8');
const proxy = {
  SMM_AUTH_MODE: 'trusted-proxy',
  SMM_PUBLIC_ORIGIN: 'https://mail.example.invalid',
  SMM_TRUSTED_PROXY_ADDRESSES: '10.0.0.2',
  SMM_HOST: '127.0.0.1',
  SMM_USER_MAP_FILE: map,
};

function start(env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], { env: { ...clean, SMM_PORT: '5198', ...env }, encoding: 'utf8', timeout: 30_000 });
}

describe('LINE startup refusal', () => {
  it('refuses unsafe LINE settings and invalid LINE data in hosted mode without writing either file', { timeout: 120_000 }, () => {
    const mailFile = join(dir, 'mail.json');
    const lineFile = join(dir, 'line.json');
    const cases: [string, Record<string, string>, string | null][] = [
      ['unknown LINE mode', { SMM_LINE_MODE: 'live' }, null],
      ['mock without its own data file', { SMM_LINE_MODE: 'mock' }, null],
      ['LINE file equal to mail file', { SMM_LINE_MODE: 'mock', SMM_LINE_DATA_FILE: mailFile }, null],
      ['mail state in the LINE file', { SMM_LINE_MODE: 'mock', SMM_LINE_DATA_FILE: lineFile }, '{"schemaVersion":1,"users":[],"mailboxes":[],"grants":[],"messages":[],"receipts":[],"audit":[],"mockConnector":{}}'],
      ['future LINE version', { SMM_LINE_MODE: 'mock', SMM_LINE_DATA_FILE: lineFile }, '{"kind":"smm-line-state","schemaVersion":2}'],
      ['malformed LINE file', { SMM_LINE_MODE: 'mock', SMM_LINE_DATA_FILE: lineFile }, '{"kind":"smm-line-state","outbox":[{"body":"運用者の返信'],
    ];
    for (const [label, env, lineContent] of cases) {
      if (lineContent === null) rmSync(lineFile, { force: true });
      else writeFileSync(lineFile, lineContent, 'utf8');
      const result = start({ ...proxy, SMM_DATA_FILE: mailFile, ...env });
      expect(result.status, `${label}: ${result.stderr}`).toBe(1);
      expect(result.stderr, label).toContain('起動を中止しました');
      expect(result.stderr + result.stdout, label).not.toMatch(/line-startup-|運用者の返信|SyntaxError|at .*\.ts/);
      expect(existsSync(mailFile), label).toBe(false);
      if (lineContent !== null) expect(readFileSync(lineFile, 'utf8'), label).toBe(lineContent);
      expect(existsSync(`${lineFile}.tmp`), label).toBe(false);
    }
  });
});
