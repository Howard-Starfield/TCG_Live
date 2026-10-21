import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystem(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(DARK_QUERY).matches);
}

/** Follows the operating system's light/dark setting. */
export function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeSystem, () => (systemPrefersDark() ? 'dark' : 'light'), () => 'light');
}

interface ThemeContextValue { theme: ThemePreference; resolved: ResolvedTheme }

const ThemeContext = createContext<ThemeContextValue>({ theme: 'system', resolved: 'light' });

export interface ThemeProviderProps {
  /** Controlled preference; storing it is the caller's job. */
  theme: ThemePreference;
  children: ReactNode;
  /** Element that receives the `.dark` class (default `document.documentElement`). */
  target?: HTMLElement | null;
}

/** Applies `.dark` to the target element for the resolved theme and removes it on unmount. */
export function ThemeProvider({ theme, children, target }: ThemeProviderProps) {
  const system = useSystemTheme();
  const resolved: ResolvedTheme = theme === 'system' ? system : theme;

  useLayoutEffect(() => {
    const element = target === undefined ? document.documentElement : target;
    if (!element) return;
    element.classList.toggle('dark', resolved === 'dark');
    element.dataset.theme = resolved;
    return () => {
      element.classList.remove('dark');
      delete element.dataset.theme;
    };
  }, [resolved, target]);

  const value = useMemo(() => ({ theme, resolved }), [theme, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The theme actually shown: the preference, with `system` resolved. */
export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeContext).resolved;
}

/** The current preference as passed to ThemeProvider. */
export function useThemePreference(): ThemePreference {
  return useContext(ThemeContext).theme;
}
