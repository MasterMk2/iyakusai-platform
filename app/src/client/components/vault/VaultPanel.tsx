import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiFailure, api, fmtDate, fmtListDate, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { LoadStatus } from '../LoadStatus';
import {
  VAULT_LIMITS,
  VAULT_REAUTH_REQUIRED,
  VAULT_ROLE_LABELS,
  vaultRoleRank,
  type VaultEntriesResponse,
  type VaultEntryItem,
  type VaultEntryResponse,
  type VaultMetaResponse,
  type VaultPrintResponse,
  type VaultRevealField,
  type VaultRevealResponse,
  type VaultSectionSummary,
  type VaultSectionsResponse,
} from '../../../shared/vault';
import { VaultSectionTools } from './VaultSectionTools';
import { VaultPrintSheet } from './VaultPrintSheet';
import './vault.css';

// パスワード帳 (2026-11-23, settings › パスワード帳). One screen: the sections as filters, a search, and the entries with
// their copy buttons, the most frequent task. Values (passwords, notes) are fetched one at a time on a button, kept in
// this component's state only (never the address, the title, storage or a loader's cache), and dropped when the screen
// locks: after 5 minutes without use, when the tab is hidden, when another part of the settings is opened, and when
// it closes. A copied value is cleared from the clipboard 30 seconds later.

const IDLE_LOCK_MS = 5 * 60_000;
const CLIPBOARD_CLEAR_MS = 30_000;
const ALL = 'all';

type Revealed = Record<string, Partial<Record<VaultRevealField, string>>>;
type Editing = { mode: 'new' } | { mode: 'edit'; entry: VaultEntryItem } | null;
type Tool = 'members' | 'events' | null;

// The clipboard is cleared 30 seconds after a copy even when the book has closed meanwhile (the usual case: the person
// went to another tab to paste). The timer lives outside the components, and a clear the browser refused because the
// page was not in front is tried again when the page comes back.
let clipboardDue: number | null = null;
let clipboardTimer: number | null = null;
let clipboardWatched = false;
function clearClipboardIfDue(): void {
  if (clipboardDue === null || Date.now() < clipboardDue) return;
  navigator.clipboard.writeText('').then(
    () => {
      clipboardDue = null;
    },
    () => undefined,
  );
}
function scheduleClipboardClear(): void {
  clipboardDue = Date.now() + CLIPBOARD_CLEAR_MS;
  if (clipboardTimer !== null) window.clearTimeout(clipboardTimer);
  clipboardTimer = window.setTimeout(() => {
    clipboardTimer = null;
    clearClipboardIfDue();
  }, CLIPBOARD_CLEAR_MS);
  if (!clipboardWatched) {
    clipboardWatched = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') clearClipboardIfDue();
    });
    window.addEventListener('focus', clearClipboardIfDue);
  }
}

const isReauth = (err: unknown) => err instanceof ApiFailure && err.status === 401 && err.body?.error === VAULT_REAUTH_REQUIRED;
const fold = (s: string) => s.normalize('NFKC').toLowerCase();
const newToken = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `tok-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};
/** A random password: 20 characters from letters and digits without the ones that look alike (l, 1, O, 0). */
export function randomPassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out: string[] = [];
  const bytes = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    // Rejection keeps every character equally likely (256 is not a multiple of the alphabet's length).
    if (bytes[0]! < Math.floor(256 / alphabet.length) * alphabet.length) out.push(alphabet[bytes[0]! % alphabet.length]!);
  }
  return out.join('');
}

export function VaultPanel({ active, onAvailable }: { active: boolean; onAvailable?: (available: boolean) => void }) {
  const [metaRefresh, setMetaRefresh] = useState(0);
  const loadMeta = useCallback(
    (signal: AbortSignal) => {
      void metaRefresh;
      return api<VaultMetaResponse>('GET', '/api/vault/meta', undefined, signal);
    },
    [metaRefresh],
  );
  const meta = useLoader(loadMeta);
  const m = meta.data;
  // A server without the password book (404), an error, or a person on no section: no part at all, never an error.
  const absent = meta.error !== null || (!!m && (!m.enabled || !m.canOpen));
  const known = !meta.loading || m !== null;
  useEffect(() => {
    if (known) onAvailable?.(!absent);
  }, [known, absent, onAvailable]);
  const metaChanged = useCallback(() => setMetaRefresh((n) => n + 1), []);
  if (absent || !m) return null;
  // The settings keep their parts mounted: while another part is shown, nothing of the password book is on the page.
  if (!active) return null;
  return <VaultBook meta={m} onMetaChanged={metaChanged} />;
}

type Phase = 'password' | 'open' | 'closed';

function VaultBook({ meta, onMetaChanged }: { meta: VaultMetaResponse; onMetaChanged: () => void }) {
  const [sectionsRefresh, setSectionsRefresh] = useState(0);
  const loadSections = useCallback(
    (signal: AbortSignal) => {
      void sectionsRefresh;
      return api<VaultSectionsResponse>('GET', '/api/vault/sections', undefined, signal);
    },
    [sectionsRefresh],
  );
  const sections = useLoader(loadSections);
  const list = useMemo(() => sections.data?.sections ?? [], [sections.data]);
  const reloadSections = useCallback(() => setSectionsRefresh((n) => n + 1), []);

  const [phase, setPhase] = useState<Phase>(meta.freshUntil === null ? 'password' : 'open');
  const [closedWhy, setClosedWhy] = useState('');
  // A new key opens the list afresh: its values start empty every time.
  const [openKey, setOpenKey] = useState(0);
  const [selected, setSelected] = useState<string>(ALL);
  const [tool, setTool] = useState<Tool>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [printing, setPrinting] = useState<VaultPrintResponse | null>(null);
  const [freshUntil, setFreshUntil] = useState<string | null>(meta.freshUntil);
  const [seenFresh, setSeenFresh] = useState<string | null>(meta.freshUntil);
  if (seenFresh !== meta.freshUntil) {
    setSeenFresh(meta.freshUntil);
    setFreshUntil(meta.freshUntil);
  }

  const byId = useMemo(() => new Map(list.map((s) => [s.id, s])), [list]);
  // A section that went away (removed, or the person was taken off it) falls back to all.
  const current = selected !== ALL && sections.data && !byId.has(selected) ? ALL : selected;
  const section = current === ALL ? null : (byId.get(current) ?? null);

  const askPassword = useCallback(() => {
    setPhase('password');
    setPrinting(null);
    setFreshUntil(null);
    setMessage(null);
  }, []);
  const fail = useCallback(
    (err: unknown) => {
      if (isReauth(err)) askPassword();
      else setMessage(toFailure(err).message);
    },
    [askPassword],
  );
  const close = useCallback((why: string) => {
    setPhase('closed');
    setClosedWhy(why);
    setPrinting(null);
    setTool((t) => (t === 'events' ? null : t));
  }, []);
  const reopen = () => {
    setPhase('open');
    setOpenKey((n) => n + 1);
    setMessage(null);
  };
  const donePrinting = useCallback(() => setPrinting(null), []);
  const print = async (s: VaultSectionSummary) => {
    setMessage(null);
    try {
      setPrinting(await api<VaultPrintResponse>('POST', `/api/vault/sections/${s.id}/print`, {}));
      reloadSections();
    } catch (err) {
      fail(err);
    }
  };

  const freshLabel = freshUntil ? new Date(freshUntil).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <section className="vault-panel" aria-labelledby="vault-title" data-testid="vault-panel">
      <div className="vault-head">
        <h3 id="vault-title">パスワード帳</h3>
        {phase === 'open' && (
          <button type="button" className="secondary" onClick={() => close('閉じました。')} data-testid="vault-lock">
            閉じる
          </button>
        )}
      </div>
      <p className="hint">
        委員会のアカウントの ID とパスワードです。値はサーバーで暗号化して保存し、表示・コピー・印刷はすべて記録に残ります。
        {freshLabel && phase === 'open' ? `この端末では ${freshLabel} まで、パスワードを入れ直さずに開けます。` : ''}
      </p>

      {phase === 'password' ? (
        <VaultReauth
          minutes={meta.revealMinutes}
          onDone={() => {
            onMetaChanged();
            setFreshUntil(new Date(Date.now() + meta.revealMinutes * 60_000).toISOString());
            reopen();
          }}
        />
      ) : (
        <>
          <SectionBar
            sections={list}
            selected={current}
            onSelect={(id) => {
              setSelected(id);
              setTool(null);
            }}
          />
          <LoadStatus loader={sections} what="区分" compact />
          {sections.data?.canAdminister && (
            <NewSection
              onCreated={(id) => {
                reloadSections();
                onMetaChanged();
                setSelected(id);
              }}
              onFail={fail}
            />
          )}
          {section && (
            <VaultSectionTools
              key={section.id}
              section={section}
              open={phase === 'open'}
              canAdminister={meta.canAdminister}
              tool={tool}
              onTool={setTool}
              onPrint={() => void print(section)}
              onChanged={() => {
                reloadSections();
                onMetaChanged();
              }}
              onRemoved={() => {
                setSelected(ALL);
                reloadSections();
                onMetaChanged();
              }}
              onFail={fail}
            />
          )}
          {message && (
            <p className="status error" role="alert">
              {message}
            </p>
          )}
          {phase === 'closed' ? (
            <div className="vault-locked" data-testid="vault-locked">
              <p>{closedWhy}</p>
              <button type="button" onClick={reopen}>
                パスワード帳を開く
              </button>
            </div>
          ) : (
            <OpenBook key={openKey} selected={current} sections={list} byId={byId} onClearFilter={() => setSelected(ALL)} onFail={fail} onClose={close} onChanged={reloadSections} />
          )}
        </>
      )}
      {printing && <VaultPrintSheet data={printing} onDone={donePrinting} />}
    </section>
  );
}

/** The list and its values. Mounted while the book is open; closing it (or losing the password) unmounts it. */
function OpenBook({
  selected,
  sections,
  byId,
  onClearFilter,
  onFail,
  onClose,
  onChanged,
}: {
  selected: string;
  sections: VaultSectionSummary[];
  byId: Map<string, VaultSectionSummary>;
  onClearFilter: () => void;
  onFail: (err: unknown) => void;
  onClose: (why: string) => void;
  onChanged: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<VaultEntriesResponse>('GET', '/api/vault/entries', undefined, signal);
    },
    [refresh],
  );
  const loader = useLoader(load);
  const entries = loader.data;
  const reauthNeeded = isReauth(loader.error);
  useEffect(() => {
    if (reauthNeeded) onFail(loader.error);
  }, [reauthNeeded, loader.error, onFail]);

  const [revealed, setRevealed] = useState<Revealed>({});
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  // Hidden tab, or 5 minutes without use: close (which drops everything here).
  const rootRef = useRef<HTMLDivElement>(null);
  const lastUse = useRef(0);
  useEffect(() => {
    lastUse.current = Date.now();
    const touch = () => {
      lastUse.current = Date.now();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') onClose('画面を離れたため、表示していた内容を消しました。');
    };
    const root = rootRef.current;
    root?.addEventListener('pointerdown', touch);
    root?.addEventListener('keydown', touch);
    document.addEventListener('visibilitychange', hidden);
    const timer = window.setInterval(() => {
      if (Date.now() - lastUse.current > IDLE_LOCK_MS) onClose(`${IDLE_LOCK_MS / 60_000} 分操作が無かったため、表示していた内容を消しました。`);
    }, 15_000);
    return () => {
      root?.removeEventListener('pointerdown', touch);
      root?.removeEventListener('keydown', touch);
      document.removeEventListener('visibilitychange', hidden);
      window.clearInterval(timer);
    };
  }, [onClose]);

  const failHere = (err: unknown) => {
    if (isReauth(err)) onFail(err);
    else setMessage({ text: toFailure(err).message, error: true });
  };
  const copyText = async (text: string, what: string, clearLater: boolean) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setMessage({ text: `${what}をコピーできませんでした（ブラウザーがクリップボードを使わせませんでした）。「表示」で確かめてください。`, error: true });
      return;
    }
    if (!clearLater) {
      setMessage({ text: `${what}をコピーしました。`, error: false });
      return;
    }
    scheduleClipboardClear();
    setMessage({ text: `${what}をコピーしました。30 秒後にクリップボードを空にします。`, error: false });
  };
  const reveal = async (entry: VaultEntryItem, field: VaultRevealField, purpose: 'show' | 'copy' | 'edit'): Promise<string | null> => {
    setMessage(null);
    try {
      return (await api<VaultRevealResponse>('POST', `/api/vault/entries/${entry.id}/reveal`, { field, purpose })).value;
    } catch (err) {
      failHere(err);
      return null;
    }
  };
  const copyPassword = async (entry: VaultEntryItem) => {
    const value = await reveal(entry, 'password', 'copy');
    if (value !== null) await copyText(value, `「${entry.name}」のパスワード`, true);
  };
  const toggleShow = async (entry: VaultEntryItem, field: VaultRevealField) => {
    if (revealed[entry.id]?.[field] !== undefined) {
      setRevealed((r) => ({ ...r, [entry.id]: { ...r[entry.id], [field]: undefined } }));
      return;
    }
    const value = await reveal(entry, field, 'show');
    if (value !== null) setRevealed((r) => ({ ...r, [entry.id]: { ...r[entry.id], [field]: value } }));
  };

  const editable = sections.filter((s) => vaultRoleRank(s.myRole) >= vaultRoleRank('edit'));
  const section = selected === ALL ? null : (byId.get(selected) ?? null);
  const shown = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    return (entries?.entries ?? []).filter((e) => {
      if (selected !== ALL && e.sectionId !== selected) return false;
      if (terms.length === 0) return true;
      const text = fold(`${e.name} ${e.url} ${e.username} ${byId.get(e.sectionId)?.name ?? ''}`);
      return terms.every((t) => text.includes(t));
    });
  }, [entries, selected, query, byId]);

  return (
    <div ref={rootRef} className="vault-open">
      <div className="vault-toolbar">
        <label className="vault-search">
          <span className="sr-only">名前・ID・URL で探す</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名前・ID・URL で探す" data-testid="vault-search" />
        </label>
        {editable.length > 0 && (
          <button type="button" className="secondary" onClick={() => setEditing({ mode: 'new' })} disabled={editing?.mode === 'new'} data-testid="vault-add">
            項目を追加
          </button>
        )}
      </div>
      {message && (
        <p className={`status ${message.error ? 'error' : 'ok'}`} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {entries && entries.unreadable > 0 && (
        <p className="status error" role="alert">
          開けない項目が {entries.unreadable} 件あります（鍵が替わったか、保存ファイルが変わっています）。権限管理者に知らせてください。
        </p>
      )}
      {editing && (
        <EntryForm
          key={editing.mode === 'edit' ? editing.entry.id : 'new'}
          editing={editing}
          sections={editable}
          defaultSection={section && vaultRoleRank(section.myRole) >= vaultRoleRank('edit') ? section.id : (editable[0]?.id ?? '')}
          onRevealNotes={(entry) => reveal(entry, 'notes', 'edit')}
          onDone={(text) => {
            setEditing(null);
            setMessage({ text, error: false });
            setRevealed({});
            setRefresh((n) => n + 1);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
          onFail={failHere}
        />
      )}
      {!reauthNeeded && <LoadStatus loader={loader} what="パスワード帳の項目" compact />}
      {entries && (
        <EntryList
          entries={shown}
          total={entries.entries.length}
          filtered={query.trim() !== '' || selected !== ALL}
          showSection={selected === ALL && sections.length > 1}
          sections={byId}
          revealed={revealed}
          onCopyPassword={(e) => void copyPassword(e)}
          onCopyId={(e) => void copyText(e.username, `「${e.name}」の ID`, false)}
          onToggle={(e, field) => void toggleShow(e, field)}
          onEdit={(e) => setEditing({ mode: 'edit', entry: e })}
          onClear={() => {
            setQuery('');
            onClearFilter();
          }}
          canAdd={editable.length > 0}
        />
      )}
    </div>
  );
}

function VaultReauth({ minutes, onDone }: { minutes: number; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/reauth', { password });
      setPassword('');
      onDone();
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="account-form vault-reauth" onSubmit={submit} data-testid="vault-reauth">
      <p>パスワード帳を開くには、ログインのパスワードをもう一度入力してください。入力してから {minutes} 分のあいだ開けます。</p>
      <label>
        パスワード
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </label>
      <button type="submit" disabled={busy || password.length === 0}>
        {busy ? '確認中…' : 'パスワード帳を開く'}
      </button>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function SectionBar({ sections, selected, onSelect }: { sections: VaultSectionSummary[]; selected: string; onSelect: (id: string) => void }) {
  if (sections.length === 0) return null;
  const total = sections.reduce((n, s) => n + (s.myRole ? s.entryCount : 0), 0);
  return (
    <div className="filter-chips vault-sections" role="group" aria-label="区分">
      <button type="button" className="filter-chip" aria-pressed={selected === ALL} onClick={() => onSelect(ALL)}>
        すべて <span className="option-count">{total}</span>
      </button>
      {sections.map((s) => (
        <button key={s.id} type="button" className="filter-chip" aria-pressed={selected === s.id} onClick={() => onSelect(s.id)} data-testid={`vault-section-${s.name}`}>
          {s.name} <span className="option-count">{s.entryCount}</span>
          {s.entryCount > 0 && (s.lastPrintedAt === null || s.changesSincePrint > 0) && <span className="vault-stale-dot" aria-label="紙の控えが古い" title="紙の控えが古い" />}
        </button>
      ))}
    </div>
  );
}

function NewSection({ onCreated, onFail }: { onCreated: (id: string) => void; onFail: (err: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <p className="vault-new-section">
        <button type="button" className="link-button" onClick={() => setOpen(true)} data-testid="vault-new-section">
          区分を作る
        </button>
      </p>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ section: VaultSectionSummary }>('POST', '/api/vault/sections', { name, note });
      setOpen(false);
      setName('');
      setNote('');
      onCreated(res.section.id);
    } catch (err) {
      onFail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-form vault-form" onSubmit={submit}>
      <label>
        区分の名前
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={VAULT_LIMITS.sectionName} required />
      </label>
      <label>
        説明（任意）
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={VAULT_LIMITS.sectionNote} />
      </label>
      <p className="hint">作った人がこの区分の最初の「管理する」になります。部局や人を付けたあと、自分を外すこともできます。</p>
      <div className="admin-actions">
        <button type="submit" disabled={busy || name.trim() === ''}>
          {busy ? '作っています…' : '作る'}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          やめる
        </button>
      </div>
    </form>
  );
}

function EntryList(props: {
  entries: VaultEntryItem[];
  total: number;
  filtered: boolean;
  showSection: boolean;
  sections: Map<string, VaultSectionSummary>;
  revealed: Revealed;
  onCopyPassword: (e: VaultEntryItem) => void;
  onCopyId: (e: VaultEntryItem) => void;
  onToggle: (e: VaultEntryItem, field: VaultRevealField) => void;
  onEdit: (e: VaultEntryItem) => void;
  onClear: () => void;
  canAdd: boolean;
}) {
  if (props.total === 0) {
    return <p className="hint">まだ項目がありません。{props.canAdd ? '「項目を追加」から登録します。' : '「編集する」を持つ人が登録すると、ここに出ます。'}</p>;
  }
  if (props.entries.length === 0) {
    return (
      <p className="hint">
        当てはまる項目がありません。
        {props.filtered && (
          <button type="button" className="link-button" onClick={props.onClear}>
            条件を外す
          </button>
        )}
      </p>
    );
  }
  return (
    <ul className="vault-list" aria-label="項目">
      {props.entries.map((e) => {
        const section = props.sections.get(e.sectionId);
        const canEdit = vaultRoleRank(section?.myRole) >= vaultRoleRank('edit');
        const shown = props.revealed[e.id] ?? {};
        return (
          <li key={e.id} className="vault-item" data-testid="vault-entry">
            <div className="vault-item-main">
              <p className="vault-item-name">
                {e.name}
                {props.showSection && section && <span className="pay-badge vault-item-section">{section.name}</span>}
              </p>
              {/^https?:\/\//i.test(e.url) ? (
                <a className="vault-item-url" href={e.url} target="_blank" rel="noopener noreferrer">
                  {e.url}
                </a>
              ) : (
                e.url && <p className="vault-item-url">{e.url}</p>
              )}
              <dl className="vault-item-fields">
                {e.username && (
                  <>
                    <dt>ID</dt>
                    <dd>
                      <code>{e.username}</code>{' '}
                      <button type="button" className="link-button" onClick={() => props.onCopyId(e)}>
                        ID をコピー
                      </button>
                    </dd>
                  </>
                )}
                {e.hasPassword && (
                  <>
                    <dt>パスワード</dt>
                    <dd>
                      {shown.password !== undefined ? <code className="vault-secret" data-testid="vault-shown-password">{shown.password}</code> : <span aria-label="伏せてあります">••••••••</span>}{' '}
                      <button type="button" className="link-button" onClick={() => props.onToggle(e, 'password')} aria-label={`「${e.name}」のパスワードを${shown.password !== undefined ? '隠す' : '表示'}`}>
                        {shown.password !== undefined ? '隠す' : '表示'}
                      </button>
                    </dd>
                  </>
                )}
                {e.hasNotes && (
                  <>
                    <dt>メモ</dt>
                    <dd>
                      {shown.notes !== undefined ? <span className="vault-notes">{shown.notes}</span> : <span className="hint">（伏せてあります）</span>}{' '}
                      <button type="button" className="link-button" onClick={() => props.onToggle(e, 'notes')}>
                        {shown.notes !== undefined ? '隠す' : '表示'}
                      </button>
                    </dd>
                  </>
                )}
              </dl>
              <p className="hint vault-item-updated">
                更新 {fmtListDate(e.updatedAt)}（{e.updatedByName}）
              </p>
            </div>
            <div className="vault-item-actions">
              {e.hasPassword && (
                <button type="button" onClick={() => props.onCopyPassword(e)} aria-label={`「${e.name}」のパスワードをコピー`} data-testid="vault-copy">
                  パスワードをコピー
                </button>
              )}
              {canEdit && (
                <button type="button" className="secondary" onClick={() => props.onEdit(e)}>
                  変更
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EntryForm({
  editing,
  sections,
  defaultSection,
  onRevealNotes,
  onDone,
  onCancel,
  onFail,
}: {
  editing: NonNullable<Editing>;
  sections: VaultSectionSummary[];
  defaultSection: string;
  onRevealNotes: (entry: VaultEntryItem) => Promise<string | null>;
  onDone: (text: string) => void;
  onCancel: () => void;
  onFail: (err: unknown) => void;
}) {
  const entry = editing.mode === 'edit' ? editing.entry : null;
  const [sectionId, setSectionId] = useState(entry?.sectionId ?? defaultSection);
  const [name, setName] = useState(entry?.name ?? '');
  const [url, setUrl] = useState(entry?.url ?? '');
  const [username, setUsername] = useState(entry?.username ?? '');
  // On a change, the password and the note stay as they are unless the person chooses to replace them.
  const [changePassword, setChangePassword] = useState(entry === null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [notes, setNotes] = useState<string | null>(entry === null ? '' : null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const token = useRef(newToken());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (entry) {
        await api<VaultEntryResponse>('PUT', `/api/vault/entries/${entry.id}`, { sectionId, name, url, username, password: changePassword ? password : null, notes, expectedVersion: entry.version });
        onDone(`「${name.trim()}」を保存しました。`);
      } else {
        await api<VaultEntryResponse>('POST', '/api/vault/entries', { sectionId, name, url, username, password, notes: notes ?? '', clientToken: token.current });
        onDone(`「${name.trim()}」を追加しました。紙の控えを刷り直してください。`);
      }
    } catch (err) {
      onFail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      await api('DELETE', `/api/vault/entries/${entry.id}?expectedVersion=${entry.version}`);
      onDone(`「${entry.name}」を消しました。紙の控えを刷り直してください。`);
    } catch (err) {
      onFail(err);
    } finally {
      setBusy(false);
    }
  };
  const editNotes = async () => {
    if (!entry) return;
    const value = await onRevealNotes(entry);
    if (value !== null) setNotes(value);
  };

  return (
    <form className="account-form vault-form" onSubmit={submit} aria-label={entry ? `「${entry.name}」を変更` : '項目を追加'} data-testid="vault-form">
      <h4>{entry ? `「${entry.name}」を変更` : '項目を追加'}</h4>
      <label>
        区分
        <select value={sectionId} onChange={(e) => setSectionId(e.target.value)} required>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        名前（何のアカウントか）
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={VAULT_LIMITS.entryName} required data-testid="vault-form-name" />
      </label>
      <label>
        URL（任意）
        <input value={url} onChange={(e) => setUrl(e.target.value)} maxLength={VAULT_LIMITS.url} inputMode="url" />
      </label>
      <label>
        ID・ログイン名（任意）
        <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={VAULT_LIMITS.username} autoComplete="off" />
      </label>
      {changePassword ? (
        <div className="vault-password-field">
          <label>
            パスワード{entry ? '（新しい値）' : ''}
            {/* A text field shown as dots (not type=password): the browser must not offer to save a committee account's
                password into a member's own browser and its sync. */}
            <input
              type="text"
              className={showPassword ? undefined : 'vault-masked'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={VAULT_LIMITS.password}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              data-testid="vault-form-password"
            />
          </label>
          <div className="admin-actions">
            <label>
              <input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
              入力した文字を見る
            </label>
            <button type="button" className="secondary" onClick={() => { setPassword(randomPassword()); setShowPassword(true); }}>
              ランダムに作る
            </button>
          </div>
        </div>
      ) : (
        <p>
          パスワードはそのまま残します。{' '}
          <button type="button" className="link-button" onClick={() => setChangePassword(true)}>
            パスワードを変える
          </button>
        </p>
      )}
      {notes === null ? (
        <p>
          {entry?.hasNotes ? 'メモはそのまま残します。' : 'メモはありません。'}{' '}
          <button type="button" className="link-button" onClick={() => (entry?.hasNotes ? void editNotes() : setNotes(''))}>
            {entry?.hasNotes ? 'メモを書き換える' : 'メモを書く'}
          </button>
        </p>
      ) : (
        <label>
          メモ（予備コード・連絡先など。任意）
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={VAULT_LIMITS.notes} rows={4} />
        </label>
      )}
      <div className="admin-actions">
        <button type="submit" disabled={busy || name.trim() === '' || sectionId === ''} data-testid="vault-form-save">
          {busy ? '保存しています…' : entry ? '保存' : '追加'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
      {entry && (
        <div className="vault-danger">
          {confirmDelete ? (
            <span className="confirm">
              消すと戻せません（アプリからは前の値も見られなくなります）。
              <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
                消す
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>
                やめる
              </button>
            </span>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmDelete(true)}>
              この項目を消す
            </button>
          )}
          <p className="hint">最終更新 {fmtDate(entry.updatedAt)}（{entry.updatedByName}）・{VAULT_ROLE_LABELS.edit}の権限で変更できます。</p>
        </div>
      )}
    </form>
  );
}
