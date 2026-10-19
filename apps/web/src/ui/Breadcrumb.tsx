import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface BreadcrumbItem {
  id: string;
  label: ReactNode;
  /** Makes the crumb a link. */
  href?: string;
  /** Makes the crumb a button. */
  onSelect?: () => void;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/** Path such as `TCG Live › Event › Round 1`; the last item is the current page. */
export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={cx('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-[13px] text-fg-muted">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          const crumb = 'truncate rounded-md px-1 py-0.5';
          return (
            <li key={item.id} className={cx('flex min-w-0 items-center gap-1', last ? 'shrink' : 'shrink-[2]')}>
              {last ? (
                <span aria-current="page" className={cx(crumb, 'font-semibold text-fg')}>{item.label}</span>
              ) : item.href ? (
                <a href={item.href} className={cx(crumb, 'hover:bg-line-faint hover:text-fg')}>{item.label}</a>
              ) : item.onSelect ? (
                <button type="button" onClick={item.onSelect} className={cx(crumb, 'hover:bg-line-faint hover:text-fg')}>{item.label}</button>
              ) : (
                <span className={crumb}>{item.label}</span>
              )}
              {!last && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
