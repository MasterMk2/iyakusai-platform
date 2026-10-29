import { Fragment, type MouseEvent, type ReactNode } from 'react';
import { nextTheme, storeTheme, THEME_LABELS, useTheme } from '../theme';

/**
 * Common frame of every screen: the navy header and one row of module tabs. The rental phone screen
 * (src/rental-web/index.html) repeats the same header and tabs in plain HTML, so moving between modules
 * looks and works the same everywhere (../docs/ui-guidelines.md).
 */

export type NavKey = 'home' | 'tasks' | 'rental' | 'inbox' | 'contacts' | 'bot' | 'settings';

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  /**
   * Where a narrow phone may wrap the label (six tabs at 320px leave about 50px each). The parts join to
   * `label`; the tabs never break inside a part. The rental screen writes the same break as <wbr>.
   */
  labelBreaks?: string[];
  /** In-app hash route; absent for a separate page (the rental screen). */
  onSelect?: () => void;
}

const ICONS: Record<NavKey, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h5v-6h3v6h5V9.5" />,
  tasks: <path d="M10 6.5h10M10 12h10M10 17.5h10M3.5 6.5l1.5 1.5 2.5-3M3.5 12l1.5 1.5 2.5-3M3.5 17.5 5 19l2.5-3" />,
  rental: <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4zM3.5 7.5 12 11.5l8.5-4M12 11.5v9" />,
  inbox: <path d="M3.5 13.5 6.5 5h11l3 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1zM3.5 13.5h5l1.5 2.5h4l1.5-2.5h5" />,
  // An address book: a person on a card with tabs at the edge (2026-10-26).
  contacts: <path d="M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5zM2.5 8h2M2.5 12h2M2.5 16h2M12 11.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM8 16.5c.7-2 2.2-3 4-3s3.3 1 4 3" />,
  bot: <path d="M4.5 6.5h15a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-8.5L7 20.5V17h-2.5A1.5 1.5 0 0 1 3 15.5V8a1.5 1.5 0 0 1 1.5-1.5zM8 12h.01M12 12h.01M16 12h.01" />,
  settings: <path d="M4 7h9m4 0h3M4 17h3m4 0h9M15 4.5v5M9 14.5v5" />,
};

export function NavIcon({ name }: { name: NavKey }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

export function Brand() {
  return (
    <a className="brand" href="#/home">
      <span>医薬祭</span>
      <strong>委員会アプリ</strong>
    </a>
  );
}

/** Header without a signed-in user (test and demo modes add their own bar below it). */
export function Masthead({ children }: { children?: ReactNode }) {
  return (
    <header className="masthead">
      <Brand />
      <div className="masthead-tools">
        <ThemeToggle />
        {children}
      </div>
    </header>
  );
}

/**
 * The colour theme in the header (2026-10-28): each press moves 若葉 → ライト → ダーク. 設定 › 画面の色
 * offers the same three and 端末の設定に合わせる. A phone shows only the colour dot.
 */
function ThemeToggle() {
  const theme = useTheme();
  const next = nextTheme(theme);
  const name = theme === 'system' ? '自動' : THEME_LABELS[theme];
  return (
    <button
      type="button"
      className="theme-toggle"
      data-testid="theme-toggle"
      aria-label={`画面の色: ${name}（押すと${THEME_LABELS[next]}）`}
      title={`押すと${THEME_LABELS[next]}に切り替えます`}
      onClick={() => storeTheme(next)}
    >
      <span className={`theme-dot theme-dot-${theme}`} aria-hidden="true" />
      <span className="theme-toggle-label" aria-hidden="true">
        {name}
      </span>
    </button>
  );
}

export function GlobalNav({ items, current }: { items: NavItem[]; current: NavKey | null }) {
  const select = (item: NavItem) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (!item.onSelect || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    item.onSelect();
  };
  return (
    <nav className="global-nav" aria-label="機能">
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <a href={item.href} data-testid={`nav-${item.key}`} aria-current={item.key === current ? 'page' : undefined} onClick={select(item)}>
              <NavIcon name={item.key} />
              <span>
                {item.labelBreaks
                  ? item.labelBreaks.map((part, i) => (
                      <Fragment key={i}>
                        {i > 0 && <wbr />}
                        {part}
                      </Fragment>
                    ))
                  : item.label}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
