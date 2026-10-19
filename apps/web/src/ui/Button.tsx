import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-fg-on-accent hover:bg-accent-hover shadow-[0_1px_2px_rgb(0_0_0/0.12)]',
  secondary: 'bg-raised text-fg shadow-raised hover:bg-sunken',
  ghost: 'bg-transparent text-fg-muted hover:bg-line-faint hover:text-fg',
  danger: 'bg-danger text-fg-on-accent hover:brightness-95 shadow-[0_1px_2px_rgb(0_0_0/0.12)]'
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5',
  md: 'h-8 gap-2 rounded-md px-3 text-[13px] [&_svg]:size-4',
  lg: 'h-10 gap-2 rounded-lg px-4 text-sm [&_svg]:size-4'
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: 'size-7 rounded-md [&_svg]:size-3.5',
  md: 'size-8 rounded-md [&_svg]:size-4',
  lg: 'size-10 rounded-lg [&_svg]:size-[18px]'
};

const BASE = 'ui-press relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium '
  + 'transition-[background-color,color,box-shadow,transform,filter] duration-200 ease-out-expo '
  + 'disabled:pointer-events-none disabled:opacity-45 aria-busy:cursor-progress';

interface CommonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets `aria-busy` and blocks clicks. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export interface ButtonProps extends CommonProps {
  children: ReactNode;
  /** Leading icon (a lucide element). */
  icon?: ReactNode;
  /** Trailing content such as a `Kbd` hint. */
  trailing?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon, trailing, children, className, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx(BASE, VARIANT[variant], SIZE[size], className)}>
      {loading ? <LoaderCircle aria-hidden className="animate-spin" /> : icon}
      <span className="truncate">{children}</span>
      {trailing}
    </button>
  );
}

export interface IconButtonProps extends CommonProps {
  /** Required: icon-only buttons have no visible text. */
  'aria-label': string;
  icon: ReactNode;
}

export function IconButton({ variant = 'ghost', size = 'md', loading = false, icon, className, disabled, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx(BASE, VARIANT[variant], ICON_SIZE[size], className)}>
      {loading ? <LoaderCircle aria-hidden className="animate-spin" /> : icon}
    </button>
  );
}
