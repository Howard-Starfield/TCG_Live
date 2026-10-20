// Matches tab: phase, live clock, judge attention, proposal and final result per match.
// Wide panes get separate Judge, Result and Proposal columns. Below MATCH_WIDE_FROM the table keeps
// Match, Players, Phase and Clock, and the Phase cell stacks those details under the chip; below
// MATCH_STACK_PLAYERS_BELOW the two players stack as well, and below MATCH_STACK_CLOCK_BELOW the clock
// moves under the match ID so all four stay visible in a 360 px pane.
import type { EventSnapshotDto, MatchDto, MatchId, Seat } from '@tcg-live/core';
import { ChevronRight, Swords } from 'lucide-react';
import { useMemo } from 'react';
import { formatTimeOfDay, memberName, useMatchCountdown } from '../../data';
import { DataTable, EmptyState, StatusDot, cx, type Column } from '../../ui';
import { JUDGE_REASON_LABEL, PHASE_META, matchPhaseMeta } from './model';
import { None, ScrollCue, SeatTag, StatusChip, ToneBadge, useElementWidth } from './shared';

/** Container width (px) from which Judge, Result and Proposal get their own columns. */
export const MATCH_WIDE_FROM = 860;
/** Below this container width the two players of a match stack vertically. */
export const MATCH_STACK_PLAYERS_BELOW = 560;
/** Below this container width the clock sits under the match ID and the result line names only the seat. */
export const MATCH_STACK_CLOCK_BELOW = 420;

function SeatName({ snapshot, seat, compact = false }: { snapshot: EventSnapshotDto; seat: Seat; compact?: boolean }) {
  const memberId = snapshot.seats[seat];
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <SeatTag seat={seat} />
      <span className={cx('min-w-0 truncate text-fg', compact ? 'max-w-[6.5rem]' : 'max-w-[7rem]')}>
        {memberId ? memberName(snapshot, memberId) : 'Open seat'}
      </span>
    </span>
  );
}

/** Live countdown; an interrupted clock is frozen and labelled, never shown as running. */
export function MatchClock({ match }: { match: MatchDto }) {
  const countdown = useMatchCountdown(match.clock);
  const interrupted = match.clock.state === 'interrupted';
  return (
    <span className="inline-flex items-center gap-1.5" data-clock-state={match.clock.state}>
      {countdown.running && <StatusDot tone="accent" live size="sm" />}
      <span className={cx('font-mono text-xs font-semibold tabular-nums',
        countdown.running ? 'text-accent-text' : interrupted ? 'text-warning' : 'text-fg-muted')}
        aria-label={`${countdown.label} ${countdown.running ? 'remaining' : interrupted ? 'remaining, clock interrupted' : 'remaining, stopped'}`}>
        {countdown.label}
      </span>
      {interrupted && <ToneBadge tone="warning" title="Another process owns this running clock; shown frozen">interrupted</ToneBadge>}
    </span>
  );
}

function JudgeCell({ match }: { match: MatchDto }) {
  if (!match.judge) return <None label="No judge needed" />;
  const { reasons, raisedBy, sinceMs } = match.judge;
  return (
    <span className="inline-flex items-center gap-1">
      {reasons.map(reason => <ToneBadge key={reason} tone="danger">{JUDGE_REASON_LABEL[reason]}</ToneBadge>)}
      <span className="text-fg-subtle">
        {raisedBy.length > 0 && <>by {raisedBy.join(', ')} · </>}since {formatTimeOfDay(sinceMs)}
      </span>
    </span>
  );
}

function ProposalCell({ match }: { match: MatchDto }) {
  const proposal = match.proposal;
  if (!proposal) return <None label="No proposal" />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <ToneBadge mono title="Proposal revision">rev {proposal.revision}</ToneBadge>
      <span className="text-fg">{proposal.winner} won</span>
      <span className="text-fg-subtle">by {proposal.reporter}</span>
      <ToneBadge tone={proposal.decision === 'disputed' ? 'danger' : 'neutral'}>{proposal.decision}</ToneBadge>
    </span>
  );
}

function SourceBadge({ match }: { match: MatchDto }) {
  if (!match.finalSource) return null;
  const title = match.finalSource === 'admin' ? 'Decided by the admin'
    : `Agreed by both players${match.confirmedBy ? `, confirmed by ${match.confirmedBy}` : ''}`;
  return <ToneBadge tone={match.finalSource === 'admin' ? 'warning' : 'success'} title={title}>{match.finalSource}</ToneBadge>;
}

function ResultCell({ snapshot, match }: { snapshot: EventSnapshotDto; match: MatchDto }) {
  if (!match.finalWinner) return <None label="No result yet" />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <SeatName snapshot={snapshot} seat={match.finalWinner} />
      <SourceBadge match={match} />
      {match.confirmedBy && <span className="text-fg-subtle">confirmed by {match.confirmedBy}</span>}
    </span>
  );
}

/** Phase chip with the match's details stacked beneath it: judge attention, then result or open proposal. */
function PhaseDetails({ snapshot, match, tight = false }: { snapshot: EventSnapshotDto; match: MatchDto; tight?: boolean }) {
  const { judge, proposal } = match;
  return (
    <span className="flex flex-col items-start gap-1 py-0.5">
      <StatusChip meta={matchPhaseMeta(match)} />
      {judge && (
        <span className="inline-flex items-center gap-1">
          {judge.reasons.map(reason => <ToneBadge key={reason} tone="danger">{JUDGE_REASON_LABEL[reason]}</ToneBadge>)}
          {judge.raisedBy.length > 0 && <span className="text-fg-subtle">by {judge.raisedBy.join(', ')}</span>}
        </span>
      )}
      {match.finalWinner ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-fg-subtle">Won by</span>
          {tight ? <SeatTag seat={match.finalWinner} /> : <SeatName snapshot={snapshot} seat={match.finalWinner} compact />}
          <SourceBadge match={match} />
        </span>
      ) : proposal && (
        <span className="inline-flex items-center gap-1">
          <span className="text-fg">{proposal.winner} won</span>
          <span className="text-fg-subtle">by {proposal.reporter} · rev {proposal.revision}</span>
          <ToneBadge tone={proposal.decision === 'disputed' ? 'danger' : 'neutral'}>{proposal.decision}</ToneBadge>
        </span>
      )}
    </span>
  );
}

export interface MatchesTabProps {
  snapshot: EventSnapshotDto;
  onOpenMatch?: (matchId: MatchId) => void;
}

export function MatchesTab({ snapshot, onOpenMatch }: MatchesTabProps) {
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const wide = width === null || width >= MATCH_WIDE_FROM;
  const stackPlayers = width !== null && width < MATCH_STACK_PLAYERS_BELOW;
  const tight = width !== null && width < MATCH_STACK_CLOCK_BELOW;

  const columns = useMemo<Array<Column<MatchDto>>>(() => {
    const list: Array<Column<MatchDto>> = [
      { id: 'id', header: tight ? 'Match · clock' : 'Match', width: tight ? undefined : '52px', sortValue: match => match.id,
        cell: match => (tight ? (
          <span className="flex flex-col items-start gap-1 py-0.5">
            <ToneBadge mono>{match.id}</ToneBadge>
            <MatchClock match={match} />
          </span>
        ) : <ToneBadge mono>{match.id}</ToneBadge>) },
      { id: 'seats', header: 'Players',
        cell: match => (stackPlayers ? (
          <span className="flex flex-col items-start gap-1 py-0.5">
            <SeatName snapshot={snapshot} seat={match.seats[0]} compact />
            <SeatName snapshot={snapshot} seat={match.seats[1]} compact />
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <SeatName snapshot={snapshot} seat={match.seats[0]} />
            <span className="text-fg-subtle">vs</span>
            <SeatName snapshot={snapshot} seat={match.seats[1]} />
          </span>
        )) },
      { id: 'phase', header: 'Phase', sortValue: match => PHASE_META[match.phase].order,
        cell: match => (wide ? <StatusChip meta={matchPhaseMeta(match)} /> : <PhaseDetails snapshot={snapshot} match={match} tight={tight} />) }
    ];
    if (!tight) {
      list.push({ id: 'clock', header: 'Clock', sortValue: match => match.clock.remainingMs,
        cell: match => <MatchClock match={match} /> });
    }
    if (wide) {
      // Each detail column appears only when some match has data for it.
      if (snapshot.matches.some(match => match.judge)) {
        list.push({ id: 'judge', header: 'Judge', sortValue: match => (match.judge ? match.judge.sinceMs : null),
          cell: match => <JudgeCell match={match} /> });
      }
      if (snapshot.matches.some(match => match.finalWinner)) {
        list.push({ id: 'result', header: 'Result', sortValue: match => match.finalWinner,
          cell: match => <ResultCell snapshot={snapshot} match={match} /> });
      }
      if (snapshot.matches.some(match => match.proposal)) {
        list.push({ id: 'proposal', header: 'Proposal', sortValue: match => match.proposal?.revision ?? null,
          cell: match => <ProposalCell match={match} /> });
      }
    }
    if (onOpenMatch && !tight) {
      list.push({ id: 'open', header: <span className="sr-only">Open</span>, width: '28px', align: 'end',
        cell: () => <ChevronRight aria-hidden className="inline size-3.5 text-fg-subtle group-hover/row:text-fg" /> });
    }
    return list;
  }, [onOpenMatch, snapshot, stackPlayers, tight, wide]);

  const judges = snapshot.matches.filter(match => match.judge).length;
  return (
    <div ref={measure} className="flex min-h-0 flex-1 flex-col gap-2" data-width={width ?? undefined}>
      <p className="truncate px-0.5 text-xs text-fg-muted">
        {snapshot.matches.length} {snapshot.matches.length === 1 ? 'match' : 'matches'}
        {judges > 0 && <> · <span className="font-medium text-danger">{judges} {judges === 1 ? 'needs' : 'need'} a judge</span></>}
        {onOpenMatch && snapshot.matches.length > 0 && ' · select a row to open it in the live preview'}
      </p>
      <ScrollCue>
        <DataTable<MatchDto> dense className="lists-table flex-1" columns={columns} rows={snapshot.matches} getRowId={match => match.id}
          label={onOpenMatch ? 'Matches. Press Enter on a row to open it in the live preview.' : 'Matches'}
          onRowActivate={onOpenMatch ? match => onOpenMatch(match.id) : undefined}
          empty={<EmptyState compact icon={<Swords />} title="No matches yet" description="Matches appear when seats are assigned." />} />
      </ScrollCue>
    </div>
  );
}
