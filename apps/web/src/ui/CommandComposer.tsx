import { ArrowUp } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton } from './Button';
import { cx } from './cx';
import { useSafeVariants, variants } from './motion';

export interface ComposerSuggestion {
  id: string;
  /** Main text, e.g. "/resolve" or "Gary". */
  label: string;
  description?: string;
  /** Replaces the trigger token; a trailing space is added. */
  insertText: string;
  icon?: ReactNode;
}

export interface ComposerTrigger {
  /** Single character that opens suggestions, e.g. "/" or "@". */
  char: string;
  /** Only trigger when the token is the first word of the input (slash commands). */
  atStart?: boolean;
  /** Suggestions for the text typed after the trigger character. */
  getSuggestions: (query: string) => ComposerSuggestion[];
  /** Heading above the list, e.g. "Commands". */
  label?: string;
}

export interface ActiveToken {
  trigger: ComposerTrigger;
  query: string;
  start: number;
  end: number;
}

/** Finds the trigger token that ends at the caret, if any. */
export function findActiveToken(text: string, caret: number, triggers: ComposerTrigger[]): ActiveToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  const token = text.slice(start, caret);
  if (token.length === 0) return null;
  const trigger = triggers.find(item => token.startsWith(item.char));
  if (!trigger) return null;
  if (trigger.atStart && text.slice(0, start).trim().length > 0) return null;
  return { trigger, query: token.slice(trigger.char.length), start, end: caret };
}

/** True while an input method editor is composing (CJK input); Enter then confirms the composition. */
export function isComposingEvent(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export interface CommandComposerProps {
  /** Controlled value; omit for an uncontrolled composer. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Called with the trimmed text on Enter or the send button. Uncontrolled composers clear afterwards. */
  onSubmit: (value: string) => void;
  triggers?: ComposerTrigger[];
  placeholder?: string;
  disabled?: boolean;
  /** Shows a spinner on the send button and blocks submitting. */
  busy?: boolean;
  /** Accessible name of the textarea. */
  label?: string;
  submitLabel?: string;
  /** Hint row under the input (chips, help text). */
  footer?: ReactNode;
  maxRows?: number;
  className?: string;
}

const LINE_PX = 20;

/**
 * Chat-style composer: Enter submits, Shift+Enter adds a line, trigger characters open a suggestion list
 * navigated with the arrow keys. Keys pressed while an IME is composing are left to the IME.
 */
export function CommandComposer({ value, defaultValue = '', onValueChange, onSubmit, triggers = [], placeholder, disabled = false,
  busy = false, label = 'Command', submitLabel = 'Send', footer, maxRows = 8, className }: CommandComposerProps) {
  const [internal, setInternal] = useState(defaultValue);
  const text = value ?? internal;
  const [token, setToken] = useState<ActiveToken | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const listId = useId();
  const listVariants = useSafeVariants(variants.popover);

  const suggestions = token && dismissedAt !== token.start ? token.trigger.getSuggestions(token.query) : [];
  const open = suggestions.length > 0 && !disabled;
  const activeIndex = Math.min(highlight, Math.max(0, suggestions.length - 1));

  const setText = useCallback((next: string) => {
    if (value === undefined) setInternal(next);
    onValueChange?.(next);
  }, [onValueChange, value]);

  const refreshToken = (nextText: string, caret: number) => {
    const next = findActiveToken(nextText, caret, triggers);
    setToken(next);
    if (!next || next.start !== token?.start || next.query !== token?.query) setHighlight(0);
    if (!next || next.start !== dismissedAt) setDismissedAt(null);
  };

  // Grow with the content up to maxRows, and apply a caret move requested by a suggestion insert.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, LINE_PX * maxRows + 8)}px`;
    if (pendingCaret.current !== null) {
      area.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text, maxRows]);

  const accept = (suggestion: ComposerSuggestion) => {
    if (!token) return;
    const before = text.slice(0, token.start);
    const after = text.slice(token.end).replace(/^\s*/, '');
    const inserted = `${suggestion.insertText} `;
    const next = before + inserted + after;
    pendingCaret.current = before.length + inserted.length;
    setText(next);
    setToken(null);
    areaRef.current?.focus();
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || busy) return;
    onSubmit(trimmed);
    if (value === undefined) setInternal('');
    setToken(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || isComposingEvent(event)) return;
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight((activeIndex + delta + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.shiftKey && event.key === 'Enter') return;
        event.preventDefault();
        const choice = suggestions[activeIndex];
        if (choice) accept(choice);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(token?.start ?? null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    if (!composing.current) refreshToken(event.target.value, event.target.selectionStart ?? event.target.value.length);
  };

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <div className={cx('relative rounded-2xl bg-raised px-3.5 pb-2 pt-2.5 shadow-composer transition-shadow focus-within:shadow-[var(--tcg-shadow-composer),0_0_0_3px_var(--color-accent-ring)]',
      disabled && 'opacity-60', className)}>
      <AnimatePresence>
        {open && (
          <motion.div key="suggestions" variants={listVariants} initial="hidden" animate="shown" exit="exit"
            className="absolute inset-x-2 bottom-[calc(100%+6px)] z-20 overflow-hidden rounded-lg bg-overlay p-1 shadow-pop">
            {token?.trigger.label && <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold text-fg-subtle">{token.trigger.label}</div>}
            <ul id={listId} role="listbox" aria-label={token?.trigger.label ?? 'Suggestions'} className="max-h-60 overflow-y-auto">
              {suggestions.map((suggestion, index) => (
                <li key={suggestion.id} id={optionId(index)} role="option" aria-selected={index === activeIndex}
                  onPointerDown={event => event.preventDefault()} onClick={() => accept(suggestion)}
                  onPointerMove={() => { if (index !== activeIndex) setHighlight(index); }}
                  className={cx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]', index === activeIndex ? 'bg-accent-soft text-fg' : 'text-fg-muted')}>
                  {suggestion.icon && <span aria-hidden className="grid text-fg-subtle [&_svg]:size-4">{suggestion.icon}</span>}
                  <span className="font-mono text-xs font-medium text-fg">{suggestion.label}</span>
                  {suggestion.description && <span className="min-w-0 truncate text-xs text-fg-subtle">{suggestion.description}</span>}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-end gap-2">
        <textarea ref={areaRef} value={text} rows={1} placeholder={placeholder} disabled={disabled} aria-label={label}
          aria-autocomplete={triggers.length > 0 ? 'list' : undefined} aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          onChange={onChange} onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={event => {
            composing.current = false;
            const area = event.currentTarget;
            refreshToken(area.value, area.selectionStart ?? area.value.length);
          }}
          onSelect={event => {
            if (composing.current) return;
            const area = event.currentTarget;
            if (area.selectionStart === area.selectionEnd) refreshToken(area.value, area.selectionStart ?? 0);
          }}
          onBlur={() => setToken(null)}
          className="max-h-[168px] min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-sm leading-5 text-fg outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed" />
        <IconButton aria-label={submitLabel} variant="primary" size="sm" loading={busy} onClick={submit}
          disabled={disabled || text.trim().length === 0} icon={<ArrowUp aria-hidden />} className="rounded-full" />
      </div>
      {footer && <div className="mt-2 flex flex-wrap items-center gap-1 text-2xs text-fg-subtle">{footer}</div>}
    </div>
  );
}
