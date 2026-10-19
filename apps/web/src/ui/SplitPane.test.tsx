import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SplitPane, resolveSplitRatio, stepSplitRatio } from './SplitPane';

function Harness({ initial = 0.5, onChange, direction = 'horizontal' as const, collapseThreshold }: {
  initial?: number; onChange?: (ratio: number) => void; direction?: 'horizontal' | 'vertical'; collapseThreshold?: number;
}) {
  const [ratio, setRatio] = useState(initial);
  return (
    <SplitPane direction={direction} ratio={ratio} defaultRatio={0.5} collapseThreshold={collapseThreshold} label="Resize"
      onChange={next => { setRatio(next); onChange?.(next); }}
      first={<button type="button">first</button>} second={<p>second</p>} />
  );
}

describe('SplitPane ratio math', () => {
  it('clamps to pane minimums and collapses inside the threshold', () => {
    const bounds = { size: 1000, minFirst: 200, minSecond: 300, collapseThreshold: 0.1 };
    expect(resolveSplitRatio(0.5, bounds)).toBe(0.5);
    expect(resolveSplitRatio(0.15, bounds)).toBe(0.2);
    expect(resolveSplitRatio(0.05, bounds)).toBe(0);
    expect(resolveSplitRatio(0.8, bounds)).toBe(0.7);
    expect(resolveSplitRatio(0.95, bounds)).toBe(1);
    expect(resolveSplitRatio(0.05, { ...bounds, collapseThreshold: undefined })).toBe(0.2);
  });

  it('steps out of a collapse and only collapses from the minimum', () => {
    const bounds = { size: 1000, minFirst: 100, collapseThreshold: 0.12 };
    expect(stepSplitRatio(0, 0.02, bounds)).toBe(0.12);
    expect(stepSplitRatio(0.12, -0.02, bounds)).toBe(0);
    expect(stepSplitRatio(0.3, -0.02, bounds)).toBeCloseTo(0.28);
    expect(stepSplitRatio(1, -0.02, bounds)).toBe(0.88);
  });
});

describe('SplitPane separator', () => {
  it('exposes separator semantics with the current value', () => {
    render(<Harness initial={0.4} />);
    const separator = screen.getByRole('separator', { name: 'Resize' });
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-valuenow', '40');
    expect(separator).toHaveAttribute('aria-valuemin', '0');
    expect(separator).toHaveAttribute('aria-valuemax', '100');
    expect(separator).toHaveAttribute('tabindex', '0');
    expect(document.getElementById(separator.getAttribute('aria-controls')!)).toContainElement(screen.getByRole('button', { name: 'first' }));
  });

  it('resizes with the arrow keys and snaps back with Enter', async () => {
    const user = userEvent.setup();
    render(<Harness initial={0.5} />);
    const separator = screen.getByRole('separator');
    separator.focus();
    await user.keyboard('{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '52');
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(separator).toHaveAttribute('aria-valuenow', '42');
    await user.keyboard('{ArrowUp}');
    expect(separator).toHaveAttribute('aria-valuenow', '42');
    await user.keyboard('{Enter}');
    expect(separator).toHaveAttribute('aria-valuenow', '50');
  });

  it('uses Up/Down when stacked vertically', async () => {
    const user = userEvent.setup();
    render(<Harness direction="vertical" />);
    const separator = screen.getByRole('separator');
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    separator.focus();
    await user.keyboard('{ArrowDown}');
    expect(separator).toHaveAttribute('aria-valuenow', '52');
  });

  it('ignores pointer travel inside the 4 px deadzone, then follows the drag', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const separator = screen.getByRole('separator');
    // jsdom has no layout; the test setup reports an 800 px wide container.
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 403 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 480 });
    expect(onChange).toHaveBeenLastCalledWith(0.6);
    fireEvent.pointerUp(separator, { pointerId: 1, clientX: 480 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 600 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reverts a drag on Escape and collapses past the threshold', () => {
    render(<Harness collapseThreshold={0.1} />);
    const separator = screen.getByRole('separator');
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 100 });
    expect(separator).toHaveAttribute('aria-valuenow', '13');
    fireEvent.keyDown(separator, { key: 'Escape' });
    expect(separator).toHaveAttribute('aria-valuenow', '50');

    fireEvent.pointerDown(separator, { button: 0, pointerId: 2, clientX: 400 });
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 20 });
    expect(separator).toHaveAttribute('aria-valuenow', '0');
    expect(separator).toHaveAttribute('aria-valuetext', 'First pane collapsed');
    expect(screen.getByRole('button', { name: 'first', hidden: true }).closest('[inert]')).not.toBeNull();
  });

  it('snaps to the default ratio on double-click', () => {
    render(<Harness initial={0.3} />);
    const separator = screen.getByRole('separator');
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute('aria-valuenow', '50');
  });
});
