import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BulletinStore } from '../../src/server/bulletin/store.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { boardHash, bulletinAudienceLabel, bulletinExcerpt, bulletinPeriodLabel, bulletinPeriodProblem, bulletinPhase, bulletinTargets, defaultBulletinEndsOn, parseBoardQuery } from '../../src/shared/bulletin.js';

// The notice board's shared rules (the days, who it is for, the words on screen), its address in the app, and its
// place in the backup. Synthetic text only.

describe('the days of a notice', () => {
  const open = { status: 'open' as const, startsOn: '2026-11-15', endsOn: '2026-11-20' };
  it('is for later before its first day, on the board through its last day, and ended after', () => {
    expect(bulletinPhase(open, '2026-11-14')).toBe('scheduled');
    expect(bulletinPhase(open, '2026-11-15')).toBe('current');
    expect(bulletinPhase(open, '2026-11-20')).toBe('current');
    expect(bulletinPhase(open, '2026-11-21')).toBe('ended');
    expect(bulletinPhase({ status: 'open', startsOn: null, endsOn: null }, '2030-01-01')).toBe('current');
    expect(bulletinPhase({ ...open, status: 'withdrawn' }, '2026-11-16')).toBe('withdrawn');
  });

  it('names what is wrong with the days', () => {
    expect(bulletinPeriodProblem(null, null, '2026-11-11')).toBeNull();
    expect(bulletinPeriodProblem(null, '2026-11-11', '2026-11-11')).toBeNull();
    expect(bulletinPeriodProblem(null, '2026-11-10', '2026-11-11')).toContain('今日より前');
    expect(bulletinPeriodProblem(null, '2026-11-10', null)).toBeNull();
    expect(bulletinPeriodProblem('2026-11-20', '2026-11-19', null)).toContain('掲載開始日と同じか');
    expect(bulletinPeriodProblem('2026-02-30', null, null)).toContain('掲載開始日');
    expect(bulletinPeriodProblem(null, '2026-02-30', null)).toContain('掲載期限');
  });

  it('offers two weeks from today as the last day, across a month end', () => {
    expect(defaultBulletinEndsOn('2026-11-11')).toBe('2026-11-25');
    expect(defaultBulletinEndsOn('2026-12-25')).toBe('2027-01-08');
  });
});

describe('who a notice is for, and the words on screen', () => {
  it('targets everyone when no department is chosen, otherwise a member of any chosen department', () => {
    expect(bulletinTargets([], [])).toBe(true);
    expect(bulletinTargets(['総務部'], ['総務部', '会計課'])).toBe(true);
    expect(bulletinTargets(['内務部', '会計課'], ['総務部', '会計課'])).toBe(true);
    expect(bulletinTargets(['内務部'], ['総務部', '会計課'])).toBe(false);
    expect(bulletinTargets(['内務部'], [])).toBe(false);
  });

  it('writes the audience, the period and the excerpt', () => {
    expect(bulletinAudienceLabel([])).toBe('全員');
    expect(bulletinAudienceLabel(['総務部', '会計課'])).toBe('総務部・会計課');
    expect(bulletinPeriodLabel(null, '2026-11-05')).toBe('11/5 まで');
    expect(bulletinPeriodLabel('2026-11-15', '2026-12-01')).toBe('11/15 から 12/1 まで');
    expect(bulletinPeriodLabel(null, null)).toBe('期限なし');
    expect(bulletinExcerpt('一行目\n\n二行目')).toBe('一行目 二行目');
    expect(bulletinExcerpt('あ'.repeat(200))).toHaveLength(91);
  });
});

describe('the board in the address bar', () => {
  it('reads and writes the list, an opened notice and the form', () => {
    const read = (query: string) => parseBoardQuery(new URLSearchParams(query));
    expect(read('')).toEqual({ postId: null, creating: false });
    expect(read('new=1')).toEqual({ postId: null, creating: true });
    const open = read('p=bb_0123456789abcdef&new=1');
    expect(open).toEqual({ postId: 'bb_0123456789abcdef', creating: false });
    expect(boardHash(open)).toBe('#/board?p=bb_0123456789abcdef');
    expect(boardHash(read('new=1'))).toBe('#/board?new=1');
    // Anything that is not a notice's ID is dropped, never sent to the server.
    expect(boardHash(read('p=../../etc'))).toBe('#/board');
  });
});

describe('the backup', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-bulletin-backup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('copies bulletin.sqlite3 next to mail.sqlite3 and counts its notices, reads and history', () => {
    const data = path.join(dir, 'data');
    const out = path.join(dir, 'backups');
    new MailboxStore(path.join(data, 'mailbox')).close();
    const board = new BulletinStore(path.join(data, 'mailbox'));
    const at = '2026-11-11T01:00:00.000Z';
    const { row } = board.create({ title: '合成のお知らせ', body: '', important: false, departments: [], startsOn: null, endsOn: null }, 'u1', at, null);
    board.markRead([row.id], 'u2', at);
    board.withdraw(row.id, 1, 'u1', at);
    board.close();

    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', path.resolve('src/server/ops/backup.ts')], {
      env: { ...process.env, BACKUP_DATA_DIR: data, BACKUP_OUT_DIR: out },
      stdio: 'pipe',
    });
    const [folder] = readdirSync(out);
    const manifest = JSON.parse(readFileSync(path.join(out, folder!, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>; counts: Record<string, number> };
    expect(Object.keys(manifest.files)).toContain('mailbox/bulletin.sqlite3');
    expect(manifest.counts).toMatchObject({ 'bulletin.posts': 1, 'bulletin.reads': 2, 'bulletin.post_history': 2 });
  }, 30_000);
});
