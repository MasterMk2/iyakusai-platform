import { useSyncExternalStore } from 'react';

// The colour theme (2026-10-28): 若葉 (the default), light or dark, or follow the device (light or
// dark). Kept only in this browser; reading or writing may fail (private windows, blocked storage), and
// the page then shows 若葉. This sets data-theme on <html>; styles.css does the rest.
const THEME_KEY = 'iyakusai.theme';

export type ThemeChoice = 'wakaba' | 'light' | 'dark' | 'system';

export const THEME_LABELS: Record<ThemeChoice, string> = {
  wakaba: '若葉',
  light: 'ライト',
  dark: 'ダーク',
  system: '端末の設定に合わせる',
};

/** The order the header's button steps through; 端末に合わせる is chosen only in 設定. */
const HEADER_CYCLE: ThemeChoice[] = ['wakaba', 'light', 'dark'];

// The header's colour in each theme, for the phone's status bar (index.html starts with 若葉).
const HEADER_COLOR = { wakaba: '#2e5e2a', light: '#163960', dark: '#0b1826' } as const;

const isChoice = (value: string | null): value is ThemeChoice => value === 'wakaba' || value === 'light' || value === 'dark' || value === 'system';

export function storedTheme(): ThemeChoice {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    return isChoice(theme) ? theme : 'wakaba';
  } catch {
    return 'wakaba';
  }
}

// The header and 設定 both show the choice; a change in one redraws the other.
const listeners = new Set<() => void>();
let current: ThemeChoice = 'wakaba';

export function storeTheme(theme: ThemeChoice): void {
  try {
    if (theme === 'wakaba') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not kept; it lasts until the page is reloaded.
  }
  applyTheme(theme);
}

/** The theme after this one on the header's button. */
export function nextTheme(theme: ThemeChoice): ThemeChoice {
  const at = HEADER_CYCLE.indexOf(theme);
  return HEADER_CYCLE[(at + 1) % HEADER_CYCLE.length]!;
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

const darkQuery = (): MediaQueryList | null => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function applyTheme(theme: ThemeChoice = storedTheme()): void {
  current = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const shown = theme === 'system' ? (darkQuery()?.matches === true ? 'dark' : 'light') : theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', HEADER_COLOR[shown]);
  for (const listener of listeners) listener();
}

/** Apply the stored choice before the first render and keep the status bar in step with the device. */
export function startTheme(): void {
  applyTheme();
  darkQuery()?.addEventListener('change', () => {
    if (current === 'system') applyTheme('system');
  });
}
