import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ContactsStore } from '../../src/server/contacts/store.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { validateContact } from '../../src/shared/contacts.js';

// The app's backup (dist/server/ops/backup.js, run before every deployment) keeps the contacts file.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-contacts-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('copies contacts.sqlite3 next to mail.sqlite3 and counts its rows', () => {
  const data = path.join(dir, 'data');
  const out = path.join(dir, 'backups');
  new MailboxStore(path.join(data, 'mailbox')).close();
  const contacts = new ContactsStore(path.join(data, 'mailbox'));
  contacts.create(validateContact({ category: 'external', organization: '合成商事', name: '' }), 'u1', '2026-10-26T00:00:00.000Z');
  contacts.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
    env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
    stdio: 'pipe',
  });
  const [folder] = readdirSync(out);
  const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
  expect(Object.keys(manifest.files)).toContain('mailbox/contacts.sqlite3');
  expect(manifest.counts).toMatchObject({ 'contacts.contacts': 1, 'contacts.contact_history': 1 });
  const copy = new DatabaseSync(path.join(out, folder!, 'mailbox', 'contacts.sqlite3'), { readOnly: true });
  try {
    expect((copy.prepare('SELECT count(*) AS n FROM contacts').get() as { n: number }).n).toBe(1);
  } finally {
    copy.close();
  }
});
