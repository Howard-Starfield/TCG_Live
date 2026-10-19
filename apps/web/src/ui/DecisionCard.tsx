import { useId, type ReactNode } from 'react';
import { Badge } from './Badge';
import { cx } from './cx';
import { StatusDot, type Tone } from './Status';

export interface DecisionReason {
  label: string;
  tone?: Tone;
}

export interface DecisionCardProps {
  title: ReactNode;
  /** Reasons render as badges next to the title (strings use the card tone). */
  reasons?: Array<string | DecisionReason>;
  /** Right-aligned secondary text such as a revision and time. */
  meta?: ReactNode;
  /** Card urgency; `danger` pulses its dot. */
  tone?: Tone;
  /** Explanation paragraph. */
  children?: ReactNode;
  /** Action slot (buttons). */
  actions?: ReactNode;
  className?: string;
}

/** A decision that needs a human: title, reasons, context and actions. */
export function DecisionCard({ title, reasons = [], meta, tone = 'danger', children, actions, className }: DecisionCardProps) {
  const titleId = useId();
  return (
    <article aria-labelledby={titleId} className={cx('rounded-lg bg-raised px-3.5 pb-3 pt-3 shadow-raised', className)}>
      <header className="flex min-w-0 items-center gap-2">
        <StatusDot tone={tone} live={tone === 'danger' || tone === 'accent'} />
        <h3 id={titleId} className="truncate text-[13px] font-semibold">{title}</h3>
        {reasons.length > 0 && <ul aria-label="Reasons" className="flex min-w-0 flex-wrap gap-1">
          {reasons.map(reason => {
            const item = typeof reason === 'string' ? { label: reason, tone } : { tone, ...reason };
            return <li key={item.label}><Badge tone={item.tone}>{item.label}</Badge></li>;
          })}
        </ul>}
        {meta && <span className="ml-auto shrink-0 font-mono text-[10.5px] text-fg-subtle tabular-nums">{meta}</span>}
      </header>
      {children && <div className="mt-1.5 text-[13px] text-fg-muted [&_b]:font-semibold [&_b]:text-fg">{children}</div>}
      {actions && <div className="mt-2.5 flex flex-wrap gap-1.5">{actions}</div>}
    </article>
  );
}
