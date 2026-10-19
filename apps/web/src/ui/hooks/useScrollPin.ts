import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ScrollPinOptions {
  /** Distance from the bottom, in px, that still counts as "at the bottom". */
  threshold?: number;
  /** Scroll events within this many ms of a programmatic scroll are ignored (default 150). */
  cooldownMs?: number;
  /** Changes whenever new content arrives (for example the entry count); pinned views follow it. */
  contentKey?: unknown;
  /** Clock for the cooldown; injectable for tests. */
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

/** Input that means the user is steering the scroll position themselves. */
const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'] as const;
/** A scroll event this soon after user input counts as user-driven. */
const USER_INPUT_WINDOW_MS = 250;

/**
 * Chat-style scroll pinning: while the user is at the bottom, new content keeps the view at the bottom;
 * once they scroll up the view stays put and `hasUnseen` flags new content.
 *
 * Rules, so programmatic scrolling can never unpin the view:
 * - reaching the bottom (within `threshold`) always pins;
 * - only upward movement (`scrollTop` decreasing) can unpin, and our own scrolls only ever move down, so a
 *   long smooth `jumpToLatest` cannot unpin part-way;
 * - for `cooldownMs` after a programmatic scroll, scroll events are ignored unless they follow user input
 *   (wheel, touch, pointer, key), so a fast stream of new content cannot swallow the user's scroll-up.
 */
export function useScrollPin<T extends HTMLElement = HTMLDivElement>(options: ScrollPinOptions = {}): ScrollPin<T> {
  const { threshold = 24, cooldownMs = 150, contentKey } = options;
  const now = options.now ?? Date.now;
  const [node, setNode] = useState<T | null>(null);
  const [pinned, setPinned] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);
  const pinnedRef = useRef(true);
  const cooldownUntil = useRef(0);
  const userInputAt = useRef(Number.NEGATIVE_INFINITY);
  const lastTop = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinned(value);
    if (value) setHasUnseen(false);
  }, []);

  const scrollToBottom = useCallback((el: T, behavior: ScrollBehavior) => {
    cooldownUntil.current = nowRef.current() + cooldownMs;
    const top = el.scrollHeight;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior });
    else el.scrollTop = top;
  }, [cooldownMs]);

  useEffect(() => {
    if (!node) return;
    lastTop.current = node.scrollTop;
    const onUserInput = () => { userInputAt.current = nowRef.current(); };
    const onScroll = () => {
      const top = node.scrollTop;
      if (distanceFromBottom(node) <= threshold) {
        lastTop.current = top;
        if (!pinnedRef.current) setPin(true);
        return;
      }
      const movedUp = top < lastTop.current - 1;
      if (!movedUp || !pinnedRef.current) {
        lastTop.current = top;
        return;
      }
      const time = nowRef.current();
      const userDriven = time - userInputAt.current <= USER_INPUT_WINDOW_MS;
      // Ignored events keep the old position, so the net upward move still counts after the cooldown.
      if (time < cooldownUntil.current && !userDriven) return;
      lastTop.current = top;
      setPin(false);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    for (const type of USER_INPUT_EVENTS) node.addEventListener(type, onUserInput, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
      for (const type of USER_INPUT_EVENTS) node.removeEventListener(type, onUserInput);
    };
  }, [node, threshold, setPin]);

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
