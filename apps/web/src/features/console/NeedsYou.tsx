import type { EventSnapshotDto, JudgeReason, MatchDto, MatchId } from '@tcg-live/core';
import { CircleCheck, Workflow } from 'lucide-react';
import { formatElapsed, formatTimeOfDay, useServerNow } from '../../data';
import { Button, CountBadge, DecisionCard, type DecisionReason } from '../../ui';
import { seatName } from '../shell/labels';

const REASON: Record<JudgeReason, DecisionReason> = {
  dispute: { label: 'Dispute', tone: 'danger' },
  called: { label: 'Judge called', tone: 'danger' },
  expired: { label: 'Clock expired', tone: 'warning' }
};

/** Matches with judge attention, in match order. */
export function judgeMatches(snapshot: EventSnapshotDto): Array<MatchDto & { judge: NonNullable<MatchDto['judge']> }> {
  return snapshot.matches.filter((match): match is MatchDto & { judge: NonNullable<MatchDto['judge']> } => match.judge !== null);
}

/** The needs-you queue: one decision card per match waiting on a judge. */
export function NeedsYou({ snapshot, onOpenMatch, readOnly }: { snapshot: EventSnapshotDto; onOpenMatch(matchId: MatchId): void; readOnly: boolean }) {
  const matches = judgeMatches(snapshot);
  const now = useServerNow(matches.length > 0 ? 1000 : null);

  return (
    <section aria-labelledby="needs-you-title" className="flex flex-col gap-2">
      <h2 id="needs-you-title" className="console-section-title">
        Needs you
        {matches.length > 0 && <CountBadge count={matches.length} label={`${matches.length} waiting`} />}
      </h2>
      {matches.length === 0 ? (
        <div className="console-empty" data-testid="needs-you-empty">
          <CircleCheck aria-hidden className="size-4 text-success" />
          <span>
            <b className="font-medium text-fg">Nothing needs you.</b>{' '}
            {readOnly ? 'This event is closed.' : 'Disputes, judge calls and expired clocks show up here.'}
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {matches.map(match => (
            <li key={match.id} data-match={match.id}>
              <JudgeCard snapshot={snapshot} match={match} now={now} onOpen={() => onOpenMatch(match.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JudgeCard({ snapshot, match, now, onOpen }: {
  snapshot: EventSnapshotDto; match: MatchDto & { judge: NonNullable<MatchDto['judge']> }; now: number; onOpen(): void;
}) {
  const [first, second] = match.seats;
  const { judge, proposal } = match;
  const name = (seat: typeof first) => <b>{seatName(snapshot, seat)}</b>;
  const raisers = judge.raisedBy.map(seat => `${seatName(snapshot, seat)} (Seat ${seat})`).join(' and ');
  const waiting = formatElapsed(judge.sinceMs, now);

  return (
    <DecisionCard tone="danger"
      title={`${match.id} needs a judge`}
      reasons={judge.reasons.map(reason => REASON[reason])}
      meta={<span title={`Since ${formatTimeOfDay(judge.sinceMs)}`}>waiting {waiting}</span>}
      actions={<Button size="sm" variant="secondary" icon={<Workflow aria-hidden />} onClick={onOpen}
        aria-label={`Open ${match.id} in live preview`}>Open in live preview</Button>}>
      <p>
        {name(first)} <span className="text-fg-subtle">(Seat {first})</span> vs {name(second)} <span className="text-fg-subtle">(Seat {second})</span>
        {' · '}{match.phase === 'expired' ? 'clock expired' : match.phase}
      </p>
      {proposal && (
        <p className="mt-0.5">
          {name(proposal.reporter)} reported that {proposal.winner === proposal.reporter ? 'they' : <b>{seatName(snapshot, proposal.winner)}</b>} won
          {proposal.decision === 'disputed' ? <>; the result is <b className="!text-danger">disputed</b>.</> : '; awaiting confirmation.'}
          <span className="ml-1 font-mono text-2xs text-fg-subtle">rev {proposal.revision}</span>
        </p>
      )}
      {raisers && <p className="mt-0.5 text-xs text-fg-subtle">Raised by {raisers} at {formatTimeOfDay(judge.sinceMs)}. Nothing is decided automatically.</p>}
    </DecisionCard>
  );
}
