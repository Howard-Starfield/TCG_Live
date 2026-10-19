import { useCallback, useSyncExternalStore } from 'react';

/** True while the media query matches; follows changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener?.('change', onChange);
    window.addEventListener('resize', onChange);
    return () => {
      list.removeEventListener?.('change', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, [query]);
  const read = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, read, () => false);
}

/** Below this width the preview dock becomes an overlay sheet. */
export const NARROW_QUERY = '(max-width: 1099.98px)';
