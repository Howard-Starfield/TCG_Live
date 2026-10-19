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

/**
 * Chat-style scroll pinning: while the user is at the bottom, new content keeps the view at the bottom;
 * once they scroll up the view stays put and `hasUnseen` flags new content. Scroll events fired by our own
 * programmatic scrolls are ignored for a short cooldown so smooth scrolling cannot unpin the view.
 */
export function useScrollPin<T extends HTMLElement = HTMLDivElement>(options: ScrollPinOptions = {}): ScrollPin<T> {
  const { threshold = 24, cooldownMs = 150, contentKey } = options;
  const now = options.now ?? Date.now;
  const [node, setNode] = useState<T | null>(null);
  const [pinned, setPinned] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);
  const pinnedRef = useRef(true);
  const cooldownUntil = useRef(0);
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
    const onScroll = () => {
      if (nowRef.current() < cooldownUntil.current) return;
      const atBottom = distanceFromBottom(node) <= threshold;
      if (atBottom !== pinnedRef.current) setPin(atBottom);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
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
