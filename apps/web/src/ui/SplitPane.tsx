import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { cx } from './cx';

export type SplitDirection = 'horizontal' | 'vertical';

/** Pointer travel (px) before a press on the divider becomes a drag. */
export const SPLIT_DEADZONE_PX = 4;

export interface SplitBounds {
  /** Container length along the split axis, in px (0 when unknown). */
  size: number;
  minFirst?: number;
  minSecond?: number;
  /** Fraction near either edge where a drag collapses that pane; omit to disable collapsing. */
  collapseThreshold?: number;
}

function limits({ size, minFirst = 0, minSecond = 0 }: SplitBounds) {
  if (size <= 0) return { min: 0, max: 1 };
  const min = Math.min(1, minFirst / size);
  const max = Math.max(min, 1 - minSecond / size);
  return { min, max };
}

/** Maps a raw drag ratio to the ratio to apply: collapse near the edges, otherwise clamp to the pane minimums. */
export function resolveSplitRatio(raw: number, bounds: SplitBounds): number {
  const { min, max } = limits(bounds);
  const threshold = bounds.collapseThreshold;
  if (threshold !== undefined) {
    if (raw <= threshold) return 0;
    if (raw >= 1 - threshold) return 1;
  }
  return Math.min(max, Math.max(min, raw));
}

/** Keyboard step: never crosses into a collapse by accident, but steps out of one to the nearest valid size. */
export function stepSplitRatio(ratio: number, delta: number, bounds: SplitBounds): number {
  const { min, max } = limits(bounds);
  const collapsible = bounds.collapseThreshold !== undefined;
  const lower = collapsible ? Math.max(min, bounds.collapseThreshold!) : min;
  const upper = collapsible ? Math.min(max, 1 - bounds.collapseThreshold!) : max;
  const epsilon = 1e-6;
  if (delta < 0) {
    if (ratio >= 1) return upper;
    if (ratio <= lower + epsilon) return collapsible ? 0 : lower;
    return Math.max(lower, ratio + delta);
  }
  if (ratio <= 0) return lower;
  if (ratio >= upper - epsilon) return collapsible ? 1 : upper;
  return Math.min(upper, ratio + delta);
}

export interface SplitPaneProps {
  /** `horizontal`: panes side by side. `vertical`: stacked. */
  direction?: SplitDirection;
  /** Share of the first pane, 0 to 1 (0 or 1 means a pane is collapsed). */
  ratio: number;
  onChange: (ratio: number) => void;
  /** Double-click and Enter snap here (default 0.5). */
  defaultRatio?: number;
  minFirst?: number;
  minSecond?: number;
  collapseThreshold?: number;
  /** Arrow-key step as a fraction (default 0.02; Shift multiplies by 5). */
  step?: number;
  first: ReactNode;
  second: ReactNode;
  /** Accessible name of the divider. */
  label?: string;
  className?: string;
}

const HANDLE_PX = 1;

/** Two resizable panes with a draggable, keyboard-operable divider (`role="separator"`). */
export function SplitPane({ direction = 'horizontal', ratio, onChange, defaultRatio = 0.5, minFirst, minSecond, collapseThreshold,
  step = 0.02, first, second, label = 'Resize panes', className }: SplitPaneProps) {
  const firstId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; start: number; startRatio: number; size: number; active: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const horizontal = direction === 'horizontal';

  const measure = (): number => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return (horizontal ? rect.width || el.offsetWidth : rect.height || el.offsetHeight) || 0;
  };
  const bounds = (size: number): SplitBounds => ({ size, minFirst, minSecond, collapseThreshold });

  const endDrag = (target: HTMLElement) => {
    const state = drag.current;
    if (state && target.hasPointerCapture?.(state.pointerId)) target.releasePointerCapture(state.pointerId);
    drag.current = null;
    setDragging(false);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: horizontal ? event.clientX : event.clientY, startRatio: ratio, size: measure(), active: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.size <= 0) return;
    const delta = (horizontal ? event.clientX : event.clientY) - state.start;
    if (!state.active) {
      if (Math.abs(delta) < SPLIT_DEADZONE_PX) return;
      state.active = true;
      setDragging(true);
    }
    const next = resolveSplitRatio(state.startRatio + delta / state.size, bounds(state.size));
    if (next !== ratio) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault();
      if (drag.current.active) onChange(drag.current.startRatio);
      endDrag(event.currentTarget);
      return;
    }
    const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const increase = horizontal ? 'ArrowRight' : 'ArrowDown';
    const amount = step * (event.shiftKey ? 5 : 1);
    const b = bounds(measure());
    let next: number | null = null;
    if (event.key === decrease) next = stepSplitRatio(ratio, -amount, b);
    else if (event.key === increase) next = stepSplitRatio(ratio, amount, b);
    else if (event.key === 'Home') next = resolveSplitRatio(0, { ...b, collapseThreshold: undefined });
    else if (event.key === 'End') next = resolveSplitRatio(1, { ...b, collapseThreshold: undefined });
    else if (event.key === 'Enter') next = defaultRatio;
    if (next === null) return;
    event.preventDefault();
    if (next !== ratio) onChange(next);
  };

  const firstCollapsed = ratio <= 0;
  const secondCollapsed = ratio >= 1;
  const percent = Math.round(ratio * 100);

  return (
    <div ref={containerRef} data-dragging={dragging || undefined}
      className={cx('ui-split flex h-full min-h-0 w-full min-w-0', horizontal ? 'flex-row' : 'flex-col', className)}>
      <div id={firstId} inert={firstCollapsed || undefined} aria-hidden={firstCollapsed || undefined}
        className={cx('ui-split-pane min-h-0 min-w-0 shrink-0 overflow-hidden', !dragging && 'ui-split-animate')}
        style={{ flexBasis: `calc(${ratio * 100}% - ${HANDLE_PX / 2}px)` }}>
        {first}
      </div>
      <div role="separator" tabIndex={0} aria-label={label} aria-controls={firstId}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
        aria-valuetext={firstCollapsed ? 'First pane collapsed' : secondCollapsed ? 'Second pane collapsed' : `${percent}%`}
        data-direction={direction}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={event => endDrag(event.currentTarget)} onPointerCancel={event => endDrag(event.currentTarget)}
        onLostPointerCapture={() => { if (drag.current) { drag.current = null; setDragging(false); } }}
        onDoubleClick={() => onChange(defaultRatio)} onKeyDown={onKeyDown}
        title="Drag to resize; double-click to reset"
        className="ui-split-handle relative z-10 shrink-0 bg-line outline-none" />
      <div inert={secondCollapsed || undefined} aria-hidden={secondCollapsed || undefined}
        className="ui-split-pane min-h-0 min-w-0 flex-1 basis-0 overflow-hidden">
        {second}
      </div>
    </div>
  );
}
