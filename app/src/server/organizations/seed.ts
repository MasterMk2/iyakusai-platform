import type { OrgInput } from '../../shared/organizations.js';
import type { OrganizationsStore } from './store.js';

// Synthetic organizations for trying the screens on a copy of the data (2026 festival, reserved .example style names
// only). Nothing starts this by itself: the app's own start never writes organizations. Used by the tests.

export const SYNTHETIC_ORGANIZATIONS: OrgInput[] = [
  { kind: 'sponsor', fiscalYear: 2026, name: '合成商事株式会社', department: '渉外課', ownerId: null, contactId: null, status: '依頼済み', amountYen: 300_000, content: '広告（大）・パンフレット表紙', nextAction: '申込書の到着を待つ', nextDue: '2026-11-20', notes: '' },
  { kind: 'sponsor', fiscalYear: 2026, name: '合成食品工業', department: '渉外課', ownerId: null, contactId: null, status: '依頼前', amountYen: null, content: '広告（小）', nextAction: '依頼状の案を作る', nextDue: null, notes: '前年度は広告（中）' },
  { kind: 'exhibitor', fiscalYear: 2026, name: '合成サークル「テスト」', department: '企画部', ownerId: null, contactId: null, status: '書類確認', amountYen: 5_000, content: '', nextAction: '出展計画書の確認', nextDue: '2026-11-10', notes: '' },
  { kind: 'donor', fiscalYear: 2026, name: '合成後援会', department: '', ownerId: null, contactId: null, status: '未対応', amountYen: null, content: '', nextAction: '', nextDue: null, notes: '' },
];

/** Adds the synthetic organizations when the store has none yet. Returns how many were added. */
export function seedOrganizations(store: OrganizationsStore, actor: string, now: string): number {
  if (store.page({ terms: [] }, 1, 0).total > 0) return 0;
  for (const data of SYNTHETIC_ORGANIZATIONS) store.create(data, actor, now, 'imported');
  return SYNTHETIC_ORGANIZATIONS.length;
}
