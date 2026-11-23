import { useCallback, useState } from 'react';
import { departmentsOfLabel, type MailAccessResponse, type MailApprovalMark, type MailApprovalMarkSkip, type MailApprovalMarksRequest, type MailApprovalMarksResponse } from '../../shared/mailbox';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { LoadStatus } from './LoadStatus';

type Kind = 'edit' | 'send' | 'review' | 'approval';
const KIND_LABELS: Record<Kind, string> = { edit: '編集', send: '送信', review: '校閲', approval: '承認必須' };
/** What a tick is called in the messages: 承認必須 is a mark on a person, not a grant. */
const KIND_NAMES: Record<Kind, string> = { edit: '編集権限', send: '送信権限', review: '校閲権限', approval: '承認必須' };
type Target = { userId: string } | { department: string };

const keyOf = (t: Target, mailboxId: string, kind: Kind) => `${'userId' in t ? `u:${t.userId}` : `d:${t.department}`}|${mailboxId}|${kind}`;

/** Why a mark was not set, as the result line says it (2026-11-23). */
const SKIP_TEXT: Record<MailApprovalMarkSkip, (n: number) => string> = {
  cannot_send: (n) => `送信権限の無い ${n} 件（もともと承認を通ります）`,
  no_reviewer: (n) => `校閲者がいない（本人だけの）受信箱の ${n} 件（付けるとその受信箱から送れなくなるので、先に校閲を付けてください）`,
  person: (n) => `アカウントが見つからない ${n} 件`,
  mailbox: (n) => `送信できない受信箱の ${n} 件`,
};

type BulkResult = { text: string; error: boolean; undo: MailApprovalMarksRequest | null };

/**
 * Grants of the committee mailbox (access administrators), per mailbox. Everyone in the committee reads every
 * mailbox and changes assignees, labels and status. An edit grant allows notes; a send grant allows sending with
 * that mailbox's address as From (only for the addresses the server can send from). A grant goes to a person or
 * to a department (everyone in it, by their Discord roles, now and later).
 * A tick shows at once and is saved in the background; only that tick waits for the server (2026-10-26: the
 * whole list waited for the save and a reload before, and seemed not to react).
 * The official LINE account's grants (2026-10-28) use the same panel and rules: `variant="line"`.
 * Approval before sending (2026-11-11, mail only): 校閲 lets a person or a department approve, change and return the
 * mail that waits in that mailbox; 承認必須 marks a person whose mail from it always waits, even with a send grant.
 * 承認必須 for many people at once (2026-11-23): pick people in the list, then set or remove it in this mailbox or in
 * every mailbox the server sends from, in one save, with an undo of exactly what changed.
 */
const TEXT = {
  mail: {
    endpoint: '/api/mail/admin/access',
    title: 'メールの権限',
    intro: 'メールの閲覧・ラベル付け・担当者変更・対応状況の変更は委員全員ができます。ここで受信箱ごとに付けるのは、内部メモを追加する「編集」と、その受信箱のアドレスを差出人にしてアプリからメールを送る「送信」です。部局に付けると、その部局の委員全員（あとから入った人も）が持ちます。',
    approval:
      '「校閲」を付けた人は、その受信箱から送るメールの承認待ちを見て、承認して送信・直す・差し戻すができます（自分が書いたメールは承認できません）。校閲者が 1 人でもいる受信箱では、送信権限の無い委員も「承認を依頼する」でメールを出せるようになり、校閲者が承認すると送られます。送信権限のある人にも承認を通させたいとき（1 年生など）は、その人に「承認必須」を付けます。',
    what: '受信箱の権限',
    pick: '受信箱',
    ingested: (n: number) => `取り込み済み ${n} 通`,
    noSend: 'このサーバーでは、アプリからの送信は設定されていません。',
    cannotSend: (name: string) => `「${name}」のアドレスからは送信できない設定です（送信用アカウントに差出人として登録した受信箱だけ送信権限を付けられます）。`,
    prefix: '',
  },
  line: {
    endpoint: '/api/line/admin/access',
    title: '公式LINE の権限',
    intro: '公式LINE の閲覧・ラベル付け・担当者変更・対応状況の変更は委員全員ができます（臨時スタッフを除く）。ここで付けるのは、内部メモを追加する「編集」と、アプリから公式LINE で送る「送信」です。部局に付けると、その部局の委員全員（あとから入った人も）が持ちます。',
    approval: null,
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
  // 承認必須 for many people at once: whether the picking is open, who is picked, in which mailboxes, the last result.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [bulkScope, setBulkScope] = useState<'this' | 'all'>('this');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

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
  // The approval before sending exists on a mail server that answers with its grants (an older server does not).
  const approvalOn = text.approval !== null && !!data?.reviewGrants;
  const rowFailed = (t: Target) =>
    selected && failed && (Object.keys(KIND_LABELS) as Kind[]).some((k) => failed === keyOf(t, selected.id, k)) ? (
      <span className="grant-failed" role="alert">
        保存できませんでした
      </span>
    ) : null;
  const count = (id: string, kind: 'edit' | 'send' | 'review') => (kind === 'edit' ? data?.grants : kind === 'send' ? data?.sendGrants : data?.reviewGrants)?.filter((g) => g.mailboxId === id).length ?? 0;
  const needle = filter.normalize('NFKC').trim().toLowerCase();
  const people = (data?.people ?? []).filter((p) => !needle || `${p.displayName} ${p.roleLabel}`.normalize('NFKC').toLowerCase().includes(needle));
  const departments = data?.departments ?? [];
  const sendableBoxes = (data?.mailboxes ?? []).filter((m) => data?.sendable?.includes(m.id));
  const bulkOn = approvalOn && sendableBoxes.length > 0;
  const scope = sendable ? bulkScope : 'all';
  const allShownPicked = people.length > 0 && people.every((p) => picked.has(p.id));
  const hiddenPicked = [...picked].filter((id) => !people.some((p) => p.id === id)).length;

  function pick(ids: string[], on: boolean) {
    setPicked((now) => {
      const next = new Set(now);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function closeBulk() {
    setBulkOpen(false);
    setPicked(new Set());
    setBulkResult(null);
  }

  /** What one bulk save did, in words: how many people and mailboxes changed, and what was left alone. */
  function describe(req: MailApprovalMarksRequest, res: MailApprovalMarksResponse, undoing: boolean): BulkResult {
    const boxName = (id: string) => res.access.mailboxes.find((m) => m.id === id)?.name ?? id;
    const changedPeople = new Set(res.changed.map((c) => c.userId)).size;
    const changedBoxes = [...new Set(res.changed.map((c) => c.mailboxId))].map(boxName).join('・');
    const parts: string[] = [];
    if (undoing) parts.push(res.changed.length > 0 ? `元に戻しました（${res.changed.length} 件）。` : '戻すものはありませんでした。');
    else if (res.changed.length > 0) parts.push(`${changedPeople} 人の承認必須を${req.approval ? '付けました' : '外しました'}（${changedBoxes}・計 ${res.changed.length} 件）。`);
    else parts.push(req.approval ? '新しく付けたものはありません。' : '外すものはありませんでした（選んだ人には付いていません）。');
    const same = req.items.length - res.changed.length - res.skipped.length;
    if (!undoing && req.approval && same > 0 && res.changed.length > 0) parts.push(`すでに付いていた ${same} 件はそのままです。`);
    const counts = new Map<MailApprovalMarkSkip, number>();
    for (const s of res.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    if (counts.size > 0) parts.push(`付けなかったもの：${[...counts].map(([reason, n]) => SKIP_TEXT[reason](n)).join('、')}。`);
    // The undo puts back exactly what changed: marks just set are removed, marks just removed are set again as they were.
    const undo = !undoing && res.changed.length > 0 ? { items: res.changed, approval: !req.approval, ...(req.approval ? {} : { restore: true }) } : null;
    return { text: parts.join(''), error: false, undo };
  }

  async function saveBulk(req: MailApprovalMarksRequest, undoing: boolean) {
    setBulkBusy(true);
    setMessage(null);
    setFailed(null);
    try {
      const res = await api<MailApprovalMarksResponse>('PUT', '/api/mail/admin/access/approval', req);
      setSaved(res.access);
      setBulkResult(describe(req, res, undoing));
    } catch (err) {
      setBulkResult({ text: `保存できませんでした：${toFailure(err).message}`, error: true, undo: null });
    } finally {
      setBulkBusy(false);
    }
  }

  function applyBulk(on: boolean) {
    if (!selected) return;
    const boxes = scope === 'this' ? [selected.id] : sendableBoxes.map((m) => m.id);
    const items: MailApprovalMark[] = [...picked].flatMap((userId) => boxes.map((mailboxId) => ({ userId, mailboxId })));
    if (items.length > 0) void saveBulk({ items, approval: on }, false);
  }

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
      setMessage({ text: `${name}の「${box.name}」の${KIND_NAMES[kind]}を${on ? '付けました' : '外しました'}。`, error: false });
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
      {approvalOn && <p className="hint">{text.approval}</p>}
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
                    {m.name}（{m.address}）編集 {count(m.id, 'edit')} 人{data.sendable?.includes(m.id) ? `・送信 ${count(m.id, 'send')} 人${approvalOn ? `・校閲 ${count(m.id, 'review')} 人` : ''}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              名前・部局で絞り込み
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
                      {approvalOn && (sendable || deptHas(d, 'review')) && (
                        <label className="checkbox">
                          <input type="checkbox" checked={shown(t, 'review', deptHas(d, 'review'))} disabled={busy(t, 'review')} onChange={(e) => void toggle(t, 'review', e.target.checked, label)} aria-label={`${d} の校閲権限`} data-testid="grant-department-review" />
                          校閲
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
            {bulkOn && data.people.length > 0 && !bulkOpen && (
              <button type="button" className="secondary grant-bulk-open" onClick={() => setBulkOpen(true)}>
                承認必須をまとめて付ける・外す
              </button>
            )}
            {bulkOn && bulkOpen && selected && (
              <div className="grant-bulk" role="group" aria-label="承認必須をまとめて付ける・外す" data-testid="approval-bulk">
                <p className="hint">委員の行の左で人を選び、承認必須をまとめて付けたり外したりします。送信権限の無い人と、校閲者のいない受信箱には付けません。</p>
                <label className="grant-bulk-check">
                  <input type="checkbox" checked={allShownPicked} disabled={people.length === 0} onChange={(e) => pick(people.map((p) => p.id), e.target.checked)} />
                  表示中の {people.length} 人を選ぶ
                </label>
                <fieldset className="grant-bulk-scope">
                  <legend>受信箱</legend>
                  <label>
                    <input type="radio" name={tid('approval-bulk-scope')} checked={scope === 'this'} disabled={!sendable} onChange={() => setBulkScope('this')} />
                    この受信箱（{selected.name}）だけ{!sendable && '：送信できない受信箱です'}
                  </label>
                  <label>
                    <input type="radio" name={tid('approval-bulk-scope')} checked={scope === 'all'} onChange={() => setBulkScope('all')} />
                    送信できる受信箱すべて（{sendableBoxes.length} 個）
                  </label>
                </fieldset>
                <p className="grant-bulk-count" aria-live="polite">
                  {picked.size === 0 ? 'まだ誰も選んでいません。' : `${picked.size} 人を選んでいます${hiddenPicked > 0 ? `（うち ${hiddenPicked} 人は絞り込みで隠れています）` : ''}。`}
                </p>
                <div className="actions">
                  <button type="button" disabled={picked.size === 0 || bulkBusy} onClick={() => applyBulk(true)}>
                    承認必須を付ける
                  </button>
                  <button type="button" className="secondary" disabled={picked.size === 0 || bulkBusy} onClick={() => applyBulk(false)}>
                    承認必須を外す
                  </button>
                  <button type="button" className="secondary" disabled={bulkBusy} onClick={closeBulk}>
                    閉じる
                  </button>
                </div>
                {bulkBusy && (
                  <p className="status loading" role="status">
                    保存しています…
                  </p>
                )}
                {bulkResult && !bulkBusy && (
                  <div className={`status ${bulkResult.error ? 'error' : 'ok'} grant-bulk-result`} role={bulkResult.error ? 'alert' : 'status'} data-testid="approval-bulk-result">
                    <span>{bulkResult.text}</span>
                    {bulkResult.undo && (
                      <button type="button" className="secondary" onClick={() => void saveBulk(bulkResult.undo!, true)}>
                        元に戻す
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {data.people.length === 0 ? (
              <p className="empty">登録済みのアカウントがありません。</p>
            ) : (
              <ul className="rows grant-list" data-testid={tid('grant-people')}>
                {people.map((p) => {
                  const t = { userId: p.id };
                  const theirs = departmentsOfLabel(p.roleLabel);
                  const viaDept = (kind: Kind) => kind !== 'approval' && theirs.some((d) => deptHas(d, kind));
                  const name = `${p.displayName} さん`;
                  const box = (kind: Kind, own: boolean) => {
                    const via = viaDept(kind) && !own;
                    return (
                      <label className="checkbox" key={kind} title={via ? '部局に付けた権限で持っています（外すときは部局ごとの欄で）' : undefined}>
                        <input
                          type="checkbox"
                          checked={shown(t, kind, own) || via}
                          disabled={busy(t, kind) || via || (kind === 'approval' && bulkBusy)}
                          onChange={(e) => void toggle(t, kind, e.target.checked, name)}
                          aria-label={`${p.displayName} さんの${KIND_NAMES[kind]}`}
                          data-testid={kind === 'edit' ? undefined : tid(`grant-${kind}`)}
                        />
                        {KIND_LABELS[kind]}
                        {via && <span className="grant-via">部局</span>}
                      </label>
                    );
                  };
                  const ownEdit = has(data.grants, p.id);
                  const ownSend = has(data.sendGrants, p.id);
                  const ownReview = has(data.reviewGrants, p.id);
                  const marked = has(data.approvalRequired, p.id);
                  // 承認必須 changes something only for a person who could send at once; a mark already set can always be removed.
                  const canSendNow = ownSend || viaDept('send');
                  return (
                    <li key={p.id} className="grant-row">
                      {bulkOn && bulkOpen && (
                        <label className="grant-pick">
                          <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => pick([p.id], e.target.checked)} aria-label={`${p.displayName} さんを選ぶ`} />
                        </label>
                      )}
                      <span className="grant-person">
                        <span className="row-main">{p.displayName}</span>
                        <span className="row-sub">{p.roleLabel}</span>
                      </span>
                      {box('edit', ownEdit)}
                      {(sendable || ownSend || viaDept('send')) && box('send', ownSend)}
                      {approvalOn && (sendable || ownReview || viaDept('review')) && box('review', ownReview)}
                      {approvalOn && ((sendable && canSendNow) || marked) && box('approval', marked)}
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
