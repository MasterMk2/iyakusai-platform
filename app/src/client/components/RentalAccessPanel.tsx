import { useCallback, useEffect, useRef, useState } from 'react';
import type { RentalAccessPermission, RentalAccessPerson, RentalAccessResponse } from '../../shared/rental-access';
import { api, ApiFailure, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

const ROLES = [
  ['none', '利用なし'], ['loan', '貸出・返却'], ['issue', '発行・台帳変更'], ['operator', '貸出・返却・発行'], ['admin', '物品管理者'],
] as const;
type Role = (typeof ROLES)[number][0];
const permissionsFor = (role: Role): RentalAccessPermission[] => role === 'admin' ? ['rental.admin', 'rental.issue', 'rental.loan'] : role === 'operator' ? ['rental.issue', 'rental.loan'] : role === 'loan' ? ['rental.loan'] : role === 'issue' ? ['rental.issue'] : [];
const roleFor = (permissions: RentalAccessPermission[], admin = false): Role => admin || permissions.includes('rental.admin') ? 'admin' : permissions.includes('rental.loan') && permissions.includes('rental.issue') ? 'operator' : permissions.includes('rental.loan') ? 'loan' : permissions.includes('rental.issue') ? 'issue' : 'none';
const roleLabel = (role: Role) => ROLES.find(([value]) => value === role)![1];
const without = <T,>(record: Record<string, T>, key: string) => {
  const rest = { ...record };
  delete rest[key];
  return rest;
};

async function rentalApi<T>(method: 'GET' | 'PUT', body?: unknown, signal?: AbortSignal): Promise<T> {
  try { return await api<T>(method, '/api/rental/admin/access', body, signal); }
  catch (error) {
    const failure = toFailure(error);
    const detail = failure.body as { error?: unknown; message?: unknown } | null;
    if (typeof detail?.error === 'string' && !detail.message) throw new ApiFailure(failure.status, failure.body, detail.error);
    throw error;
  }
}

/**
 * Rental permissions (access administrators). A save uses the answer of the server (the whole list) instead of
 * reloading it, and only the row being saved waits; the other rows keep what was chosen in them (2026-10-26: the
 * whole list was locked until a reload, and every row was rebuilt, losing choices made in other rows). Saves go
 * one after another, since each needs the revision the previous one made.
 */
export function RentalAccessPanel({ onChanged }: { onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => {
    void refresh;
    try { return await rentalApi<RentalAccessResponse>('GET', undefined, signal); }
    catch (error) { if (toFailure(error).status === 404) return null; throw error; }
  }, [refresh]);
  const access = useLoader(load);
  // The answer of the last save: newer than the loaded list until the next reload.
  const [saved, setSaved] = useState<RentalAccessResponse | null>(null);
  const [filter, setFilter] = useState('');
  // What is being saved and what failed, by 'policy' or the person's id.
  const [saving, setSaving] = useState<Record<string, true>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef<number | null>(null);
  const data = saved ?? access.data;
  useEffect(() => { if (data) revision.current = data.revision; }, [data]);
  const needle = filter.normalize('NFKC').trim().toLowerCase();
  const people = data?.people.filter((p) => !needle || `${p.displayName} ${p.roleLabel}`.normalize('NFKC').toLowerCase().includes(needle)) ?? [];
  // Only a reload (the first one, or after another administrator's change) locks the whole list.
  const locked = !saved && (access.loading || access.error !== null);

  function save(target: string, body: Record<string, unknown>, text: string): Promise<boolean> {
    setSaving((s) => ({ ...s, [target]: true }));
    setFailed((f) => without(f, target));
    setMessage(null);
    const run = queue.current.then(async () => {
      try {
        const next = await rentalApi<RentalAccessResponse>('PUT', { ...body, expectedRevision: revision.current });
        revision.current = next.revision;
        setSaved(next);
        setMessage({ text, error: false });
        onChanged();
        return true;
      } catch (error) {
        const failure = toFailure(error);
        setMessage({ text: failure.message, error: true });
        setFailed((f) => ({ ...f, [target]: failure.message }));
        if (failure.status === 409) { setSaved(null); setRefresh((n) => n + 1); }
        return false;
      } finally { setSaving((s) => without(s, target)); }
    });
    queue.current = run;
    return run;
  }

  if (!access.loading && !access.error && !data) return null;
  return (
    <section className="admin rental-access" aria-labelledby="rental-access-title" data-testid="rental-access">
      <h3 id="rental-access-title">物品の権限</h3>
      <p className="hint">物品管理者は、貸出・返却・発行・台帳変更とリセットを行えます。この画面で変えるのは物品の権限です。</p>
      <LoadStatus loader={access} what="物品の権限" compact />
      {message && <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'} data-testid="rental-access-message">{message.text}</p>}
      {data && <>
        <PolicyForm enabled={data.allMembersAdmin} disabled={locked} saving={!!saving.policy} error={failed.policy} onSave={(enabled) => save('policy', { kind: 'policy', allMembersAdmin: enabled }, `全員設定を${enabled ? 'オン' : 'オフ'}にしました。`)} />
        <div className="rental-access-heading">
          <h4>委員ごとの権限</h4>
          <p className="hint">登録済み {data.people.length} 人・現在の物品管理者 {data.people.filter((p) => p.effectiveAdmin).length} 人</p>
        </div>
        {data.allMembersAdmin && <p className="hint">全員設定がオンの間は、個別設定に関わらず全員が物品管理者です。個別設定は、全員設定をオフにしたときに使います。</p>}
        <label className="rental-access-search">名前・所属で絞り込み<input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        {people.length ? <ul className="rows rental-access-people">{people.map((person) =>
          <PersonRow key={person.id} person={person} disabled={locked} saving={!!saving[person.id]} error={failed[person.id]} onSave={(role) => save(person.id, { kind: 'account', userId: person.id, permissions: permissionsFor(role) }, `${person.displayName} さんの個別設定を「${roleLabel(role)}」にしました。`)} />,
        )}</ul> : <p className="empty">{data.people.length ? '該当する委員がいません。絞り込みを変えてください。' : '登録済みの委員がいません。利用登録後にここへ表示されます。'}</p>}
        <details className="rental-access-history">
          <summary>最近の権限変更（{data.history.length} 件）</summary>
          {data.history.length ? <ol>{data.history.map((event) => <li key={event.id}>
            <strong>{event.kind === 'policy' ? `全員設定：${event.after ? 'オン' : 'オフ'}` : `${event.targetName}：${roleLabel(roleFor(event.after as RentalAccessPermission[]))}`}</strong>
            <span className="hint">{fmtDate(event.at)}・{event.actorName}</span>
          </li>)}</ol> : <p className="hint">この画面からの変更はまだありません。</p>}
        </details>
      </>}
    </section>
  );
}

// A choice not saved yet stays until it is saved or set back; otherwise the saved setting shows.
function PolicyForm({ enabled, disabled, saving, error, onSave }: { enabled: boolean; disabled: boolean; saving: boolean; error?: string; onSave: (enabled: boolean) => Promise<boolean> }) {
  const [draft, setDraft] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const value = draft ?? enabled;
  const off = disabled || saving;
  return <form className="rental-access-policy" aria-label="全員の物品管理者設定" onSubmit={(e) => {
    e.preventDefault();
    if (enabled && !value && !confirm) { setConfirm(true); return; }
    void onSave(value).then((ok) => { if (ok) { setDraft(null); setConfirm(false); } });
  }}>
    <div className="rental-access-policy-title"><h4>全員設定</h4><span className={`status ${enabled ? 'ok' : 'info'}`}>保存済み：{enabled ? 'オン' : 'オフ'}</span></div>
    <label className="checkbox"><input type="checkbox" checked={value} disabled={off} onChange={(e) => { setDraft(e.target.checked === enabled ? null : e.target.checked); setConfirm(false); }} />全員に物品の管理者権限を付ける</label>
    <p className="hint">今後新しく利用登録する委員も対象です。</p>
    {confirm ? <div className="status warning" role="alert">
      <p>オフにすると、委員ごとの個別設定に切り替わります。必要な権限が設定されているか確認してください。</p>
      <button type="submit" disabled={off}>{saving ? '保存中…' : '個別設定に切り替える'}</button>{' '}
      <button type="button" className="secondary" disabled={off} onClick={() => { setDraft(null); setConfirm(false); }}>やめる</button>
    </div> : <button type="submit" disabled={off || value === enabled}>{saving ? '保存中…' : '全員設定を保存'}</button>}
    {error && <p className="rental-access-failed" role="alert">保存できませんでした：{error}</p>}
  </form>;
}

function PersonRow({ person, disabled, saving, error, onSave }: { person: RentalAccessPerson; disabled: boolean; saving: boolean; error?: string; onSave: (role: Role) => Promise<boolean> }) {
  const current = roleFor(person.storedPermissions);
  const [draft, setDraft] = useState<Role | null>(null);
  const value = draft ?? current;
  const effective = roleFor(person.effectivePermissions, person.effectiveAdmin);
  return <li className="rental-access-person">
    <div className="rental-access-person-name"><strong>{person.displayName}</strong><span className="hint">{person.roleLabel}</span><span className="rental-access-effective">現在：{roleLabel(effective)}</span></div>
    <label>個別設定<select aria-label={`${person.displayName} さんの個別設定`} value={value} disabled={disabled || saving} onChange={(e) => { const role = e.target.value as Role; setDraft(role === current ? null : role); }}>{ROLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
    <button type="button" aria-label={`${person.displayName} さんの権限を保存`} disabled={disabled || saving || value === current} onClick={() => void onSave(value).then((ok) => { if (ok) setDraft(null); })}>{saving ? '保存中…' : '保存'}</button>
    {error && <p className="rental-access-failed" role="alert">保存できませんでした：{error}</p>}
  </li>;
}
