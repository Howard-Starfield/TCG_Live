import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from './cx';

export interface CodeBlockProps {
  code: string;
  /** Shown in the header, e.g. "json". */
  language?: string;
  /** Wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  /** Caps the height; the body scrolls beyond it. */
  maxHeight?: number;
  className?: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** Monospace block with a copy button. */
export function CodeBlock({ code, language, wrap = false, maxHeight = 320, className }: CodeBlockProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  };

  return (
    <div className={cx('group overflow-hidden rounded-lg bg-sunken shadow-[inset_0_0_0_1px_var(--color-line-faint)]', className)}>
      <div className="flex h-8 items-center gap-2 pl-3 pr-1 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
        <span className="flex-1 truncate">{language ?? 'text'}</span>
        <button type="button" onClick={copy}
          className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-2xs normal-case tracking-normal text-fg-muted transition-colors hover:bg-line-faint hover:text-fg [&_svg]:size-3.5">
          {state === 'copied' ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
          <span>{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
        </button>
        <span role="status" className="sr-only">{state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}</span>
      </div>
      <pre style={{ maxHeight }} className={cx('overflow-auto px-3 pb-3 font-mono text-xs leading-relaxed text-fg', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
