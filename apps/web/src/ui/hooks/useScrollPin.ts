import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ScrollPinOptions {
  /** Distance from the bottom, in px, that still counts as "at the bottom". */
  threshold?: number;
  /** An upward scroll counts as the user's only within this many ms of their input (default 250). */
  intentWindowMs?: number;
  /** Changes whenever new content arrives (for example the entry count); pinned views follow it. */
  contentKey?: unknown;
  /** Clock for the intent window; injectable for tests. */
  now?: () => number;
}

export interface ScrollPin<T extends HTMLElement> {
  /** Attach to the scrolling element. */
  scrollRef: (node: T | null) => void;
  /** True while the view follows new content. */
  pinned: boolean;
  /** True when content arrived while the user was scrolled away from the bottom. */
  hasUnseen: boolean;
  /** Scrolls to the newest content and pins again. */
  jumpToLatest: (behavior?: ScrollBehavior) => void;
}

export function distanceFromBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** Momentary input that means the user is steering the scroll position. */
const INTENT_EVENTS = ['wheel', 'touchstart', 'touchmove', 'keydown'] as const;

/**
 * Chat-style scroll pinning: while the user is at the bottom, new content keeps the view at the bottom;
 * once they scroll up the view stays put and `hasUnseen` flags new content.
 *
 * Only the user can unpin. An upward scroll unpins only when it follows user input: a wheel, touch or key
 * event within `intentWindowMs`, or a pointer held down on the container (scrollbar drags). So nothing
 * else moving the view up unpins it: smooth `jumpToLatest` animations, browser scroll anchoring during a
 * reflow, or the container shrinking. Reaching the bottom always pins.
 *
 * While pinned, resizing the container or its content (a dock opening, a window resize, images loading)
 * keeps the view at the bottom. The hook also sets `overflow-anchor: none` on the container, so the
 * browser's own scroll anchoring does not fight the pinning.
 */
export function useScrollPin<T extends HTMLElement = HTMLDivElement>(options: ScrollPinOptions = {}): ScrollPin<T> {
  const { threshold = 24, intentWindowMs = 250, contentKey } = options;
  const now = options.now ?? Date.now;
  const [node, setNode] = useState<T | null>(null);
  const [pinned, setPinned] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);
  const pinnedRef = useRef(true);
  const intentAt = useRef(Number.NEGATIVE_INFINITY);
  const pointerHeld = useRef(false);
  const lastTop = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinned(value);
    if (value) setHasUnseen(false);
  }, []);

  const scrollToBottom = useCallback((el: T, behavior: ScrollBehavior) => {
    const top = el.scrollHeight;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior });
    else el.scrollTop = top;
  }, []);

  useEffect(() => {
    if (!node) return;
    lastTop.current = node.scrollTop;
    const previousAnchor = node.style.overflowAnchor;
    node.style.overflowAnchor = 'none';

    const onIntent = () => { intentAt.current = nowRef.current(); };
    const onPointerDown = () => { pointerHeld.current = true; onIntent(); };
    const onPointerUp = () => { pointerHeld.current = false; };
    const onScroll = () => {
      const top = node.scrollTop;
      const movedUp = top < lastTop.current - 1;
      lastTop.current = top;
      if (distanceFromBottom(node) <= threshold) {
        if (!pinnedRef.current) setPin(true);
        return;
      }
      if (!movedUp || !pinnedRef.current) return;
      const userDriven = pointerHeld.current || nowRef.current() - intentAt.current <= intentWindowMs;
      if (userDriven) setPin(false);
    };

    // While pinned, any change in size keeps the newest content in view.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (pinnedRef.current && distanceFromBottom(node) > 0) scrollToBottom(node, 'auto');
    });
    observer?.observe(node);
    for (const child of Array.from(node.children)) observer?.observe(child);

    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('pointerdown', onPointerDown, { passive: true });
    for (const type of INTENT_EVENTS) node.addEventListener(type, onIntent, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      observer?.disconnect();
      node.style.overflowAnchor = previousAnchor;
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('pointerdown', onPointerDown);
      for (const type of INTENT_EVENTS) node.removeEventListener(type, onIntent);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [node, threshold, intentWindowMs, setPin, scrollToBottom]);

  // Follow new content while pinned; otherwise remember that something arrived.
  const firstRun = useRef(true);
  useLayoutEffect(() => {
    if (!node) return;
    if (pinnedRef.current) scrollToBottom(node, 'auto');
    else if (!firstRun.current) setHasUnseen(true);
    firstRun.current = false;
  }, [node, contentKey, scrollToBottom]);

  const jumpToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (!node) return;
    setPin(true);
    scrollToBottom(node, behavior);
  }, [node, scrollToBottom, setPin]);

  return { scrollRef: setNode, pinned, hasUnseen, jumpToLatest };
}
