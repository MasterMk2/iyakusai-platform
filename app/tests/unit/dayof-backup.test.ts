import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DayOfStore } from '../../src/server/dayof/store.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';

// The app's backup (src/server/ops/backup.ts) keeps the festival-day board next to mail.sqlite3, with its history.
// The backup runs as a child process, so the test allows more time than a plain unit test.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-dayof-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('copies dayof.sqlite3 next to mail.sqlite3 and counts its notices, history and posters', () => {
  const data = path.join(dir, 'data');
  const out = path.join(dir, 'backups');
  new MailboxStore(path.join(data, 'mailbox')).close();
  const board = new DayOfStore(path.join(data, 'mailbox'));
  const at = '2026-11-07T01:00:00.000Z';
  board.saveSettings({ startDate: '2026-11-07', endDate: '2026-11-08', rules: '合成の決め方' }, 1, 'u1', at);
  board.setPosterGrant('department', '企画部', true, 'u1', at);
  const { row } = board.create({ body: '合成の連絡', priority: 'urgent', place: '', departments: [], staffVisible: false }, 'u1', at, null);
  board.changeStatus(row.id, 'resolve', 1, 'u1', at);
  board.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
    env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
    stdio: 'pipe',
  });
  const [folder] = readdirSync(out);
  const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
  expect(Object.keys(manifest.files)).toContain('mailbox/dayof.sqlite3');
  expect(manifest.counts).toMatchObject({ 'dayof.posts': 1, 'dayof.post_history': 2, 'dayof.poster_grants': 1, 'dayof.admin_history': 2 });
  const copy = new DatabaseSync(path.join(out, folder!, 'mailbox', 'dayof.sqlite3'), { readOnly: true });
  try {
    expect((copy.prepare('SELECT start_date AS s FROM settings WHERE id=1').get() as { s: string }).s).toBe('2026-11-07');
  } finally {
    copy.close();
  }
}, 30_000);
