import { useEffect, useState } from 'react';
import { cx } from './cx';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE: Record<AvatarSize, string> = {
  xs: 'size-4 text-[8px]',
  sm: 'size-5 text-[10px]',
  md: 'size-6 text-[11px]',
  lg: 'size-8 text-xs'
};

/** Muted warm hues for initials; picked deterministically from the name. */
const HUES = [18, 32, 145, 168, 200, 255, 290, 340];

export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0]!)[0] ?? '';
  const second = words.length > 1 ? Array.from(words[words.length - 1]!)[0] ?? '' : '';
  return (first + second).toUpperCase();
}

function hueOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return HUES[hash % HUES.length]!;
}

export interface AvatarProps {
  /** Discord CDN avatar URL; null or a failed load falls back to initials. */
  src: string | null | undefined;
  /** Display name; used for the initials, the color and the accessible name. */
  name: string | null | undefined;
  size?: AvatarSize;
  shape?: 'circle' | 'rounded';
  /** Hide from assistive tech when the name is already shown next to it. */
  decorative?: boolean;
  className?: string;
}

/** Discord avatar with an initials fallback. */
export function Avatar({ src, name, size = 'md', shape = 'circle', decorative = false, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const label = name?.trim() || 'Unknown member';
  const classes = cx('inline-grid shrink-0 place-items-center overflow-hidden font-semibold leading-none select-none',
    shape === 'circle' ? 'rounded-full' : 'rounded-[28%]', SIZE[size], className);
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': label };

  if (src && !failed) {
    return (
      <span {...a11y} className={cx(classes, 'bg-sunken')}>
        <img src={src} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" />
      </span>
    );
  }
  const hue = hueOf(label);
  return (
    <span {...a11y} data-fallback="" className={classes}
      style={{ backgroundColor: `oklch(0.66 0.07 ${hue})`, color: 'white' }}>
      {initialsOf(name)}
    </span>
  );
}
