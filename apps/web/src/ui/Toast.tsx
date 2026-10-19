import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './cx';
import { useSafeVariants, variants } from './motion';
import { Portal } from './Portal';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss delay in ms; `null` keeps the toast until dismissed. Defaults to the provider duration. */
  duration?: number | null;
  /** One optional action, e.g. "Retry". Clicking it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions { id: string }

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Default auto-dismiss delay in ms (default 5000). */
  duration?: number;
  /** Oldest toasts are dropped beyond this many (default 4). */
  max?: number;
}

/**
 * Toast stack in the bottom-right corner. Neutral and success toasts are announced politely, danger
 * toasts assertively. Timers pause while the pointer or focus is inside the stack.
 */
export function ToastProvider({ children, duration = 5000, max = 4 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => setToasts(list => list.filter(toast => toast.id !== id)), []);
  const show = useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    setToasts(list => [...list, { duration, ...options, id }].slice(-max));
    return id;
  }, [duration, max]);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  // A toast removed under the pointer may never fire pointerleave; an empty stack is never paused.
  useEffect(() => {
    if (toasts.length === 0) setPaused(false);
  }, [toasts.length]);

  const polite = toasts.filter(toast => toast.tone !== 'danger');
  const assertive = toasts.filter(toast => toast.tone === 'danger');
  const regionProps = {
    onPointerEnter: () => setPaused(true),
    onPointerLeave: () => setPaused(false),
    onFocus: () => setPaused(true),
    onBlur: () => setPaused(false)
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Portal>
        <section aria-label="Notifications" data-inert-exempt="" {...regionProps}
          className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
          <div role="status" aria-live="polite" aria-atomic="false">
            <ol className="flex flex-col gap-2"><ToastList toasts={polite} paused={paused} onDismiss={dismiss} /></ol>
          </div>
          <div role="alert" aria-live="assertive" aria-atomic="false">
            <ol className="flex flex-col gap-2"><ToastList toasts={assertive} paused={paused} onDismiss={dismiss} /></ol>
          </div>
        </section>
      </Portal>
    </ToastContext.Provider>
  );
}

function ToastList({ toasts, paused, onDismiss }: { toasts: ToastRecord[]; paused: boolean; onDismiss: (id: string) => void }) {
  return (
    <AnimatePresence initial={false}>
      {toasts.map(toast => <ToastItem key={toast.id} toast={toast} paused={paused} onDismiss={onDismiss} />)}
    </AnimatePresence>
  );
}

const ICON: Record<ToastTone, ReactNode> = {
  neutral: <Info aria-hidden className="text-fg-subtle" />,
  success: <CircleCheck aria-hidden className="text-success" />,
  danger: <CircleAlert aria-hidden className="text-danger" />
};

function ToastItem({ toast, paused, onDismiss }: { toast: ToastRecord; paused: boolean; onDismiss: (id: string) => void }) {
  const toastVariants = useSafeVariants(variants.toast);
  const remaining = useRef(toast.duration ?? null);

  // Count down only while not paused; pausing keeps the time left.
  useEffect(() => {
    if (paused || remaining.current === null) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      if (remaining.current !== null) remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, onDismiss, toast.id]);

  const tone = toast.tone ?? 'neutral';
  return (
    <motion.li layout variants={toastVariants} initial="hidden" animate="shown" exit="exit"
      className={cx('pointer-events-auto flex items-start gap-2.5 rounded-lg bg-overlay py-2.5 pl-3 pr-2 text-[13px] shadow-pop [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0')}>
      {ICON[tone]}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-xs text-fg-muted">{toast.description}</p>}
      </div>
      {toast.action && (
        <button type="button" onClick={() => { toast.action!.onClick(); onDismiss(toast.id); }}
          className="h-6 shrink-0 rounded-md px-2 text-xs font-semibold text-accent-text hover:bg-accent-soft">
          {toast.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-line-faint hover:text-fg [&_svg]:size-3.5">
        <X aria-hidden />
      </button>
    </motion.li>
  );
}
