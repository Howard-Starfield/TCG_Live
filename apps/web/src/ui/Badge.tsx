import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';
import { StatusDot, type Tone } from './Status';

const TONE: Record<Tone, string> = {
  neutral: 'bg-line-faint text-fg-muted',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger'
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Monospace for identifiers such as `M1` or revision numbers. */
  mono?: boolean;
  children: ReactNode;
}

/** Small square-cornered label for reasons, phases and identifiers. */
export function Badge({ tone = 'neutral', mono = false, className, children, ...rest }: BadgeProps) {
  return (
    <span {...rest} className={cx('inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-2xs font-semibold tabular-nums',
      mono && 'font-mono font-medium', TONE[tone], className)}>
      {children}
    </span>
  );
}

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Leading status dot. */
  dot?: boolean;
  /** Pulses the dot. */
  live?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

/** Rounded pill for statuses and counts. */
export function Chip({ tone = 'neutral', dot = false, live = false, icon, className, children, ...rest }: ChipProps) {
  return (
    <span {...rest} className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium tabular-nums [&_svg]:size-3.5',
      TONE[tone], className)}>
      {dot && <StatusDot tone={tone} live={live} size="sm" />}
      {icon}
      {children}
    </span>
  );
}

/** Numeric counter bubble (e.g. the "Needs you" count). */
export function CountBadge({ count, tone = 'danger', label }: { count: number; tone?: Tone; label?: string }) {
  return (
    <span aria-label={label} className={cx('inline-grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10.5px] font-semibold leading-none tabular-nums', TONE[tone])}>
      {count}
    </span>
  );
}
