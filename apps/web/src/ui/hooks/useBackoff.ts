import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface BackoffOptions {
  /** Delay before the first retry, in ms (default 500). */
  baseMs?: number;
  /** Upper bound for any delay, in ms (default 30 000). */
  maxMs?: number;
  /** Growth per attempt (default 2). */
  factor?: number;
  /**
   * `full`: uniform in [0, cap]. `equal`: half fixed, half random, so the delay never collapses to zero.
   * `none`: deterministic. Default `equal`.
   */
  jitter?: 'full' | 'equal' | 'none';
  /** Random source in [0, 1); injectable for tests. */
  random?: () => number;
}

/** Delay for a zero-based retry attempt: capped exponential growth with jitter. */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 500, maxMs = 30_000, factor = 2, jitter = 'equal', random = Math.random } = options;
  const cap = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt));
  if (jitter === 'none') return Math.round(cap);
  if (jitter === 'full') return Math.round(random() * cap);
  return Math.round(cap / 2 + random() * (cap / 2));
}

export interface Backoff {
  /** Retries scheduled since the last reset. */
  attempt: number;
  /** Returns the next delay and advances the attempt counter. */
  next: () => number;
  /** Schedules `run` after the next delay, cancelling any pending run; returns the delay used. */
  schedule: (run: () => void) => number;
  /** Cancels the pending run, if any. */
  cancel: () => void;
  /** Cancels and starts over from the first delay (call after a success). */
  reset: () => void;
}

/** Jittered exponential backoff with one pending timer; the timer is cleared on unmount. */
export function useBackoff(options: BackoffOptions = {}): Backoff {
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const next = useCallback(() => {
    const delay = backoffDelay(attemptRef.current, optionsRef.current);
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
    return delay;
  }, []);

  const schedule = useCallback((run: () => void) => {
    cancel();
    const delay = next();
    timer.current = setTimeout(() => { timer.current = null; run(); }, delay);
    return delay;
  }, [cancel, next]);

  const reset = useCallback(() => {
    cancel();
    attemptRef.current = 0;
    setAttempt(0);
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return useMemo(() => ({ attempt, next, schedule, cancel, reset }), [attempt, next, schedule, cancel, reset]);
}
