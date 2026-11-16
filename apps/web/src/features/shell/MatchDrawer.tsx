// Match drawer for the Home task board: the match's judge request and evidence in the main column, and a rail of
// property sections (status, players, actions, links) beside it, or under it in the narrow side drawer, where a
// compact strip keeps the status and the main actions in view. Reads the live snapshot it is given, so the match
// changing lane while the drawer is open just updates it. Expands from a right-hand drawer to a centred panel.
import type { EventSnapshotDto, MatchDto } from '@tcg-live/core';
import { ArrowUpRight, Copy, Maximize2, Minimize2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useMatchCountdown } from '../../data';
import { Badge, Button, Dialog, IconButton, cx, type Tone } from '../../ui';
import { MatchActions } from '../commands';
import { ModerateMembersMenu } from '../admin-tools/members/ModerateMembersMenu';
import { MatchEvidencePanel } from '../evidence';
import { JudgeRequestCard, useCanCloseIssue, type JudgeMatch } from './JudgeRequestCard';
import { seatName } from './labels';
import './match-drawer.css';

export function matchStatusLabel(snapshot: EventSnapshotDto, match: MatchDto): string {
  if (match.judge) {
    if (match.judge.reasons.includes('dispute')) return 'Result disputed';
    if (match.judge.reasons.includes('expired')) return 'Clock expired';
    return 'Judge requested';
  }
  if (match.phase === 'final') return match.finalWinner ? `${seatName(snapshot, match.finalWinner)} won` : 'Result final';
  if (match.proposal?.decision === 'open') return 'Awaiting result confirmation';
  if (match.phase === 'setup') return 'Waiting for Ready';
  return match.phase === 'paused' ? 'Paused' : 'Playing';
}

export function matchStatusTone(match: MatchDto): Tone {
  if (match.judge) return 'danger';
  if (match.phase === 'final') return 'success';
  if (match.proposal?.decision === 'open') return 'warning';
  return 'accent';
}

/** The task-board lane the match is in now. */
export function matchLane(match: MatchDto): string {
  if (match.phase === 'final') return 'Done';
  if (match.judge) return 'Judge needed';
  return match.proposal?.decision === 'open' ? 'Decision needed' : 'In progress';
}

const CLOCK_STATE: Record<MatchDto['clock']['state'], string> = { running: 'Running', frozen: 'Not running', interrupted: 'Interrupted' };

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="match-drawer-section">
    <h3>{title}</h3>
    {children}
  </section>;
}

export interface MatchDrawerProps {
  snapshot: EventSnapshotDto;
  matchId: string;
  onClose(): void;
  /** The old navigation: opens the match in the tournament view. */
  onOpenInTournament(): void;
}

export function MatchDrawer({ snapshot, matchId, onClose, onOpenInTournament }: MatchDrawerProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const match = snapshot.matches.find(item => item.id === matchId);
  const countdown = useMatchCountdown(match?.clock);
  const canClose = useCanCloseIssue(snapshot, match);
  if (!match) return null;
  const [first, second] = match.seats;
  const readOnly = snapshot.status !== 'active';
  const judge = match.judge;
  const allowResultRuling = !judge || judge.reasons.includes('dispute') || judge.reasons.includes('expired');
  const members = match.seats.map(seat => ({ id: snapshot.seats[seat] ?? null, name: seatName(snapshot, seat) }));
  const toggle = expanded ? 'Collapse to side panel' : 'Expand to centred panel';
  const actions = <MatchActions snapshot={snapshot} match={match} readOnly={readOnly} allowResultRuling={allowResultRuling} exclude={['judgeClose']} />;
  const clock = <span className="tabular-nums"><b className="font-semibold text-fg">{countdown.label}</b>
    <span className="ml-1.5 text-xs text-fg-muted">{CLOCK_STATE[match.clock.state]}</span></span>;
  // Opened on a judge call that can be closed: start in the notes field so the note can be typed at once.
  const initialFocus = judge && canClose ? notesRef : contentRef;

  return <Dialog open onClose={onClose} initialFocusRef={initialFocus} layout={expanded ? 'center' : 'drawer'} width={expanded ? 'xl' : 'lg'}
    title={<>Match {match.id} · {seatName(snapshot, first)} vs {seatName(snapshot, second)}</>}
    headerActions={<IconButton aria-label={toggle} title={toggle} size="sm" className="-mt-1" icon={expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
      onClick={() => setExpanded(value => !value)} />}>
    <div className={cx('match-drawer', expanded && 'match-drawer-wide')}>
      <div className="match-drawer-main">
        {!expanded && <section aria-label="Match summary" className="match-drawer-strip">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={matchStatusTone(match)}>{matchStatusLabel(snapshot, match)}</Badge>
            <span className="text-xs text-fg-muted">{matchLane(match)}</span>
            <span className="ml-auto">{clock}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </section>}
        <div ref={contentRef} tabIndex={-1} className="flex min-w-0 flex-col gap-4 outline-none">
          {judge && <JudgeRequestCard snapshot={snapshot} match={match as JudgeMatch} notesRef={notesRef} />}
          <section aria-label="Evidence" className="match-drawer-section !border-t-0 !pt-0">
            <h3>Evidence</h3>
            <MatchEvidencePanel eventId={snapshot.eventId} matchId={match.id} />
          </section>
        </div>
      </div>
      <aside aria-label="Match properties" className="match-drawer-rail">
        {expanded && <RailSection title="Status">
          <dl className="match-drawer-props">
            <dt>Lane</dt><dd>{matchLane(match)}</dd>
            <dt>Status</dt><dd><Badge tone={matchStatusTone(match)}>{matchStatusLabel(snapshot, match)}</Badge></dd>
            <dt>Phase</dt><dd className="capitalize">{match.phase}</dd>
            <dt>Clock</dt><dd>{clock}</dd>
          </dl>
        </RailSection>}
        <RailSection title="Players">
          <ul className="flex flex-col gap-1">
            {match.seats.map(seat => <li key={seat} className="flex flex-wrap items-center gap-1.5">
              <b className="font-medium text-fg">{seatName(snapshot, seat)}</b>
              <span className="text-xs text-fg-subtle">Seat {seat}</span>
              {match.finalWinner === seat && <Badge tone="success">Winner</Badge>}
              {match.finalWinner === null && match.proposal?.winner === seat &&
                <Badge tone={match.proposal.decision === 'disputed' ? 'danger' : 'warning'}>
                  {match.proposal.decision === 'disputed' ? 'Reported (disputed)' : 'Reported winner'}</Badge>}
              {match.ready.includes(seat) && match.phase === 'setup' && <Badge tone="success">Ready</Badge>}
            </li>)}
          </ul>
          {!readOnly && <div><ModerateMembersMenu variant="button" eventId={snapshot.eventId} matchId={match.id}
            label={`Moderate a player of ${match.id}`} members={members} /></div>}
        </RailSection>
        {expanded && <RailSection title="Actions"><div className="flex flex-col items-stretch gap-2">{actions}</div></RailSection>}
        <RailSection title="Links">
          <div className="flex flex-col items-start gap-1">
            <Button size="sm" variant="ghost" icon={<ArrowUpRight aria-hidden />} onClick={onOpenInTournament}>Open in tournament view</Button>
            <Button size="sm" variant="ghost" icon={<Copy aria-hidden />}
              onClick={() => { void navigator.clipboard?.writeText(match.id); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? 'Copied' : 'Copy match ID'}</Button>
          </div>
        </RailSection>
      </aside>
    </div>
  </Dialog>;
}
