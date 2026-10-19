import { useEffect, useRef } from 'react';

/** True when the key event comes from somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file', 'image'].includes(type);
}

/** Alt+<digit> handlers, ignored while typing; uses `code` so layouts that remap Alt+digit still work. */
export function useAltDigitShortcuts(handlers: Partial<Record<'1' | '2', () => void>>): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      const digit = /^(?:Digit|Numpad)([12])$/.exec(event.code)?.[1] ?? (event.key === '1' || event.key === '2' ? event.key : null);
      const handler = digit ? ref.current[digit as '1' | '2'] : undefined;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
