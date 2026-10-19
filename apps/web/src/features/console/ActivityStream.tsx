import type { ActorDto, AuditEntryDto, EventSnapshotDto } from '@tcg-live/core';
import {
  Activity, ArrowDown, Check, Clock, Flag, Gavel, Info, Lock, LockOpen, Megaphone, Pause, Pencil, Play,
  ShieldCheck, ThumbsUp, Timer, TriangleAlert, Trophy, UserCheck, UserMinus, UserPlus, UserX
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { formatAuditEntry, formatTimeOfDay, useAudit, type AuditIconKey, type AuditTone, type FormattedAuditEntry } from '../../data';
import { Avatar, Badge, Button, ScrollFade, StatusDot, Tooltip, cx, mergeRefs, springs, useSafeTransition, useScrollPin } from '../../ui';

const ICONS: Record<AuditIconKey, ReactNode> = {
  'user-plus': <UserPlus />, 'user-minus': <UserMinus />, 'user-x': <UserX />, lock: <Lock />, unlock: <LockOpen />,
  'check-in': <UserCheck />, megaphone: <Megaphone />, ready: <ThumbsUp />, pause: <Pause />, gavel: <Gavel />,
  play: <Play />, timer: <Timer />, flag: <Flag />, check: <Check />, alert: <TriangleAlert />, trophy: <Trophy />,
  pencil: <Pencil />, clock: <Clock />, activity: <Activity />
};

const VIA: Record<AuditEntryDto['via'], string> = { discord: 'Discord', web: 'console', system: 'timer', cli: 'CLI' };

/** Entries by the same actor within five minutes form one group. */
const GROUP_WINDOW_MS = 5 * 60_000;

export interface ActivityLine { entry: AuditEntryDto; formatted: FormattedAuditEntry; text: string }
export interface ActivityGroup { key: string; actor: ActorDto; first: AuditEntryDto; formatted: FormattedAuditEntry; lines: ActivityLine[] }

function actorKey(actor: ActorDto): string {
  switch (actor.kind) {
    case 'player': return `player:${actor.seat}`;
    case 'member': return `member:${actor.memberId}`;
    case 'admin': return 'admin';
    case 'system': return 'system';
  }
}

/** The sentence without its leading actor label (the group header names the actor). */
export function lineText(formatted: FormattedAuditEntry): string {
  const prefix = `${formatted.actorLabel} `;
  if (!formatted.text.startsWith(prefix)) return formatted.text;
  const rest = formatted.text.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Groups consecutive entries by actor (ascending input, ascending groups). */
export function groupActivity(entries: AuditEntryDto[], names: EventSnapshotDto | undefined): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const entry of entries) {
    const formatted = formatAuditEntry(entry, names);
    const line = { entry, formatted, text: lineText(formatted) };
    const last = groups[groups.length - 1];
    const lastEntry = last?.lines[last.lines.length - 1]?.entry;
    if (last && lastEntry && actorKey(last.actor) === actorKey(entry.actor) && entry.occurredAtMs - lastEntry.occurredAtMs <= GROUP_WINDOW_MS) {
      last.lines.push(line);
    } else {
      groups.push({ key: `g${entry.sequence}`, actor: entry.actor, first: entry, formatted, lines: [line] });
    }
  }
  return groups;
}

const TONE_CLASS: Record<AuditTone, string> = {
  neutral: 'text-fg-subtle', info: 'text-fg-muted', success: 'text-success', warning: 'text-warning', danger: 'text-danger', accent: 'text-accent'
};

/** The audit log, chat-style: newest at the bottom, pinned while at the bottom, older pages on demand. */
export function ActivityStream({ eventId, snapshot }: { eventId: string; snapshot: EventSnapshotDto | undefined }) {
  const audit = useAudit(eventId);
  const groups = useMemo(() => groupActivity(audit.entries, snapshot), [audit.entries, snapshot]);
  const lastSequence = audit.entries[audit.entries.length - 1]?.sequence ?? 0;
  const firstSequence = audit.entries[0]?.sequence ?? 0;
  const pin = useScrollPin<HTMLDivElement>({ contentKey: lastSequence });
  const node = useRef<HTMLDivElement | null>(null);
  const setRef = useMemo(() => mergeRefs(pin.scrollRef, (el: HTMLDivElement | null) => { node.current = el; }), [pin.scrollRef]);
  const restore = useRef<number | null>(null);
  const transition = useSafeTransition(springs.listItem);

  // Layout changes (dock opening, window resizing) reflow the feed; a pinned view stays at the bottom.
  const feed = useRef<HTMLOListElement | null>(null);
  const pinnedRef = useRef(pin.pinned);
  pinnedRef.current = pin.pinned;
  const { jumpToLatest } = pin;
  useEffect(() => {
    const el = node.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (pinnedRef.current) jumpToLatest('auto'); });
    });
    observer.observe(el);
    if (feed.current) observer.observe(feed.current);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [jumpToLatest]);

  // Keep the view still when older entries are prepended above it.
  useLayoutEffect(() => {
    const el = node.current;
    if (!el || restore.current === null) return;
    el.scrollTop += el.scrollHeight - restore.current;
    restore.current = null;
  }, [firstSequence]);

  const loadOlder = () => {
    if (node.current) restore.current = node.current.scrollHeight;
    void audit.fetchOlder();
  };

  return (
    <section aria-labelledby="activity-title" className="console-activity">
      <header className="console-activity-head">
        <h2 id="activity-title" className="console-section-title">
          Activity
          {audit.live
            ? <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-accent-text"><StatusDot tone="accent" live size="sm" />live</span>
            : <span className="text-2xs font-medium text-fg-subtle">history</span>}
        </h2>
        <Tooltip content="Rejected and no-op attempts are not stored, so they never appear here." placement="bottom-end">
          <span tabIndex={0} className="console-hint"><Info aria-hidden className="size-3.5" />Applied changes only</span>
        </Tooltip>
      </header>

      <div className="relative min-h-0 flex-1">
        <ScrollFade ref={setRef} fade={20} className="console-activity-scroll" role="log" aria-label="Activity" aria-live="polite"
          aria-relevant="additions" data-testid="activity-log">
          {audit.hasOlder && (
            <div className="flex justify-center pb-2">
              <Button size="sm" variant="ghost" loading={audit.isFetchingOlder} onClick={loadOlder}>Load older activity</Button>
            </div>
          )}
          {!audit.hasOlder && groups.length > 0 && <p className="console-feed-edge">Start of this event's activity</p>}
          {audit.pageError && <p role="alert" className="pb-2 text-center text-xs text-danger">{audit.pageError.message}</p>}
          {audit.isLoading && (
            <div aria-busy="true" aria-label="Loading activity" className="flex flex-col gap-3 py-2">
              <span className="shell-skeleton h-10" /><span className="shell-skeleton h-10 opacity-70" /><span className="shell-skeleton h-10 opacity-40" />
            </div>
          )}
          {audit.error && !audit.isLoading && <p role="alert" className="py-6 text-center text-xs text-danger">Activity could not be loaded: {audit.error.message}</p>}
          {!audit.isLoading && !audit.error && groups.length === 0 && (
            <p className="py-8 text-center text-xs text-fg-subtle">No activity yet. Applied changes appear here as they happen.</p>
          )}
          <ol ref={feed} className="console-feed">
            <AnimatePresence initial={false}>
              {groups.map(group => (
                <motion.li key={group.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={transition}>
                  <ActivityGroupView group={group} snapshot={snapshot} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
          {audit.hasMore && (
            <div className="flex justify-center pt-2">
              <Button size="sm" variant="ghost" loading={audit.isFetchingMore} onClick={() => { void audit.fetchMore(); }}>Load more</Button>
            </div>
          )}
        </ScrollFade>
        <AnimatePresence>
          {!pin.pinned && groups.length > 0 && (
            <motion.div className="console-jump" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={transition}>
              <Button size="sm" variant="secondary" icon={<ArrowDown aria-hidden />} onClick={() => pin.jumpToLatest()}
                className={cx(pin.hasUnseen && 'console-jump-unseen')}>
                {pin.hasUnseen ? 'New activity · Jump to latest' : 'Jump to latest'}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function GroupAvatar({ group, snapshot }: { group: ActivityGroup; snapshot: EventSnapshotDto | undefined }) {
  const { actor, formatted } = group;
  if (actor.kind === 'admin') return <span aria-hidden className="console-avatar is-admin"><ShieldCheck /></span>;
  if (actor.kind === 'system') return <span aria-hidden className="console-avatar is-system"><Timer /></span>;
  const member = formatted.actorMemberId ? snapshot?.members[formatted.actorMemberId] : undefined;
  return <Avatar src={member?.avatarUrl ?? null} name={formatted.actorName ?? formatted.actorLabel} size="md" decorative />;
}

function ActivityGroupView({ group, snapshot }: { group: ActivityGroup; snapshot: EventSnapshotDto | undefined }) {
  const { actor, formatted, first } = group;
  const name = actor.kind === 'player' ? (formatted.actorName ?? formatted.actorLabel) : formatted.actorLabel;
  const role = actor.kind === 'player' ? `Seat ${actor.seat}` : actor.kind === 'member' ? 'member' : actor.kind === 'admin' ? 'admin' : 'system';
  return (
    <article className="console-group" aria-label={`${name}, ${formatTimeOfDay(first.occurredAtMs)}`}>
      <GroupAvatar group={group} snapshot={snapshot} />
      <div className="min-w-0 flex-1">
        <div className="console-group-meta">
          <span className="truncate font-semibold text-fg">{name}</span>
          <Badge mono={actor.kind === 'player'}>{role}</Badge>
          <span className="text-2xs text-fg-subtle">via {VIA[first.via]}</span>
          <time className="ml-auto shrink-0 text-2xs tabular-nums text-fg-subtle" dateTime={new Date(first.occurredAtMs).toISOString()}>
            {formatTimeOfDay(first.occurredAtMs)}
          </time>
        </div>
        <ul className="console-lines">
          {group.lines.map(line => (
            <li key={line.entry.sequence} className={cx('console-line', line.formatted.tone === 'danger' && 'is-danger', actor.kind === 'admin' && 'is-admin')}
              data-sequence={line.entry.sequence} title={`${formatTimeOfDay(line.entry.occurredAtMs)} · #${line.entry.sequence}`}>
              <span aria-hidden className={cx('console-line-icon', TONE_CLASS[line.formatted.tone])}>{ICONS[line.formatted.icon]}</span>
              <span className="min-w-0">{line.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

