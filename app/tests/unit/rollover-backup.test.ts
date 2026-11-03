import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { RolloverStore } from '../../src/server/rollover/store.js';

// The app's backup keeps the year rollover's record (rollover.sqlite3) next to mail.sqlite3: an undo needs what each
// run made. The backup runs as a child process, so the test allows more time than a plain unit test.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-rollover-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('copies rollover.sqlite3 next to mail.sqlite3 and counts its runs and items', () => {
  const data = path.join(dir, 'data');
  const out = path.join(dir, 'backups');
  new MailboxStore(path.join(data, 'mailbox')).close();
  const rollover = new RolloverStore(path.join(data, 'mailbox'));
  const begun = rollover.begin({ step: 'organizations', sourceYear: 2026, targetYear: 2027, planToken: 'synthetic-plan-token', actorId: 'u1', now: '2026-11-04T00:00:00.000Z' });
  if (begun.kind !== 'started') throw new Error('not started');
  rollover.addItem(begun.run.id, { kind: 'organization', sourceId: 'og_0123456789abcdef', madeId: 'og_fedcba9876543210', name: '合成薬局', data: {} });
  rollover.finish(begun.run.id, '団体 1 件を 2027年度に写した', { made: 1 }, '2026-11-04T00:00:01.000Z');
  rollover.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
    env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
    stdio: 'pipe',
  });
  const [folder] = readdirSync(out);
  const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
  expect(Object.keys(manifest.files)).toContain('mailbox/rollover.sqlite3');
  expect(manifest.counts).toMatchObject({ 'rollover.runs': 1, 'rollover.run_items': 1 });
  const copy = new RolloverStore(path.join(out, folder!, 'mailbox'));
  try {
    expect(copy.list()[0]).toMatchObject({ step: 'organizations', status: 'done', summary: '団体 1 件を 2027年度に写した' });
    expect(copy.items(begun.run.id)).toHaveLength(1);
  } finally {
    copy.close();
  }
}, 30_000);
