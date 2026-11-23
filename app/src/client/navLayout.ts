/**
 * The module tabs' order and grouping (2026-11-23). Eleven tabs no longer fitted: two rows below about 1100px, and
 * 34px tabs with 12px labels on a phone. The ones used every day stay tabs; the rest sit in two menus whose names
 * stay on screen (連絡, 運営). App.tsx builds the tabs from this list, and tests/unit/nav-consistency.test.ts holds
 * the rental screens' HTML (src/rental-web/index.html, supplies.html) to it. Rules: ../../docs/ui-guidelines.md §2.
 */

export type NavKey = 'home' | 'board' | 'tasks' | 'rental' | 'inbox' | 'line' | 'contacts' | 'books' | 'bot' | 'site' | 'vault' | 'settings';
export type NavGroupKey = 'contact' | 'ops';

export interface NavLayoutItem {
  key: NavKey;
  label: string;
  /**
   * Where a narrow phone may wrap the label. The parts join to `label`; the tabs never break inside a part. The
   * rental screens write the same break as <wbr>.
   */
  labelBreaks?: readonly string[];
}

export interface NavLayoutGroup {
  group: NavGroupKey;
  label: string;
  items: readonly NavLayoutItem[];
}

export type NavLayoutEntry = NavLayoutItem | NavLayoutGroup;

export const NAV_LAYOUT: readonly NavLayoutEntry[] = [
  { key: 'home', label: 'ホーム' },
  { key: 'tasks', label: 'タスク' },
  // The tab is "メール", not "メールボックス": mail is sent from here too. The mailboxes inside it are each a "受信箱".
  { key: 'inbox', label: 'メール' },
  {
    group: 'contact',
    label: '連絡',
    items: [
      // The official LINE has its own place (2026-11-03): its people, counts and sending differ from mail's.
      { key: 'line', label: '公式LINE', labelBreaks: ['公式', 'LINE'] },
      { key: 'contacts', label: '連絡先' },
      // 掲示板 (2026-11-11): the committee's notices (what is new on it also shows on home).
      { key: 'board', label: '掲示板' },
      // Webサイト (2026-11-23): the committee's site and blog, for the people who may write and the access administrators.
      { key: 'site', label: 'Webサイト', labelBreaks: ['Web', 'サイト'] },
    ],
  },
  {
    group: 'ops',
    label: '運営',
    items: [
      // 会計 (2026-11-05): every member's reimbursement claims, and the books for the accounting section.
      { key: 'books', label: '会計' },
      // Absent while rental is stopped (設定 › 使う機能).
      { key: 'rental', label: '物品貸出', labelBreaks: ['物品', '貸出'] },
      // パスワード帳 (2026-11-23): only for the people who can open it.
      { key: 'vault', label: 'パスワード帳', labelBreaks: ['パス', 'ワード帳'] },
    ],
  },
  { key: 'bot', label: 'Bot' },
  { key: 'settings', label: '設定' },
];

export function isNavGroup(entry: NavLayoutEntry): entry is NavLayoutGroup {
  return 'group' in entry;
}

/**
 * Fills the layout with what each tab opens; a key mapped to null is left out (rental stopped, no password book).
 * A menu left with one entry shows that entry as a plain tab (a menu of one is a needless second press), and an
 * empty one is dropped.
 */
export type NavBuiltItem<T> = NavLayoutItem & { target: T };
export interface NavBuiltGroup<T> {
  group: NavGroupKey;
  label: string;
  items: Array<NavBuiltItem<T>>;
}
export type NavBuiltEntry<T> = NavBuiltItem<T> | NavBuiltGroup<T>;

export function buildNav<T>(targets: Record<NavKey, T | null>): Array<NavBuiltEntry<T>> {
  const fill = (item: NavLayoutItem): NavBuiltItem<T> | null => {
    const target = targets[item.key];
    return target === null ? null : { ...item, target };
  };
  return NAV_LAYOUT.flatMap((entry): Array<NavBuiltEntry<T>> => {
    if (!isNavGroup(entry)) {
      const item = fill(entry);
      return item ? [item] : [];
    }
    const items = entry.items.map(fill).filter((item): item is NavBuiltItem<T> => item !== null);
    if (items.length <= 1) return items;
    return [{ group: entry.group, label: entry.label, items }];
  });
}
