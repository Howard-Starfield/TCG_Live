import { useEffect, useRef, useState } from 'react';

/** At most five graph updates per second. */
export const GRAPH_UPDATE_INTERVAL_MS = 200;

export interface Throttle<T> {
  /** Offer a new value: emitted now if the interval has passed, otherwise once it has (latest wins). */
  push(value: T): void;
  cancel(): void;
}

/**
 * Leading-and-trailing throttle: the first value after a quiet period is emitted at once, and values
 * arriving within `intervalMs` of the last emission collapse into one trailing emission of the latest.
 */
export function createThrottle<T>(intervalMs: number, emit: (value: T) => void, now: () => number = Date.now): Throttle<T> {
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  const flush = (): void => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastEmitAt = now();
    emit(value);
  };

  return {
    push(value) {
      const wait = lastEmitAt + intervalMs - now();
      if (wait <= 0 && timer === null) {
        lastEmitAt = now();
        emit(value);
        return;
      }
      pending = { value };
      timer ??= setTimeout(flush, Math.max(0, wait));
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    }
  };
}

/** `value`, updated at most once per `intervalMs`; the latest value always lands. */
export function useThrottledValue<T>(value: T, intervalMs: number = GRAPH_UPDATE_INTERVAL_MS): T {
  const [throttled, setThrottled] = useState(value);
  const throttleRef = useRef<Throttle<T> | null>(null);

  useEffect(() => {
    const throttle = createThrottle<T>(intervalMs, next => setThrottled(() => next));
    throttleRef.current = throttle;
    return () => {
      throttle.cancel();
      throttleRef.current = null;
    };
  }, [intervalMs]);

  useEffect(() => {
    throttleRef.current?.push(value);
  }, [value, intervalMs]);

  return throttled;
}
