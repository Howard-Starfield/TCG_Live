// Small building blocks shared by the List preview tabs. Owned by L7 (web-lists).
import type { EventSnapshotDto, Seat, Snowflake } from '@tcg-live/core';
import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { memberName } from '../../data';
import { Avatar, Badge, Chip, IconButton, Tooltip, cx, type Tone } from '../../ui';
import type { StatusMeta } from './model';

/**
 * Content-box width of an element, kept current with a ResizeObserver. Null until first measured
 * (and where ResizeObserver is missing), so callers render their widest layout by default.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number | null] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const next = entries[entries.length - 1]?.contentRect.width;
      if (next !== undefined && next > 0) setWidth(Math.round(next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, width];
}

export type CopyState = 'idle' | 'copied' | 'failed';

/** Clipboard copy with a short-lived result state. */
export function useCopy(resetMs = 1600): { state: CopyState; copy(text: string): Promise<void> } {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), resetMs);
  }, [resetMs]);
  return { state, copy };
}

function CopyAnnouncement({ state }: { state: CopyState }) {
  return (
    <span role="status" className="sr-only">
      {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}
    </span>
  );
}

/** Clicks inside activatable rows must not activate the row. */
const stop = (event: MouseEvent) => event.stopPropagation();

/** Icon button that copies a Discord ID. */
export function CopyIdButton({ value, what }: { value: Snowflake; what: string }) {
  const { state, copy } = useCopy();
  return (
    <>
      <Tooltip content={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : `Copy ${what} ID`} describe={false}>
        <IconButton aria-label={`Copy ${what} ID`} size="sm" className="lists-copy -my-1 size-6"
          icon={state === 'copied' ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
          onClick={event => { stop(event); void copy(value); }} />
      </Tooltip>
      <CopyAnnouncement state={state} />
    </>
  );
}

/** A Discord ID in monospace with a copy button. */
export function IdValue({ value, what, className }: { value: Snowflake; what: string; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="min-w-0 truncate font-mono text-xs text-fg" title={value}>{value}</span>
      <CopyIdButton value={value} what={what} />
    </span>
  );
}

/** Square seat letter, e.g. `A`. */
export function SeatTag({ seat, className }: { seat: Seat; className?: string }) {
  return (
    <span aria-label={`Seat ${seat}`} role="img"
      className={cx('inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-line-faint font-mono text-2xs font-semibold text-fg-muted', className)}>
      {seat}
    </span>
  );
}

/** Avatar plus display name; the name is a button that copies the member ID (shown in its tooltip). */
export function MemberName({ snapshot, memberId, avatar = true, compact = false, className }: {
  snapshot: EventSnapshotDto; memberId: Snowflake | null; avatar?: boolean;
  /** Narrower name truncation for narrow panes. */
  compact?: boolean; className?: string;
}) {
  const { state, copy } = useCopy();
  if (!memberId) return <span className="text-fg-subtle">Open seat</span>;
  const member = snapshot.members[memberId];
  const name = memberName(snapshot, memberId);
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)}>
      {avatar && <Avatar src={member?.avatarUrl} name={name} size="sm" decorative />}
      <Tooltip content={state === 'copied' ? 'Member ID copied' : state === 'failed' ? 'Copy failed' : `ID ${memberId} · click to copy`}>
        <button type="button" aria-label={`${name}, copy member ID`} onClick={event => { stop(event); void copy(memberId); }}
          className={cx('min-w-0 truncate rounded-[4px]', compact ? 'max-w-[7.5rem]' : 'max-w-[12rem]',
            'text-left font-medium text-fg outline-none hover:underline hover:decoration-line-strong hover:underline-offset-2 focus-visible:shadow-[0_0_0_2px_var(--color-accent-ring)]')}>
          {name}
        </button>
      </Tooltip>
      <CopyAnnouncement state={state} />
    </span>
  );
}

/** Compact kit Chip for a status (tone, dot, optional live pulse). */
export function StatusChip({ meta, className, children }: { meta: StatusMeta; className?: string; children?: ReactNode }) {
  return (
    <Chip tone={meta.tone} dot live={meta.live ?? false}
      className={cx('lists-chip h-5 px-2 text-2xs', className)}>
      {children ?? meta.label}
    </Chip>
  );
}

/** Kit Badge with an optional title. */
export function ToneBadge({ tone = 'neutral', mono, children, className, title }: {
  tone?: Tone; mono?: boolean; children: ReactNode; className?: string; title?: string;
}) {
  return (
    <Badge tone={tone} mono={mono ?? false} title={title} className={className}>
      {children}
    </Badge>
  );
}

/** Em dash for "nothing here"; assistive tech hears the label instead. */
export function None({ label = 'None' }: { label?: string }) {
  return (
    <span className="text-fg-subtle">
      <span aria-hidden>—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
