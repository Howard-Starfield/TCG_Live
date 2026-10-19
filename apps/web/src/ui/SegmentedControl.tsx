import { motion } from 'motion/react';
import { useCallback, useId, type ReactNode } from 'react';
import { cx } from './cx';
import { useRovingFocus } from './hooks/useRovingFocus';
import { springs, useSafeTransition } from './motion';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** Tooltip text, e.g. why an option is unavailable. */
  title?: string;
}

export interface SegmentedControlProps<V extends string> {
  /** Accessible name of the group. */
  label: string;
  options: Array<SegmentOption<V>>;
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md';
  className?: string;
}

/** Single-choice pill group (radio semantics); arrow keys move the selection, the indicator slides. */
export function SegmentedControl<V extends string>({ label, options, value, onChange, size = 'sm', className }: SegmentedControlProps<V>) {
  const indicatorId = useId();
  const transition = useSafeTransition(springs.control);
  const selectedIndex = options.findIndex(option => option.value === value);
  const isDisabled = useCallback((index: number) => Boolean(options[index]?.disabled), [options]);
  const onNavigate = useCallback((index: number) => {
    const option = options[index];
    if (option && !option.disabled) onChange(option.value);
  }, [onChange, options]);
  const roving = useRovingFocus({ count: options.length, orientation: 'both', activeIndex: Math.max(0, selectedIndex), isDisabled, onNavigate });

  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex w-fit shrink-0 rounded-full bg-line-faint p-0.5', className)}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={selected} disabled={option.disabled}
            title={option.title} {...roving.getItemProps(index)}
            onClick={() => onChange(option.value)}
            className={cx('relative isolate whitespace-nowrap rounded-full font-medium outline-offset-1 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'h-[22px] px-2.5 text-[11.5px]' : 'h-7 px-3 text-xs',
              selected ? 'text-fg' : 'text-fg-muted hover:text-fg')}>
            {selected && (
              <motion.span layoutId={indicatorId} transition={transition} aria-hidden
                className="absolute inset-0 -z-10 rounded-full bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_0.5px_var(--color-line)]" />
            )}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
