// Lets a vertical mouse wheel scroll a horizontally overflowing strip (the Admin tools tab row).
// Only takes over the wheel while the strip can still move in that direction, so the page keeps
// scrolling normally at either end and when the strip doesn't overflow.
import { useEffect, type RefObject } from 'react';

export function wheelScrollTarget(el: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>,
  deltaX: number, deltaY: number): number | null {
  // Trackpads already scroll sideways on their own; only translate mostly-vertical wheel input.
  if (Math.abs(deltaX) >= Math.abs(deltaY) || deltaY === 0) return null;
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0) return null;
  const next = Math.min(max, Math.max(0, el.scrollLeft + deltaY));
  return next === el.scrollLeft ? null : next;
}

/** `enabled` re-attaches the listener once the element mounts (the page renders it conditionally). */
export function useWheelScrollX(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const onWheel = (event: WheelEvent) => {
      // Lines/pages (Firefox, some mice) report small deltas; scale them to pixels.
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1;
      const next = wheelScrollTarget(el, event.deltaX * scale, event.deltaY * scale);
      if (next === null) return;
      event.preventDefault();
      el.scrollLeft = next;
    };
    // Non-passive so preventDefault stops the page from scrolling at the same time.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, enabled]);
}
