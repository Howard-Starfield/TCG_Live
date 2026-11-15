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

/**
 * "?" (Shift+/ on most layouts) anywhere, ignored while typing, with Ctrl/Alt/⌘ held, on repeats, while a
 * dialog or menu is open, or when another handler has taken the key.
 */
export function useHelpShortcut(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      // While a modal dialog is open, or inside a menu or popover, the key belongs to it (the shortcuts dialog closes with Esc).
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"],[role="alertdialog"],[role="menu"]')) return;
      event.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
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
