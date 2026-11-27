import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  siteEditorPostHref,
  sortSitePages,
  SITE_EDITOR_PREFIX,
  type SiteEditorAccess,
  type SiteEditorAccessResponse,
  type SiteEditorDeletedPagesResponse,
  type SiteEditorMetaResponse,
  type SiteEditorPagesResponse,
  type SiteEditorResult,
  type SiteEditorVersion,
} from '../../../shared/site-editor';
import { api, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import './site-editor.css';

/**
 * The Webサイト tab (2026-11-23; before, a part of the settings): the blog's posts and whether each is on the site, the
 * way to write a new one, and for the access administrators who may write and who may publish. The tab is there only
 * for people who may write (and access administrators), once the server says the editor is on (App.tsx). The editor
 * itself opens in a browser tab of its own (WebGenEngine, behind this app: docs/site-editor.md); coming back here reads
 * the list again.
 */
export function SiteView() {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<SiteEditorMetaResponse>('GET', '/api/site-editor/meta', undefined, signal);
    },
    [refresh],
  );
  const meta = useLoader(load);
  const m = meta.data;
  // A server without the editor (404), an error, or a person who may not write: the page says why it is empty.
  const absent = meta.error !== null || (!!m && (!m.enabled || (!m.canEdit && !m.canAdminister)));
  return (
    <main className="main site-main" aria-label="Webサイト">
      {meta.loading && !m && <p className="status loading">読み込んでいます…</p>}
      {absent && (
        <section className="site-panel" data-testid="site-absent">
          <h2 className="site-title">Webサイト（ブログ）</h2>
          <p className="hint">このサーバーでは Webサイトの編集を使っていないか、あなたには書く権限がありません。書けるようにするには、権限管理者に依頼してください。</p>
        </section>
      )}
      {!absent && m && (
        <section className="site-panel" aria-labelledby="site-title" data-testid="site-panel">
          <div className="site-head">
            <h2 id="site-title" className="site-title">
              Webサイト（ブログ）
            </h2>
            <div className="site-head-actions">
              {m.siteUrl && (
                <a className="button secondary" href={m.siteUrl} target="_blank" rel="noopener noreferrer" data-testid="site-view">
                  サイトを見る
                </a>
              )}
              {m.canEdit && (
                <a className="button" href={m.editorUrl ?? `${SITE_EDITOR_PREFIX}/editor/posts.html`} target="_blank" rel="noopener" data-testid="site-new">
                  新しい記事を書く
                </a>
              )}
            </div>
          </div>
          <p className="hint">
            {m.canPublish ? 'あなたは書くことと公開（非公開に戻すことも）ができます。' : '書いた記事は、公開できる人か権限管理者が公開します。'}
            記事はエディタ（別のタブ）で書きます。書いた内容は自動で下書きに保存され、「公開」を押すまでサイトには出ません。
          </p>
          {m.canEdit && <PostList canPublish={m.canPublish} />}
          {m.canAdminister && <AccessEditor onSaved={() => setRefresh((n) => n + 1)} />}
        </section>
      )}
    </main>
  );
}

/** A change sent to the editor's server through this app, as the editor sends it (the server refuses one without X-WGE-Request). */
async function changeOnEditor(path: string, body: object = {}): Promise<SiteEditorResult> {
  try {
    const res = await fetch(`${SITE_EDITOR_PREFIX}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-WGE-Request': '1' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as SiteEditorResult | null;
    return json && typeof json.ok === 'boolean' ? json : { ok: false };
  } catch (err) {
    return { ok: false, message: toFailure(err).message };
  }
}

const dayOf = (ms: number) => new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * The posts, newest first. Read again when the person comes back from the editor's browser tab. A draft can be deleted
 * (2026-11-24): the editor's server keeps it, so deleting asks nothing first and offers 元に戻す instead; a published
 * post is made a draft first, so deleting never changes the site. A person who may publish makes a published post a
 * draft with 非公開に戻す (2026-11-26, WebGenEngine #26): it leaves the site at once, so it asks first.
 */
function PostList({ canPublish }: { canPublish: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<SiteEditorPagesResponse>('GET', `${SITE_EDITOR_PREFIX}/api/pages`, undefined, signal);
    },
    [refresh],
  );
  const pages = useLoader(load);
  const loadDeleted = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<SiteEditorDeletedPagesResponse>('GET', `${SITE_EDITOR_PREFIX}/api/deleted-pages`, undefined, signal);
    },
    [refresh],
  );
  const deleted = useLoader(loadDeleted);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean; undo?: { id: string; title: string } } | null>(null);
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') setRefresh((n) => n + 1);
    };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);
  // The post whose 非公開に戻す waits for a yes in its row.
  const [asking, setAsking] = useState<string | null>(null);
  const list = useMemo(() => sortSitePages(pages.data?.pages ?? []), [pages.data]);
  const published = list.filter((p) => p.published).length;
  const gone = deleted.data?.pages ?? [];

  // Asked in the row first (the post leaves the site at once). The live version is read then, so a post published
  // again meanwhile is not taken off by an old list.
  async function unpublish(id: string, title: string) {
    setAsking(null);
    setBusy(id);
    setNotice(null);
    let res: SiteEditorResult;
    try {
      const versions = await api<{ ok: boolean; versions: SiteEditorVersion[] }>('GET', `${SITE_EDITOR_PREFIX}/api/pages/${encodeURIComponent(id)}/versions`);
      const live = versions.versions.find((v) => v.live);
      res = live ? await changeOnEditor(`/api/pages/${encodeURIComponent(id)}/undo-publish`, { versionId: live.id, unpublish: true }) : { ok: false, reason: 'not-published' };
    } catch (err) {
      res = { ok: false, message: toFailure(err).message };
    }
    setBusy(null);
    setRefresh((n) => n + 1);
    // An editor's server older than WebGenEngine #26 ignores "unpublish" and goes back to the version before.
    if (res.ok && res.published) {
      setNotice({ text: `「${title}」は 1 つ前の公開版に戻っただけで、まだ公開中です。編集サーバーの版が古いため、システム課に連絡してください。`, ok: false });
      return;
    }
    if (res.ok) {
      setNotice({ text: `「${title}」を非公開に戻しました。下書きとして一覧にあります。`, ok: true });
      return;
    }
    const why: Record<string, string> = {
      'not-published': 'この記事はすでに公開されていません。',
      'not-live': 'ほかの人が公開し直したため、非公開に戻せませんでした。もう一度押してください。',
    };
    setNotice({ text: (res.reason && why[res.reason]) ?? res.message ?? '非公開に戻せませんでした。もう一度押してください。', ok: false });
  }

  async function change(id: string, action: 'delete' | 'restore', title: string) {
    setBusy(id);
    setNotice(null);
    const res = await changeOnEditor(`/api/pages/${encodeURIComponent(id)}/${action}`);
    setBusy(null);
    setRefresh((n) => n + 1);
    if (res.ok) {
      setNotice(action === 'delete' ? { text: `「${title}」を削除しました。`, ok: true, undo: { id, title } } : { text: `「${title}」を元に戻しました。下書きとして一覧にあります。`, ok: true });
      return;
    }
    const why: Record<string, string> = {
      published: canPublish ? 'この記事は公開中のため削除できません。「非公開に戻す」を押してから削除してください。' : 'この記事は公開中のため削除できません。公開できる人か権限管理者に、非公開に戻してもらってから削除してください。',
      deleted: 'この記事はすでに削除されています。',
      'not-deleted': 'この記事はすでに一覧に戻っています。',
    };
    setNotice({ text: (res.reason && why[res.reason]) ?? res.message ?? (action === 'delete' ? '削除できませんでした。もう一度押してください。' : '元に戻せませんでした。もう一度押してください。'), ok: false });
  }

  return (
    <section className="site-posts" aria-labelledby="site-posts-title">
      <h3 id="site-posts-title">
        記事<span className="site-count">{pages.data ? `${list.length} 件・公開中 ${published} 件` : ''}</span>
      </h3>
      {notice && (
        <p className={`status ${notice.ok ? 'info' : 'error'}`} role="status" data-testid="site-notice">
          {notice.text}
          {notice.undo && (
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => void change(notice.undo!.id, 'restore', notice.undo!.title)} data-testid="site-undo">
              元に戻す
            </button>
          )}
        </p>
      )}
      {pages.error && (
        <p className="status error" role="alert">
          記事の一覧を読み込めませんでした。{pages.error.message}
          <button type="button" className="secondary" onClick={pages.retry}>
            もう一度読み込む
          </button>
        </p>
      )}
      {!pages.data && !pages.error && <p className="status loading">記事の一覧を読み込んでいます…</p>}
      {pages.data && list.length === 0 && <p className="empty">まだ記事はありません。「新しい記事を書く」から始めます。</p>}
      {list.length > 0 && (
        <ul className="site-post-list" data-testid="site-posts">
          {list.map((p) => (
            <li key={p.id} className="site-post" data-testid="site-post">
              <a className="site-post-title" href={siteEditorPostHref(p.id)} target="_blank" rel="noopener">
                {p.title?.trim() || '（題名なし）'}
              </a>
              <span className="site-post-date">{p.date ? p.date.replaceAll('-', '/') : '日付なし'}</span>
              <span className={`chip ${p.published ? 'site-chip-live' : 'site-chip-draft'}`}>{p.published ? '公開中' : '下書き'}</span>
              {!p.published && (
                <button type="button" className="secondary site-post-delete" disabled={busy !== null} aria-label={`「${p.title?.trim() || '題名なし'}」を削除`} onClick={() => void change(p.id, 'delete', p.title?.trim() || '題名なし')} data-testid="site-post-delete">
                  {busy === p.id ? '削除しています…' : '削除'}
                </button>
              )}
              {p.published && canPublish && (
                <button type="button" className="secondary site-post-unpublish" disabled={busy !== null || asking === p.id} aria-label={`「${p.title?.trim() || '題名なし'}」を非公開に戻す`} onClick={() => { setNotice(null); setAsking(p.id); }} data-testid="site-post-unpublish">
                  {busy === p.id ? '戻しています…' : '非公開に戻す'}
                </button>
              )}
              {asking === p.id && (
                <div className="status warning site-post-confirm" role="alert" data-testid="site-unpublish-confirm">
                  <p>「{p.title?.trim() || '題名なし'}」を非公開に戻しますか？ サイトから外れます。書いた内容は下書きに残り、エディタでもう一度公開すれば戻ります。</p>
                  <button type="button" disabled={busy !== null} onClick={() => void unpublish(p.id, p.title?.trim() || '題名なし')} data-testid="site-unpublish-yes">
                    非公開に戻す
                  </button>{' '}
                  <button type="button" className="secondary" onClick={() => setAsking(null)} data-testid="site-unpublish-no">
                    やめる
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && <p className="hint">題名を押すと、その記事がエディタ（別のタブ）で開きます。下書きは「削除」で一覧から外せます。{canPublish ? '公開中の記事は「非公開に戻す」で下書きにしてから削除します。' : '公開中の記事を非公開に戻せるのは、公開できる人と権限管理者です。'}</p>}
      {deleted.error && (
        <p className="status error">
          削除した記事を読み込めませんでした。{deleted.error.message}
          <button type="button" className="secondary" onClick={deleted.retry}>
            もう一度読み込む
          </button>
        </p>
      )}
      {gone.length > 0 && (
        <details className="site-trash" data-testid="site-trash">
          <summary>削除した記事（{gone.length} 件）</summary>
          <p className="hint">元に戻すと、下書きとして一覧に戻ります。</p>
          <ul className="site-post-list">
            {gone.map((p) => (
              <li key={p.id} className="site-post site-trash-post" data-testid="site-trash-post">
                <span className="site-post-title">{p.title.trim() || '（題名なし）'}</span>
                <span className="site-post-date">{dayOf(p.deletedAt)} に削除</span>
                <button type="button" className="secondary" disabled={busy !== null} aria-label={`「${p.title.trim() || '題名なし'}」を元に戻す`} onClick={() => void change(p.id, 'restore', p.title.trim() || '題名なし')} data-testid="site-trash-restore">
                  {busy === p.id ? '戻しています…' : '元に戻す'}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

type Draft = Pick<SiteEditorAccess, 'editors' | 'publishers'>;

/** Who may write and who may publish, for the access administrators. */
function AccessEditor({ onSaved }: { onSaved: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<SiteEditorAccessResponse>('GET', '/api/site-editor/access', undefined, signal);
    },
    [refresh],
  );
  const loaded = useLoader(load);
  const data = loaded.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [seen, setSeen] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');
  if (data && seen !== data.access.version) {
    setSeen(data.access.version);
    setDraft({ editors: data.access.editors, publishers: data.access.publishers });
  }
  const people = useMemo(() => {
    const q = filter.trim().normalize('NFKC').toLowerCase();
    return (data?.choices.people ?? []).filter((p) => !q || p.name.normalize('NFKC').toLowerCase().includes(q) || p.departments.some((d) => d.includes(q)));
  }, [data, filter]);
  if (loaded.error) return <p className="status error">書ける人・公開できる人を読み込めませんでした。{toFailure(loaded.error).message}</p>;
  if (!data || !draft) return null;

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const setEditors = (next: Partial<Draft['editors']>) => setDraft({ ...draft, editors: { ...draft.editors, ...next } });
  const setPublishers = (next: Partial<Draft['publishers']>) => setDraft({ ...draft, publishers: { ...draft.publishers, ...next } });
  const changed = JSON.stringify(draft) !== JSON.stringify({ editors: data.access.editors, publishers: data.access.publishers });

  async function save() {
    if (!draft || !data) return;
    setSaving(true);
    setMessage(null);
    try {
      await api<SiteEditorAccessResponse>('PUT', '/api/site-editor/access', { ...draft, expectedVersion: data.access.version });
      setMessage({ text: '保存しました。次に開いたときから効きます。', ok: true });
      setRefresh((n) => n + 1);
      onSaved();
    } catch (err) {
      setMessage({ text: toFailure(err).message, ok: false });
    } finally {
      setSaving(false);
    }
  }

  const chips = (name: string, all: string[], chosen: string[], onToggle: (v: string) => void, label: (v: string) => string = (v) => v) => (
    <div className="site-access-chips">
      {all.length === 0 && <span className="hint">候補がありません。</span>}
      {all.map((v) => (
        <label key={v} className="status-option">
          <input type="checkbox" name={name} checked={chosen.includes(v)} onChange={() => onToggle(v)} />
          {label(v)}
        </label>
      ))}
    </div>
  );
  const nameOf = new Map(data.choices.people.map((p) => [p.id, p.name]));
  // People chosen before who are no longer members stay listed, so they can be taken off.
  const peopleIds = (chosen: string[]) => [...new Set([...people.map((p) => p.id), ...chosen.filter((id) => !nameOf.has(id))])];
  const personLabel = (id: string) => nameOf.get(id) ?? '（委員でなくなった人）';

  return (
    <section className="site-access" aria-labelledby="site-access-title" data-testid="site-access">
      <h3 id="site-access-title">書ける人・公開できる人</h3>
      <p className="hint">権限管理者は、選ばなくても書くことと公開ができます。{data.access.updatedAt ? `最後の変更：${new Date(data.access.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}（${data.access.updatedByName ?? '不明'}）` : 'まだ画面から変えていません（サーバーの設定の値です）。'}</p>

      <fieldset className="site-access-group">
        <legend>書ける人</legend>
        <div className="site-access-chips">
          <label className="status-option">
            <input type="radio" name="site-editors-scope" checked={draft.editors.everyone} onChange={() => setEditors({ everyone: true })} />
            委員全員
          </label>
          <label className="status-option">
            <input type="radio" name="site-editors-scope" checked={!draft.editors.everyone} onChange={() => setEditors({ everyone: false })} />
            選んだ部局と人だけ
          </label>
        </div>
        {!draft.editors.everyone && (
          <>
            <p className="site-access-sub">部局</p>
            {chips('site-editor-dept', data.choices.departments, draft.editors.departments, (v) => setEditors({ departments: toggle(draft.editors.departments, v) }))}
            <p className="site-access-sub">人</p>
            {chips('site-editor-person', peopleIds(draft.editors.userIds), draft.editors.userIds, (v) => setEditors({ userIds: toggle(draft.editors.userIds, v) }), personLabel)}
          </>
        )}
      </fieldset>

      <fieldset className="site-access-group">
        <legend>公開できる人</legend>
        <p className="site-access-sub">部局（役員会など）</p>
        {chips('site-publisher-dept', data.choices.departments, draft.publishers.departments, (v) => setPublishers({ departments: toggle(draft.publishers.departments, v) }))}
        <p className="site-access-sub">人</p>
        {chips('site-publisher-person', peopleIds(draft.publishers.userIds), draft.publishers.userIds, (v) => setPublishers({ userIds: toggle(draft.publishers.userIds, v) }), personLabel)}
      </fieldset>

      <label className="site-access-filter">
        人の絞り込み
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="名前や部局で絞り込む" />
      </label>
      <div className="site-access-actions">
        <button type="button" onClick={() => void save()} disabled={!changed || saving} data-testid="site-access-save">
          {saving ? '保存しています…' : '保存する'}
        </button>
        {changed && (
          <button type="button" className="secondary" onClick={() => setDraft({ editors: data.access.editors, publishers: data.access.publishers })}>
            元に戻す
          </button>
        )}
      </div>
      {message && (
        <p className={`status ${message.ok ? 'info' : 'error'}`} role="status">
          {message.text}
        </p>
      )}
    </section>
  );
}
