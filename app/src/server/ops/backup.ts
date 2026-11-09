import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

// Backup of the unified app's data, safe while the app runs (run inside the container):
//   docker exec iyakusai-app node dist/server/ops/backup.js
// Writes /backups/iyakusai-app-<UTC time>/ with the JSON state files (each written atomically by the
// app, so a plain read is consistent), the rental ledger, the committee mailbox and contacts through SQLite's online
// backup, the photos and mail attachments those databases reference (checked against their recorded SHA-256),
// and manifest.json. Never deletes anything.
// Restore: stop the container and copy the folder's contents back over /data (../docs/deployment.md §5).

const data = process.env.BACKUP_DATA_DIR ?? '/data';
const out = process.env.BACKUP_OUT_DIR ?? '/backups';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = path.join(out, `iyakusai-app-${stamp}`);
  if (existsSync(target)) throw new Error('同じ時刻のバックアップが既にあります。');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const manifest: { createdAt: string; files: Record<string, { bytes: number; sha256: string }>; counts: Record<string, number> } = {
    createdAt: new Date().toISOString(),
    files: {},
    counts: {},
  };
  const keep = (relative: string, buf: Buffer) => {
    const dest = path.join(target, relative);
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, buf, { mode: 0o600, flag: 'wx' });
    manifest.files[relative] = { bytes: buf.length, sha256: sha256(buf) };
  };

  // mailbox/line-state.json: the committee's official LINE account (2026-10-28). mailbox/signatures.json: the signature's settings (2026-11-10).
  for (const relative of ['accounts/accounts.json', 'mail/state.json', 'mail/task-links.json', 'mail/state.line.json', 'mailbox/line-state.json', 'mailbox/signatures.json']) {
    const file = path.join(data, relative);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    JSON.parse(buf.toString('utf8')); // refuse to keep a damaged state file silently
    keep(relative, buf);
  }

  const ledger = path.join(data, 'rental', 'rental.sqlite3');
  if (existsSync(ledger)) {
    const dest = path.join(target, 'rental', 'rental.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(ledger, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('台帳の複製の整合性を確認できませんでした。');
      // A ledger copied from the Python server has no grants table until the app first opens it.
      const tables = new Set((copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
      for (const table of ['items', 'borrowers', 'operations', 'files', 'issuance', 'grants'].filter((t) => tables.has(t))) {
        manifest.counts[`rental.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
      // Photos and operation records the ledger refers to, verified before they are kept.
      for (const row of copy.prepare('SELECT path, sha256 FROM files').all() as { path: string; sha256: string }[]) {
        const relative = row.path.replaceAll('\\', '/');
        const buf = readFileSync(path.join(data, 'rental', relative));
        if (sha256(buf) !== row.sha256) throw new Error(`写真・記録ファイルの内容が台帳と一致しません: ${relative}`);
        keep(path.posix.join('rental', relative), buf);
      }
    } finally {
      copy.close();
    }
    manifest.files['rental/rental.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Committee mailbox (SMM_MAIL_DIR=/data/mailbox): mail.sqlite3 and the attachment files it names.
  const mailDb = path.join(data, 'mailbox', 'mail.sqlite3');
  if (existsSync(mailDb)) {
    const dest = path.join(target, 'mailbox', 'mail.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(mailDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('受信箱の複製の整合性を確認できませんでした。');
      for (const table of ['messages', 'message_mailboxes', 'attachments', 'notes', 'history', 'grants']) {
        manifest.counts[`mailbox.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
      for (const row of copy.prepare('SELECT DISTINCT sha256 FROM attachments ORDER BY sha256').all() as { sha256: string }[]) {
        const relative = path.posix.join('attachments', row.sha256.slice(0, 2), row.sha256);
        const buf = readFileSync(path.join(data, 'mailbox', relative));
        if (sha256(buf) !== row.sha256) throw new Error(`添付ファイルの内容が受信箱の記録と一致しません: ${relative}`);
        keep(path.posix.join('mailbox', relative), buf);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/mail.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Committee contacts (2026-10-26): contacts.sqlite3 next to mail.sqlite3, with its change history.
  const contactsDb = path.join(data, 'mailbox', 'contacts.sqlite3');
  if (existsSync(contactsDb)) {
    const dest = path.join(target, 'mailbox', 'contacts.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(contactsDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('連絡先の複製の整合性を確認できませんでした。');
      for (const table of ['contacts', 'contact_history']) {
        manifest.counts[`contacts.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/contacts.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Decision register (2026-11-03): decisions.sqlite3 next to mail.sqlite3, with its change history.
  const decisionsDb = path.join(data, 'mailbox', 'decisions.sqlite3');
  if (existsSync(decisionsDb)) {
    const dest = path.join(target, 'mailbox', 'decisions.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(decisionsDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('決定事項の複製の整合性を確認できませんでした。');
      for (const table of ['decisions', 'decision_history']) {
        manifest.counts[`decisions.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/decisions.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Organizations (団体の台帳, 2026-11-03): organizations.sqlite3 next to contacts.sqlite3, with its history and mail batches.
  const organizationsDb = path.join(data, 'mailbox', 'organizations.sqlite3');
  if (existsSync(organizationsDb)) {
    const dest = path.join(target, 'mailbox', 'organizations.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(organizationsDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('団体の複製の整合性を確認できませんでした。');
      for (const table of ['organizations', 'organization_history', 'mail_batches']) {
        manifest.counts[`organizations.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/organizations.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Payments (入金確認, 2026-11-03): payments.sqlite3 next to organizations.sqlite3, with its invoices, deposits and history.
  const paymentsDb = path.join(data, 'mailbox', 'payments.sqlite3');
  if (existsSync(paymentsDb)) {
    const dest = path.join(target, 'mailbox', 'payments.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(paymentsDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('会計の複製の整合性を確認できませんでした。');
      for (const table of ['invoices', 'deposits', 'allocations', 'history']) {
        manifest.counts[`payments.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/payments.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Books (会計の帳簿, 2026-11-05): books.sqlite3 next to payments.sqlite3, and the receipts (books-receipts/) it names,
  // each checked against its recorded SHA-256. The receipts a person took off are kept too (the history names them).
  const booksDb = path.join(data, 'mailbox', 'books.sqlite3');
  if (existsSync(booksDb)) {
    const dest = path.join(target, 'mailbox', 'books.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(booksDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('会計の帳簿の複製の整合性を確認できませんでした。');
      for (const table of ['accounts', 'journals', 'lines', 'claims', 'receipts', 'history']) {
        manifest.counts[`books.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
      for (const row of copy.prepare('SELECT id, sha256 FROM receipts ORDER BY id').all() as { id: string; sha256: string }[]) {
        const relative = path.posix.join('books-receipts', row.id);
        const buf = readFileSync(path.join(data, 'mailbox', relative));
        if (sha256(buf) !== row.sha256) throw new Error(`領収書の内容が帳簿の記録と一致しません: ${relative}`);
        keep(path.posix.join('mailbox', relative), buf);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/books.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Meeting minutes (α 2026-11-02): minutes.sqlite3 next to mail.sqlite3. The recordings (minutes-audio/) are
  // not backed up: they are deleted a fixed number of days after confirmation.
  const minutesDb = path.join(data, 'mailbox', 'minutes.sqlite3');
  if (existsSync(minutesDb)) {
    const dest = path.join(target, 'mailbox', 'minutes.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(minutesDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('議事録の複製の整合性を確認できませんでした。');
      for (const table of ['meetings', 'meeting_history']) {
        manifest.counts[`minutes.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/minutes.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Committee calendar (2026-11-03): calendar.sqlite3 next to mail.sqlite3, with its history and the iCal URLs' hashes
  // (the URLs themselves are never stored). Without this, a restore from this backup would lose every event.
  const calendarDb = path.join(data, 'mailbox', 'calendar.sqlite3');
  if (existsSync(calendarDb)) {
    const dest = path.join(target, 'mailbox', 'calendar.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(calendarDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('カレンダーの複製の整合性を確認できませんでした。');
      for (const table of ['events', 'event_history', 'ical_subscriptions', 'event_requests']) {
        manifest.counts[`calendar.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/calendar.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Festival-day board (2026-11-03): dayof.sqlite3 next to mail.sqlite3 (the period, the rules, the posters, the
  // notices and their history). The decisions recorded on the day are in decisions.sqlite3 above.
  const dayofDb = path.join(data, 'mailbox', 'dayof.sqlite3');
  if (existsSync(dayofDb)) {
    const dest = path.join(target, 'mailbox', 'dayof.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(dayofDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('当日の連絡板の複製の整合性を確認できませんでした。');
      for (const table of ['posts', 'post_history', 'poster_grants', 'admin_history']) {
        manifest.counts[`dayof.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/dayof.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  // Year rollover (2026-11-04): rollover.sqlite3 next to mail.sqlite3, the record of each run (who, when, what) and
  // what each copy made, which an undo needs.
  const rolloverDb = path.join(data, 'mailbox', 'rollover.sqlite3');
  if (existsSync(rolloverDb)) {
    const dest = path.join(target, 'mailbox', 'rollover.sqlite3');
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(rolloverDb, { readOnly: true });
    try {
      await backup(source, dest);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(dest, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error('年度の切り替えの記録の複製の整合性を確認できませんでした。');
      for (const table of ['runs', 'run_items']) {
        manifest.counts[`rollover.${table}`] = Number((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      }
    } finally {
      copy.close();
    }
    manifest.files['mailbox/rollover.sqlite3'] = { bytes: readFileSync(dest).length, sha256: sha256(readFileSync(dest)) };
  }

  writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`バックアップを作りました: ${path.basename(target)}（ファイル ${Object.keys(manifest.files).length} 件）`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'バックアップを作れませんでした。');
  process.exitCode = 1;
});

