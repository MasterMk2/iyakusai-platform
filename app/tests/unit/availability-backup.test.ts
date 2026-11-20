import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AvailabilityStore } from '../../src/server/availability/store.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';

// The app's backup keeps availability.sqlite3 (each member's connected calendar and choices) next to mail.sqlite3.
// The busy periods are never in it. The backup runs as a child process, so the test allows more time.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-availability-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('copies availability.sqlite3 next to mail.sqlite3 and counts its connections and checks', () => {
  const data = path.join(dir, 'data');
  const out = path.join(dir, 'backups');
  new MailboxStore(path.join(data, 'mailbox')).close();
  const store = new AvailabilityStore(path.join(data, 'mailbox'));
  const at = '2026-11-20T01:00:00.000Z';
  store.putChallenge({ userId: 'u1', calendarId: 'one@example.invalid', slotStart: at, slotEnd: at, audience: { everyone: true, departments: [], people: [] }, detail: 'parts', createdAt: at });
  store.connect(store.challenge('u1')!, at);
  store.putChallenge({ userId: 'u2', calendarId: 'two@example.invalid', slotStart: at, slotEnd: at, audience: { everyone: false, departments: ['役員会'], people: [] }, detail: 'blocks', createdAt: at });
  store.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
    env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
    stdio: 'pipe',
  });
  const [folder] = readdirSync(out);
  const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
  expect(Object.keys(manifest.files)).toContain('mailbox/availability.sqlite3');
  expect(manifest.counts).toMatchObject({ 'availability.connections': 1, 'availability.challenges': 1 });
  const copy = new DatabaseSync(path.join(out, folder!, 'mailbox', 'availability.sqlite3'), { readOnly: true });
  try {
    expect((copy.prepare('SELECT calendar_id FROM connections').get() as { calendar_id: string }).calendar_id).toBe('one@example.invalid');
  } finally {
    copy.close();
  }
}, 30_000);
