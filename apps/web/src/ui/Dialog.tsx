import { AlertTriangle, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Button, IconButton } from './Button';
import { cx, focusableWithin } from './cx';
import { Field, Textarea } from './Field';
import { useSafeVariants, variants } from './motion';
import { Portal, usePortalContainer } from './Portal';

export interface DialogProps {
  open: boolean;
  /** Called on Escape, backdrop click and the close button. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row, right-aligned. */
  footer?: ReactNode;
  /** Element to focus on open; defaults to the first focusable element in the body, then the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** `alertdialog` for confirmations that interrupt the user. */
  role?: 'dialog' | 'alertdialog';
  /** Shown for destructive flows: a danger icon next to the title. */
  tone?: 'default' | 'danger';
  /** Blocks Escape and backdrop dismissal while something is in flight. */
  dismissible?: boolean;
  width?: 'sm' | 'md' | 'lg';
}

const WIDTH = { sm: 'max-w-[400px]', md: 'max-w-[480px]', lg: 'max-w-[640px]' } as const;

/**
 * Modal dialog: traps Tab focus inside, closes on Escape and backdrop click, makes the rest of the page
 * inert, and returns focus to the element that opened it.
 */
export function Dialog({ open, onClose, title, description, children, footer, initialFocusRef, role = 'dialog', tone = 'default', dismissible = true, width = 'md' }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const backdropVariants = useSafeVariants(variants.backdrop);
  const panelVariants = useSafeVariants(variants.dialog);

  // One effect owns the modal lifecycle so the order is fixed: remember the opener, make the rest of the
  // page inert, move focus in; on close, lift inert first and only then give focus back to the opener.
  const layerRef = useRef<HTMLDivElement | null>(null);
  const initialFocus = useRef(initialFocusRef);
  initialFocus.current = initialFocusRef;
  // The portal container can arrive after the first render (PortalScope), so the effect also waits for it:
  // a dialog mounted already open still moves focus in, makes the page inert and restores focus later.
  const container = usePortalContainer();
  useEffect(() => {
    if (!open || !container || !layerRef.current) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inerted = makeOthersInert(layerRef.current);
    const panel = panelRef.current;
    if (panel) {
      const target = initialFocus.current?.current ?? focusableWithin(panel).find(el => !el.dataset.dialogClose) ?? panel;
      target.focus();
    }
    return () => {
      inerted.forEach(el => el.removeAttribute('inert'));
      if (opener?.isConnected) opener.focus();
    };
  }, [open, container]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!event.defaultPrevented && dismissible) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const items = focusableWithin(panelRef.current);
    if (items.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <div ref={layerRef} className="fixed inset-0 z-50 grid place-items-center p-4" onKeyDown={onKeyDown}>
            <motion.div aria-hidden className="absolute inset-0 bg-[rgb(20_19_17/0.32)] backdrop-blur-[2px] dark:bg-[rgb(0_0_0/0.5)]"
              variants={backdropVariants} initial="hidden" animate="shown" exit="exit"
              onClick={() => { if (dismissible) onClose(); }} />
            <motion.div ref={panelRef} role={role} aria-modal="true" aria-labelledby={titleId}
              aria-describedby={description ? descriptionId : undefined} tabIndex={-1}
              variants={panelVariants} initial="hidden" animate="shown" exit="exit"
              className={cx('relative flex max-h-[min(640px,calc(100vh-32px))] w-full flex-col overflow-hidden rounded-xl bg-overlay text-fg shadow-pop outline-none', WIDTH[width])}>
              <header className="flex items-start gap-3 px-5 pb-1 pt-4">
                {tone === 'danger' && (
                  <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
                    <AlertTriangle className="size-4" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <h2 id={titleId} className="text-[15px] font-semibold leading-snug">{title}</h2>
                  {description && <p id={descriptionId} className="mt-1 text-[13px] text-fg-muted">{description}</p>}
                </div>
                <IconButton aria-label="Close dialog" data-dialog-close="true" size="sm" icon={<X aria-hidden />}
                  onClick={onClose} disabled={!dismissible} className="-mr-2 -mt-1" />
              </header>
              {children && <div className="min-h-0 overflow-y-auto px-5 py-3 text-[13px]">{children}</div>}
              {footer && <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-2">{footer}</footer>}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </Portal>
  );
}

/** Sets `inert` on every element outside `layer`'s ancestor chain; returns what it changed. */
function makeOthersInert(layer: HTMLElement | null): HTMLElement[] {
  const changed: HTMLElement[] = [];
  let node: HTMLElement | null = layer;
  while (node && node !== document.body && node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute('inert') || sibling.hasAttribute('data-inert-exempt')) continue;
      sibling.setAttribute('inert', '');
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return changed;
}

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  /** Receives the trimmed reason when `requireReason` is set, otherwise an empty string. */
  onConfirm: (reason: string) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styling for destructive or corrective actions. */
  danger?: boolean;
  /** Asks for a non-empty reason before the confirm button enables. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonDescription?: string;
  /** Shows a spinner on confirm and blocks dismissal. */
  pending?: boolean;
}

/** Confirmation built on Dialog, with an optional required reason. */
export function ConfirmDialog({ open, onCancel, onConfirm, title, description, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, requireReason = false, reasonLabel = 'Reason', reasonPlaceholder, reasonDescription, pending = false }: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) { setReason(''); setTouched(false); }
  }, [open]);
  const trimmed = reason.trim();
  const blocked = requireReason && trimmed.length === 0;

  const submit = () => {
    setTouched(true);
    if (blocked || pending) return;
    onConfirm(requireReason ? trimmed : '');
  };

  return (
    <Dialog open={open} onClose={onCancel} title={title} description={description} role="alertdialog"
      tone={danger ? 'danger' : 'default'} dismissible={!pending}
      footer={(
        <>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={submit} loading={pending} disabled={blocked}>{confirmLabel}</Button>
        </>
      )}>
      {(children || requireReason) && (
        <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); submit(); }}>
          {children}
          {requireReason && (
            <Field label={reasonLabel} description={reasonDescription} required
              error={touched && blocked ? 'A reason is required.' : undefined}>
              <Textarea value={reason} rows={3} placeholder={reasonPlaceholder} disabled={pending}
                onChange={event => setReason(event.target.value)} onBlur={() => setTouched(true)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
                }} />
            </Field>
          )}
        </form>
      )}
    </Dialog>
  );
}
