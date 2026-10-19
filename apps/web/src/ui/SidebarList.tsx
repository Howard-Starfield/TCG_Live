import type { ReactNode } from 'react';
import { cx } from './cx';
import { StatusDot } from './Status';

export interface SidebarItem {
  id: string;
  label: string;
  /** Second line, e.g. "Round 1 · live". */
  meta?: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  /** Pulsing accent dot for the live session. */
  live?: boolean;
  /** Renders a link instead of a button. */
  href?: string;
}

export interface SidebarListProps {
  /** Accessible name of the list's navigation region. */
  label: string;
  /** Optional visible section heading. */
  heading?: ReactNode;
  items: SidebarItem[];
  onSelect?: (id: string) => void;
  /** Icon-only rail: labels stay available to assistive tech and as tooltips. */
  collapsed?: boolean;
  className?: string;
}

/** Sidebar navigation list (events, sections); the active item carries `aria-current="page"`. */
export function SidebarList({ label, heading, items, onSelect, collapsed = false, className }: SidebarListProps) {
  return (
    <nav aria-label={label} className={cx('flex min-w-0 flex-col gap-0.5', className)}>
      {heading && !collapsed && <div className="px-2 pb-1 pt-1 text-2xs font-semibold tracking-wide text-fg-subtle">{heading}</div>}
      <ul className="flex flex-col gap-0.5">
        {items.map(item => {
          const lead = item.icon ?? <StatusDot tone={item.live ? 'accent' : 'neutral'} live={item.live} />;
          const content = (
            <>
              <span aria-hidden className="grid w-4 shrink-0 place-items-center text-fg-muted [&_svg]:size-4">{lead}</span>
              <span className={cx('min-w-0 flex-1 text-left', collapsed && 'sr-only')}>
                <span className="block truncate text-[12.5px] font-medium">{item.label}</span>
                {item.meta && <span className="block truncate text-2xs text-fg-subtle">{item.meta}</span>}
              </span>
              {item.live && <span className="sr-only">(live)</span>}
            </>
          );
          const classes = cx('flex min-w-0 items-center rounded-[9px] text-fg transition-[background-color,box-shadow] duration-150',
            collapsed ? 'mx-auto size-8 justify-center' : 'w-full gap-2.5 px-2 py-[7px]',
            item.active ? 'bg-raised shadow-raised' : 'hover:bg-line-faint');
          return (
            <li key={item.id}>
              {item.href ? (
                <a href={item.href} aria-current={item.active ? 'page' : undefined} title={collapsed ? item.label : undefined}
                  onClick={() => onSelect?.(item.id)} className={classes}>{content}</a>
              ) : (
                <button type="button" aria-current={item.active ? 'page' : undefined} title={collapsed ? item.label : undefined}
                  onClick={() => onSelect?.(item.id)} className={classes}>{content}</button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
