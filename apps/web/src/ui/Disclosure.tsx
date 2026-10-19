import { ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import { cx } from './cx';
import { springs, useSafeTransition } from './motion';

export interface DisclosureProps {
  summary: ReactNode;
  /** Secondary text on the right of the summary row. */
  meta?: ReactNode;
  children: ReactNode;
  /** Uncontrolled initial state. */
  defaultOpen?: boolean;
  /** Controlled state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Expand/collapse section with an animated height and a rotating chevron. */
export function Disclosure({ summary, meta, children, defaultOpen = false, open, onOpenChange, className }: DisclosureProps) {
  const [internal, setInternal] = useState(defaultOpen);
  const isOpen = open ?? internal;
  const contentId = useId();
  const transition = useSafeTransition(springs.pane);
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInternal(next);
    onOpenChange?.(next);
  };

  return (
    <div className={cx('rounded-lg', className)}>
      <button type="button" aria-expanded={isOpen} aria-controls={contentId} onClick={toggle}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-fg-muted transition-colors hover:bg-line-faint hover:text-fg">
        <motion.span aria-hidden animate={{ rotate: isOpen ? 90 : 0 }} transition={transition} initial={false} className="grid">
          <ChevronRight className="size-3.5" />
        </motion.span>
        <span className="min-w-0 flex-1 truncate font-medium">{summary}</span>
        {meta && <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{meta}</span>}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div id={contentId} key="content" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={transition} className="overflow-hidden">
            <div className="px-1.5 pb-1 pt-1.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
