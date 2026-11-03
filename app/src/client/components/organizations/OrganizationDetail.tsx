import { useEffect, useState, type FormEvent } from 'react';
import type { ContactListResponse } from '../../../shared/contacts';
import { defaultStatus, ORG_KIND_LABELS, ORG_KINDS, type OrgDetailResponse, type OrgHistoryAction, type OrgInput, type OrgKind, type OrgMeta, type OrgView } from '../../../shared/organizations';
import { api, ApiFailure, fmtDate, toFailure } from '../../api';

// The organization on the right of the list: its facts, the status (changed at once where the kind has stages), the
// history (with 戻す), the mail of its contact, and the form to add or change it. Errors from the server are shown next
// to the field they are about (or at the top). A version conflict keeps what was typed and loads the latest version.

const THIS_YEAR = new Date().getFullYear();
const ACTION_LABELS: Record<OrgHistoryAction, string> = { created: '登録', updated: '変更', deleted: '削除', imported: '取り込み', reverted: '元に戻す', mail_sent: '一斉送信' };

type Thread = { threadId: string; mailboxId: string; mailboxName: string; subject: string; latestReceivedAt: string; senders: string[] };

function failure(err: unknown): { message: string; field: string | null; reauth: boolean; conflict: boolean } {
  const f = toFailure(err);
  const body = f.body as (ApiFailure['body'] & { details?: { field?: unknown } }) | null;
  const field = body?.details && typeof body.details === 'object' && typeof body.details.field === 'string' ? body.details.field : null;
  return { message: f.message, field, reauth: body?.error === 'reauth_required', conflict: body?.error === 'conflict' };
}

/** The organization as the server takes it back: the same fields as the form (the version is sent apart). */
function inputOf(org: OrgView, status: string = org.status): OrgInput {
  return {
    kind: org.kind,
    fiscalYear: org.fiscalYear,
    name: org.name,
    department: org.department,
    ownerId: org.ownerId,
    contactId: org.contactId,
    status,
    amountYen: org.amountYen,
    content: org.content,
    nextAction: org.nextAction,
    nextDue: org.nextDue,
    notes: org.notes,
  };
}

export function OrganizationDetail({
  meta,
  id,
  onChanged,
  onClose,
  onDeleted,
}: {
  meta: OrgMeta;
  /** The organization shown, or null for a new one (the form only). */
  id: string | null;
  onChanged: (id: string) => void;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [detail, setDetail] = useState<OrgDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [threads, setThreads] = useState<{ address: string | null; threads: Thread[] } | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);

  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController();
    api<OrgDetailResponse>('GET', `/api/organizations/${encodeURIComponent(id)}`, undefined, controller.signal)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(failure(err).message);
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  if (id === null) {
    return (
      <OrganizationForm
        meta={meta}
        initial={null}
        onSaved={(d) => onChanged(d.org.id)}
        onCancel={onClose}
      />
    );
  }

  if (error) {
    return (
      <div className="status error" role="alert">
        団体を読めませんでした（{error}）。
        <button type="button" className="secondary" onClick={() => setReloadKey((n) => n + 1)}>
          読み直す
        </button>
      </div>
    );
  }
  if (!detail) return <p className="status loading" role="status">読み込み中…</p>;

  const org = detail.org;
  const stages = meta.stages[org.kind] ?? null;

  if (editing) {
    return (
      <OrganizationForm
        meta={meta}
        initial={org}
        onSaved={(d) => {
          setDetail(d);
          setEditing(false);
          onChanged(d.org.id);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const changeStatus = async (next: string) => {
    if (busy || next === org.status) return;
    setBusy(true);
    setStatusError(null);
    setNotice(null);
    try {
      const saved = await api<OrgDetailResponse>('PUT', `/api/organizations/${encodeURIComponent(org.id)}`, { expectedVersion: org.version, organization: inputOf(org, next) });
      setDetail(saved);
      setNotice(`状態を「${next}」にしました。`);
      onChanged(org.id);
    } catch (err) {
      const f = failure(err);
      setStatusError(f.conflict ? `${f.message} 「編集する」から開き、「最新を読み込む」で最新の版を読めます。` : `状態を変えられませんでした（${f.message}）。`);
    } finally {
      setBusy(false);
    }
  };

  const revert = async (historyId: number) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await api<OrgDetailResponse>('POST', `/api/organizations/${encodeURIComponent(org.id)}/revert`, { expectedVersion: org.version, historyId });
      setDetail(next);
      setNotice('その時点の内容に戻しました。');
      onChanged(org.id);
    } catch (err) {
      setNotice(`戻せませんでした（${failure(err).message}）。読み直してから、もう一度試してください。`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api<void>('DELETE', `/api/organizations/${encodeURIComponent(org.id)}?expectedVersion=${org.version}`);
      onDeleted?.();
    } catch (err) {
      setNotice(`削除できませんでした（${failure(err).message}）。`);
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const loadThreads = async () => {
    setThreadError(null);
    try {
      setThreads(await api<{ address: string | null; threads: Thread[] }>('GET', `/api/organizations/${encodeURIComponent(org.id)}/mail`));
    } catch (err) {
      const f = failure(err);
      setThreadError(f.reauth ? 'メールを開くには、メールの画面でパスワードを入れ直してください。' : f.message);
    }
  };

  return (
    <div className="orgs-form">
      <div className="pane-head">
        <div className="pane-title">
          <h2>{org.name}</h2>
          <span className="orgs-kind">{ORG_KIND_LABELS[org.kind]}</span>
        </div>
        <div className="actions">
          <button type="button" onClick={() => setEditing(true)}>
            編集する
          </button>
        </div>
      </div>
      {notice && (
        <p className="status info" role="status">
          {notice}
        </p>
      )}

      {stages && (
        <div className="orgs-status-change">
          <label>
            状態を変える（選ぶとすぐ保存します）
            <select value={org.status} disabled={busy} onChange={(e) => void changeStatus(e.target.value)} data-testid="org-status-select">
              {!stages.includes(org.status) && <option value={org.status}>{org.status}</option>}
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {statusError && (
            <p className="status error" role="alert">
              {statusError}
            </p>
          )}
        </div>
      )}

      <dl className="orgs-facts">
        <dt>年度</dt>
        <dd>{org.fiscalYear}年度</dd>
        <dt>状態</dt>
        <dd>{org.status}</dd>
        <dt>金額</dt>
        <dd>{org.amountYen === null ? '未定' : `${org.amountYen.toLocaleString('ja-JP')}円`}</dd>
        <dt>協賛の内容</dt>
        <dd>{org.content || '—'}</dd>
        <dt>次の対応</dt>
        <dd>{org.nextAction || '—'}</dd>
        <dt>期限</dt>
        <dd>{org.nextDue ?? '—'}</dd>
        <dt>委員会側の部局</dt>
        <dd>{org.department || '—'}</dd>
        <dt>委員会側の担当</dt>
        <dd>{org.ownerName ?? '—'}</dd>
        <dt>相手の担当者</dt>
        <dd>
          {org.contactId ? (
            <>
              {/* Opens the contact in the people's section of the same tab (the browser's Back returns here). */}
              <a href={`#/contacts?c=${encodeURIComponent(org.contactId)}`}>{org.contactName ?? '（名前なし）'}</a>
              {org.contactEmail && <> · {org.contactEmail}</>}
            </>
          ) : (
            '連絡先と結んでいません'
          )}
        </dd>
        <dt>メモ</dt>
        <dd style={{ whiteSpace: 'pre-wrap' }}>{org.notes || '—'}</dd>
        <dt>更新</dt>
        <dd>
          {fmtDate(org.updatedAt)} · {org.updatedByName}
        </dd>
      </dl>

      <section aria-labelledby="org-mail-title">
        <h3 id="org-mail-title">関係するメール</h3>
        {!meta.mail.readable ? (
          <p className="hint">メールを読む権限がないため、ここには出ません（メールの画面で読める人が見られます）。</p>
        ) : org.contactEmail ? (
          threads ? (
            threads.threads.length === 0 ? (
              <p className="hint">{threads.address} のメールは見つかりませんでした（先頭 10 件まで、あなたが読めるメールの中で探しています）。</p>
            ) : (
              <ul className="orgs-mail-list">
                {threads.threads.map((t) => (
                  <li key={t.threadId}>
                    <a href={`#/mailbox/${encodeURIComponent(t.mailboxId)}?thread=${encodeURIComponent(t.threadId)}`}>{t.subject || '（件名なし）'}</a>
                    <span className="hint"> · {t.mailboxName} · {fmtDate(t.latestReceivedAt)}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <button type="button" className="secondary" onClick={() => void loadThreads()}>
              {org.contactEmail} のメールを探す
            </button>
          )
        ) : (
          <p className="hint">相手の担当者（連絡先）を結ぶと、そのアドレスのメールがここに出ます。</p>
        )}
        {threadError && (
          <p className="status error" role="alert">
            {threadError}
          </p>
        )}
      </section>

      <details className="history">
        <summary>変更の履歴（{detail.history.length} 件）</summary>
        <ul>
          {detail.history.map((h) => (
            <li key={h.id}>
              <span>
                {fmtDate(h.at)} · {h.actorName} · {ACTION_LABELS[h.action]}
              </span>
              {h.changed.length > 0 && <span className="history-meta">{h.changed.join('・')} を変えました</span>}
              {h.mail && (
                <span className="history-meta">
                  「{h.mail.subject}」を {h.mail.sent} 通送りました
                </span>
              )}
              {h.canRevert && (
                <span>
                  <button type="button" className="link-button" disabled={busy} onClick={() => void revert(h.id)}>
                    この時点の内容に戻す
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </details>

      {detail.canAdminister &&
        (confirmDelete ? (
          <div className="status warning" role="group" aria-label="団体の削除の確認">
            <span>この団体を削除します。削除すると戻せません（履歴の記録は残ります）。</span>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              削除する
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>
              やめる
            </button>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirmDelete(true)}>
            この団体を削除
          </button>
        ))}
    </div>
  );
}

// ---- the form ----

interface Draft {
  kind: OrgKind;
  fiscalYear: string;
  name: string;
  department: string;
  ownerId: string;
  contact: { id: string; name: string; email: string } | null;
  status: string;
  amount: string;
  content: string;
  nextAction: string;
  nextDue: string;
  notes: string;
}

function draftOf(meta: OrgMeta, org: OrgView | null): Draft {
  if (org) {
    return {
      kind: org.kind,
      fiscalYear: String(org.fiscalYear),
      name: org.name,
      department: org.department,
      ownerId: org.ownerId ?? '',
      contact: org.contactId ? { id: org.contactId, name: org.contactName ?? org.contactEmail ?? '', email: org.contactEmail ?? '' } : null,
      status: org.status,
      amount: org.amountYen === null ? '' : String(org.amountYen),
      content: org.content,
      nextAction: org.nextAction,
      nextDue: org.nextDue ?? '',
      notes: org.notes,
    };
  }
  return {
    kind: 'sponsor',
    fiscalYear: String(THIS_YEAR),
    name: '',
    department: '',
    ownerId: '',
    contact: null,
    status: meta.stages.sponsor?.[0] ?? defaultStatus('sponsor'),
    amount: '',
    content: '',
    nextAction: '',
    nextDue: '',
    notes: '',
  };
}

function OrganizationForm({ meta, initial, onSaved, onCancel }: { meta: OrgMeta; initial: OrgView | null; onSaved: (d: OrgDetailResponse) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(meta, initial));
  // The version the save is checked against: a conflict loads the latest one and keeps the typed text.
  const [version, setVersion] = useState(initial?.version ?? 0);
  const [contactQuery, setContactQuery] = useState('');
  const [contactHits, setContactHits] = useState<ContactListResponse['items']>([]);
  const [contactState, setContactState] = useState<'idle' | 'searching' | 'done'>('idle');
  const [contactError, setContactError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});

  const stages = meta.stages[draft.kind] ?? null;

  // Contacts to link: the search follows the typing (the contacts list of the 連絡先 tab, the same rule).
  useEffect(() => {
    const term = contactQuery.trim();
    if (!term) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<ContactListResponse>('GET', `/api/contacts?q=${encodeURIComponent(term)}&pageSize=8`, undefined, controller.signal)
        .then((r) => {
          setContactHits(r.items);
          setContactError(null);
          setContactState('done');
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            setContactError(failure(err).message);
            setContactState('done');
          }
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [contactQuery]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const changeKind = (next: OrgKind) => {
    setDraft((d) => {
      const nextStages = meta.stages[next] ?? null;
      const oldStages = meta.stages[d.kind] ?? [];
      // A stage of the old kind (set by the kind, not by the person) gives way to the new kind's start; other text stays.
      const status = nextStages
        ? nextStages.includes(d.status)
          ? d.status
          : nextStages[0] ?? d.status
        : oldStages.includes(d.status)
          ? defaultStatus(next)
          : d.status;
      return { ...d, kind: next, status };
    });
  };

  /** Loads the latest version: what was typed stays, and the save goes against the new version. */
  const loadLatest = async () => {
    if (!initial) return;
    try {
      const latest = await api<OrgDetailResponse>('GET', `/api/organizations/${encodeURIComponent(initial.id)}`);
      setVersion(latest.org.version);
      setConflict(false);
      setFormError('最新の版を読み込みました。入力は残してあります。保存すると、今の入力で上書きします（ほかの人の変更は、今の入力と同じ項目なら消えます）。');
    } catch (err) {
      setFormError(`最新の内容を読み込めませんでした（${failure(err).message}）。`);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const local: Partial<Record<string, string>> = {};
    if (!draft.name.trim()) local.name = '団体名を入れてください。';
    if (!/^\d{4}$/.test(draft.fiscalYear.trim())) local.fiscalYear = '年度は西暦の数字で入れてください（例: 2026）。';
    const amount = draft.amount.replace(/[,，\s]/g, '');
    if (amount !== '' && !/^\d+$/.test(amount)) local.amountYen = '金額は数字で入れてください（例: 300000）。';
    if (draft.nextDue !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.nextDue)) local.nextDue = '期限は 2026-11-30 の形で入れてください。';
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;
    const organization = {
      kind: draft.kind,
      fiscalYear: Number(draft.fiscalYear),
      name: draft.name,
      department: draft.department,
      ownerId: draft.ownerId || null,
      contactId: draft.contact?.id ?? null,
      status: draft.status,
      amountYen: amount === '' ? null : Number(amount),
      content: draft.content,
      nextAction: draft.nextAction,
      nextDue: draft.nextDue === '' ? null : draft.nextDue,
      notes: draft.notes,
    };
    setSaving(true);
    setFormError(null);
    setConflict(false);
    try {
      const saved = initial
        ? await api<OrgDetailResponse>('PUT', `/api/organizations/${encodeURIComponent(initial.id)}`, { expectedVersion: version, organization })
        : await api<OrgDetailResponse>('POST', '/api/organizations', organization);
      onSaved(saved);
    } catch (err) {
      const f = failure(err);
      if (f.field) setFieldErrors({ [f.field]: f.message });
      else setFormError(f.message);
      setConflict(f.conflict);
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (key: string) => (fieldErrors[key] ? <p className="field-error" role="alert">{fieldErrors[key]}</p> : null);

  return (
    <form className="orgs-form" onSubmit={(e) => void submit(e)} aria-label={initial ? '団体を編集する' : '団体を追加する'} noValidate>
      <div className="pane-head">
        <div className="pane-title">
          <h2>{initial ? '団体を編集' : '団体を追加'}</h2>
        </div>
      </div>
      {formError && (
        <p className="status error" role="alert">
          {formError}
        </p>
      )}
      {conflict && initial && (
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void loadLatest()}>
            最新を読み込む（入力は残す）
          </button>
        </div>
      )}
      <div className="form-grid">
        <label>
          種別
          <select value={draft.kind} onChange={(e) => changeKind(e.target.value as OrgKind)}>
            {ORG_KINDS.map((k) => (
              <option key={k} value={k}>
                {ORG_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          年度
          <input inputMode="numeric" value={draft.fiscalYear} onChange={(e) => set('fiscalYear', e.target.value)} maxLength={4} aria-invalid={fieldErrors.fiscalYear ? true : undefined} />
          {fieldError('fiscalYear')}
        </label>
        <label className="field-wide">
          団体名（必須）
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={100} autoComplete="off" aria-invalid={fieldErrors.name ? true : undefined} />
          {fieldError('name')}
        </label>
        <label>
          状態
          {stages ? (
            <select value={draft.status} onChange={(e) => set('status', e.target.value)}>
              {!stages.includes(draft.status) && <option value={draft.status}>{draft.status}</option>}
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <input value={draft.status} onChange={(e) => set('status', e.target.value)} maxLength={20} />
          )}
          {fieldError('status')}
        </label>
        <label>
          金額（円）
          <input inputMode="numeric" value={draft.amount} onChange={(e) => set('amount', e.target.value)} placeholder="例: 300000" aria-invalid={fieldErrors.amountYen ? true : undefined} />
          {fieldError('amountYen')}
        </label>
        <label>
          委員会側の部局
          <input value={draft.department} onChange={(e) => set('department', e.target.value)} maxLength={40} />
        </label>
        <label>
          委員会側の担当
          <select value={draft.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
            <option value="">未定</option>
            {meta.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {fieldError('ownerId')}
        </label>
        <label>
          期限
          <input type="date" value={draft.nextDue} onChange={(e) => set('nextDue', e.target.value)} aria-invalid={fieldErrors.nextDue ? true : undefined} />
          {fieldError('nextDue')}
        </label>
        <label className="field-wide">
          次の対応
          <input value={draft.nextAction} onChange={(e) => set('nextAction', e.target.value)} maxLength={200} />
        </label>
        <label className="field-wide">
          協賛の内容（広告の大きさなど）
          <textarea value={draft.content} onChange={(e) => set('content', e.target.value)} rows={2} maxLength={500} />
        </label>
        <label className="field-wide">
          メモ
          <textarea value={draft.notes} onChange={(e) => set('notes', e.target.value)} rows={3} maxLength={2000} />
        </label>
      </div>

      <fieldset className="field-wide" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>相手の担当者（連絡先と結ぶ）</legend>
        {draft.contact ? (
          <div className="orgs-chosen">
            <span>
              {draft.contact.name || '（名前なし）'}
              {draft.contact.email && <> · {draft.contact.email}</>}
            </span>
            <button type="button" className="secondary" onClick={() => set('contact', null)}>
              結びを外す
            </button>
          </div>
        ) : (
          <>
            <label>
              <span className="hint">連絡先を名前・組織・アドレスで探す</span>
              <input
                value={contactQuery}
                onChange={(e) => {
                  setContactQuery(e.target.value);
                  setContactState(e.target.value.trim() ? 'searching' : 'idle');
                  if (!e.target.value.trim()) setContactHits([]);
                }}
                maxLength={100}
                autoComplete="off"
              />
            </label>
            {contactError && (
              <p className="status error" role="alert">
                連絡先を探せませんでした（{contactError}）。
              </p>
            )}
            {contactState === 'searching' && <p className="hint" role="status">探しています…</p>}
            {contactState === 'done' && contactHits.length === 0 && !contactError && (
              <p className="hint" role="status">
                見つかりません。連絡先に先に登録してください（連絡先タブ）。
              </p>
            )}
            {contactHits.length > 0 && (
              <ul className="orgs-contact-results" aria-label="連絡先の候補">
                {contactHits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        set('contact', { id: c.id, name: c.name || c.organization, email: c.email ?? '' });
                        setContactQuery('');
                        setContactHits([]);
                        setContactState('idle');
                      }}
                    >
                      {c.name || c.organization}
                      {c.email && <span className="hint"> · {c.email}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">連絡先を結ぶと、一斉送信の宛先はその連絡先のメールアドレスになります。</p>
          </>
        )}
        {fieldError('contactId')}
      </fieldset>

      <div className="actions">
        <button type="submit" disabled={saving}>
          {saving ? '保存しています…' : initial ? '保存する' : '団体を追加'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          やめる
        </button>
      </div>
    </form>
  );
}
