// The judge request of one match: why a judge is needed, who asked and when, the players' messages, and the one
// thing a judge does about a plain call: write a note and close the issue. Disputes need a result instead.
import { JUDGE_REQUEST_CATEGORIES, type EventSnapshotDto, type MatchDto } from '@tcg-live/core';
import { useRef, useState, type Ref } from 'react';
import { formatElapsed, formatTimeOfDay, useServerNow } from '../../data';
import { Badge, Button, Field, Textarea } from '../../ui';
import { useCommands } from '../commands';
import { canCloseJudgeIssue, canRun, isWritable } from '../commands/model';
import { seatName } from './labels';

export type JudgeMatch = MatchDto & { judge: NonNullable<MatchDto['judge']> };

const MAX_NOTE = 500;

/** "Close issue" is possible now: the session may judge and the domain offers it for this match. */
export function useCanCloseIssue(snapshot: EventSnapshotDto, match: MatchDto | undefined): boolean {
  const commands = useCommands();
  return !!commands && !!match && canCloseJudgeIssue(commands.session, snapshot, match);
}

export function JudgeRequestCard({ snapshot, match, notesRef }: { snapshot: EventSnapshotDto; match: JudgeMatch; notesRef?: Ref<HTMLTextAreaElement> }) {
  const commands = useCommands();
  const canClose = useCanCloseIssue(snapshot, match);
  const resumed = match.phase === 'running';
  const now = useServerNow(resumed ? null : 1000);
  const { judge } = match;
  // A dispute or an expired clock needs a result, not a note.
  const needsResult = match.proposal?.decision === 'disputed' || judge.reasons.includes('dispute') || judge.reasons.includes('expired');
  const writable = isWritable(snapshot);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: two Ctrl+Enter presses in one tick would both see pending=false.
  const inFlight = useRef(false);
  const reason = note.trim();
  const ready = canClose && !needsResult && reason.length > 0 && reason.length <= MAX_NOTE && !pending;

  const close = async () => {
    if (!commands || !ready || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const outcome = await commands.run(snapshot, { type: 'judgeClose', matchId: match.id, reason }, { inline: true });
      if (outcome.status === 'applied' || outcome.status === 'noop') setNote('');
      else if (outcome.status === 'conflict' || outcome.status === 'failed') setError(outcome.message);
    } finally { inFlight.current = false; setPending(false); }
  };

  return <section aria-label="Judge request" className="flex flex-col gap-2 rounded-lg border border-line p-3">
    <div className="flex flex-wrap items-center gap-1.5">
      {[...new Set(judge.reasons)].map(item => <Badge key={item} tone={item === 'expired' ? 'warning' : 'danger'}>
        {item === 'dispute' ? 'Dispute' : item === 'expired' ? 'Clock expired' : 'Judge called'}</Badge>)}
      <span className="text-xs text-fg-muted">since {formatTimeOfDay(judge.sinceMs)} · {resumed ? 'play resumed' : `waiting ${formatElapsed(judge.sinceMs, now)}`}</span>
    </div>
    {judge.raisedBy.length > 0 && <p className="text-xs text-fg-muted">
      Called by {judge.raisedBy.map(seat => `${seatName(snapshot, seat)} (Seat ${seat})`).join(' and ')}.</p>}
    {judge.requests && judge.requests.length > 0 && <ul aria-label="Player messages" className="flex flex-col gap-1.5">
      {judge.requests.map((request, index) => <li key={index} className="rounded-md bg-line-faint px-2.5 py-2">
        <p className="whitespace-pre-wrap break-words text-fg">{request.description}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone="accent">{JUDGE_REQUEST_CATEGORIES[request.category]}</Badge>
          <span className="text-xs text-fg-muted">{seatName(snapshot, request.seat)}</span>
        </div>
      </li>)}
    </ul>}
    {!writable
      ? <p className="text-xs text-fg-muted">This event is closed. The request is history; nothing can be changed here.</p>
      : needsResult
      ? <p className="rounded-md bg-warning-soft px-2.5 py-2 text-xs text-fg">
        {judge.reasons.includes('expired') && !judge.reasons.includes('dispute') ? 'The clock expired' : 'This is a dispute'}: choose a winner with Resolve{canRun(commands?.session ?? null, 'resolve') && match.adminActions.includes('resolve') ? ' (in Actions)' : ''}.
        It cannot be closed with a note.</p>
      : canClose && <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void close(); }}>
        <Field label="Notes" required description="Written to the audit log. Required to close the issue.">
          <Textarea ref={notesRef} rows={3} value={note} maxLength={MAX_NOTE} disabled={pending}
            onChange={event => { setNote(event.target.value); setError(null); }}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void close(); } }} />
        </Field>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div><Button type="submit" size="sm" variant="primary" loading={pending} disabled={!ready}>Close issue</Button></div>
      </form>}
  </section>;
}
