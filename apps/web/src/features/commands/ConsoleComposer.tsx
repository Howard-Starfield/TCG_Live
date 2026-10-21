// Command composer (L10, Experience item 4): `/tcg-test` slash commands with suggestions and
// mentions, executed through the same command API as the buttons. It follows the kit composer's look
// and IME guard, but is a combobox whose suggestions come from the whole line (the command, the match
// already named), which the kit's single-character triggers cannot express. It is a single-line
// input because ARIA allows the combobox role there (not on a textarea), and slash commands are one line.
import type { EventSnapshotDto } from '@tcg-live/core';
import { ArrowUp, CircleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { IconButton, Kbd, cx, isComposingEvent, useSafeVariants, variants } from '../../ui';
import { useCommands, type CommandsApi } from './CommandsProvider';
import { currentArg, parseCommand, suggest, usage, type ComposerIntent, type Suggestion } from './grammar';
import { canRunAny, isWritable } from './model';

export interface ConsoleComposerProps {
  snapshot: EventSnapshotDto;
  /** Viewing history: no composer. */
  readOnly?: boolean;
}

/** Mounted below the activity stream; renders nothing unless the session can act on this event. */
export function ConsoleComposer({ snapshot, readOnly = false }: ConsoleComposerProps) {
  const commands = useCommands();
  if (!commands || readOnly || !isWritable(snapshot) || !canRunAny(commands.session)) return null;
  return <Composer commands={commands} snapshot={snapshot} />;
}

function Composer({ commands, snapshot }: { commands: CommandsApi; snapshot: EventSnapshotDto }) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const listId = useId();
  const hintId = useId();
  const listVariants = useSafeVariants(variants.popover);
  const context = useMemo(() => ({ snapshot, session: commands.session }), [snapshot, commands.session]);

  const list = useMemo(() => (focused ? suggest(text, caret, context) : null), [focused, text, caret, context]);
  // Escape hides the list for the word it was open on; typing on reopens it.
  const listKey = list ? `${list.start}:${text.slice(list.start, list.end)}` : null;
  const open = !!list && listKey !== dismissed && !busy;
  const items = open ? list!.items : [];
  const active = Math.min(highlight, Math.max(0, items.length - 1));

  // Puts the caret after an accepted suggestion once the new text is in the input.
  useLayoutEffect(() => {
    const area = inputRef.current;
    if (!area) return;
    if (pendingCaret.current !== null) {
      area.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  const update = (next: string, nextCaret: number) => {
    setText(next);
    setCaret(nextCaret);
    setHighlight(0);
    setError(null);
  };

  const acceptSuggestion = (item: Suggestion) => {
    if (!list) return;
    const before = text.slice(0, list.start);
    const after = text.slice(list.end).replace(/^\s*/, '');
    const inserted = `${item.insertText} `;
    pendingCaret.current = before.length + inserted.length;
    update(before + inserted + after, before.length + inserted.length);
    inputRef.current?.focus();
  };

  const clear = () => update('', 0);

  const execute = async (intent: ComposerIntent) => {
    const { eventId } = snapshot;
    switch (intent.kind) {
      case 'remove':
        commands.confirmRemove({ eventId, memberId: intent.memberId, onDone: clear });
        return;
      case 'match': {
        const ready = intent.reason !== null && (intent.action === 'judgeResume' || intent.winner !== null);
        // Corrections always confirm in the dialog; incomplete commands finish there.
        if (intent.action === 'correct' || !ready) {
          commands.openMatchAction({ eventId, matchId: intent.matchId, action: intent.action, winner: intent.winner, reason: intent.reason, onDone: clear });
          return;
        }
        const command = intent.action === 'judgeResume'
          ? { type: 'judgeResume' as const, matchId: intent.matchId, reason: intent.reason! }
          : { type: intent.action, matchId: intent.matchId, winner: intent.winner!, reason: intent.reason! };
        return finish(await commands.run(snapshot, command, { inline: true }));
      }
      case 'refresh':
        return finish(await commands.refreshPanels(snapshot, { inline: true }));
      case 'event':
        return finish(await commands.run(snapshot, { type: intent.type }, { inline: true }));
    }
  };

  const finish = (outcome: Awaited<ReturnType<CommandsApi['run']>>) => {
    if (outcome.status === 'applied' || outcome.status === 'noop' || outcome.status === 'refreshed') clear();
    else if (outcome.status === 'conflict' || outcome.status === 'failed') setError(outcome.message);
  };

  const submit = async () => {
    if (busy) return;
    const parsed = parseCommand(text, context);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'error') {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    try {
      await execute(parsed.intent);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || isComposingEvent(event)) return;
    if (open && items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        acceptSuggestion(items[active]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(listKey);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const area = event.target;
    setText(area.value);
    setError(null);
    if (!composing.current) {
      setCaret(area.selectionStart ?? area.value.length);
      setHighlight(0);
    }
  };

  const syncCaret = () => {
    const area = inputRef.current;
    if (area && !composing.current && area.selectionStart === area.selectionEnd) setCaret(area.selectionStart ?? 0);
  };

  const optionId = (index: number) => `${listId}-option-${index}`;
  const position = currentArg(text, caret);

  return (
    <section aria-label="Command composer" className="shrink-0 px-[18px] pb-4 pt-1" data-testid="command-composer">
      <div className={cx('relative rounded-2xl bg-raised px-3.5 pb-2 pt-2.5 shadow-composer transition-shadow',
        'focus-within:shadow-[var(--tcg-shadow-composer),0_0_0_3px_var(--color-accent-ring)]', error && 'shadow-[var(--tcg-shadow-composer),0_0_0_1px_var(--color-danger)]')}>
        <AnimatePresence>
          {open && items.length > 0 && (
            <motion.div key="suggestions" variants={listVariants} initial="hidden" animate="shown" exit="exit"
              className="absolute inset-x-2 bottom-[calc(100%+6px)] z-20 overflow-hidden rounded-lg bg-overlay p-1 shadow-pop">
              <div aria-hidden className="px-2 pb-1 pt-1.5 text-2xs font-semibold text-fg-subtle">{list!.heading}</div>
              <ul id={listId} role="listbox" aria-label={list!.heading} className="max-h-60 overflow-y-auto">
                {items.map((item, index) => (
                  <li key={item.id} id={optionId(index)} role="option" aria-selected={index === active}
                    onPointerDown={event => event.preventDefault()} onClick={() => acceptSuggestion(item)}
                    onPointerMove={() => { if (index !== active) setHighlight(index); }}
                    className={cx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]', index === active ? 'bg-accent-soft text-fg' : 'text-fg-muted')}>
                    <span className="font-mono text-xs font-medium text-fg">{item.label}</span>
                    {item.description && <span className="min-w-0 truncate text-xs text-fg-subtle">{item.description}</span>}
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex items-center gap-2">
          <input ref={inputRef} type="text" value={text} role="combobox" aria-label="Admin command"
            aria-expanded={open && items.length > 0} aria-controls={open && items.length > 0 ? listId : undefined} aria-autocomplete="list"
            aria-activedescendant={open && items.length > 0 ? optionId(active) : undefined} aria-describedby={hintId}
            aria-invalid={error ? true : undefined} spellCheck={false} autoComplete="off" readOnly={busy} aria-busy={busy || undefined}
            placeholder="Type / for commands, @ to mention a seat or member"
            onChange={onChange} onKeyDown={onKeyDown} onSelect={syncCaret} onClick={syncCaret}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; syncCaret(); }}
            className="h-6 min-w-0 flex-1 bg-transparent py-0.5 font-mono text-[13px] leading-5 text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle read-only:cursor-progress" />
          <IconButton aria-label="Run command" variant="primary" size="sm" loading={busy} onClick={() => { void submit(); }}
            disabled={text.trim().length === 0} icon={<ArrowUp aria-hidden />} className="rounded-full" />
        </div>
        <div id={hintId} className="mt-1.5 flex min-h-4 flex-wrap items-center gap-1 text-2xs text-fg-subtle">
          {error ? (
            <span role="alert" className="inline-flex items-start gap-1 font-medium text-danger [&>svg]:mt-px [&>svg]:size-3 [&>svg]:shrink-0">
              <CircleAlert aria-hidden />{error}
            </span>
          ) : position ? (
            <UsageHint spec={position.spec} arg={position.arg} />
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1">
              <Kbd keys="/" /> commands · <Kbd keys="@" /> seats and members · <Kbd keys="Enter" /> runs · the reason goes last
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function UsageHint({ spec, arg }: NonNullable<ReturnType<typeof currentArg>>) {
  const parts = usage(spec).split(' ');
  return (
    <span className="font-mono">
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 && ' '}
          <span className={cx(part === `<${arg}>` && 'font-semibold text-accent-text')}>{part}</span>
        </span>
      ))}
      <span className="font-sans"> · {spec.description}</span>
    </span>
  );
}
