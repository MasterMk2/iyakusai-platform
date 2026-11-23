import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { type NavBuiltEntry, type NavBuiltGroup, type NavBuiltItem, type NavGroupKey, type NavKey } from '../navLayout';
import { nextTheme, storeTheme, THEME_LABELS, useTheme } from '../theme';
import { ServerBadge } from './ServerBadge';

/**
 * Common frame of every screen: the navy header and one row of module tabs, two of them menus (2026-11-23,
 * ../navLayout.ts). The rental phone screens (src/rental-web/index.html, supplies.html) repeat the same header and
 * tabs in plain HTML, so moving between modules looks and works the same everywhere (../docs/ui-guidelines.md).
 */

export type { NavKey } from '../navLayout';

export interface NavTarget {
  href: string;
  /** In-app hash route; absent for a separate page (the rental screen). */
  onSelect?: () => void;
}

export type NavEntry = NavBuiltEntry<NavTarget>;

const ICONS: Record<NavKey, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h5v-6h3v6h5V9.5" />,
  // A notice board on a stand, with a notice's lines (2026-11-11).
  board: <path d="M4.5 4.5h15v11h-15zM12 15.5v5M8.5 20.5h7M8 8.5h8M8 11.5h5" />,
  tasks: <path d="M10 6.5h10M10 12h10M10 17.5h10M3.5 6.5l1.5 1.5 2.5-3M3.5 12l1.5 1.5 2.5-3M3.5 17.5 5 19l2.5-3" />,
  rental: <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4zM3.5 7.5 12 11.5l8.5-4M12 11.5v9" />,
  inbox: <path d="M3.5 13.5 6.5 5h11l3 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1zM3.5 13.5h5l1.5 2.5h4l1.5-2.5h5" />,
  // A round speech balloon with lines of text, apart from the Bot's square one (2026-11-03).
  line: <path d="M12 4c-4.7 0-8.5 3-8.5 6.8 0 3.3 2.9 6 6.8 6.6L9.5 20.5l3.9-3.1c4-.5 7.1-3.3 7.1-6.6C20.5 7 16.7 4 12 4zM8 9.5h8M8 12.5h5" />,
  // An address book: a person on a card with tabs at the edge (2026-10-26).
  contacts: <path d="M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5zM2.5 8h2M2.5 12h2M2.5 16h2M12 11.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM8 16.5c.7-2 2.2-3 4-3s3.3 1 4 3" />,
  // A receipt with a torn edge and lines (2026-11-05).
  books: <path d="M6 3.5h12v17l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5zM9 8h6M9 11.5h6M9 15h4" />,
  bot: <path d="M4.5 6.5h15a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-8.5L7 20.5V17h-2.5A1.5 1.5 0 0 1 3 15.5V8a1.5 1.5 0 0 1 1.5-1.5zM8 12h.01M12 12h.01M16 12h.01" />,
  // A globe (Webサイト, 2026-11-23). The rental screen draws the same path.
  site: <path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.2 2.3 3.4 5.2 3.4 8.5s-1.2 6.2-3.4 8.5M12 3.5C9.8 5.8 8.6 8.7 8.6 12s1.2 6.2 3.4 8.5" />,
  // A padlock (パスワード帳, 2026-11-23). The rental screen draws the same path.
  vault: <path d="M6.5 10.5h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3M12 14.5v2.5" />,
  settings: <path d="M4 7h9m4 0h3M4 17h3m4 0h9M15 4.5v5M9 14.5v5" />,
};

// The two menus (2026-11-23). The rental screens draw the same paths.
const GROUP_ICONS: Record<NavGroupKey, ReactNode> = {
  // Two speech balloons, one behind the other (連絡).
  contact: <path d="M4 4.5h10a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H8.5L5 16v-3H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1zM18 9h2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-1v3l-3.5-3H11a1 1 0 0 1-1-1V16" />,
  // A briefcase (運営).
  ops: <path d="M4 8h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM9 8V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V8M3 13.5h18" />,
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function NavIcon({ name }: { name: NavKey }) {
  return <Icon>{ICONS[name]}</Icon>;
}

export function Brand() {
  return (
    <a className="brand" href="#/home">
      <span>医薬祭</span>
      <strong>委員会アプリ</strong>
    </a>
  );
}

/**
 * Header without a signed-in user (test and demo modes add their own bar below it). `serverStatus`: a signed-in
 * member's screen, which shows the server's state on a PC (ServerBadge, 2026-11-21).
 */
export function Masthead({ children, serverStatus = false }: { children?: ReactNode; serverStatus?: boolean }) {
  return (
    <header className="masthead">
      <Brand />
      <div className="masthead-tools">
        {serverStatus && <ServerBadge />}
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

function NavLink({ item, current, onPicked }: { item: NavBuiltItem<NavTarget>; current: NavKey | null; onPicked: () => void }) {
  const select = (e: MouseEvent<HTMLAnchorElement>) => {
    onPicked();
    if (!item.target.onSelect || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    item.target.onSelect();
  };
  return (
    <a href={item.target.href} data-testid={`nav-${item.key}`} aria-current={item.key === current ? 'page' : undefined} onClick={select}>
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
  );
}

/**
 * A menu among the tabs (2026-11-23): a button that shows and hides a list of links (a disclosure, not an ARIA
 * menu), so the links keep working as links (a new tab with Ctrl, the address on hover). Marked like a tab when the
 * page shown is one of its links.
 */
function NavMenu({ group, current, open, onToggle, onClose, toggleRef }: {
  group: NavBuiltGroup<NavTarget>;
  current: NavKey | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  toggleRef: (button: HTMLButtonElement | null) => void;
}) {
  const here = group.items.find((item) => item.key === current);
  const id = `nav-menu-${group.group}`;
  return (
    <li
      className={`nav-group${here ? ' is-current' : ''}`}
      data-group={group.group}
      onBlur={(e) => {
        // Tabbing past the last link closes it. A click elsewhere moves focus nowhere (null) and lands on the scrim.
        const next = e.relatedTarget;
        if (open && next instanceof Node && !e.currentTarget.contains(next)) onClose();
      }}
    >
      <button type="button" className="nav-group-toggle" ref={toggleRef} aria-expanded={open} aria-controls={id} data-testid={`nav-group-${group.group}`} onClick={onToggle}>
        <Icon>{GROUP_ICONS[group.group]}</Icon>
        <span>
          {group.label}
          {here && <span className="sr-only">（表示中：{here.label}）</span>}
          <svg className="nav-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      <ul id={id} className="nav-menu" hidden={!open}>
        {group.items.map((item) => (
          <li key={item.key}>
            <NavLink item={item} current={current} onPicked={onClose} />
          </li>
        ))}
      </ul>
    </li>
  );
}

export function GlobalNav({ entries, current }: { entries: NavEntry[]; current: NavKey | null }) {
  // The open menu belongs to the page it was opened on: moving to another page closes it.
  const [menu, setMenu] = useState<{ group: NavGroupKey; at: NavKey | null } | null>(null);
  const open = menu && menu.at === current ? menu.group : null;
  const toggles = useRef(new Map<NavGroupKey, HTMLButtonElement>());
  const close = () => setMenu(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      toggles.current.get(open)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <nav className="global-nav" aria-label="機能">
      <ul>
        {entries.map((entry) =>
          'group' in entry ? (
            <NavMenu
              key={entry.group}
              group={entry}
              current={current}
              open={open === entry.group}
              onToggle={() => setMenu(open === entry.group ? null : { group: entry.group, at: current })}
              onClose={close}
              toggleRef={(button) => {
                if (button) toggles.current.set(entry.group, button);
                else toggles.current.delete(entry.group);
              }}
            />
          ) : (
            <li key={entry.key}>
              <NavLink item={entry} current={current} onPicked={close} />
            </li>
          ),
        )}
      </ul>
      {/* While a menu is open, a press anywhere else closes it and does nothing more (no button under it fires). */}
      {open && <div className="nav-scrim" data-testid="nav-scrim" aria-hidden="true" onClick={close} />}
    </nav>
  );
}
