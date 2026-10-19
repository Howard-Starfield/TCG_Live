import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

export interface RovingFocusOptions {
  count: number;
  orientation?: RovingOrientation;
  /** Wrap from the last item to the first and back (default true). */
  loop?: boolean;
  /** Controlled active index; the hook follows it when it changes. */
  activeIndex?: number;
  /** Disabled items are skipped by the arrow keys. */
  isDisabled?: (index: number) => boolean;
  /** Called after keyboard navigation moves to a new index (used for "selection follows focus"). */
  onNavigate?: (index: number) => void;
}

export interface RovingItemProps {
  ref: (node: HTMLElement | null) => void;
  tabIndex: 0 | -1;
  onKeyDown: (event: KeyboardEvent) => void;
  onFocus: () => void;
}

const KEYS: Record<RovingOrientation, { prev: string[]; next: string[] }> = {
  horizontal: { prev: ['ArrowLeft'], next: ['ArrowRight'] },
  vertical: { prev: ['ArrowUp'], next: ['ArrowDown'] },
  both: { prev: ['ArrowLeft', 'ArrowUp'], next: ['ArrowRight', 'ArrowDown'] }
};

/** Steps from `from` in `direction`, skipping disabled items; returns `from` when nothing is reachable. */
export function nextRovingIndex(from: number, direction: 1 | -1, count: number, loop: boolean, isDisabled?: (i: number) => boolean): number {
  let index = from;
  for (let step = 0; step < count; step += 1) {
    index += direction;
    if (index < 0 || index >= count) {
      if (!loop) return from;
      index = (index + count) % count;
    }
    if (!isDisabled?.(index)) return index;
  }
  return from;
}

/**
 * Roving tabindex: exactly one item in the group is tabbable, the arrow keys move focus between items,
 * Home and End jump to the ends. Returns props to spread on each item.
 */
export function useRovingFocus(options: RovingFocusOptions) {
  const { count, orientation = 'horizontal', loop = true, activeIndex, isDisabled, onNavigate } = options;
  const [current, setCurrent] = useState(activeIndex ?? 0);
  const nodes = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    if (activeIndex !== undefined && activeIndex >= 0) setCurrent(activeIndex);
  }, [activeIndex]);

  // Keep the tabbable index inside the list and off disabled items.
  const safeCurrent = current >= count ? Math.max(0, count - 1) : current;
  const tabbable = isDisabled?.(safeCurrent) ? nextRovingIndex(safeCurrent, 1, count, true, isDisabled) : safeCurrent;

  const focusIndex = useCallback((index: number) => {
    setCurrent(index);
    nodes.current[index]?.focus();
    onNavigate?.(index);
  }, [onNavigate]);

  const getItemProps = useCallback((index: number): RovingItemProps => ({
    ref: node => { nodes.current[index] = node; },
    tabIndex: index === tabbable ? 0 : -1,
    onFocus: () => setCurrent(index),
    onKeyDown: event => {
      const keys = KEYS[orientation];
      let target: number | null = null;
      if (keys.next.includes(event.key)) target = nextRovingIndex(index, 1, count, loop, isDisabled);
      else if (keys.prev.includes(event.key)) target = nextRovingIndex(index, -1, count, loop, isDisabled);
      else if (event.key === 'Home') target = nextRovingIndex(-1, 1, count, false, isDisabled);
      else if (event.key === 'End') target = nextRovingIndex(count, -1, count, false, isDisabled);
      if (target === null) return;
      event.preventDefault();
      if (target !== index) focusIndex(target);
    }
  }), [count, focusIndex, isDisabled, loop, orientation, tabbable]);

  return { activeIndex: tabbable, setActiveIndex: setCurrent, focusIndex, getItemProps };
}
