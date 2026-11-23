import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SiteEditorAccess, SiteEditorAccessResponse, SiteEditorMetaResponse } from '../../../shared/site-editor';
import { api, toFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { Facts } from '../books/common';
import './site-editor.css';

/**
 * The website (blog) editor (2026-11-23): where to open it, what this person may do there, and for the access
 * administrators who may write and who may publish. Listed only for people who may write (and access administrators),
 * once the server says the editor is on; nobody else sees it. The editor opens in a tab of its own (WebGenEngine,
 * behind this app: docs/site-editor.md).
 */
export function SiteEditorPanel({ onAvailable }: { onAvailable?: (available: boolean) => void }) {
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
  // A server without the editor (404), an error, or a person who may not write: no part at all, never an error.
  const absent = meta.error !== null || (!!m && (!m.enabled || (!m.canEdit && !m.canAdminister)));
  const known = !meta.loading || m !== null;
  useEffect(() => {
    if (known) onAvailable?.(!absent);
  }, [known, absent, onAvailable]);
  if (absent || !m) return null;
  return (
    <section aria-labelledby="site-editor-title" data-testid="site-editor-panel">
      <h3 id="site-editor-title">Webサイト（ブログ）</h3>
      <p className="hint">委員会の Webサイトのブログを書いて公開します。書いた内容は自動で下書きに保存され、「公開」を押すまでサイトには出ません。</p>
      <Facts
        items={[
          ['できること', m.canPublish ? '書くことと公開（公開の取り消しも）' : m.canEdit ? '書くことだけ（公開は、公開できる人か権限管理者が行います）' : null],
          [
            '公開先',
            m.siteUrl ? (
              <a href={m.siteUrl} target="_blank" rel="noopener noreferrer">
                {m.siteUrl}
              </a>
            ) : null,
          ],
        ]}
      />
      {m.editorUrl && (
        <p>
          <a className="button" href={m.editorUrl} target="_blank" rel="noopener" data-testid="site-editor-open">
            ブログを書く
          </a>
        </p>
      )}
      <p className="hint">エディタは別のタブで開きます。記事の一覧から書き始め、題名・日付・画像もエディタで直せます。</p>
      {m.canAdminister && <AccessEditor onSaved={() => setRefresh((n) => n + 1)} />}
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
      <h4 id="site-access-title">書ける人・公開できる人</h4>
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
