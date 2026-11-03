import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { newIcalToken, tokenHash } from '../../src/server/calendar/ical.js';
import { CalendarStore } from '../../src/server/calendar/store.js';
import type { CalendarEventInput } from '../../src/shared/calendar.js';

// The app's backup (dist/server/ops/backup.js, run before every deployment) keeps the calendar file, with its
// history and the subscriptions' hashes. Synthetic data only.

const NOW = '2026-11-03T01:00:00.000Z';
const LATER = '2026-11-03T02:00:00.000Z';
const input = (over: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  title: '（例）締切',
  kind: 'deadline',
  date: '2026-11-20',
  time: null,
  departments: ['企画部'],
  memo: '',
  yearly: false,
  remindDays: [3],
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-calendar-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('copies calendar.sqlite3 next to mail.sqlite3 with its history and counts it, without any URL', () => {
  const data = path.join(dir, 'data');
  const out = path.join(dir, 'backups');
  const calendar = new CalendarStore(path.join(data, 'mailbox'));
  const created = calendar.create(input(), 'u1', NOW);
  calendar.update(created.id, 1, input({ title: '（例）締切（変更）' }), 'u1', LATER);
  const token = newIcalToken();
  calendar.putSubscription('u1', tokenHash(token), NOW);
  calendar.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
    env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
    stdio: 'pipe',
  });
  const [folder] = readdirSync(out);
  const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
  expect(Object.keys(manifest.files)).toContain('mailbox/calendar.sqlite3');
  expect(manifest.counts).toMatchObject({ 'calendar.events': 1, 'calendar.event_history': 2, 'calendar.ical_subscriptions': 1, 'calendar.event_requests': 0 });

  const copyPath = path.join(out, folder!, 'mailbox', 'calendar.sqlite3');
  const copy = new DatabaseSync(copyPath, { readOnly: true });
  try {
    expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect((copy.prepare('SELECT title FROM events').get() as { title: string }).title).toBe('（例）締切（変更）');
  } finally {
    copy.close();
  }
  // Only the hash of the URL's token is kept, so the copy never holds the token itself.
  expect(readFileSync(copyPath).includes(Buffer.from(token))).toBe(false);
});
