import { motion } from 'motion/react';
import { useCallback, useId, type ReactNode } from 'react';
import { cx } from './cx';
import { useRovingFocus } from './hooks/useRovingFocus';
import { Kbd } from './Kbd';
import { springs, useSafeTransition } from './motion';

export interface ToggleTabProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  icon?: ReactNode;
  children: ReactNode;
  /** Shortcut hint, e.g. ["Alt", "1"]; also added to the tooltip title. The shell binds the keys. */
  shortcut?: string[];
  className?: string;
}

/** Toolbar toggle (`aria-pressed`), e.g. the Live preview and List preview tabs. */
export function ToggleTab({ pressed, onPressedChange, icon, children, shortcut, className }: ToggleTabProps) {
  return (
    <button type="button" aria-pressed={pressed} onClick={() => onPressedChange(!pressed)}
      aria-keyshortcuts={shortcut?.join('+')}
      className={cx('ui-press inline-flex h-[30px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-2.5 text-[12.5px] font-medium',
        'transition-[background-color,color,box-shadow] duration-200 ease-out-expo [&_svg]:size-4',
        pressed ? 'bg-raised text-fg shadow-raised [&_svg]:text-accent-text' : 'text-fg-muted hover:bg-line-faint hover:text-fg', className)}>
      {icon && <span aria-hidden className="grid">{icon}</span>}
      {children}
      {shortcut && <Kbd keys={shortcut} className="ml-0.5" />}
    </button>
  );
}

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** Trailing count or badge. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabStripProps<V extends string> {
  /** Accessible name of the tab list. */
  label: string;
  tabs: Array<TabItem<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Prefix for tab/panel ids; panels use `tabPanelId(idBase, value)`. Defaults to a generated id. */
  idBase?: string;
  className?: string;
}

export const tabId = (base: string, value: string) => `${base}-tab-${value}`;
export const tabPanelId = (base: string, value: string) => `${base}-panel-${value}`;

/**
 * Tab list with roving tabindex: one tab is tabbable, arrow keys move between tabs and selection follows
 * focus. Render each panel with `TabPanel` using the same `idBase`.
 */
export function TabStrip<V extends string>({ label, tabs, value, onChange, idBase, className }: TabStripProps<V>) {
  const generated = useId();
  const base = idBase ?? generated;
  const indicatorId = useId();
  const transition = useSafeTransition(springs.control);
  const selectedIndex = tabs.findIndex(tab => tab.value === value);
  const isDisabled = useCallback((index: number) => Boolean(tabs[index]?.disabled), [tabs]);
  const onNavigate = useCallback((index: number) => {
    const tab = tabs[index];
    if (tab && !tab.disabled) onChange(tab.value);
  }, [onChange, tabs]);
  const roving = useRovingFocus({ count: tabs.length, orientation: 'horizontal', activeIndex: Math.max(0, selectedIndex), isDisabled, onNavigate });

  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className={cx('flex items-center gap-0.5', className)}>
      {tabs.map((tab, index) => {
        const selected = tab.value === value;
        return (
          <button key={tab.value} type="button" role="tab" id={tabId(base, tab.value)} aria-selected={selected}
            aria-controls={tabPanelId(base, tab.value)} disabled={tab.disabled} {...roving.getItemProps(index)}
            onClick={() => onChange(tab.value)}
            className={cx('relative isolate inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors duration-200 [&_svg]:size-3.5',
              'disabled:cursor-not-allowed disabled:opacity-40', selected ? 'text-fg' : 'text-fg-muted hover:text-fg')}>
            {selected && (
              <motion.span layoutId={indicatorId} transition={transition} aria-hidden
                className="absolute inset-0 -z-10 rounded-md bg-raised shadow-raised" />
            )}
            {tab.icon && <span aria-hidden className="grid">{tab.icon}</span>}
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idBase: string;
  value: string;
  children: ReactNode;
  className?: string;
}

/** Panel for the selected tab; labelled by its tab. */
export function TabPanel({ idBase, value, children, className }: TabPanelProps) {
  return (
    <div role="tabpanel" id={tabPanelId(idBase, value)} aria-labelledby={tabId(idBase, value)} tabIndex={0} className={cx('outline-none', className)}>
      {children}
    </div>
  );
}
