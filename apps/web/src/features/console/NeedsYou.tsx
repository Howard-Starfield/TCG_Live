import { JUDGE_REQUEST_CATEGORIES, type EventSnapshotDto, type JudgeReason, type MatchDto, type MatchId } from '@tcg-live/core';
import { CircleCheck, Workflow } from 'lucide-react';
import { formatElapsed, formatTimeOfDay, useServerNow } from '../../data';
import { Badge, Button, CountBadge, DecisionCard, type DecisionReason } from '../../ui';
import { MatchActions } from '../commands';
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
  // Only live, waiting cards tick; resumed matches and retired events show a fixed time.
  const ticking = !readOnly && matches.some(match => match.phase !== 'running');
  const now = useServerNow(ticking ? 1000 : null);

  return (
    <section aria-labelledby="needs-you-title" className="flex flex-col gap-2">
      <h2 id="needs-you-title" className="console-section-title">
        Needs you
        {matches.length > 0 && <CountBadge count={matches.length} tone={readOnly ? 'neutral' : 'danger'}
          label={readOnly ? `${matches.length} open when the event closed` : `${matches.length} waiting`} />}
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
              <JudgeCard snapshot={snapshot} match={match} now={now} readOnly={readOnly} onOpen={() => onOpenMatch(match.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type JudgeMatch = MatchDto & { judge: NonNullable<MatchDto['judge']> };

type JudgeRequest = NonNullable<JudgeMatch['judge']['requests']>[number];

function groupRequests(requests: JudgeRequest[]) {
  const grouped = new Map<string, { request: JudgeRequest; seats: Set<JudgeRequest['seat']> }>();
  for (const request of requests) {
    const key = `${request.category}:${request.description.trim().replace(/\s+/g, ' ')}`;
    const existing = grouped.get(key);
    if (existing) existing.seats.add(request.seat);
    else grouped.set(key, { request, seats: new Set([request.seat]) });
  }
  return grouped;
}

/** How a judge card reads: waiting now, play resumed with attention kept, or history. */
export function judgeCardMode(match: JudgeMatch, readOnly: boolean): 'waiting' | 'resumed' | 'history' {
  if (readOnly) return 'history';
  return match.phase === 'running' ? 'resumed' : 'waiting';
}

function JudgeCard({ snapshot, match, now, readOnly, onOpen }: {
  snapshot: EventSnapshotDto; match: JudgeMatch; now: number; readOnly: boolean; onOpen(): void;
}) {
  const [first, second] = match.seats;
  const { judge, proposal } = match;
  const mode = judgeCardMode(match, readOnly);
  const disputed = judge.reasons.includes('dispute');
  const allowResultRuling = disputed || judge.reasons.includes('expired');
  const name = (seat: typeof first) => <b>{seatName(snapshot, seat)}</b>;
  const requests = groupRequests(judge.requests ?? []);
  const detailedSeats = new Set(judge.requests?.map(request => request.seat));
  const raisers = judge.raisedBy.filter(seat => !detailedSeats.has(seat))
    .map(seat => `${seatName(snapshot, seat)} (Seat ${seat})`).join(' and ');
  const reasons = [...new Set(judge.reasons)].filter(reason => reason !== 'called' || requests.size === 0);
  const since = formatTimeOfDay(judge.sinceMs);
  const title = mode === 'waiting' ? `${match.id} needs a judge`
    : mode === 'resumed' ? `${match.id} · ${disputed ? 'result disputed' : 'play resumed'}` : `${match.id} needed a judge`;
  const meta = mode === 'waiting'
    ? <span title={`Since ${since}`}>waiting {formatElapsed(judge.sinceMs, now)}</span>
    : <span>since {since}</span>;

  return (
    <DecisionCard tone={mode === 'waiting' ? 'danger' : mode === 'resumed' ? 'warning' : 'neutral'}
      title={title}
      reasons={reasons.map(reason => (mode === 'waiting' ? REASON[reason] : { ...REASON[reason], tone: 'neutral' as const }))}
      meta={meta}
      actions={(
        <>
          {/* Wave 3 (L10): resolve / judge-resume as the domain allows; nothing in history or read-only mode. */}
          <MatchActions snapshot={snapshot} match={match} readOnly={readOnly} allowResultRuling={allowResultRuling} />
          <Button size="sm" variant="secondary" icon={<Workflow aria-hidden />} onClick={onOpen}
            aria-label={`Open ${match.id} in live preview`}>Open in live preview</Button>
        </>
      )}>
      {requests.size > 0 && <ul aria-label="Player messages" className="mt-2 space-y-2">
        {[...requests].map(([key, { request, seats }]) => (
          <li key={key} className="rounded-md bg-line-faint px-2.5 py-2">
            <p className="whitespace-pre-wrap break-words text-fg">{request.description}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone="accent">{JUDGE_REQUEST_CATEGORIES[request.category]}</Badge>
              <span className="text-xs text-fg-muted">{[...seats].map(seat => seatName(snapshot, seat)).join(' and ')}</span>
            </div>
          </li>
        ))}
      </ul>}
      <p className={requests.size ? 'mt-2 text-xs text-fg-muted' : undefined}>
        {requests.size ? <>{seatName(snapshot, first)} vs {seatName(snapshot, second)}</> : <>
          {name(first)} <span className="text-fg-subtle">(Seat {first})</span> vs {name(second)} <span className="text-fg-subtle">(Seat {second})</span>
        </>}
        {' · '}{match.phase === 'expired' ? 'clock expired' : match.phase}
      </p>
      {proposal && (
        <p className="mt-0.5">
          {name(proposal.reporter)} reported that {proposal.winner === proposal.reporter ? 'they' : <b>{seatName(snapshot, proposal.winner)}</b>} won
          {proposal.decision === 'disputed' ? <>; the result is <b className={mode === 'history' ? undefined : '!text-danger'}>disputed</b>.</> : '; awaiting confirmation.'}
        </p>
      )}
      {mode === 'resumed' && (
        <p className="mt-0.5 text-xs text-fg-muted">{disputed
          ? 'The players can still agree on the result, or a judge can make a ruling.'
          : 'Play resumed after a help request. The players can report and agree on the result.'}</p>
      )}
      {mode === 'history' && (
        <p className="mt-0.5 text-xs text-fg-muted">The event was retired with this still open. It is history now; nothing can be decided here.</p>
      )}
      {raisers && <p className="mt-0.5 text-xs text-fg-subtle">
        Raised by {raisers}.
      </p>}
    </DecisionCard>
  );
}
