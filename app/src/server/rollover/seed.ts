import { validateOrg, type OrgInput } from '../../shared/organizations.js';
import type { OrganizationsStore } from '../organizations/store.js';

// Synthetic organizations for the demo (SMM_AUTH_MODE=demo), so the year rollover has a ledger to copy: every name,
// amount and content is made up and marked 合成. Written only into an empty file.

const ACTOR = 'demo-seed';

export function seedRolloverDemo(store: OrganizationsStore, year: number, nowIso: string): void {
  if (store.page({ terms: [] }, 1, 0).total > 0) return;
  const org = (over: Partial<OrgInput> & Pick<OrgInput, 'kind' | 'name' | 'status'>): OrgInput =>
    validateOrg({ fiscalYear: year, department: '渉外部', ownerId: null, contactId: null, amountYen: null, content: '', nextAction: '', nextDue: null, notes: '', ...over });
  const samples: OrgInput[] = [
    org({ kind: 'sponsor', name: '合成薬局（例）', status: 'お礼状を送った', amountYen: 30000, content: 'パンフレットの広告（1/2ページ）', ownerId: 'u-editor-a', notes: '合成データの例です。' }),
    org({ kind: 'sponsor', name: '合成医療機器（例）', status: '入金済み', amountYen: 50000, content: 'パンフレットの広告（1ページ）' }),
    org({ kind: 'sponsor', name: '合成書店（例）', status: '依頼済み', content: '' }),
    org({ kind: 'sponsor', name: '合成カフェ（例）', status: '依頼前' }),
    org({ kind: 'donor', name: '合成同窓会（例）', status: '受領済み', amountYen: 100000 }),
    org({ kind: 'exhibitor', name: '合成サークル（例）', status: '完了', amountYen: 3000, department: '企画部', content: '模擬店（飲み物）' }),
    org({ kind: 'exhibitor', name: '合成研究会（例）', status: '書類確認', department: '企画部' }),
  ];
  for (const data of samples) store.create(data, ACTOR, nowIso, 'created');
}
