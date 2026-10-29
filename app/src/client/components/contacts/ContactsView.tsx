import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CATEGORY_LABELS,
  CONTACT_CATEGORIES,
  CONTACT_LIMITS,
  ContactValidationError,
  FIELD_LABELS,
  contactTitle,
  recipientText,
  splitTags,
  validateContact,
  type ContactAddressMatch,
  type ContactCategory,
  type ContactDetailResponse,
  type ContactEmail,
  type ContactHistoryAction,
  type ContactImportResponse,
  type ContactInput,
  type ContactListResponse,
  type ContactPhone,
} from '../../../shared/contacts';
import { isMailAddress } from '../../../shared/mailbox';
import { api, ApiFailure, fmtDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';

// Committee contacts (2026-10-26): a list to search on the left, the opened contact on the right (one column on a
// phone). Every committee member adds and edits; access administrators also delete, import and export.

export interface ContactsRoute {
  contactId: string | null;
  creating: boolean;
  importing: boolean;
}

/** What the mail screen hands over when a sender is added ("連絡先に追加"). */
export interface ContactPrefill {
  name: string;
  email: string;
}

// Rows per page, chosen by the reader; すべて is the server's upper limit.
// The choice is remembered on this device only, like the mail list's; storage may be blocked (private windows).
const PAGE_SIZE_CHOICES = [20, 50, 100, CONTACT_LIMITS.pageSizeMax] as const;
const PAGE_SIZE_KEY = 'iyakusai-contacts-page-size';
const DEFAULT_PAGE_SIZE = 50;

function savedPageSize(): number {
  try {
    const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if ((PAGE_SIZE_CHOICES as readonly number[]).includes(saved)) return saved;
  } catch {
    // fall through to the default
  }
  return DEFAULT_PAGE_SIZE;
}

const ACTIONS: Record<ContactHistoryAction, string> = { created: '登録', updated: '変更', deleted: '削除', imported: '取り込み' };

export function ContactsView({
  route,
  initialQuery,
  prefill,
  onPrefillUsed,
  canWriteMail,
  onWriteMail,
  onNavigate,
  refresh,
}: {
  route: ContactsRoute;
  initialQuery: string;
  prefill: ContactPrefill | null;
  onPrefillUsed: () => void;
  canWriteMail: boolean;
  /** Opens new mail in the mailbox with this recipient. */
  onWriteMail: (recipient: string) => void;
  onNavigate: (route: ContactsRoute) => void;
  refresh: number;
}) {
  const [typed, setTyped] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery.trim());
  const [category, setCategory] = useState<ContactCategory | 'all'>('all');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(savedPageSize);
  const [changes, setChanges] = useState(0);

  // The list follows the search box a moment after typing stops.
  useEffect(() => {
    const next = typed.trim();
    if (next === q) return;
    const timer = window.setTimeout(() => {
      setQ(next);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [typed, q]);

  const loadList = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      void changes;
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (q) p.set('q', q);
      if (category !== 'all') p.set('category', category);
      if (tag) p.set('tag', tag);
      return api<ContactListResponse>('GET', `/api/contacts?${p.toString()}`, undefined, signal);
    },
    [q, category, tag, page, pageSize, refresh, changes],
  );

  // Keeps the first row on screen in view: rows 51–100 at 50 per page become page 1 (rows 1–100) at 100.
  function changePageSize(next: number) {
    setPage(Math.floor(((page - 1) * pageSize) / next) + 1);
    setPageSize(next);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(next));
    } catch {
      // not remembered; this view still uses it
    }
  }
  const list = useLoader(loadList);
  const data = list.data;
  const filtered = !!q || category !== 'all' || !!tag;
  const saved = () => setChanges((n) => n + 1);
  const open = (contactId: string) => onNavigate({ contactId, creating: false, importing: false });
  const close = () => onNavigate({ contactId: null, creating: false, importing: false });

  const first = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <>
      <section className="list-pane contacts-list" aria-label="連絡先の一覧">
        <div className="pane-head">
          <div className="pane-title">
            <h1>連絡先</h1>
            <span className="pane-sub">相手先・出展団体・委員会の窓口・委員</span>
          </div>
          <button type="button" onClick={() => onNavigate({ contactId: null, creating: true, importing: false })} data-testid="contact-new">
            ＋ 連絡先を追加
          </button>
        </div>
        {data?.canAdminister && (
          <div className="contact-admin-links">
            <button type="button" className="secondary" onClick={() => onNavigate({ contactId: null, creating: false, importing: true })} data-testid="contact-import-open">
              取り込む
            </button>
            <a className="button secondary" href="/api/contacts/export.csv" data-testid="contact-export">
              CSV で書き出す
            </a>
            <span className="hint">権限管理者だけに出ています</span>
          </div>
        )}
        <div className="list-tools">
          <label htmlFor="contact-search" className="sr-only">
            連絡先を探す
          </label>
          <input id="contact-search" className="list-search" type="search" value={typed} placeholder="名前・会社・ふりがな・電話・メール・タグ" onChange={(e) => setTyped(e.target.value)} maxLength={CONTACT_LIMITS.query} data-testid="contact-search" />
          <div className="filter-chips" role="group" aria-label="種類">
            {(['all', ...CONTACT_CATEGORIES] as const).map((c) => (
              <button
                key={c}
                type="button"
                className="filter-chip"
                aria-pressed={category === c}
                onClick={() => {
                  setCategory(c);
                  setPage(1);
                }}
                data-testid={`contact-category-${c}`}
              >
                {c === 'all' ? 'すべて' : CATEGORY_LABELS[c]} <span className="option-count">{data?.counts[c] ?? ''}</span>
              </button>
            ))}
            {data && data.tags.length > 0 && (
              <>
                <span className="chip-divider" aria-hidden="true" />
                <label className="sr-only" htmlFor="contact-tag">
                  タグで絞る
                </label>
                <select
                  id="contact-tag"
                  className={`chip-select ${tag ? 'selected' : ''}`}
                  value={tag}
                  onChange={(e) => {
                    setTag(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">すべてのタグ</option>
                  {data.tags.map((t) => (
                    <option key={t.tag} value={t.tag}>
                      {t.tag}（{t.count}）
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
        <LoadStatus loader={list} what="連絡先" />
        {data && (
          <>
            <div className="list-bar">
              <p className="count" role="status" data-testid="contact-count">
                {data.total === 0 ? '0 件' : data.total <= data.pageSize ? `${data.total} 件` : `${data.total} 件中 ${first}〜${last} 件`}
              </p>
              <label className="page-size">
                表示件数
                <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))} data-testid="contact-page-size">
                  {PAGE_SIZE_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n === CONTACT_LIMITS.pageSizeMax ? 'すべて' : `${n} 件`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {data.items.length === 0 ? (
              <div className="list-empty">
                {filtered ? <p>条件に合う連絡先はありません。</p> : <p>まだ連絡先がありません。「＋ 連絡先を追加」から登録できます（権限管理者は既存の資料から取り込めます）。</p>}
              </div>
            ) : (
              <ul className="rows-list contact-rows">
                {data.items.map((c) => (
                  <li key={c.id} className={`row contact-row ${c.id === route.contactId ? 'selected' : ''}`}>
                    <button type="button" className="row-open" aria-current={c.id === route.contactId ? 'true' : undefined} onClick={() => open(c.id)} data-testid="contact-row">
                      <span className="row-line">
                        <span className="subject">{contactTitle(c)}</span>
                        <span className={`chip contact-category category-${c.category}`}>{CATEGORY_LABELS[c.category]}</span>
                      </span>
                      {(c.name && c.organization) || c.section ? (
                        <span className="row-meta">
                          {c.name && c.organization && <span>{c.organization}</span>}
                          {c.section && <span>{c.section}</span>}
                        </span>
                      ) : null}
                      {(c.phone || c.email) && (
                        <span className="row-meta">
                          {c.phone && <span>{c.phone.number}</span>}
                          {c.email && <span>{c.email}</span>}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {data.total > data.pageSize && (
              <div className="pager">
                <button type="button" className="secondary" disabled={data.page <= 1} onClick={() => setPage((p) => p - 1)}>
                  前へ
                </button>
                <span>
                  {data.page} / {Math.ceil(data.total / data.pageSize)} ページ
                </span>
                <button type="button" className="secondary" disabled={last >= data.total} onClick={() => setPage((p) => p + 1)} data-testid="contact-next-page">
                  次へ
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <section className="detail-pane" aria-label="連絡先の詳細">
        {(route.contactId || route.creating || route.importing) && (
          <button type="button" className="back-link" onClick={close}>
            ← 一覧に戻る
          </button>
        )}
        {route.importing ? (
          <ContactImport onImported={saved} />
        ) : route.creating ? (
          <ContactForm
            key={prefill ? `prefill-${prefill.email}` : 'new'}
            initial={prefill ? { ...EMPTY, name: prefill.name, emails: [{ label: '', address: prefill.email }], category: 'external' } : EMPTY}
            tags={data?.tags.map((t) => t.tag) ?? []}
            onSaved={(detail) => {
              onPrefillUsed();
              saved();
              open(detail.contact.id);
            }}
            onCancel={() => {
              onPrefillUsed();
              close();
            }}
            onOpenExisting={open}
          />
        ) : route.contactId ? (
          <ContactDetail key={route.contactId} id={route.contactId} refresh={refresh} tags={data?.tags.map((t) => t.tag) ?? []} canWriteMail={canWriteMail} onWriteMail={onWriteMail} onSaved={saved} onDeleted={() => { saved(); close(); }} onOpenExisting={open} />
        ) : (
          <div className="detail-placeholder">
            <h2>連絡先を選択</h2>
            <p>一覧から選ぶと、メール・電話・住所・メモがここに出ます。</p>
          </div>
        )}
      </section>
    </>
  );
}

const EMPTY: ContactInput = { category: 'external', organization: '', section: '', name: '', nameKana: '', emails: [], phones: [], postalCode: '', address: '', tags: [], notes: '' };

/** A tel: link target: the digits and a leading +, without an extension. */
const telHref = (n: string) => `tel:${n.replace(/(?:内線|ext\.?|#).*$/i, '').replace(/[^\d+]/g, '')}`;

function ContactDetail({
  id,
  refresh,
  tags,
  canWriteMail,
  onWriteMail,
  onSaved,
  onDeleted,
  onOpenExisting,
}: {
  id: string;
  refresh: number;
  tags: string[];
  canWriteMail: boolean;
  onWriteMail: (recipient: string) => void;
  onSaved: () => void;
  onDeleted: () => void;
  onOpenExisting: (id: string) => void;
}) {
  const [reload, setReload] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      void reload;
      return api<ContactDetailResponse>('GET', `/api/contacts/${encodeURIComponent(id)}`, undefined, signal);
    },
    [id, refresh, reload],
  );
  const detail = useLoader(load);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'conflict'; text: string } | null>(null);

  if (!detail.data) return <LoadStatus loader={detail} what="連絡先" />;
  const { contact: c, history, canAdminister } = detail.data;

  if (editing) {
    return (
      <ContactForm
        initial={c}
        existing={{ id: c.id, version: c.version }}
        tags={tags}
        onSaved={() => {
          setEditing(false);
          setMessage({ kind: 'ok', text: '保存しました。' });
          setReload((n) => n + 1);
          onSaved();
        }}
        onCancel={() => setEditing(false)}
        onOpenExisting={onOpenExisting}
      />
    );
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      await api('DELETE', `/api/contacts/${encodeURIComponent(c.id)}?expectedVersion=${c.version}`);
      onDeleted();
    } catch (err) {
      const f = toFailure(err);
      setMessage({ kind: f.status === 409 ? 'conflict' : 'error', text: f.message });
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage({ kind: 'ok', text: `${text} をコピーしました。` });
    } catch {
      setMessage({ kind: 'error', text: 'コピーできませんでした。選んでコピーしてください。' });
    }
  }

  const recipientName = c.name || c.organization;
  return (
    <article className="contact-detail" aria-labelledby="contact-title" data-testid="contact-detail">
      <div className="detail-head">
        <div className="contact-title-line">
          <h2 id="contact-title">{contactTitle(c)}</h2>
          <span className={`chip contact-category category-${c.category}`}>{CATEGORY_LABELS[c.category]}</span>
        </div>
        {(c.name && c.organization) || c.section ? (
          <p className="hint">{[c.name ? c.organization : '', c.section].filter(Boolean).join('　')}</p>
        ) : null}
        {c.nameKana && <p className="hint">{c.nameKana}</p>}
      </div>
      {message && (
        <p className={`status ${message.kind}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
          {message.text}
          {message.kind === 'conflict' && (
            <button type="button" className="secondary" onClick={() => { setMessage(null); setReload((n) => n + 1); }}>
              最新を読み込む
            </button>
          )}
        </p>
      )}
      <dl className="contact-fields">
        <dt>メール</dt>
        <dd>
          {c.emails.length === 0 ? (
            <span className="hint">なし</span>
          ) : (
            <ul className="contact-values">
              {c.emails.map((e) => (
                <li key={e.address}>
                  {e.label && <span className="contact-label">{e.label}</span>}
                  <span className="contact-value">{e.address}</span>
                  <span className="contact-value-actions">
                    {canWriteMail && (
                      <button type="button" className="secondary" onClick={() => onWriteMail(recipientText(recipientName, e.address))} data-testid="contact-write-mail">
                        メールを書く
                      </button>
                    )}
                    <button type="button" className="quiet" onClick={() => void copy(e.address)}>
                      コピー
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>電話</dt>
        <dd>
          {c.phones.length === 0 ? (
            <span className="hint">なし</span>
          ) : (
            <ul className="contact-values">
              {c.phones.map((p) => (
                <li key={p.number}>
                  {p.label && <span className="contact-label">{p.label}</span>}
                  <a className="contact-value" href={telHref(p.number)}>
                    {p.number}
                  </a>
                  <span className="contact-value-actions">
                    <button type="button" className="quiet" onClick={() => void copy(p.number)}>
                      コピー
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        {(c.postalCode || c.address) && (
          <>
            <dt>住所</dt>
            <dd className="contact-address">
              {c.postalCode && <span>〒{c.postalCode}</span>}
              {c.address && <span>{c.address}</span>}
            </dd>
          </>
        )}
        {c.tags.length > 0 && (
          <>
            <dt>タグ</dt>
            <dd className="chips">
              {c.tags.map((t) => (
                <span key={t} className="chip task-tag">
                  {t}
                </span>
              ))}
            </dd>
          </>
        )}
        {c.notes && (
          <>
            <dt>メモ</dt>
            <dd className="contact-notes">{c.notes}</dd>
          </>
        )}
        {c.source && (
          <>
            <dt>出典</dt>
            <dd className="hint">{c.source}</dd>
          </>
        )}
      </dl>
      <div className="actions contact-actions">
        <button type="button" onClick={() => { setMessage(null); setEditing(true); }} data-testid="contact-edit">
          編集する
        </button>
        {canAdminister && !confirmDelete && (
          <button type="button" className="secondary" onClick={() => setConfirmDelete(true)} data-testid="contact-delete">
            削除…
          </button>
        )}
      </div>
      {confirmDelete && (
        <div className="contact-delete-confirm" role="group" aria-label="削除の確認">
          <p>「{contactTitle(c)}」を連絡先から削除します。削除した内容は記録に残り、権限管理者が記録から戻せます。</p>
          <div className="actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()} data-testid="contact-delete-confirm">
              削除する
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>
              やめる
            </button>
          </div>
        </div>
      )}
      <p className="hint contact-record">
        登録 {c.createdByName}（{fmtDate(c.createdAt)}）{c.version > 1 && `・最終更新 ${c.updatedByName}（${fmtDate(c.updatedAt)}）`}
      </p>
      {history.length > 0 && (
        <details className="history">
          <summary>変更の記録（{history.length} 件）</summary>
          <ul>
            {history.map((h, i) => (
              <li key={i}>
                <span className="history-meta">
                  {fmtDate(h.at)}・{h.actorName}
                </span>
                <span>
                  {ACTIONS[h.action]}
                  {h.changed.length > 0 && `：${h.changed.map((f) => FIELD_LABELS[f as keyof ContactInput] ?? f).join('、')}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

interface Draft {
  category: ContactCategory;
  organization: string;
  section: string;
  name: string;
  nameKana: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  postalCode: string;
  address: string;
  tags: string;
  notes: string;
}

const toDraft = (c: ContactInput): Draft => ({
  category: c.category,
  organization: c.organization,
  section: c.section,
  name: c.name,
  nameKana: c.nameKana,
  emails: c.emails.length > 0 ? c.emails.map((e) => ({ ...e })) : [{ label: '', address: '' }],
  phones: c.phones.length > 0 ? c.phones.map((p) => ({ ...p })) : [{ label: '', number: '' }],
  postalCode: c.postalCode,
  address: c.address,
  tags: c.tags.join('、'),
  notes: c.notes,
});

/** The field an error is shown at: one tag is the tag field; the category (a list to choose from) has none. */
const shownField = (field: string | null) => (field?.startsWith('tags.') ? 'tags' : field === 'category' ? null : field);

/** The id of the input a validation field names (emails.1 → the second address). */
const inputId = (field: string) => {
  const [name, index] = field.split('.');
  if (name === 'emails') return index === undefined ? 'contact-emails-0-address' : `contact-emails-${index}-address`;
  if (name === 'phones') return index === undefined ? 'contact-phones-0-number' : `contact-phones-${index}-number`;
  if (name === 'tags') return 'contact-tags';
  return `contact-${name}`;
};

function ContactForm({
  initial,
  existing,
  tags,
  onSaved,
  onCancel,
  onOpenExisting,
}: {
  initial: ContactInput;
  existing?: { id: string; version: number };
  tags: string[];
  onSaved: (detail: ContactDetailResponse) => void;
  onCancel: () => void;
  onOpenExisting: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [error, setError] = useState<{ field: string | null; text: string; conflict?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dupes, setDupes] = useState<ContactAddressMatch[]>([]);
  const form = useRef<HTMLFormElement>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setEmail = (i: number, patch: Partial<ContactEmail>) => setDraft((d) => ({ ...d, emails: d.emails.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const setPhone = (i: number, patch: Partial<ContactPhone>) => setDraft((d) => ({ ...d, phones: d.phones.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const focusField = (field: string | null) => {
    if (!field) return;
    window.setTimeout(() => form.current?.querySelector<HTMLElement>(`#${inputId(field).replace(/\./g, '\\.')}`)?.focus(), 0);
  };

  // An address already in another contact (checked when an address field is left).
  async function checkDuplicates() {
    const addresses = draft.emails.map((e) => e.address.trim().normalize('NFKC')).filter(isMailAddress);
    if (addresses.length === 0) {
      setDupes([]);
      return;
    }
    try {
      const found = await api<ContactAddressMatch[]>('GET', `/api/contacts/by-address?addresses=${encodeURIComponent(addresses.join(','))}`);
      setDupes(found.filter((m) => m.contactId !== existing?.id));
    } catch {
      setDupes([]);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    let input: ContactInput;
    try {
      input = validateContact({ ...draft, tags: splitTags(draft.tags) });
    } catch (err) {
      if (!(err instanceof ContactValidationError)) throw err;
      const field = shownField(err.field);
      setError({ field, text: err.message });
      focusField(field);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = existing
        ? await api<ContactDetailResponse>('PUT', `/api/contacts/${encodeURIComponent(existing.id)}`, { expectedVersion: existing.version, contact: input })
        : await api<ContactDetailResponse>('POST', '/api/contacts', input);
      onSaved(result);
    } catch (err) {
      const f = err instanceof ApiFailure ? err : toFailure(err);
      const field = shownField((f.body?.details as { field?: string } | undefined)?.field ?? null);
      setError({ field, text: f.message, conflict: f.status === 409 });
      focusField(field);
      setBusy(false);
    }
  }

  // A whole-list error (too many addresses) marks the first row.
  const hit = (field: string) => !!error?.field && (error.field === field || field === `${error.field}.0`);
  const invalid = (field: string) => (hit(field) ? { 'aria-invalid': true as const, 'aria-describedby': 'contact-form-error' } : {});
  // The message sits under the field it is about (../docs/ui-guidelines.md §7); one without a field sits above the buttons.
  const errorAt = (field: string) =>
    hit(field) ? (
      <p className="field-error" role="alert" id="contact-form-error" data-testid="contact-form-error">
        {error!.text}
      </p>
    ) : null;
  const text = (field: 'organization' | 'section' | 'name' | 'nameKana' | 'address', label: string, wide = false, testId?: string) => (
    <div className={`edit-field ${wide ? 'field-wide' : ''}`}>
      <label htmlFor={`contact-${field}`}>{label}</label>
      <input id={`contact-${field}`} type="text" value={draft[field]} maxLength={field === 'address' ? CONTACT_LIMITS.address : CONTACT_LIMITS.text} onChange={(e) => set(field, e.target.value)} {...invalid(field)} data-testid={testId} />
      {errorAt(field)}
    </div>
  );

  return (
    <form ref={form} className="contact-form" onSubmit={(e) => void submit(e)} aria-labelledby="contact-form-title" noValidate data-testid="contact-form">
      <h2 id="contact-form-title">{existing ? '連絡先を編集' : '連絡先を追加'}</h2>
      <p className="hint">氏名か組織・団体のどちらかは必須です。ほかは分かるものだけで構いません。</p>
      <div className="form-grid">
        <div className="edit-field field-wide">
          <label htmlFor="contact-category">種類</label>
          <select id="contact-category" value={draft.category} onChange={(e) => set('category', e.target.value as ContactCategory)}>
            {CONTACT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        {text('organization', '組織・団体', false, 'contact-organization')}
        {text('section', '部署・役職')}
        {text('name', '氏名', false, 'contact-name')}
        {text('nameKana', 'ふりがな')}
      </div>

      <fieldset className="contact-multi">
        <legend>メール</legend>
        {draft.emails.map((e, i) => (
          <div className="contact-multi-item" key={i}>
            <div className="contact-multi-row">
              <label>
                <span className="sr-only">{i + 1} 件目の</span>種類
                <input type="text" value={e.label} placeholder="例: 請求書" maxLength={CONTACT_LIMITS.label} onChange={(ev) => setEmail(i, { label: ev.target.value })} />
              </label>
              <label className="contact-multi-main">
                <span className="sr-only">{i + 1} 件目の</span>アドレス
                <input id={`contact-emails-${i}-address`} type="email" inputMode="email" autoComplete="off" value={e.address} onChange={(ev) => setEmail(i, { address: ev.target.value })} onBlur={() => void checkDuplicates()} {...invalid(`emails.${i}`)} data-testid="contact-email" />
              </label>
              {draft.emails.length > 1 && (
                <button type="button" className="quiet" onClick={() => set('emails', draft.emails.filter((_, j) => j !== i))} aria-label={`${i + 1} 件目のメールを外す`}>
                  外す
                </button>
              )}
            </div>
            {errorAt(`emails.${i}`)}
          </div>
        ))}
        {draft.emails.length < CONTACT_LIMITS.emails && (
          <button type="button" className="quiet" onClick={() => set('emails', [...draft.emails, { label: '', address: '' }])}>
            ＋ メールを足す
          </button>
        )}
        {dupes.length > 0 && (
          <div className="status warning" role="status" data-testid="contact-duplicate">
            {dupes.map((d) => (
              <p key={d.address}>
                {d.address} は「
                <button type="button" className="link-button" onClick={() => onOpenExisting(d.contactId)}>
                  {d.name}
                </button>
                」にもあります。
              </p>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="contact-multi">
        <legend>電話</legend>
        {draft.phones.map((p, i) => (
          <div className="contact-multi-item" key={i}>
            <div className="contact-multi-row">
              <label>
                <span className="sr-only">{i + 1} 件目の</span>種類
                <input type="text" value={p.label} placeholder="例: 代表・携帯" maxLength={CONTACT_LIMITS.label} onChange={(ev) => setPhone(i, { label: ev.target.value })} />
              </label>
              <label className="contact-multi-main">
                <span className="sr-only">{i + 1} 件目の</span>番号
                <input id={`contact-phones-${i}-number`} type="tel" inputMode="tel" autoComplete="off" value={p.number} onChange={(ev) => setPhone(i, { number: ev.target.value })} {...invalid(`phones.${i}`)} data-testid="contact-phone" />
              </label>
              {draft.phones.length > 1 && (
                <button type="button" className="quiet" onClick={() => set('phones', draft.phones.filter((_, j) => j !== i))} aria-label={`${i + 1} 件目の電話を外す`}>
                  外す
                </button>
              )}
            </div>
            {errorAt(`phones.${i}`)}
          </div>
        ))}
        {draft.phones.length < CONTACT_LIMITS.phones && (
          <button type="button" className="quiet" onClick={() => set('phones', [...draft.phones, { label: '', number: '' }])}>
            ＋ 電話を足す
          </button>
        )}
      </fieldset>

      <div className="form-grid">
        <div className="edit-field">
          <label htmlFor="contact-postalCode">郵便番号</label>
          <input id="contact-postalCode" type="text" inputMode="numeric" value={draft.postalCode} placeholder="123-4567" maxLength={20} onChange={(e) => set('postalCode', e.target.value)} {...invalid('postalCode')} />
          {errorAt('postalCode')}
        </div>
        {text('address', '住所', true)}
        <div className="edit-field field-wide">
          <label htmlFor="contact-tags">タグ</label>
          <input id="contact-tags" type="text" list="contact-tag-options" value={draft.tags} placeholder="例: 協賛、業者（「、」で区切る）" onChange={(e) => set('tags', e.target.value)} {...invalid('tags')} data-testid="contact-tags" />
          <datalist id="contact-tag-options">
            {tags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          {errorAt('tags')}
        </div>
        <div className="edit-field field-wide">
          <label htmlFor="contact-notes">メモ</label>
          <textarea id="contact-notes" rows={4} value={draft.notes} maxLength={CONTACT_LIMITS.notes} onChange={(e) => set('notes', e.target.value)} {...invalid('notes')} />
          {errorAt('notes')}
        </div>
      </div>
      {error && !error.field && (
        <p className={`status ${error.conflict ? 'conflict' : 'error'}`} role="alert" id="contact-form-error" data-testid="contact-form-error">
          {error.text}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={busy} data-testid="contact-save">
          {busy ? '保存しています…' : existing ? '保存する' : '登録する'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

function ContactImport({ onImported }: { onImported: () => void }) {
  const [contacts, setContacts] = useState<unknown[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [checked, setChecked] = useState<ContactImportResponse | null>(null);
  const [done, setDone] = useState<ContactImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File | undefined) {
    setContacts(null);
    setChecked(null);
    setDone(null);
    setError(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as { contacts?: unknown }).contacts;
      if (!Array.isArray(list) || list.length === 0) throw new Error('empty');
      if (list.length > CONTACT_LIMITS.importMax) {
        setError(`一度に取り込めるのは ${CONTACT_LIMITS.importMax} 件までです（このファイルは ${list.length} 件）。`);
        return;
      }
      setContacts(list);
    } catch {
      setError('取り込み用の JSON ファイルとして読めませんでした（"contacts" の一覧が要ります）。');
    }
  }

  async function run(dryRun: boolean) {
    if (!contacts) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<ContactImportResponse>('POST', '/api/contacts/import', { contacts, dryRun });
      if (dryRun) setChecked(result);
      else {
        setDone(result);
        setChecked(null);
        onImported();
      }
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  const result = done ?? checked;
  return (
    <section className="contact-import" aria-labelledby="contact-import-title" data-testid="contact-import">
      <h2 id="contact-import-title">連絡先の取り込み</h2>
      <p className="hint">委員長が中身を確かめた取り込み用の JSON ファイル（取り込み候補_日付.json）を選びます。まず「確かめる」で何件入るかを見てから取り込みます。すでにあるアドレスの連絡先と、同じ種類・組織・氏名でアドレスのない連絡先はとばします。</p>
      <label className="contact-file">
        ファイル
        <input type="file" accept=".json,application/json" onChange={(e) => void read(e.target.files?.[0])} data-testid="contact-import-file" />
      </label>
      {contacts && (
        <p className="hint">
          {fileName}：{contacts.length} 件
        </p>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="secondary" disabled={!contacts || busy || !!done} onClick={() => void run(true)} data-testid="contact-import-check">
          確かめる（まだ取り込まない）
        </button>
        <button type="button" disabled={!checked || checked.added === 0 || busy} onClick={() => void run(false)} data-testid="contact-import-run">
          {checked ? `${checked.added} 件を取り込む` : '取り込む'}
        </button>
      </div>
      {result && (
        <div className="contact-import-result" role="status" data-testid="contact-import-result">
          <p className={`status ${result.dryRun ? 'info' : 'ok'}`}>
            {result.dryRun ? `取り込むと ${result.added} 件が入ります。` : `${result.added} 件を取り込みました。`}
            {result.duplicates.length > 0 && ` すでにある ${result.duplicates.length} 件はとばします。`}
            {result.invalid.length > 0 && ` 形の正しくない ${result.invalid.length} 件は入りません。`}
          </p>
          {result.invalid.length > 0 && (
            <details open>
              <summary>入らないもの（{result.invalid.length} 件）</summary>
              <ul className="rows">
                {result.invalid.slice(0, 200).map((x) => (
                  <li key={x.index}>
                    <span className="row-main">
                      {x.index + 1} 件目 {x.label}
                    </span>
                    <span className="row-sub">{x.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.duplicates.length > 0 && (
            <details>
              <summary>とばすもの（{result.duplicates.length} 件）</summary>
              <ul className="rows">
                {result.duplicates.slice(0, 200).map((x) => (
                  <li key={x.index}>
                    <span className="row-main">
                      {x.index + 1} 件目 {x.label}
                    </span>
                    <span className="row-sub">{x.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
