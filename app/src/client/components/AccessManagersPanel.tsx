import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccessManagerRole, AccessManagersResponse } from '../../shared/api';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

const ROLES: [AccessManagerRole, string][] = [
  ['none', 'なし'],
  ['setter', '権限設定者'],
  ['master', 'マスター管理者'],
];
const roleLabel = (role: AccessManagerRole) => ROLES.find(([value]) => value === role)![1];
const ORDER: Record<AccessManagerRole, number> = { master: 0, setter: 1, none: 2 };
const STATUS = { active: '', pending: '登録待ち', retired: '退会' } as const;
type Person = AccessManagersResponse['people'][number];

/**
 * Who manages access (2026-11-06). Access administrators (権限設定者) see who they are; masters choose them and the
 * other masters. Same way of saving as the rental permissions: the answer of the server replaces the list, only the
 * row being saved waits, and a conflict reloads.
 */
export function AccessManagersPanel({ onChanged, onAvailable }: { onChanged: () => void; onAvailable?: (available: boolean) => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    async (signal: AbortSignal) => {
      void refresh;
      try {
        return await api<AccessManagersResponse>('GET', '/api/auth/admin/managers', undefined, signal);
      } catch (error) {
        if (toFailure(error).status === 404) return null;
        throw error;
      }
    },
    [refresh],
  );
  const loaded = useLoader(load);
  const [saved, setSaved] = useState<AccessManagersResponse | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ account: string; text: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const version = useRef<number | null>(null);
  const data = saved ?? loaded.data;
  useEffect(() => {
    if (data) version.current = data.version;
  }, [data]);

  const absent = !loaded.loading && !loaded.error && !data;
  useEffect(() => {
    if (!loaded.loading) onAvailable?.(!absent);
  }, [loaded.loading, absent, onAvailable]);
  if (absent) return null;

  const needle = filter.normalize('NFKC').trim().toLowerCase();
  const people = (data?.people ?? [])
    .filter((p) => !needle || `${p.name} ${p.studentId ?? ''} ${p.departments.join(' ')}`.normalize('NFKC').toLowerCase().includes(needle))
    .sort((x, y) => ORDER[x.role] - ORDER[y.role]);
  const count = (role: AccessManagerRole) => data?.people.filter((p) => p.role === role).length ?? 0;
  const byConfig = data?.people.filter((p) => p.byConfig && p.role === 'none') ?? [];
  const locked = !saved && (loaded.loading || loaded.error !== null);

  async function save(person: Person, role: AccessManagerRole): Promise<boolean> {
    setSaving(person.account);
    setFailed(null);
    setMessage(null);
    try {
      const next = await api<AccessManagersResponse>('PUT', '/api/auth/admin/managers', { account: person.account, role, expectedVersion: version.current ?? 0 });
      version.current = next.version;
      setSaved(next);
      setMessage({ text: `${person.name} さんを「${roleLabel(role)}」にしました。`, error: false });
      onChanged();
      return true;
    } catch (error) {
      const failure = toFailure(error);
      setMessage({ text: failure.message, error: true });
      setFailed({ account: person.account, text: failure.message });
      if (failure.status === 409) {
        setSaved(null);
        setRefresh((n) => n + 1);
      }
      return false;
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="admin rental-access access-managers" aria-labelledby="access-managers-title" data-testid="access-managers">
      <h3 id="access-managers-title">権限設定者</h3>
      <p className="hint">
        権限設定者は、この設定画面でメール・公式LINE・会計・物品などの権限を付けられる人です。マスター管理者は権限設定者を兼ね、権限設定者とマスター管理者を選べます。
      </p>
      <LoadStatus loader={loaded} what="権限設定者" compact />
      {message && (
        <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'} data-testid="access-managers-message">
          {message.text}
        </p>
      )}
      {data && (
        <>
          <div className="rental-access-heading">
            <h4>委員ごとの役割</h4>
            <p className="hint">
              マスター管理者 {count('master')} 人・権限設定者 {count('setter')} 人
            </p>
          </div>
          {!data.canEdit && <p className="hint">変えられるのはマスター管理者だけです。変えたいときはマスター管理者に頼んでください。</p>}
          {byConfig.length > 0 && (
            <p className="hint">
              サーバーの設定ファイルでも権限設定者になっている人がいます（{byConfig.map((p) => p.name).join('、')}）。この画面では外せません。
            </p>
          )}
          <label className="rental-access-search">
            名前・学籍番号・所属で絞り込み
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {people.length ? (
            <ul className="rows rental-access-people">
              {people.map((person) => (
                <PersonRow
                  key={person.account}
                  person={person}
                  canEdit={data.canEdit}
                  disabled={locked || saving !== null}
                  saving={saving === person.account}
                  error={failed?.account === person.account ? failed.text : undefined}
                  onSave={(role) => save(person, role)}
                />
              ))}
            </ul>
          ) : (
            <p className="empty">{data.people.length ? '該当する委員がいません。絞り込みを変えてください。' : '登録済みの委員がいません。'}</p>
          )}
          <details className="rental-access-history">
            <summary>最近の変更（{data.history.length} 件）</summary>
            {data.history.length ? (
              <ol>
                {data.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <strong>
                      {h.targetName}：{roleLabel(h.before)} → {roleLabel(h.after)}
                    </strong>
                    <span className="hint">
                      {fmtDate(h.at)}・{h.actorName}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">この画面からの変更はまだありません。</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}

function PersonRow({ person, canEdit, disabled, saving, error, onSave }: { person: Person; canEdit: boolean; disabled: boolean; saving: boolean; error?: string; onSave: (role: AccessManagerRole) => Promise<boolean> }) {
  const [draft, setDraft] = useState<AccessManagerRole | null>(null);
  const [confirm, setConfirm] = useState(false);
  const value = draft ?? person.role;
  const status = STATUS[person.status];
  // Leaving the masters oneself cannot be undone from here: asked once more.
  const leavingSelf = person.self && person.role === 'master' && value !== 'master';
  const submit = () => {
    if (leavingSelf && !confirm) {
      setConfirm(true);
      return;
    }
    void onSave(value).then((ok) => {
      if (ok) {
        setDraft(null);
        setConfirm(false);
      }
    });
  };
  return (
    <li className="rental-access-person">
      <div className="rental-access-person-name">
        <strong>
          {person.name}
          {person.self ? '（自分）' : ''}
        </strong>
        <span className="hint">
          {[person.departments.join('・') || '委員', status].filter(Boolean).join('・')}
        </span>
        {person.byConfig && <span className="rental-access-effective">設定ファイルでも権限設定者</span>}
      </div>
      <label>
        役割
        <select
          aria-label={`${person.name} さんの役割`}
          value={value}
          disabled={!canEdit || disabled || saving}
          onChange={(e) => {
            const role = e.target.value as AccessManagerRole;
            setDraft(role === person.role ? null : role);
            setConfirm(false);
          }}
        >
          {ROLES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {canEdit && (
        <button type="button" aria-label={`${person.name} さんの役割を保存`} disabled={disabled || saving || value === person.role} onClick={submit}>
          {saving ? '保存中…' : '保存'}
        </button>
      )}
      {confirm && (
        <div className="status warning access-managers-confirm" role="alert">
          <p>自分をマスター管理者から外すと、自分では戻せません（ほかのマスター管理者に頼むことになります）。</p>
          <button type="button" disabled={disabled || saving} onClick={submit}>
            外す
          </button>{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setDraft(null);
              setConfirm(false);
            }}
          >
            やめる
          </button>
        </div>
      )}
      {error && (
        <p className="rental-access-failed" role="alert">
          保存できませんでした：{error}
        </p>
      )}
    </li>
  );
}
