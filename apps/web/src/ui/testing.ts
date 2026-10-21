// Test helpers for the kit's own tests (not exported from index.ts).
import { MotionGlobalConfig } from 'motion/react';

/** Makes motion finish every animation instantly, so exits unmount without waiting for frames. */
export function skipMotion(): void {
  MotionGlobalConfig.skipAnimations = true;
}

/** Overrides `window.matchMedia` with a controllable query list; returns a setter that fires `change`. */
export function mockMatchMedia(initial: Record<string, boolean>) {
  const state = { ...initial };
  const listeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>();
  const original = window.matchMedia;
  window.matchMedia = (query: string): MediaQueryList => ({
    get matches() { return state[query] ?? false; },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)!.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { listeners.get(query)?.delete(listener); },
    dispatchEvent: () => false
  }) as MediaQueryList;
  return {
    set(query: string, matches: boolean) {
      state[query] = matches;
      listeners.get(query)?.forEach(listener => listener({ matches, media: query } as MediaQueryListEvent));
    },
    restore() { window.matchMedia = original; }
  };
}
