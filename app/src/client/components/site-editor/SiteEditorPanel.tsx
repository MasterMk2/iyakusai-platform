import { useCallback, useEffect } from 'react';
import type { SiteEditorMetaResponse } from '../../../shared/site-editor';
import { api } from '../../api';
import { useLoader } from '../../useLoader';
import { Facts } from '../books/common';

/**
 * The website editor (2026-11-23): where to open it, and what this person may do there. Listed only for the people
 * site-editor.json names (and access administrators), once the server says the editor is on; nobody else sees it.
 * The editor itself opens in a tab of its own (WebGenEngine, behind this app: docs/site-editor.md).
 */
export function SiteEditorPanel({ onAvailable }: { onAvailable?: (available: boolean) => void }) {
  const load = useCallback((signal: AbortSignal) => api<SiteEditorMetaResponse>('GET', '/api/site-editor/meta', undefined, signal), []);
  const meta = useLoader(load);
  const m = meta.data;
  // A server without the editor (404), an error, or a person it does not name: no part at all, never an error.
  const absent = meta.error !== null || (!!m && (!m.enabled || !m.canEdit || !m.editorUrl));
  const known = !meta.loading || m !== null;
  useEffect(() => {
    if (known) onAvailable?.(!absent);
  }, [known, absent, onAvailable]);
  if (absent || !m?.editorUrl) return null;
  return (
    <section aria-labelledby="site-editor-title" data-testid="site-editor-panel">
      <h3 id="site-editor-title">Webサイト</h3>
      <p className="hint">委員会の Webサイトのページを、画面の上で直接書き換えて公開します。書いた内容は自動で下書きに保存され、「公開」を押すまでサイトには出ません。</p>
      <Facts
        items={[
          ['できること', m.canPublish ? '編集と公開（公開の取り消しも）' : '編集だけ（公開は、公開の権限を持つ人か権限管理者が行います）'],
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
      <p>
        <a className="button" href={m.editorUrl} target="_blank" rel="noopener" data-testid="site-editor-open">
          エディタを開く
        </a>
      </p>
      <p className="hint">エディタは別のタブで開きます。編集の権限は、権限管理者がサーバーの設定（site-editor.json）で決めています。</p>
    </section>
  );
}
