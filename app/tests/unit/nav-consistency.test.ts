import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The module tabs are written twice: the React header (src/client/App.tsx, navItems) and the plain HTML
// of the rental phone screen (src/rental-web/index.html). Same labels, same order, or the tabs drift apart
// (../docs/ui-guidelines.md §2). The rental screen has no route in this composition, so this is static.
const ROOT = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('module tabs on every screen', () => {
  it('the app and the rental screen show the same tabs in the same order, with the Bot tab before settings', () => {
    const app = [...read('src/client/App.tsx').matchAll(/key: '[a-z]+', label: '([^']+)'/g)].map((m) => m[1]);
    const navBlock = /<nav class="global-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(read('src/rental-web/index.html'));
    expect(navBlock).not.toBeNull();
    const rental = [...navBlock![1]!.matchAll(/<span>(.*?)<\/span>/g)].map((m) => m[1]!.replace(/<wbr>/g, ''));
    // パスワード帳 (2026-11-23) is in both lists, before 設定; both screens show it only to the people who can open it.
    // Webサイト (2026-11-23) too, before パスワード帳; both screens show it only to the people who may write.
    expect(app).toEqual(['ホーム', '掲示板', 'タスク', '物品貸出', 'メール', '公式LINE', '連絡先', '会計', 'Bot', 'Webサイト', 'パスワード帳', '設定']);
    expect(rental).toEqual(app);
  });

  it('the パスワード帳 tab is hidden on the rental screen until the server says the person can open it, and wraps the same way', () => {
    const html = read('src/rental-web/index.html');
    expect(html).toContain('<li hidden data-vault-tab><a href="/#/vault" data-leave>');
    expect(html).toContain('<span>パス<wbr>ワード帳</span>');
    expect(read('src/client/App.tsx')).toMatch(/label: 'パスワード帳', labelBreaks: \['パス', 'ワード帳'\]/);
    for (const script of ['src/rental-web/app.js', 'src/rental-web/supplies.js']) expect(read(script)).toMatch(/meta\.enabled === true && meta\.canOpen === true/);
  });

  it('the Webサイト tab is hidden on the rental screen until the server says the person may write, and wraps the same way', () => {
    const html = read('src/rental-web/index.html');
    expect(html).toContain('<li hidden data-site-tab><a href="/#/site" data-leave>');
    expect(html).toContain('<span>Web<wbr>サイト</span>');
    expect(read('src/client/App.tsx')).toMatch(/label: 'Webサイト', labelBreaks: \['Web', 'サイト'\]/);
    for (const script of ['src/rental-web/app.js', 'src/rental-web/supplies.js']) expect(read(script)).toMatch(/meta\.enabled === true && \(meta\.canEdit === true \|\| meta\.canAdminister === true\)/);
  });

  it('a long label wraps only where both screens allow it (物品 | 貸出 on a 320px phone)', () => {
    const breaks = /label: '物品貸出', labelBreaks: \[([^\]]+)\]/.exec(read('src/client/App.tsx'));
    expect(breaks).not.toBeNull();
    const parts = [...breaks![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(parts).toEqual(['物品', '貸出']);
    expect(read('src/rental-web/index.html')).toContain('<span>物品<wbr>貸出</span>');
    // "メール" (2026-10-26; "メール | ボックス" before) is short enough not to wrap.
    expect(read('src/rental-web/index.html')).toContain('<span>メール</span>');
    for (const css of ['src/client/styles.css', 'src/rental-web/styles.css']) expect(read(css)).toMatch(/word-break: ?keep-all/);
  });

  it('the rental screen bumps its service worker cache to a name no earlier release or parallel branch used', () => {
    const cache = /const CACHE = '([^']+)'/.exec(read('src/rental-web/sw.js'))![1];
    // The prefix is how sw.js deletes old shells on activate; a reused name would keep phones on the old tabs.
    expect(cache).toMatch(/^iyakusai-rental-shell-/);
    expect([
      'iyakusai-rental-shell-20261013-v5',
      'iyakusai-rental-shell-20261014-v6',
      'iyakusai-rental-shell-20261014-v7-reader',
      'iyakusai-rental-shell-20261014-v8-drive',
      'iyakusai-rental-shell-20261014-v8-botnav',
      'iyakusai-rental-shell-20261015-v18-reread-scan-layout',
      // Shipped as overlays on the running image (10/18–10/20), not in this source.
      'iyakusai-rental-shell-20261018-info-select-v1',
      'iyakusai-rental-shell-20261018-info-select-v2',
      'iyakusai-rental-shell-20261025-v19-mailbox-tab',
      'iyakusai-rental-shell-20261026-v20-mail-tab',
      'iyakusai-rental-shell-20261026-v21-contacts-tab',
      'iyakusai-rental-shell-20261104-v22-supplies',
      'iyakusai-rental-shell-20261105-v23-books-tab',
      'iyakusai-rental-shell-20261109-v24-paused',
      'iyakusai-rental-shell-20261111-v25-board-tab',
      'iyakusai-rental-shell-20261123-v26-vault-tab',
    ]).not.toContain(cache);
  });
});
