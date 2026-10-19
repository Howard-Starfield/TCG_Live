import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { MatchId } from '@tcg-live/core';

export interface FlowContextValue {
  /** Prefix for this canvas's SVG marker ids, unique per instance so themes never share markers. */
  markerPrefix: string;
  reducedMotion: boolean;
  /** Server-corrected clock for countdowns. */
  getServerNow: () => number;
  /** Set in the Event view only: opens a match's lifecycle. */
  openMatch: ((matchId: MatchId) => void) | null;
}

export const FlowContext = createContext<FlowContextValue>({
  markerPrefix: 'tcg-flow',
  reducedMotion: false,
  getServerNow: Date.now,
  openMatch: null
});

export function useFlowContext(): FlowContextValue {
  return useContext(FlowContext);
}

/** Countdown refresh period. Short enough that a ceil-rounded m:ss display never lags by a second. */
export const CLOCK_TICK_MS = 250;

/**
 * Server time for a countdown. While `ticking`, it refreshes every `CLOCK_TICK_MS` inside the
 * component that renders the clock, so the canvas layout is never recomputed by a tick.
 */
export function useServerNow(ticking: boolean, intervalMs: number = CLOCK_TICK_MS): number {
  const { getServerNow } = useFlowContext();
  const [now, setNow] = useState(getServerNow);
  useEffect(() => {
    setNow(getServerNow());
    if (!ticking) return;
    const timer = setInterval(() => setNow(getServerNow()), intervalMs);
    return () => clearInterval(timer);
  }, [ticking, getServerNow, intervalMs]);
  return now;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function readReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** `prefers-reduced-motion: reduce`, live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
}
