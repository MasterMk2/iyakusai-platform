import type { DecisionInput, DecisionSource } from '../../shared/decisions.js';
import type { DecisionsStore } from './store.js';

// Synthetic decisions for the demo (SMM_AUTH_MODE=demo): every name, date and place is made up. The keys are the
// demo task service's department keys, so the screens' department labels show.

const input = (title: string, departments: string[], decidedOn: string, venue: DecisionInput['venue'], sources: DecisionSource[], extra: Partial<DecisionInput> = {}): DecisionInput => ({
  title,
  body: '',
  departments,
  decidedOn,
  venue,
  venueOther: '',
  sources,
  taskIds: [],
  ...extra,
});

/** Fills an empty register with a few demo decisions, one of them a change and one revoked. Does nothing otherwise. */
export function seedDecisionsDemo(store: DecisionsStore, actorId: string, at: string): void {
  if (store.count() > 0) return;
  const manual: DecisionSource[] = [{ kind: 'manual', refId: null, label: '合成データ（手入力）', link: null }];
  const minutes: DecisionSource[] = [{ kind: 'minutes', refId: 'mt_0123456789abcdef', label: '合成の定例ミーティング（2026-09-20）', link: '#/bot/minutes?job=mt_0123456789abcdef' }];

  const original = store.create(
    input('来場者向けパンフレットは 2,000 部刷る', ['planning'], '2026-09-20', 'regular', minutes, { body: '中身の校正は 10 月末までに終える。' }),
    actorId,
    at,
    null,
  ).row;
  const changed = store.supersede(
    original.id,
    original.version,
    input('来場者向けパンフレットは 2,500 部刷る', ['planning'], '2026-10-18', 'board', manual, { body: '来場の見込みが増えたため、前回の 2,000 部から増やす。' }),
    '来場の見込みが増えたため、500 部増やした',
    actorId,
    at,
  );
  if (!changed || typeof changed === 'string') throw new Error('seed: change refused');

  store.create(
    input('当日の案内所は本部テントの隣に置く', ['gaimu'], '2026-10-14', 'subcommittee', manual),
    actorId,
    at,
    null,
  );
  store.create(
    input('出展団体への案内メールは 10 月 31 日までに送る', ['naimu'], '2026-10-10', 'mail', [{ kind: 'mail', refId: 'th_0123456789abcdef', label: '合成の案内メール（出展団体向け）', link: '#/all?thread=th_0123456789abcdef' }]),
    actorId,
    at,
    null,
  );
  const abandoned = store.create(
    input('打ち上げは 11 月 28 日の夜に行う', ['somu'], '2026-10-02', 'other', manual, { venueOther: '合成の懇親会（別案）' }),
    actorId,
    at,
    null,
  ).row;
  store.revoke(abandoned.id, abandoned.version, '会場の都合で日程を見直すため取り消した（合成データ）', actorId, at);
}
