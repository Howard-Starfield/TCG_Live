import { AnimatePresence, motion } from 'motion/react';
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx';
import { useFloating, type Placement } from './floating';
import { Kbd } from './Kbd';
import { useSafeVariants, variants } from './motion';
import { Portal } from './Portal';

export interface TooltipProps {
  content: ReactNode;
  /** Shortcut shown after the text. */
  shortcut?: string[];
  placement?: Placement;
  /** Hover delay in ms (focus shows immediately). */
  delay?: number;
  /**
   * Adds `aria-describedby` on the trigger. Turn off when the tooltip repeats the trigger's accessible
   * name (icon buttons whose aria-label already says the same thing).
   */
  describe?: boolean;
  /** Initially visible (gallery and screenshots). */
  defaultOpen?: boolean;
  /** One focusable element. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

function isFocusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** Hover/focus hint attached to one element; Escape hides it. */
export function Tooltip({ content, shortcut, placement = 'top', delay = 450, describe = true, defaultOpen = false, children }: TooltipProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setFloating, position } = useFloating(anchorRef, open, placement);
  const tipVariants = useSafeVariants(variants.popover);

  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const show = (wait: number) => {
    clear();
    if (wait <= 0) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), wait);
  };
  const hide = () => { clear(); setOpen(false); };
  useEffect(() => clear, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const trigger = isValidElement(children) && describe
    ? cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined })
    : children;

  return (
    <>
      <span ref={anchorRef} className="inline-flex"
        onPointerEnter={event => { if (event.pointerType !== 'touch') show(delay); }} onPointerLeave={hide}
        onFocus={event => { if (isFocusVisible(event.target as HTMLElement)) show(0); }} onBlur={hide}
        onPointerDown={hide}>
        {trigger}
      </span>
      <Portal>
        <AnimatePresence>
          {open && (
            <motion.div ref={setFloating} id={id} role="tooltip" key="tip"
              variants={tipVariants} initial="hidden" animate="shown" exit="exit"
              style={{ position: 'fixed', top: position?.top ?? -9999, left: position?.left ?? -9999 }}
              className={cx('pointer-events-none z-[60] flex max-w-64 items-center gap-2 rounded-md bg-fg px-2 py-1 text-xs font-medium text-[var(--color-base)] shadow-pop')}>
              <span>{content}</span>
              {shortcut && <Kbd keys={shortcut} className="[&_kbd]:bg-[color-mix(in_srgb,var(--color-base)_16%,transparent)] [&_kbd]:text-current [&_kbd]:opacity-80 [&_kbd]:shadow-none" />}
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
