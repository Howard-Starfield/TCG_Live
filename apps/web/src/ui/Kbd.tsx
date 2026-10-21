import { cx } from './cx';

export interface KbdProps {
  /** One key ("Esc") or a combination (["Alt", "1"]). */
  keys: string | string[];
  className?: string;
}

/** Keyboard shortcut hint. */
export function Kbd({ keys, className }: KbdProps) {
  const list = Array.isArray(keys) ? keys : [keys];
  return (
    <span className={cx('inline-flex items-center gap-0.5', className)}>
      {list.map((key, index) => (
        <kbd key={`${key}-${index}`} className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] bg-line-faint px-1 font-mono text-[10.5px] font-medium leading-none text-fg-subtle shadow-[inset_0_-1px_0_var(--color-line)]">
          {key}
        </kbd>
      ))}
    </span>
  );
}
