import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle, GRAPH_UPDATE_INTERVAL_MS, useThrottledValue } from './throttle';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('createThrottle', () => {
  it('allows at most five emissions per second and always lands the latest value', () => {
    const emitted: number[] = [];
    const throttle = createThrottle<number>(GRAPH_UPDATE_INTERVAL_MS, value => emitted.push(value));
    // 100 updates over one second, one every 10 ms.
    for (let index = 0; index < 100; index += 1) {
      throttle.push(index);
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(GRAPH_UPDATE_INTERVAL_MS);
    expect(GRAPH_UPDATE_INTERVAL_MS).toBe(200);
    expect(emitted.length).toBeLessThanOrEqual(6); // five per second plus the trailing flush
    expect(emitted[0]).toBe(0);
    expect(emitted.at(-1)).toBe(99);
  });

  it('emits immediately after a quiet period and coalesces a burst into one trailing emission', () => {
    const emitted: string[] = [];
    const throttle = createThrottle<string>(200, value => emitted.push(value));
    throttle.push('a');
    expect(emitted).toEqual(['a']);
    throttle.push('b');
    throttle.push('c');
    expect(emitted).toEqual(['a']);
    vi.advanceTimersByTime(199);
    expect(emitted).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['a', 'c']);
    vi.advanceTimersByTime(1_000);
    throttle.push('d');
    expect(emitted).toEqual(['a', 'c', 'd']);
  });

  it('cancel drops a pending emission', () => {
    const emitted: number[] = [];
    const throttle = createThrottle<number>(200, value => emitted.push(value));
    throttle.push(1);
    throttle.push(2);
    throttle.cancel();
    vi.advanceTimersByTime(500);
    expect(emitted).toEqual([1]);
  });
});

describe('useThrottledValue', () => {
  it('follows the input at most every 200 ms', () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value), { initialProps: { value: 0 } });
    expect(result.current).toBe(0);
    rerender({ value: 1 });
    rerender({ value: 2 });
    rerender({ value: 3 });
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(GRAPH_UPDATE_INTERVAL_MS); });
    expect(result.current).toBe(3);
    act(() => { vi.advanceTimersByTime(1_000); });
    rerender({ value: 4 });
    expect(result.current).toBe(4);
  });
});
