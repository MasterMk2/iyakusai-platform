import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DecisionsStore } from '../../src/server/decisions/store.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';

// The app's backup (dist/server/ops/backup.js) keeps the decision register next to mail.sqlite3, with its history.
// The backup runs as a child process, so the test allows more time than a plain unit test.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-decisions-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('copies decisions.sqlite3 next to mail.sqlite3 and counts its decisions and history', () => {
  const data = path.join(dir, 'data');
  const out = path.join(dir, 'backups');
  new MailboxStore(path.join(data, 'mailbox')).close();
  const decisions = new DecisionsStore(path.join(data, 'mailbox'));
  decisions.create(
    { title: '合成の決定', body: '', departments: ['planning'], decidedOn: '2026-10-01', venue: 'board', venueOther: '', sources: [], taskIds: [] },
    'u1',
    '2026-11-01T00:00:00.000Z',
    null,
  );
  decisions.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
    env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
    stdio: 'pipe',
  });
  const [folder] = readdirSync(out);
  const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
  expect(Object.keys(manifest.files)).toContain('mailbox/decisions.sqlite3');
  expect(manifest.counts).toMatchObject({ 'decisions.decisions': 1, 'decisions.decision_history': 1 });
  const copy = new DatabaseSync(path.join(out, folder!, 'mailbox', 'decisions.sqlite3'), { readOnly: true });
  try {
    expect((copy.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }).n).toBe(1);
  } finally {
    copy.close();
  }
}, 30_000);
