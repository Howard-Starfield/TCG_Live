import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

export interface FloatingPosition { top: number; left: number; placement: Placement }

const GAP = 6;
const EDGE = 8;

/** Computes a fixed-position box next to an anchor, flipping to the other side when it would not fit. */
export function computePosition(anchor: DOMRect, floating: { width: number; height: number }, placement: Placement,
  viewport = { width: window.innerWidth, height: window.innerHeight }): FloatingPosition {
  const [side, align] = placement.split('-') as ['top' | 'bottom' | 'left' | 'right', 'start' | 'end' | undefined];
  let resolved = side;
  if (side === 'bottom' && anchor.bottom + GAP + floating.height > viewport.height && anchor.top - GAP - floating.height > 0) resolved = 'top';
  if (side === 'top' && anchor.top - GAP - floating.height < 0) resolved = 'bottom';
  if (side === 'right' && anchor.right + GAP + floating.width > viewport.width) resolved = 'left';
  if (side === 'left' && anchor.left - GAP - floating.width < 0) resolved = 'right';

  let top: number;
  let left: number;
  if (resolved === 'top' || resolved === 'bottom') {
    top = resolved === 'top' ? anchor.top - GAP - floating.height : anchor.bottom + GAP;
    left = align === 'start' ? anchor.left : align === 'end' ? anchor.right - floating.width : anchor.left + anchor.width / 2 - floating.width / 2;
  } else {
    left = resolved === 'left' ? anchor.left - GAP - floating.width : anchor.right + GAP;
    top = anchor.top + anchor.height / 2 - floating.height / 2;
  }
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewport.width - floating.width - EDGE));
  top = Math.min(Math.max(EDGE, top), Math.max(EDGE, viewport.height - floating.height - EDGE));
  return { top, left, placement: (align ? `${resolved}-${align}` : resolved) as Placement };
}

/** Tracks the fixed position of a floating element while it is open (re-measures on scroll and resize). */
export function useFloating(anchorRef: RefObject<HTMLElement | null>, open: boolean, placement: Placement) {
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<FloatingPosition | null>(null);

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return;
    setPosition(computePosition(anchor.getBoundingClientRect(), { width: floating.offsetWidth, height: floating.offsetHeight }, placement));
  }, [anchorRef, placement]);

  useLayoutEffect(() => {
    if (open) update();
    else setPosition(null);
  }, [open, update]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, update]);

  const setFloating = useCallback((node: HTMLDivElement | null) => {
    floatingRef.current = node;
    if (node && open) update();
  }, [open, update]);

  return { floatingRef, setFloating, position, update };
}

/** Calls `onDismiss` on Escape or on a pointer press outside every given element while active. */
export function useDismiss(active: boolean, refs: Array<RefObject<HTMLElement | null>>, onDismiss: (reason: 'escape' | 'outside') => void) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node | null;
      if (target && refsRef.current.some(ref => ref.current?.contains(target))) return;
      onDismissRef.current('outside');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onDismissRef.current('escape');
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);
}
