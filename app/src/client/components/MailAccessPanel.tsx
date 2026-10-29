import { useCallback, useState } from 'react';
import { departmentsOfLabel, type MailAccessResponse } from '../../shared/mailbox';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

type Kind = 'edit' | 'send';
type Target = { userId: string } | { department: string };

const keyOf = (t: Target, mailboxId: string, kind: Kind) => `${'userId' in t ? `u:${t.userId}` : `d:${t.department}`}|${mailboxId}|${kind}`;

/**
 * Grants of the committee mailbox (access administrators), per mailbox. Everyone in the committee reads every
 * mailbox and changes assignees, labels and status. An edit grant allows notes; a send grant allows sending with
 * that mailbox's address as From (only for the addresses the server can send from). A grant goes to a person or
 * to a department (everyone in it, by their Discord roles, now and later).
 * A tick shows at once and is saved in the background; only that tick waits for the server (2026-10-26: the
 * whole list waited for the save and a reload before, and seemed not to react).
 * The official LINE account's grants (2026-10-28) use the same panel and rules: `variant="line"`.
 */
const TEXT = {
  mail: {
    endpoint: '/api/mail/admin/access',
    title: '受信箱の編集権限・送信権限',
    intro: 'メールの閲覧・ラベル付け・担当者変更・対応状況の変更は委員全員ができます。ここで受信箱ごとに付けるのは、内部メモを追加する「編集」と、その受信箱のアドレスを差出人にしてアプリからメールを送る「送信」です。部局に付けると、その部局の委員全員（あとから入った人も）が持ちます。',
    what: '受信箱の権限',
    pick: '受信箱',
    ingested: (n: number) => `取り込み済み ${n} 通`,
    noSend: 'このサーバーでは、アプリからの送信は設定されていません。',
    cannotSend: (name: string) => `「${name}」のアドレスからは送信できない設定です（送信用アカウントに差出人として登録した受信箱だけ送信権限を付けられます）。`,
    prefix: '',
  },
  line: {
    endpoint: '/api/line/admin/access',
    title: '公式LINE の編集権限・送信権限',
    intro: '公式LINE の閲覧・ラベル付け・担当者変更・対応状況の変更は委員全員ができます（臨時スタッフを除く）。ここで付けるのは、内部メモを追加する「編集」と、アプリから公式LINE で送る「送信」です。部局に付けると、その部局の委員全員（あとから入った人も）が持ちます。',
    what: '公式LINE の権限',
    pick: 'アカウント',
    ingested: (n: number) => `取り込み済み ${n} 件`,
    noSend: 'このサーバーでは、公式LINE の送信（チャネルアクセストークン）は設定されていません。今は閲覧だけです。',
    cannotSend: (name: string) => `「${name}」からは送信できない設定です。`,
    prefix: 'line-',
  },
} as const;

export function MailAccessPanel({ variant = 'mail' }: { variant?: keyof typeof TEXT }) {
  const text = TEXT[variant];
  const tid = (id: string) => `${text.prefix}${id}`;
  const load = useCallback((signal: AbortSignal) => api<MailAccessResponse>('GET', text.endpoint, undefined, signal), [text.endpoint]);
  const access = useLoader(load);
  // The answer of the last save (the whole matrix): newer than the loaded one.
  const [saved, setSaved] = useState<MailAccessResponse | null>(null);
  // Ticks being saved: what the screen shows until the server answers.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [mailboxId, setMailboxId] = useState('');
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  // The tick whose save failed (shown on its row too: the message above may be out of sight in a long list).
  const [failed, setFailed] = useState<string | null>(null);

  const data = saved ?? access.data;
  const selected = data?.mailboxes.find((m) => m.id === mailboxId) ?? data?.mailboxes[0] ?? null;
  const sendable = !!selected && !!data?.sendable?.includes(selected.id);
  const has = (list: { userId: string; mailboxId: string }[] | undefined, userId: string) => !!list?.some((g) => g.userId === userId && g.mailboxId === selected?.id);
  const deptHas = (department: string, kind: Kind) => !!data?.departmentGrants?.some((g) => g.department === department && g.mailboxId === selected?.id && g.kind === kind);
  const shown = (t: Target, kind: Kind, stored: boolean) => {
    const p = selected ? pending[keyOf(t, selected.id, kind)] : undefined;
    return p === undefined ? stored : p;
  };
  const busy = (t: Target, kind: Kind) => !!selected && pending[keyOf(t, selected.id, kind)] !== undefined;
  const rowFailed = (t: Target) =>
    selected && failed && (failed === keyOf(t, selected.id, 'edit') || failed === keyOf(t, selected.id, 'send')) ? (
      <span className="grant-failed" role="alert">
        保存できませんでした
      </span>
    ) : null;
  const count = (id: string, kind: Kind) => (kind === 'edit' ? data?.grants : data?.sendGrants)?.filter((g) => g.mailboxId === id).length ?? 0;
  const needle = filter.normalize('NFKC').trim().toLowerCase();
  const people = (data?.people ?? []).filter((p) => !needle || `${p.displayName} ${p.roleLabel}`.normalize('NFKC').toLowerCase().includes(needle));
  const departments = data?.departments ?? [];

  async function toggle(target: Target, kind: Kind, on: boolean, name: string) {
    if (!selected) return;
    const box = selected;
    const key = keyOf(target, box.id, kind);
    setPending((p) => ({ ...p, [key]: on }));
    setMessage(null);
    setFailed(null);
    try {
      const next = await api<MailAccessResponse>('PUT', text.endpoint, { ...target, mailboxId: box.id, [kind]: on });
      setSaved(next);
      const what = kind === 'edit' ? '編集権限' : '送信権限';
      setMessage({ text: `${name}の「${box.name}」の${what}を${on ? '付けました' : '外しました'}。`, error: false });
    } catch (err) {
      setMessage({ text: `${name}：${toFailure(err).message}`, error: true });
      setFailed(key);
    } finally {
      setPending((p) => {
        const rest = { ...p };
        delete rest[key];
        return rest;
      });
    }
  }

  return (
    <section className="admin" aria-labelledby={tid('mail-access-title')} data-testid={tid('mail-access')}>
      <h3 id={tid('mail-access-title')}>{text.title}</h3>
      <p className="hint">{text.intro}</p>
      <LoadStatus loader={access} what={text.what} compact />
      {data && (
        <>
          <p className="hint" data-testid={tid('mail-ingest')}>
            {text.ingested(data.ingest.messages)}
            {data.ingest.latestStoredAt ? `（最後の取り込み ${fmtDate(data.ingest.latestStoredAt)}）` : '（まだ取り込みはありません）'}
          </p>
          <div className="filters">
            <label>
              {text.pick}
              <select value={selected?.id ?? ''} onChange={(e) => setMailboxId(e.target.value)}>
                {data.mailboxes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{m.address}）編集 {count(m.id, 'edit')} 人{data.sendable?.includes(m.id) ? `・送信 ${count(m.id, 'send')} 人` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              名前で絞り込み
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
          </div>
          {data.sendable === null ? (
            <p className="hint">{text.noSend}</p>
          ) : (
            !sendable && selected && <p className="hint">{text.cannotSend(selected.name)}</p>
          )}
          {message && (
            <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'} data-testid={tid('mail-access-message')}>
              {message.text}
            </p>
          )}
          {departments.length > 0 && (
            <section className="grant-section" aria-labelledby={tid('grant-departments-title')}>
              <h4 id={tid('grant-departments-title')}>部局ごと</h4>
              <ul className="rows grant-list" data-testid={tid('grant-departments')}>
                {departments.map((d) => {
                  const t = { department: d };
                  const label = `${d}（部局）`;
                  return (
                    <li key={d} className="grant-row">
                      <span className="grant-person">
                        <span className="row-main">{d}</span>
                      </span>
                      <label className="checkbox">
                        <input type="checkbox" checked={shown(t, 'edit', deptHas(d, 'edit'))} disabled={busy(t, 'edit')} onChange={(e) => void toggle(t, 'edit', e.target.checked, label)} aria-label={`${d} の編集権限`} />
                        編集
                      </label>
                      {(sendable || deptHas(d, 'send')) && (
                        <label className="checkbox">
                          <input type="checkbox" checked={shown(t, 'send', deptHas(d, 'send'))} disabled={busy(t, 'send')} onChange={(e) => void toggle(t, 'send', e.target.checked, label)} aria-label={`${d} の送信権限`} />
                          送信
                        </label>
                      )}
                      {rowFailed(t)}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <section className="grant-section" aria-labelledby={tid('grant-people-title')}>
            <h4 id={tid('grant-people-title')}>委員ごと</h4>
            {data.people.length === 0 ? (
              <p className="empty">登録済みのアカウントがありません。</p>
            ) : (
              <ul className="rows grant-list" data-testid={tid('grant-people')}>
                {people.map((p) => {
                  const t = { userId: p.id };
                  const theirs = departmentsOfLabel(p.roleLabel);
                  const viaDept = (kind: Kind) => theirs.some((d) => deptHas(d, kind));
                  const name = `${p.displayName} さん`;
                  const box = (kind: Kind, own: boolean) => {
                    const via = viaDept(kind) && !own;
                    return (
                      <label className="checkbox" key={kind} title={via ? '部局に付けた権限で持っています（外すときは部局ごとの欄で）' : undefined}>
                        <input
                          type="checkbox"
                          checked={shown(t, kind, own) || via}
                          disabled={busy(t, kind) || via}
                          onChange={(e) => void toggle(t, kind, e.target.checked, name)}
                          aria-label={`${p.displayName} さんの${kind === 'edit' ? '編集' : '送信'}権限`}
                          data-testid={kind === 'send' ? tid('grant-send') : undefined}
                        />
                        {kind === 'edit' ? '編集' : '送信'}
                        {via && <span className="grant-via">部局</span>}
                      </label>
                    );
                  };
                  const ownEdit = has(data.grants, p.id);
                  const ownSend = has(data.sendGrants, p.id);
                  return (
                    <li key={p.id} className="grant-row">
                      <span className="grant-person">
                        <span className="row-main">{p.displayName}</span>
                        <span className="row-sub">{p.roleLabel}</span>
                      </span>
                      {box('edit', ownEdit)}
                      {(sendable || ownSend || viaDept('send')) && box('send', ownSend)}
                      {rowFailed(t)}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
