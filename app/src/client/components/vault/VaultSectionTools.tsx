import { useCallback, useState, type FormEvent } from 'react';
import { api, fmtDate } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import {
  VAULT_ACTION_LABELS,
  VAULT_LIMITS,
  VAULT_ROLE_HINTS,
  VAULT_ROLE_LABELS,
  VAULT_ROLES,
  type VaultEventsResponse,
  type VaultMemberKind,
  type VaultMembersResponse,
  type VaultRole,
  type VaultSectionSummary,
} from '../../../shared/vault';

// The selected section: the state of its paper copy and its print, then (on a button) who opens it and its record.
// Renaming and removing a section are an access administrator's, kept under その他 apart from the daily buttons.

export function VaultSectionTools(props: {
  section: VaultSectionSummary;
  /** The book is open (the list is on the screen): printing and the record are offered only then. */
  open: boolean;
  canAdminister: boolean;
  tool: 'members' | 'events' | null;
  onTool: (tool: 'members' | 'events' | null) => void;
  onPrint: () => void;
  onChanged: () => void;
  onRemoved: () => void;
  onFail: (err: unknown) => void;
}) {
  const { section: s } = props;
  const [confirmPrint, setConfirmPrint] = useState(false);
  const [more, setMore] = useState(false);
  const paper =
    s.entryCount === 0
      ? null
      : s.lastPrintedAt === null
        ? 'まだ印刷していません。'
        : s.changesSincePrint > 0
          ? `紙の控えが古くなっています（${fmtDate(s.lastPrintedAt)} の印刷のあと ${s.changesSincePrint} 件の変更）。刷り直して、古い紙は細断してください。`
          : `紙の控えは最新です（${fmtDate(s.lastPrintedAt)} に印刷）。`;
  return (
    <div className="vault-section" data-testid="vault-section-tools">
      <div className="vault-section-head">
        <h4>
          {s.name}
          <span className="pay-badge">{s.myRole ? VAULT_ROLE_LABELS[s.myRole] : 'メンバーではありません'}</span>
        </h4>
        {s.note && <p className="hint">{s.note}</p>}
        {paper && <p className={`hint ${s.lastPrintedAt === null || s.changesSincePrint > 0 ? 'vault-stale' : ''}`}>{paper}</p>}
        {!s.myRole && <p className="hint">権限管理者として、名前・見られる人・記録だけを見ています。値を見るには、自分を見られる人に加えてください（記録に残ります）。</p>}
      </div>
      <div className="admin-actions">
        {props.open && s.myRole && s.entryCount > 0 && (
          <button type="button" className="secondary" onClick={() => setConfirmPrint(true)} aria-expanded={confirmPrint} data-testid="vault-print">
            紙に印刷
          </button>
        )}
        <button type="button" className="secondary" aria-pressed={props.tool === 'members'} onClick={() => props.onTool(props.tool === 'members' ? null : 'members')} data-testid="vault-members">
          見られる人
        </button>
        {props.open && s.canManage && (
          <button type="button" className="secondary" aria-pressed={props.tool === 'events'} onClick={() => props.onTool(props.tool === 'events' ? null : 'events')} data-testid="vault-events">
            記録
          </button>
        )}
        {props.canAdminister && (
          <button type="button" className="quiet" aria-expanded={more} onClick={() => setMore((v) => !v)}>
            その他
          </button>
        )}
      </div>
      {props.open && confirmPrint && (
        <div className="status warning vault-print-confirm" role="group" aria-label="印刷の確認">
          <p>
            この区分のパスワードとメモを {s.entryCount} 件すべて紙に出します（印刷したことは記録に残ります）。印刷の画面では「PDF に保存」を選ばず、プリンターで印刷してください。刷った紙は封筒に入れて封をし、決めてある金庫へ。
          </p>
          <div className="admin-actions">
            <button
              type="button"
              onClick={() => {
                setConfirmPrint(false);
                props.onPrint();
              }}
              data-testid="vault-print-go"
            >
              印刷する
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmPrint(false)}>
              やめる
            </button>
          </div>
        </div>
      )}
      {more && props.canAdminister && <SectionAdmin section={s} onChanged={props.onChanged} onRemoved={props.onRemoved} onFail={props.onFail} />}
      {props.tool === 'members' && <Members section={s} onChanged={props.onChanged} onFail={props.onFail} />}
      {props.open && props.tool === 'events' && s.canManage && <Events section={s} />}
    </div>
  );
}

function SectionAdmin({ section, onChanged, onRemoved, onFail }: { section: VaultSectionSummary; onChanged: () => void; onRemoved: () => void; onFail: (err: unknown) => void }) {
  const [name, setName] = useState(section.name);
  const [note, setNote] = useState(section.note);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('PUT', `/api/vault/sections/${section.id}`, { name, note, expectedVersion: section.version });
      onChanged();
    } catch (err) {
      onFail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api('DELETE', `/api/vault/sections/${section.id}?expectedVersion=${section.version}`);
      onRemoved();
    } catch (err) {
      onFail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-form vault-form" onSubmit={save}>
      <label>
        区分の名前
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={VAULT_LIMITS.sectionName} required />
      </label>
      <label>
        説明（任意）
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={VAULT_LIMITS.sectionNote} />
      </label>
      <div className="admin-actions">
        <button type="submit" disabled={busy || name.trim() === '' || (name === section.name && note === section.note)}>
          名前・説明を保存
        </button>
      </div>
      <div className="vault-danger">
        {section.entryCount > 0 ? (
          <p className="hint">項目が残っている区分は消せません（{section.entryCount} 件）。</p>
        ) : confirm ? (
          <span className="confirm">
            区分と見られる人の指定を消します。
            <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
              消す
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(false)}>
              やめる
            </button>
          </span>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirm(true)}>
            この区分を消す
          </button>
        )}
      </div>
    </form>
  );
}

function Members({ section, onChanged, onFail }: { section: VaultSectionSummary; onChanged: () => void; onFail: (err: unknown) => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<VaultMembersResponse>('GET', `/api/vault/sections/${section.id}/members`, undefined, signal);
    },
    [section.id, refresh],
  );
  const members = useLoader(load);
  const data = members.data;
  const [kind, setKind] = useState<VaultMemberKind>('department');
  const [target, setTarget] = useState('');
  const [role, setRole] = useState<VaultRole>('view');
  const [busy, setBusy] = useState(false);
  const canManage = data?.section.canManage ?? false;

  const set = async (k: VaultMemberKind, t: string, r: VaultRole | null) => {
    if (!data) return;
    setBusy(true);
    try {
      await api('PUT', `/api/vault/sections/${section.id}/members`, { kind: k, target: t, role: r, expectedVersion: data.section.version });
      setTarget('');
      setRefresh((n) => n + 1);
      onChanged();
    } catch (err) {
      onFail(err);
      setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  const options = kind === 'department' ? (data?.choices.departments ?? []).map((d) => ({ value: d, label: d })) : (data?.choices.people ?? []).map((p) => ({ value: p.id, label: p.departments.length ? `${p.name}（${p.departments.join('・')}）` : p.name }));

  return (
    <div className="vault-members" data-testid="vault-members-panel">
      <h5>見られる人</h5>
      <LoadStatus loader={members} what="見られる人" compact />
      {data && (
        <>
          <p className="hint">部局で付けると、その部局のロールを持つ人が全員開けます（Discord でロールを付けられる人が、開ける人を増やせます）。部局の名前が変わると、その指定は外れます。</p>
          <table className="vault-table">
            <thead>
              <tr>
                <th>相手</th>
                <th>役割</th>
                <th>付けた人</th>
                {canManage && <th>変更</th>}
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={`${m.kind}:${m.target}`}>
                  <td>
                    {m.kind === 'department' ? '部局 ' : ''}
                    {m.label}
                  </td>
                  <td>
                    {canManage ? (
                      <select aria-label={`${m.label}の役割`} value={m.role} disabled={busy} onChange={(e) => void set(m.kind, m.target, e.target.value as VaultRole)}>
                        {VAULT_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {VAULT_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      VAULT_ROLE_LABELS[m.role]
                    )}
                  </td>
                  <td className="hint">
                    {m.grantedByName}（{fmtDate(m.grantedAt)}）
                  </td>
                  {canManage && (
                    <td>
                      <button type="button" className="secondary" disabled={busy} onClick={() => void set(m.kind, m.target, null)}>
                        外す
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {canManage && (
            <form
              className="vault-member-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (target) void set(kind, target, role);
              }}
            >
              <fieldset className="admin-actions">
                <legend className="sr-only">付ける相手の種類</legend>
                <label>
                  <input type="radio" name={`vault-kind-${section.id}`} checked={kind === 'department'} onChange={() => { setKind('department'); setTarget(''); }} />
                  部局
                </label>
                <label>
                  <input type="radio" name={`vault-kind-${section.id}`} checked={kind === 'user'} onChange={() => { setKind('user'); setTarget(''); }} />人
                </label>
              </fieldset>
              <label>
                相手
                <select value={target} onChange={(e) => setTarget(e.target.value)} required data-testid="vault-member-target">
                  <option value="">選んでください</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                役割
                <select value={role} onChange={(e) => setRole(e.target.value as VaultRole)}>
                  {VAULT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {VAULT_ROLE_LABELS[r]}（{VAULT_ROLE_HINTS[r]}）
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={busy || target === ''} data-testid="vault-member-add">
                付ける
              </button>
            </form>
          )}
          <h5>いま開ける人（{data.openers.length} 人）</h5>
          {data.openers.length === 0 ? (
            <p className="hint">いません。</p>
          ) : (
            <ul className="vault-openers">
              {data.openers.map((o) => (
                <li key={o.id}>
                  {o.name}：{VAULT_ROLE_LABELS[o.role]}
                  <span className="hint">（{o.via.join('・')}）</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Events({ section }: { section: VaultSectionSummary }) {
  const load = useCallback((signal: AbortSignal) => api<VaultEventsResponse>('GET', `/api/vault/sections/${section.id}/events?limit=100`, undefined, signal), [section.id]);
  const events = useLoader(load);
  return (
    <div className="vault-events" data-testid="vault-events-panel">
      <h5>記録（新しい順・100 件まで）</h5>
      <LoadStatus loader={events} what="記録" compact />
      {events.data && events.data.events.length === 0 && <p className="hint">まだありません。</p>}
      {events.data && events.data.events.length > 0 && (
        <table className="vault-table">
          <thead>
            <tr>
              <th>日時</th>
              <th>人</th>
              <th>したこと</th>
              <th>項目</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {events.data.events.map((e, i) => (
              <tr key={i}>
                <td>{fmtDate(e.at)}</td>
                <td>{e.actorName}</td>
                <td>{VAULT_ACTION_LABELS[e.action]}</td>
                <td>{e.entryName ?? '—'}</td>
                <td>{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
