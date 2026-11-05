import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCOUNTING_PERMISSION_LABELS, ACCOUNTING_PERMISSIONS, type AccountingAccessResponse, type AccountingPermission } from '../../../shared/payments';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import { failureOf } from './common';
import './payments.css';

// 設定 → 会計の権限 (権限管理者): 会計を見る and 請求と入金の確定, for a department (every member with its Discord role,
// e.g. 会計課) and for one member. A box saves as soon as it is changed; temporary staff are not listed and cannot
// hold either. The panel is left out where the server has no accounting (404).
// The same manner as 物品の権限 (RentalAccessPanel): only the row being saved waits, and a failure is shown on its
// row; saves go one after another, since each needs the revision the previous one made.

const without = <T,>(record: Record<string, T>, key: string) => {
  const rest = { ...record };
  delete rest[key];
  return rest;
};

export function AccountingAccessPanel({ onAvailable }: { onAvailable?: (available: boolean) => void } = {}) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    async (signal: AbortSignal) => {
      void refresh;
      try {
        const data = await api<AccountingAccessResponse>('GET', '/api/payments/admin/access', undefined, signal);
        return data && Array.isArray(data.people) && Array.isArray(data.departments) ? data : null;
      } catch (err) {
        if (failureOf(err).status === 404) return null;
        throw err;
      }
    },
    [refresh],
  );
  const access = useLoader(load);
  // The answer of the last save: newer than the loaded list until the next reload.
  const [saved, setSaved] = useState<AccountingAccessResponse | null>(null);
  // What is being saved and what failed, by row ('d:会計課', 'u:<id>').
  const [saving, setSaving] = useState<Record<string, true>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  // The box as it was just set, by 'row:permission', until the server answers (a failure puts it back).
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [filter, setFilter] = useState('');
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef<number | null>(null);
  const data = saved ?? access.data;
  useEffect(() => {
    if (data) revision.current = data.revision;
  }, [data]);
  // Only a reload (the first one, or after another administrator's change) stops the whole list.
  const locked = !saved && (access.loading || access.error !== null);

  const save = (row: string, target: { userId: string } | { department: string }, permission: AccountingPermission, on: boolean, text: string) => {
    const box = `${row}:${permission}`;
    setSaving((s) => ({ ...s, [row]: true }));
    setPending((b) => ({ ...b, [box]: on }));
    setFailed((f) => without(f, row));
    setMessage(null);
    const run = queue.current.then(async () => {
      try {
        const next = await api<AccountingAccessResponse>('PUT', '/api/payments/admin/access', { expectedRevision: revision.current ?? 0, ...target, permission, on });
        revision.current = next.revision;
        setSaved(next);
        setMessage({ text, error: false });
      } catch (err) {
        const f = failureOf(err);
        setMessage({ text: f.message, error: true });
        setFailed((prev) => ({ ...prev, [row]: f.message }));
        if (f.conflict) {
          setSaved(null);
          setRefresh((n) => n + 1);
        }
      } finally {
        setSaving((s) => without(s, row));
        setPending((b) => without(b, box));
      }
    });
    queue.current = run;
  };

  const absent = !access.loading && !access.error && !data;
  useEffect(() => {
    if (!access.loading) onAvailable?.(!absent);
  }, [access.loading, absent, onAvailable]);
  if (absent) return null;

  const departmentHas = (department: string, permission: AccountingPermission) => data?.departmentGrants.some((g) => g.department === department && g.permission === permission) ?? false;
  const needle = filter.normalize('NFKC').trim().toLowerCase();
  const people = data?.people.filter((p) => !needle || `${p.displayName} ${p.roleLabel}`.normalize('NFKC').toLowerCase().includes(needle)) ?? [];
  const boxes = (row: string, has: (p: AccountingPermission) => boolean, target: { userId: string } | { department: string }, name: string) => (
    <span className="pay-access-boxes">
      {ACCOUNTING_PERMISSIONS.map((p) => (
        <label key={p}>
          <input
            type="checkbox"
            checked={pending[`${row}:${p}`] ?? has(p)}
            disabled={locked || !!saving[row]}
            aria-label={`${name}の「${ACCOUNTING_PERMISSION_LABELS[p]}」`}
            onChange={(e) => save(row, target, p, e.target.checked, `${name}の「${ACCOUNTING_PERMISSION_LABELS[p]}」を${e.target.checked ? '付けました' : '外しました'}。`)}
          />
          {ACCOUNTING_PERMISSION_LABELS[p]}
        </label>
      ))}
      {saving[row] && (
        <span className="hint" role="status">
          保存中…
        </span>
      )}
    </span>
  );
  const rowFailure = (row: string) =>
    failed[row] ? (
      <p className="pay-access-failed" role="alert">
        保存できませんでした：{failed[row]}
      </p>
    ) : null;

  return (
    <section className="admin" aria-labelledby="pay-access-title" data-testid="accounting-access">
      <h3 id="pay-access-title">会計の権限</h3>
      <p className="hint">
        「会計を見る」は請求・入金の一覧と CSV の書き出し、「請求と入金の確定」は請求を作る・明細を取り込む・入金を確定することです（確定できる人は見ることもできます）。権限のない委員は、団体の画面で「入金済みかどうか」だけを見られます。
      </p>
      <LoadStatus loader={access} what="会計の権限" compact />
      {message && (
        <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {data && (
        <>
          <h4>部局ごと（その部局のロールを持つ委員全員）</h4>
          {data.departments.length === 0 ? (
            <p className="hint">部局のロールを持つ委員がまだいません。</p>
          ) : (
            <ul className="pay-access-grid">
              {data.departments.map((d) => (
                <li key={d}>
                  <span className="pay-access-name">
                    <strong>{d}</strong>
                  </span>
                  {boxes(`d:${d}`, (p) => departmentHas(d, p), { department: d }, `部局「${d}」`)}
                  {rowFailure(`d:${d}`)}
                </li>
              ))}
            </ul>
          )}
          <h4>委員ごと</h4>
          <label className="pay-access-search">
            名前・所属で絞り込み
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {people.length === 0 ? (
            <p className="hint">{data.people.length ? '該当する委員がいません。絞り込みを変えてください。' : '登録済みの委員がいません。'}</p>
          ) : (
            <ul className="pay-access-grid">
              {people.map((person) => (
                <li key={person.id}>
                  <span className="pay-access-name">
                    <strong>{person.displayName}</strong>
                    <span className="hint">
                      {person.roleLabel} · 今使える権限: {person.effective.length ? person.effective.map((p) => ACCOUNTING_PERMISSION_LABELS[p]).join('・') : 'なし'}
                    </span>
                  </span>
                  {boxes(`u:${person.id}`, (p) => person.stored.includes(p), { userId: person.id }, `${person.displayName} さん`)}
                  {rowFailure(`u:${person.id}`)}
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>最近の会計の権限の変更（{data.history.length} 件）</summary>
            {data.history.length ? (
              <ol>
                {data.history.map((h) => (
                  <li key={h.id}>
                    {h.text}
                    <span className="hint">
                      {' '}
                      {fmtDate(h.at)}・{h.actorName}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">まだ変更はありません。</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
