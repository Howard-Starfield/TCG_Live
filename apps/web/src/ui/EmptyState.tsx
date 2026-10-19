import type { ReactNode } from 'react';
import { cx } from './cx';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** A button or link. */
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Placeholder for an empty list or pane. */
export function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 px-4 py-6' : 'gap-2 px-6 py-12', className)}>
      {icon && <span aria-hidden className="mb-1 grid size-10 place-items-center rounded-lg bg-line-faint text-fg-subtle [&_svg]:size-5">{icon}</span>}
      <p className="text-[13px] font-semibold text-fg">{title}</p>
      {description && <p className="max-w-80 text-xs text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
