import { cx } from '../../ui';

/** The clay "T" square used in the sidebar and on the login screen. */
export function BrandMark({ size = 'md', className }: { size?: 'md' | 'lg'; className?: string }) {
  return (
    <span aria-hidden className={cx('shell-brand-mark', size === 'lg' && 'is-lg', className)}>T</span>
  );
}
