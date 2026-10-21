import type { ClockDto } from '@tcg-live/core';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { getServerNow, ServerClock, ServerClockContext, serverClock, useMatchCountdown, useServerNow } from './clock';

const LOCAL_START = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(LOCAL_START);
});
afterEach(() => {
  vi.useRealTimers();
  serverClock.reset();
});

function withClock(clock: ServerClock) {
  return ({ children }: { children?: ReactNode }) =>
    <ServerClockContext.Provider value={clock}>{children}</ServerClockContext.Provider>;
}

describe('ServerClock', () => {
  it('takes the first sample as the offset, then smooths, and resets on large jumps', () => {
    const clock = new ServerClock();
    clock.observe(LOCAL_START + 2_000);                // server is 2 s ahead
    expect(clock.getOffset()).toBe(2_000);
    expect(clock.now()).toBe(LOCAL_START + 2_000);
    clock.observe(LOCAL_START + 3_000);                // a 1 s sample error moves it by a quarter
    expect(clock.getOffset()).toBe(2_250);
    clock.observe(LOCAL_START - 60_000);               // a jump beyond 5 s replaces the estimate
    expect(clock.getOffset()).toBe(-60_000);
  });

  it('exposes a stable getServerNow bound to the app-wide clock', () => {
    const before = getServerNow;
    serverClock.observe(LOCAL_START + 10_000);
    expect(getServerNow).toBe(before);
    expect(getServerNow()).toBe(LOCAL_START + 10_000);
  });
});

describe('useServerNow', () => {
  it('applies the offset, ticks each second, and re-renders when the offset changes', () => {
    const clock = new ServerClock();
    const { result } = renderHook(() => useServerNow(), { wrapper: withClock(clock) });
    expect(result.current).toBe(LOCAL_START);
    act(() => { clock.observe(LOCAL_START + 5_000); });
    expect(result.current).toBe(LOCAL_START + 5_000);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toBe(LOCAL_START + 6_000);
  });
});

describe('useMatchCountdown', () => {
  const running = (remainingMs: number): ClockDto =>
    ({ durationMs: 3_000_000, remainingMs, runningSinceMs: LOCAL_START, state: 'running' });

  it('counts down once per displayed second while running', () => {
    const clock = new ServerClock();
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useMatchCountdown(running(65_500)); },
      { wrapper: withClock(clock) });
    expect(result.current).toMatchObject({ label: '1:06', running: true, state: 'running' });
    const afterMount = renders;
    act(() => { vi.advanceTimersByTime(499); });
    expect(result.current.label).toBe('1:06');
    act(() => { vi.advanceTimersByTime(2); });       // crossed 65 s remaining
    expect(result.current.label).toBe('1:05');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.label).toBe('0:55');
    expect(renders - afterMount).toBeLessThanOrEqual(12);  // about one render per second, not per frame
  });

  it('stops at zero', () => {
    const { result } = renderHook(() => useMatchCountdown(running(1_500)), { wrapper: withClock(new ServerClock()) });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current).toMatchObject({ remainingMs: 0, label: '0:00', running: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not tick for frozen or interrupted clocks', () => {
    for (const state of ['frozen', 'interrupted'] as const) {
      const clockDto: ClockDto = { durationMs: 3_000_000, remainingMs: 1_345_000, runningSinceMs: null, state };
      const { result, unmount } = renderHook(() => useMatchCountdown(clockDto), { wrapper: withClock(new ServerClock()) });
      expect(vi.getTimerCount()).toBe(0);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(result.current).toMatchObject({ label: '22:25', running: false, state });
      unmount();
    }
  });

  it('starts and stops ticking when the clock state changes', () => {
    const frozen: ClockDto = { durationMs: 3_000_000, remainingMs: 60_000, runningSinceMs: null, state: 'frozen' };
    const { result, rerender } = renderHook(({ clock }) => useMatchCountdown(clock),
      { wrapper: withClock(new ServerClock()), initialProps: { clock: frozen } });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ clock: running(60_000) });
    act(() => { vi.advanceTimersByTime(3_001); });
    expect(result.current.label).toBe('0:57');
    rerender({ clock: { ...frozen, remainingMs: 57_000 } });
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.label).toBe('0:57');
  });

  it('uses the server offset', () => {
    const clock = new ServerClock();
    clock.observe(LOCAL_START + 10_000);              // server 10 s ahead
    const { result } = renderHook(() => useMatchCountdown(running(60_000)), { wrapper: withClock(clock) });
    expect(result.current.label).toBe('0:50');
  });
});
