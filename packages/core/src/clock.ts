import type { ClockDto } from './admin-contract.js';

/**
 * Remaining time at `serverNowMs`. Only a `running` clock counts down; frozen and
 * interrupted clocks return their persisted `remainingMs`. Display-only: the server
 * stays authoritative for expiry.
 */
export function remainingMsAt(clock: ClockDto, serverNowMs: number): number {
  if (clock.state !== 'running' || clock.runningSinceMs === null) return clock.remainingMs;
  const elapsed = Math.max(0, serverNowMs - clock.runningSinceMs);
  return Math.max(0, clock.remainingMs - elapsed);
}

/** `m:ss`, rounding up so a clock never shows 0:00 before it expires. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
