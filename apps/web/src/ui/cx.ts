import type { Ref, RefCallback, RefObject } from 'react';

/** Joins truthy class names. Tiny on purpose: the kit has no class-merging dependency. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Assigns one DOM node to several refs (callback or object refs). */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return node => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as RefObject<T | null>).current = node;
    }
  };
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]'
].join(',');

/** Focusable descendants in DOM order, skipping hidden and inert subtrees. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    el => !el.closest('[inert]') && !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
  );
}
