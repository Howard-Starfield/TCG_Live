import type { ReactNode } from 'react';
import { cx } from './cx';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const DOT: Record<Tone, string> = {
  neutral: 'bg-line-strong',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger'
};

export interface StatusDotProps {
  tone?: Tone;
  /** Breathing pulse for "happening now" (static under reduced motion). */
  live?: boolean;
  /** Accessible text. Without it the dot is decorative and hidden from assistive tech. */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusDot({ tone = 'neutral', live = false, label, size = 'md', className }: StatusDotProps) {
  return (
    <span role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      data-live={live || undefined}
      className={cx('ui-status-dot relative inline-block shrink-0 rounded-full', size === 'sm' ? 'size-1.5' : 'size-2', DOT[tone], className)} />
  );
}

export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'offline' | 'degraded' | 'idle';

const CONNECTION: Record<ConnectionState, { tone: Tone; live: boolean; text: string }> = {
  connected: { tone: 'success', live: true, text: 'Connected' },
  connecting: { tone: 'warning', live: true, text: 'Connecting' },
  reconnecting: { tone: 'warning', live: true, text: 'Reconnecting' },
  degraded: { tone: 'warning', live: false, text: 'Degraded' },
  offline: { tone: 'danger', live: false, text: 'Offline' },
  idle: { tone: 'neutral', live: false, text: 'Not applicable' }
};

export interface ConnectionPillProps {
  /** What is connected, e.g. "Discord" or "PostgreSQL". */
  label: string;
  state: ConnectionState;
  /** Overrides the default state wording, e.g. "Ready". */
  detail?: ReactNode;
  className?: string;
}

/** Compact status chip for a connection; the state is announced politely when it changes. */
export function ConnectionPill({ label, state, detail, className }: ConnectionPillProps) {
  const meta = CONNECTION[state];
  return (
    <span role="status" data-state={state}
      className={cx('inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-line-faint px-2.5 text-xs text-fg-muted', className)}>
      <StatusDot tone={meta.tone} live={meta.live} size="sm" />
      <span className="font-medium text-fg">{label}</span>
      <span>{detail ?? meta.text}</span>
    </span>
  );
}
