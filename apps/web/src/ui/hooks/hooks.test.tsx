import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, useBackoff } from './useBackoff';
import { nextRovingIndex } from './useRovingFocus';
import { distanceFromBottom, useScrollPin } from './useScrollPin';

/** Gives a jsdom element a scriptable scroll box (jsdom has no layout). */
function scrollBox(el: HTMLElement & { scripted?: boolean }, box: { scrollHeight: number; clientHeight: number }) {
  if (el.scripted) return;
  el.scripted = true;
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight)); } });
  // Smooth scrolls do not move at once; the test steps through the animation by hand.
  el.scrollTo = ((options: ScrollToOptions) => { if (options.behavior !== 'smooth') el.scrollTop = options.top ?? 0; }) as typeof el.scrollTo;
}

function Feed({ clock, box }: { clock: { now: number }; box: { scrollHeight: number; clientHeight: number } }) {
  const [count, setCount] = useState(1);
  const pin = useScrollPin<HTMLDivElement>({ contentKey: count, now: () => clock.now, threshold: 10 });
  return (
    <>
      <div data-testid="scroller" ref={node => { if (node) scrollBox(node, box); pin.scrollRef(node); }} />
      <button type="button" onClick={() => { box.scrollHeight += 100; setCount(c => c + 1); }}>add</button>
      <button type="button" onClick={() => pin.jumpToLatest('auto')}>jump</button>
      <button type="button" onClick={() => pin.jumpToLatest('smooth')}>smooth jump</button>
      <output data-testid="state">{`${pin.pinned ? 'pinned' : 'free'}${pin.hasUnseen ? '+unseen' : ''}`}</output>
    </>
  );
}

describe('useScrollPin', () => {
  it('follows new content while at the bottom', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 500, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    expect(scroller.scrollTop).toBe(300);
    fireEvent.click(screen.getByText('add'));
    expect(scroller.scrollTop).toBe(400);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
  });

  it('ignores scroll events during the 150 ms cooldown after a programmatic scroll', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 500, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    // A scroll event inside the cooldown (e.g. smooth scrolling passing mid-way) must not unpin.
    clock.now += 100;
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
    // After the cooldown the same position unpins.
    clock.now += 60;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('state')).toHaveTextContent('free');
  });

  it('stops following when the user scrolls up, flags unseen content, and jumpToLatest re-pins', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 500, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    clock.now += 500;
    scroller.scrollTop = 50;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('state')).toHaveTextContent('free');

    fireEvent.click(screen.getByText('add'));
    expect(scroller.scrollTop).toBe(50);
    expect(screen.getByTestId('state')).toHaveTextContent('free+unseen');

    fireEvent.click(screen.getByText('jump'));
    expect(scroller.scrollTop).toBe(400);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');

    // Scrolling back within the threshold of the bottom pins again.
    clock.now += 500;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 395;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
  });

  it('stays pinned through a smooth jumpToLatest that outlasts the cooldown', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 5000, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    clock.now += 500;
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('state')).toHaveTextContent('free');

    fireEvent.click(screen.getByText('smooth jump'));
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
    // The animation runs for ~600 ms, far past the 150 ms cooldown, and never reaches the bottom early.
    for (const top of [400, 1200, 2500, 3800, 4600]) {
      clock.now += 120;
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
      expect(screen.getByTestId('state')).toHaveTextContent('pinned');
    }
    clock.now += 120;
    scroller.scrollTop = 4800;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
  });

  it('honors a user scroll-up while content arrives faster than the cooldown', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 500, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    // New content every 100 ms keeps re-arming the 150 ms cooldown.
    for (let i = 0; i < 3; i += 1) {
      clock.now += 100;
      fireEvent.click(screen.getByText('add'));
      fireEvent.scroll(scroller);
    }
    expect(scroller.scrollTop).toBe(600);
    clock.now += 20;
    fireEvent.wheel(scroller, { deltaY: -300 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('state')).toHaveTextContent('free');
    clock.now += 100;
    fireEvent.click(screen.getByText('add'));
    expect(scroller.scrollTop).toBe(300);
    expect(screen.getByTestId('state')).toHaveTextContent('free+unseen');
  });

  it('measures distance from the bottom', () => {
    expect(distanceFromBottom({ scrollHeight: 500, scrollTop: 250, clientHeight: 200 })).toBe(50);
    expect(distanceFromBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 200 })).toBe(0);
  });
});

describe('backoff', () => {
  it('grows exponentially up to the cap, with jitter inside the bounds', () => {
    const none = (attempt: number) => backoffDelay(attempt, { baseMs: 500, maxMs: 8000, jitter: 'none' });
    expect([0, 1, 2, 3, 4, 5].map(none)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(backoffDelay(3, { baseMs: 500, jitter: 'full', random: () => 0 })).toBe(0);
    expect(backoffDelay(3, { baseMs: 500, jitter: 'full', random: () => 0.5 })).toBe(2000);
    expect(backoffDelay(3, { baseMs: 500, jitter: 'equal', random: () => 0 })).toBe(2000);
    expect(backoffDelay(3, { baseMs: 500, jitter: 'equal', random: () => 0.999999 })).toBe(4000);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const delay = backoffDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(Math.min(30_000, 500 * 2 ** attempt) / 2);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  describe('useBackoff', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('schedules one retry at a time, counts attempts and resets', () => {
      vi.useFakeTimers();
      const run = vi.fn();
      const { result, unmount } = renderHook(() => useBackoff({ baseMs: 100, jitter: 'none' }));
      let delay = 0;
      act(() => { delay = result.current.schedule(run); });
      expect(delay).toBe(100);
      act(() => { delay = result.current.schedule(run); });
      expect(delay).toBe(200);
      expect(result.current.attempt).toBe(2);
      act(() => { vi.advanceTimersByTime(199); });
      expect(run).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(run).toHaveBeenCalledOnce();

      act(() => { result.current.reset(); });
      expect(result.current.attempt).toBe(0);
      act(() => { result.current.schedule(run); });
      unmount();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(run).toHaveBeenCalledOnce();
    });
  });
});

describe('nextRovingIndex', () => {
  const disabled = (index: number) => index === 1;
  it('skips disabled items and wraps only when looping', () => {
    expect(nextRovingIndex(0, 1, 4, true, disabled)).toBe(2);
    expect(nextRovingIndex(3, 1, 4, true, disabled)).toBe(0);
    expect(nextRovingIndex(3, 1, 4, false, disabled)).toBe(3);
    expect(nextRovingIndex(2, -1, 4, true, disabled)).toBe(0);
    expect(nextRovingIndex(0, 1, 1, true, () => false)).toBe(0);
  });
});
