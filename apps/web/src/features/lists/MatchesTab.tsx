// Matches tab: phase, live clock, judge attention, proposal and final result per match.
import type { EventSnapshotDto, MatchDto, MatchId, Seat } from '@tcg-live/core';
import { ChevronRight, Swords } from 'lucide-react';
import { useMemo } from 'react';
import { formatTimeOfDay, memberName, useMatchCountdown } from '../../data';
import { DataTable, EmptyState, StatusDot, cx, type Column } from '../../ui';
import { JUDGE_REASON_LABEL, PHASE_META, matchPhaseMeta } from './model';
import { None, SeatTag, StatusChip, ToneBadge } from './shared';

function SeatName({ snapshot, seat }: { snapshot: EventSnapshotDto; seat: Seat }) {
  const memberId = snapshot.seats[seat];
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <SeatTag seat={seat} />
      <span className="min-w-0 max-w-[7rem] truncate text-fg">{memberId ? memberName(snapshot, memberId) : 'Open seat'}</span>
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

function ResultCell({ snapshot, match }: { snapshot: EventSnapshotDto; match: MatchDto }) {
  if (!match.finalWinner) return <None label="No result yet" />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <SeatName snapshot={snapshot} seat={match.finalWinner} />
      {match.finalSource && (
        <ToneBadge tone={match.finalSource === 'admin' ? 'warning' : 'success'}
          title={match.finalSource === 'admin' ? 'Decided by the admin' : 'Agreed by both players'}>
          {match.finalSource}
        </ToneBadge>
      )}
      {match.confirmedBy && <span className="text-fg-subtle">confirmed by {match.confirmedBy}</span>}
    </span>
  );
}

export interface MatchesTabProps {
  snapshot: EventSnapshotDto;
  onOpenMatch?: (matchId: MatchId) => void;
}

/** Judge, Proposal and Result columns appear only when some match has data for them (narrow panes). */
export function MatchesTab({ snapshot, onOpenMatch }: MatchesTabProps) {
  const columns = useMemo<Array<Column<MatchDto>>>(() => {
    const list: Array<Column<MatchDto>> = [
      { id: 'id', header: 'Match', width: '56px', sortValue: match => match.id,
        cell: match => <ToneBadge mono>{match.id}</ToneBadge> },
      { id: 'seats', header: 'Players',
        cell: match => (
          <span className="inline-flex items-center gap-1.5">
            <SeatName snapshot={snapshot} seat={match.seats[0]} />
            <span className="text-fg-subtle">vs</span>
            <SeatName snapshot={snapshot} seat={match.seats[1]} />
          </span>
        ) },
      { id: 'phase', header: 'Phase', sortValue: match => PHASE_META[match.phase].order,
        cell: match => <StatusChip meta={matchPhaseMeta(match)} /> },
      { id: 'clock', header: 'Clock', sortValue: match => match.clock.remainingMs,
        cell: match => <MatchClock match={match} /> },
      ...(snapshot.matches.some(match => match.judge) ? [{ id: 'judge', header: 'Judge', sortValue: match => (match.judge ? match.judge.sinceMs : null),
        cell: match => <JudgeCell match={match} /> } satisfies Column<MatchDto>] : []),
      ...(snapshot.matches.some(match => match.finalWinner) ? [{ id: 'result', header: 'Result', sortValue: match => match.finalWinner,
        cell: match => <ResultCell snapshot={snapshot} match={match} /> } satisfies Column<MatchDto>] : []),
      ...(snapshot.matches.some(match => match.proposal) ? [{ id: 'proposal', header: 'Proposal', sortValue: match => match.proposal?.revision ?? null,
        cell: match => <ProposalCell match={match} /> } satisfies Column<MatchDto>] : [])
    ];
    if (onOpenMatch) {
      list.push({ id: 'open', header: <span className="sr-only">Open</span>, width: '28px', align: 'end',
        cell: () => <ChevronRight aria-hidden className="inline size-3.5 text-fg-subtle group-hover/row:text-fg" /> });
    }
    return list;
  }, [onOpenMatch, snapshot]);

  const judges = snapshot.matches.filter(match => match.judge).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="truncate px-0.5 text-xs text-fg-muted">
        {snapshot.matches.length} {snapshot.matches.length === 1 ? 'match' : 'matches'}
        {judges > 0 && <> · <span className="font-medium text-danger">{judges} {judges === 1 ? 'needs' : 'need'} a judge</span></>}
        {onOpenMatch && snapshot.matches.length > 0 && ' · select a row to open it in the live preview'}
      </p>
      <DataTable<MatchDto> dense className="lists-table flex-1" columns={columns} rows={snapshot.matches} getRowId={match => match.id}
        label={onOpenMatch ? 'Matches. Press Enter on a row to open it in the live preview.' : 'Matches'}
        onRowActivate={onOpenMatch ? match => onOpenMatch(match.id) : undefined}
        empty={<EmptyState compact icon={<Swords />} title="No matches yet" description="Matches appear when seats are assigned." />} />
    </div>
  );
}
