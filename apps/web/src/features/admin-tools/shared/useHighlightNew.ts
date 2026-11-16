// Scrolls a freshly saved list item into view and marks it with a short-lived highlight, so the admin sees
// where it landed after the editor dialog closes.
import { useCallback, useEffect, useRef, useState } from 'react';

/** Soft accent ring that fades in the list item; uses existing tokens only. */
export const HIGHLIGHT_CLASS = 'ring-2 ring-accent-ring bg-accent-soft';
const HIGHLIGHT_MS = 2000;

function scrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

export function useHighlightNew() {
  const [active, setActive] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const callbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const scrollTo = (el: HTMLElement) => el.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() });

  const highlight = useCallback((id: string) => {
    setActive(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(current => (current === id ? null : current)), HIGHLIGHT_MS);
    const el = elements.current.get(id);
    if (el) { pending.current = null; scrollTo(el); } else pending.current = id; // the list may not have rendered it yet
  }, []);

  const ref = useCallback((id: string) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = (el: HTMLElement | null) => {
        if (!el) { elements.current.delete(id); return; }
        elements.current.set(id, el);
        if (pending.current === id) { pending.current = null; scrollTo(el); }
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  }, []);

  const isHighlighted = useCallback((id: string) => active === id, [active]);
  return { highlight, isHighlighted, ref };
}
