import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateContact } from '../../src/shared/contacts.js';
import { ContactsStore, sortKey } from '../../src/server/contacts/store.js';

// The contacts file on its own (synthetic values only).

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'iyakusai-contacts-store-'));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const NOW = '2026-10-26T00:00:00.000Z';
const contact = (o: Record<string, unknown>) => validateContact({ category: 'external', organization: '', name: '', ...o });

describe('the contacts file', () => {
  it('opens again with what was stored and refuses another schema version', () => {
    const first = new ContactsStore(folder);
    first.create(contact({ organization: '合成商事' }), 'u1', NOW);
    first.close();
    const again = new ContactsStore(folder);
    expect(again.count()).toBe(1);
    again.db.prepare("UPDATE meta SET value='99' WHERE key='schema'").run();
    again.close();
    expect(() => new ContactsStore(folder)).toThrow();
  });

  it('keeps the contact as it was before an edit or a delete', () => {
    const store = new ContactsStore(folder);
    try {
      const row = store.create(contact({ name: '合成 太郎', phones: [{ label: '', number: '090-0000-0001' }] }), 'u1', NOW);
      const edited = store.update(row.id, 1, contact({ name: '合成 太郎', phones: [{ label: '', number: '090-0000-0002' }] }), 'u2', NOW);
      expect(edited).not.toBe('conflict');
      // Saving the same content again changes nothing (no new version, no history row).
      expect(store.update(row.id, 2, contact({ name: '合成 太郎', phones: [{ label: '', number: '090-0000-0002' }] }), 'u2', NOW)).toMatchObject({ version: 2 });
      expect(store.delete(row.id, 2, 'u3', NOW)).toBe('deleted');
      const kept = store.db.prepare('SELECT action, before_json FROM contact_history WHERE contact_id=? ORDER BY id').all(row.id) as { action: string; before_json: string | null }[];
      expect(kept.map((k) => k.action)).toEqual(['created', 'updated', 'deleted']);
      expect(JSON.parse(kept[1]!.before_json!).data.phones[0].number).toBe('090-0000-0001');
      expect(JSON.parse(kept[2]!.before_json!).data.phones[0].number).toBe('090-0000-0002');
    } finally {
      store.close();
    }
  });

  it('sorts by reading, else by the name without the legal form', () => {
    expect(sortKey(contact({ organization: '株式会社あおい商店' }))).toBe('あおい商店');
    expect(sortKey(contact({ organization: '㈱合成', nameKana: 'ゴウセイ' }))).toBe('ごうせい');
    const store = new ContactsStore(folder);
    try {
      for (const organization of ['株式会社さくら', 'あさひ合同', '有限会社かえで']) store.create(contact({ organization }), 'u1', NOW);
      expect(store.all().map((r) => r.data.organization)).toEqual(['あさひ合同', '有限会社かえで', '株式会社さくら']);
    } finally {
      store.close();
    }
  });

  it('filters by tag and counts categories with the search applied', () => {
    const store = new ContactsStore(folder);
    try {
      store.create(contact({ organization: '合成A', tags: ['協賛'] }), 'u1', NOW);
      store.create(contact({ organization: '合成B', tags: ['業者'] }), 'u1', NOW);
      store.create(contact({ category: 'exhibitor', organization: '合成サークル', tags: ['協賛'] }), 'u1', NOW);
      expect(store.page({ terms: [], tag: '協賛' }, 10, 0).total).toBe(2);
      expect(store.categoryCounts({ terms: ['合成'], tag: '協賛' })).toMatchObject({ all: 2, external: 1, exhibitor: 1 });
      expect(store.page({ terms: ['100%'] }, 10, 0).total).toBe(0);
      expect(store.tagCounts()).toEqual([
        { tag: '協賛', count: 2 },
        { tag: '業者', count: 1 },
      ]);
    } finally {
      store.close();
    }
  });
});
