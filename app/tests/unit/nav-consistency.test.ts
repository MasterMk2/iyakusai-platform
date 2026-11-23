import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomUtils, parseDocument } from 'htmlparser2';
import type { Element, Node } from 'domhandler';
import { describe, expect, it } from 'vitest';
import { buildNav, isNavGroup, NAV_LAYOUT, type NavKey, type NavLayoutItem } from '../../src/client/navLayout.js';

// The module tabs are written twice: the React header (src/client/navLayout.ts, drawn by AppShell.tsx) and the plain
// HTML of the rental screens (src/rental-web/index.html and supplies.html). Same names, same order, same menus, or
// the tabs drift apart (../docs/ui-guidelines.md §2). The rental screens have no route in this composition, so
// this is static.
const ROOT = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const RENTAL_PAGES = ['src/rental-web/index.html', 'src/rental-web/supplies.html'];

// Where each tab goes from the rental screens (the app uses the same addresses without the leading slash).
const RENTAL_HREF: Record<NavKey, string> = {
  home: '/#/home',
  tasks: '/#/tasks',
  inbox: '/#/all',
  line: '/#/line',
  contacts: '/#/contacts',
  board: '/#/board',
  books: '/#/books',
  rental: '/rental',
  vault: '/#/vault',
  bot: '/#/bot',
  site: '/#/site',
  settings: '/#/settings',
};

interface LinkShape {
  label: string;
  href: string;
  markup: string;
}
type Shape = LinkShape | { group: string; label: string; items: LinkShape[] };

const elements = (nodes: Node[]) => nodes.filter((n): n is Element => n.type === 'tag');
const child = (el: Element, name: string) => elements(el.children).find((c) => c.name === name);
// A label's own text: the <span>'s text nodes and <wbr>, without the hidden "表示中" note or the chevron.
const ownLabel = (span: Element) =>
  span.children.map((n) => (n.type === 'text' ? DomUtils.textContent(n) : n.type === 'tag' && (n as Element).name === 'wbr' ? '<wbr>' : '')).join('');
const link = (li: Element): LinkShape => {
  const a = child(li, 'a')!;
  const markup = ownLabel(child(a, 'span')!);
  return { label: markup.replace(/<wbr>/g, ''), href: a.attribs.href!, markup };
};

function rentalShape(path: string): Shape[] {
  const doc = parseDocument(read(path));
  const nav = DomUtils.findOne((el) => el.name === 'nav' && el.attribs.class === 'global-nav', doc.children);
  expect(nav, path).toBeTruthy();
  return elements(child(nav!, 'ul')!.children).map((li): Shape => {
    if (!li.attribs.class?.split(' ').includes('nav-group')) return link(li);
    const button = child(li, 'button')!;
    const menu = child(li, 'ul')!;
    // A disclosure: the button names the list it shows, which starts hidden (nav.js opens it).
    expect(button.attribs.type).toBe('button');
    expect(button.attribs['aria-expanded']).toBe('false');
    expect(button.attribs['aria-controls']).toBe(menu.attribs.id);
    expect(menu.attribs.id).toBe(`nav-menu-${li.attribs['data-group']}`);
    expect(menu.attribs).toHaveProperty('hidden');
    return { group: li.attribs['data-group']!, label: ownLabel(child(button, 'span')!), items: elements(menu.children).map(link) };
  });
}

const markupOf = (item: NavLayoutItem) => (item.labelBreaks ? item.labelBreaks.join('<wbr>') : item.label);
const layoutShape = (): Shape[] =>
  NAV_LAYOUT.map((entry) =>
    isNavGroup(entry)
      ? { group: entry.group, label: entry.label, items: entry.items.map((item) => ({ label: item.label, href: RENTAL_HREF[item.key], markup: markupOf(item) })) }
      : { label: entry.label, href: RENTAL_HREF[entry.key], markup: markupOf(entry) },
  );

describe('module tabs on every screen', () => {
  it('the tabs used every day are tabs, the rest sit in the 連絡 and 運営 menus (2026-11-23)', () => {
    const names = NAV_LAYOUT.map((entry) => (isNavGroup(entry) ? `${entry.label}: ${entry.items.map((i) => i.label).join('・')}` : entry.label));
    expect(names).toEqual(['ホーム', 'タスク', 'メール', '連絡: 公式LINE・連絡先・掲示板・Webサイト', '運営: 会計・物品貸出・パスワード帳', 'Bot', '設定']);
    // Every module appears once.
    const keys = NAV_LAYOUT.flatMap((entry) => (isNavGroup(entry) ? entry.items.map((i) => i.key) : [entry.key]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(Object.keys(RENTAL_HREF).length);
  });

  it('the app and both rental screens show the same tabs and menus in the same order, with the same addresses and breaks', () => {
    for (const page of RENTAL_PAGES) expect(rentalShape(page), page).toEqual(layoutShape());
    // The rental screens show their own page as current, inside the 運営 menu, which is marked too.
    for (const page of RENTAL_PAGES) {
      const html = read(page);
      expect(html).toContain('<li class="nav-group is-current" data-group="ops">');
      expect(html).toContain('<span class="sr-only">（表示中：物品貸出）</span>');
      expect(html).toContain('<a href="/rental" aria-current="page" data-leave>');
      expect(html).toContain('<script src="/rental/nav.js" defer></script>');
    }
  });

  it('a menu left with one link shows it as a tab, and an empty menu goes', () => {
    const all = Object.fromEntries(Object.keys(RENTAL_HREF).map((k) => [k, k])) as Record<NavKey, string>;
    const shown = (targets: Record<NavKey, string | null>) => buildNav(targets).map((e) => ('group' in e ? `${e.label}▾` : e.label));
    expect(shown(all)).toEqual(['ホーム', 'タスク', 'メール', '連絡▾', '運営▾', 'Bot', '設定']);
    // Rental stopped: the menu stays (会計 and パスワード帳).
    expect(shown({ ...all, rental: null })).toEqual(['ホーム', 'タスク', 'メール', '連絡▾', '運営▾', 'Bot', '設定']);
    // Rental stopped and no password book: 会計 alone, as a tab in the menu's place.
    expect(shown({ ...all, rental: null, vault: null })).toEqual(['ホーム', 'タスク', 'メール', '連絡▾', '会計', 'Bot', '設定']);
    expect(shown({ ...all, books: null, rental: null, vault: null })).toEqual(['ホーム', 'タスク', 'メール', '連絡▾', 'Bot', '設定']);
  });

  it('the パスワード帳 link is hidden on the rental screens until the server says the person can open it', () => {
    for (const page of RENTAL_PAGES) expect(read(page)).toContain('<li hidden data-vault-tab><a href="/#/vault" data-leave>');
    for (const script of ['src/rental-web/app.js', 'src/rental-web/supplies.js']) expect(read(script)).toMatch(/meta\.enabled === true && meta\.canOpen === true/);
  });

  it('the Webサイト link is hidden on the rental screens until the server says the person may write', () => {
    for (const page of RENTAL_PAGES) expect(read(page)).toContain('<li hidden data-site-tab><a href="/#/site" data-leave>');
    for (const script of ['src/rental-web/app.js', 'src/rental-web/supplies.js']) expect(read(script)).toMatch(/meta\.enabled === true && \(meta\.canEdit === true \|\| meta\.canAdminister === true\)/);
  });

  it('a temporary staff member keeps the rental tab alone, out of its menu', () => {
    expect(read('src/rental-web/app.js')).toContain("only.append(tabs.querySelector('a[href=\"/rental\"]')); tabs.replaceChildren(only);");
  });

  it('labels wrap only at their set break, and both style sheets keep Japanese words whole at 14px', () => {
    for (const css of ['src/client/styles.css', 'src/rental-web/styles.css']) {
      expect(read(css)).toMatch(/word-break: ?keep-all/);
      // Seven tabs fit a 320px phone at 14px: the 12–13px fallbacks of ten or eleven tabs are gone.
      expect(read(css)).not.toMatch(/\.global-nav a ?\{[^}]*font-size: ?1[23]px/);
    }
  });

  it('the rental screen bumps its service worker cache to a name no earlier release or parallel branch used, and keeps nav.js offline', () => {
    const worker = read('src/rental-web/sw.js');
    const cache = /const CACHE = '([^']+)'/.exec(worker)![1];
    expect(worker).toContain("'/rental/nav.js'");
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
      'iyakusai-rental-shell-20261123-v27-site-tab',
      // The first push of the grouped tabs (PR branch only).
      'iyakusai-rental-shell-20261123-v27-nav-menus',
    ]).not.toContain(cache);
  });
});
