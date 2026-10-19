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

/** A user wheel scroll: intent first, then the position change and its scroll event. */
function userScroll(scroller: HTMLElement, top: number) {
  fireEvent.wheel(scroller, { deltaY: top - scroller.scrollTop });
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

/** A scroll with no user input behind it (scroll anchoring, a smooth animation, a shrinking container). */
function silentScroll(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

describe('useScrollPin', () => {
  it('follows new content while at the bottom and disables browser scroll anchoring', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 500, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    expect(scroller.scrollTop).toBe(300);
    expect(scroller.style.overflowAnchor).toBe('none');
    fireEvent.click(screen.getByText('add'));
    expect(scroller.scrollTop).toBe(400);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
  });

  it('does not unpin when the view moves up without user input (scroll anchoring during a reflow)', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 1600, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    expect(scroller.scrollTop).toBe(1400);
    // A reflow makes the browser anchor the view 1000 px above the bottom; no wheel, touch, key or pointer.
    clock.now += 5000;
    silentScroll(scroller, 400);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
    // Old user input does not count either.
    fireEvent.wheel(scroller, { deltaY: -10 });
    clock.now += 1000;
    silentScroll(scroller, 300);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
    // The next content arrival brings the pinned view back to the bottom.
    fireEvent.click(screen.getByText('add'));
    expect(scroller.scrollTop).toBe(1500);
  });

  it('treats a held pointer (scrollbar drag) as user input for as long as it is held', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 1000, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    fireEvent.pointerDown(scroller);
    clock.now += 2000;
    silentScroll(scroller, 600);
    expect(screen.getByTestId('state')).toHaveTextContent('free');
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByText('jump'));
    clock.now += 2000;
    silentScroll(scroller, 500);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
  });

  it('stops following when the user scrolls up, flags unseen content, and jumpToLatest re-pins', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 500, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    userScroll(scroller, 50);
    expect(screen.getByTestId('state')).toHaveTextContent('free');

    fireEvent.click(screen.getByText('add'));
    expect(scroller.scrollTop).toBe(50);
    expect(screen.getByTestId('state')).toHaveTextContent('free+unseen');

    fireEvent.click(screen.getByText('jump'));
    expect(scroller.scrollTop).toBe(400);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');

    // Scrolling back within the threshold of the bottom pins again.
    userScroll(scroller, 0);
    expect(screen.getByTestId('state')).toHaveTextContent('free');
    userScroll(scroller, 395);
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
  });

  it('stays pinned through a long smooth jumpToLatest', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 5000, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    userScroll(scroller, 100);
    expect(screen.getByTestId('state')).toHaveTextContent('free');

    fireEvent.click(screen.getByText('smooth jump'));
    expect(screen.getByTestId('state')).toHaveTextContent('pinned');
    // The animation runs for ~600 ms and only reaches the bottom at the end.
    for (const top of [400, 1200, 2500, 3800, 4600, 4800]) {
      clock.now += 120;
      silentScroll(scroller, top);
      expect(screen.getByTestId('state')).toHaveTextContent('pinned');
    }
  });

  it('honors a user scroll-up while content arrives every 100 ms', () => {
    const clock = { now: 1000 };
    const box = { scrollHeight: 500, clientHeight: 200 };
    render(<Feed clock={clock} box={box} />);
    const scroller = screen.getByTestId('scroller');
    for (let i = 0; i < 3; i += 1) {
      clock.now += 100;
      fireEvent.click(screen.getByText('add'));
      fireEvent.scroll(scroller);
    }
    expect(scroller.scrollTop).toBe(600);
    clock.now += 20;
    userScroll(scroller, 300);
    expect(screen.getByTestId('state')).toHaveTextContent('free');
    clock.now += 100;
    fireEvent.click(screen.getByText('add'));
    expect(scroller.scrollTop).toBe(300);
    expect(screen.getByTestId('state')).toHaveTextContent('free+unseen');
  });

  it('re-pins to the bottom when the container or its content resizes while pinned', () => {
    const callbacks: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly run: () => void;
      constructor(callback: ResizeObserverCallback) { this.run = () => callback([], this as unknown as ResizeObserver); callbacks.push(this.run); }
      observe() {}
      unobserve() {}
      disconnect() { callbacks.splice(callbacks.indexOf(this.run), 1); }
    } as unknown as typeof ResizeObserver;
    try {
      const clock = { now: 1000 };
      const box = { scrollHeight: 1000, clientHeight: 400 };
      render(<Feed clock={clock} box={box} />);
      const scroller = screen.getByTestId('scroller');
      expect(scroller.scrollTop).toBe(600);
      // The dock opens: the feed narrows, wraps and grows taller; the container gets shorter.
      box.scrollHeight = 1600;
      box.clientHeight = 300;
      act(() => callbacks.forEach(run => run()));
      expect(scroller.scrollTop).toBe(1300);
      expect(screen.getByTestId('state')).toHaveTextContent('pinned');

      // Once the user has scrolled away, resizes leave the position alone.
      userScroll(scroller, 200);
      box.scrollHeight = 2000;
      act(() => callbacks.forEach(run => run()));
      expect(scroller.scrollTop).toBe(200);
    } finally {
      globalThis.ResizeObserver = original;
    }
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
