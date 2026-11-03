import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrganizationsStore } from '../../src/server/organizations/store.js';
import { seedOrganizations, SYNTHETIC_ORGANIZATIONS } from '../../src/server/organizations/seed.js';
import type { OrgInput } from '../../src/shared/organizations.js';

// The organizations store on its own: versions, history and revert, and the state of a mail batch (who may send it,
// one sending at a time, a message cut off mid-send is never sent again). Synthetic names only.

let dir: string;
let store: OrganizationsStore;
const NOW = '2026-11-03T01:00:00.000Z';
const LATER = '2026-11-03T02:00:00.000Z';
const org = (changes: Partial<OrgInput> = {}): OrgInput => ({
  kind: 'sponsor',
  fiscalYear: 2026,
  name: '合成商事',
  department: '渉外課',
  ownerId: null,
  contactId: null,
  status: '依頼前',
  amountYen: 100_000,
  content: '',
  nextAction: '',
  nextDue: null,
  notes: '',
  ...changes,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-orgs-store-'));
  store = new OrganizationsStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the organizations store', () => {
  it('keeps a version, the state before each change, and puts an earlier state back as one more change', () => {
    const created = store.create(org(), 'u1', NOW);
    expect(created.version).toBe(1);
    const updated = store.update(created.id, 1, org({ status: '依頼済み' }), 'u2', LATER);
    expect(updated).toMatchObject({ version: 2, updated_by: 'u2' });
    expect(store.update(created.id, 1, org({ name: '古い版からの変更' }), 'u3', LATER)).toBe('conflict');

    const [change, creation] = store.history(created.id);
    expect(change).toMatchObject({ action: 'updated', changed: ['status'], before: { status: '依頼前' } });
    expect(creation).toMatchObject({ action: 'created', before: null });

    const reverted = store.update(created.id, 2, change!.before!, 'u1', LATER, 'reverted');
    expect(reverted).toMatchObject({ version: 3, data: { status: '依頼前' } });
    expect(store.history(created.id)[0]).toMatchObject({ action: 'reverted' });
  });

  it('pages, counts by status and searches only the organization\'s own words', () => {
    store.create(org({ name: '合成商事', status: '依頼前' }), 'u1', NOW);
    store.create(org({ name: '合成食品', status: '入金済み', content: '広告（大）' }), 'u1', NOW);
    store.create(org({ name: '別の団体', fiscalYear: 2025 }), 'u1', NOW);
    expect(store.page({ terms: [], fiscalYear: 2026 }, 10, 0).total).toBe(2);
    expect(store.statusCounts({ terms: [], fiscalYear: 2026 })).toEqual({ 依頼前: 1, 入金済み: 1 });
    expect(store.page({ terms: ['広告'], fiscalYear: 2026 }, 10, 0).rows.map((r) => r.data.name)).toEqual(['合成食品']);
    expect(store.page({ terms: [], fiscalYear: 2026, status: '入金済み' }, 10, 0).total).toBe(1);
  });

  it('lets only the member who made a batch take it for sending, one at a time; a cut-off message is never sent again', () => {
    const made = store.createBatch(
      { id: 'mb_0000000000000001', client_token: 'token-0000000000000001', created_by: 'u1', created_at: NOW, mailbox_id: 'sponsorship', mailbox_address: 'sponsorship@committee.example', template_name: null, subject: '件名' },
      [
        { org_id: 'og_0000000000000001', org_name: '合成商事', to_address: 'a@partner.example', to_name: '', subject: '件名A', body: '本文', skip_reason: null },
        { org_id: 'og_0000000000000002', org_name: '合成食品', to_address: '', to_name: '', subject: '件名B', body: '本文', skip_reason: '宛先がありません' },
        { org_id: 'og_0000000000000003', org_name: '別の団体', to_address: 'b@partner.example', to_name: '', subject: '件名C', body: '本文', skip_reason: null },
      ],
    );
    expect(made.status).toBe('draft');
    expect(store.batchItems(made.id).map((i) => i.status)).toEqual(['pending', 'skipped', 'pending']);
    // Tokens are unique per message (the sending service keeps them).
    expect(new Set(store.batchItems(made.id).map((i) => i.send_token)).size).toBe(3);

    expect(store.claimBatch(made.id, 'u2', LATER, '2026-11-03T00:50:00.000Z')).toBe(false);
    expect(store.claimBatch(made.id, 'u1', LATER, '2026-11-03T00:50:00.000Z')).toBe(true);
    // While it is held, nobody else can take it, not even the creator again.
    expect(store.claimBatch(made.id, 'u1', LATER, '2026-11-03T00:50:00.000Z')).toBe(false);
    store.setItem(made.id, 0, { status: 'sent', receiptId: 'rc_0000000000000001', sentAt: LATER });
    store.setItem(made.id, 2, { status: 'sending' });
    // The batch was cut off: the message left "sending" is unknown after ten minutes, and never listed for sending.
    store.finishBatch(made.id, null, LATER);
    expect(store.batch(made.id)).toMatchObject({ status: 'partial' });
    expect(store.nextItems(made.id, 5, true)).toEqual([]);

    // After ten minutes a new request takes the batch: the cut-off message becomes unknown, not pending.
    expect(store.claimBatch(made.id, 'u1', '2026-11-03T03:00:00.000Z', '2026-11-03T02:50:00.000Z')).toBe(true);
    expect(store.batchItems(made.id)[2]).toMatchObject({ status: 'unknown' });
    store.finishBatch(made.id, '確かめてください', '2026-11-03T03:00:00.000Z');
    expect(store.batch(made.id)).toMatchObject({ status: 'done', notice: '確かめてください' });
  });

  it('lists a failed message again only when asked (再送), and never an unknown one', () => {
    const made = store.createBatch(
      { id: 'mb_0000000000000002', client_token: 'token-0000000000000002', created_by: 'u1', created_at: NOW, mailbox_id: 'sponsorship', mailbox_address: 'sponsorship@committee.example', template_name: null, subject: '件名' },
      [
        { org_id: 'og_0000000000000001', org_name: '合成商事', to_address: 'a@partner.example', to_name: '', subject: 'A', body: 'B', skip_reason: null },
        { org_id: 'og_0000000000000003', org_name: '別の団体', to_address: 'b@partner.example', to_name: '', subject: 'C', body: 'D', skip_reason: null },
      ],
    );
    store.claimBatch(made.id, 'u1', LATER, '2026-11-03T00:50:00.000Z');
    store.setItem(made.id, 0, { status: 'failed', error: '宛先が受け付けられませんでした' });
    store.setItem(made.id, 1, { status: 'unknown', error: '届いたか確認できません' });
    expect(store.nextItems(made.id, 5, false)).toEqual([]);
    expect(store.nextItems(made.id, 5, true).map((i) => i.idx)).toEqual([0]);
  });

  it('adds the synthetic organizations once, to an empty store only', () => {
    expect(seedOrganizations(store, 'u1', NOW)).toBe(SYNTHETIC_ORGANIZATIONS.length);
    expect(seedOrganizations(store, 'u1', NOW)).toBe(0);
    expect(store.page({ terms: [] }, 100, 0).total).toBe(SYNTHETIC_ORGANIZATIONS.length);
    expect(store.history(store.page({ terms: [] }, 1, 0).rows[0]!.id)[0]).toMatchObject({ action: 'imported' });
  });
});
