import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefCallback } from 'react';
import { cx, focusableWithin } from './cx';
import { useDismiss, useFloating, type Placement } from './floating';
import { Kbd } from './Kbd';
import { useSafeVariants, variants } from './motion';
import { Portal, usePortalContainer } from './Portal';

export interface TriggerProps {
  ref: RefCallback<HTMLElement>;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  'aria-haspopup': 'menu' | 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
}

export type MenuEntry =
  | {
      type?: 'item';
      id: string;
      label: ReactNode;
      /** Plain text for typeahead when the label is not a string. */
      textValue?: string;
      icon?: ReactNode;
      shortcut?: string[];
      danger?: boolean;
      disabled?: boolean;
      /** Set for choice items (renders `menuitemradio` with a check mark). */
      checked?: boolean;
      onSelect: () => void;
    }
  | { type: 'separator'; id: string }
  | { type: 'label'; id: string; label: ReactNode };

type MenuItemEntry = Extract<MenuEntry, { onSelect: () => void }>;

function useAnchoredOpen(defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);
  const anchorRef = useRef<HTMLElement | null>(null);
  const setAnchor = useCallback((node: HTMLElement | null) => { anchorRef.current = node; }, []);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) anchorRef.current?.focus();
  }, []);
  return { open, setOpen, anchorRef, setAnchor, close };
}

const SURFACE = 'z-[60] min-w-44 rounded-lg bg-overlay p-1 text-[13px] text-fg shadow-pop outline-none';

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  items: MenuEntry[];
  trigger: (props: TriggerProps) => ReactNode;
  placement?: Placement;
  /** Initially open (gallery and screenshots). */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Dropdown menu: arrow keys, Home/End and typeahead move between items; Enter or Space selects; Escape
 * closes and returns focus to the trigger; clicking outside closes.
 */
export function Menu({ label, items, trigger, placement = 'bottom-start', defaultOpen = false, className }: MenuProps) {
  const menuId = useId();
  const { open, setOpen, anchorRef, setAnchor, close } = useAnchoredOpen(defaultOpen);
  const { floatingRef, setFloating, position } = useFloating(anchorRef, open, placement);
  const menuVariants = useSafeVariants(variants.popover);
  const enabled = items.filter((item): item is MenuItemEntry => item.type !== 'separator' && item.type !== 'label' && !item.disabled);
  const [focusId, setFocusId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const typeahead = useRef({ text: '', at: 0 });

  useDismiss(open, [anchorRef, floatingRef], reason => close(reason === 'escape'));

  // Focus follows the active item while the menu is open (re-run once a scoped portal container exists).
  const container = usePortalContainer();
  useEffect(() => {
    if (open && focusId) itemRefs.current.get(focusId)?.focus();
  }, [open, focusId, container]);

  const openAt = (which: 'first' | 'last') => {
    setOpen(true);
    setFocusId((which === 'first' ? enabled[0] : enabled[enabled.length - 1])?.id ?? null);
  };

  const select = (item: MenuItemEntry) => {
    close(true);
    item.onSelect();
  };

  const move = (delta: number) => {
    if (enabled.length === 0) return;
    const index = enabled.findIndex(item => item.id === focusId);
    const next = index === -1 ? (delta > 0 ? 0 : enabled.length - 1) : (index + delta + enabled.length) % enabled.length;
    setFocusId(enabled[next]!.id);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = enabled.find(item => item.id === focusId);
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(1); return;
      case 'ArrowUp': event.preventDefault(); move(-1); return;
      case 'Home': event.preventDefault(); setFocusId(enabled[0]?.id ?? null); return;
      case 'End': event.preventDefault(); setFocusId(enabled[enabled.length - 1]?.id ?? null); return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current) select(current);
        return;
      case 'Tab': event.preventDefault(); close(true); return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const state = typeahead.current;
      state.text = now - state.at > 700 ? event.key.toLowerCase() : state.text + event.key.toLowerCase();
      state.at = now;
      const text = (item: MenuItemEntry) => (item.textValue ?? (typeof item.label === 'string' ? item.label : '')).toLowerCase();
      const match = enabled.find(item => text(item).startsWith(state.text));
      if (match) setFocusId(match.id);
    }
  };

  const triggerProps: TriggerProps = {
    ref: setAnchor,
    onClick: () => (open ? close(false) : openAt('first')),
    onKeyDown: event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openAt(event.key === 'ArrowDown' ? 'first' : 'last');
      }
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined
  };

  return (
    <>
      {trigger(triggerProps)}
      <Portal>
        <AnimatePresence>
          {open && (
            <motion.div ref={setFloating} key="menu" id={menuId} role="menu" aria-label={label} tabIndex={-1}
              variants={menuVariants} initial="hidden" animate="shown" exit="exit" onKeyDown={onMenuKeyDown}
              style={{ position: 'fixed', top: position?.top ?? -9999, left: position?.left ?? -9999 }}
              className={cx(SURFACE, className)}>
              {items.map(item => {
                if (item.type === 'separator') return <div key={item.id} role="separator" className="mx-1 my-1 h-px bg-line" />;
                if (item.type === 'label') return <div key={item.id} role="presentation" className="px-2 pb-1 pt-1.5 text-2xs font-semibold text-fg-subtle">{item.label}</div>;
                const choice = item.checked !== undefined;
                return (
                  <div key={item.id} ref={node => { if (node) itemRefs.current.set(item.id, node); else itemRefs.current.delete(item.id); }}
                    role={choice ? 'menuitemradio' : 'menuitem'} aria-checked={choice ? item.checked : undefined}
                    aria-disabled={item.disabled || undefined} tabIndex={-1}
                    onClick={() => { if (!item.disabled) select(item); }}
                    onPointerMove={() => { if (!item.disabled && focusId !== item.id) setFocusId(item.id); }}
                    className={cx('flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 outline-none [&_svg]:size-4',
                      'focus:bg-line-faint aria-disabled:opacity-45', item.danger ? 'text-danger focus:bg-danger-soft' : 'text-fg')}>
                    {choice
                      ? <span aria-hidden className="grid w-4 place-items-center text-accent-text">{item.checked && <Check />}</span>
                      : item.icon && <span aria-hidden className={cx('grid', !item.danger && 'text-fg-muted')}>{item.icon}</span>}
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.shortcut && <Kbd keys={item.shortcut} />}
                  </div>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}

export interface PopoverProps {
  /** Accessible name of the popover dialog. */
  label: string;
  trigger: (props: TriggerProps) => ReactNode;
  /** Content, or a render function receiving `close`. */
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: Placement;
  defaultOpen?: boolean;
  className?: string;
}

/** Non-modal floating panel anchored to a trigger; Escape or an outside click closes it. */
export function Popover({ label, trigger, children, placement = 'bottom-start', defaultOpen = false, className }: PopoverProps) {
  const panelId = useId();
  const { open, setOpen, anchorRef, setAnchor, close } = useAnchoredOpen(defaultOpen);
  const { floatingRef, setFloating, position } = useFloating(anchorRef, open, placement);
  const popVariants = useSafeVariants(variants.popover);
  useDismiss(open, [anchorRef, floatingRef], reason => close(reason === 'escape'));
  const opened = useRef(false);
  const container = usePortalContainer();

  useEffect(() => {
    if (!open) { opened.current = false; return; }
    const panel = floatingRef.current;
    if (opened.current || defaultOpen || !panel) return;
    opened.current = true;
    (focusableWithin(panel)[0] ?? panel).focus();
  }, [open, defaultOpen, floatingRef, container]);

  const triggerProps: TriggerProps = {
    ref: setAnchor,
    onClick: () => (open ? close(false) : setOpen(true)),
    onKeyDown: () => {},
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined
  };

  return (
    <>
      {trigger(triggerProps)}
      <Portal>
        <AnimatePresence>
          {open && (
            <motion.div ref={setFloating} key="popover" id={panelId} role="dialog" aria-label={label} tabIndex={-1}
              variants={popVariants} initial="hidden" animate="shown" exit="exit"
              style={{ position: 'fixed', top: position?.top ?? -9999, left: position?.left ?? -9999 }}
              className={cx(SURFACE, 'p-3', className)}>
              {typeof children === 'function' ? children(() => close(true)) : children}
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
