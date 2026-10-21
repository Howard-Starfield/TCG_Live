import { formatClock, remainingMsAt, type ClockDto } from '@tcg-live/core';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

/** Smoothing weight of each new offset sample after the first. */
const SMOOTHING = 0.25;
/** A sample this far from the current estimate replaces it outright (local clock jump, server restart). */
const RESET_THRESHOLD_MS = 5_000;

/**
 * Estimates server time as local time plus a smoothed offset (server − local at receipt), fed by the
 * stream's `hello.status.serverTimeMs`, `status.serverTimeMs` and `heartbeat.serverTimeMs`. Display-only.
 */
export class ServerClock {
  private offset = 0;
  private samples = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly localNow: () => number = () => Date.now()) {}

  /** Current estimate of server time in epoch ms. Stable reference, safe to pass as a prop. */
  readonly now = (): number => this.localNow() + this.offset;

  /** Current offset estimate in ms (server − local). */
  readonly getOffset = (): number => this.offset;

  /** True once at least one server time sample was observed. */
  get synced(): boolean { return this.samples > 0; }

  /** Records a server timestamp received now. */
  observe(serverTimeMs: number, receivedAtLocalMs: number = this.localNow()): void {
    if (!Number.isFinite(serverTimeMs)) return;
    const sample = serverTimeMs - receivedAtLocalMs;
    const next = this.samples === 0 || Math.abs(sample - this.offset) > RESET_THRESHOLD_MS
      ? sample
      : this.offset + (sample - this.offset) * SMOOTHING;
    this.samples += 1;
    const rounded = Math.round(next);
    if (rounded === this.offset) return;
    this.offset = rounded;
    for (const listener of [...this.listeners]) listener();
  }

  /** Forgets all samples (sign-out). */
  reset(): void {
    this.samples = 0;
    if (this.offset === 0) return;
    this.offset = 0;
    for (const listener of [...this.listeners]) listener();
  }

  /** Subscribes to offset changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

/** The app-wide server clock. `createAdminData()` feeds it unless given another clock. */
export const serverClock = new ServerClock();

/** Stable function returning estimated server time (epoch ms); pass it as the canvas `getServerNow` prop. */
export const getServerNow: () => number = serverClock.now;

/** Context so tests and nested providers can supply a different clock. */
export const ServerClockContext = createContext<ServerClock>(serverClock);

/** The server clock in scope (the app-wide one by default). */
export function useServerClock(): ServerClock {
  return useContext(ServerClockContext);
}

/** Current server − local offset in ms; re-renders when the estimate changes. */
export function useServerOffset(): number {
  const clock = useServerClock();
  return useSyncExternalStore(clock.subscribe, clock.getOffset, clock.getOffset);
}

/**
 * Estimated server time, re-rendering every `tickMs` (aligned to server-time boundaries of that
 * period) and whenever the offset changes. Pass `null` to never tick.
 */
export function useServerNow(tickMs: number | null = 1000): number {
  const clock = useServerClock();
  const offset = useServerOffset();
  const [now, setNow] = useState(() => clock.now());

  useEffect(() => {
    setNow(clock.now());
    if (tickMs === null || tickMs <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const current = clock.now();
      const delay = tickMs - (((current % tickMs) + tickMs) % tickMs);
      timer = setTimeout(() => {
        setNow(clock.now());
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [clock, offset, tickMs]);

  return now;
}

/** Live countdown values for a match clock. */
export interface MatchCountdown {
  /** Remaining ms at the current server time. */
  remainingMs: number;
  /** `m:ss`, rounded up (never 0:00 before expiry). */
  label: string;
  /** True while the countdown is ticking (`state === 'running'` with time left). */
  running: boolean;
  /** The clock's state; `interrupted` must render as frozen with a label. */
  state: ClockDto['state'] | null;
}

function isTicking(clock: ClockDto | null | undefined): clock is ClockDto {
  return !!clock && clock.state === 'running' && clock.runningSinceMs !== null;
}

/**
 * Countdown on top of `remainingMsAt()`. Ticks only while the clock is running, once per displayed
 * second: each tick lands just after the clock crosses a whole second, so `label` changes on time.
 */
export function useMatchCountdown(clock: ClockDto | null | undefined): MatchCountdown {
  const serverClockInScope = useServerClock();
  const offset = useServerOffset();
  const compute = () => (clock ? remainingMsAt(clock, serverClockInScope.now()) : 0);
  const [remainingMs, setRemainingMs] = useState(compute);

  const durationMs = clock?.durationMs;
  const baseRemaining = clock?.remainingMs;
  const runningSince = clock?.runningSinceMs;
  const state = clock?.state;

  useEffect(() => {
    const current = clock ? remainingMsAt(clock, serverClockInScope.now()) : 0;
    setRemainingMs(current);
    if (!isTicking(clock) || current <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (left: number) => {
      // Next whole-second boundary of the remaining time, plus 1 ms so ceil() has moved on.
      const delay = (left % 1000 || 1000) + 1;
      timer = setTimeout(() => {
        const next = remainingMsAt(clock, serverClockInScope.now());
        setRemainingMs(next);
        if (next > 0) schedule(next);
      }, delay);
    };
    schedule(current);
    return () => clearTimeout(timer);
    // The clock object may be replaced by an identical one on every snapshot; depend on its fields.
  },[serverClockInScope, offset, durationMs, baseRemaining, runningSince, state]);

  return {
    remainingMs,
    label: formatClock(remainingMs),
    running: isTicking(clock) && remainingMs > 0,
    state: state ?? null
  };
}
