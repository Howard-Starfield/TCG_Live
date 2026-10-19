import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from './Button';
import { cx } from './cx';

export interface PaneHeaderProps {
  title: string;
  icon?: ReactNode;
  /** Controls next to the title (segmented controls, tabs). */
  children?: ReactNode;
  /** Right-aligned actions before the close button. */
  actions?: ReactNode;
  /** Adds a close button labelled "Close <title>". */
  onClose?: () => void;
  /** Heading level for the title (default 2). */
  level?: 2 | 3;
  className?: string;
}

/** Header row of a dock pane: icon, title, controls, actions, close. */
export function PaneHeader({ title, icon, children, actions, onClose, level = 2, className }: PaneHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={cx('flex h-[42px] shrink-0 items-center gap-2 pl-3 pr-1.5', className)}>
      {icon && <span aria-hidden className="grid text-accent-text [&_svg]:size-4">{icon}</span>}
      <Heading className="whitespace-nowrap text-[12.5px] font-semibold text-fg">{title}</Heading>
      {children && <div className="flex min-w-0 items-center gap-2">{children}</div>}
      <div className="ml-auto flex items-center gap-1">
        {actions}
        {onClose && <IconButton aria-label={`Close ${title.toLowerCase()}`} size="sm" icon={<X aria-hidden />} onClick={onClose} />}
      </div>
    </div>
  );
}
