import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { PaymentsStore } from '../../src/server/payments/store.js';

// The app's backup (dist/server/ops/backup.js, run before every deployment) keeps payments.sqlite3 (入金確認).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-payments-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('copies payments.sqlite3 next to mail.sqlite3, with its invoices, deposits, matches and history counted', () => {
  const data = path.join(dir, 'data');
  const out = path.join(dir, 'backups');
  new MailboxStore(path.join(data, 'mailbox')).close();
  const payments = new PaymentsStore(path.join(data, 'mailbox'));
  const now = '2026-11-04T00:00:00.000Z';
  payments.createInvoice({ orgId: 'og_0000000000000001', number: '', amountYen: 5_000, issuedOn: null, dueOn: null, payerKana: '', memo: '' }, { name: '合成サークル', nameKey: '合成サークル', fiscalYear: 2026 }, 'token-0000000000000001', 'u1', now);
  payments.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
    env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
    stdio: 'pipe',
  });
  const [folder] = readdirSync(out);
  const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
  expect(Object.keys(manifest.files)).toContain('mailbox/payments.sqlite3');
  expect(manifest.counts).toMatchObject({ 'payments.invoices': 1, 'payments.deposits': 0, 'payments.allocations': 0, 'payments.history': 1 });
}, 60_000);
