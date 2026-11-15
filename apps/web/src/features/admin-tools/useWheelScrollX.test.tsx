import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useWheelScrollX, wheelScrollTarget } from './useWheelScrollX';

const strip = (scrollLeft: number, scrollWidth = 1000, clientWidth = 400) => ({ scrollLeft, scrollWidth, clientWidth });

describe('wheelScrollTarget', () => {
  it('turns a vertical wheel into a sideways scroll, clamped to the ends', () => {
    expect(wheelScrollTarget(strip(0), 0, 120)).toBe(120);
    expect(wheelScrollTarget(strip(550), 0, 120)).toBe(600);
    expect(wheelScrollTarget(strip(100), 0, -300)).toBe(0);
  });
  it('lets the page scroll at either end, without overflow, and for sideways trackpad input', () => {
    expect(wheelScrollTarget(strip(600), 0, 120)).toBeNull();
    expect(wheelScrollTarget(strip(0), 0, -120)).toBeNull();
    expect(wheelScrollTarget(strip(0, 400, 400), 0, 120)).toBeNull();
    expect(wheelScrollTarget(strip(100), 80, 10)).toBeNull();
  });
});

function Strip({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useWheelScrollX(ref, enabled);
  return <div ref={ref} data-testid="strip" />;
}

function sized(el: HTMLElement) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 1000 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 400 });
  return el;
}

describe('useWheelScrollX', () => {
  it('scrolls the strip and stops the page from scrolling with it', () => {
    const { getByTestId } = render(<Strip />);
    const el = sized(getByTestId('strip'));
    const notCancelled = fireEvent.wheel(el, { deltaY: 150 });
    expect(el.scrollLeft).toBe(150);
    expect(notCancelled).toBe(false);
  });
  it('does nothing while disabled', () => {
    const { getByTestId } = render(<Strip enabled={false} />);
    const el = sized(getByTestId('strip'));
    expect(fireEvent.wheel(el, { deltaY: 150 })).toBe(true);
    expect(el.scrollLeft).toBe(0);
  });
});
